import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { startCompanionMcpGateway } from "./companionMcpGateway";

import {
  COMPANION_PI_BROKER_MAX_LINE_BYTES,
  CompanionPiDispatchLedger,
  CompanionPiBroker,
  SegmentedCompanionPiJournal,
  StrictLfJsonlDecoder,
  startCompanionPiBrokerSocket,
  type CompanionPiRpcTransport,
  type PiJsonObject,
} from "./companionPiBrokerCore";

const root = requiredAbsolutePath("COMPANION_PI_ROOT");
const piBin = requiredAbsolutePath("COMPANION_PI_BIN");
const invocationId = requiredOpaqueId(
  process.env.COMPANION_PI_INVOCATION_ID ?? process.env.INVOCATION_ID,
  "COMPANION_PI_INVOCATION_ID",
);
const routineRunId = optionalRoutineRunId();
const validationOnly = optionalBooleanFlag("COMPANION_PI_VALIDATION_ONLY");
if (validationOnly && routineRunId === null) {
  throw new Error("COMPANION_PI_VALIDATION_ONLY requires an isolated routine run");
}
const socketPath = optionalAbsolutePath("COMPANION_PI_SOCKET_PATH")
  ?? join(root, "state", "pi-broker.sock");
const journalPath = optionalAbsolutePath("COMPANION_PI_JOURNAL_PATH")
  ?? join(root, "events");
const dispatchLedgerPath = optionalAbsolutePath("COMPANION_PI_DISPATCH_LEDGER_PATH")
  ?? join(root, "state", "dispatch-ledger.json");
// The main layout keeps outbox beside `.companion/runtime`; an isolated routine owns an outbox
// inside its run root so it can never consume or clear a main-session file.
const outboxPath = routineRunId === null
  ? resolve(root, "..", "..", "outbox")
  : join(root, "outbox");
const layoutMarker = process.env.PI_BROKER_LAYOUT_MARKER;
const maxLineBytes = optionalPositiveInteger("COMPANION_PI_MAX_LINE_BYTES")
  ?? COMPANION_PI_BROKER_MAX_LINE_BYTES;
const segmentBytes = optionalPositiveInteger("COMPANION_PI_SEGMENT_BYTES");
const rpcTimeoutMs = optionalPositiveInteger("COMPANION_PI_RPC_TIMEOUT_MS") ?? 8_000;
const PI_STARTUP_READY_TIMEOUT_MS = 150_000;
const PI_STARTUP_READY_RETRY_MS = 250;
const piCommandIdentitySchema = z.object({ id: z.string(), type: z.string() });
const piResponseIdentitySchema = z.object({ type: z.literal("response"), id: z.string() });
const processErrorSchema = z.object({
  code: z.string().optional(),
  syscall: z.string().optional(),
});

interface CompanionPiJournalOptions {
  directory: string;
  segmentBytes?: number;
}

interface CompanionPiBrokerOptions {
  invocationId: string;
  transport: CompanionPiRpcTransport;
  journal: SegmentedCompanionPiJournal;
  dispatchLedger: CompanionPiDispatchLedger;
  outboxPath: string;
  layoutMarker?: string;
}

class SpawnedPiTransport implements CompanionPiRpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, {
    command: string;
    timeout: NodeJS.Timeout;
    resolve: (record: PiJsonObject) => void;
    reject: (error: Error) => void;
  }>();
  #onEvent: (record: PiJsonObject) => void = () => undefined;
  #onExit: (exit: { code: number | null; signal: string | null }) => void = () => undefined;
  #onFault: (fault: "malformed" | "oversized" | "unterminated") => void = () => undefined;
  #lastExit: { code: number | null; signal: string | null } | null = null;
  readonly ready: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const decoder = new StrictLfJsonlDecoder({
      maxLineBytes,
      onRecord: (record) => this.#acceptRecord(record),
      onFault: (fault) => this.#onFault(fault),
    });
    this.#child = spawn(piBin, piArguments(root, routineRunId !== null, validationOnly), {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Drain but never retain/log raw Pi stderr: it may contain provider diagnostics or secrets.
    this.#child.stderr.resume();
    this.#child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    this.#child.stdout.on("end", () => decoder.finish());
    this.#child.stdin.on("error", () => this.#rejectPending());
    this.#child.on("error", () => this.#rejectPending());
    this.exited = new Promise((resolveExit) => {
      this.#child.once("close", (code, signal) => {
        const exit = { code, signal };
        this.#lastExit = exit;
        this.#rejectPending();
        this.#onExit(exit);
        resolveExit(exit);
      });
    });
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const onSpawn = (): void => {
        this.#child.off("error", onError);
        resolveReady();
      };
      const onError = (): void => {
        this.#child.off("spawn", onSpawn);
        rejectReady(new Error("Pi process could not start"));
      };
      this.#child.once("spawn", onSpawn);
      this.#child.once("error", onError);
    });
  }

  bind(input: {
    onEvent(record: PiJsonObject): void;
    onExit(exit: { code: number | null; signal: string | null }): void;
    onFault(fault: "malformed" | "oversized" | "unterminated"): void;
  }): void {
    this.#onEvent = input.onEvent;
    this.#onExit = input.onExit;
    this.#onFault = input.onFault;
    if (this.#lastExit) this.#onExit(this.#lastExit);
  }

  request(command: PiJsonObject): Promise<PiJsonObject> {
    const identity = piCommandIdentitySchema.safeParse(command);
    const id = identity.success ? identity.data.id : "";
    const commandName = identity.success ? identity.data.type : "invalid";
    if (!id || this.#pending.has(id)) return Promise.reject(new Error("Pi command id is invalid"));
    return new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectResponse(new Error("Pi response deadline elapsed"));
      }, rpcTimeoutMs);
      this.#pending.set(id, {
        command: commandName,
        timeout,
        resolve: resolveResponse,
        reject: rejectResponse,
      });
      this.#write(command).catch(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(new Error("Pi command write failed"));
      });
    });
  }

  send(command: PiJsonObject): Promise<void> {
    return this.#write(command);
  }

  stop(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
  }

  async terminate(): Promise<void> {
    this.stop();
    let timeout: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!exited && this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await this.exited;
    }
  }

  #write(command: PiJsonObject): Promise<void> {
    return new Promise((resolveWrite, rejectWrite) => {
      this.#child.stdin.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
        if (error) rejectWrite(new Error("Pi command write failed"));
        else resolveWrite();
      });
    });
  }

  #acceptRecord(record: PiJsonObject): void {
    const identity = piResponseIdentitySchema.safeParse(record);
    if (!identity.success) {
      this.#onEvent(record);
      return;
    }
    const pending = this.#pending.get(identity.data.id);
    if (!pending || record.command !== pending.command) {
      this.#onEvent(record);
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(identity.data.id);
    pending.resolve(record);
  }

  #rejectPending(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete(id);
      pending.reject(new Error("Pi process is unavailable"));
    }
  }
}

async function main(): Promise<void> {
  const journalOptions: CompanionPiJournalOptions = { directory: journalPath };
  if (segmentBytes !== undefined) journalOptions.segmentBytes = segmentBytes;
  const journal = new SegmentedCompanionPiJournal(journalOptions);
  const dispatchLedger = new CompanionPiDispatchLedger({
    path: dispatchLedgerPath,
    invocationId,
  });
  const gatewayToken = process.env.COMPANION_MCP_BROKER_TOKEN ?? "";
  const controlToken = process.env.COMPANION_CONTROL_TOKEN ?? "";
  const gateway = validationOnly
    ? null
    : await startCompanionMcpGateway({
        configPath: join(root, "state", "mcp-gateway.json"),
        apiUrl: process.env.COMPANION_API_URL ?? "",
        brokerToken: gatewayToken,
        controlToken,
      });
  const piEnvironment = { ...process.env };
  delete piEnvironment.COMPANION_MCP_BROKER_TOKEN;
  delete piEnvironment.COMPANION_CONTROL_TOKEN;
  if (gateway) piEnvironment.COMPANION_MCP_GATEWAY_ORIGIN = gateway.origin;
  const transport = new SpawnedPiTransport(piEnvironment);
  const brokerOptions: CompanionPiBrokerOptions = {
    invocationId,
    transport,
    journal,
    dispatchLedger,
    outboxPath,
  };
  if (layoutMarker) brokerOptions.layoutMarker = layoutMarker;
  const broker = new CompanionPiBroker(brokerOptions);
  transport.bind({
    onEvent(record) {
      if (record.type === "response") {
        journal.recordFault("orphanResponses");
        return;
      }
      broker.acceptPiRecord(record);
    },
    onExit: (exit) => broker.acceptPiProcessExit(exit),
    onFault(fault) {
      journal.recordFault(
        fault === "malformed"
          ? "malformedLines"
          : fault === "oversized"
            ? "oversizedLines"
            : "unterminatedLines",
      );
    },
  });
  let server;
  try {
    await transport.ready;
    await awaitPiState(broker, transport.exited);
    server = await startCompanionPiBrokerSocket({ broker, socketPath });
  } catch (error) {
    // A spawned Pi and its pipes would otherwise keep this failed systemd invocation alive forever.
    await transport.terminate();
    await gateway?.close();
    throw error;
  }
  let stopping = false;
  const removeSocket = (): void => {
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // systemd will replace an owned stale socket on the next invocation.
    }
  };
  const stop = (): void => {
    stopping = true;
    server.close();
    void transport.terminate();
    void gateway?.close();
    removeSocket();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  void transport.exited.then(() => {
    removeSocket();
    if (stopping) return;
    server.close();
    void gateway?.close();
    // A broker without its Pi child must fail so systemd restarts the whole control boundary.
    process.exitCode = 1;
  });
}

async function awaitPiState(
  broker: CompanionPiBroker,
  exited: Promise<{ code: number | null; signal: string | null }>,
): Promise<void> {
  const deadline = Date.now() + PI_STARTUP_READY_TIMEOUT_MS;
  const exitedBeforeReady = exited.then(() => {
    const error = new Error("Pi process exited before its state became ready");
    error.name = "PiProcessExitedBeforeReadyError";
    throw error;
  });
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const response = await Promise.race([
      broker.command({
        id: `startup:${invocationId}:${attempt}`,
        type: "get_state",
      }),
      exitedBeforeReady,
    ]);
    if (response.success === true) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error("Pi state did not become ready");
      error.name = "PiStateReadinessError";
      throw error;
    }
    await Promise.race([
      new Promise((resolveReady) => {
        setTimeout(resolveReady, Math.min(PI_STARTUP_READY_RETRY_MS, remaining));
      }),
      exitedBeforeReady,
    ]);
  }
}

function piArguments(
  runtimeRoot: string,
  isolatedRoutine: boolean,
  validationOnly = false,
): string[] {
  // The main daemon resumes the Companion's one ongoing conversation. A routine root is a new,
  // disposable session by definition: passing --continue there could select an older session in
  // that run directory after takeover, and would make the routine depend on main-session history.
  const args = ["--mode", "rpc", "--session-dir", join(runtimeRoot, "sessions")];
  if (!isolatedRoutine) args.push("--continue");
  const model = readOptionalText(join(runtimeRoot, "state", "model.txt"));
  if (model) args.push("--model", model);
  args.push("--no-skills");
  const skills = join(runtimeRoot, "skills");
  if (!validationOnly && containsSkillFile(skills)) args.push("--skill", skills);
  if (validationOnly) {
    args.push(
      "--no-extensions",
      "--extension",
      join(runtimeRoot, "pi", "extensions", "companion-routine-surface.ts"),
      "--tools",
      "surface_to_main",
      "--no-context-files",
    );
  }
  const instructions = readOptionalText(join(runtimeRoot, "state", "instructions.txt"));
  if (instructions) args.push("--append-system-prompt", instructions);
  return args;
}

function containsSkillFile(directory: string): boolean {
  if (!existsSync(directory)) return false;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === "SKILL.md") return true;
      if (entry.isDirectory()) pending.push(join(current, entry.name));
    }
  }
  return false;
}

function readOptionalText(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value || null;
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`${name} must be absolute`);
  return absolute;
}

function optionalAbsolutePath(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`${name} must be absolute`);
  return absolute;
}

function requiredOpaqueId(value: string | undefined, name: string): string {
  if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalRoutineRunId(): string | null {
  const value = process.env.COMPANION_PI_ROUTINE_RUN_ID?.trim();
  if (!value) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("COMPANION_PI_ROUTINE_RUN_ID is invalid");
  }
  return value.toLowerCase();
}

function optionalPositiveInteger(name: string): number | undefined {
  const text = process.env[name]?.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  return value;
}

function optionalBooleanFlag(name: string): boolean {
  const value = process.env[name]?.trim();
  if (!value) return false;
  if (value !== "1") throw new Error(`${name} is invalid`);
  return true;
}

void main().catch((error) => {
  const parsedError = processErrorSchema.safeParse(error);
  const code = parsedError.success ? parsedError.data.code : undefined;
  const syscall = parsedError.success ? parsedError.data.syscall : undefined;
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
  const reason = code !== undefined && /^[A-Z0-9_]{1,32}$/.test(code)
    ? syscall !== undefined && /^[a-z0-9_]{1,32}$/.test(syscall) ? `${code} ${syscall}` : code
    : errorName;
  // Never log the raw error: it may contain a Box path or provider payload.
  process.stderr.write(`companion-pi-broker: startup failed (${reason})\n`);
  process.exitCode = 1;
});
