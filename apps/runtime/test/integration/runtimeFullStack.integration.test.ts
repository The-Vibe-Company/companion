/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-shape-in-symbol-names, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Existing simulator fixture decoding predates the incremental anti-slop gate; Companion icon shapes are geometric catalog fields. */

/**
 * Product promise:
 * An accepted Companion message is durable independently of the API process, and the dedicated
 * Runtime process is the only owner of Box/Pi work. Ordered turns, decisions, wake-on-send, lease
 * takeover, and permanent deletion must therefore survive real process boundaries.
 *
 * Why integrated:
 * This suite starts the production API and Runtime entrypoints, a deterministic HTTP Box provider
 * whose Pi is a real JSONL child process, and a freshly migrated PostgreSQL database with distinct
 * API/worker/runtime login roles. Unit ports cannot prove that process death, grants, HTTP contracts,
 * the Box adapter, and the broker all compose without an in-memory handoff.
 *
 * Boundary:
 * The real worker process is kept alive under its distinct database role and receives no Box/Pi
 * environment. Browser rendering remains covered by browser:smoke; this suite owns the HTTP
 * control-plane/runtime behavior beneath that UI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!migrationUrl?.trim()) {
  throw new Error("Runtime full-stack integration requires an explicitly disposable DATABASE_URL");
}

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const runtimeGrantsFile = fileURLToPath(
  new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `runtime_e2e_${suffix}`;
const apiRole = `runtime_e2e_api_${suffix}`;
const workerRole = `runtime_e2e_worker_${suffix}`;
const runtimeRole = `runtime_e2e_exec_${suffix}`;
const rolePassword = `runtime-e2e-${suffix}`;
const email = `runtime-e2e-${suffix}@example.test`;
const password = `runtime-e2e-password-${suffix}`;
const masterKey = Buffer.alloc(32, 37).toString("base64");
const desktopKey = Buffer.alloc(32, 73).toString("base64");
const controlToken = `control-${suffix}`;
const boxApiKey = `box-${suffix}`;
const releaseId = `runtime-e2e-${suffix}`;

type Sql = ReturnType<typeof postgres>;

interface ManagedProcess {
  child: ChildProcess;
  label: string;
  environment: NodeJS.ProcessEnv;
  output(): string;
}

interface TurnRow {
  id: string;
  status: string;
  queueSequence: number;
  startedAt: Date | null;
  settledAt: Date | null;
  errorCode: string | null;
}

interface OperationRow {
  id: string;
  kind: string;
  status: string;
  settledAt: Date | null;
  errorCode: string | null;
}

interface BoxSimState {
  boxes: Array<{
    id: string;
    state: string;
    daemon: {
      status: string;
      invocationId: string | null;
      layoutMarker: string | null;
      activeAttemptId: string | null;
      tailCursor: number;
      acknowledgedCursor: number;
      counters: {
        malformedLines: number;
        oversizedLines: number;
        unterminatedLines: number;
        unknownEvents: number;
        unboundEvents: number;
        orphanResponses: number;
      };
      restartCount: number;
      scenario: string;
    };
  }>;
  deletions: Array<{ id: string; targetId: string; status: string }>;
  requests: Array<{ surface: string; method: string; path: string }>;
}

type BoxSimBox = BoxSimState["boxes"][number];

class TerminalWaitError extends Error {}

const adminSql = postgres(migrationUrl, { max: 1 });
const databaseUrl = databaseRoleUrl(migrationUrl, databaseName);
const ownerUrl = databaseUrl.toString();
const apiUrl = databaseRoleUrl(migrationUrl, databaseName, apiRole, rolePassword).toString();
const workerUrl = databaseRoleUrl(migrationUrl, databaseName, workerRole, rolePassword).toString();
const runtimeUrl = databaseRoleUrl(migrationUrl, databaseName, runtimeRole, rolePassword).toString();

let databaseCreated = false;
let rolesCreated = false;
let databaseSql: Sql | undefined;
let apiPort = 0;
let runtimePort = 0;
let boxPort = 0;
let apiBase = "";
let runtimeBase = "";
let boxBase = "";
let boxControlBase = "";
let apiProcess: ManagedProcess | undefined;
let workerProcess: ManagedProcess | undefined;
let runtimeProcess: ManagedProcess | undefined;
let boxProcess: ManagedProcess | undefined;
let sessionCookie = "";
let orgId = "";
let userId = "";
let companionId = "";

function databaseRoleUrl(
  source: string,
  name: string,
  role?: string,
  roleSecret?: string,
): URL {
  const result = new URL(source);
  result.pathname = `/${name}`;
  result.search = "";
  if (role) {
    result.username = role;
    result.password = roleSecret ?? "";
  }
  return result;
}

interface PortReservation {
  port: number;
  release(): Promise<void>;
}

const STARTUP_ATTEMPTS = 2;

async function reservePort(): Promise<PortReservation> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a loopback port"));
        return;
      }
      let released = false;
      resolve({
        port: address.port,
        release: async () => {
          if (released) return;
          released = true;
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
        },
      });
    });
  });
}

async function reserveDistinctPorts(count: number): Promise<PortReservation[]> {
  const reservations: PortReservation[] = [];
  try {
    while (reservations.length < count) reservations.push(await reservePort());
    return reservations;
  } catch (error) {
    await Promise.all(reservations.map((reservation) => reservation.release().catch(() => undefined)));
    throw error;
  }
}

async function releaseReservations(reservations: PortReservation[]): Promise<void> {
  await Promise.all(reservations.map((reservation) => reservation.release().catch(() => undefined)));
}

async function applyMigrationFile(client: Sql, name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

async function migrationFileNames(): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function replayMigrations(client: Sql, names: string[]): Promise<void> {
  for (const name of names) await applyMigrationFile(client, name);
}

async function applyRuntimeGrants(client: Sql): Promise<void> {
  const source = await readFile(runtimeGrantsFile, "utf8");
  const begin = source.indexOf("-- companion-runtime-grants-begin");
  const end = source.indexOf("-- companion-runtime-grants-end");
  if (begin < 0 || end <= begin) throw new Error("runtime role grant block is missing");
  const grants = source.slice(begin + "-- companion-runtime-grants-begin".length, end).trim();
  await client`select set_config('companion.api_role', ${apiRole}, false)`;
  await client`select set_config('companion.worker_role', ${workerRole}, false)`;
  await client`select set_config('companion.companion_runtime_role', ${runtimeRole}, false)`;
  await client`select set_config('companion.retired_runtime_role', '', false)`;
  await client.unsafe(grants);
}

const SAFE_CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "CI",
  "LANG",
  "LC_ALL",
  "TZ",
  "HOSTNAME",
  "PNPM_HOME",
  "COREPACK_HOME",
  "COREPACK_ENABLE_PROJECT_SPEC",
  "NODE_OPTIONS",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

function cleanChildEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  return { ...environment, ...overrides };
}

function startProcess(label: string, args: string[], overrides: NodeJS.ProcessEnv): ManagedProcess {
  const environment = cleanChildEnvironment(overrides);
  const child = spawn("pnpm", args, {
    cwd: repositoryRoot,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const append = (chunk: Buffer | string): void => {
    log = `${log}${String(chunk)}`.slice(-200_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, label, environment, output: () => log };
}

async function runProcess(label: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const processHandle = startProcess(label, args, env);
  const code = await new Promise<number | null>((resolve, reject) => {
    processHandle.child.once("error", reject);
    processHandle.child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`${label} exited ${String(code)} (signal=${String(processHandle.child.signalCode)})`);
  }
}

async function stopProcess(processHandle: ManagedProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!processHandle || processHandle.child.exitCode !== null || processHandle.child.signalCode) return;
  const pid = processHandle.child.pid;
  if (!pid) return;
  try {
    globalThis.process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => processHandle.child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (processHandle.child.exitCode === null && !processHandle.child.signalCode) {
    try {
      globalThis.process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      if (error instanceof TerminalWaitError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for ${label}${detail}`);
}

function processExitError(processHandle: ManagedProcess): TerminalWaitError {
  return new TerminalWaitError(
    `${processHandle.label} exited early (exit=${String(processHandle.child.exitCode)}, `
    + `signal=${String(processHandle.child.signalCode)})`,
  );
}

async function fetchWhileProcessIsAlive(
  url: string,
  processHandle: ManagedProcess,
  init: RequestInit,
): Promise<boolean> {
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
    throw processExitError(processHandle);
  }
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      processHandle.child.removeListener("exit", onExit);
      callback();
    };
    const onExit = (): void => settle(() => reject(processExitError(processHandle)));
    processHandle.child.once("exit", onExit);
    void fetch(url, init).then(
      (response) => settle(() => resolve(response.ok)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

async function waitForHttp(
  url: string,
  processHandle: ManagedProcess,
  init: RequestInit = {},
): Promise<void> {
  await waitFor(`${processHandle.label} readiness`, async () => {
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode) {
      throw processExitError(processHandle);
    }
    return await fetchWhileProcessIsAlive(url, processHandle, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(1_000),
    });
  }, 30_000);
}

function commonApiEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: apiUrl,
    BETTER_AUTH_URL: apiBase,
    BETTER_AUTH_SECRET: "runtime-e2e-better-auth-secret-32-bytes",
    BETTER_AUTH_COOKIE_PREFIX: `runtime_e2e_${suffix}`,
    COMPANION_API_HOST: "127.0.0.1",
    COMPANION_API_PORT: String(apiPort),
    COMPANION_API_URL: apiBase,
    COMPANION_WEB_URL: apiBase,
    COMPANION_COMPANIONS_ENABLED: "true",
    COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
    COMPANION_SECRETS_MASTER_KEY: masterKey,
    COMPANION_RUNTIME_PRIVATE_URL: runtimeBase,
    COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: desktopKey,
    RAILWAY_GIT_COMMIT_SHA: releaseId,
  };
}

function startApi(): ManagedProcess {
  return startProcess(
    "Companion API",
    ["--filter", "@companion/api", "exec", "tsx", "src/index.ts"],
    commonApiEnv(),
  );
}

function startWorker(): ManagedProcess {
  return startProcess(
    "Companion Worker",
    ["--filter", "@companion/worker", "exec", "tsx", "src/index.ts"],
    {
      NODE_ENV: "test",
      DATABASE_URL: workerUrl,
      COMPANION_DATABASE_POOL_MAX: "2",
      COMPANION_BILLING_MODE: "disabled",
      COMPANION_SKILL_DB_CLEANUP_INTERVAL_MS: "60000",
    },
  );
}

function startRuntime(executorId: string): ManagedProcess {
  return startProcess(
    `Companion Runtime ${executorId.slice(0, 8)}`,
    ["--filter", "@companion/runtime", "exec", "tsx", "src/index.ts"],
    {
      NODE_ENV: "test",
      DATABASE_COMPANION_RUNTIME_URL: runtimeUrl,
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
      COMPANION_SECRETS_MASTER_KEY: masterKey,
      COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: desktopKey,
      COMPANION_RUNTIME_EXECUTOR_ID: executorId,
      COMPANION_RUNTIME_HOST: "127.0.0.1",
      COMPANION_RUNTIME_PORT: String(runtimePort),
      COMPANION_RUNTIME_SWEEP_INTERVAL_MS: "250",
      COMPANION_RUNTIME_SHUTDOWN_DRAIN_MS: "100",
      RAILWAY_GIT_COMMIT_SHA: releaseId,
      COMPANION_API_URL: apiBase,
      COMPANION_BOX_API_KEY: boxApiKey,
      COMPANION_BOX_API_BASE: boxBase,
      COMPANION_BOX_POLL_INTERVAL_MS: "10",
      COMPANION_BOX_READY_TIMEOUT_MS: "10000",
      COMPANION_PI_BROKER_TIMEOUT_MS: "5000",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "10000",
      // Full direct-transport rollout: every staging registers the hosted agent endpoint and the
      // kernel consumes the event path over it, with per-call fallback to the exec transport.
      COMPANION_DIRECT_TRANSPORT: "on",
    },
  );
}

function setBoxPort(port: number): void {
  boxPort = port;
  boxBase = `http://127.0.0.1:${boxPort}`;
  boxControlBase = `${boxBase}/_box-sim`;
}

function setApiRuntimePorts(api: number, runtime: number): void {
  apiPort = api;
  runtimePort = runtime;
  apiBase = `http://127.0.0.1:${apiPort}`;
  runtimeBase = `http://127.0.0.1:${runtimePort}`;
}

function hasAddressInUse(processHandles: ManagedProcess[]): boolean {
  return processHandles.some((processHandle) => /\bEADDRINUSE\b/.test(processHandle.output()));
}

async function startBoxWithRetry(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt += 1) {
    const reservation = await reservePort();
    setBoxPort(reservation.port);
    let candidate: ManagedProcess | undefined;
    try {
      await reservation.release();
      candidate = startProcess(
        "Box/Pi simulator",
        ["--filter", "@companion/box-sim", "exec", "tsx", "src/cli.ts"],
        {
          BOX_SIM_HOST: "127.0.0.1",
          BOX_SIM_PORT: String(boxPort),
          BOX_SIM_API_KEY: boxApiKey,
          BOX_SIM_CONTROL_TOKEN: controlToken,
          // Ephemeral agent listener: staging learns the hosted URL from `host url`, so no
          // caller needs the concrete port and it can never collide with the reserved pair.
          BOX_SIM_AGENT_PORT: "0",
        },
      );
      await waitForHttp(`${boxControlBase}/state`, candidate, {
        headers: { "x-box-sim-token": controlToken },
      });
      boxProcess = candidate;
      return;
    } catch (error) {
      lastError = error;
      await stopProcess(candidate, "SIGTERM").catch(() => undefined);
      if (candidate && attempt < STARTUP_ATTEMPTS && hasAddressInUse([candidate])) continue;
      throw error;
    } finally {
      await reservation.release().catch(() => undefined);
    }
  }
  throw lastError ?? new Error("Box/Pi simulator did not start");
}

async function startApiRuntimePair(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt += 1) {
    const reservations = await reserveDistinctPorts(2);
    setApiRuntimePorts(reservations[0]!.port, reservations[1]!.port);
    let candidateApi: ManagedProcess | undefined;
    let candidateRuntime: ManagedProcess | undefined;
    try {
      await releaseReservations(reservations);
      candidateApi = startApi();
      // This is deliberately before the database feature gate is enabled: /healthz must stay
      // available while claims are disabled, and both sides retain this exact URL pair on retry.
      candidateRuntime = startRuntime(randomUUID());
      await Promise.all([
        waitForHttp(`${apiBase}/health`, candidateApi),
        waitForHttp(`${runtimeBase}/healthz`, candidateRuntime),
      ]);
      apiProcess = candidateApi;
      runtimeProcess = candidateRuntime;
      return;
    } catch (error) {
      lastError = error;
      await Promise.all([
        stopProcess(candidateApi, "SIGTERM").catch(() => undefined),
        stopProcess(candidateRuntime, "SIGTERM").catch(() => undefined),
      ]);
      if (
        attempt < STARTUP_ATTEMPTS
        && hasAddressInUse([candidateApi, candidateRuntime].filter(
          (processHandle): processHandle is ManagedProcess => Boolean(processHandle),
        ))
      ) {
        continue;
      }
      throw error;
    } finally {
      await releaseReservations(reservations);
    }
  }
  throw lastError ?? new Error("Companion API and Runtime did not start");
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", apiBase);
  if (sessionCookie) headers.set("cookie", sessionCookie);
  if (orgId) headers.set("x-companion-org", orgId);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

async function apiJson<T>(path: string, init: RequestInit, status: number): Promise<T> {
  const response = await apiRequest(path, init);
  const body = await response.json().catch(() => null) as T | { error?: string } | null;
  if (response.status !== status) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function signIn(): Promise<void> {
  const response = await apiRequest("/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  const cookieHeaders = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? [response.headers.get("set-cookie") ?? ""];
  sessionCookie = cookieHeaders
    .filter(Boolean)
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
  if (!sessionCookie) throw new Error("sign-in returned no session cookie");
}

function assertProcessAlive(processHandle: ManagedProcess | undefined): asserts processHandle is ManagedProcess {
  if (
    !processHandle
    || processHandle.child.exitCode !== null
    || processHandle.child.signalCode !== null
  ) {
    throw new Error(
      `${processHandle?.label ?? "process"} is not alive `
      + `(exit=${String(processHandle?.child.exitCode ?? null)}, `
      + `signal=${String(processHandle?.child.signalCode ?? null)})`,
    );
  }
}

async function turnRow(turnId: string): Promise<TurnRow | undefined> {
  const rows = await databaseSql!<TurnRow[]>`
    select t.id::text, t.status::text, t.queue_sequence::int as "queueSequence",
      a.started_at as "startedAt", t.settled_at as "settledAt",
      t.last_error_code as "errorCode"
    from companion_turns t
    left join lateral (
      select attempt.started_at
      from companion_turn_attempts attempt
      where attempt.turn_id = t.id
      order by attempt.attempt_number desc
      limit 1
    ) a on true
    where t.id = ${turnId}::uuid
  `;
  return rows[0];
}

async function waitForTurn(turnId: string, status: string, timeoutMs = 30_000): Promise<TurnRow> {
  try {
    return await waitFor(`turn ${turnId} to become ${status}`, async () => {
      const row = await turnRow(turnId);
      if (!row) return false;
      if (["failed", "interrupted", "cancelled"].includes(row.status) && row.status !== status) {
        throw new TerminalWaitError(
          `turn became ${row.status} (${row.errorCode ?? "no code"}); ${await turnDiagnostic(turnId)}`,
        );
      }
      return row.status === status ? row : false;
    }, timeoutMs);
  } catch (error) {
    if (error instanceof TerminalWaitError) throw error;
    throw new Error(`${error instanceof Error ? error.message : "turn wait failed"}; ${await turnDiagnostic(turnId)}`);
  }
}

async function turnDiagnostic(turnId: string): Promise<string> {
  const row = await turnRow(turnId).catch(() => undefined);
  const [attempt] = await databaseSql!<Array<{
    status: string;
    checkpoint: string;
    cursor: number;
    dispatchState: string;
  }>>`
    select status::text, checkpoint, event_cursor::int as cursor,
      dispatch_state::text as "dispatchState"
    from companion_turn_attempts where turn_id = ${turnId}::uuid
    order by attempt_number desc limit 1
  `.catch(() => []);
  const simulator = await simulatorState().catch(() => null);
  const boxId = await durableCompanionBoxId().catch(() => null);
  const box = simulator && boxId ? boxById(simulator, boxId) : undefined;
  const processState = (processHandle: ManagedProcess | undefined) => ({
    running: Boolean(
      processHandle
      && processHandle.child.exitCode === null
      && processHandle.child.signalCode === null
    ),
    exitCode: processHandle?.child.exitCode ?? null,
    signal: processHandle?.child.signalCode ?? null,
  });
  return `turn=${JSON.stringify(row)} attempt=${JSON.stringify(attempt)} `
    + `box=${JSON.stringify(box ? {
      id: box.id,
      state: box.state,
      daemon: {
        status: box.daemon.status,
        invocationId: box.daemon.invocationId,
        layoutMarker: box.daemon.layoutMarker,
        activeAttemptId: box.daemon.activeAttemptId,
        tailCursor: box.daemon.tailCursor,
        acknowledgedCursor: box.daemon.acknowledgedCursor,
        counters: box.daemon.counters,
        restartCount: box.daemon.restartCount,
      },
    } : null)} runtime=${JSON.stringify(processState(runtimeProcess))} `
    + `worker=${JSON.stringify(processState(workerProcess))}`;
}

async function waitForOperation(operationId: string, timeoutMs = 30_000): Promise<OperationRow> {
  return await waitFor(`operation ${operationId}`, async () => {
    const [row] = await databaseSql!<OperationRow[]>`
      select id::text, kind::text, status::text, settled_at as "settledAt",
        last_error_code as "errorCode"
      from companion_operations where id = ${operationId}::uuid
    `;
    if (!row) return false;
    if (["failed", "interrupted", "cancelled"].includes(row.status)) {
      throw new Error(`${row.kind} became ${row.status} (${row.errorCode ?? "no code"})`);
    }
    return row.status === "succeeded" ? row : false;
  }, timeoutMs);
}

async function boxControl<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${boxControlBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-box-sim-token": controlToken,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Box simulator control ${path} returned ${response.status}`);
  return await response.json() as T;
}

async function boxProvider<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${boxBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${boxApiKey}`,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Box simulator provider ${path} returned ${response.status}`);
  return await response.json() as T;
}

async function simulatorState(): Promise<BoxSimState> {
  const result = await boxControl<{ state: BoxSimState }>("/state");
  return result.state;
}

async function durableCompanionBoxId(): Promise<string | null> {
  const [instance] = await databaseSql!<Array<{ boxId: string | null }>>`
    select box_id as "boxId"
    from companion_runtime_instances
    where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
  `;
  return instance?.boxId ?? null;
}

function boxById(state: BoxSimState, boxId: string): BoxSimBox | undefined {
  return state.boxes.find((candidate) => candidate.id === boxId);
}

beforeAll(async () => {
  await adminSql.unsafe(`
    create role ${apiRole} login password '${rolePassword}' nosuperuser nobypassrls noinherit;
    create role ${workerRole} login password '${rolePassword}' nosuperuser nobypassrls noinherit;
    create role ${runtimeRole} login password '${rolePassword}' nosuperuser nobypassrls noinherit;
  `);
  rolesCreated = true;
  await adminSql.unsafe(`create database "${databaseName}"`);
  databaseCreated = true;
  const migrationNames = await migrationFileNames();
  const cutoverIndex = migrationNames.findIndex((name) => name.startsWith("0094_"));
  if (cutoverIndex < 0) throw new Error("Runtime v2 cutover migration is missing");
  const migrationSql = postgres(ownerUrl, { max: 1 });
  try {
    await replayMigrations(migrationSql, migrationNames.slice(0, cutoverIndex));
    // 0094 verifies a grants nonce bound to this physical backend before destructive cutover.
    await applyRuntimeGrants(migrationSql);
    await replayMigrations(migrationSql, migrationNames.slice(cutoverIndex));
    // The two-phase migration runner re-applies the grants hook after the post-cutover phase, and
    // this suite must start the real Runtime process against the same ACLs: a post-cutover
    // migration that DROP + CREATEs a function resets that function's grant.
    await applyRuntimeGrants(migrationSql);
  } finally {
    await migrationSql.end({ timeout: 1 });
  }
  databaseSql = postgres(ownerUrl, { max: 4 });

  await startBoxWithRetry();
  await startApiRuntimePair();

  await runProcess(
    "test-user seed",
    ["--filter", "@companion/api", "exec", "tsx", "src/seed-test-user.ts"],
    {
      ...commonApiEnv(),
      COMPANION_ALLOW_TEST_USER_SEED: "1",
      COMPANION_SEED_EMAIL: email,
      COMPANION_SEED_PASSWORD: password,
      COMPANION_SEED_NAME: "Runtime E2E Owner",
    },
  );

  const [identity] = await databaseSql<Array<{ userId: string; orgId: string }>>`
    select u.id as "userId", m.org_id::text as "orgId"
    from "user" u join memberships m on m.user_id = u.id
    where u.email = ${email}
    order by m.created_at limit 1
  `;
  if (!identity) throw new Error("seed did not create a tenant identity");
  userId = identity.userId;
  orgId = identity.orgId;

  await signIn();

  workerProcess = startWorker();
  await waitFor("Worker process startup", async () => {
    assertProcessAlive(workerProcess);
    return workerProcess.output().includes("GitHub sync supervisor disabled");
  }, 10_000);

  await apiJson("/v1/companion-providers/anthropic", {
    method: "PUT",
    body: JSON.stringify({ auth_method: "api_key", credential: "deterministic-e2e-key" }),
  }, 200);

  companionId = randomUUID();
  await databaseSql`
    insert into companions (
      id, org_id, owner_id, name, persona, model_id, provider_ids,
      selected_skill_ids, selected_mcp_account_ids
    ) values (
      ${companionId}::uuid, ${orgId}::uuid, ${userId}, 'Runtime full stack',
      'Reply concisely.', 'claude-sonnet-4-6', '["anthropic"]'::jsonb,
      '[]'::jsonb, '[]'::jsonb
    )
  `;
  await databaseSql`
    insert into companion_runtime_instances (org_id, companion_id, health_due_at)
    values (${orgId}::uuid, ${companionId}::uuid, now() - interval '1 second')
  `;
  const [gate] = await databaseSql<Array<{ epoch: string; enabled: boolean }>>`
    select gate_epoch::text as epoch, enabled from companion_runtime_control where id = 'runtime-v2'
  `;
  if (gate && !gate.enabled) {
    await databaseSql`select * from public.companion_runtime_enable(${gate.epoch}::bigint, 'runtime-e2e')`;
  }
}, 180_000);

afterAll(async () => {
  await stopProcess(apiProcess, "SIGTERM").catch(() => undefined);
  await stopProcess(workerProcess, "SIGTERM").catch(() => undefined);
  await stopProcess(runtimeProcess, "SIGTERM").catch(() => undefined);
  await stopProcess(boxProcess, "SIGTERM").catch(() => undefined);
  await databaseSql?.end({ timeout: 1 });
  if (databaseCreated) {
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
  }
  if (rolesCreated) {
    await adminSql.unsafe(`drop role if exists ${runtimeRole}, ${workerRole}, ${apiRole}`);
  }
  await adminSql.end({ timeout: 1 });
}, 30_000);

describe("Runtime v2 real-process control plane", () => {
  it("survives API death and runtime takeover while preserving order, decisions, wake, and delete", async () => {
    assertProcessAlive(apiProcess);
    assertProcessAlive(workerProcess);
    assertProcessAlive(runtimeProcess);
    assertProcessAlive(boxProcess);
    expect(apiProcess.environment.COMPANION_BOX_API_KEY).toBeUndefined();
    expect(workerProcess.environment.COMPANION_BOX_API_KEY).toBeUndefined();
    expect(apiProcess.environment.BOX_SIM_API_KEY).toBeUndefined();
    expect(workerProcess.environment.BOX_SIM_API_KEY).toBeUndefined();
    expect(runtimeProcess.environment.COMPANION_BOX_API_KEY).toBe(boxApiKey);
    expect(boxProcess.environment.BOX_SIM_API_KEY).toBe(boxApiKey);
    expect(apiProcess.environment.RAILWAY_GIT_COMMIT_SHA).toBe(releaseId);
    expect(runtimeProcess.environment.RAILWAY_GIT_COMMIT_SHA).toBe(releaseId);
    expect(apiProcess.environment.COMPANION_RELEASE_ID).toBeUndefined();
    expect(runtimeProcess.environment.COMPANION_RELEASE_ID).toBeUndefined();
    const providerSecretKeys = (environment: NodeJS.ProcessEnv): string[] =>
      Object.keys(environment).filter((key) =>
        /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN)$/.test(key));
    expect(providerSecretKeys(apiProcess.environment)).toEqual([]);
    expect(providerSecretKeys(workerProcess.environment)).toEqual([]);
    expect(Object.keys(apiProcess.environment).filter((key) => key.startsWith("DATABASE_")))
      .toEqual(["DATABASE_URL"]);
    expect(Object.keys(workerProcess.environment).filter((key) => key.startsWith("DATABASE_")))
      .toEqual(["DATABASE_URL"]);
    expect(Object.keys(runtimeProcess.environment).filter((key) => key.startsWith("DATABASE_")))
      .toEqual(["DATABASE_COMPANION_RUNTIME_URL"]);
    const [apiHealth, runtimeHealth] = await Promise.all([
      apiRequest("/health"),
      fetch(`${runtimeBase}/healthz`, { signal: AbortSignal.timeout(5_000) }),
    ]);
    expect(apiHealth.status).toBe(200);
    expect(runtimeHealth.status).toBe(200);
    await expect(apiHealth.json()).resolves.toMatchObject({ release_id: releaseId });
    await expect(runtimeHealth.json()).resolves.toMatchObject({ release_id: releaseId });

    for (const [installationId, tokenByte] of [
      [randomUUID(), "ab"],
      [randomUUID(), "cd"],
    ] as const) {
      const registration = await apiRequest(`/v1/notification-devices/${installationId}`, {
        method: "PUT",
        body: JSON.stringify({
          platform: "ios",
          device_token: tokenByte.repeat(32),
          environment: "sandbox",
          bundle_id: "dev.companion.mobile.dev",
        }),
      });
      const registrationBody = await registration.text();
      expect(registration.status, registrationBody).toBe(204);
      expect(registrationBody).toBe("");
    }
    const collaboratingUserId = `notification-collaborator-${suffix}`;
    await databaseSql!`
      insert into "user" (id, name, email, email_verified)
      values (
        ${collaboratingUserId}, 'Notification collaborator',
        ${`${collaboratingUserId}@example.test`}, true
      )
    `;
    await databaseSql!`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${collaboratingUserId}, 'developer')
    `;
    await databaseSql!`
      insert into companion_workspace_access (org_id, companion_id, owner_id, role, granted_by)
      values (${orgId}::uuid, ${companionId}::uuid, ${userId}, 'editor', ${userId})
    `;
    await databaseSql!`
      insert into companion_notification_devices (
        org_id, installation_id, user_id, device_token, environment, bundle_id
      ) values (
        ${orgId}::uuid, ${randomUUID()}::uuid, ${collaboratingUserId}, ${"ef".repeat(32)},
        'sandbox', 'dev.companion.mobile.dev'
      )
    `;

    const coldAcceptedAt = Date.now();
    const coldMessageId = randomUUID();
    const cold = await apiJson<{ turn: { id: string; status: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: coldMessageId,
          client_surface: "web",
          content: "Cold-start this Companion and answer once.",
        }),
      },
      202,
    );
    expect(Date.now() - coldAcceptedAt).toBeLessThan(1_000);
    expect(cold.turn.status).toBe("queued");

    // The accepted transaction, not the API process, owns delivery from this point onward.
    await stopProcess(apiProcess, "SIGKILL");
    apiProcess = undefined;
    const coldTerminal = await waitForTurn(cold.turn.id, "succeeded", 45_000);
    expect(coldTerminal.startedAt).not.toBeNull();
    // A just-due health observation must release its lease instead of starving the accepted Send
    // until the 30-second lease expiry. This is the production claim-latency SLO, not UI polling.
    expect(coldTerminal.startedAt!.getTime() - coldAcceptedAt).toBeLessThan(5_000);
    expect(coldTerminal.errorCode).toBeNull();
    const [coldProjection] = await databaseSql!<Array<{ assistants: number }>>`
      select count(*) filter (where role = 'assistant')::int as assistants
      from companion_transcript_entries where companion_id = ${companionId}::uuid
    `;
    expect(coldProjection?.assistants).toBeGreaterThanOrEqual(1);
    // Direct transport carried the cold turn's event path: staging registered the hosted agent
    // endpoint, and no direct call had to fall back to the exec transport.
    const runtimeOutput = runtimeProcess?.output() ?? "";
    expect(runtimeOutput).toContain("\"phase\":\"agent_registration\"");
    expect(runtimeOutput).not.toContain("runtime.direct_transport.fallback");
    const coldNotifications = await databaseSql!<Array<{
      event: string;
      title: string;
      body: string;
      expiresInHours: number;
      recipientUserId: string;
    }>>`
      select delivery.event::text, delivery.title, delivery.body,
        delivery.recipient_user_id as "recipientUserId",
        extract(epoch from (delivery.expires_at - delivery.created_at)) / 3600 as "expiresInHours"
      from companion_notification_deliveries delivery
      where delivery.event_key like ${`turn:${cold.turn.id}:succeeded:%`}
      order by delivery.created_at
    `;
    expect(coldNotifications).toHaveLength(2);
    expect(coldNotifications.every((delivery) =>
      delivery.event === "reply"
      && delivery.title === "Runtime full stack replied"
      && delivery.body.length > 0
      && delivery.body.length <= 180
      && delivery.recipientUserId === userId
      && Number(delivery.expiresInHours) === 24)).toBe(true);

    apiProcess = startApi();
    await waitForHttp(`${apiBase}/health`, apiProcess);
    const persisted = await apiJson<{ thread: { entries: Array<{ role: string }> } }>(
      `/v1/companions/${companionId}/thread`,
      { method: "GET" },
      200,
    );
    expect(persisted.thread.entries.some((entry) => entry.role === "assistant")).toBe(true);

    const stateAfterCold = await simulatorState();
    const durableBoxId = await durableCompanionBoxId();
    const box = durableBoxId ? boxById(stateAfterCold, durableBoxId) : undefined;
    if (!box) throw new Error("cold send did not create a Box");
    expect(box.state).toMatch(/ready|idle|running/);
    await boxControl(`/boxes/${box.id}/scenario`, {
      method: "PUT",
      body: JSON.stringify({ scenario: "ask_user" }),
    });

    const decisionAccepted = await apiJson<{ turn: { id: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: randomUUID(),
          client_surface: "web",
          content: "Ask me for one deterministic choice before continuing.",
        }),
      },
      202,
    );
    await waitForTurn(decisionAccepted.turn.id, "needs_input", 30_000);
    const decisionNotifications = await databaseSql!<Array<{
      event: string;
      title: string;
      body: string;
    }>>`
      select event::text, title, body
      from companion_notification_deliveries
      where event_key like ${`decision:%`}
      order by created_at
    `;
    expect(decisionNotifications).toHaveLength(2);
    expect(decisionNotifications.every((delivery) =>
      delivery.event === "input_required"
      && delivery.title === "Runtime full stack needs your answer"
      && delivery.body.length > 0
      && delivery.body.length <= 180)).toBe(true);

    // Exercise takeover while the decision is still pending. Any later member message now closes
    // this wait fail-closed, so notification fixtures must not be interleaved before the answer.
    const [decision] = await databaseSql!<Array<{ requestKey: string }>>`
      select request_key as "requestKey" from companion_decision_deliveries
      where turn_id = ${decisionAccepted.turn.id}::uuid and decision_status = 'pending'
      order by created_at limit 1
    `;
    if (!decision) throw new Error("ask_user did not project a durable decision");
    const beforeTakeover = await simulatorState();
    const beforeBroker = boxById(beforeTakeover, box.id)?.daemon;
    if (!beforeBroker) throw new Error("decision turn lost its broker state");
    const [attemptsBefore] = await databaseSql!<Array<{ count: number; dispatchCount: number }>>`
      select count(*)::int as count, max(dispatch_count)::int as "dispatchCount"
      from companion_turn_attempts
      where turn_id = ${decisionAccepted.turn.id}::uuid
    `;
    expect(attemptsBefore?.count).toBe(1);
    expect(attemptsBefore?.dispatchCount).toBe(1);

    const takeoverStartedAt = Date.now();
    await stopProcess(runtimeProcess, "SIGKILL");
    runtimeProcess = startRuntime(randomUUID());
    await waitForHttp(`${runtimeBase}/healthz`, runtimeProcess);
    await apiJson(
      `/v1/companions/${companionId}/decisions/${encodeURIComponent(decision.requestKey)}`,
      {
        method: "POST",
        body: JSON.stringify({ action: "answer", answer: "Continue." }),
      },
      202,
    );
    await waitForTurn(decisionAccepted.turn.id, "succeeded", 45_000);
    expect(Date.now() - takeoverStartedAt).toBeLessThan(45_000);
    const [attemptsAfter] = await databaseSql!<Array<{ count: number; dispatchCount: number }>>`
      select count(*)::int as count, max(dispatch_count)::int as "dispatchCount"
      from companion_turn_attempts
      where turn_id = ${decisionAccepted.turn.id}::uuid
    `;
    expect(attemptsAfter?.count).toBe(1);
    expect(attemptsAfter?.dispatchCount).toBe(1);
    const afterTakeover = await simulatorState();
    const afterTakeoverBroker = boxById(afterTakeover, box.id)?.daemon;
    expect(afterTakeoverBroker).toMatchObject({
      invocationId: beforeBroker.invocationId,
      activeAttemptId: null,
    });
    expect(afterTakeoverBroker?.tailCursor).toBeGreaterThan(beforeBroker.tailCursor);
    expect(afterTakeoverBroker?.acknowledgedCursor).toBe(afterTakeoverBroker?.tailCursor);

    await boxControl(`/boxes/${box.id}/scenario`, {
      method: "PUT",
      body: JSON.stringify({ scenario: "normal" }),
    });

    const cancelled = await apiJson<{ turn: { id: string; status: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: randomUUID(),
          client_surface: "web",
          content: "Cancel this queued notification fixture.",
        }),
      },
      202,
    );
    const cancelledResult = await apiJson<{ turn: { status: string } }>(
      `/v1/companions/${companionId}/turns/${cancelled.turn.id}/cancel`,
      { method: "POST", body: JSON.stringify({}) },
      202,
    );
    expect(cancelledResult.turn.status).toBe("cancelled");
    const [cancelledDelivery] = await databaseSql!<Array<{ count: number }>>`
      select count(*)::int as count from companion_notification_deliveries
      where event_key like ${`turn:${cancelled.turn.id}:%`}
    `;
    expect(cancelledDelivery?.count).toBe(0);

    const notificationWorkerA = postgres(workerUrl, { max: 1 });
    const notificationWorkerB = postgres(workerUrl, { max: 1 });
    const notificationApi = postgres(apiUrl, {
      max: 1,
      connection: { application_name: "notification-account-switch" },
    });
    try {
      await expect(notificationWorkerA`select count(*) from companion_notification_deliveries`)
        .rejects.toThrow(/permission denied/);

      const revokedEventKey = `authorization-revoked:${randomUUID()}`;
      await databaseSql!`
        select public.companion_notification_enqueue(
          ${orgId}::uuid, ${companionId}::uuid, ${collaboratingUserId}, ${revokedEventKey},
          'reply', 'Must not escape', 'Revoked before claim'
        )
      `;
      await databaseSql!`
        delete from companion_workspace_access
        where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
      `;

      const expiredEventKey = `expired:${randomUUID()}`;
      await databaseSql!`
        select public.companion_notification_enqueue(
          ${orgId}::uuid, ${companionId}::uuid, ${userId}, ${expiredEventKey},
          'reply', 'Expired', 'Must not be delivered'
        )
      `;
      await databaseSql!`
        update companion_notification_deliveries
        set expires_at = clock_timestamp() - interval '1 second'
        where event_key = ${expiredEventKey}
      `;

      const duplicateEventKey = `idempotent:${randomUUID()}`;
      const [firstFanout] = await databaseSql!<Array<{ inserted: number }>>`
        select public.companion_notification_enqueue(
          ${orgId}::uuid, ${companionId}::uuid, ${userId}, ${duplicateEventKey},
          'reply', 'Bounded title', ${"x".repeat(300)}
        ) as inserted
      `;
      const [secondFanout] = await databaseSql!<Array<{ inserted: number }>>`
        select public.companion_notification_enqueue(
          ${orgId}::uuid, ${companionId}::uuid, ${userId}, ${duplicateEventKey},
          'reply', 'Bounded title', 'Duplicate'
        ) as inserted
      `;
      expect(firstFanout?.inserted).toBe(2);
      expect(secondFanout?.inserted).toBe(0);
      const [boundedFanout] = await databaseSql!<Array<{ count: number; maxBody: number }>>`
        select count(*)::int as count, max(char_length(body))::int as "maxBody"
        from companion_notification_deliveries where event_key = ${duplicateEventKey}
      `;
      expect(boundedFanout).toEqual({ count: 2, maxBody: 180 });

      const [claimsA, claimsB] = await Promise.all([
        notificationWorkerA<Array<{
          deliveryId: string;
          claimToken: string;
          eventKey: string;
          companionName: string;
          iconShape: number;
          iconMouth: number;
          iconAccessory: number;
          iconColor: number;
        }>>`
          select "deliveryId"::text, "claimToken"::text, "eventKey", "companionName",
            "iconShape", "iconMouth", "iconAccessory", "iconColor"
          from public.companion_claim_notification_deliveries_v2('notification-worker-a', 3, 60)
        `,
        notificationWorkerB<Array<{
          deliveryId: string;
          claimToken: string;
          eventKey: string;
          companionName: string;
          iconShape: number;
          iconMouth: number;
          iconAccessory: number;
          iconColor: number;
        }>>`
          select "deliveryId"::text, "claimToken"::text, "eventKey", "companionName",
            "iconShape", "iconMouth", "iconAccessory", "iconColor"
          from public.companion_claim_notification_deliveries_v2('notification-worker-b', 3, 60)
        `,
      ]);
      expect(claimsA.length).toBeGreaterThan(0);
      expect(claimsB.length).toBeGreaterThan(0);
      const claimedIds = [...claimsA, ...claimsB].map((claim) => claim.deliveryId);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect([...claimsA, ...claimsB].map((claim) => claim.eventKey))
        .not.toContain(revokedEventKey);
      expect([...claimsA, ...claimsB].map((claim) => claim.eventKey))
        .not.toContain(expiredEventKey);
      expect([...claimsA, ...claimsB].every((claim) =>
        claim.companionName === "Runtime full stack"
        && claim.iconShape === 1
        && claim.iconMouth === 1
        && claim.iconAccessory === 1
        && claim.iconColor === 2)).toBe(true);

      const fencedClaim = claimsA[0]!;
      const [wrongFence] = await notificationWorkerA<Array<{ completed: boolean }>>`
        select public.companion_complete_notification_delivery(
          ${fencedClaim.deliveryId}::uuid, ${randomUUID()}::uuid
        ) as completed
      `;
      expect(wrongFence?.completed).toBe(false);
      for (const claim of [...claimsA, ...claimsB]) {
        const [settled] = await notificationWorkerA<Array<{ completed: boolean }>>`
          select public.companion_complete_notification_delivery(
            ${claim.deliveryId}::uuid, ${claim.claimToken}::uuid
          ) as completed
        `;
        expect(settled?.completed).toBe(true);
      }
      const [discarded] = await databaseSql!<Array<{ count: number }>>`
        select count(*)::int as count from companion_notification_deliveries
        where event_key in (${revokedEventKey}, ${expiredEventKey})
      `;
      expect(discarded?.count).toBe(0);

      const reassignedEventKey = `installation-reassigned:${randomUUID()}`;
      await databaseSql!`
        select public.companion_notification_enqueue(
          ${orgId}::uuid, ${companionId}::uuid, ${userId}, ${reassignedEventKey},
          'reply', 'Must remain private', 'Claimed before account switch'
        )
      `;
      const [reassignedClaim] = await notificationWorkerA<Array<{
        deliveryId: string;
        claimToken: string;
        deviceId: string;
      }>>`
        select "deliveryId"::text, "claimToken"::text, "deviceId"::text
        from public.companion_claim_notification_deliveries('notification-worker-a', 1, 60)
      `;
      if (!reassignedClaim) throw new Error("account-switch fixture was not claimed");
      const [claimedDevice] = await databaseSql!<Array<{ installationId: string }>>`
        select installation_id::text as "installationId"
        from companion_notification_devices where id = ${reassignedClaim.deviceId}::uuid
      `;
      if (!claimedDevice) throw new Error("account-switch fixture lost its device");
      let releaseSend!: () => void;
      const sendCanFinish = new Promise<void>((resolve) => { releaseSend = resolve; });
      let markValidated!: () => void;
      const sendValidated = new Promise<void>((resolve) => { markValidated = resolve; });
      const heldSend = notificationWorkerA.begin(async (tx) => {
        const [validation] = await tx<Array<{ valid: boolean }>>`
          select public.companion_validate_notification_delivery(
            ${reassignedClaim.deliveryId}::uuid, ${reassignedClaim.claimToken}::uuid
          ) as valid
        `;
        expect(validation?.valid).toBe(true);
        markValidated();
        await sendCanFinish;
        const [completion] = await tx<Array<{ completed: boolean }>>`
          select public.companion_complete_notification_delivery(
            ${reassignedClaim.deliveryId}::uuid, ${reassignedClaim.claimToken}::uuid
          ) as completed
        `;
        expect(completion?.completed).toBe(true);
      });
      await sendValidated;
      const accountSwitch = notificationApi.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${orgId}, true),
                        set_config('app.user_id', ${collaboratingUserId}, true)`;
        await tx`
          select public.companion_api_register_notification_device(
            ${orgId}::uuid, ${claimedDevice.installationId}::uuid, 'ios', ${"12".repeat(32)},
            'sandbox', 'dev.companion.mobile.dev'
          )
        `;
      });
      try {
        await waitFor("account switch to wait behind the APNs send", async () => {
          const [waiting] = await databaseSql!<Array<{ waiting: boolean }>>`
            select (wait_event_type = 'Lock' and wait_event = 'advisory') as waiting
            from pg_stat_activity
            where application_name = 'notification-account-switch'
              and state = 'active'
          `;
          return waiting?.waiting === true;
        });
      } finally {
        releaseSend();
      }
      await Promise.all([heldSend, accountSwitch]);
      const [switchedDevice] = await databaseSql!<Array<{ userId: string; deliveryCount: number }>>`
        select device.user_id as "userId", count(delivery.id)::int as "deliveryCount"
        from companion_notification_devices device
        left join companion_notification_deliveries delivery on delivery.device_id = device.id
        where device.installation_id = ${claimedDevice.installationId}::uuid
        group by device.user_id
      `;
      expect(switchedDevice).toEqual({ userId: collaboratingUserId, deliveryCount: 0 });
    } finally {
      await notificationWorkerA.end({ timeout: 1 });
      await notificationWorkerB.end({ timeout: 1 });
      await notificationApi.end({ timeout: 1 });
    }
    const concurrent = await Promise.all([
      apiJson<{ turn: { id: string; queue_sequence: number } }>(
        `/v1/companions/${companionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            client_message_id: randomUUID(),
            client_surface: "web",
            content: "Concurrent message A.",
          }),
        },
        202,
      ),
      apiJson<{ turn: { id: string; queue_sequence: number } }>(
        `/v1/companions/${companionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            client_message_id: randomUUID(),
            client_surface: "web",
            content: "Concurrent message B.",
          }),
        },
        202,
      ),
    ]);
    const ordered = [...concurrent].sort((left, right) =>
      left.turn.queue_sequence - right.turn.queue_sequence);
    const first = await waitForTurn(ordered[0]!.turn.id, "succeeded", 30_000);
    const second = await waitForTurn(ordered[1]!.turn.id, "succeeded", 30_000);
    expect(first.queueSequence).toBeLessThan(second.queueSequence);
    expect(first.settledAt!.getTime()).toBeLessThanOrEqual(second.startedAt!.getTime());

    // Reproduce the production divergence: the provider archives the Box while PostgreSQL still
    // projects it as idle. The interrupted occurrence is terminal immediately; the next accepted
    // message owns ordinary Box reconciliation and the ambiguous prompt is never replayed.
    await stopProcess(runtimeProcess, "SIGKILL");
    await databaseSql!`
      update companion_runtime_instances
      set box_state = 'idle',
          health_due_at = clock_timestamp() + interval '1 hour',
          updated_at = clock_timestamp()
      where org_id = ${orgId}::uuid and companion_id = ${companionId}::uuid
    `;
    await boxProvider(`/boxes/${encodeURIComponent(box.id)}/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await boxControl(`/boxes/${encodeURIComponent(box.id)}/tick`, {
      method: "POST",
      body: JSON.stringify({ count: 1 }),
    });
    expect(boxById(await simulatorState(), box.id)?.state).toBe("archived");

    const interrupted = await apiJson<{ turn: { id: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: randomUUID(),
          client_surface: "web",
          content: "This ambiguous occurrence must never be replayed.",
        }),
      },
      202,
    );
    await databaseSql!`
      update companion_turns
      set status = 'interrupted',
          absolute_deadline_at = clock_timestamp() + interval '2 hours',
          state_changed_at = clock_timestamp(),
          settled_at = clock_timestamp(),
          last_error_code = 'turn_stalled',
          last_error_message = 'The interrupted invocation ended without a confirmed outcome.',
          last_error_action = 'none',
          updated_at = clock_timestamp()
      where org_id = ${orgId}::uuid
        and companion_id = ${companionId}::uuid
        and id = ${interrupted.turn.id}::uuid
    `;
    const [terminal] = await databaseSql!<Array<{
      resolution: string | null;
      errorAction: string;
      recoveries: number;
      attempts: number;
    }>>`
      select turn_row.resolution,
        turn_row.last_error_action::text as "errorAction",
        count(distinct operation.id)::integer as recoveries,
        count(distinct attempt.id)::integer as attempts
      from companion_turns turn_row
      left join companion_operations operation
        on operation.source_turn_id = turn_row.id
        and operation.kind = 'restart_pi'
        and operation.trigger = 'recovery'
      left join companion_turn_attempts attempt on attempt.turn_id = turn_row.id
      where turn_row.id = ${interrupted.turn.id}::uuid
      group by turn_row.resolution, turn_row.last_error_action
    `;
    expect(terminal).toEqual({
      resolution: "auto_abandoned",
      errorAction: "none",
      recoveries: 0,
      attempts: 0,
    });

    const resumed = await apiJson<{ turn: { id: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: randomUUID(),
          client_surface: "web",
          content: "Resume the archived Box and dispatch only this message.",
        }),
      },
      202,
    );
    runtimeProcess = startRuntime(randomUUID());
    await waitForHttp(`${runtimeBase}/healthz`, runtimeProcess);
    await waitForTurn(resumed.turn.id, "succeeded", 30_000);
    const [resumedAttempt] = await databaseSql!<Array<{
      dispatchState: string;
      dispatchCount: number;
    }>>`
      select dispatch_state as "dispatchState", dispatch_count as "dispatchCount"
      from companion_turn_attempts
      where turn_id = ${resumed.turn.id}::uuid
    `;
    expect(resumedAttempt).toEqual({ dispatchState: "accepted", dispatchCount: 1 });
    expect(boxById(await simulatorState(), box.id)?.state).toMatch(/ready|idle|running/);

    const stop = await apiJson<{ operation: { id: string } }>(
      `/v1/companions/${companionId}/runtime/stop`,
      {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({}),
      },
      202,
    );
    await waitForOperation(stop.operation.id, 30_000);
    await waitFor("Box to archive", async () =>
      boxById(await simulatorState(), box.id)?.state === "archived");

    const [installedBeforePublication] = await databaseSql!<Array<{
      requiredRevision: number;
      availableRevision: number;
      appliedRevision: number;
      digest: string | null;
    }>>`
      select companion.skills_revision as "requiredRevision",
        companion.skills_available_revision as "availableRevision",
        instance.applied_skills_revision as "appliedRevision",
        instance.applied_skills_digest as digest
      from companions companion
      join companion_runtime_instances instance
        on instance.org_id = companion.org_id and instance.companion_id = companion.id
      where companion.org_id = ${orgId}::uuid and companion.id = ${companionId}::uuid
    `;
    expect(installedBeforePublication?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(installedBeforePublication?.appliedRevision)
      .toBe(installedBeforePublication?.availableRevision);
    await databaseSql!.begin(async (tx) => {
      await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
      await tx`
        update companions
        set skills_available_revision = skills_available_revision + 1
        where org_id = ${orgId}::uuid and id = ${companionId}::uuid
      `;
    });
    const publishedRevision = installedBeforePublication!.availableRevision + 1;

    const wake = await apiJson<{ turn: { id: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: randomUUID(),
          client_surface: "web",
          content: "Wake on this send and answer again.",
        }),
      },
      202,
    );
    await waitForTurn(wake.turn.id, "succeeded", 30_000);
    expect(boxById(await simulatorState(), box.id)?.state).toMatch(/ready|idle|running/);
    const [wakeSnapshot] = await databaseSql!<Array<{
      targetRevision: number;
      requiredRevision: number;
      availableRevision: number;
      appliedRevision: number;
    }>>`
      select operation.target_skills_revision as "targetRevision",
        companion.skills_revision as "requiredRevision",
        companion.skills_available_revision as "availableRevision",
        instance.applied_skills_revision as "appliedRevision"
      from companion_operations operation
      join companions companion
        on companion.org_id = operation.org_id and companion.id = operation.companion_id
      join companion_runtime_instances instance
        on instance.org_id = operation.org_id and instance.companion_id = operation.companion_id
      where operation.source_turn_id = ${wake.turn.id}::uuid and operation.kind = 'start'
    `;
    expect(wakeSnapshot).toMatchObject({
      targetRevision: installedBeforePublication!.appliedRevision,
      requiredRevision: installedBeforePublication!.requiredRevision,
      availableRevision: publishedRevision,
      appliedRevision: installedBeforePublication!.appliedRevision,
    });

    const beforePiRestart = boxById(await simulatorState(), box.id)?.daemon;
    if (!beforePiRestart?.invocationId) throw new Error("wake did not leave an observable Pi invocation");
    const restartPi = await apiJson<{ operation: { id: string } }>(
      `/v1/companions/${companionId}/runtime/restart`,
      {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({ target: "pi" }),
      },
      202,
    );
    await waitForOperation(restartPi.operation.id, 30_000);
    const [restartSnapshot] = await databaseSql!<Array<{
      targetRevision: number;
      requiredRevision: number;
      availableRevision: number;
      appliedRevision: number;
      updateErrorCode: string | null;
      updateErrorMessage: string | null;
    }>>`
      select operation.target_skills_revision as "targetRevision",
        companion.skills_revision as "requiredRevision",
        companion.skills_available_revision as "availableRevision",
        instance.applied_skills_revision as "appliedRevision",
        instance.skills_update_error_code as "updateErrorCode",
        instance.skills_update_error_message as "updateErrorMessage"
      from companion_operations operation
      join companions companion
        on companion.org_id = operation.org_id and companion.id = operation.companion_id
      join companion_runtime_instances instance
        on instance.org_id = operation.org_id and instance.companion_id = operation.companion_id
      where operation.id = ${restartPi.operation.id}::uuid
    `;
    expect(restartSnapshot).toMatchObject({
      targetRevision: publishedRevision,
      requiredRevision: installedBeforePublication!.requiredRevision,
      availableRevision: publishedRevision,
      appliedRevision: publishedRevision,
      updateErrorCode: null,
      updateErrorMessage: null,
    });
    const afterPiRestart = boxById(await simulatorState(), box.id);
    expect(afterPiRestart).toMatchObject({
      id: box.id,
      state: expect.stringMatching(/ready|idle|running/),
      daemon: { restartCount: beforePiRestart.restartCount + 1 },
    });
    expect(afterPiRestart?.daemon.invocationId).not.toBe(beforePiRestart.invocationId);

    await boxControl("/defaults", {
      method: "PUT",
      body: JSON.stringify({ deletePolls: 100 }),
    });
    const deletion = await apiJson<{ operation: { id: string } }>(
      `/v1/companions/${companionId}`,
      {
        method: "DELETE",
        headers: { "idempotency-key": randomUUID() },
      },
      202,
    );
    const acceptedDeletion = await waitFor("accepted Box deletion to be deferred", async () => {
      const state = await simulatorState();
      const providerDeletion = state.deletions.find((operation) => operation.targetId === box.id);
      const deleteRequests = state.requests.filter((request) =>
        request.surface === "box" && request.method === "DELETE"
          && request.path === `/boxes/${box.id}`);
      const polls = state.requests.filter((request) =>
        request.surface === "box" && request.method === "GET"
          && request.path.startsWith("/deletion-operations/"));
      if (!providerDeletion || deleteRequests.length !== 1 || polls.length < 1) return false;
      const [durable] = await databaseSql!<Array<{
        status: string;
        providerOperationId: string | null;
        leaseToken: string | null;
      }>>`
        select operation.status::text, operation.provider_operation_id as "providerOperationId",
          lease.claim_token::text as "leaseToken"
        from companion_operations operation
        join companion_runtime_leases lease
          on lease.org_id = operation.org_id and lease.companion_id = operation.companion_id
        where operation.id = ${deletion.operation.id}::uuid
      `;
      return durable?.status === "pending"
          && durable.providerOperationId === providerDeletion.id
          && durable.leaseToken === null
        ? providerDeletion
        : false;
    }, 30_000);

    // A different runtime takes over the same accepted provider operation. Completion is injected
    // only after the first runtime has released its slot; no executor is allowed to replay DELETE.
    await stopProcess(runtimeProcess, "SIGKILL");
    runtimeProcess = startRuntime(randomUUID());
    await waitForHttp(`${runtimeBase}/healthz`, runtimeProcess);
    await boxControl(`/deletion-operations/${acceptedDeletion.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "completed" }),
    });
    await waitFor("delete settlement audit", async () => {
      const [audit] = await databaseSql!<Array<{ operationId: string | null }>>`
        select metadata ->> 'operation_id' as "operationId"
        from audit_log
        where org_id = ${orgId}::uuid
          and action = 'companion.deleted'
          and target_type = 'companion'
          and target_id = ${companionId}
        order by created_at desc
        limit 1
      `;
      return audit?.operationId === deletion.operation.id;
    }, 30_000);
    await waitFor("permanent Box deletion", async () => {
      const state = await simulatorState();
      return !boxById(state, box.id)
        && state.deletions.some((operation) =>
          operation.targetId === box.id && operation.status === "completed");
    });
    const [root] = await databaseSql!<Array<{ count: number }>>`
      select count(*)::int as count from companions where id = ${companionId}::uuid
    `;
    expect(root?.count).toBe(0);
    const finalProviderState = await simulatorState();
    expect(finalProviderState.requests.filter((request) =>
      request.surface === "box" && request.method === "DELETE"
        && request.path === `/boxes/${box.id}`)).toHaveLength(1);
    assertProcessAlive(workerProcess);
  }, 180_000);
});
