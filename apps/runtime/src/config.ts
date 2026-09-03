/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- Predates the incremental anti-slop gate; file reawakened by an unrelated budget/reliability edit, existing debt not rewritten here. */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { COMPANION_BUDGETS, COMPANION_BUDGETS_BASE } from "@companion/contracts";
import { DESKTOP_REQUEST_MAX_SKEW_SECONDS } from "@companion/companion-runtime/runtime-support";
import { companionsEnabled, deploymentReleaseId } from "@companion/core";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const BOX_TTL_SECONDS = COMPANION_BUDGETS_BASE.boxWarmTtlSeconds;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_SWEEP_INTERVAL_MS = COMPANION_BUDGETS_BASE.sweepIntervalMs;
const DEFAULT_LEASE_SECONDS = COMPANION_BUDGETS_BASE.leaseSeconds;
const DEFAULT_RENEW_INTERVAL_MS = COMPANION_BUDGETS.renewIntervalMs;
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 3_007;
const DEFAULT_SHUTDOWN_DRAIN_MS = COMPANION_BUDGETS.shutdownDrainMs;

interface RuntimeServiceConfigBase {
  databaseUrl: string;
  /** Expected login name; the runtime store must verify this against `current_user` at startup. */
  databaseRole: string;
  boxApiBase: string;
  boxTtlSeconds: typeof BOX_TTL_SECONDS;
  executorId: string;
  concurrency: number;
  sweepIntervalMs: number;
  leaseSeconds: typeof DEFAULT_LEASE_SECONDS;
  renewIntervalMs: typeof DEFAULT_RENEW_INTERVAL_MS;
  listenHost: string;
  listenPort: number;
  desktopMaxSkewSeconds: number;
  shutdownDrainMs: number;
  releaseId: string;
  /**
   * Phase 2 direct-transport rollout gate. `off` (default) skips Box agent endpoint registration
   * and keeps the exec-only composition byte-for-byte. `shadow` registers the hosted endpoint at
   * staging and logs one throttled direct-vs-exec comparison per Box without routing any real
   * call. `on` additionally routes the event path — broker state, event reads/acks, and the
   * daemon probe — over the direct channel with per-call fallback to exec.
   */
  directTransport: "off" | "shadow" | "on";
}

export type RuntimeServiceConfig = RuntimeServiceConfigBase & (
  | {
    /** Local deployment gate. True requires both the existing flag and non-empty allowlist. */
    companionsEnabled: true;
    boxApiKey: string;
    masterKey: Buffer;
    desktopHmacSecret: Buffer;
    apiUrl: string;
  }
  | {
    /** False durably disables the shared runtime gate and never enables it. */
    companionsEnabled: false;
    boxApiKey: null;
    masterKey: null;
    desktopHmacSecret: null;
    apiUrl: null;
  }
);

export class RuntimeServiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeServiceConfigError";
  }
}

export function loadRuntimeServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { randomUuid?: () => string } = {},
): RuntimeServiceConfig {
  const database = databaseConfig(required(env, "DATABASE_COMPANION_RUNTIME_URL"));
  const enabled = companionsEnabled(env);
  const boxApiBase = enabled
    ? boxBaseUrl(env.COMPANION_BOX_API_BASE?.trim() || DEFAULT_BOX_API_BASE)
    : DEFAULT_BOX_API_BASE;
  const boxTtlSeconds = integerEnv(
    env.COMPANION_BOX_TTL_SECONDS,
    "COMPANION_BOX_TTL_SECONDS",
    BOX_TTL_SECONDS,
    BOX_TTL_SECONDS,
    BOX_TTL_SECONDS,
  ) as typeof BOX_TTL_SECONDS;
  const executorId = env.COMPANION_RUNTIME_EXECUTOR_ID?.trim()
    || (options.randomUuid ?? randomUUID)();
  if (!isUuid(executorId)) {
    throw new RuntimeServiceConfigError("COMPANION_RUNTIME_EXECUTOR_ID must be a UUID");
  }
  const concurrency = integerEnv(
    env.COMPANION_RUNTIME_CONCURRENCY,
    "COMPANION_RUNTIME_CONCURRENCY",
    DEFAULT_CONCURRENCY,
    1,
    64,
  );
  const sweepIntervalMs = integerEnv(
    env.COMPANION_RUNTIME_SWEEP_INTERVAL_MS,
    "COMPANION_RUNTIME_SWEEP_INTERVAL_MS",
    DEFAULT_SWEEP_INTERVAL_MS,
    250,
    60_000,
  );
  const listenHost = privateListenHost(
    env.COMPANION_RUNTIME_HOST?.trim() || DEFAULT_LISTEN_HOST,
  );
  const listenPort = integerEnv(
    env.COMPANION_RUNTIME_PORT ?? env.PORT,
    "COMPANION_RUNTIME_PORT",
    DEFAULT_LISTEN_PORT,
    1,
    65_535,
  );
  const shutdownDrainMs = integerEnv(
    env.COMPANION_RUNTIME_SHUTDOWN_DRAIN_MS,
    "COMPANION_RUNTIME_SHUTDOWN_DRAIN_MS",
    DEFAULT_SHUTDOWN_DRAIN_MS,
    100,
    44_000,
  );
  if (shutdownDrainMs >= DEFAULT_LEASE_SECONDS * 1_000) {
    throw new RuntimeServiceConfigError(
      "COMPANION_RUNTIME_SHUTDOWN_DRAIN_MS must be shorter than the runtime lease",
    );
  }

  const base: RuntimeServiceConfigBase = {
    databaseUrl: database.url,
    databaseRole: database.role,
    boxApiBase,
    boxTtlSeconds,
    executorId,
    concurrency,
    sweepIntervalMs,
    leaseSeconds: DEFAULT_LEASE_SECONDS,
    renewIntervalMs: DEFAULT_RENEW_INTERVAL_MS,
    listenHost,
    listenPort,
    desktopMaxSkewSeconds: DESKTOP_REQUEST_MAX_SKEW_SECONDS,
    shutdownDrainMs,
    releaseId: deploymentReleaseId(env),
    directTransport: directTransportEnv(env.COMPANION_DIRECT_TRANSPORT),
  };
  if (!enabled) {
    return {
      ...base,
      companionsEnabled: false,
      boxApiKey: null,
      masterKey: null,
      desktopHmacSecret: null,
      apiUrl: null,
    };
  }
  return {
    ...base,
    companionsEnabled: true,
    boxApiKey: required(env, "COMPANION_BOX_API_KEY"),
    masterKey: base64Key(
      env.COMPANION_SECRETS_MASTER_KEY,
      "COMPANION_SECRETS_MASTER_KEY",
    ),
    desktopHmacSecret: base64Key(
      env.COMPANION_RUNTIME_DESKTOP_HMAC_SECRET,
      "COMPANION_RUNTIME_DESKTOP_HMAC_SECRET",
    ),
    apiUrl: serviceUrl(required(env, "COMPANION_API_URL"), "COMPANION_API_URL"),
  };
}

function serviceUrl(raw: string, name: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new RuntimeServiceConfigError(`${name} must be an absolute URL`);
  }
  if (value.username || value.password || value.search || value.hash) {
    throw new RuntimeServiceConfigError(
      `${name} must not contain credentials, query parameters, or a fragment`,
    );
  }
  if (value.protocol !== "https:" && !(value.protocol === "http:" && isPrivateHost(value.hostname))) {
    throw new RuntimeServiceConfigError(`${name} must use HTTPS unless it targets a private service`);
  }
  return value.toString().replace(/\/+$/, "");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new RuntimeServiceConfigError(`${name} is required by apps/runtime`);
  return value;
}

function databaseConfig(raw: string): { url: string; role: string } {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new RuntimeServiceConfigError("DATABASE_COMPANION_RUNTIME_URL must be a PostgreSQL URL");
  }
  if (value.protocol !== "postgres:" && value.protocol !== "postgresql:") {
    throw new RuntimeServiceConfigError("DATABASE_COMPANION_RUNTIME_URL must be a PostgreSQL URL");
  }
  if (!value.hostname || value.pathname === "" || value.pathname === "/") {
    throw new RuntimeServiceConfigError(
      "DATABASE_COMPANION_RUNTIME_URL must name a host and database",
    );
  }
  let role: string;
  try {
    role = decodeURIComponent(value.username);
  } catch {
    throw new RuntimeServiceConfigError(
      "DATABASE_COMPANION_RUNTIME_URL contains an invalid runtime role",
    );
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new RuntimeServiceConfigError(
      "DATABASE_COMPANION_RUNTIME_URL must identify the dedicated runtime role",
    );
  }
  return { url: raw, role };
}

function boxBaseUrl(raw: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new RuntimeServiceConfigError("COMPANION_BOX_API_BASE must be an absolute URL");
  }
  if (value.username || value.password || value.search || value.hash) {
    throw new RuntimeServiceConfigError(
      "COMPANION_BOX_API_BASE must not contain credentials, query parameters, or a fragment",
    );
  }
  if (value.protocol !== "https:" && !(value.protocol === "http:" && isPrivateHost(value.hostname))) {
    throw new RuntimeServiceConfigError(
      "COMPANION_BOX_API_BASE must use HTTPS unless it targets a private simulator",
    );
  }
  return value.toString().replace(/\/+$/, "");
}

function base64Key(raw: string | undefined, name: string): Buffer {
  if (!raw?.trim()) {
    throw new RuntimeServiceConfigError(`${name} must be a base64-encoded 32-byte key`);
  }
  const normalized = raw.trim();
  const decoded = Buffer.from(normalized, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (decoded.byteLength !== 32 || canonical !== normalized.replace(/=+$/, "")) {
    throw new RuntimeServiceConfigError(`${name} must be a base64-encoded 32-byte key`);
  }
  return decoded;
}

function integerEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new RuntimeServiceConfigError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RuntimeServiceConfigError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function directTransportEnv(raw: string | undefined): "off" | "shadow" | "on" {
  if (raw === undefined || raw.trim() === "") return "off";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "shadow" || normalized === "on") return normalized;
  throw new RuntimeServiceConfigError("COMPANION_DIRECT_TRANSPORT must be off, shadow, or on");
}

function privateListenHost(host: string): string {
  const normalized = host.toLowerCase();
  // Wildcards are required when API and runtime are separate private-network containers. They are
  // never selected by default; the deployment must still omit any public route to this service.
  if (normalized === "0.0.0.0" || normalized === "::") return host;
  if (!isPrivateHost(normalized)) {
    throw new RuntimeServiceConfigError(
      "COMPANION_RUNTIME_HOST must bind a loopback, private-network, or explicit wildcard address",
    );
  }
  return host;
}

function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized.endsWith(".internal") || normalized.endsWith(".local")) return true;
  const version = isIP(normalized);
  if (version === 4) {
    const [first = 0, second = 0] = normalized.split(".").map(Number);
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (version === 6) {
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return false;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
