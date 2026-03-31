import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSetupScripts,
  startServices,
  stopAllServices,
  getServices,
  getServiceStatuses,
  stopAll,
  reassociateServices,
  restartService,
} from "./launch-runner.js";
import type { ResolvedLaunchConfig, ResolvedService } from "./launch-config.js";
import { companionBus } from "./event-bus.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "launch-runner-test-"));
}

function makeResolved(services: Record<string, ResolvedService>): ResolvedLaunchConfig {
  return { setup: [], services, ports: {} };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("launch-runner", () => {
  let tmpDir: string;
  const sessionIds: string[] = [];

  afterEach(() => {
    // Clean up any services started during tests
    for (const id of sessionIds) {
      stopAllServices(id);
    }
    sessionIds.length = 0;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- runSetupScripts --

  describe("runSetupScripts", () => {
    test("runs a simple echo command successfully", async () => {
      tmpDir = makeTmpDir();
      const result = await runSetupScripts(
        [{ name: "Echo test", command: "echo hello" }],
        { cwd: tmpDir },
      );
      expect(result.ok).toBe(true);
    });

    test("captures output via onOutput callback", async () => {
      tmpDir = makeTmpDir();
      const lines: string[] = [];
      await runSetupScripts(
        [{ name: "Output test", command: "echo line1 && echo line2" }],
        { cwd: tmpDir, onOutput: (_name, line) => lines.push(line) },
      );
      expect(lines.some((l) => l.includes("line1"))).toBe(true);
      expect(lines.some((l) => l.includes("line2"))).toBe(true);
    });

    test("fails fast on non-zero exit", async () => {
      tmpDir = makeTmpDir();
      const result = await runSetupScripts(
        [
          { name: "Fail", command: "exit 42" },
          { name: "Never runs", command: "echo should-not-run" },
        ],
        { cwd: tmpDir },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Fail");
      expect(result.error).toContain("exit 42");
    });

    test("runs multiple scripts sequentially", async () => {
      tmpDir = makeTmpDir();
      const order: string[] = [];
      const result = await runSetupScripts(
        [
          { name: "First", command: "echo first" },
          { name: "Second", command: "echo second" },
        ],
        { cwd: tmpDir, onOutput: (name, _line) => order.push(name) },
      );
      expect(result.ok).toBe(true);
      // "First" outputs should appear before "Second" outputs
      const firstIdx = order.indexOf("First");
      const secondIdx = order.indexOf("Second");
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    test("handles timeout", async () => {
      tmpDir = makeTmpDir();
      const result = await runSetupScripts(
        [{ name: "Slow", command: "sleep 10" }],
        { cwd: tmpDir, timeout: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("timed out");
    });
  });

  // -- startServices --

  describe("startServices", () => {
    test("starts a single service and marks it ready (no readyPattern)", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-1`;
      sessionIds.push(sessionId);

      // Use a long-running process (sleep) so it doesn't exit before we check
      const resolved = makeResolved({
        bg: {
          name: "bg",
          command: "sleep 30",
          env: {},
          dependsOn: {},
          readyTimeout: 5,
        },
      });

      const statuses: Array<{ name: string; status: string }> = [];
      const result = await startServices(resolved, {
        cwd: tmpDir,
        sessionId,
        onProgress: (name, status) => statuses.push({ name, status }),
      });

      expect(result.ok).toBe(true);
      const handles = getServices(sessionId);
      expect(handles).toHaveLength(1);
      expect(handles[0].status).toBe("ready");
      expect(handles[0].pid).toBeDefined();

      // Check progress events
      expect(statuses).toContainEqual({ name: "bg", status: "starting" });
      expect(statuses).toContainEqual({ name: "bg", status: "started" });
    });

    test("starts service and detects readyPattern", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-2`;
      sessionIds.push(sessionId);

      const resolved = makeResolved({
        web: {
          name: "web",
          // Echo ready marker then keep running
          command: "echo 'server listening on :3000' && sleep 30",
          env: {},
          dependsOn: {},
          readyPattern: "listening on",
          readyTimeout: 5,
        },
      });

      const result = await startServices(resolved, {
        cwd: tmpDir,
        sessionId,
      });

      expect(result.ok).toBe(true);
      const handles = getServices(sessionId);
      expect(handles[0].status).toBe("ready");
    }, 10_000);

    test("readyPattern timeout marks as started, not failed", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-3`;
      sessionIds.push(sessionId);

      const resolved = makeResolved({
        web: {
          name: "web",
          command: "echo 'no match here' && sleep 30",
          env: {},
          dependsOn: {},
          readyPattern: "NEVER_MATCHES",
          readyTimeout: 1, // 1 second timeout
        },
      });

      const progressEvents: Array<{ name: string; status: string; detail?: string }> = [];
      const result = await startServices(resolved, {
        cwd: tmpDir,
        sessionId,
        onProgress: (name, status, detail) => progressEvents.push({ name, status, detail }),
      });

      expect(result.ok).toBe(true);
      // Should have a timeout warning
      expect(progressEvents.some((e) => e.detail?.includes("timeout"))).toBe(true);
    });

    test("respects dependency ordering: sequential chain", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-4`;
      sessionIds.push(sessionId);

      // db → api (db must be ready before api starts)
      const resolved = makeResolved({
        db: {
          name: "db",
          command: "echo 'db ready' && sleep 30",
          env: {},
          dependsOn: {},
          readyPattern: "db ready",
          readyTimeout: 5,
        },
        api: {
          name: "api",
          command: "sleep 30",
          env: {},
          dependsOn: { db: "ready" },
          readyTimeout: 5,
        },
      });

      const startOrder: string[] = [];
      const result = await startServices(resolved, {
        cwd: tmpDir,
        sessionId,
        onProgress: (name, status) => {
          if (status === "starting") startOrder.push(name);
        },
      });

      expect(result.ok).toBe(true);
      // db must start before api
      expect(startOrder.indexOf("db")).toBeLessThan(startOrder.indexOf("api"));
    });

    test("independent services start in the same wave", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-5`;
      sessionIds.push(sessionId);

      const resolved = makeResolved({
        a: { name: "a", command: "sleep 30", env: {}, dependsOn: {}, readyTimeout: 5 },
        b: { name: "b", command: "sleep 30", env: {}, dependsOn: {}, readyTimeout: 5 },
      });

      const startTimes: Record<string, number> = {};
      const result = await startServices(resolved, {
        cwd: tmpDir,
        sessionId,
        onProgress: (name, status) => {
          if (status === "starting") startTimes[name] = Date.now();
        },
      });

      expect(result.ok).toBe(true);
      // Both should start within 100ms of each other (parallel)
      expect(Math.abs(startTimes.a - startTimes.b)).toBeLessThan(100);
    });

    test("marks a service failed when it exits immediately", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-5c`;
      sessionIds.push(sessionId);

      const resolved = makeResolved({
        broken: {
          name: "broken",
          command: "exit 1",
          env: {},
          dependsOn: {},
          readyTimeout: 1,
        },
      });

      const result = await startServices(resolved, { cwd: tmpDir, sessionId });

      expect(result.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getServices(sessionId)[0]?.status).toBe("failed");
    });
  });

  // -- Lifecycle --

  describe("lifecycle", () => {
    test("stopAllServices kills running processes", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-6`;
      sessionIds.push(sessionId);

      const resolved = makeResolved({
        bg: { name: "bg", command: "sleep 60", env: {}, dependsOn: {}, readyTimeout: 5 },
      });

      await startServices(resolved, { cwd: tmpDir, sessionId });
      expect(getServices(sessionId)).toHaveLength(1);

      stopAllServices(sessionId);
      expect(getServices(sessionId)).toHaveLength(0);
    });

    test("getServiceStatuses returns serializable data", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-7`;
      sessionIds.push(sessionId);

      const resolved = makeResolved({
        web: { name: "web", command: "sleep 30", env: {}, dependsOn: {}, readyTimeout: 5 },
      });

      await startServices(resolved, { cwd: tmpDir, sessionId });
      const statuses = getServiceStatuses(sessionId);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].name).toBe("web");
      expect(statuses[0].status).toBe("ready");
      expect(typeof statuses[0].pid).toBe("number");
    });

    test("stopAll cleans up all sessions", async () => {
      tmpDir = makeTmpDir();
      const s1 = `test-${Date.now()}-8a`;
      const s2 = `test-${Date.now()}-8b`;
      sessionIds.push(s1, s2);

      const resolved = makeResolved({
        bg: { name: "bg", command: "sleep 30", env: {}, dependsOn: {}, readyTimeout: 5 },
      });

      await startServices(resolved, { cwd: tmpDir, sessionId: s1 });
      await startServices(resolved, { cwd: tmpDir, sessionId: s2 });

      stopAll();
      expect(getServices(s1)).toHaveLength(0);
      expect(getServices(s2)).toHaveLength(0);
    });

    test("reassociateServices retargets future service_log events to the new session", async () => {
      tmpDir = makeTmpDir();
      const oldSessionId = `test-${Date.now()}-9-old`;
      const newSessionId = `test-${Date.now()}-9-new`;
      sessionIds.push(newSessionId);

      const events: Array<{ sessionId: string; serviceName: string; line: string }> = [];
      const unsubscribe = companionBus.on("service:log", (event) => {
        if (event.serviceName === "logger") {
          events.push(event);
        }
      });

      try {
        const resolved = makeResolved({
          logger: {
            name: "logger",
            command: "echo first && sleep 1 && echo second && sleep 30",
            env: {},
            dependsOn: {},
            readyTimeout: 5,
          },
        });

        const result = await startServices(resolved, { cwd: tmpDir, sessionId: oldSessionId });
        expect(result.ok).toBe(true);

        reassociateServices(oldSessionId, newSessionId);
        await new Promise((resolve) => setTimeout(resolve, 1600));

        expect(events.some((event) => event.line.includes("second") && event.sessionId === newSessionId)).toBe(true);
        expect(events.some((event) => event.line.includes("second") && event.sessionId === oldSessionId)).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    test("restartService preserves failed status when the restarted process exits immediately", async () => {
      tmpDir = makeTmpDir();
      const sessionId = `test-${Date.now()}-10`;
      sessionIds.push(sessionId);

      const initial = makeResolved({
        web: {
          name: "web",
          command: "sleep 30",
          env: {},
          dependsOn: {},
          readyTimeout: 5,
        },
      });

      const restartConfig = makeResolved({
        web: {
          name: "web",
          command: "exit 1",
          env: {},
          dependsOn: {},
          readyTimeout: 1,
        },
      });

      const started = await startServices(initial, { cwd: tmpDir, sessionId });
      expect(started.ok).toBe(true);

      const result = await restartService(sessionId, "web", restartConfig, { cwd: tmpDir });

      expect(result.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getServices(sessionId)[0]?.status).toBe("failed");
    });
  });
});
