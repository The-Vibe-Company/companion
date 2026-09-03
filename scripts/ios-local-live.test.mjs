import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapLocalProvider, archiveLocalCompanion } from "./ios-local-live.mjs";

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function configuration(overrides = {}) {
  return {
    apiURL: new URL("http://127.0.0.1:3001"),
    email: "admin@thevibecompany.co",
    password: "adminadmin",
    zaiApiKey: "zai-local-secret",
    pollIntervalMs: 0,
    archiveTimeoutMs: 10_000,
    ...overrides,
  };
}

function authenticatedResponse(record) {
  if (record.url === "/v1/auth/login") {
    return json({}, { headers: { "set-cookie": "local.session_token=opaque; Path=/; HttpOnly" } });
  }
  if (record.url === "/v1/auth/whoami") {
    return json({ org: { org_id: "org-local" }, needsOnboarding: false });
  }
  return null;
}

test("bootstrap connects z.ai without creating a Companion or exposing a mobile contract", async () => {
  const requests = [];
  const fetchImpl = async (request, options) => {
    const record = {
      url: request.pathname,
      method: options.method ?? "GET",
      headers: new Headers(options.headers),
      body: options.body ? JSON.parse(options.body) : null,
    };
    requests.push(record);
    const auth = authenticatedResponse(record);
    if (auth) return auth;
    if (record.url === "/v1/companion-providers/zai") {
      return json({ connection: { provider_id: "zai" } });
    }
    if (record.url === "/v1/companion-providers") {
      return json({
        catalog: [{ id: "zai", models: [{ id: "glm-local", default: true }] }],
        connections: [{ provider_id: "zai" }],
        default_provider_id: "another-provider",
      });
    }
    if (record.url === "/v1/companion-providers/default") return json({ ok: true });
    return json({ error: "unexpected_request" }, { status: 500 });
  };

  const result = await bootstrapLocalProvider(configuration(), fetchImpl);

  assert.deepEqual(result, { providerId: "zai", modelId: "glm-local" });
  const providerRequest = requests.find((request) => request.url === "/v1/companion-providers/zai");
  assert.equal(providerRequest.headers.get("cookie"), "local.session_token=opaque");
  assert.equal(providerRequest.headers.get("x-companion-org"), "org-local");
  assert.equal(providerRequest.headers.get("origin"), "http://127.0.0.1:3001");
  assert.deepEqual(providerRequest.body, {
    auth_method: "api_key",
    credential: "zai-local-secret",
  });
  const defaultRequest = requests.find(
    (request) => request.url === "/v1/companion-providers/default",
  );
  assert.deepEqual(defaultRequest.body, { provider_id: "zai" });
  assert.equal(requests.some((request) => request.url === "/v1/companions"), false);
  assert.equal(requests.some((request) => request.headers.has("client_surface")), false);
});

test("bootstrap rejects missing credentials and non-loopback APIs before any request", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return json({});
  };

  await assert.rejects(
    bootstrapLocalProvider(configuration({ zaiApiKey: "" }), fetchImpl),
    /missing COMPANION_IOS_LOCAL_ZAI_API_KEY/,
  );
  await assert.rejects(
    bootstrapLocalProvider(configuration({ apiURL: new URL("https://api.example.test") }), fetchImpl),
    /must target loopback/,
  );
  assert.equal(requests, 0);
});

test("bootstrap never includes the z.ai credential in a surfaced API error", async () => {
  const fetchImpl = async (request, options) => {
    const record = { url: request.pathname, method: options.method ?? "GET" };
    const auth = authenticatedResponse(record);
    if (auth) return auth;
    return json({ code: "provider_rejected", detail: "zai-local-secret" }, { status: 400 });
  };

  await assert.rejects(
    bootstrapLocalProvider(configuration(), fetchImpl),
    (error) => error.message === "/v1/companion-providers/zai failed: provider_rejected"
      && !error.message.includes("zai-local-secret"),
  );
});

test("archive targets one exact Companion, uses the v3 lifecycle route, and waits for stopped", async () => {
  const requests = [];
  let runtimeReads = 0;
  const fetchImpl = async (request, options) => {
    const record = {
      url: request.pathname,
      method: options.method ?? "GET",
      headers: new Headers(options.headers),
    };
    requests.push(record);
    const auth = authenticatedResponse(record);
    if (auth) return auth;
    if (record.url === "/v1/companions") {
      return json({
        companions: [
          { id: "companion-1", name: "Mobile Live" },
          { id: "companion-2", name: "Another Companion" },
        ],
      });
    }
    if (record.url === "/v1/companions/companion-1/runtime/archive") {
      return json({ lifecycle: { intent: "archive", revision: "2" } }, { status: 202 });
    }
    if (record.url === "/v1/companions/companion-1/runtime") {
      runtimeReads += 1;
      return json({
        companion: {
          runtime: runtimeReads === 1
            ? { state: "stopping", lifecycle_intent: "archive" }
            : { state: "stopped", lifecycle_intent: "archive" },
        },
      });
    }
    return json({ error: "unexpected_request" }, { status: 500 });
  };

  const result = await archiveLocalCompanion(
    configuration(),
    "Mobile Live",
    fetchImpl,
    async () => {},
  );

  assert.deepEqual(result, {
    companionId: "companion-1",
    companionName: "Mobile Live",
    lifecycleRevision: "2",
    state: "stopped",
  });
  const archiveRequest = requests.find((request) => request.url.endsWith("/runtime/archive"));
  assert.equal(archiveRequest.method, "POST");
  assert.match(archiveRequest.headers.get("idempotency-key"), /^[0-9a-f-]{36}$/);
  assert.equal(archiveRequest.headers.has("client_surface"), false);
  assert.equal(runtimeReads, 2);
});

test("archive refuses ambiguous names before recording lifecycle intent", async () => {
  const requests = [];
  const fetchImpl = async (request, options) => {
    const record = { url: request.pathname, method: options.method ?? "GET" };
    requests.push(record);
    const auth = authenticatedResponse(record);
    if (auth) return auth;
    if (record.url === "/v1/companions") {
      return json({ companions: [
        { id: "companion-1", name: "Duplicate" },
        { id: "companion-2", name: "Duplicate" },
      ] });
    }
    return json({ error: "unexpected_request" }, { status: 500 });
  };

  await assert.rejects(
    archiveLocalCompanion(configuration(), "Duplicate", fetchImpl),
    /multiple Companions match/,
  );
  assert.equal(requests.some((request) => request.url.endsWith("/runtime/archive")), false);
});

test("archive is idempotent when the exact Companion is already stopped", async () => {
  const requests = [];
  const fetchImpl = async (request, options) => {
    const record = { url: request.pathname, method: options.method ?? "GET" };
    requests.push(record);
    const auth = authenticatedResponse(record);
    if (auth) return auth;
    if (record.url === "/v1/companions") {
      return json({ companions: [{
        id: "companion-stopped",
        name: "Already Stopped",
        runtime: {
          state: "stopped",
          lifecycle_intent: "archive",
        },
      }] });
    }
    return json({ error: "unexpected_request" }, { status: 500 });
  };

  const result = await archiveLocalCompanion(configuration(), "Already Stopped", fetchImpl);

  assert.deepEqual(result, {
    companionId: "companion-stopped",
    companionName: "Already Stopped",
    lifecycleRevision: null,
    state: "stopped",
  });
  assert.equal(requests.some((request) => request.url.endsWith("/runtime/archive")), false);
});

test("archive fails visibly when the durable lifecycle enters error", async () => {
  const fetchImpl = async (request, options) => {
    const record = { url: request.pathname, method: options.method ?? "GET" };
    const auth = authenticatedResponse(record);
    if (auth) return auth;
    if (record.url === "/v1/companions") {
      return json({ companions: [{ id: "companion-1", name: "Mobile Live" }] });
    }
    if (record.url.endsWith("/runtime/archive")) {
      return json({ lifecycle: { intent: "archive", revision: "2" } }, { status: 202 });
    }
    if (record.url.endsWith("/runtime")) {
      return json({
        companion: {
          runtime: {
            state: "error",
            lifecycle_intent: "archive",
          },
        },
      });
    }
    return json({ error: "unexpected_request" }, { status: 500 });
  };

  await assert.rejects(
    archiveLocalCompanion(configuration(), "companion-1", fetchImpl),
    /archive lifecycle entered an error state/,
  );
});
