import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";

import {
  DESKTOP_REQUEST_PATH,
  DESKTOP_REQUEST_ID_HEADER,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIMESTAMP_HEADER,
  signDesktopRequest,
} from "@companion/companion-runtime/runtime-support";
import {
  createRuntimeHttpServer,
  type RuntimeHttpServer,
  type RuntimeSchedulerHealthSnapshot,
} from "./server";

const hmacSecret = Buffer.alloc(32, 23);
const nowMs = 1_800_000_000_000;
const ids = {
  orgId: "11111111-1111-4111-8111-111111111111",
  companionId: "22222222-2222-4222-8222-222222222222",
  actorId: "test-user",
};
const openServers: RuntimeHttpServer[] = [];
let requestIdSequence = 0;

function nextRequestId(): string {
  requestIdSequence += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${requestIdSequence.toString().padStart(12, "0")}`;
}

function healthySnapshot(): RuntimeSchedulerHealthSnapshot {
  return {
    claimLoopAlive: true,
    fatal: false,
    lastSweepStartedAt: new Date(nowMs - 100),
    lastSweepCompletedAt: new Date(nowMs - 50),
    claimLoopErrorAt: null,
    activeCount: 2,
  };
}

async function start(input: {
  snapshot?: RuntimeSchedulerHealthSnapshot;
  ping?: () => Promise<void>;
  authorizeAndMint?: ReturnType<typeof vi.fn>;
  replayIds?: Set<string>;
  image?: () => {
    loopAlive: boolean;
    status: string | null;
    lastErrorCode: string | null;
    coldFallbackCount: number;
  };
} = {}) {
  let snapshot = input.snapshot ?? healthySnapshot();
  const authorizeAndMint = input.authorizeAndMint ?? vi.fn(async () => ({
    url: "https://desktop.example.test/session?token=never-log-this",
    provisioning: false,
    transport: "vnc" as const,
  }));
  const replayIds = input.replayIds ?? new Set<string>();
  const server = createRuntimeHttpServer({
    host: "127.0.0.1",
    port: 0,
    sweepIntervalMs: 2_000,
    releaseId: "production-2026-08-17.3",
    desktopHmacSecret: hmacSecret,
    desktopMaxSkewSeconds: 30,
    health: {
      ping: input.ping ?? (async () => undefined),
      snapshot: () => snapshot,
      image: input.image,
    },
    desktop: { authorizeAndMint },
    desktopReplay: {
      consume: vi.fn(async ({ requestId }) => {
        if (replayIds.has(requestId)) return false;
        replayIds.add(requestId);
        return true;
      }),
    },
    now: () => nowMs,
    healthPingTimeoutMs: 20,
  });
  await server.listen();
  openServers.push(server);
  return {
    server,
    authorizeAndMint,
    setSnapshot(next: RuntimeSchedulerHealthSnapshot) { snapshot = next; },
  };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

describe("private runtime HTTP server", () => {
  it("reports only stable health fields and fails stale or unavailable dependencies", async () => {
    const handle = await start();
    const healthy = await fetch(`${handle.server.baseUrl}/healthz`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({
      status: "ok",
      checks: { database: true, claim_loop: true, sweep_fresh: true },
      last_sweep_started_at: new Date(nowMs - 100).toISOString(),
      last_sweep_completed_at: new Date(nowMs - 50).toISOString(),
      claim_loop_error_at: null,
      active_count: 2,
      release_id: "production-2026-08-17.3",
    });

    // Flap damping: a sweep completed 6s ago (older than the previous 2*sweep+1s = 5s window) is
    // still fresh under the widened max(5*sweep, 15s) window, so a brief pause does not flip 503.
    handle.setSnapshot({
      ...healthySnapshot(),
      lastSweepCompletedAt: new Date(nowMs - 6_000),
    });
    const stillFresh = await fetch(`${handle.server.baseUrl}/healthz`);
    expect(stillFresh.status).toBe(200);
    expect(await stillFresh.json()).toMatchObject({ checks: { sweep_fresh: true } });

    // Only a sweep older than the full widened window is stale.
    handle.setSnapshot({
      ...healthySnapshot(),
      lastSweepCompletedAt: new Date(nowMs - 16_000),
    });
    const staleSweep = await fetch(`${handle.server.baseUrl}/healthz`);
    expect(staleSweep.status).toBe(503);
    expect(await staleSweep.json()).toMatchObject({ checks: { sweep_fresh: false } });

    handle.setSnapshot({
      ...healthySnapshot(),
      lastSweepCompletedAt: new Date(nowMs - 5_001),
      claimLoopErrorAt: new Date(nowMs - 10),
    });
    const unhealthy = await fetch(`${handle.server.baseUrl}/healthz`);
    expect(unhealthy.status).toBe(503);
    const body = JSON.stringify(await unhealthy.json());
    expect(body).not.toContain("Error");
    expect(body).not.toContain(ids.companionId);
    expect(body).not.toContain("http");

    const databaseDown = await start({ ping: async () => { throw new Error("postgres secret"); } });
    const failedPing = await fetch(`${databaseDown.server.baseUrl}/healthz`);
    expect(failedPing.status).toBe(503);
    expect(await failedPing.json()).toMatchObject({ checks: { database: false } });
  });

  it("surfaces image builder liveness: a dead loop fails health, a failed digest only informs", async () => {
    const aliveFailed = await start({
      image: () => ({
        loopAlive: true,
        status: "failed",
        lastErrorCode: "image_build_failed",
        coldFallbackCount: 4,
      }),
    });
    const informational = await fetch(`${aliveFailed.server.baseUrl}/healthz`);
    // A failed digest is reported but must NOT flip health — creates still work via cold fallback.
    expect(informational.status).toBe(200);
    expect(await informational.json()).toMatchObject({
      status: "ok",
      checks: { image_builder: true },
      image: { status: "failed", last_error_code: "image_build_failed", cold_fallback_count: 4 },
    });

    const deadLoop = await start({
      image: () => ({
        loopAlive: false,
        status: "building",
        lastErrorCode: null,
        coldFallbackCount: 0,
      }),
    });
    const unhealthy = await fetch(`${deadLoop.server.baseUrl}/healthz`);
    // A dead builder loop means every create silently cold-installs — a hard 503.
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toMatchObject({
      status: "unhealthy",
      checks: { image_builder: false },
    });
  });

  it("binds desktop authorization to timestamp, path, and exact body before SQL reauthorization", async () => {
    const handle = await start();
    const rawBody = Buffer.from(JSON.stringify(ids), "utf8");
    const timestamp = Math.floor(nowMs / 1_000);
    const requestId = nextRequestId();
    const signature = signDesktopRequest({
      method: "POST",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      requestId,
      rawBody,
    }, hmacSecret);
    const response = await fetch(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
        [DESKTOP_REQUEST_ID_HEADER]: requestId,
        [DESKTOP_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      desktop_url: "https://desktop.example.test/session?token=never-log-this",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
    });
    expect(handle.authorizeAndMint).toHaveBeenCalledWith({
      ...ids,
      signal: expect.any(AbortSignal),
    });

    const tampered = await fetch(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
        [DESKTOP_REQUEST_ID_HEADER]: requestId,
        [DESKTOP_SIGNATURE_HEADER]: signature,
      },
      body: JSON.stringify({ ...ids, actorId: "44444444-4444-4444-8444-444444444444" }),
    });
    expect(tampered.status).toBe(401);
    expect(handle.authorizeAndMint).toHaveBeenCalledTimes(1);

    const staleTimestamp = timestamp - 31;
    const staleRequestId = nextRequestId();
    const stale = await fetch(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(staleTimestamp),
        [DESKTOP_REQUEST_ID_HEADER]: staleRequestId,
        [DESKTOP_SIGNATURE_HEADER]: signDesktopRequest({
          method: "POST",
          pathname: DESKTOP_REQUEST_PATH,
          timestamp: staleTimestamp,
          requestId: staleRequestId,
          rawBody,
        }, hmacSecret),
      },
      body: rawBody,
    });
    expect(stale.status).toBe(401);
    expect(handle.authorizeAndMint).toHaveBeenCalledTimes(1);
  });

  it("rejects replay of a previously authenticated desktop request", async () => {
    const handle = await start();
    const rawBody = Buffer.from(JSON.stringify(ids));
    const timestamp = Math.floor(nowMs / 1_000);
    const requestId = nextRequestId();
    const signature = signDesktopRequest({
      method: "POST",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      requestId,
      rawBody,
    }, hmacSecret);
    const send = async () => await fetch(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
        [DESKTOP_REQUEST_ID_HEADER]: requestId,
        [DESKTOP_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
    });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
    expect(handle.authorizeAndMint).toHaveBeenCalledOnce();
  });

  it("uses shared replay storage across two server replicas and a restart", async () => {
    const replayIds = new Set<string>();
    const first = await start({ replayIds });
    const second = await start({ replayIds });
    const rawBody = Buffer.from(JSON.stringify(ids));
    const timestamp = Math.floor(nowMs / 1_000);
    const requestId = nextRequestId();
    const signature = signDesktopRequest({
      method: "POST",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      requestId,
      rawBody,
    }, hmacSecret);
    const send = async (server: RuntimeHttpServer): Promise<number> => (await fetch(
      `${server.baseUrl}${DESKTOP_REQUEST_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
          [DESKTOP_REQUEST_ID_HEADER]: requestId,
          [DESKTOP_SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
      },
    )).status;

    const statuses = await Promise.all([send(first.server), send(second.server)]);
    expect(statuses.sort()).toEqual([200, 401]);
    await first.server.close();
    const restarted = await start({ replayIds });
    expect(await send(restarted.server)).toBe(401);
    expect(first.authorizeAndMint.mock.calls.length + second.authorizeAndMint.mock.calls.length)
      .toBe(1);
    expect(restarted.authorizeAndMint).not.toHaveBeenCalled();
  });

  it("rejects extra desktop fields and never logs or returns provider failure details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerSecret = "https://desktop.invalid/?token=provider-secret";
    const authorizeAndMint = vi.fn(async () => {
      throw new Error(providerSecret);
    });
    const handle = await start({ authorizeAndMint });
    const extraBody = Buffer.from(JSON.stringify({ ...ids, boxId: "forbidden" }));
    const timestamp = Math.floor(nowMs / 1_000);
    const extraResponse = await signedDesktop(handle.server, extraBody, timestamp);
    expect(extraResponse.status).toBe(400);
    expect(authorizeAndMint).not.toHaveBeenCalled();

    const validBody = Buffer.from(JSON.stringify(ids));
    const unavailable = await signedDesktop(handle.server, validBody, timestamp);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(providerSecret);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(providerSecret);
  });

  it("rejects a chunked body over the limit with 413 before authorization", async () => {
    const handle = await start();
    const response = await postChunked(`${handle.server.baseUrl}${DESKTOP_REQUEST_PATH}`, [
      Buffer.alloc(2_049, 1),
      Buffer.alloc(2_048, 1),
    ], {
        "Content-Type": "application/json",
        [DESKTOP_TIMESTAMP_HEADER]: String(Math.floor(nowMs / 1_000)),
        [DESKTOP_SIGNATURE_HEADER]: `v1=${"0".repeat(64)}`,
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "request_too_large" });
    expect(handle.authorizeAndMint).not.toHaveBeenCalled();
  });

  it("fails desktop closed when the disabled runtime has no HMAC secret", async () => {
    const authorizeAndMint = vi.fn();
    const server = createRuntimeHttpServer({
      host: "127.0.0.1",
      port: 0,
      sweepIntervalMs: 2_000,
      releaseId: "production-2026-08-17.3",
      desktopHmacSecret: null,
      desktopMaxSkewSeconds: 30,
      health: { ping: async () => undefined, snapshot: healthySnapshot },
      desktop: { authorizeAndMint },
      desktopReplay: { consume: async () => false },
      now: () => nowMs,
    });
    await server.listen();
    openServers.push(server);

    const response = await fetch(`${server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "desktop_not_configured" });
    expect(authorizeAndMint).not.toHaveBeenCalled();
  });
});

function signedDesktop(
  server: RuntimeHttpServer,
  rawBody: Buffer,
  timestamp: number,
): Promise<Response> {
  const requestId = nextRequestId();
  return fetch(`${server.baseUrl}${DESKTOP_REQUEST_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
      [DESKTOP_REQUEST_ID_HEADER]: requestId,
      [DESKTOP_SIGNATURE_HEADER]: signDesktopRequest({
        method: "POST",
        pathname: DESKTOP_REQUEST_PATH,
        timestamp,
        requestId,
        rawBody,
      }, hmacSecret),
    },
    body: rawBody,
  });
}

async function postChunked(
  url: string,
  chunks: Buffer[],
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, (response) => {
      const body: Buffer[] = [];
      response.on("data", (chunk: Buffer) => body.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(body).toString("utf8"),
      }));
    });
    request.once("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
