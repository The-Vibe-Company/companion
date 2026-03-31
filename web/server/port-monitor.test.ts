import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import {
  startMonitoring,
  stopMonitoring,
  getPortStatuses,
  stopAllMonitors,
  checkPort,
  reassociateMonitoring,
} from "./port-monitor.js";
import { companionBus } from "./event-bus.js";

describe("port-monitor", () => {
  const sessionIds: string[] = [];
  const emitSpy = vi.fn();

  beforeEach(() => {
    emitSpy.mockReset();
    companionBus.on("port:status", emitSpy);
  });

  afterEach(() => {
    companionBus.off("port:status", emitSpy);
    for (const id of sessionIds) {
      stopMonitoring(id);
    }
    sessionIds.length = 0;
  });

  test("startMonitoring initializes port statuses as unknown", () => {
    const sid = `pm-test-${Date.now()}-1`;
    sessionIds.push(sid);

    startMonitoring(sid, {
      "3000": { label: "App", healthCheck: { path: "/", interval: 60 } },
      "5432": { label: "Postgres", protocol: "tcp" },
    });

    const statuses = getPortStatuses(sid);
    expect(statuses).toHaveLength(2);

    const app = statuses.find((s) => s.port === 3000);
    expect(app).toBeDefined();
    expect(app!.label).toBe("App");
    expect(app!.protocol).toBe("http");
    // Status may already be "unhealthy" from the first check, or still "unknown"
    expect(["unknown", "unhealthy"]).toContain(app!.status);

    const pg = statuses.find((s) => s.port === 5432);
    expect(pg).toBeDefined();
    expect(pg!.label).toBe("Postgres");
    expect(pg!.protocol).toBe("tcp");
  });

  test("getPortStatuses returns empty for unknown session", () => {
    expect(getPortStatuses("nonexistent")).toEqual([]);
  });

  test("stopMonitoring clears state", () => {
    const sid = `pm-test-${Date.now()}-2`;
    sessionIds.push(sid);

    startMonitoring(sid, {
      "8080": { label: "Web", healthCheck: { path: "/" } },
    });
    expect(getPortStatuses(sid)).toHaveLength(1);

    stopMonitoring(sid);
    expect(getPortStatuses(sid)).toEqual([]);
  });

  test("stopAllMonitors clears all sessions", () => {
    const s1 = `pm-test-${Date.now()}-3a`;
    const s2 = `pm-test-${Date.now()}-3b`;
    sessionIds.push(s1, s2);

    startMonitoring(s1, { "3000": { label: "A" } });
    startMonitoring(s2, { "4000": { label: "B" } });

    stopAllMonitors();
    expect(getPortStatuses(s1)).toEqual([]);
    expect(getPortStatuses(s2)).toEqual([]);
  });

  test("checkPort returns unhealthy for closed port", async () => {
    const sid = `pm-test-${Date.now()}-4`;
    sessionIds.push(sid);

    // Use a port that's almost certainly not listening
    startMonitoring(sid, {
      "19999": { label: "Closed", healthCheck: { path: "/", interval: 300 } },
    });

    // Wait a bit for the first check to run
    await new Promise((r) => setTimeout(r, 200));
    const status = await checkPort(sid, 19999);
    expect(status).toBe("unhealthy");
  });

  test("associates service name with port", () => {
    const sid = `pm-test-${Date.now()}-5`;
    sessionIds.push(sid);

    startMonitoring(
      sid,
      { "3000": { label: "App", healthCheck: { path: "/" } } },
      { servicePortMap: { web: 3000 } },
    );

    const statuses = getPortStatuses(sid);
    expect(statuses[0].service).toBe("web");
  });

  test("openOnReady flag is included in port status", () => {
    const sid = `pm-test-${Date.now()}-7`;
    sessionIds.push(sid);

    startMonitoring(sid, {
      "5173": { label: "Vite", openOnReady: true },
      "3000": { label: "API" },
    });

    const statuses = getPortStatuses(sid);
    const vite = statuses.find((s) => s.port === 5173);
    expect(vite!.openOnReady).toBe(true);
    const api = statuses.find((s) => s.port === 3000);
    expect(api!.openOnReady).toBeUndefined();
  });

  test("ports without healthCheck are tracked but not checked", () => {
    const sid = `pm-test-${Date.now()}-6`;
    sessionIds.push(sid);

    // No healthCheck config and not TCP → no checks run
    startMonitoring(sid, {
      "9999": { label: "Static" },
    });

    const statuses = getPortStatuses(sid);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("unknown");
    expect(statuses[0].lastCheck).toBe(0);
  });

  test("reassociateMonitoring retargets future emissions to the new session ID", async () => {
    const oldId = `pm-test-${Date.now()}-old`;
    const newId = `pm-test-${Date.now()}-new`;
    sessionIds.push(newId);

    startMonitoring(oldId, {
      "18080": { label: "App", healthCheck: { path: "/", interval: 1 } },
    });

    reassociateMonitoring(oldId, newId);
    stopMonitoring(oldId);

    await checkPort(newId, 18080);

    expect(emitSpy).toHaveBeenCalled();
    expect(emitSpy.mock.calls.some(([payload]) => payload.sessionId === newId)).toBe(true);
    expect(emitSpy.mock.calls.every(([payload]) => payload.sessionId !== oldId)).toBe(true);
  });

  test("sanitizes invalid healthCheck interval values", () => {
    const sid = `pm-test-${Date.now()}-interval`;
    sessionIds.push(sid);

    startMonitoring(sid, {
      "3001": { label: "Bad", healthCheck: { path: "/", interval: 0 } },
      "3002": { label: "Negative", healthCheck: { path: "/", interval: -10 } },
    });

    const statuses = getPortStatuses(sid);
    expect(statuses.map((status) => status.port)).toEqual([3001, 3002]);
  });
});
