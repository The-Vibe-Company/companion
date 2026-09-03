#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const PROVIDER_ID = "zai";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function sessionCookie(response) {
  for (const value of response.headers.getSetCookie()) {
    for (const part of value.split(/,(?=\s*[^;,=]+=[^;,]*)/)) {
      const pair = part.trim().split(";", 1)[0];
      if (pair?.split("=", 1)[0]?.endsWith(".session_token")) return pair;
    }
  }
  throw new Error("login did not return a session cookie");
}

function assertLoopbackAPI(configuration) {
  const { apiURL } = configuration;
  if (!["http:", "https:"].includes(apiURL.protocol)
      || !LOOPBACK_HOSTS.has(apiURL.hostname)
      || apiURL.username
      || apiURL.password) {
    throw new Error("local iOS API URL must target loopback without embedded credentials");
  }
}

function localClient(configuration, fetchImpl) {
  let cookie;
  let orgId;

  async function request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    if (orgId) headers.set("x-companion-org", orgId);
    if (options.method && !["GET", "HEAD"].includes(options.method)) {
      headers.set("origin", configuration.apiURL.origin);
    }

    const response = await fetchImpl(new URL(path, configuration.apiURL), { ...options, headers });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body?.code ?? body?.error ?? `http_${response.status}`;
      throw new Error(`${path} failed: ${code}`);
    }
    return { body, response };
  }

  return {
    async authenticate() {
      const login = await request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: configuration.email,
          password: configuration.password,
          name: "iOS local live",
        }),
      });
      cookie = sessionCookie(login.response);
      const identity = await request("/v1/auth/whoami");
      orgId = identity.body?.org?.org_id;
      if (!orgId || identity.body?.needsOnboarding) {
        throw new Error("local test user is not onboarded into a workspace");
      }
    },
    request,
  };
}

export async function bootstrapLocalProvider(configuration, fetchImpl = fetch) {
  assertLoopbackAPI(configuration);
  if (!configuration.zaiApiKey?.trim()) {
    throw new Error("missing COMPANION_IOS_LOCAL_ZAI_API_KEY");
  }

  const api = localClient(configuration, fetchImpl);
  await api.authenticate();
  const connected = await api.request(`/v1/companion-providers/${PROVIDER_ID}`, {
    method: "PUT",
    body: JSON.stringify({
      auth_method: "api_key",
      credential: configuration.zaiApiKey,
    }),
  });
  if (connected.body?.connection?.provider_id !== PROVIDER_ID) {
    throw new Error("z.ai connection response was invalid");
  }

  const providers = (await api.request("/v1/companion-providers")).body;
  const provider = providers?.catalog?.find((candidate) => candidate.id === PROVIDER_ID);
  const model = provider?.models?.find((candidate) => candidate.default) ?? provider?.models?.[0];
  if (!model?.id) throw new Error("z.ai catalog returned no model");
  if (!providers?.connections?.some((connection) => connection.provider_id === PROVIDER_ID)) {
    throw new Error("z.ai connection was not persisted");
  }
  if (providers.default_provider_id !== PROVIDER_ID) {
    await api.request("/v1/companion-providers/default", {
      method: "PUT",
      body: JSON.stringify({ provider_id: PROVIDER_ID }),
    });
  }

  return { providerId: PROVIDER_ID, modelId: model.id };
}

function selectCompanion(companions, selector) {
  const byId = companions.filter((companion) => companion.id === selector);
  const matches = byId.length ? byId : companions.filter((companion) => companion.name === selector);
  if (matches.length === 0) throw new Error(`no Companion matches "${selector}"`);
  if (matches.length > 1) throw new Error(`multiple Companions match "${selector}"; use the id`);
  return matches[0];
}

export async function archiveLocalCompanion(
  configuration,
  selector,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  assertLoopbackAPI(configuration);
  const normalizedSelector = selector?.trim();
  if (!normalizedSelector) throw new Error("--companion requires an exact name or id");

  const api = localClient(configuration, fetchImpl);
  await api.authenticate();
  const roster = (await api.request("/v1/companions")).body?.companions ?? [];
  const companion = selectCompanion(roster, normalizedSelector);
  if (companion.runtime?.state === "stopped") {
    return {
      companionId: companion.id,
      companionName: companion.name,
      lifecycleRevision: null,
      state: "stopped",
    };
  }
  const accepted = (await api.request(
    `/v1/companions/${encodeURIComponent(companion.id)}/runtime/archive`,
    {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    },
  )).body?.lifecycle;
  if (accepted?.intent !== "archive" || !accepted.revision) {
    throw new Error("archive response returned no lifecycle receipt");
  }

  const deadline = Date.now() + configuration.archiveTimeoutMs;
  while (Date.now() < deadline) {
    const projection = (await api.request(
      `/v1/companions/${encodeURIComponent(companion.id)}/runtime`,
    )).body?.companion;
    if (projection?.runtime?.state === "stopped") {
      return {
        companionId: companion.id,
        companionName: companion.name,
        lifecycleRevision: accepted.revision,
        state: "stopped",
      };
    }
    if (projection?.runtime?.state === "error"
        && projection.runtime.lifecycle_intent === "archive") {
      throw new Error("archive lifecycle entered an error state");
    }
    await sleep(configuration.pollIntervalMs);
  }
  throw new Error(`timed out waiting for "${companion.name}" to archive`);
}

function configuration() {
  const basePort = Number.parseInt(process.env.CONDUCTOR_PORT ?? "3000", 10);
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65526) {
    throw new Error("CONDUCTOR_PORT must be an integer between 1024 and 65526");
  }
  return {
    apiURL: new URL(`http://127.0.0.1:${basePort + 1}`),
    email: process.env.COMPANION_SEED_EMAIL?.trim() || "admin@thevibecompany.co",
    password: process.env.COMPANION_SEED_PASSWORD ?? "adminadmin",
    zaiApiKey: process.env.COMPANION_IOS_LOCAL_ZAI_API_KEY ?? "",
    pollIntervalMs: 2_000,
    archiveTimeoutMs: 15 * 60_000,
  };
}

function companionSelector(argv) {
  const index = argv.indexOf("--companion");
  if (index >= 0) return argv[index + 1];
  return argv.find((argument) => argument.startsWith("--companion="))?.slice("--companion=".length);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const command = process.argv[2];
    const config = configuration();
    if (command === "bootstrap") {
      const result = await bootstrapLocalProvider(config);
      console.log(`[ios-live] z.ai connected; default model ${result.modelId}`);
    } else if (command === "archive") {
      const result = await archiveLocalCompanion(config, companionSelector(process.argv.slice(3)));
      console.log(`[ios-live] ${result.companionName} is archived and ready for a send-to-wake test`);
    } else {
      throw new Error("usage: ios-local-live.mjs bootstrap | archive --companion <exact-name-or-id>");
    }
  } catch (error) {
    console.error(`[ios-live] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
