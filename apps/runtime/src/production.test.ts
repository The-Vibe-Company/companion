/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- Composition fixtures are hand-written fakes matching the used factory surfaces exactly. */
import { describe, expect, it, vi } from "vitest";
import type {
  AsciiBoxMaintenanceClientOptions,
  BoxRuntimeLifecycleClient,
  CompanionBoxRuntimeV2,
} from "@companion/box-runtime";
import type {
  CreateRuntimeKernelInput,
  RuntimeSchedulerSnapshot,
  RuntimeStore,
} from "@companion/companion-runtime";

import type { RuntimeDatabase } from "./database";
import { RuntimeDatabaseRoleError } from "./database";
import {
  buildProductionRuntimeService,
  type RuntimeArchiveStorage,
  type RuntimeProductionFactories,
} from "./production";
import type { RuntimeKernelScheduler } from "./schedulerAdapter";

const databaseUrl = "postgres://companion_runtime:secret@127.0.0.1:5432/companion";

function scheduler(): RuntimeKernelScheduler {
  const snapshot: RuntimeSchedulerSnapshot = {
    claimLoopAlive: false,
    acceptingClaims: false,
    claimsEnabled: false,
    gateEnabled: null,
    lastSweepStartedAt: null,
    lastSweepCompletedAt: null,
    claimLoopErrorAt: null,
    activeCount: 0,
    concurrency: 8,
    sweepIntervalMs: 2_000,
  };
  return {
    start: vi.fn(),
    stopClaims: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => snapshot,
  };
}

function database(): RuntimeDatabase {
  return {
    sql: { unsafe: vi.fn() } as unknown as RuntimeDatabase["sql"],
    verifyRole: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("production runtime composition", () => {
  it("closes the pool and constructs no service when database role verification refuses startup", async () => {
    const db = database();
    const failure = new RuntimeDatabaseRoleError("login_mismatch");
    vi.mocked(db.verifyRole).mockRejectedValue(failure);
    const createStore = vi.fn(() => ({} as RuntimeStore));

    await expect(buildProductionRuntimeService({
      env: {
        DATABASE_COMPANION_RUNTIME_URL: databaseUrl,
        COMPANION_COMPANIONS_ENABLED: "false",
      },
      factories: { createDatabase: () => db, createStore },
    })).rejects.toBe(failure);

    expect(createStore).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("verifies the runtime role but constructs no external client on the kill-switch path", async () => {
    const db = database();
    const store = {} as RuntimeStore;
    let kernelInput: CreateRuntimeKernelInput | undefined;
    const createLifecycle = vi.fn(() => ({} as BoxRuntimeLifecycleClient));
    const createBoxRuntime = vi.fn(() => ({} as CompanionBoxRuntimeV2));
    const createArchiveStorage = vi.fn(() => ({
      load: vi.fn(),
      store: vi.fn(),
      close: vi.fn(),
    } as RuntimeArchiveStorage));
    const loadBundledSkill = vi.fn();
    const factories = {
      createDatabase: () => db,
      createStore: () => store,
      createLifecycle,
      createBoxRuntime,
      createArchiveStorage,
      loadBundledSkill,
      createKernel: (input) => {
        kernelInput = input;
        return { scheduler: scheduler() };
      },
    } satisfies RuntimeProductionFactories;

    const service = await buildProductionRuntimeService({
      env: {
        DATABASE_COMPANION_RUNTIME_URL: databaseUrl,
        COMPANION_COMPANIONS_ENABLED: "false",
      },
      factories,
    });

    expect(db.verifyRole).toHaveBeenCalledOnce();
    expect(kernelInput).toMatchObject({ claimsEnabled: false, store });
    expect(kernelInput?.log).toEqual(expect.objectContaining({
      error: expect.any(Function),
      warn: expect.any(Function),
      info: expect.any(Function),
    }));
    expect(createLifecycle).not.toHaveBeenCalled();
    expect(createBoxRuntime).not.toHaveBeenCalled();
    expect(createArchiveStorage).not.toHaveBeenCalled();
    expect(loadBundledSkill).not.toHaveBeenCalled();
    await service.application.stop();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("wires isolated Box calls, storage, bundled skill, and clears key bytes after drain", async () => {
    const masterKey = Buffer.alloc(32, 17);
    const hmacKey = Buffer.alloc(32, 23);
    const db = database();
    // The image registry reads the published build state on every Box create; a ready row
    // proves the clone path without a live provider.
    (db.sql.unsafe as ReturnType<typeof vi.fn>).mockImplementation(async (query: string) => {
      if (query.includes("companion_runtime_image_claim")) return [];
      return [{
        digest: "14:base:overlay=overlay:skill=none:boot=1",
        image_name: "companion-l14-aaaaaaaaaaaa",
        status: "ready",
        parent_image_name: null,
        build_box_id: null,
        attempt_count: 1,
        last_error_code: null,
        last_error_message: null,
      }];
    });
    const store = {} as RuntimeStore;
    let kernelInput: CreateRuntimeKernelInput | undefined;
    let configuredMasterKey: Buffer | undefined;
    let configuredHmacKey: Buffer | undefined;
    let boxEnv: NodeJS.ProcessEnv | undefined;
    const existingBoxStatus = vi.fn(async (input: { boxId: string }) => ({
      boxId: input.boxId,
      state: "ready" as const,
    }));
    const createBoxRuntime = vi.fn(() => ({
      existingBoxStatus,
      layoutIdentity: () => ({
        layoutVersion: 14,
        packages: [],
        qmdPackage: "@tobilu/qmd@2.8.3",
        minimumPiVersion: "0.84.2",
        overlayRevision: 1,
        overlayMarker: "overlay",
        baseMarker: "14:base",
        fullMarker: "14:base:overlay=overlay",
        imageMarker: "14:base:overlay=overlay:skill=none:boot=1",
        imageName: "companion-l14-aaaaaaaaaaaa",
      }),
    } as unknown as CompanionBoxRuntimeV2));
    const storageClose = vi.fn();
    let lifecycleOptions: AsciiBoxMaintenanceClientOptions | undefined;
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "Companion 11111111-1111-4111-8111-111111111111 g1",
    }));
    const factories = {
      createDatabase: (config) => {
        configuredMasterKey = config.masterKey ?? undefined;
        configuredHmacKey = config.desktopHmacSecret ?? undefined;
        return db;
      },
      createStore: () => store,
      createLifecycle: (env, options) => {
        boxEnv = env;
        lifecycleOptions = options;
        return {
          getNamedSnapshot: async () => ({
            name: "companion-l14-aaaaaaaaaaaa",
            status: "ready" as const,
            sourceBoxId: "bx_23456789",
            createdAt: "2026-08-19T00:00:00.000Z",
          }),
          createGenerationBoxAfterObservedAbsence,
        } as unknown as BoxRuntimeLifecycleClient;
      },
      createBoxRuntime,
      createArchiveStorage: () => ({
        load: vi.fn(async () => Buffer.from("archive")),
        store: vi.fn(async () => undefined),
        close: storageClose,
      }),
      loadBundledSkill: vi.fn(async () => ({
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      })),
      createKernel: (input) => {
        kernelInput = input;
        return { scheduler: scheduler() };
      },
    } satisfies RuntimeProductionFactories;

    const service = await buildProductionRuntimeService({
      env: {
        DATABASE_COMPANION_RUNTIME_URL: databaseUrl,
        COMPANION_COMPANIONS_ENABLED: "true",
        COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
        COMPANION_BOX_API_KEY: "box-secret",
        COMPANION_BOX_API_BASE: "http://127.0.0.1:13400",
        COMPANION_SECRETS_MASTER_KEY: masterKey.toString("base64"),
        COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: hmacKey.toString("base64"),
        COMPANION_API_URL: "http://127.0.0.1:3001",
        COMPANION_PI_MCP_ADAPTER_PACKAGE: "npm:pi-mcp-adapter@2.12.1",
        COMPANION_DIRECT_TRANSPORT: "off",
        UNRELATED_DATABASE_SECRET: "must-not-be-forwarded",
      },
      factories,
    });

    expect(db.verifyRole).toHaveBeenCalledOnce();
    expect(kernelInput).toMatchObject({
      claimsEnabled: true,
      concurrency: 8,
      sweepIntervalMs: 2_000,
      materialProvider: expect.any(Object),
      projectionRedactorFactory: expect.any(Object),
      resourceStager: expect.any(Object),
      log: expect.objectContaining({
        error: expect.any(Function),
        warn: expect.any(Function),
        info: expect.any(Function),
      }),
    });
    // The Box adapter is the only process that lays out a disk, so the one pin an environment can
    // still move reaches it and nothing else in this environment does.
    expect(boxEnv).toEqual({
      COMPANION_BOX_API_KEY: "box-secret",
      COMPANION_BOX_API_BASE: "http://127.0.0.1:13400",
      COMPANION_BOX_TTL_SECONDS: "21600",
      COMPANION_DIRECT_TRANSPORT: "off",
      COMPANION_PI_MCP_ADAPTER_PACKAGE: "npm:pi-mcp-adapter@2.12.1",
    });
    // Gate off: today's exec-only composition, byte-for-byte — no direct poll-interval override.
    expect(kernelInput?.eventPollIntervalMs).toBeUndefined();
    const control = (kernelInput as CreateRuntimeKernelInput).box;
    await control.getStatus({ boxId: "bx_23456789", signal: new AbortController().signal });
    await control.getStatus({ boxId: "bx_23456789", signal: new AbortController().signal });
    expect(createBoxRuntime).toHaveBeenCalledTimes(3);

    // A create right after boot waits on the baker's first resolution and clones the ready image.
    const created = await control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 1n,
      ttlSeconds: 21_600,
      signal: new AbortController().signal,
    });
    expect(created).toMatchObject({ outcome: "created", boxId: "bx_23456789" });
    expect(createGenerationBoxAfterObservedAbsence).toHaveBeenCalledWith(expect.objectContaining({
      from: "companion-l14-aaaaaaaaaaaa",
    }));
    // Provider-call timings flow into the process log as structured info records.
    expect(lifecycleOptions?.onTiming).toEqual(expect.any(Function));
    lifecycleOptions?.onTiming?.({ operation: "list_boxes", durationMs: 3, ok: true });

    await service.application.stop();
    expect(storageClose).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(configuredMasterKey).toEqual(Buffer.alloc(32));
    expect(configuredHmacKey).toEqual(Buffer.alloc(32));
  });

  it.each([
    { mode: "on", pollOverride: true },
    { mode: "shadow", pollOverride: false },
  ])("wires the direct transport facade when the gate is $mode", async ({ mode, pollOverride }) => {
    const db = database();
    (db.sql.unsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const store = {} as RuntimeStore;
    let kernelInput: CreateRuntimeKernelInput | undefined;
    const factories = {
      createDatabase: () => db,
      createStore: () => store,
      createLifecycle: () => ({} as unknown as BoxRuntimeLifecycleClient),
      createBoxRuntime: vi.fn(() => ({
        layoutIdentity: () => ({
          layoutVersion: 14,
          packages: [],
          qmdPackage: "@tobilu/qmd@2.8.3",
          minimumPiVersion: "0.84.2",
          overlayRevision: 1,
          overlayMarker: "overlay",
          baseMarker: "14:base",
          fullMarker: "14:base:overlay=overlay",
          imageMarker: "14:base:overlay=overlay:skill=none:boot=1",
          imageName: "companion-l14-aaaaaaaaaaaa",
        }),
      } as unknown as CompanionBoxRuntimeV2)),
      createArchiveStorage: () => ({
        load: vi.fn(async () => Buffer.from("archive")),
        store: vi.fn(async () => undefined),
        close: vi.fn(),
      }),
      loadBundledSkill: vi.fn(async () => ({
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      })),
      createKernel: (input) => {
        kernelInput = input;
        return { scheduler: scheduler() };
      },
    } satisfies RuntimeProductionFactories;

    const service = await buildProductionRuntimeService({
      env: {
        DATABASE_COMPANION_RUNTIME_URL: databaseUrl,
        COMPANION_COMPANIONS_ENABLED: "true",
        COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
        COMPANION_BOX_API_KEY: "box-secret",
        COMPANION_BOX_API_BASE: "http://127.0.0.1:13400",
        COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 17).toString("base64"),
        COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: Buffer.alloc(32, 23).toString("base64"),
        COMPANION_API_URL: "http://127.0.0.1:3001",
        COMPANION_DIRECT_TRANSPORT: mode,
      },
      factories,
    });

    // `on` hands the kernel the per-Box direct poll interval; `shadow` keeps the flat cadence.
    if (pollOverride) {
      const interval = kernelInput?.eventPollIntervalMs;
      expect(interval).toEqual(expect.any(Function));
      expect((interval as (input: { boxId: string }) => number)({ boxId: "bx_23456789" })).toBe(500);
    } else {
      expect(kernelInput?.eventPollIntervalMs).toBeUndefined();
    }
    expect(kernelInput?.pi).toEqual(expect.any(Object));
    await service.application.stop();
  });
});
