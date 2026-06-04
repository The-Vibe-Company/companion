/**
 * Tests for the console API client, focused on the contract that the rest of the
 * app and the Go server depend on:
 *
 *  - mutating calls (POST/PUT/DELETE) send the `X-Console-Token` header;
 *  - read-only GETs send NO token;
 *  - non-2xx responses become a ConsoleError carrying status + server message;
 *  - the dev token fallback hits `GET /api/console/session` when the page has no
 *    injected token, and caches the result (one fetch for N mutations).
 *
 * The network is mocked at the `fetch` boundary; nothing here touches a live
 * server. Each recorded call is inspected so we assert real request shape, not
 * just that a function resolved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTokenCacheForTests,
  apply,
  ConsoleError,
  createAgent,
  deleteAgent,
  getAgent,
  getStatus,
  listAgents,
  plan,
  updateAgent,
} from "./client";
import type { AgentInput } from "./types";

/** A captured fetch call: the request URL, method, and headers. */
interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/**
 * Installs a fetch mock returning JSON per a small routing table and records
 * every call so tests can assert on headers/method. Routes are matched by URL
 * substring (and optional method).
 */
function installFetch(
  routes: Array<{
    url: string;
    method?: string;
    status?: number;
    json?: unknown;
  }>,
): { calls: Recorded[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        url,
        method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      const route = routes.find(
        (r) =>
          url.includes(r.url) &&
          (r.method ? r.method.toUpperCase() === method : true),
      );
      if (!route) {
        throw new Error(`no mock route for ${method} ${url}`);
      }
      const status = route.status ?? 200;
      const payload = route.json === undefined ? "" : JSON.stringify(route.json);
      return new Response(payload, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const sampleInput: AgentInput = {
  id: "agent-one",
  name: "Agent One",
  model: "anthropic/claude-3.5",
  memory: "512mb",
  cpus: 1,
  region: "cdg",
  tailscale_hostname: "agent-one",
  fly_app: "agent-one",
  runtime: "fly.default",
  network: "tailscale.default",
  model_provider: "openrouter.default",
  lifecycle: "present",
  soul: "",
  companion_soul_enabled: true,
  vault_name: "memory",
};

describe("console API client", () => {
  beforeEach(() => {
    __resetTokenCacheForTests();
    // Production-style injected token on the window for the default cases.
    window.__CONSOLE_TOKEN__ = "prod-token-abc";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__CONSOLE_TOKEN__;
    // Remove any meta tag a test added.
    document
      .querySelectorAll('meta[name="console-token"]')
      .forEach((el) => el.remove());
  });

  it("sends no token header on read-only GETs", async () => {
    const { calls } = installFetch([{ url: "/api/console/agents", json: [] }]);
    await listAgents();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.has("X-Console-Token")).toBe(false);
  });

  it("encodes the id in single-agent GETs", async () => {
    const { calls } = installFetch([
      { url: "/api/console/agents/", json: { id: "a b" } },
    ]);
    await getAgent("a b");
    expect(calls[0].url).toContain("/api/console/agents/a%20b");
    expect(calls[0].headers.has("X-Console-Token")).toBe(false);
  });

  it("sends X-Console-Token and a JSON body on POST create", async () => {
    const { calls } = installFetch([
      { url: "/api/console/agents", method: "POST", status: 201, json: { id: "agent-one" } },
    ]);
    await createAgent(sampleInput);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("X-Console-Token")).toBe("prod-token-abc");
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ id: "agent-one" });
  });

  it("sends X-Console-Token on PUT update", async () => {
    const { calls } = installFetch([
      { url: "/api/console/agents/", method: "PUT", json: { id: "agent-one" } },
    ]);
    await updateAgent("agent-one", sampleInput);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers.get("X-Console-Token")).toBe("prod-token-abc");
  });

  it("sends X-Console-Token on DELETE with no body", async () => {
    const { calls } = installFetch([
      { url: "/api/console/agents/", method: "DELETE", json: { id: "agent-one", lifecycle: "absent" } },
    ]);
    await deleteAgent("agent-one");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].headers.get("X-Console-Token")).toBe("prod-token-abc");
    expect(calls[0].body).toBeUndefined();
  });

  it("echoes the hash in the apply body", async () => {
    const { calls } = installFetch([
      { url: "/api/console/apply", method: "POST", status: 202, json: { operation_id: "op1" } },
    ]);
    const res = await apply("hash-123");
    expect(res.operation_id).toBe("op1");
    expect(JSON.parse(calls[0].body as string)).toEqual({ hash: "hash-123" });
    expect(calls[0].headers.get("X-Console-Token")).toBe("prod-token-abc");
  });

  it("throws ConsoleError with the server message on a 4xx", async () => {
    installFetch([
      {
        url: "/api/console/agents",
        method: "POST",
        status: 409,
        json: { error: "agent already exists: agent-one" },
      },
    ]);
    await expect(createAgent(sampleInput)).rejects.toMatchObject({
      status: 409,
      message: "agent already exists: agent-one",
    });
    await expect(createAgent(sampleInput)).rejects.toBeInstanceOf(ConsoleError);
  });

  it("throws ConsoleError with status on a 5xx read", async () => {
    installFetch([
      { url: "/api/console/agents", status: 500, json: { error: "boom" } },
    ]);
    const err = await listAgents().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleError);
    expect((err as ConsoleError).status).toBe(500);
    expect((err as ConsoleError).message).toBe("boom");
  });

  it("surfaces /api/status errors as ConsoleError", async () => {
    installFetch([{ url: "/api/status", status: 503, json: { error: "no poller" } }]);
    await expect(getStatus()).rejects.toMatchObject({ status: 503 });
  });

  describe("dev token fallback", () => {
    beforeEach(() => {
      // Simulate the dev environment: no injected token anywhere on the page.
      __resetTokenCacheForTests();
      delete window.__CONSOLE_TOKEN__;
    });

    it("treats the unreplaced %%CONSOLE_TOKEN%% sentinel as absent and fetches /session", async () => {
      // The dev HTML keeps the literal sentinel; it must NOT be used as a token.
      window.__CONSOLE_TOKEN__ = "%%CONSOLE_TOKEN%%";
      const { calls } = installFetch([
        { url: "/api/console/session", json: { token: "dev-token-xyz" } },
        { url: "/api/console/plan", method: "POST", json: { hash: "h", text: "", changes: [] } },
      ]);

      await plan();

      const sessionCall = calls.find((c) => c.url.includes("/session"));
      const planCall = calls.find((c) => c.url.includes("/plan"));
      expect(sessionCall).toBeDefined();
      expect(sessionCall?.method).toBe("GET");
      expect(planCall?.headers.get("X-Console-Token")).toBe("dev-token-xyz");
    });

    it("fetches the session token only once across multiple mutations (cached)", async () => {
      const { calls } = installFetch([
        { url: "/api/console/session", json: { token: "dev-token-xyz" } },
        { url: "/api/console/plan", method: "POST", json: { hash: "h", text: "", changes: [] } },
        { url: "/api/console/apply", method: "POST", status: 202, json: { operation_id: "op" } },
      ]);

      await plan();
      await apply("h");

      const sessionCalls = calls.filter((c) => c.url.includes("/session"));
      expect(sessionCalls).toHaveLength(1);
      // Both mutations carried the fetched dev token.
      const tokenedCalls = calls.filter(
        (c) => c.headers.get("X-Console-Token") === "dev-token-xyz",
      );
      expect(tokenedCalls).toHaveLength(2);
    });

    it("reads the token from the <meta> tag when the window global is absent", async () => {
      const meta = document.createElement("meta");
      meta.name = "console-token";
      meta.content = "meta-token-123";
      document.head.appendChild(meta);

      const { calls } = installFetch([
        { url: "/api/console/plan", method: "POST", json: { hash: "h", text: "", changes: [] } },
      ]);
      await plan();

      // No /session fetch needed: the meta tag supplied the token.
      expect(calls.some((c) => c.url.includes("/session"))).toBe(false);
      expect(calls[0].headers.get("X-Console-Token")).toBe("meta-token-123");
    });
  });
});
