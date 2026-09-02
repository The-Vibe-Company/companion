/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Test fixtures narrow live HTTP server addresses, JSON bodies, and thrown values the same way the agent core test does. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  COMPANION_BOX_AGENT_EVENT_WAIT_MS,
  CompanionBoxAgentClient,
  CompanionBoxAgentRequestError,
} from "./companionBoxAgentClient";
import { COMPANION_BOX_AGENT_LONG_POLL_CAP_MS } from "./companionBoxAgentCore";
import { companionPiDispatchFingerprint } from "./companionPiBrokerCore";

const PROXY_TOKEN = "p".repeat(32);
const BEARER = "b".repeat(64);
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

interface Seen {
  method: string;
  url: URL;
  authorization: string | null;
  body: string;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise((resolve) => server.close(resolve))));
});

async function fakeAgent(
  handle: (seen: Seen, response: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: Seen[] }> {
  const requests: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const seen: Seen = {
        method: request.method ?? "GET",
        url: new URL(request.url ?? "/", "http://agent.invalid"),
        authorization: typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : null,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(seen);
      handle(seen, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/boxes/bx_test1234`, requests };
}

function client(baseUrl: string, stateTimeoutMs?: number): CompanionBoxAgentClient {
  return new CompanionBoxAgentClient({
    endpoint: { hostedUrl: baseUrl, proxyToken: PROXY_TOKEN, bearerToken: BEARER },
    ...(stateTimeoutMs === undefined ? {} : { stateTimeoutMs }),
  });
}

function json(response: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

const BROKER_STATE = {
  invocationId: "inv-1",
  layoutMarker: "layout-14/abc",
  activeAttemptId: null,
  tailCursor: 7,
  acknowledgedCursor: 7,
  counters: {
    malformedLines: 0,
    oversizedLines: 0,
    unterminatedLines: 0,
    unknownEvents: 0,
    unboundEvents: 0,
    orphanResponses: 0,
  },
  modelInput: ["text"],
};

describe("CompanionBoxAgentClient", () => {
  it("sends the proxy token on every request plus the bearer header, and parses broker state", async () => {
    const agent = await fakeAgent((seen, response) => {
      expect(seen.url.searchParams.get("_token")).toBe(PROXY_TOKEN);
      expect(seen.authorization).toBe(`Bearer ${BEARER}`);
      json(response, 200, BROKER_STATE);
    });
    const state = await client(agent.baseUrl).brokerState();
    expect(state.invocationId).toBe("inv-1");
    expect(state.tailCursor).toBe(7);
    expect(agent.requests[0]?.url.pathname).toBe("/boxes/bx_test1234/v1/broker/state");
  });

  it("maps the health payload and sanitizes the unit verdict", async () => {
    const agent = await fakeAgent((_seen, response) => {
      json(response, 200, {
        agentVersion: 1,
        piUnit: "active extra-noise",
        brokerSocketReady: true,
        layoutMarker: null,
      });
    });
    const health = await client(agent.baseUrl).health();
    expect(health).toEqual({
      agentVersion: 1,
      piUnit: "active",
      brokerSocketReady: true,
      layoutMarker: null,
    });
  });

  it("long-polls events with after/wait_ms and validates the page with the shared parser", async () => {
    const agent = await fakeAgent((seen, response) => {
      expect(seen.url.pathname).toBe("/boxes/bx_test1234/v1/events");
      expect(seen.url.searchParams.get("after")).toBe("7");
      expect(seen.url.searchParams.get("wait_ms")).toBe(String(COMPANION_BOX_AGENT_EVENT_WAIT_MS));
      json(response, 200, {
        events: [{
          sequence: 8,
          invocationId: "inv-1",
          attemptId: "attempt-1",
          kind: "pi_event",
          event: { type: "agent_start" },
        }],
        nextCursor: 8,
        acknowledgedCursor: 7,
        hasMore: false,
      });
    });
    const page = await client(agent.baseUrl).readEvents({ after: 7 });
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBe(8);
  });

  it("clamps the requested wait to the agent long-poll cap", async () => {
    const agent = await fakeAgent((seen, response) => {
      expect(seen.url.searchParams.get("wait_ms"))
        .toBe(String(COMPANION_BOX_AGENT_LONG_POLL_CAP_MS));
      json(response, 200, { events: [], nextCursor: 0, acknowledgedCursor: 0, hasMore: false });
    });
    await client(agent.baseUrl).readEvents({ after: 0, waitMs: 90_000 });
    expect(agent.requests).toHaveLength(1);
  });

  it("posts acknowledgements as JSON and returns the cursor", async () => {
    const agent = await fakeAgent((seen, response) => {
      expect(seen.method).toBe("POST");
      expect(JSON.parse(seen.body)).toEqual({ through: 9 });
      json(response, 200, { acknowledgedCursor: 9 });
    });
    await expect(client(agent.baseUrl).ackEvents({ through: 9 }))
      .resolves.toEqual({ acknowledgedCursor: 9 });
  });

  it("dispatches and resolves a prompt with the exact durable command identity", async () => {
    const agent = await fakeAgent((seen, response) => {
      if (seen.url.pathname.endsWith("/v1/prompt")) {
        expect(JSON.parse(seen.body)).toEqual({
          commandId: "command-1",
          attemptId: "attempt-1",
          expectedInvocationId: "inv-1",
          message: "hello",
        });
      } else {
        expect(seen.url.pathname).toBe("/boxes/bx_test1234/v1/dispatch/status");
        expect(seen.url.searchParams.get("attempt_id")).toBe("attempt-1");
        expect(seen.url.searchParams.get("command_id")).toBe("command-1");
      }
      json(response, 200, {
        status: "accepted",
        fingerprint: companionPiDispatchFingerprint({
          attemptId: "attempt-1",
          expectedInvocationId: "inv-1",
          message: "hello",
          requiredInput: ["text"],
          clearOutbox: true,
        }),
        piAcknowledged: true,
        attemptId: "attempt-1",
        responseAttemptId: "attempt-1",
        invocationId: "inv-1",
        initialCursor: 7,
        clearOutbox: true,
      });
    });
    const input = {
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
    };
    await expect(client(agent.baseUrl).prompt(input)).resolves.toMatchObject({
      outcome: "accepted",
      responseAttemptId: "attempt-1",
      invocationId: "inv-1",
      initialCursor: 7,
    });
    await expect(client(agent.baseUrl).dispatchStatus(input)).resolves.toMatchObject({
      status: "accepted",
      dispatch: {
        outcome: "accepted",
        responseAttemptId: "attempt-1",
        invocationId: "inv-1",
        initialCursor: 7,
      },
    });
  });

  it("rejects dispatch proof whose durable payload fingerprint differs", async () => {
    const agent = await fakeAgent((_seen, response) => {
      json(response, 200, {
        status: "accepted",
        fingerprint: "0".repeat(64),
        piAcknowledged: true,
        attemptId: "attempt-1",
        invocationId: "inv-1",
        initialCursor: 7,
        clearOutbox: true,
      });
    });
    await expect(client(agent.baseUrl).dispatchStatus({
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
    })).rejects.toMatchObject({ stableCode: "agent_protocol" });
  });

  it("preserves broker ambiguity instead of treating a 502 as a transport failure", async () => {
    const agent = await fakeAgent((_seen, response) => {
      json(response, 502, {
        error: {
          code: "dispatch_ledger_unavailable",
          message: "acknowledgement unavailable",
          ambiguous: true,
        },
      });
    });
    await expect(client(agent.baseUrl).prompt({
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
    })).resolves.toMatchObject({
      outcome: "ambiguous",
      code: "dispatch_ledger_unavailable",
    });
  });

  it("uploads raw attachment bytes before committing the validated manifest", async () => {
    const bytes = Buffer.from("direct attachment");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const agent = await fakeAgent((seen, response) => {
      if (seen.method === "PUT") {
        expect(seen.url.pathname).toBe("/boxes/bx_test1234/v1/files");
        expect(seen.url.searchParams.get("message_id")).toBe(MESSAGE_ID);
        expect(seen.url.searchParams.get("sha256")).toBe(sha256);
        expect(seen.body).toBe("direct attachment");
        json(response, 200, { uploaded: true, position: 0, byteSize: bytes.byteLength, sha256 });
        return;
      }
      const manifest = JSON.parse(seen.body) as { files: Array<Record<string, unknown>> };
      expect(manifest.files[0]).toMatchObject({ filename: "notes.txt", sha256 });
      json(response, 200, {
        files: [{
          ...manifest.files[0],
          path: `~/attachments/${MESSAGE_ID}/0-notes.txt`,
        }],
      });
    });
    await expect(client(agent.baseUrl).stageAttachments({
      messageId: MESSAGE_ID,
      files: [{ position: 0, filename: "notes.txt", contentType: "text/plain", bytes }],
    })).resolves.toEqual([{
      position: 0,
      filename: "notes.txt",
      contentType: "text/plain",
      byteSize: bytes.byteLength,
      path: `~/attachments/${MESSAGE_ID}/0-notes.txt`,
    }]);
    expect(agent.requests.map((request) => request.method)).toEqual(["PUT", "POST"]);
  });

  it("reads direct outbox bytes only when size and digest match the manifest", async () => {
    const bytes = Buffer.from("image bytes");
    const entry = {
      name: "answer.png",
      encodedName: Buffer.from("answer.png").toString("base64"),
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const agent = await fakeAgent((seen, response) => {
      if (seen.url.pathname.endsWith("/v1/outbox/file")) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(bytes);
        return;
      }
      json(response, 200, { entries: [entry] });
    });
    const direct = client(agent.baseUrl);
    await expect(direct.listOutbox()).resolves.toEqual([entry]);
    await expect(direct.readOutboxFile({ entry })).resolves.toEqual({ entry, bytes });
  });

  it.each([
    [401, "agent_auth_failed"],
    [403, "agent_auth_failed"],
    [429, "agent_rate_limited"],
    [503, "agent_broker_unavailable"],
    [502, "agent_broker_failed"],
    [500, "agent_http_error"],
  ] as const)("maps HTTP %s to the stable code %s", async (status, stableCode) => {
    const agent = await fakeAgent((_seen, response) => {
      json(response, status, { error: { code: "x", message: "y", ambiguous: false } });
    });
    const failure = await client(agent.baseUrl).brokerState().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CompanionBoxAgentRequestError);
    expect((failure as CompanionBoxAgentRequestError).stableCode).toBe(stableCode);
    // Expurgated: neither the URL nor any token may leak through the error.
    expect((failure as Error).message).not.toContain(PROXY_TOKEN);
    expect((failure as Error).message).not.toContain(BEARER);
    expect((failure as Error).message).not.toContain("127.0.0.1");
  });

  it("classifies a payload the shared parser rejects as agent_protocol", async () => {
    const agent = await fakeAgent((_seen, response) => {
      json(response, 200, { invocationId: 42 });
    });
    await expect(client(agent.baseUrl).brokerState())
      .rejects.toMatchObject({ stableCode: "agent_protocol" });
  });

  it("classifies non-JSON bodies as agent_protocol", async () => {
    const agent = await fakeAgent((_seen, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Access granted, somehow");
    });
    await expect(client(agent.baseUrl).health())
      .rejects.toMatchObject({ stableCode: "agent_protocol" });
  });

  it("reports an unreachable endpoint as agent_unreachable", async () => {
    const agent = await fakeAgent((_seen, response) => json(response, 200, {}));
    const unreachable = agent.baseUrl.replace(/:\d+\//, ":1/");
    await expect(client(unreachable).health())
      .rejects.toMatchObject({ stableCode: "agent_unreachable" });
  });

  it("times out a state call that hangs", async () => {
    const agent = await fakeAgent(() => {
      // Never respond.
    });
    await expect(client(agent.baseUrl, 100).brokerState())
      .rejects.toMatchObject({ stableCode: "agent_timeout" });
  });

  it("bounds an outbox read by the turn's absolute deadline", async () => {
    const agent = await fakeAgent(() => {
      // Never respond.
    });
    const started = Date.now();
    await expect(client(agent.baseUrl).listOutbox({
      deadlineAt: new Date(Date.now() + 100),
    })).rejects.toMatchObject({ stableCode: "agent_timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("propagates the caller abort reason out of a hanging long-poll", async () => {
    const agent = await fakeAgent(() => {
      // Hold the long-poll open; only the caller signal can end this test quickly.
    });
    const controller = new AbortController();
    const reason = new Error("lease fence lost");
    const pending = client(agent.baseUrl).readEvents({
      after: 0,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 50);
    const started = Date.now();
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("follows one same-origin redirect while keeping the bearer and re-carrying the token", async () => {
    let first = true;
    const agent = await fakeAgent((seen, response) => {
      if (first) {
        first = false;
        response.writeHead(302, { location: seen.url.pathname });
        response.end();
        return;
      }
      expect(seen.url.searchParams.get("_token")).toBe(PROXY_TOKEN);
      expect(seen.authorization).toBe(`Bearer ${BEARER}`);
      json(response, 200, BROKER_STATE);
    });
    const state = await client(agent.baseUrl).brokerState();
    expect(state.invocationId).toBe("inv-1");
    expect(agent.requests).toHaveLength(2);
  });

  it("refuses a cross-origin redirect", async () => {
    const agent = await fakeAgent((_seen, response) => {
      response.writeHead(302, { location: "https://elsewhere.invalid/steal" });
      response.end();
    });
    await expect(client(agent.baseUrl).brokerState())
      .rejects.toMatchObject({ stableCode: "agent_http_error", status: 302 });
  });
});
