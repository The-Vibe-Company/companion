import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { sendCompanionPiBrokerCommand } from "./companionPiBrokerCore";
import {
  COMPANION_PI_BROKER_SOCKET_PATH,
  COMPANION_PI_BROKER_SOURCE,
} from "./companionPiBroker";

const processes: ChildProcessWithoutNullStreams[] = [];
const processExits = new WeakMap<ChildProcessWithoutNullStreams, Promise<ProcessExit>>();
const directories: string[] = [];
const execFileAsync = promisify(execFile);
const brokerStateSchema = z.object({
  invocationId: z.string(),
  activeAttemptId: z.string().nullable(),
  tailCursor: z.number(),
  counters: z.object({
    malformedLines: z.number(),
    oversizedLines: z.number(),
    unknownEvents: z.number(),
  }),
});
const stringArraySchema = z.array(z.string());
const journalKindSchema = z.object({ kind: z.string() });
const errnoSchema = z.object({ code: z.string() });

afterEach(cleanupTrackedResources);

async function cleanupTrackedResources(): Promise<void> {
  await Promise.all(processes.splice(0).map(stopBrokerProcess));
  for (const directory of directories.splice(0)) {
    await rm(directory, {
      recursive: true,
      force: true,
      // Linux can transiently report ENOTEMPTY while the last descendant releases the directory.
      maxRetries: 20,
      retryDelay: 25,
    });
  }
}

describe("COMPANION_PI_BROKER_SOURCE", () => {
  it("is the byte-exact deterministic bundle and retains only Node built-in imports", async () => {
    const generator = fileURLToPath(new URL("../scripts/generate-companion-pi-broker.mjs", import.meta.url));
    await expect(execFileAsync(process.execPath, [generator, "--check"])).resolves.toMatchObject({
      stderr: "",
    });
    const imports = [
      ...[...COMPANION_PI_BROKER_SOURCE.matchAll(/\bfrom\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
      ...[...COMPANION_PI_BROKER_SOURCE.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
      ...[...COMPANION_PI_BROKER_SOURCE.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
    ];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
  });

  it("runs the staged ESM against a real strict-LF Pi subprocess", async () => {
    const home = temporaryDirectory("pi-broker-source-");
    const runtimeRoot = join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "fake-pi.mjs");
    const capturePath = join(home, "pi-commands.ndjson");
    const piPidPath = join(home, "pi.pid");
    const piArgvPath = join(home, "pi.argv.json");
    // macOS has a short Unix-socket path limit; the production relative layout is covered by the
    // adapter tests, while this subprocess test only needs a private socket in its temp directory.
    const socketPath = join(home, "broker.sock");
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "sessions"), { recursive: true, mode: 0o700 });
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, fakePiSource(), { mode: 0o700 });
    chmodSync(piPath, 0o700);

    const broker = trackBrokerProcess(spawn(process.execPath, [brokerPath], {
      detached: true,
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "invocation-source-1",
        COMPANION_PI_SOCKET_PATH: socketPath,
        COMPANION_PI_MAX_LINE_BYTES: "256",
        COMPANION_PI_SEGMENT_BYTES: "400",
        FAKE_PI_CAPTURE_PATH: capturePath,
        FAKE_PI_PID_PATH: piPidPath,
        FAKE_PI_ARGV_PATH: piArgvPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }));
    let startupStderr = "";
    broker.stderr.on("data", (chunk: Buffer) => {
      startupStderr += chunk.toString("utf8");
    });
    await waitFor(() => existsSync(socketPath)).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : "startup failed"}: ${startupStderr}`);
    });

    // Without --continue, Pi's own CLI always starts a brand-new session even when a Companion
    // already has one on disk in --session-dir, silently discarding its conversation on every
    // broker (re)start. Assert the exact argv the broker spawns Pi with so a future regeneration of
    // the bundled broker source cannot lose this flag unnoticed.
    expect(await waitForStringArrayJsonFile(piArgvPath)).toEqual([
      "--mode", "rpc", "--session-dir", join(runtimeRoot, "sessions"), "--continue", "--no-skills",
    ]);

    const prompt = await sendCompanionPiBrokerCommand({
      socketPath,
      command: {
        id: "control-source-prompt",
        type: "prompt",
        attemptId: "attempt-source-1",
        message: "Run through the standalone broker",
        requiredInput: ["text"],
        clearOutbox: true,
      },
    });
    expect(prompt).toMatchObject({
      id: "control-source-prompt",
      success: true,
      data: { attemptId: "attempt-source-1", piAcknowledged: true },
    });

    let brokerState: z.infer<typeof brokerStateSchema> | null = null;
    await waitFor(async () => {
      const response = await sendCompanionPiBrokerCommand({
        socketPath,
        command: { id: "control-source-state", type: "broker_state" },
      });
      brokerState = brokerStateSchema.parse(response.data);
      return brokerState.activeAttemptId === null && brokerState.tailCursor >= 3;
    });
    expect(brokerState).toMatchObject({
      invocationId: "invocation-source-1",
      activeAttemptId: null,
      counters: {
        malformedLines: 1,
        oversizedLines: 1,
        unknownEvents: 1,
      },
    });

    const read = await sendCompanionPiBrokerCommand({
      socketPath,
      command: { id: "control-source-read", type: "read_events", after: 0, limit: 20 },
    });
    expect(read).toMatchObject({
      success: true,
      data: {
        events: [
          { sequence: 1, attemptId: "attempt-source-1", event: { type: "agent_start" } },
          { sequence: 2, attemptId: "attempt-source-1", event: { type: "message_end" } },
          { sequence: 3, attemptId: "attempt-source-1", event: { type: "agent_settled" } },
        ],
      },
    });
    const ack = await sendCompanionPiBrokerCommand({
      socketPath,
      command: { id: "control-source-ack", type: "ack_events", through: 3 },
    });
    expect(ack).toMatchObject({ success: true, data: { acknowledgedCursor: 3 } });

    const commands = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.map((command) => command.type)).toEqual(["get_state", "prompt"]);
    expect(commands[1]).toMatchObject({ streamingBehavior: "steer" });
    const piPid = Number(readFileSync(piPidPath, "utf8"));
    expect(Number.isSafeInteger(piPid)).toBe(true);
    process.kill(piPid, "SIGKILL");
    const brokerExit = await waitForExit(broker);
    expect(brokerExit).toMatchObject({ code: 1, signal: null });
    expect(existsSync(socketPath)).toBe(false);
    const journalKinds = readJournalKinds(join(runtimeRoot, "events"));
    expect(journalKinds).not.toContain("pi_process_exit");
    expect(JSON.parse(readFileSync(join(runtimeRoot, "events", "counters.json"), "utf8")))
      .toMatchObject({ unboundEvents: 1 });
  }, 10_000);

  it("allows only surface_to_main in an untrusted trigger validation process", async () => {
    const home = temporaryDirectory("pi-broker-trigger-validation-");
    const runtimeRoot = join(home, ".companion", "runtime", "routines", "11111111-1111-4111-8111-111111111111");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "fake-pi.mjs");
    const piArgvPath = join(home, "pi.argv.json");
    const socketPath = join(home, "broker.sock");
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "pi", "extensions"), { recursive: true, mode: 0o700 });
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, fakePiSource(), { mode: 0o700 });

    trackBrokerProcess(spawn(process.execPath, [brokerPath], {
      detached: true,
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "routine-validation-invocation",
        COMPANION_PI_ROUTINE_RUN_ID: "11111111-1111-4111-8111-111111111111",
        COMPANION_PI_VALIDATION_ONLY: "1",
        COMPANION_PI_SOCKET_PATH: socketPath,
        FAKE_PI_CAPTURE_PATH: join(home, "pi-commands.ndjson"),
        FAKE_PI_PID_PATH: join(home, "pi.pid"),
        FAKE_PI_ARGV_PATH: piArgvPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }));
    await waitFor(() => existsSync(socketPath));

    expect(await waitForStringArrayJsonFile(piArgvPath)).toEqual([
      "--mode", "rpc",
      "--session-dir", join(runtimeRoot, "sessions"),
      "--no-skills",
      "--no-extensions",
      "--extension", join(runtimeRoot, "pi", "extensions", "companion-routine-surface.ts"),
      "--tools", "surface_to_main",
      "--no-context-files",
    ]);
  }, 10_000);

  it("terminates a spawned Pi when the command socket cannot start", async () => {
    const home = temporaryDirectory("pi-broker-start-failure-");
    const runtimeRoot = join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "idle-pi.mjs");
    const invalidSocketPath = join(runtimeRoot, "state", "not-a-socket");
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    writeFileSync(invalidSocketPath, "regular file", { mode: 0o600 });
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, fakePiSource(), { mode: 0o700 });

    const broker = trackBrokerProcess(spawn(process.execPath, [brokerPath], {
      detached: true,
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "invocation-start-failure",
        COMPANION_PI_SOCKET_PATH: invalidSocketPath,
        FAKE_PI_CAPTURE_PATH: join(home, "pi-commands.ndjson"),
        FAKE_PI_PID_PATH: join(home, "pi.pid"),
        FAKE_PI_ARGV_PATH: join(home, "pi.argv.json"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }));
    let stderr = "";
    broker.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await expect(waitForExitWithin(broker, 5_000)).resolves.toEqual({ code: 1, signal: null });
    expect(stderr).toBe("companion-pi-broker: startup failed (Error)\n");
  });

  it("fails immediately when Pi exits before its initial state is ready", async () => {
    const home = temporaryDirectory("pi-broker-early-exit-");
    const runtimeRoot = join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "exiting-pi.mjs");
    const socketPath = join(home, "broker.sock");
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, "#!/usr/bin/env node\nprocess.exit(23);\n", { mode: 0o700 });

    const broker = trackBrokerProcess(spawn(process.execPath, [brokerPath], {
      detached: true,
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "invocation-early-exit",
        COMPANION_PI_SOCKET_PATH: socketPath,
        COMPANION_PI_RPC_TIMEOUT_MS: "10000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }));
    let stderr = "";
    broker.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await expect(waitForExitWithin(broker, 2_000)).resolves.toEqual({ code: 1, signal: null });
    expect(stderr).toBe(
      "companion-pi-broker: startup failed (PiProcessExitedBeforeReadyError)\n",
    );
    expect(existsSync(socketPath)).toBe(false);
  });
});

describe("Pi broker --append-system-prompt", () => {
  async function spawnedPiArgv(
    instructions: string | null,
    routineRunId: string | null = null,
  ): Promise<string[]> {
    const home = temporaryDirectory("pi-broker-argv-");
    const runtimeRoot = routineRunId
      ? join(home, ".companion", "runtime", "routines", routineRunId)
      : join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "fake-pi.mjs");
    const piArgvPath = join(home, "pi.argv.json");
    const socketPath = join(home, COMPANION_PI_BROKER_SOCKET_PATH);
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "sessions"), { recursive: true, mode: 0o700 });
    if (instructions !== null) {
      writeFileSync(join(runtimeRoot, "state", "instructions.txt"), instructions, { mode: 0o600 });
    }
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, fakePiSource(), { mode: 0o700 });
    chmodSync(piPath, 0o700);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      COMPANION_PI_ROOT: runtimeRoot,
      COMPANION_PI_BIN: piPath,
      COMPANION_PI_INVOCATION_ID: "invocation-argv",
      COMPANION_PI_SOCKET_PATH: socketPath,
      FAKE_PI_CAPTURE_PATH: join(home, "unused.ndjson"),
      FAKE_PI_PID_PATH: join(home, "pi.pid"),
      FAKE_PI_ARGV_PATH: piArgvPath,
    };
    if (routineRunId) environment.COMPANION_PI_ROUTINE_RUN_ID = routineRunId;
    trackBrokerProcess(spawn(process.execPath, [brokerPath], {
      detached: true,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    return waitForStringArrayJsonFile(piArgvPath);
  }

  it("passes a present instructions file as --append-system-prompt", async () => {
    const argv = await spawnedPiArgv("Be terse.\n");
    const flag = argv.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThan(-1);
    expect(argv[flag + 1]).toBe("Be terse.");
  });

  it("omits --append-system-prompt when instructions.txt is absent", async () => {
    expect(await spawnedPiArgv(null)).not.toContain("--append-system-prompt");
  });

  it("omits --append-system-prompt when instructions.txt is whitespace-only", async () => {
    expect(await spawnedPiArgv("   \n")).not.toContain("--append-system-prompt");
  });

  it("starts a routine root as a fresh Pi session without --continue", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const argv = await spawnedPiArgv(null, runId);
    expect(argv).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      expect.stringContaining(`/runtime/routines/${runId}/sessions`),
      "--no-skills",
    ]);
    expect(argv).not.toContain("--continue");
  });
});

describe("Pi broker subprocess teardown", () => {
  it("waits for inherited stdio to close after a broker process exits", async () => {
    const broker = trackBrokerProcess(spawn(process.execPath, [
      "-e",
      `const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 150)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
grandchild.unref();`,
    ], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    await waitFor(() => broker.exitCode !== null || broker.signalCode !== null);

    expect(broker.exitCode).toBe(0);
    expect(broker.stdout.closed).toBe(false);
    await stopBrokerProcess(broker);
    expect(broker.stdout.closed).toBe(true);
  });

  it("bounds cleanup when a descendant keeps inherited stdio open", async () => {
    const home = temporaryDirectory("pi-broker-close-timeout-");
    const grandchildPidPath = join(home, "grandchild.pid");
    const broker = trackBrokerProcess(spawn(process.execPath, [
      "-e",
      `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(process.argv[1], String(grandchild.pid));
grandchild.unref();`,
      grandchildPidPath,
    ], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    await waitFor(() => existsSync(grandchildPidPath));
    const grandchildPid = z.coerce.number().int().positive()
      .parse(readFileSync(grandchildPidPath, "utf8"));
    await waitFor(() => broker.exitCode !== null || broker.signalCode !== null);
    expect(broker.stdout.closed).toBe(false);

    const teardown = stopBrokerProcess(broker, 25);
    try {
      const outcome = await Promise.race([
        teardown.then(() => "closed" as const),
        new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 500)),
      ]);
      expect(outcome).toBe("closed");
      expect(broker.stdout.destroyed).toBe(true);
    } finally {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // The fixture may have already exited after closing its inherited streams.
      }
      await teardown;
    }
  });

  it("stops repeated descendant writers before removing their temp directories", async () => {
    const homes: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const home = temporaryDirectory("pi-broker-repeated-cleanup-");
      homes.push(home);
      const readyPath = join(home, "ready");
      const pulsePath = join(home, "pulse");
      trackBrokerProcess(spawn(process.execPath, [
        "-e",
        `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, [
  "-e",
  'const { writeFileSync } = require("node:fs"); setInterval(() => writeFileSync(process.argv[1], String(Date.now())), 1);',
  process.argv[2],
], { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(process.argv[1], String(grandchild.pid));
grandchild.unref();`,
        readyPath,
        pulsePath,
      ], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }));
      await waitFor(() => existsSync(readyPath) && existsSync(pulsePath));
    }

    await cleanupTrackedResources();
    expect(homes.every((home) => !existsSync(home))).toBe(true);
  });
});

function fakePiSource(): string {
  return `#!/usr/bin/env node
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
const capture = process.env.FAKE_PI_CAPTURE_PATH;
process.stdout.on("error", () => process.exit(1));
writeFileSync(process.env.FAKE_PI_PID_PATH, String(process.pid), { mode: 0o600 });
if (process.env.FAKE_PI_ARGV_PATH) {
  const argvPath = process.env.FAKE_PI_ARGV_PATH;
  const temporary = argvPath + ".tmp";
  writeFileSync(temporary, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
  renameSync(temporary, argvPath);
}
const decoder = new StringDecoder("utf8");
let buffered = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function handle(line) {
  const command = JSON.parse(line);
  appendFileSync(capture, JSON.stringify(command) + "\\n", { mode: 0o600 });
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        model: { id: "vision-model", input: ["text", "image"] },
      },
    });
    return;
  }
  send({ id: command.id, type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });
  process.stdout.write('{"type":"message_update","provider":"provider-secret"\\n');
  send({ type: "message_update", value: "x".repeat(512) });
  send({ type: "future_event", value: "provider-secret" });
  send({ type: "message_end", message: { role: "assistant", content: [] } });
  send({ type: "agent_settled" });
}
process.stdin.on("data", (chunk) => {
  buffered += decoder.write(chunk);
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line) handle(line);
  }
});
`;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true before timeout");
}

async function waitForStringArrayJsonFile(path: string, timeoutMs = 5_000): Promise<string[]> {
  let parsed: string[] | undefined;
  await waitFor(() => {
    if (!existsSync(path)) return false;
    try {
      parsed = stringArraySchema.parse(JSON.parse(readFileSync(path, "utf8")));
      return true;
    } catch {
      // writeFileSync creates the path before the bytes land; wait until JSON is complete.
      return false;
    }
  }, timeoutMs);
  if (!parsed) throw new Error("JSON file did not contain a string array");
  return parsed;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function trackBrokerProcess(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
  const exit = new Promise<ProcessExit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  processExits.set(child, exit);
  processes.push(child);
  return child;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<ProcessExit> {
  const exit = processExits.get(child);
  if (!exit) throw new Error("broker process was not tracked before waiting for exit");
  return exit;
}

async function stopBrokerProcess(
  child: ChildProcessWithoutNullStreams,
  closeTimeoutMs = 3_000,
): Promise<void> {
  const processGroupId = child.pid;
  // Every tracked fixture leads its own process group, so an already-exited broker cannot orphan a
  // Pi descendant that keeps inherited stdio open or races temp-directory removal with late writes.
  signalProcessGroup(processGroupId, "SIGTERM");
  try {
    // Node emits close only after the broker exits and every inherited stdio stream closes, so a
    // Pi descendant cannot still be writing through the fixture's pipes when this resolves.
    await waitForExitWithin(child, closeTimeoutMs);
  } catch {
    signalProcessGroup(processGroupId, "SIGKILL");
    // Close our pipe ends as a final bound even if the host delays reaping a killed descendant.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await waitForExitWithin(child, closeTimeoutMs).catch(() => undefined);
  }
}

function signalProcessGroup(processGroupId: number | undefined, signal: NodeJS.Signals): void {
  if (!processGroupId) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    const parsed = errnoSchema.safeParse(error);
    // macOS returns EPERM when the detached group contains only its already-dead zombie leader;
    // there is no signalable descendant left, which is equivalent to ESRCH for fixture cleanup.
    const alreadyStopped = parsed.success && (
      parsed.data.code === "ESRCH"
      || (process.platform === "darwin" && parsed.data.code === "EPERM")
    );
    if (!alreadyStopped) throw error;
  }
}

async function waitForExitWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      waitForExit(child),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("broker did not exit after startup failure")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readJournalKinds(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ndjson"))
    .sort()
    .flatMap((name) => readFileSync(join(directory, name), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => journalKindSchema.parse(JSON.parse(line)).kind));
}
