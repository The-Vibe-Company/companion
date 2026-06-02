import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { registerMetricsRoutes } from "./metrics-routes.js";

// Mock the singleton so tests don't pollute each other
vi.mock("../metrics-collector.js", () => {
  const mockSnapshot = {
    serverUptimeMs: 60_000,
    snapshotAt: 1710500000000,
    counters: {
      sessionsCreated: { claude: 3 },
      sessionsTerminated: { "0": 1 },
      autoRelaunches: { attempted: 1, succeeded: 1, exhausted: 0 },
      messagesProcessed: { assistant: 10 },
      permissionRequests: {
        total: 5,
        autoApproved: 2,
        autoDenied: 0,
        userApproved: 3,
        userDenied: 0,
      },
      errors: {},
      stateTransitions: { "starting→initializing": 3 },
      wsConnections: { cliOpened: 3, cliClosed: 1, browserOpened: 5, browserClosed: 2 },
    },
    gauges: {
      activeSessions: { ready: 2 },
      totalActiveSessions: 2,
      connectedBrowsers: 3,
      totalPendingMessages: 0,
      totalEventBufferSize: 4,
      totalHistoryMessages: 100,
      memory: { rss: 100_000_000, heapUsed: 50_000_000, heapTotal: 70_000_000, external: 5_000_000 },
    },
    histograms: {
      sessionInitTimeMs: { count: 3, sum: 9000, min: 2000, max: 4000, avg: 3000, p50Bucket: 2500, p95Bucket: 5000, p99Bucket: 5000, buckets: {} },
      turnDurationMs: { count: 10, sum: 50000, min: 1000, max: 15000, avg: 5000, p50Bucket: 5000, p95Bucket: 10000, p99Bucket: 30000, buckets: {} },
      permissionDurationMs: { count: 5, sum: 15000, min: 500, max: 8000, avg: 3000, p50Bucket: 2500, p95Bucket: 10000, p99Bucket: 10000, buckets: {} },
    },
  };

  return {
    metricsCollector: {
      getSnapshot: vi.fn(() => mockSnapshot),
    },
  };
});

describe("GET /metrics", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    const mockGaugeProvider = {
      getSessionMemoryStats: vi.fn(() => []),
      getSessionPhases: vi.fn(() => new Map()),
    };
    registerMetricsRoutes(app, { gaugeProvider: mockGaugeProvider });
  });

  it("returns 200 with valid JSON", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json).toBeDefined();
  });

  it("response contains expected top-level keys", async () => {
    const res = await app.request("/metrics");
    const json = await res.json();

    expect(json.serverUptimeMs).toBeDefined();
    expect(json.snapshotAt).toBeDefined();
    expect(json.counters).toBeDefined();
    expect(json.gauges).toBeDefined();
    expect(json.histograms).toBeDefined();
  });

  it("counters contain sessionsCreated", async () => {
    const res = await app.request("/metrics");
    const json = await res.json();

    expect(json.counters.sessionsCreated).toEqual({ claude: 3 });
  });

  it("gauges contain memory info", async () => {
    const res = await app.request("/metrics");
    const json = await res.json();

    expect(json.gauges.memory.rss).toBeGreaterThan(0);
    expect(json.gauges.memory.heapUsed).toBeGreaterThan(0);
  });

  it("histograms contain session init time", async () => {
    const res = await app.request("/metrics");
    const json = await res.json();

    expect(json.histograms.sessionInitTimeMs.count).toBe(3);
    expect(json.histograms.turnDurationMs.count).toBe(10);
    expect(json.histograms.permissionDurationMs.count).toBe(5);
  });
});
