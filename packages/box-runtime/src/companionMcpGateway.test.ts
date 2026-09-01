import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { startCompanionMcpGateway, type CompanionMcpGateway } from "./companionMcpGateway";

const accountId = "11111111-1111-4111-8111-111111111111";
const credentialGeneration = "22222222-2222-4222-8222-222222222222";
const conductorAccountId = "33333333-3333-4333-8333-333333333333";
const conductorCredentialGeneration = "44444444-4444-4444-8444-444444444444";
const brokerToken = `cmp_mcp_${"a".repeat(48)}`;
const controlToken = `cmp_ctl_${"b".repeat(48)}`;
const apiUrl = "https://control.example.test/v1";
const upstreamUrl = "https://mcp.example.test/rpc";
const brokerRequestSchema = z.object({
  account_id: z.string().uuid(),
  credential_generation: z.string().uuid(),
  force_refresh: z.boolean(),
}).strict();
const mcpMethodSchema = z.object({ method: z.string().optional() }).passthrough();
const controlToolListSchema = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
});
const toolsListResponseSchema = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough(),
}).passthrough();
const jsonRpcErrorSchema = z.object({
  error: z.object({ code: z.number() }).passthrough(),
}).passthrough();

const temporaryDirectories: string[] = [];
const gateways: CompanionMcpGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(async (gateway) => await gateway.close()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe("Companion MCP loopback gateway", () => {
  it("serves the static control catalog and forwards tool calls with only the control capability", async () => {
    const upstream: Array<{ url: string; authorization: string | null }> = [];
    const gateway = await startGatewayWithAccounts(async (rawUrl, init) => {
      upstream.push({
        url: String(rawUrl),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } });
    }, []);

    const listed = controlToolListSchema.parse(await fetch(`${gateway.origin}/control`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then(async (response) => await response.json()));
    expect(listed.result.tools.map((tool) => tool.name)).toContain("companion_get_self");
    expect(listed.result.tools.map((tool) => tool.name)).toContain("companion_send_message");
    expect(upstream).toHaveLength(0);

    await fetch(`${gateway.origin}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "companion_get_self", arguments: {} },
      }),
    });
    expect(upstream).toEqual([{
      url: `${apiUrl}/runtime/companion-control`,
      authorization: `Bearer ${controlToken}`,
    }]);
  });

  it("keeps attached plugin accounts available when the current attempt has no control token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-mcp-gateway-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "mcp-gateway.json");
    writeFileSync(configPath, JSON.stringify({
      accounts: [{ accountId, credentialGeneration, upstreamUrl, github: false }],
    }));
    const gateway = await startCompanionMcpGateway({
      configPath,
      apiUrl,
      brokerToken,
      fetchImpl: async (rawUrl) => String(rawUrl).startsWith(apiUrl)
        ? tokenResponse("plugin-access", null)
        : new Response("plugin-ok", { status: 200 }),
    });
    if (!gateway) throw new Error("gateway did not start");
    gateways.push(gateway);

    await expect(fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" })
      .then(async (response) => await response.text())).resolves.toBe("plugin-ok");
    expect((await fetch(`${gateway.origin}/control`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it.each([
    { label: "without expiry", ttlMs: null },
    { label: "for one second", ttlMs: 1_000 },
    { label: "for thirty seconds", ttlMs: 30_000 },
    { label: "for fifteen minutes", ttlMs: 15 * 60_000 },
    { label: "for more than two hours", ttlMs: 126 * 60_000 },
  ])("accepts tokens $label and renews only when their proportional margin is reached", async ({ ttlMs }) => {
    let now = Date.parse("2027-01-01T00:00:00.000Z");
    let tokenRequests = 0;
    let providerRefreshes = 0;
    let providerExpiry: number | null = null;
    const upstreamTokens: string[] = [];
    const gateway = await startGateway(async (rawUrl, init) => {
      const url = String(rawUrl);
      if (url.startsWith(apiUrl)) {
        tokenRequests += 1;
        const force = Boolean(JSON.parse(String(init?.body)).force_refresh);
        if (providerRefreshes === 0 || force) {
          providerRefreshes += 1;
          providerExpiry = ttlMs === null ? null : now + ttlMs;
        }
        return tokenResponse(`access-${providerRefreshes}`, providerExpiry);
      }
      upstreamTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("ok", { status: 200 });
    }, () => now);

    await expect(fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" })
      .then(async (response) => await response.text())).resolves.toBe("ok");
    await expect(fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" })
      .then(async (response) => await response.text())).resolves.toBe("ok");
    expect(tokenRequests).toBe(2);
    expect(providerRefreshes).toBe(1);
    expect(upstreamTokens).toEqual(["Bearer access-1", "Bearer access-1"]);

    if (ttlMs !== null) {
      now += ttlMs;
      await fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" });
      expect(tokenRequests).toBe(3);
      expect(providerRefreshes).toBe(2);
      expect(upstreamTokens.at(-1)).toBe("Bearer access-2");
    }
  });

  it("coalesces concurrent renewals and spans repeated expirations across a two-hour turn", async () => {
    let now = Date.parse("2027-01-01T00:00:00.000Z");
    let tokenRequests = 0;
    let providerRefreshes = 0;
    let providerExpiry = 0;
    const forceRefreshes: boolean[] = [];
    const fetchImpl: typeof fetch = async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.startsWith(apiUrl)) {
        tokenRequests += 1;
        const force = Boolean(JSON.parse(String(init?.body)).force_refresh);
        forceRefreshes.push(force);
        if (providerRefreshes === 0 || force) {
          providerRefreshes += 1;
          providerExpiry = now + 15 * 60_000;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return tokenResponse(`turn-token-${providerRefreshes}`, providerExpiry);
      }
      return new Response("ok", { status: 200 });
    };
    const gateway = await startGateway(fetchImpl, () => now);

    for (let elapsed = 0; elapsed <= 2 * 60 * 60_000; elapsed += 14 * 60_000) {
      now = Date.parse("2027-01-01T00:00:00.000Z") + elapsed;
      const responses = await Promise.all(Array.from({ length: 4 }, async () => {
        const response = await fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" });
        await response.arrayBuffer();
        return response;
      }));
      expect(responses.every((response) => response.ok)).toBe(true);
    }

    expect(tokenRequests).toBeGreaterThanOrEqual(9);
    expect(tokenRequests).toBeLessThanOrEqual(36);
    expect(providerRefreshes).toBe(5);
    expect(forceRefreshes[0]).toBe(false);
    expect(forceRefreshes.filter(Boolean)).toHaveLength(4);
  });

  it("forces one refresh after an explicit 401 and never retries a second 401", async () => {
    let tokenRequests = 0;
    let upstreamRequests = 0;
    const forceRefreshes: boolean[] = [];
    const gateway = await startGateway(async (rawUrl, init) => {
      if (String(rawUrl).startsWith(apiUrl)) {
        tokenRequests += 1;
        forceRefreshes.push(Boolean(JSON.parse(String(init?.body)).force_refresh));
        return tokenResponse(`access-${tokenRequests}`, Date.now() + 60_000);
      }
      upstreamRequests += 1;
      return new Response("unauthorized", { status: 401 });
    });

    const response = await fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(tokenRequests).toBe(2);
    expect(upstreamRequests).toBe(2);
    expect(forceRefreshes).toEqual([false, true]);
  });

  it("does not replay an ambiguous upstream failure", async () => {
    let tokenRequests = 0;
    let upstreamRequests = 0;
    const gateway = await startGateway(async (rawUrl) => {
      if (String(rawUrl).startsWith(apiUrl)) {
        tokenRequests += 1;
        return tokenResponse("access", Date.now() + 60_000);
      }
      upstreamRequests += 1;
      throw new TypeError("connection lost after write");
    });

    const response = await fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    expect(tokenRequests).toBe(1);
    expect(upstreamRequests).toBe(1);
  });

  it("revalidates broker authorization before every remote request", async () => {
    let tokenRequests = 0;
    let upstreamRequests = 0;
    const gateway = await startGateway(async (rawUrl) => {
      if (String(rawUrl).startsWith(apiUrl)) {
        tokenRequests += 1;
        return tokenRequests === 1
          ? tokenResponse("access", null)
          : new Response("revoked", { status: 401 });
      }
      upstreamRequests += 1;
      return new Response("ok", { status: 200 });
    });

    await expect(fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" })
      .then(async (response) => await response.text())).resolves.toBe("ok");
    const revoked = await fetch(`${gateway.origin}/mcp/${accountId}`, { method: "POST", body: "{}" });
    expect(revoked.status).toBe(502);
    expect(tokenRequests).toBe(2);
    expect(upstreamRequests).toBe(1);
  });

  it("forwards MCP headers, rewrites same-origin SSE endpoints, and forbids redirects", async () => {
    const upstreamCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const gateway = await startGateway(async (rawUrl, init) => {
      const url = String(rawUrl);
      if (url.startsWith(apiUrl)) return tokenResponse("access", null);
      upstreamCalls.push({ url, init });
      if (url.endsWith("/events/next")) return new Response("next", { status: 200 });
      return new Response("event: endpoint\ndata: /events/next\n\n", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "mcp-session-id": "session-1",
        },
      });
    });

    const response = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      headers: {
        authorization: "Bearer attacker-controlled",
        "last-event-id": "event-7",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": "session-1",
      },
    });
    const eventStream = await response.text();
    const endpoint = /^data: (http[^\n]+)$/m.exec(eventStream)?.[1];
    expect(endpoint).toBeDefined();
    await expect(fetch(endpoint ?? "").then(async (next) => await next.text())).resolves.toBe("next");

    const first = upstreamCalls[0];
    const headers = new Headers(first?.init?.headers);
    expect(first?.url).toBe(upstreamUrl);
    expect(first?.init?.redirect).toBe("error");
    expect(headers.get("authorization")).toBe("Bearer access");
    expect(headers.get("last-event-id")).toBe("event-7");
    expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(headers.get("mcp-session-id")).toBe("session-1");
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    expect(upstreamCalls[1]?.url).toBe("https://mcp.example.test/events/next");
  });

  it("terminates a cross-origin SSE endpoint without taking down the gateway", async () => {
    let upstreamRequests = 0;
    const gateway = await startGateway(async (rawUrl) => {
      if (String(rawUrl).startsWith(apiUrl)) return tokenResponse("access", null);
      upstreamRequests += 1;
      if (upstreamRequests === 1) {
        return new Response("event: endpoint\ndata: https://attacker.example/rpc\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("still-running", { status: 200 });
    });

    await expect(fetch(`${gateway.origin}/mcp/${accountId}`)
      .then(async (response) => await response.text())).rejects.toThrow();
    await expect(fetch(`${gateway.origin}/mcp/${accountId}`)
      .then(async (response) => await response.text())).resolves.toBe("still-running");
    expect(upstreamRequests).toBe(2);
  });

  it("serves GitHub credentials from memory and renews them after expiry", async () => {
    let now = Date.parse("2027-01-01T00:00:00.000Z");
    let tokenRequests = 0;
    const gateway = await startGateway(async (rawUrl) => {
      if (!String(rawUrl).startsWith(apiUrl)) throw new Error("unexpected upstream call");
      tokenRequests += 1;
      return tokenResponse(`github-${tokenRequests}`, now + 1_000);
    }, () => now, true);

    await expect(fetch(`${gateway.origin}/git/${accountId}`).then(async (response) => await response.text()))
      .resolves.toBe("github-1");
    now += 1_000;
    await expect(fetch(`${gateway.origin}/git/${accountId}`).then(async (response) => await response.text()))
      .resolves.toBe("github-2");
    expect(tokenRequests).toBe(2);
  });

  it("vends GitHub and Conductor access through the same account-bound broker", async () => {
    const tokenRequests: Array<{ account_id: string; credential_generation: string }> = [];
    const upstreamAuthorizations: string[] = [];
    const gateway = await startGatewayWithAccounts(async (rawUrl, init) => {
      if (String(rawUrl).startsWith(apiUrl)) {
        const body = brokerRequestSchema.parse(JSON.parse(String(init?.body)));
        tokenRequests.push(body);
        return tokenResponse(`access-${body.account_id}`, null);
      }
      upstreamAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("conductor-ok", { status: 200 });
    }, [
      { accountId, credentialGeneration, upstreamUrl: "https://api.github.test/mcp", github: true },
      {
        accountId: conductorAccountId,
        credentialGeneration: conductorCredentialGeneration,
        upstreamUrl: "https://mcp.conductor.test/rpc",
        github: false,
      },
    ]);

    await expect(fetch(`${gateway.origin}/git/${accountId}`).then(async (response) => await response.text()))
      .resolves.toBe(`access-${accountId}`);
    await expect(fetch(`${gateway.origin}/mcp/${conductorAccountId}`, {
      method: "POST",
      body: "{}",
    }).then(async (response) => await response.text())).resolves.toBe("conductor-ok");
    expect(tokenRequests).toEqual([
      { account_id: accountId, credential_generation: credentialGeneration, force_refresh: false },
      {
        account_id: conductorAccountId,
        credential_generation: conductorCredentialGeneration,
        force_refresh: false,
      },
    ]);
    expect(upstreamAuthorizations).toEqual([`Bearer access-${conductorAccountId}`]);
  });

  it("serves a narrow Slack MCP tool and keeps the bot token in the loopback gateway", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const gateway = await startGatewayWithAccounts(async (rawUrl, init) => {
      if (String(rawUrl).startsWith(apiUrl)) return tokenResponse("xoxb-secret", null);
      calls.push({
        url: String(rawUrl),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ ok: true, channel: "C123ABC", ts: "1720000000.123456" });
    }, [{
      accountId,
      credentialGeneration,
      upstreamUrl: "https://slack.com/api/chat.postMessage",
      github: false,
      slack: true,
    }]);

    // SAFETY: this fixture controls the gateway response and asserts its tools/list contract below.
    const listed = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then(async (response) => await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["slack_chat_post_message"]);

    // SAFETY: this fixture controls the gateway response and asserts its tools/call contract below.
    const sent = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "slack_chat_post_message",
          arguments: {
            channel: "C123ABC",
            text: "Build completed",
            thread_ts: "1719999999.000001",
          },
        },
      }),
    }).then(async (response) => await response.json()) as {
      result: { structuredContent: { sent: boolean; channel: string; ts: string } };
    };
    expect(sent.result.structuredContent).toEqual({
      sent: true,
      channel: "C123ABC",
      ts: "1720000000.123456",
    });
    expect(calls).toEqual([{
      url: "https://slack.com/api/chat.postMessage",
      authorization: "Bearer xoxb-secret",
      body: {
        channel: "C123ABC",
        text: "Build completed",
        thread_ts: "1719999999.000001",
        unfurl_links: false,
        unfurl_media: false,
      },
    }]);
    expect(JSON.stringify(sent)).not.toContain("xoxb-secret");
  });

  it("expurgates Slack provider failures from MCP results", async () => {
    const gateway = await startGatewayWithAccounts(async (rawUrl) => {
      if (String(rawUrl).startsWith(apiUrl)) return tokenResponse("xoxb-secret", null);
      return Response.json({ ok: false, error: "provider-secret-detail" });
    }, [{
      accountId,
      credentialGeneration,
      upstreamUrl: "https://slack.com/api/chat.postMessage",
      github: false,
      slack: true,
    }]);

    // SAFETY: this fixture controls the gateway error response and reads only the asserted flag.
    const failed = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "slack_chat_post_message",
          arguments: { channel: "D123ABC", text: "Hello" },
        },
      }),
    }).then(async (response) => await response.json()) as { result: { isError: boolean } };
    expect(failed.result.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("provider-secret-detail");
    expect(JSON.stringify(failed)).not.toContain("xoxb-secret");
  });

  it("filters a curated tool catalog and refuses calls outside it before upstream access", async () => {
    let upstreamRequests = 0;
    const gateway = await startGatewayWithAccounts(async (rawUrl, init) => {
      if (String(rawUrl).startsWith(apiUrl)) return tokenResponse("gmail-access", null);
      upstreamRequests += 1;
      const request = mcpMethodSchema.parse(JSON.parse(String(init?.body)));
      if (request.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "search_threads" },
              { name: "create_draft" },
              { name: "label_message" },
              { name: "send_message" },
            ],
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    }, [{
      accountId,
      credentialGeneration,
      upstreamUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      github: false,
      allowedTools: ["search_threads", "create_draft"],
    }]);

    const listed = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then(async (response) => toolsListResponseSchema.parse(await response.json()));
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "search_threads",
      "create_draft",
    ]);

    const denied = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send_message", arguments: {} },
      }),
    }).then(async (response) => jsonRpcErrorSchema.parse(await response.json()));
    expect(denied.error.code).toBe(-32601);
    expect(upstreamRequests).toBe(1);

    await expect(fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "create_draft", arguments: {} },
      }),
    }).then(async (response) => await response.json())).resolves.toMatchObject({ result: { ok: true } });
    expect(upstreamRequests).toBe(2);
  });

  it("preserves a valid tools/list JSON-RPC error", async () => {
    const gateway = await startGatewayWithAccounts(async (rawUrl) => {
      if (String(rawUrl).startsWith(apiUrl)) return tokenResponse("gmail-access", null);
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "authorization expired" },
      });
    }, [{
      accountId,
      credentialGeneration,
      upstreamUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      github: false,
      allowedTools: ["search_threads", "create_draft"],
    }]);

    const error = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then(async (response) => jsonRpcErrorSchema.parse(await response.json()));

    expect(error.error).toEqual({ code: -32001, message: "authorization expired" });
  });

  it("preserves non-result SSE events while filtering a later tools/list result", async () => {
    const gateway = await startGatewayWithAccounts(async (rawUrl) => {
      if (String(rawUrl).startsWith(apiUrl)) return tokenResponse("gmail-access", null);
      return new Response([
        "event: message",
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
        "",
        "event: message",
        'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search_threads"},{"name":"send_message"}]}}',
        "",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }, [{
      accountId,
      credentialGeneration,
      upstreamUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      github: false,
      allowedTools: ["search_threads", "create_draft"],
    }]);

    const body = await fetch(`${gateway.origin}/mcp/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then(async (response) => await response.text());

    expect(body).toContain('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
    expect(body).toContain('"tools":[{"name":"search_threads"}]');
    expect(body).not.toContain("send_message");
  });
});

async function startGateway(
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
  github = false,
): Promise<CompanionMcpGateway> {
  return await startGatewayWithAccounts(fetchImpl, [
    { accountId, credentialGeneration, upstreamUrl, github },
  ], now);
}

async function startGatewayWithAccounts(
  fetchImpl: typeof fetch,
  accounts: Array<{
    accountId: string;
    credentialGeneration: string;
    upstreamUrl: string;
    github: boolean;
    slack?: true;
    allowedTools?: string[];
  }>,
  now: () => number = Date.now,
): Promise<CompanionMcpGateway> {
  const directory = mkdtempSync(join(tmpdir(), "companion-mcp-gateway-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "mcp-gateway.json");
  writeFileSync(configPath, JSON.stringify({ accounts }));
  const gateway = await startCompanionMcpGateway({
    configPath,
    apiUrl,
    brokerToken,
    controlToken,
    fetchImpl,
    now,
  });
  if (!gateway) throw new Error("gateway did not start");
  gateways.push(gateway);
  return gateway;
}

function tokenResponse(accessToken: string, expiresAt: number | null): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    credential_version: 1,
  }, {
    headers: { "cache-control": "no-store" },
  });
}
