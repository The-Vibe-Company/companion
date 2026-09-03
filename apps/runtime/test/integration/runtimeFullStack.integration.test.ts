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

interface BoxSimState {
  boxes: Array<{
    id: string;
    name?: string;
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
  faults: Array<{ id: string; point: string; visits: number; fired: number }>;
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
    + `signal=${String(processHandle.child.signalCode)}): ${processHandle.output().slice(-2_000)}`,
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
    select t.id::text, t.state::text as status, t.queue_sequence::int as "queueSequence",
      t.first_claimed_at as "startedAt", t.settled_at as "settledAt",
      t.outcome_code as "errorCode"
    from companion_v3_turns t
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

async function waitForV3Turn(turnId: string, status: string, timeoutMs = 30_000): Promise<void> {
  try {
    await waitFor(`Runtime v3 turn ${turnId} to become ${status}`, async () => {
      const [row] = await databaseSql!<Array<{ state: string; code: string | null }>>`
        select state::text, outcome_code as code
        from companion_v3_turns where id = ${turnId}::uuid
      `;
      if (!row) return false;
      if (["failed", "interrupted", "cancelled"].includes(row.state) && row.state !== status) {
        throw new TerminalWaitError(`Runtime v3 turn became ${row.state} (${row.code ?? "no code"})`);
      }
      return row.state === status;
    }, timeoutMs);
  } catch (error) {
    const [facts] = await databaseSql!<Array<{
      state: string;
      checkpoint: string;
      errorCode: string | null;
      errorMessage: string | null;
    }>>`
      select turn_row.state::text, instance.preparation_checkpoint as checkpoint,
        instance.preparation_error_code as "errorCode",
        instance.preparation_error_message as "errorMessage"
      from companion_v3_turns turn_row
      join companion_v3_instances instance using (org_id, companion_id)
      where turn_row.id = ${turnId}::uuid
    `;
    throw new Error(
      `${error instanceof Error ? error.message : "Runtime v3 wait failed"}; `
      + `facts=${JSON.stringify(facts ?? null)}; runtime=${runtimeProcess?.output().slice(-2_000) ?? "stopped"}`,
    );
  }
}

async function turnDiagnostic(turnId: string): Promise<string> {
  const row = await turnRow(turnId).catch(() => undefined);
  const [lease] = await databaseSql!<Array<{
    lane: string;
    claimEpoch: string;
    claimToken: string | null;
  }>>`
    select lane::text, claim_epoch::text as "claimEpoch", claim_token::text as "claimToken"
    from companion_v3_lane_leases where turn_id = ${turnId}::uuid
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
  return `turn=${JSON.stringify(row)} lease=${JSON.stringify(lease)} `
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

async function simulatorState(): Promise<BoxSimState> {
  const result = await boxControl<{ state: BoxSimState }>("/state");
  return result.state;
}

async function durableCompanionBoxId(): Promise<string | null> {
  const [instance] = await databaseSql!<Array<{ boxId: string | null }>>`
    select box_id as "boxId"
    from companion_v3_instances
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

  const [identity] = await databaseSql<Array<{ orgId: string }>>`
    select m.org_id::text as "orgId"
    from "user" u join memberships m on m.user_id = u.id
    where u.email = ${email}
    order by m.created_at limit 1
  `;
  if (!identity) throw new Error("seed did not create a tenant identity");
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

  const [gate] = await databaseSql<Array<{ epoch: string; enabled: boolean }>>`
    select gate_epoch::text as epoch, enabled from companion_runtime_control where id = 'runtime-v3'
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

describe("Runtime v3 real-process control plane", () => {
  it("accepts an immediate cold Turn and answers after an idempotent create fault", async () => {
    assertProcessAlive(apiProcess);
    assertProcessAlive(runtimeProcess);
    // The runtime image builder shares the provider account. Let its one startup create settle so
    // the global deterministic fault below can only belong to this Companion generation.
    await waitFor("runtime image builder settlement", async () => {
      const [image] = await databaseSql!<Array<{ status: string }>>`
        select status::text from companion_images order by requested_at desc limit 1
      `;
      return image && ["ready", "failed"].includes(image.status);
    }, 60_000);
    const before = await simulatorState();
    const injected = await boxControl<{ fault: { id: string } }>("/faults", {
      method: "POST",
      body: JSON.stringify({
        point: "box.create.idempotent.after",
        action: { kind: "disconnect" },
      }),
    });

    const created = await apiJson<{ companion: { id: string } }>("/v1/companions", {
      method: "POST",
      body: JSON.stringify({
        name: "Runtime v3 cold acceptance",
        persona: "Reply concisely.",
        provider_id: "anthropic",
        model_id: "claude-sonnet-4-6",
      }),
    }, 201);
    const messageId = randomUUID();
    const accepted = await apiJson<{ turn: { id: string; status: string } }>(
      `/v1/companions/${created.companion.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: messageId,
          client_surface: "web",
          content: "Return one deterministic cold Runtime v3 answer.",
        }),
      },
      202,
    );
    expect(accepted.turn.status).toBe("queued");

    await waitForV3Turn(accepted.turn.id, "succeeded", 60_000);
    const thread = await apiJson<{ thread: {
      active_turn: unknown;
      queued_count: number;
      entries: Array<{ role: string; turn_id: string | null }>;
    } }>(`/v1/companions/${created.companion.id}/thread`, { method: "GET" }, 200);
    expect(thread.thread.active_turn).toBeNull();
    expect(thread.thread.queued_count).toBe(0);
    expect(thread.thread.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "Simulated reply." }),
    ]));

    const [durable] = await databaseSql!<Array<{
      preparationClaimEpoch: number;
      firstClaimedAt: Date;
      boxReadyAt: Date;
      turnCount: number;
    }>>`
      select instance.preparation_claim_epoch::integer as "preparationClaimEpoch",
        turn_row.first_claimed_at as "firstClaimedAt",
        instance.box_ready_at as "boxReadyAt",
        (select count(*)::integer from companion_v3_turns sibling
          where sibling.org_id=instance.org_id and sibling.companion_id=instance.companion_id)
          as "turnCount"
      from companion_v3_instances instance
      join companion_v3_turns turn_row using (org_id, companion_id)
      where instance.companion_id = ${created.companion.id}::uuid
        and turn_row.id = ${accepted.turn.id}::uuid
    `;
    expect(durable).toMatchObject({ turnCount: 1 });
    expect(durable!.preparationClaimEpoch).toBeGreaterThanOrEqual(2);
    expect(durable!.firstClaimedAt.getTime()).toBeLessThanOrEqual(durable!.boxReadyAt.getTime());

    const [recoveryProof] = await databaseSql!<Array<{
      opened: number;
      recovered: number;
      recoveredBeforeSettlement: boolean;
    }>>`
      select
        count(*) filter (where signal.kind = 'opened')::integer as opened,
        count(*) filter (where signal.kind = 'recovered')::integer as recovered,
        bool_or(signal.kind = 'recovered' and signal.created_at <= turn_row.settled_at)
          as "recoveredBeforeSettlement"
      from companion_v3_external_incident_signals signal
      join companion_v3_turns turn_row
        on turn_row.org_id = signal.org_id and turn_row.companion_id = signal.companion_id
      where signal.companion_id = ${created.companion.id}::uuid
        and signal.failure_class = 'box'
        and turn_row.id = ${accepted.turn.id}::uuid
    `;
    expect(recoveryProof).toEqual({ opened: 1, recovered: 1, recoveredBeforeSettlement: true });

    const after = await simulatorState();
    const firedFault = after.faults.find((fault) => fault.id === injected.fault.id);
    expect(firedFault).toMatchObject({
      point: "box.create.idempotent.after",
      fired: 1,
    });
    if (!firedFault) throw new Error("the scoped create fault was not retained by the simulator");
    expect(firedFault.visits).toBeGreaterThanOrEqual(2);
    const oldBoxIds = new Set(before.boxes.map((box) => box.id));
    const createRequestsBefore = before.requests.filter((request) =>
      request.surface === "box" && request.method === "POST" && request.path === "/boxes").length;
    const createRequestsAfter = after.requests.filter((request) =>
      request.surface === "box" && request.method === "POST" && request.path === "/boxes").length;
    expect(createRequestsAfter - createRequestsBefore).toBeGreaterThan(1);
    expect(after.boxes.filter((box) =>
      !oldBoxIds.has(box.id)
      && box.name === `Companion ${created.companion.id} g1`)).toHaveLength(1);
  }, 90_000);

  it("survives API death and runtime takeover while preserving ordered chat, wake, and delete", async () => {
    assertProcessAlive(apiProcess);
    assertProcessAlive(workerProcess);
    assertProcessAlive(runtimeProcess);
    expect(apiProcess.environment.COMPANION_BOX_API_KEY).toBeUndefined();
    expect(workerProcess.environment.COMPANION_BOX_API_KEY).toBeUndefined();

    const seeded = await apiJson<{ companion: { id: string } }>("/v1/companions", {
      method: "POST",
      body: JSON.stringify({
        name: "Runtime full stack",
        persona: "Reply concisely.",
        provider_id: "anthropic",
        model_id: "claude-sonnet-4-6",
      }),
    }, 201);
    companionId = seeded.companion.id;

    const acceptedAt = Date.now();
    const cold = await apiJson<{ turn: { id: string; status: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: randomUUID(),
          client_surface: "web",
          content: "Cold-start this v3 Companion and answer once.",
        }),
      },
      202,
    );
    expect(cold.turn.status).toBe("queued");
    expect(Date.now() - acceptedAt).toBeLessThan(1_000);

    await stopProcess(apiProcess, "SIGKILL");
    apiProcess = undefined;
    const coldTerminal = await waitForTurn(cold.turn.id, "succeeded", 60_000);
    expect(coldTerminal.startedAt).not.toBeNull();
    expect(coldTerminal.errorCode).toBeNull();

    const boxId = await durableCompanionBoxId();
    if (!boxId) throw new Error("v3 cold chat did not durably checkpoint a Box");
    expect(boxById(await simulatorState(), boxId)).toMatchObject({
      id: boxId,
      state: expect.stringMatching(/ready|idle|running/),
      daemon: { status: "active" },
    });

    apiProcess = startApi();
    await waitForHttp(`${apiBase}/health`, apiProcess);
    const concurrent = await Promise.all([
      apiJson<{ turn: { id: string; queue_sequence: number } }>(
        `/v1/companions/${companionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            client_message_id: randomUUID(), client_surface: "web", content: "Ordered v3 message A.",
          }),
        }, 202),
      apiJson<{ turn: { id: string; queue_sequence: number } }>(
        `/v1/companions/${companionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            client_message_id: randomUUID(), client_surface: "web", content: "Ordered v3 message B.",
          }),
        }, 202),
    ]);
    const ordered = [...concurrent].sort((left, right) =>
      left.turn.queue_sequence - right.turn.queue_sequence);

    await stopProcess(runtimeProcess, "SIGKILL");
    runtimeProcess = startRuntime(randomUUID());
    await waitForHttp(`${runtimeBase}/healthz`, runtimeProcess);
    const first = await waitForTurn(ordered[0]!.turn.id, "succeeded", 45_000);
    const second = await waitForTurn(ordered[1]!.turn.id, "succeeded", 45_000);
    expect(first.queueSequence).toBeLessThan(second.queueSequence);
    expect(first.settledAt!.getTime()).toBeLessThanOrEqual(second.startedAt!.getTime());

    await apiJson<{ lifecycle: { intent: string; revision: string } }>(
      `/v1/companions/${companionId}/runtime/archive`,
      { method: "POST", headers: { "idempotency-key": randomUUID() }, body: "{}" },
      202,
    );
    await waitFor("v3 Box archive", async () => {
      const [instance] = await databaseSql!<Array<{ state: string }>>`
        select lifecycle_state::text as state from companion_v3_instances
        where companion_id = ${companionId}::uuid
      `;
      return instance?.state === "archived"
        && boxById(await simulatorState(), boxId)?.state === "archived";
    }, 30_000);

    const wake = await apiJson<{ turn: { id: string } }>(
      `/v1/companions/${companionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          client_message_id: randomUUID(), client_surface: "web", content: "Wake and answer on the same Box.",
        }),
      }, 202,
    );
    await waitForTurn(wake.turn.id, "succeeded", 45_000);
    expect(await durableCompanionBoxId()).toBe(boxId);
    expect(boxById(await simulatorState(), boxId)?.state).toMatch(/ready|idle|running/);

    await boxControl("/defaults", {
      method: "PUT",
      body: JSON.stringify({ deletePolls: 100 }),
    });
    await apiJson<{ lifecycle: { intent: string; revision: string } }>(
      `/v1/companions/${companionId}`,
      { method: "DELETE", headers: { "idempotency-key": randomUUID() } },
      202,
    );
    const providerDeletion = await waitFor("durable v3 deletion dispatch", async () => {
      const state = await simulatorState();
      const provider = state.deletions.find((candidate) => candidate.targetId === boxId);
      const [instance] = await databaseSql!<Array<{
        state: string;
        providerOperationId: string | null;
      }>>`
        select lifecycle_state::text as state,
          delete_provider_operation_id as "providerOperationId"
        from companion_v3_instances where companion_id = ${companionId}::uuid
      `;
      return provider && instance?.state === "waiting_deleted"
          && instance.providerOperationId === provider.id
        ? provider
        : false;
    }, 30_000);

    await stopProcess(runtimeProcess, "SIGKILL");
    runtimeProcess = startRuntime(randomUUID());
    await waitForHttp(`${runtimeBase}/healthz`, runtimeProcess);
    await boxControl(`/deletion-operations/${providerDeletion.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "completed" }),
    });
    await waitFor("v3 permanent deletion", async () => {
      const [remaining] = await databaseSql!<Array<{ count: number }>>`
        select count(*)::integer as count from companions where id = ${companionId}::uuid
      `;
      return remaining?.count === 0 && !boxById(await simulatorState(), boxId);
    }, 30_000);
    const finalState = await simulatorState();
    expect(finalState.requests.filter((request) =>
      request.surface === "box" && request.method === "DELETE"
        && request.path === `/boxes/${boxId}`)).toHaveLength(1);
    assertProcessAlive(workerProcess);
  }, 180_000);
});
