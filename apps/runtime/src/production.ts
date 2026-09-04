/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Predates the incremental anti-slop gate; file reawakened by an unrelated budget/reliability edit, existing debt not rewritten here. */
import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  type AsciiBoxMaintenanceClientOptions,
  type BoxProviderCallTiming,
  type BoxRuntimeLifecycleClient,
  type CompanionBoxRuntime,
  type CompanionRuntimeSkill,
} from "@companion/box-runtime";
import {
  CompanionImageRegistry,
  createJsonRuntimeProcessLog,
  describeThrownError,
} from "@companion/companion-runtime/runtime-support";
import {
  combineRuntimeV3Convergence,
  createRuntimeV3Convergence,
  createRuntimeV3DeadlineSweep,
  createRuntimeV3Lifecycle,
  createRuntimeV3Preparation,
  createRuntimeV3WarmTurnAdvance,
} from "@companion/companion-runtime/v3/internal";
import {
  createStorageClient,
  getSkillArchive,
  getStorageConfig,
  putSkillArchive,
} from "@companion/storage";

import { createRuntimeBoxControl, createRuntimePiControl } from "./boxAdapters";
import type {
  RuntimeApplicationScheduler,
  RuntimeApplicationStore,
  RuntimeGateStatus,
} from "./application";
import { composeRuntimeService, type RuntimeService } from "./composition";
import { loadRuntimeServiceConfig, type RuntimeServiceConfig } from "./config";
import { createRuntimeDatabase, type RuntimeDatabase } from "./database";
import {
  createDirectBoxDataTransport,
  createDirectRuntimePiControl,
  DirectBoxEndpointRegistry,
} from "./directBoxTransport";
import {
  createRuntimeDesktopPort,
  PostgresRuntimeDesktopAuthorizer,
  PostgresRuntimeDesktopReplayGuard,
} from "./desktop";
import { createImageBuildWorker } from "./imageBuildWorker";
import { superviseImageBuilder } from "./imageBuilderSupervisor";
import {
  createRuntimeMaterialPipeline,
  loadBundledCompanionRuntimeSkill,
} from "./materialPipeline";
import { createPiBundleUrlProvider } from "./piBundlePresigner";
import {
  createRuntimeV3Scheduler,
  type RuntimeV3SchedulerOptions,
} from "./schedulerAdapter";
import { createSentryRuntimeProcessLog } from "./sentry";
import {
  createRuntimeV3PostgresPreparationPersistence,
  createRuntimeV3PostgresLifecyclePersistence,
  createRuntimeV3PostgresBackgroundConvergence,
  createRuntimeV3PostgresBackgroundTurnPersistence,
  createRuntimeV3PostgresWarmConvergence,
  createRuntimeV3PostgresWarmTurnPersistence,
} from "./runtimeV3ProgressionStore";
import { createRuntimeV3WarmPi } from "./runtimeV3WarmPi";
import { createRuntimeV3RoutinePi } from "./runtimeV3RoutinePi";

export interface RuntimeArchiveStorage {
  load(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  /** Store one harvested attachment. Skill archives are read-only, so this is write-only. */
  store(input: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }): Promise<void>;
  close(): void | Promise<void>;
}

export interface RuntimeProductionFactories {
  createDatabase(config: RuntimeServiceConfig): RuntimeDatabase;
  createLifecycle(
    env: NodeJS.ProcessEnv,
    options?: AsciiBoxMaintenanceClientOptions,
  ): BoxRuntimeLifecycleClient;
  createBoxRuntime(
    env: NodeJS.ProcessEnv,
    options?: {
      onTiming?: (sample: BoxProviderCallTiming) => void;
      companionSkillChecksum?: string;
      /** Mints a fresh presigned Pi-bundle download URL per layout script generation. */
      bundleUrlProvider?: () => Promise<string>;
    },
  ): CompanionBoxRuntime;
  createArchiveStorage(): RuntimeArchiveStorage;
  loadBundledSkill(): Promise<CompanionRuntimeSkill>;
  createScheduler(input: RuntimeV3SchedulerOptions): RuntimeApplicationScheduler;
}

export interface BuildProductionRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  factories?: Partial<RuntimeProductionFactories>;
}

const defaultFactories: RuntimeProductionFactories = {
  createDatabase: createRuntimeDatabase,
  createLifecycle: (env, options) => new AsciiBoxMaintenanceClient(env, options),
  createBoxRuntime: (env, options) => new AsciiBoxCompanionRuntime(env, options),
  createArchiveStorage: () => {
    const config = getStorageConfig();
    const client = createStorageClient(config);
    return {
      load: async (storagePath, signal) => await getSkillArchive({
        key: storagePath,
        signal,
        client,
        config,
      }),
      store: async ({ key, bytes, contentType, signal }) => {
        await putSkillArchive({ key, body: bytes, contentType, signal, client, config });
      },
      close: () => client.destroy(),
    };
  },
  loadBundledSkill: loadBundledCompanionRuntimeSkill,
  createScheduler: createRuntimeV3Scheduler,
};

/** Build the sole process that may claim Runtime v3 work or contact Box/Pi. */
export async function buildProductionRuntimeService(
  options: BuildProductionRuntimeOptions = {},
): Promise<RuntimeService> {
  const env = options.env ?? process.env;
  const factories: RuntimeProductionFactories = {
    ...defaultFactories,
    ...options.factories,
  };
  const config = loadRuntimeServiceConfig(env);
  const database = factories.createDatabase(config);
  let archiveStorage: RuntimeArchiveStorage | null = null;
  let bakerAbort: AbortController | null = null;
  let bakerRun: Promise<void> | null = null;
  const closeResources = resourceCloser({
    database,
    archiveStorage: () => archiveStorage,
    config,
    abortBaker: () => bakerAbort?.abort(),
    awaitBaker: () => bakerRun,
  });

  try {
    // A valid URL is insufficient: a mistakenly privileged API/owner login must fail startup.
    await database.verifyRole();
    const store = createRuntimeApplicationStore(database);
    const log = createSentryRuntimeProcessLog(createJsonRuntimeProcessLog());
    const externalIncidentOptions = {
      onExternalIncident: (incident: {
        signalId: string;
        incidentId: string;
        state: "opened" | "recovered";
        classification: "box" | "model" | "plugin_provider" | "authority";
        source: "main" | "routine" | "trigger" | "delegation";
        stableCode?: string;
      }) => {
        const record = {
          ts: new Date().toISOString(),
          event: `runtime.external_incident.${incident.classification}.${incident.state}`,
          classification: incident.classification,
          source: incident.source,
          signal_id: incident.signalId,
          incident_id: incident.incidentId,
          ...(incident.stableCode ? { code: incident.stableCode } : {}),
        };
        if (incident.state === "opened") log.error(record);
        else log.warn(record);
      },
    };
    if (!config.companionsEnabled) {
      const scheduler = factories.createScheduler({
        executorId: config.executorId,
        sweepIntervalMs: config.sweepIntervalMs,
        claimsEnabled: false,
      });
      return composeRuntimeService({
        config,
        store,
        scheduler,
        closeResources,
      });
    }

    const boxEnv = runtimeBoxEnvironment(config, env);
    const bundleUrlProvider = createPiBundleUrlProvider(env);
    const lifecycle = factories.createLifecycle(boxEnv, {
      onTiming: (sample) => {
        log.info({
          ts: new Date().toISOString(),
          event: "runtime.box.provider_call",
          operation: sample.operation,
          durationMs: sample.durationMs,
          ok: sample.ok,
          ...(sample.status === undefined ? {} : { status: sample.status }),
        });
      },
    });
    const bundledSkill = await factories.loadBundledSkill();
    // Staging is a multi-request transaction with one shared abort budget. Keep adapter instances
    // call-local so that budget cannot leak into a later lifecycle or broker operation.
    const runtimeTiming = {
      onTiming: (sample: BoxProviderCallTiming) => {
        log.info({
          ts: new Date().toISOString(),
          event: "runtime.box.provider_call",
          operation: sample.operation,
          durationMs: sample.durationMs,
          ok: sample.ok,
          ...(sample.status === undefined ? {} : { status: sample.status }),
        });
      },
      onStageTiming: (sample: {
        phase: string;
        durationMs: number;
        ok: boolean;
      }) => {
        log.info({
          ts: new Date().toISOString(),
          event: "runtime.box.staging_phase",
          phase: sample.phase,
          durationMs: sample.durationMs,
          ok: sample.ok,
        });
      },
      companionSkillChecksum: bundledSkill.checksum,
      // Undefined when bundle mode is off or S3 is not fully configured; the box runtime then keeps
      // the COMPANION_PI_INSTALL_COMMAND escape hatch. The runtime service is the only process with
      // both the Box credential and the S3 credential, so presigning happens here and nowhere else.
      ...(bundleUrlProvider ? { bundleUrlProvider } : {}),
    };
    const freshRuntime = (): CompanionBoxRuntime => factories.createBoxRuntime(
      boxEnv,
      runtimeTiming,
    );
    const imageAbortController = new AbortController();
    bakerAbort = imageAbortController;
    const imageRegistry = new CompanionImageRegistry(database.sql);
    const layoutIdentity = freshRuntime().layoutIdentity();
    const imageWorker = createImageBuildWorker({
      registry: imageRegistry,
      identity: layoutIdentity,
      lifecycle,
      runtime: () => freshRuntime(),
      bundledSkill,
      executorId: config.executorId,
      log,
    });
    const imageSupervisor = superviseImageBuilder({
      worker: imageWorker,
      registry: imageRegistry,
      digest: layoutIdentity.imageMarker,
      log,
    });
    void imageWorker.requestCurrentImage().catch((error) => {
      log.warn({
        ts: new Date().toISOString(),
        event: "runtime.image_build_request_failed",
        error: describeThrownError(error),
      });
    });
    // Supervised, not fire-and-forget: liveness feeds /healthz and the run joins the shutdown drain
    // so an in-flight bake settles before resources close. A crash leaves loopAlive false → 503.
    bakerRun = imageSupervisor.run(imageAbortController.signal).catch((error) => {
      if (imageAbortController.signal.aborted) return;
      log.warn({
        ts: new Date().toISOString(),
        event: "runtime.image_build_worker_failed",
        error: describeThrownError(error),
      });
    });
    archiveStorage = factories.createArchiveStorage();
    // The direct-transport registry exists whenever the gate is not off: `shadow` needs endpoints
    // to compare against, `on` needs them to route the event path. `off` stays byte-for-byte the
    // exec-only composition.
    const endpointRegistry = config.directTransport === "off"
      ? null
      : new DirectBoxEndpointRegistry();
    const directFiles = endpointRegistry && config.directTransport === "on"
      ? createDirectBoxDataTransport({
        exec: freshRuntime,
        registry: endpointRegistry,
        log,
      })
      : null;
    const material = createRuntimeMaterialPipeline({
      masterKey: config.masterKey,
      apiUrl: config.apiUrl,
      bundledSkill,
      runtime: freshRuntime,
      ...(directFiles ? { fileRuntime: () => directFiles } : {}),
      ...(endpointRegistry
        ? {
          registerAgentEndpoint: (boxId: string, endpoint: {
            hostedUrl: string;
            proxyToken: string;
            bearerToken: string;
            observedAt: Date;
          }) => endpointRegistry.register(boxId, endpoint),
        }
        : {}),
      loadSkillArchive: async (storagePath, signal) => {
        const storage = archiveStorage;
        if (!storage) throw new Error("runtime archive storage is closed");
        return await storage.load(storagePath, signal);
      },
      loadAttachment: async (storageKey, signal) => {
        const storage = archiveStorage;
        if (!storage) throw new Error("runtime attachment storage is closed");
        return await storage.load(storageKey, signal);
      },
      storeAttachment: async (stored) => {
        const storage = archiveStorage;
        if (!storage) throw new Error("runtime archive storage is closed");
        await storage.store(stored);
      },
    });
    const adapters = {
      lifecycle,
      runtime: freshRuntime,
      runtimeImage: imageWorker.source(),
      onColdFallback: (reason: string) => imageSupervisor.recordColdFallback(reason),
      log,
    };
    const execPi = createRuntimePiControl(adapters);
    const direct = endpointRegistry
      ? createDirectRuntimePiControl({
        mode: config.directTransport === "on" ? "on" : "shadow",
        exec: execPi,
        registry: endpointRegistry,
        layoutFullMarker: layoutIdentity.fullMarker,
        log,
      })
      : null;
    const pi = direct?.pi ?? execPi;
    const box = createRuntimeBoxControl(adapters);
    const desktop = createRuntimeDesktopPort({
      authorization: new PostgresRuntimeDesktopAuthorizer(database.sql),
      box: {
        desktop: async (input) => await freshRuntime().desktop(input),
      },
    });
    const runtimeV3TurnPersistence = createRuntimeV3PostgresWarmConvergence(database.sql, {
      enabledLanes: new Set(["main"]),
      ...externalIncidentOptions,
    });
    const runtimeV3Turns = createRuntimeV3Convergence({
      persistence: runtimeV3TurnPersistence,
      advance: createRuntimeV3WarmTurnAdvance({
        persistence: createRuntimeV3PostgresWarmTurnPersistence(
          database.sql, externalIncidentOptions,
        ),
        pi: createRuntimeV3WarmPi(pi),
        inputAttachments: material.inputAttachmentStager,
        outbox: {
          harvest: async (input) => await material.outboxHarvester.harvestOutbox({
            orgId: input.orgId,
            companionId: input.companionId,
            boxId: input.boxId,
            turnId: input.turnId,
            deadlineAt: input.deadlineAt,
            signal: input.signal,
          }),
          clear: async (input) => await material.outboxHarvester.clearOutbox(input),
        },
        onOutboxDegraded: () => log.warn({
          ts: new Date().toISOString(),
          event: "runtime.v3.outbox_harvest_degraded",
          error: "One or more Pi output images could not be persisted.",
        }),
      }),
    });
    const runtimeV3Background = createRuntimeV3Convergence({
      persistence: createRuntimeV3PostgresBackgroundConvergence(
        database.sql, externalIncidentOptions,
      ),
      advance: createRuntimeV3WarmTurnAdvance({
        persistence: createRuntimeV3PostgresBackgroundTurnPersistence(
          database.sql, externalIncidentOptions,
        ),
        pi: createRuntimeV3RoutinePi(pi),
      }),
    });
    const runtimeV3 = combineRuntimeV3Convergence(
      createRuntimeV3Lifecycle({
        persistence: createRuntimeV3PostgresLifecyclePersistence(database.sql),
        box,
      }),
      createRuntimeV3Preparation({
        persistence: createRuntimeV3PostgresPreparationPersistence(
          database.sql, externalIncidentOptions,
        ),
        box,
        preparationStager: material.preparationStager,
        pi,
        observePreparedLatency: (durationMs) => log.info({
          ts: new Date().toISOString(),
          event: "runtime.v3.prepared",
          durationMs,
        }),
      }),
      runtimeV3Turns,
    );
    return composeRuntimeService({
      config,
      store,
      scheduler: factories.createScheduler({
        claimsEnabled: true,
        concurrency: config.concurrency,
        convergence: runtimeV3,
        backgroundConvergence: runtimeV3Background,
        deadlineSweep: createRuntimeV3DeadlineSweep(runtimeV3TurnPersistence),
        executorId: config.executorId,
        sweepIntervalMs: config.sweepIntervalMs,
      }),
      desktop,
      desktopReplay: new PostgresRuntimeDesktopReplayGuard(database.sql),
      imageHealth: () => imageSupervisor.snapshot(),
      closeResources,
    });
  } catch (error) {
    await closeResources().catch(() => undefined);
    throw error;
  }
}

const BOX_RUNTIME_ENV_KEYS = [
  "COMPANION_BOX_ENVIRONMENT",
  "COMPANION_DIRECT_TRANSPORT",
  "COMPANION_BOX_POLL_INTERVAL_MS",
  "COMPANION_BOX_READY_TIMEOUT_MS",
  "COMPANION_BOX_DESKTOP_MINT_BUDGET_MS",
  "COMPANION_PI_BROKER_COMMAND",
  "COMPANION_PI_BROKER_SOCKET",
  "COMPANION_PI_BROKER_TIMEOUT_MS",
  "COMPANION_PI_BUNDLE_ENABLED",
  "COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS",
  "COMPANION_PI_INSTALL_COMMAND",
  "COMPANION_PI_MCP_ADAPTER_PACKAGE",
] as const;

/** Construct the Box-only environment without forwarding database or encryption credentials. */
export function runtimeBoxEnvironment(
  config: Extract<RuntimeServiceConfig, { companionsEnabled: true }>,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    COMPANION_BOX_API_KEY: config.boxApiKey,
    COMPANION_BOX_API_BASE: config.boxApiBase,
    COMPANION_BOX_TTL_SECONDS: String(config.boxTtlSeconds),
  };
  for (const key of BOX_RUNTIME_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function resourceCloser(input: {
  database: RuntimeDatabase;
  archiveStorage(): RuntimeArchiveStorage | null;
  config: RuntimeServiceConfig;
  abortBaker?: () => void;
  awaitBaker?: () => Promise<void> | null;
}): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= (async () => {
      input.abortBaker?.();
      let failure: unknown;
      // Join the builder run before closing the DB so an in-flight bake's registry writes settle.
      try {
        await input.awaitBaker?.();
      } catch {
        // The supervised run already logs its own death; never fail shutdown on it.
      }
      try {
        await input.archiveStorage()?.close();
      } catch (error) {
        failure = error;
      }
      try {
        await input.database.close();
      } catch (error) {
        failure ??= error;
      } finally {
        input.config.masterKey?.fill(0);
        input.config.desktopHmacSecret?.fill(0);
      }
      if (failure) throw failure;
    })();
    return closing;
  };
}

interface RuntimeGateRow {
  enabled: boolean;
  gate_epoch: string;
  updated_at: Date;
}

/** PostgreSQL health and kill-switch port for Runtime v3 convergence. */
function createRuntimeApplicationStore(database: RuntimeDatabase): RuntimeApplicationStore {
  const readGateStatus = async (
    query: string,
    parameters: string[] = [],
  ): Promise<RuntimeGateStatus> => {
    const rows = await database.sql.unsafe<RuntimeGateRow[]>(query, parameters);
    const row = rows[0];
    if (rows.length !== 1 || !row || (row.enabled !== true && row.enabled !== false)
      || !/^-?\d+$/.test(row.gate_epoch) || !(row.updated_at instanceof Date)
      || Number.isNaN(row.updated_at.getTime())) {
      throw new Error("runtime gate returned an invalid result");
    }
    let gateEpoch: bigint;
    try {
      gateEpoch = BigInt(row.gate_epoch);
    } catch {
      throw new Error("runtime gate returned an invalid result");
    }
    return { enabled: row.enabled, gateEpoch, updatedAt: row.updated_at };
  };

  const gateStatus = async (): Promise<RuntimeGateStatus> => await readGateStatus(`
    SELECT enabled, gate_epoch::text AS gate_epoch, updated_at
    FROM public.companion_runtime_gate_status()
  `);
  return {
    ping: async () => {
      await gateStatus();
    },
    gateStatus,
    disable: async (expectedGateEpoch, actorId) => await readGateStatus(`
      SELECT enabled, gate_epoch::text AS gate_epoch, updated_at
      FROM public.companion_runtime_disable($1::bigint, $2::text)
    `, [expectedGateEpoch.toString(), actorId]),
  };
}
