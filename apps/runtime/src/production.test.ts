/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- Composition fixtures are hand-written fakes matching the used factory surfaces exactly. */
import { describe, expect, it, vi } from "vitest";
import type {
  AsciiBoxMaintenanceClientOptions,
  BoxRuntimeLifecycleClient,
  CompanionBoxRuntimeV2,
} from "@companion/box-runtime";

import type { RuntimeApplicationScheduler } from "./application";
import type { RuntimeDatabase } from "./database";
import { RuntimeDatabaseRoleError } from "./database";
import {
  buildProductionRuntimeService,
  type RuntimeArchiveStorage,
  type RuntimeProductionFactories,
} from "./production";
import type { RuntimeV3SchedulerOptions } from "./schedulerAdapter";

const databaseUrl = "postgres://companion_runtime:secret@127.0.0.1:5432/companion";

function scheduler(): RuntimeApplicationScheduler {
  return {
    start: vi.fn(),
    stopClaims: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => ({
      claimLoopAlive: false,
      fatal: false,
      lastSweepStartedAt: null,
      lastSweepCompletedAt: null,
      claimLoopErrorAt: null,
      activeCount: 0,
    }),
  };
}

function database(): RuntimeDatabase {
  return {
    sql: { unsafe: vi.fn() } as unknown as RuntimeDatabase["sql"],
    verifyRole: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function runtimeFixture(): CompanionBoxRuntimeV2 {
  return {
    existingBoxStatus: vi.fn(async (input: { boxId: string }) => ({
      boxId: input.boxId,
      state: "ready" as const,
    })),
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
  } as unknown as CompanionBoxRuntimeV2;
}

function archiveStorage(close: () => void = vi.fn()): RuntimeArchiveStorage {
  return {
    load: vi.fn(async () => Buffer.from("archive")),
    store: vi.fn(async () => undefined),
    close,
  };
}

function bundledSkill() {
  return {
    slug: "companion",
    version: "1.0.0",
    checksum: `sha256:${"1".repeat(64)}`,
    archive: Buffer.from("bundled"),
  };
}

describe("production runtime composition", () => {
  it("closes the pool and constructs no runtime dependency when role verification refuses startup", async () => {
    const db = database();
    const failure = new RuntimeDatabaseRoleError("login_mismatch");
    vi.mocked(db.verifyRole).mockRejectedValue(failure);
    const createScheduler = vi.fn(() => scheduler());

    await expect(buildProductionRuntimeService({
      env: {
        DATABASE_COMPANION_RUNTIME_URL: databaseUrl,
        COMPANION_COMPANIONS_ENABLED: "false",
      },
      factories: { createDatabase: () => db, createScheduler },
    })).rejects.toBe(failure);

    expect(createScheduler).not.toHaveBeenCalled();
    expect(db.sql.unsafe).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("constructs a claim-free v3 scheduler and no external client on the kill-switch path", async () => {
    const db = database();
    let schedulerInput: RuntimeV3SchedulerOptions | undefined;
    const createLifecycle = vi.fn(() => ({} as BoxRuntimeLifecycleClient));
    const createBoxRuntime = vi.fn(() => ({} as CompanionBoxRuntimeV2));
    const createArchiveStorage = vi.fn(() => archiveStorage());
    const loadBundledSkill = vi.fn();
    const factories = {
      createDatabase: () => db,
      createLifecycle,
      createBoxRuntime,
      createArchiveStorage,
      loadBundledSkill,
      createScheduler: (input) => {
        schedulerInput = input;
        return scheduler();
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
    expect(schedulerInput).toEqual(expect.objectContaining({ claimsEnabled: false }));
    expect(Object.keys(schedulerInput ?? {}).sort()).toEqual([
      "claimsEnabled",
      "executorId",
      "sweepIntervalMs",
    ]);
    expect(createLifecycle).not.toHaveBeenCalled();
    expect(createBoxRuntime).not.toHaveBeenCalled();
    expect(createArchiveStorage).not.toHaveBeenCalled();
    expect(loadBundledSkill).not.toHaveBeenCalled();
    await service.application.stop();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("wires only v3 convergence, isolated Box inputs, and clears key bytes after drain", async () => {
    const masterKey = Buffer.alloc(32, 17);
    const hmacKey = Buffer.alloc(32, 23);
    const db = database();
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
    let schedulerInput: RuntimeV3SchedulerOptions | undefined;
    let configuredMasterKey: Buffer | undefined;
    let configuredHmacKey: Buffer | undefined;
    let boxEnv: NodeJS.ProcessEnv | undefined;
    let lifecycleOptions: AsciiBoxMaintenanceClientOptions | undefined;
    const storageClose = vi.fn();
    const factories = {
      createDatabase: (config) => {
        configuredMasterKey = config.masterKey ?? undefined;
        configuredHmacKey = config.desktopHmacSecret ?? undefined;
        return db;
      },
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
        } as unknown as BoxRuntimeLifecycleClient;
      },
      createBoxRuntime: vi.fn(runtimeFixture),
      createArchiveStorage: () => archiveStorage(storageClose),
      loadBundledSkill: vi.fn(async () => bundledSkill()),
      createScheduler: (input) => {
        schedulerInput = input;
        return scheduler();
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
    expect(schedulerInput).toEqual(expect.objectContaining({
      claimsEnabled: true,
      convergence: expect.objectContaining({ converge: expect.any(Function) }),
      backgroundConvergence: expect.objectContaining({ converge: expect.any(Function) }),
      deadlineSweep: expect.objectContaining({ converge: expect.any(Function) }),
      sweepIntervalMs: 2_000,
    }));
    expect(Object.keys(schedulerInput ?? {}).sort()).toEqual([
      "backgroundConvergence",
      "claimsEnabled",
      "convergence",
      "deadlineSweep",
      "executorId",
      "sweepIntervalMs",
    ]);
    expect(boxEnv).toEqual({
      COMPANION_BOX_API_KEY: "box-secret",
      COMPANION_BOX_API_BASE: "http://127.0.0.1:13400",
      COMPANION_BOX_TTL_SECONDS: "21600",
      COMPANION_DIRECT_TRANSPORT: "off",
      COMPANION_PI_MCP_ADAPTER_PACKAGE: "npm:pi-mcp-adapter@2.12.1",
    });
    expect(lifecycleOptions?.onTiming).toEqual(expect.any(Function));
    lifecycleOptions?.onTiming?.({ operation: "list_boxes", durationMs: 3, ok: true });

    await service.application.stop();
    expect(storageClose).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(configuredMasterKey).toEqual(Buffer.alloc(32));
    expect(configuredHmacKey).toEqual(Buffer.alloc(32));
  });

  it.each(["on", "shadow"] as const)(
    "keeps direct transport mode %s behind the v3-only scheduler surface",
    async (mode) => {
      const db = database();
      (db.sql.unsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      let schedulerInput: RuntimeV3SchedulerOptions | undefined;
      const factories = {
        createDatabase: () => db,
        createLifecycle: () => ({} as unknown as BoxRuntimeLifecycleClient),
        createBoxRuntime: vi.fn(runtimeFixture),
        createArchiveStorage: () => archiveStorage(),
        loadBundledSkill: vi.fn(async () => bundledSkill()),
        createScheduler: (input) => {
          schedulerInput = input;
          return scheduler();
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

      expect(schedulerInput?.claimsEnabled).toBe(true);
      expect(Object.keys(schedulerInput ?? {}).sort()).toEqual([
        "backgroundConvergence",
        "claimsEnabled",
        "convergence",
        "deadlineSweep",
        "executorId",
        "sweepIntervalMs",
      ]);
      await service.application.stop();
    },
  );
});
