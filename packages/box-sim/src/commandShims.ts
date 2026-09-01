/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing simulator command parsing predates the incremental anti-slop gate. */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import type { BoxSimCommandResult, BoxSimPiController } from "./protocol";

const CONTROL_BUNDLE_ALLOWED_PATHS = new Set([
  ".companion/pi/auth.json",
  ".companion/pi/mcp.json",
  ".companion/pi/models.json",
  ".companion/runtime/state/mcp-gateway.json",
  ".companion/runtime/state/mcp-accounts.json",
  ".companion/runtime/state/skills.json",
  ".companion/runtime/state/config-catalog.json",
  ".companion/runtime/state/instructions.txt",
  ".companion/runtime/state/model.txt",
  ".companion/runtime/state/providers.env",
  ".companion/runtime/state/agent-auth.json",
  ".companion/bin/git-credential-github",
  ".companion/bin/gh",
]);
const CONTROL_BUNDLE_FILE_LIMIT_BYTES = 4 * 1024 * 1024;

type BoxSimJsonValue = string | number | boolean | null | BoxSimJsonObject | BoxSimJsonValue[];

interface BoxSimJsonObject {
  [key: string]: BoxSimJsonValue;
}

const boxSimJsonValueSchema: z.ZodType<BoxSimJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  boxSimJsonObjectSchema,
  z.array(boxSimJsonValueSchema),
]));
const boxSimJsonObjectSchema: z.ZodType<BoxSimJsonObject> = z.record(
  z.string(),
  boxSimJsonValueSchema,
);
const brokerCorrelationIdSchema = z.union([
  z.string().min(1).max(256),
  z.number().finite(),
]);
const controlBundleManifestSchema = z.object({
  revision: z.number().optional(),
  files: z.array(z.object({
    path: z.string().optional(),
    mode: z.number().optional(),
    byteSize: z.number().optional(),
    sha256: z.string().optional(),
    content: z.string().optional(),
  })).optional(),
});
const piModelsFileSchema = z.object({
  providers: z.record(z.string(), z.object({
    baseUrl: z.string(),
    models: z.array(z.object({ id: z.string() })),
  })),
});

export type BoxSimCommandKind =
  | "box-runnable"
  | "staging-probe"
  | "warm-daemon-ready"
  | "mkdir-pi-bin"
  | "install-layout"
  | "probe-layout"
  | "warm-runtime-image"
  | "apply-control-bundle"
  | "mkdir-extensions"
  | "clear-skill-archives"
  | "remove-plugin-skills"
  | "measure-skill-archives"
  | "read-skills-revision"
  | "match-skills-revision"
  | "join-file-parts"
  | "prepare-skills"
  | "agent-register"
  | "start-or-restart-daemon"
  | "daemon-state"
  | "rpc-command"
  | "extension-ui-response"
  | "daemon-diagnostics"
  | "remove-control-bundle"
  | "remove-provider-files"
  | "terminate-daemon-invocation"
  | "stop-daemon"
  | "prepare-attachments"
  | "lock-attachments"
  | "clear-outbox"
  | "list-outbox"
  | "read-outbox-chunk"
  | "unsupported";

export interface BoxSimBrokerCounters {
  malformedLines: number;
  oversizedLines: number;
  unterminatedLines: number;
  unknownEvents: number;
  unboundEvents: number;
  orphanResponses: number;
}

export type BoxSimBrokerJournalRecord =
  | {
      sequence: number;
      invocationId: string;
      attemptId: string;
      kind: "pi_event";
      event: BoxSimJsonObject;
    }
  | {
      sequence: number;
      invocationId: string;
      attemptId: string;
      kind: "pi_process_exit";
      exit: { code: number | null; signal: string | null };
    };

export interface BoxSimDaemonMachine {
  status: "inactive" | "active" | "failed";
  invocationId: string | null;
  invocationCounter: number;
  rpcReady: boolean;
  activeAttemptId: string | null;
  brokerDispatchLedger: Map<string, {
    commandId: string;
    invocationId: string;
    initialCursor: number;
    fingerprint: string;
  }>;
  brokerJournal: BoxSimBrokerJournalRecord[];
  brokerAcknowledgedCursor: number;
  brokerCounters: BoxSimBrokerCounters;
  restartCount: number;
  scenario: string;
  stderrLog: string;
}

/** In-memory Box disk and the minimum systemd/Pi state required by the production adapter. */
export interface BoxSimCommandMachine {
  readonly boxId: string;
  persistentFiles: Map<string, Buffer>;
  volatileFiles: Map<string, Buffer>;
  daemon: BoxSimDaemonMachine;
  layoutInstalled: boolean;
  extensionDirectoryCreated: boolean;
  unknownCommandDigests: string[];
  /**
   * Truncate every outbox chunk to this many raw bytes before encoding it, simulating the command
   * transport's demonstrated habit of mangling large bodies. Null leaves the transport honest.
   */
  mangleOutboxChunkBytes: number | null;
  /**
   * Injects a self-hosted Pi bundle failure into the layout install: the download or its checksum
   * (or the Node major) fails so the bundle branch of the setup script prints its fixed marker and
   * writes no layout file. Null leaves the bundle download honest.
   */
  bundleDownloadFault: "download" | "checksum" | "node" | null;
  /** Directories whose write bit was cleared; their entries can no longer be unlinked. */
  readOnlyDirectories: Set<string>;
  /**
   * The provider's `host <port>` registrations. Sticky per port on purpose: ascii.dev keeps one
   * stable hosted URL and `_token` per port across re-registrations, and the adapter relies on it.
   */
  hostedPorts: Map<number, { title: string; url: string }>;
  /**
   * Mints the token-free base of a hosted URL. The server wires this to its agent listener so the
   * minted endpoint is actually reachable; without it the URL points at an unroutable port.
   */
  hostedUrlFactory?: (port: number) => string;
  /** True once the agent registration command enabled and started the agent user unit. */
  agentUnitEnabled: boolean;
  providerRequests: Array<{ providerId: string; modelId: string; baseUrl: string }>;
  piController?: BoxSimPiController;
}

export function createBoxSimCommandMachine(input: {
  boxId: string;
  scenario: string;
}): BoxSimCommandMachine {
  return {
    boxId: input.boxId,
    persistentFiles: new Map(),
    volatileFiles: new Map(),
    daemon: {
      status: "inactive",
      invocationId: null,
      invocationCounter: 0,
      rpcReady: false,
      activeAttemptId: null,
      brokerDispatchLedger: new Map(),
      brokerJournal: [],
      brokerAcknowledgedCursor: 0,
      brokerCounters: emptyBrokerCounters(),
      restartCount: 0,
      scenario: input.scenario,
      stderrLog: "",
    },
    layoutInstalled: false,
    extensionDirectoryCreated: false,
    unknownCommandDigests: [],
    mangleOutboxChunkBytes: null,
    bundleDownloadFault: null,
    readOnlyDirectories: new Set<string>(),
    hostedPorts: new Map(),
    agentUnitEnabled: false,
    providerRequests: [],
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeBoxPath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/");
  normalized = normalized.replace(/^\$HOME\//, "").replace(/^~\//, "").replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("Box path escapes its virtual home");
      parts.pop();
      continue;
    }
    if (part.includes("\0")) throw new Error("Box path contains NUL");
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("Box path is empty");
  return parts.join("/");
}

export function putBoxFile(
  machine: BoxSimCommandMachine,
  path: string,
  bytes: Uint8Array,
  volatile = false,
): void {
  const destination = volatile ? machine.volatileFiles : machine.persistentFiles;
  destination.set(normalizeBoxPath(path), Buffer.from(bytes));
}

export function appendPiEvent<Event extends object>(
  machine: BoxSimCommandMachine,
  event: Event | string,
): void {
  const textEvent = z.string().safeParse(event);
  if (textEvent.success) {
    appendPiFault(
      machine,
      Buffer.byteLength(textEvent.data, "utf8") > BROKER_MAX_LINE_BYTES ? "oversized" : "malformed",
    );
    return;
  }
  const parsedEvent = boxSimJsonObjectSchema.safeParse(event);
  if (!parsedEvent.success) {
    appendPiFault(machine, "malformed");
    return;
  }
  const validatedEvent = parsedEvent.data;
  const serialized = JSON.stringify(validatedEvent);
  if (Buffer.byteLength(serialized, "utf8") > BROKER_MAX_LINE_BYTES) {
    incrementBrokerCounter(machine, "oversizedLines");
    return;
  }
  if (validatedEvent.type === "response") {
    incrementBrokerCounter(machine, "orphanResponses");
    return;
  }
  const eventTypeResult = z.string().safeParse(validatedEvent.type);
  const eventType = eventTypeResult.success ? eventTypeResult.data : null;
  if (
    !eventType
    || !BROKER_SUPPORTED_EVENT_TYPES.has(eventType)
    || (eventType === "agent_settled" && Object.keys(validatedEvent).length !== 1)
  ) {
    incrementBrokerCounter(machine, "unknownEvents");
    return;
  }
  const { activeAttemptId, invocationId } = machine.daemon;
  if (!activeAttemptId || !invocationId) {
    incrementBrokerCounter(machine, "unboundEvents");
    return;
  }
  machine.daemon.brokerJournal.push({
    sequence: brokerTailCursor(machine) + 1,
    invocationId,
    attemptId: activeAttemptId,
    kind: "pi_event",
    event: structuredClone(validatedEvent),
  });
  if (eventType === "agent_settled" && machine.daemon.activeAttemptId === activeAttemptId) {
    machine.daemon.activeAttemptId = null;
  }
}

/** Record a parser fault without retaining the rejected Pi line or fragment. */
export function appendPiFault(
  machine: BoxSimCommandMachine,
  fault: "malformed" | "oversized" | "unterminated",
): void {
  incrementBrokerCounter(
    machine,
    fault === "malformed"
      ? "malformedLines"
      : fault === "oversized"
        ? "oversizedLines"
        : "unterminatedLines",
  );
}

const BROKER_MAX_LINE_BYTES = 64 * 1024;
const BROKER_READ_LIMIT = 256;
/** Match the production broker's headroom beneath the 256 KiB command response limit. */
const BROKER_READ_BYTES = 224 * 1024;
const BROKER_SUPPORTED_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "extension_ui_request",
  "extension_error",
  "auto_retry_start",
  "auto_retry_end",
  "queue_update",
  "compaction_start",
  "compaction_update",
  "compaction_end",
]);

function emptyBrokerCounters(): BoxSimBrokerCounters {
  return {
    malformedLines: 0,
    oversizedLines: 0,
    unterminatedLines: 0,
    unknownEvents: 0,
    unboundEvents: 0,
    orphanResponses: 0,
  };
}

function incrementBrokerCounter(
  machine: BoxSimCommandMachine,
  counter: keyof BoxSimBrokerCounters,
): void {
  const current = machine.daemon.brokerCounters[counter];
  machine.daemon.brokerCounters[counter] = current >= Number.MAX_SAFE_INTEGER
    ? current
    : current + 1;
}

function brokerTailCursor(machine: BoxSimCommandMachine): number {
  return machine.daemon.brokerJournal.at(-1)?.sequence ?? 0;
}

function simulatedLayoutMarker(machine: BoxSimCommandMachine): string | null {
  return machine.persistentFiles.get(".companion/runtime/state/pi-layout.version")
    ?.toString("utf8").trim() || null;
}

export function appendPiProcessExit(
  machine: BoxSimCommandMachine,
  exit: { code: number | null; signal: string | null } = { code: null, signal: null },
): void {
  const invocationId = machine.daemon.invocationId;
  const attemptId = machine.daemon.activeAttemptId;
  if (!invocationId || !attemptId) {
    incrementBrokerCounter(machine, "unboundEvents");
    machine.daemon.activeAttemptId = null;
    return;
  }
  machine.daemon.brokerJournal.push({
    sequence: brokerTailCursor(machine) + 1,
    invocationId,
    attemptId,
    kind: "pi_process_exit",
    exit,
  });
  machine.daemon.activeAttemptId = null;
  machine.daemon.brokerDispatchLedger.clear();
}

/** Classify only known adapter commands. Unknown strings are never delegated to a host shell. */
export function classifyBoxCommand(command: string): BoxSimCommandKind {
  const brokerCommand = extractBrokerJson(command);
  if (brokerCommand?.type === "extension_ui_response") return "extension-ui-response";
  if (brokerCommand) return "rpc-command";
  if (command.includes("companion-pi-journal") && command.includes("companion-pi-restarts")) {
    return "daemon-diagnostics";
  }
  // The agent registration script also runs `systemctl --user daemon-reload`, so it must be
  // recognized by its own endpoint marker before the daemon-reload family below can claim it.
  if (command.includes("companion-agent-endpoint") && command.includes("host url")) {
    return "agent-register";
  }
  // Activation now waits for the ready/unready marker inside the same Box command. Match its
  // credential and daemon-reload side effects before the narrower read-only status probe.
  if (command.includes("staged_credential_file=") && command.includes("systemctl --user daemon-reload")) {
    return "start-or-restart-daemon";
  }
  if (
    command.includes("companion-pi-broker-ready")
    && command.includes("companion-pi-broker-unready")
  ) {
    return "daemon-state";
  }
  if (command.includes("companion-pi-warm-ready")) return "warm-daemon-ready";
  if (
    command.includes("companion-box-runnable")
    && command.includes("pi-layout.version")
    && command.includes("companion-provider-auth-present")
  ) return "staging-probe";
  if (command.includes("companion-box-runnable")) return "box-runnable";
  if (
    command.includes("COMPANION_CONTROL_BUNDLE=")
    && command.includes("COMPANION_CONTROL_APPLY")
  ) return "apply-control-bundle";
  if (command.includes("companion-pi-termination-terminated")) {
    return "terminate-daemon-invocation";
  }
  if (command.includes("Pi daemon is still active after stop")) return "stop-daemon";
  if (
    command.includes(".companion/runtime/state/providers.env")
    && command.includes("/run/user/$(id -u)/companion/providers.env")
    && command.includes("rm -f")
  ) {
    return "remove-provider-files";
  }
  if (
    command.includes(".companion/runtime/state/control-bundle-v1.json")
    && command.includes("control-transaction-v1")
    && command.includes("rm -f")
  ) return "remove-control-bundle";
  if (command.includes("companion-archive-bytes") && command.includes("wc -c")) {
    return "measure-skill-archives";
  }
  if (
    command.includes("skills-tree.version")
    && command.includes("grep -Eq '^[0-9a-f]{64}$'")
  ) return "read-skills-revision";
  if (
    command.includes("skills-tree.version")
    && command.includes('test "$(cat ')
    && command.includes("2>/dev/null || true)")
  ) return "match-skills-revision";
  if (command.includes("cat ") && command.includes(".part") && command.includes("; rm -f ")) {
    return "join-file-parts";
  }
  if (
    command.includes('root="$HOME/.companion/runtime"')
    && command.includes('rm -rf "$root/state/skill-archives"')
    && command.includes('mkdir -p "$root/state/skill-archives"')
  ) return "clear-skill-archives";
  if (command.includes("skills.next") && command.includes("base64 --decode") && command.includes("tar --extract")) {
    return "prepare-skills";
  }
  if (
    command.includes('root="$HOME/.companion/runtime"')
    && command.includes("companion-provider-auth-present")
  ) {
    return "clear-skill-archives";
  }
  if (/rm -rf "\$HOME\/\.companion\/runtime\/skills\/plugin-[a-z]+"/.test(command)) {
    return "remove-plugin-skills";
  }
  if (command.includes("companion-outbox-manifest-begin")) return "list-outbox";
  if (command.includes("companion-outbox-chunk-begin")) return "read-outbox-chunk";
  if (command.includes('dir="$HOME/outbox"') && command.includes("find \"$dir\" -mindepth 1 -delete")) {
    return "clear-outbox";
  }
  if (/rm -rf ['"]attachments/.test(command) && command.includes("mkdir -p")) {
    return "prepare-attachments";
  }
  if (command.includes("chmod a-w") || command.includes("chmod -R a-w")) return "lock-attachments";
  if (command.trim() === 'mkdir -p "$HOME/.companion/bin"') return "mkdir-pi-bin";
  if (command.includes("ensure-pi-layout.sh") && /^\s*bash\s/.test(command)) return "install-layout";
  if (
    command.includes("pi-layout.version")
    && command.includes("companion-layout-unchanged")
    && command.includes("companion-pi-broker.mjs")
  ) return "probe-layout";
  if (
    command.includes("companion-runtime-playbook-ready")
    && command.includes(".ascii/playbook.json")
    && command.includes("companion-pi-broker.mjs")
  ) return "warm-runtime-image";
  if (command.trim() === 'mkdir -p "$HOME/.companion/pi/extensions"') return "mkdir-extensions";
  return "unsupported";
}

function ok(stdout = ""): BoxSimCommandResult {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string, exitCode = 1, stdout = ""): BoxSimCommandResult {
  return { success: false, exitCode, stdout, stderr };
}

/** Marker the layout script prints as its last stderr line for each injected bundle fault. */
const BUNDLE_FAULT_MARKER: Record<NonNullable<BoxSimCommandMachine["bundleDownloadFault"]>, string> = {
  download: "companion-bundle-download-failed",
  checksum: "companion-bundle-checksum-mismatch",
  node: "companion-bundle-node-mismatch",
};

function installedLayout(machine: BoxSimCommandMachine): BoxSimCommandResult {
  const script = machine.persistentFiles.get(".companion/bin/ensure-pi-layout.sh")?.toString("utf8");
  if (!script) return failed("staged Pi layout script is missing");
  const expected = /(?:^|\n)expected_layout='([^']*)'/.exec(script)?.[1];
  const base = /(?:^|\n)base_layout='([^']*)'/.exec(script)?.[1];
  const markerPath = ".companion/runtime/state/pi-layout.version";
  const recorded = machine.persistentFiles.get(markerPath)?.toString("utf8").trim() ?? "";
  const brokerReady = machine.persistentFiles.has(".companion/bin/companion-pi-broker.mjs")
    && machine.persistentFiles.has(".companion/bin/pi-daemon")
    && machine.persistentFiles.has(".config/systemd/user/companion-pi-daemon.service");
  machine.layoutInstalled = true;
  if (expected && recorded === expected && brokerReady) {
    return ok("companion-layout-unchanged\n");
  }
  // A bundle-mode layout script downloads one immutable tarball through its injected presigned URL
  // and verifies it before it writes anything. The injected fault fails that step: it prints the
  // fixed marker as its last stderr line and returns before any layout file is written, exactly as
  // the real script's `exit 1` does.
  const bundleMode = /(?:^|\n)bundle_url='[^']*'/.test(script);
  if (bundleMode && machine.bundleDownloadFault) {
    return failed(`${BUNDLE_FAULT_MARKER[machine.bundleDownloadFault]}\n`);
  }
  writeSimulatedLayoutFiles(machine, expected);
  if (expected && base && recorded.split(":overlay=")[0] === base) {
    return ok("companion-layout-overlay\n");
  }
  return ok("companion-layout-base\n");
}

function probedLayout(machine: BoxSimCommandMachine, command: string): BoxSimCommandResult {
  const quoted = /\[ "\$recorded" = ('(?:\\'|[^'])*') \]/.exec(command)?.[1];
  const expected = quoted ? decodeShellQuoted(quoted) : undefined;
  const recorded = machine.persistentFiles.get(".companion/runtime/state/pi-layout.version")
    ?.toString("utf8").trim() ?? "";
  const brokerReady = machine.persistentFiles.has(".companion/bin/companion-pi-broker.mjs")
    && machine.persistentFiles.has(".companion/bin/pi-daemon")
    && machine.persistentFiles.has(".config/systemd/user/companion-pi-daemon.service");
  if (expected && recorded === expected && brokerReady) {
    return ok("companion-layout-unchanged\n");
  }
  return ok();
}

function clearStagedSkillArchives(machine: BoxSimCommandMachine): void {
  const prefix = ".companion/runtime/state/skill-archives/";
  for (const path of machine.persistentFiles.keys()) {
    if (path.startsWith(prefix)) machine.persistentFiles.delete(path);
  }
}

function stagingProbe(machine: BoxSimCommandMachine, command: string): BoxSimCommandResult {
  const output = ["companion-box-runnable"];
  if (probedLayout(machine, command).stdout.includes("companion-layout-unchanged")) {
    output.push("companion-layout-unchanged");
  }

  const installedRevision = machine.persistentFiles
    .get(".companion/runtime/state/skills-tree.version")?.toString("utf8").trim();
  if (command.includes("companion-skills-snapshot-corrupt")) {
    if (!installedRevision || !/^[0-9a-f]{64}$/.test(installedRevision)) {
      output.push("companion-skills-snapshot-corrupt");
      return failed("", 1, `${output.join("\n")}\n`);
    }
    output.push(installedRevision);
    clearStagedSkillArchives(machine);
    output.push("companion-skills-tree-reused");
  } else {
    const expectedRevision = /skills-tree\.version[\s\S]*?" = '([0-9a-f]{64})' \]; then/
      .exec(command)?.[1];
    if (expectedRevision && expectedRevision === installedRevision) {
      output.push("companion-skills-tree-reused");
    } else {
      clearStagedSkillArchives(machine);
      const bakedCopy = /if \[ -s "\$HOME\/([^"]+)" \]; then cp "\$HOME\/([^"]+)" "\$HOME\/([^"]+)";/.exec(command);
      const source = bakedCopy?.[1] && bakedCopy[1] === bakedCopy[2]
        ? bakedCopy[1]
        : undefined;
      const destination = bakedCopy?.[3];
      const bakedArchive = source ? machine.persistentFiles.get(normalizeBoxPath(source)) : undefined;
      if (bakedArchive && destination) {
        machine.persistentFiles.set(normalizeBoxPath(destination), Buffer.from(bakedArchive));
        output.push("companion-bundled-skill-reused");
      }
    }
  }

  if (machine.persistentFiles.has(".companion/pi/auth.json")) {
    output.push("companion-provider-auth-present");
  }
  return ok(`${output.join("\n")}\n`);
}

function writeSimulatedLayoutFiles(machine: BoxSimCommandMachine, expected?: string): void {
  machine.persistentFiles.set(".companion/bin/companion-pi-broker.mjs", Buffer.from("broker\n"));
  machine.persistentFiles.set(".companion/bin/pi-daemon", Buffer.from("daemon\n"));
  machine.persistentFiles.set(
    ".config/systemd/user/companion-pi-daemon.service",
    Buffer.from("[Service]\n"),
  );
  if (expected) {
    machine.persistentFiles.set(
      ".companion/runtime/state/pi-layout.version",
      Buffer.from(`${expected}\n`),
    );
  }
}

/** The staged attachment directory a prepare command names, relative to the Box home. */
function attachmentDirectory(command: string): string | null {
  const match = /rm -rf ('(?:[^']|'"'"')*')/.exec(command);
  return match?.[1] ? decodeShellQuoted(match[1]) : null;
}

/** The directory a lock command applies `chmod a-w` to. */
function lockedAttachmentDirectory(command: string): string | null {
  const match = /chmod (?:-R )?a-w ('(?:[^']|'"'"')*')|find ('(?:[^']|'"'"')*') -type f/.exec(command);
  const quoted = match?.[1] ?? match?.[2];
  return quoted ? decodeShellQuoted(quoted) : null;
}

/** The file, chunk index, and chunk size one outbox read command asks for. */
function outboxChunkRequest(
  command: string,
): { name: string; index: number; chunkBytes: number } | null {
  const encoded = /base64 -d\b[\s\S]*?'([A-Za-z0-9+/]+={0,2})'/.exec(command)
    ?? /'([A-Za-z0-9+/]+={0,2})' \| base64 -d/.exec(command);
  const chunk = /bs=(\d+)/.exec(command);
  const skip = /skip=(\d+)/.exec(command);
  if (!encoded?.[1] || !chunk?.[1] || !skip?.[1]) return null;
  return {
    name: Buffer.from(encoded[1], "base64").toString("utf8"),
    index: Number(skip[1]),
    chunkBytes: Number(chunk[1]),
  };
}

/** Decode the exact POSIX single-quote form emitted by boxCompanionRuntime's shellQuote helper. */
export function decodeShellQuoted(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("'") || !trimmed.endsWith("'")) return null;
  return trimmed.slice(1, -1).split("'\"'\"'").join("'");
}

/** Pull the base64-encoded JSON command from layout 14's owner-only socket client. */
export function extractBrokerJson(command: string): BoxSimJsonObject | null {
  const match = /\bCOMPANION_PI_BROKER_COMMAND=('(?:[^']|'"'"')*')/.exec(command);
  const encoded = match?.[1] ? decodeShellQuoted(match[1]) : null;
  if (!encoded) return null;
  try {
    const parsed = boxSimJsonObjectSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function nextInvocationId(machine: BoxSimCommandMachine): string {
  machine.daemon.invocationCounter += 1;
  return machine.daemon.invocationCounter.toString(16).padStart(32, "0");
}

async function startDaemon(machine: BoxSimCommandMachine, restart: boolean): Promise<BoxSimCommandResult> {
  const stagedPath = ".companion/runtime/state/providers.env";
  const runtimePath = "run/user/1000/companion/providers.env";
  const staged = machine.persistentFiles.get(stagedPath);
  if (!staged && !machine.volatileFiles.has(runtimePath)) {
    return failed("Companion runtime credentials were not staged");
  }
  if (!machine.persistentFiles.has(".companion/pi/auth.json")) {
    return failed("Companion provider auth file is missing");
  }
  if (staged) {
    machine.persistentFiles.delete(stagedPath);
    machine.volatileFiles.set(runtimePath, Buffer.from(staged));
  }
  const modelError = selectedModelStartupError(machine);
  if (modelError) {
    machine.daemon.status = "failed";
    machine.daemon.rpcReady = false;
    machine.daemon.stderrLog += `${modelError}\n`;
    return ok("failed\ncompanion-pi-broker-unready\n");
  }
  if (!restart && machine.daemon.status === "active") {
    // `systemctl start` is idempotent for an already active unit. In particular it does not create
    // a new Pi invocation; configuration changes use the explicit restart path.
    return ok(
      `active\ncompanion-pi-broker-ready\ncompanion-pi-invocation ${machine.daemon.invocationId}\n`,
    );
  }
  if (restart) {
    machine.daemon.restartCount += 1;
    appendPiProcessExit(machine);
  }
  machine.daemon.status = "active";
  machine.daemon.invocationId = nextInvocationId(machine);
  // Match SegmentedCompanionPiJournal.beginInvocation(): a new broker invocation cannot resume
  // the attempt bound by its predecessor, so its remaining records are retired before Pi can emit
  // anything for the new invocation. Without this, the simulator poisons an explicit Retry with a
  // permanently non-empty broker queue even though the production broker starts cleanly.
  machine.daemon.brokerAcknowledgedCursor = brokerTailCursor(machine);
  machine.daemon.rpcReady = true;
  machine.daemon.activeAttemptId = null;
  machine.daemon.brokerDispatchLedger.clear();
  try {
    if (restart) await machine.piController?.restart();
    else await machine.piController?.start();
  } catch {
    appendPiProcessExit(machine);
    machine.daemon.status = "failed";
    machine.daemon.rpcReady = false;
    machine.daemon.stderrLog += "simulated Pi controller failed to start\n";
    return failed("simulated Pi controller failed to start");
  }
  return ok(
    `active\ncompanion-pi-broker-ready\ncompanion-pi-invocation ${machine.daemon.invocationId}\n`,
  );
}

function selectedModelStartupError(machine: BoxSimCommandMachine): string | null {
  const selected = machine.persistentFiles.get(".companion/runtime/state/model.txt")
    ?.toString("utf8").trim();
  if (selected !== "glm-5.3-flash") return null;
  return selectedCustomModel(machine)?.modelId === selected
    ? null
    : `Error: Model "${selected}" not found. Use --list-models to see available models.`;
}

function selectedCustomModel(
  machine: BoxSimCommandMachine,
): { providerId: string; modelId: string; baseUrl: string } | null {
  const selected = machine.persistentFiles.get(".companion/runtime/state/model.txt")
    ?.toString("utf8").trim();
  const file = machine.persistentFiles.get(".companion/pi/models.json");
  if (!selected || !file) return null;
  try {
    const parsed = piModelsFileSchema.parse(JSON.parse(file.toString("utf8")));
    for (const [providerId, provider] of Object.entries(parsed.providers)) {
      if (provider.models.some((model) => model.id === selected)) {
        return { providerId, modelId: selected, baseUrl: provider.baseUrl };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function responseFor(command: BoxSimJsonObject, data?: BoxSimJsonObject): BoxSimJsonObject {
  const typeResult = z.string().safeParse(command.type);
  const type = typeResult.success ? typeResult.data : "unknown";
  const response: BoxSimJsonObject = {
    type: "response",
    command: type,
    success: true,
  };
  if (command.id !== undefined) response.id = command.id;
  if (data !== undefined) response.data = data;
  return response;
}

function brokerFailureFor(
  command: BoxSimJsonObject,
  code: string,
  message: string,
): BoxSimJsonObject {
  return {
    ...responseFor(command),
    success: false,
    error: { code, message, ambiguous: false },
  };
}

function brokerNonNegativeInteger(value: BoxSimJsonValue | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function validBrokerCorrelationId(value: BoxSimJsonValue | undefined): value is string | number {
  return brokerCorrelationIdSchema.safeParse(value).success;
}

function objectRecord(value: BoxSimJsonValue | undefined): BoxSimJsonObject | null {
  const parsed = boxSimJsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Registers the Companion box agent's hosted endpoint. The provider keeps one URL and `_token` per
 * port for the lifetime of the Box, so a re-registration after stop/resume must answer with the
 * same endpoint the first registration minted.
 */
function registeredAgentEndpoint(
  machine: BoxSimCommandMachine,
  command: string,
): BoxSimCommandResult {
  const port = Number(/\bhost url (\d+)\b/.exec(command)?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return failed("simulated agent registration names no hosted port");
  }
  machine.agentUnitEnabled = true;
  let hosted = machine.hostedPorts.get(port);
  if (!hosted) {
    // The factory only knows where the shared agent listener is; the per-box path and the proxy
    // `_token` are minted here. Port 0 makes the factory-less default unroutable on purpose.
    const origin = machine.hostedUrlFactory?.(port) ?? "http://127.0.0.1:0";
    hosted = {
      title: /--title (\S+)/.exec(command)?.[1] ?? "companion-agent",
      url: `${origin}/boxes/${machine.boxId}?_token=${randomBytes(32).toString("hex")}`,
    };
    machine.hostedPorts.set(port, hosted);
  }
  return ok(`companion-agent-endpoint ${hosted.url}\n`);
}

/** Answer the layout-14 broker's control commands. Both transports must serve identical bytes. */
export async function executeBrokerControl(
  machine: BoxSimCommandMachine,
  command: BoxSimJsonObject,
): Promise<BoxSimCommandResult | null> {
  const tailCursor = brokerTailCursor(machine);
  switch (command.type) {
    case "broker_state":
      return ok(`${JSON.stringify(responseFor(command, {
        invocationId: machine.daemon.invocationId,
        layoutMarker: simulatedLayoutMarker(machine),
        activeAttemptId: machine.daemon.activeAttemptId,
        tailCursor,
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
        counters: { ...machine.daemon.brokerCounters },
      }))}\n`);
    case "runtime_state": {
      let piState: BoxSimJsonObject | null;
      try {
        const getStateCommand: BoxSimJsonObject = { type: "get_state" };
        if (command.id !== undefined) getStateCommand.id = command.id;
        const rawPiState = await machine.piController?.handleRpc(getStateCommand)
          ?? responseFor(getStateCommand, {
          model: { input: [] },
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount: 0,
        });
        const parsedPiState = boxSimJsonObjectSchema.safeParse(rawPiState);
        piState = parsedPiState.success ? parsedPiState.data : null;
      } catch {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "broker_unavailable",
          "Pi broker command failed",
        ))}\n`);
      }
      const state = piState?.success === true ? objectRecord(piState.data) : null;
      if (!state) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "pi_state_unavailable",
          "Pi state is unavailable",
        ))}\n`);
      }
      const model = objectRecord(state.model);
      const modelInput = Array.isArray(model?.input)
        ? structuredClone(model.input)
        : [];
      return ok(`${JSON.stringify(responseFor(command, {
        invocationId: machine.daemon.invocationId,
        layoutMarker: simulatedLayoutMarker(machine),
        activeAttemptId: machine.daemon.activeAttemptId,
        tailCursor,
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
        counters: { ...machine.daemon.brokerCounters },
        modelInput,
      }))}\n`);
    }
    case "dispatch_status": {
      const attemptId = typeof command.attemptId === "string" ? command.attemptId : null;
      const commandId = typeof command.commandId === "string" ? command.commandId : null;
      if (!attemptId || !commandId) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "invalid_command",
          "dispatch identity is required",
        ))}\n`);
      }
      const recorded = machine.daemon.brokerDispatchLedger.get(attemptId);
      if (!recorded) {
        return ok(`${JSON.stringify(responseFor(command, { status: "absent", attemptId, commandId }))}\n`);
      }
      if (recorded.commandId !== commandId) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "dispatch_conflict",
          "attempt dispatch identity does not match",
        ))}\n`);
      }
      return ok(`${JSON.stringify(responseFor(command, {
        status: "accepted",
        attemptId,
        commandId,
        invocationId: recorded.invocationId,
        fingerprint: recorded.fingerprint,
        piAcknowledged: true,
        initialCursor: recorded.initialCursor,
        requiredInput: ["text"],
        clearOutbox: true,
      }))}\n`);
    }
    case "read_events": {
      const after = brokerNonNegativeInteger(command.after);
      const limit = command.limit === undefined ? BROKER_READ_LIMIT : brokerNonNegativeInteger(command.limit);
      if (
        after === null
        || limit === null
        || limit < 1
        || limit > BROKER_READ_LIMIT
        || after > tailCursor
      ) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "invalid_command",
          "event journal cursor or limit is invalid",
        ))}\n`);
      }
      const effectiveAfter = Math.max(after, machine.daemon.brokerAcknowledgedCursor);
      const events: BoxSimBrokerJournalRecord[] = [];
      let responseBytes = 0;
      for (const event of machine.daemon.brokerJournal) {
        if (event.sequence <= effectiveAfter) continue;
        const cloned = structuredClone(event);
        const recordBytes = Buffer.byteLength(JSON.stringify(cloned), "utf8") + 1;
        if (events.length > 0 && responseBytes + recordBytes > BROKER_READ_BYTES) break;
        events.push(cloned);
        responseBytes += recordBytes;
        if (events.length === limit || responseBytes >= BROKER_READ_BYTES) break;
      }
      const nextCursor = events.at(-1)?.sequence ?? effectiveAfter;
      return ok(`${JSON.stringify(responseFor(command, {
        events,
        nextCursor,
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
        hasMore: nextCursor < tailCursor,
      }))}\n`);
    }
    case "ack_events": {
      const through = brokerNonNegativeInteger(command.through);
      if (through === null || through > tailCursor) {
        return ok(`${JSON.stringify(brokerFailureFor(
          command,
          "invalid_command",
          "event acknowledgement cursor is invalid",
        ))}\n`);
      }
      machine.daemon.brokerAcknowledgedCursor = Math.max(
        machine.daemon.brokerAcknowledgedCursor,
        through,
      );
      return ok(`${JSON.stringify(responseFor(command, {
        acknowledgedCursor: machine.daemon.brokerAcknowledgedCursor,
      }))}\n`);
    }
    default:
      return null;
  }
}

async function executeRpc(
  machine: BoxSimCommandMachine,
  commandText: string,
): Promise<BoxSimCommandResult> {
  if (machine.daemon.status !== "active" || !machine.daemon.rpcReady) {
    return failed("Pi RPC is not ready");
  }
  const brokerCommand = extractBrokerJson(commandText);
  if (!brokerCommand) return failed("Pi broker command was not valid JSON");
  return await executeBrokerCommand(machine, brokerCommand);
}

async function executeBrokerCommand(
  machine: BoxSimCommandMachine,
  brokerCommand: BoxSimJsonObject,
): Promise<BoxSimCommandResult> {
  const brokerControl = await executeBrokerControl(machine, brokerCommand);
  if (brokerControl) return brokerControl;
  const promptAttemptIdResult = z.string().safeParse(brokerCommand.attemptId);
  const promptAttemptId = brokerCommand.type === "prompt" && promptAttemptIdResult.success
    ? promptAttemptIdResult.data
    : null;
  const promptCommandId = brokerCommand.type === "prompt" && typeof brokerCommand.id === "string"
    ? brokerCommand.id
    : null;
  const promptFingerprint = promptAttemptId && promptCommandId
    ? createHash("sha256").update(JSON.stringify({
      attemptId: promptAttemptId,
      expectedInvocationId: typeof brokerCommand.expectedInvocationId === "string"
        ? brokerCommand.expectedInvocationId
        : null,
      message: brokerCommand.message,
      requiredInput: brokerCommand.requiredInput,
      clearOutbox: brokerCommand.clearOutbox === true,
    })).digest("hex")
    : null;
  if (
    brokerCommand.type === "prompt"
    && typeof brokerCommand.expectedInvocationId === "string"
    && brokerCommand.expectedInvocationId !== machine.daemon.invocationId
  ) {
    return ok(`${JSON.stringify(brokerFailureFor(
      brokerCommand,
      "invocation_mismatch",
      "prompt does not match the current Pi invocation",
    ))}\n`);
  }
  const recorded = promptAttemptId
    ? machine.daemon.brokerDispatchLedger.get(promptAttemptId)
    : undefined;
  if (recorded) {
    if (recorded.commandId !== promptCommandId || recorded.fingerprint !== promptFingerprint) {
      return ok(`${JSON.stringify(brokerFailureFor(
        brokerCommand,
        "dispatch_conflict",
        "attempt dispatch identity does not match",
      ))}\n`);
    }
    return ok(`${JSON.stringify(responseFor(brokerCommand, {
      attemptId: promptAttemptId,
      commandId: recorded.commandId,
      invocationId: recorded.invocationId,
      piAcknowledged: true,
      initialCursor: recorded.initialCursor,
      requiredInput: brokerCommand.requiredInput ?? ["text"],
      clearOutbox: true,
    }))}\n`);
  }
  if (brokerCommand.type === "prompt" && machine.daemon.activeAttemptId) {
    return ok(`${JSON.stringify(brokerFailureFor(
      brokerCommand,
      "attempt_active",
      "another Pi attempt is already active",
    ))}\n`);
  }
  const abortAttemptId = brokerCommand.type === "abort" ? machine.daemon.activeAttemptId : null;
  if (brokerCommand.type === "abort" && typeof brokerCommand.attemptId === "string"
    && abortAttemptId && brokerCommand.attemptId !== abortAttemptId) {
    return ok(`${JSON.stringify(brokerFailureFor(
      brokerCommand,
      "attempt_mismatch",
      "abort does not match the active Pi attempt",
    ))}\n`);
  }
  if (brokerCommand.type === "abort" && !abortAttemptId) {
    return ok(`${JSON.stringify(responseFor(brokerCommand, {
      aborted: false,
      invocationId: machine.daemon.invocationId,
    }))}\n`);
  }
  const initialCursor = brokerCommand.type === "prompt" ? brokerTailCursor(machine) : null;
  if (brokerCommand.type === "prompt") {
    const providerRequest = selectedCustomModel(machine);
    if (providerRequest) machine.providerRequests.push(providerRequest);
  }
  if (brokerCommand.type === "prompt" && brokerCommand.clearOutbox === true) {
    for (const path of machine.persistentFiles.keys()) {
      if (path.startsWith("outbox/")) machine.persistentFiles.delete(path);
    }
  }
  // The production broker binds before writing to Pi: Pi may emit an event before its correlated
  // command response arrives. Roll this provisional binding back only when Pi proves rejection.
  if (promptAttemptId) machine.daemon.activeAttemptId = promptAttemptId;
  let response: BoxSimJsonObject | null;
  try {
    const rawResponse = await machine.piController?.handleRpc(brokerCommand) ?? null;
    const parsedResponse = boxSimJsonObjectSchema.safeParse(rawResponse);
    response = parsedResponse.success ? parsedResponse.data : null;
  } catch {
    appendPiProcessExit(machine);
    machine.daemon.status = "failed";
    machine.daemon.rpcReady = false;
    machine.daemon.stderrLog += "simulated Pi RPC controller failed\n";
    return failed("simulated Pi RPC controller failed");
  }
  if (!response) {
    response = brokerCommand.type === "get_state"
      ? responseFor(brokerCommand, { isStreaming: false, pendingMessageCount: 0 })
      : responseFor(brokerCommand);
  } else if (response.type !== "response") {
    response = responseFor(brokerCommand, response);
  }
  if (brokerCommand.type === "prompt") {
    const promptResponseData: BoxSimJsonObject = {
      invocationId: machine.daemon.invocationId,
      piAcknowledged: true,
      initialCursor,
      clearOutbox: true,
    };
    if (promptAttemptId !== null) promptResponseData.attemptId = promptAttemptId;
    if (brokerCommand.requiredInput !== undefined) {
      promptResponseData.requiredInput = brokerCommand.requiredInput;
    }
    response = response.success === true
      ? responseFor(brokerCommand, promptResponseData)
      : {
          ...responseFor(brokerCommand),
          success: false,
          error: {
            code: "pi_prompt_refused",
            message: "Pi refused the prompt",
            ambiguous: false,
          },
        };
    if (
      response.success === true
      && promptAttemptId
      && promptCommandId
      && promptFingerprint
      && machine.daemon.invocationId
      && initialCursor !== null
    ) {
      machine.daemon.brokerDispatchLedger.set(promptAttemptId, {
        commandId: promptCommandId,
        invocationId: machine.daemon.invocationId,
        initialCursor,
        fingerprint: promptFingerprint,
      });
    }
    if (
      response.success !== true
      && promptAttemptId
      && machine.daemon.activeAttemptId === promptAttemptId
    ) {
      machine.daemon.activeAttemptId = null;
    }
  } else if (brokerCommand.type === "abort") {
    if (response.success === true) machine.daemon.activeAttemptId = null;
    response = response.success === true
      ? responseFor(brokerCommand, {
        aborted: true,
        attemptId: abortAttemptId,
        invocationId: machine.daemon.invocationId,
      })
      : {
          ...responseFor(brokerCommand),
          success: false,
          error: {
            code: "pi_abort_refused",
            message: "Pi refused the abort",
            ambiguous: false,
          },
        };
  }
  return ok(`${JSON.stringify(response)}\n`);
}

async function executeExtensionResponse(
  machine: BoxSimCommandMachine,
  commandText: string,
): Promise<BoxSimCommandResult> {
  if (machine.daemon.status !== "active" || !machine.daemon.rpcReady) {
    return failed("Pi RPC is not ready");
  }
  const brokerCommand = extractBrokerJson(commandText);
  if (!brokerCommand) return failed("Pi extension response was not valid JSON");
  return await executeExtensionResponseCommand(machine, brokerCommand);
}

async function executeExtensionResponseCommand(
  machine: BoxSimCommandMachine,
  brokerCommand: BoxSimJsonObject,
): Promise<BoxSimCommandResult> {
  const requestedAttemptIdResult = z.string().safeParse(brokerCommand.attemptId);
  const requestedAttemptId = requestedAttemptIdResult.success
    ? requestedAttemptIdResult.data
    : machine.daemon.activeAttemptId;
  if (
    (
      !requestedAttemptId
      || (
        brokerCommand.attemptId !== undefined
        && brokerCommand.attemptId !== machine.daemon.activeAttemptId
      )
    )
  ) {
    const code = machine.daemon.activeAttemptId ? "attempt_mismatch" : "no_active_attempt";
    return ok(`${JSON.stringify({
      ...responseFor(brokerCommand),
      success: false,
      error: { code, message: "decision does not match an active Pi attempt", ambiguous: false },
    })}\n`);
  }
  const responseResult = boxSimJsonObjectSchema.safeParse(brokerCommand.response);
  const response = brokerCommand.type === "extension_ui_response" && responseResult.success
    ? responseResult.data
    : null;
  if (
    !response
    || response.type !== "extension_ui_response"
    || !validBrokerCorrelationId(response.id)
  ) {
    return ok(`${JSON.stringify(brokerFailureFor(
      brokerCommand,
      "invalid_command",
      "extension UI response is invalid",
    ))}\n`);
  }
  try {
    await machine.piController?.respondExtensionUi(response);
  } catch {
    return failed("simulated Pi extension response failed");
  }
  return ok(`${JSON.stringify(responseFor(brokerCommand, {
    attemptId: requestedAttemptId!,
    invocationId: machine.daemon.invocationId,
    delivered: true,
  }))}\n`);
}

/** Direct-agent entrypoint: the same broker semantics as an exec-transport socket command. */
export async function executeBrokerAgentCommand(
  machine: BoxSimCommandMachine,
  command: Record<string, unknown>,
): Promise<BoxSimCommandResult> {
  if (machine.daemon.status !== "active" || !machine.daemon.rpcReady) {
    return failed("Pi RPC is not ready");
  }
  const parsed = boxSimJsonObjectSchema.safeParse(command);
  if (!parsed.success) return failed("Pi broker command was not valid JSON");
  return parsed.data.type === "extension_ui_response"
    ? await executeExtensionResponseCommand(machine, parsed.data)
    : await executeBrokerCommand(machine, parsed.data);
}

function joinedFileCommand(machine: BoxSimCommandMachine, command: string): BoxSimCommandResult {
  const match = /\bcat\s+(.+?)\s+>\s+('(?:[^']|'"'"')*')\s*;/.exec(command);
  if (!match?.[1] || !match[2]) return failed("simulated file join could not parse command", 2);
  const target = decodeShellQuoted(match[2]);
  const quotedParts = match[1].match(/'(?:[^']|'"'"')*'/g) ?? [];
  const parts = quotedParts.map(decodeShellQuoted);
  if (!target || parts.some((part) => part === null)) {
    return failed("simulated file join could not parse paths", 2);
  }
  const decodedParts = parts.filter((part): part is string => part !== null);
  const chunks: Buffer[] = [];
  for (const part of decodedParts) {
    const normalized = normalizeBoxPath(part);
    const bytes = machine.persistentFiles.get(normalized);
    if (!bytes) return failed(`simulated file part is missing: ${normalized}`);
    chunks.push(bytes);
  }
  machine.persistentFiles.set(normalizeBoxPath(target), Buffer.concat(chunks));
  for (const part of decodedParts) machine.persistentFiles.delete(normalizeBoxPath(part));
  return ok();
}

function measuredArchives(machine: BoxSimCommandMachine): BoxSimCommandResult {
  const prefix = ".companion/runtime/state/skill-archives/";
  const lines = [...machine.persistentFiles.entries()]
    .filter(([path]) => path.startsWith(prefix) && path.endsWith(".tar.gz.b64"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => `companion-archive-bytes ${path.slice(prefix.length)} ${bytes.byteLength}`);
  return ok(lines.length ? `${lines.join("\n")}\n` : "");
}

function appliedControlBundle(machine: BoxSimCommandMachine): BoxSimCommandResult {
  const bundlePath = ".companion/runtime/state/control-bundle-v1.json";
  const bytes = machine.persistentFiles.get(bundlePath);
  if (!bytes) return failed("simulated runtime control bundle is missing");
  try {
    const manifest = controlBundleManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      manifest.revision !== 1
      || !Array.isArray(manifest.files)
      || manifest.files.length > CONTROL_BUNDLE_ALLOWED_PATHS.size
    ) {
      return failed("simulated runtime control manifest is invalid");
    }
    const seen = new Set<string>();
    const validated: Array<{ path: string; content: Buffer }> = [];
    for (const file of manifest.files) {
      if (
        file.path === undefined
        || !CONTROL_BUNDLE_ALLOWED_PATHS.has(file.path)
        || seen.has(file.path)
        || ![0o600, 0o700].includes(Number(file.mode))
        || file.content === undefined
      ) return failed("simulated runtime control file is invalid");
      const content = Buffer.from(file.content, "base64");
      if (
        content.byteLength !== file.byteSize
        || content.byteLength > CONTROL_BUNDLE_FILE_LIMIT_BYTES
        || sha256(content) !== file.sha256
      ) return failed("simulated runtime control digest is invalid");
      seen.add(file.path);
      validated.push({ path: normalizeBoxPath(file.path), content });
    }
    for (const file of validated) machine.persistentFiles.set(file.path, file.content);
    return ok();
  } catch {
    return failed("simulated runtime control bundle is unreadable");
  } finally {
    // The production command's EXIT trap removes credentials-bearing bundle bytes on success and
    // every failure path. Model that property so replay and cleanup assertions remain meaningful.
    machine.persistentFiles.delete(bundlePath);
  }
}

/** Execute one recognized command against virtual state. This function never invokes a shell. */
export async function executeBoxCommand(
  machine: BoxSimCommandMachine,
  command: string,
  _timeoutSeconds = 60,
): Promise<BoxSimCommandResult> {
  if (
    machine.daemon.status === "active"
    && machine.piController?.running === false
  ) {
    appendPiProcessExit(machine);
    machine.daemon.status = "failed";
    machine.daemon.rpcReady = false;
    machine.daemon.stderrLog += "simulated Pi process exited\n";
  }
  switch (classifyBoxCommand(command)) {
    case "box-runnable":
      return ok("companion-box-runnable\n");
    case "staging-probe":
      return stagingProbe(machine, command);
    case "warm-daemon-ready": {
      const warm = machine.daemon.status === "active"
        && machine.daemon.rpcReady
        && machine.volatileFiles.has("run/user/1000/companion/providers.env");
      return ok(warm ? "companion-pi-warm-ready\n" : "");
    }
    case "mkdir-pi-bin":
      return ok();
    case "install-layout":
      return installedLayout(machine);
    case "probe-layout":
      return probedLayout(machine, command);
    case "warm-runtime-image": {
      const brokerReady = machine.persistentFiles.has(".companion/bin/companion-pi-broker.mjs");
      const playbookReady = (
        machine.persistentFiles.get(".ascii/playbook.json")?.toString("utf8").trim().length ?? 0
      ) > 0;
      let bundledSkillReady = false;
      for (const path of machine.persistentFiles.keys()) {
        if (
          path.startsWith(".companion/runtime/image/companion-")
          && path.endsWith(".tar.gz.b64")
        ) {
          bundledSkillReady = true;
          break;
        }
      }
      if (!brokerReady || !bundledSkillReady || !playbookReady) {
        return failed("simulated runtime image prerequisites are missing");
      }
      return ok("companion-runtime-playbook-ready\n");
    }
    case "apply-control-bundle":
      return appliedControlBundle(machine);
    case "mkdir-extensions":
      machine.extensionDirectoryCreated = true;
      return ok();
    case "clear-skill-archives": {
      if (command.includes('rm -rf "$root/state/skill-archives"')) {
        clearStagedSkillArchives(machine);
      }
      const output: string[] = [];
      if (machine.persistentFiles.has(".companion/pi/auth.json")) {
        output.push("companion-provider-auth-present");
      }
      const installedRevision = machine.persistentFiles
        .get(".companion/runtime/state/skills-tree.version")?.toString("utf8").trim();
      const expectedRevision = command.match(/[0-9a-f]{64}/)?.[0];
      if (
        command.includes("companion-skills-tree-reused")
        && (!expectedRevision || expectedRevision === installedRevision)
      ) output.push("companion-skills-tree-reused");
      return ok(output.length ? `${output.join("\n")}\n` : "");
    }
    case "remove-plugin-skills": {
      // Mirrors the runtime's detached-plugin cleanup: drop the staged per-plugin skill dirs.
      for (const match of command.matchAll(/skills\/(plugin-[a-z]+)/g)) {
        const prefix = `.companion/runtime/skills/${match[1]}/`;
        for (const path of machine.persistentFiles.keys()) {
          if (path.startsWith(prefix)) machine.persistentFiles.delete(path);
        }
      }
      return ok();
    }
    case "measure-skill-archives":
      return measuredArchives(machine);
    case "read-skills-revision": {
      const revision = machine.persistentFiles
        .get(".companion/runtime/state/skills-tree.version")?.toString("utf8").trim();
      return revision && /^[0-9a-f]{64}$/.test(revision)
        ? ok(`${revision}\n`)
        : failed("simulated Skills revision is missing or corrupt");
    }
    case "match-skills-revision": {
      const revision = machine.persistentFiles
        .get(".companion/runtime/state/skills-tree.version")?.toString("utf8").trim();
      const expectedRevision = command.match(/[0-9a-f]{64}/)?.[0];
      return revision && expectedRevision === revision
        ? ok()
        : failed("simulated Skills revision does not match");
    }
    case "join-file-parts":
      return joinedFileCommand(machine, command);
    case "prepare-skills":
      for (const path of machine.persistentFiles.keys()) {
        if (path.startsWith(".companion/runtime/state/skill-archives/")) {
          machine.persistentFiles.delete(path);
        }
      }
      machine.persistentFiles.set(".companion/runtime/skills/.box-sim-prepared", Buffer.alloc(0));
      {
        const revision = command.match(/[0-9a-f]{64}/)?.[0];
        if (revision) {
          machine.persistentFiles.set(
            ".companion/runtime/state/skills-tree.version",
            Buffer.from(`${revision}\n`),
          );
        }
        const nextManifest = machine.persistentFiles
          .get(".companion/runtime/state/skills.json.next");
        if (nextManifest) {
          machine.persistentFiles.set(".companion/runtime/state/skills.json", nextManifest);
          machine.persistentFiles.delete(".companion/runtime/state/skills.json.next");
        }
      }
      return ok();
    case "agent-register":
      return registeredAgentEndpoint(machine, command);
    case "start-or-restart-daemon":
      return startDaemon(machine, command.includes("systemctl --user restart"));
    case "daemon-state": {
      const marker = machine.daemon.rpcReady
        ? "companion-pi-broker-ready"
        : "companion-pi-broker-unready";
      return ok(`${machine.daemon.status === "active" ? "active" : machine.daemon.status}\n${marker}\n`);
    }
    case "rpc-command":
      return executeRpc(machine, command);
    case "extension-ui-response":
      return executeExtensionResponse(machine, command);
    case "daemon-diagnostics": {
      const status = machine.daemon.status;
      const lines = [
        `companion-pi-state ${status}`,
        `companion-pi-status Active: ${status}`,
        `companion-pi-restarts ${machine.daemon.restartCount}`,
      ];
      const stderr = machine.daemon.stderrLog.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (stderr) lines.push(`companion-pi-stderr ${stderr.replaceAll("providers.env", "[redacted]")}`);
      return ok(`${lines.join("\n")}\n`);
    }
    case "remove-control-bundle":
      machine.persistentFiles.delete(".companion/runtime/state/control-bundle-v1.json");
      for (const path of machine.persistentFiles.keys()) {
        if (path.startsWith(".companion/runtime/control-transaction-v1/")) {
          machine.persistentFiles.delete(path);
        }
      }
      return ok();
    case "remove-provider-files":
      machine.persistentFiles.delete(".companion/runtime/state/providers.env");
      machine.volatileFiles.delete("run/user/1000/companion/providers.env");
      if (command.includes(".companion/pi/auth.json")) {
        machine.persistentFiles.delete(".companion/pi/auth.json");
      }
      if (command.includes("control-bundle-v1.json")) {
        machine.persistentFiles.delete(".companion/runtime/state/control-bundle-v1.json");
      }
      for (const path of machine.persistentFiles.keys()) {
        if (path.startsWith(".companion/runtime/control-transaction-v1/")) {
          machine.persistentFiles.delete(path);
        }
      }
      return ok();
    case "terminate-daemon-invocation": {
      const encodedExpected = /expected_invocation=('(?:[^']|'"'"')*')/.exec(command)?.[1];
      const expected = encodedExpected ? decodeShellQuoted(encodedExpected) : null;
      if (!expected) return failed("simulated exact Pi invocation is unreadable");
      if (machine.daemon.status !== "active" || machine.daemon.invocationId === null) {
        return ok("companion-pi-termination-already-gone\n");
      }
      if (machine.daemon.invocationId !== expected) {
        return ok("companion-pi-termination-superseded\n");
      }
      try {
        await machine.piController?.stop();
      } catch {
        return failed("simulated Pi controller failed to stop");
      }
      appendPiProcessExit(machine);
      machine.daemon.status = "inactive";
      machine.daemon.invocationId = null;
      machine.daemon.rpcReady = false;
      machine.daemon.activeAttemptId = null;
      machine.volatileFiles.clear();
      return ok("companion-pi-termination-terminated\n");
    }
    case "stop-daemon":
      try {
        await machine.piController?.stop();
      } catch {
        return failed("simulated Pi controller failed to stop");
      }
      appendPiProcessExit(machine);
      machine.daemon.status = "inactive";
      machine.daemon.invocationId = null;
      machine.daemon.rpcReady = false;
      machine.daemon.activeAttemptId = null;
      machine.volatileFiles.clear();
      return ok();
    case "prepare-attachments": {
      // The staging root is replaced, not added to, so a retried attempt stages exactly what it was
      // given. A directory whose write bit was cleared cannot have its entries unlinked, which is
      // what makes a re-stage fail on a real Box -- model that rather than deleting unconditionally.
      const directory = attachmentDirectory(command);
      if (!directory) return failed("simulated attachment directory is unreadable");
      for (const locked of machine.readOnlyDirectories) {
        if (locked === directory || locked.startsWith(`${directory}/`)) {
          return failed(`rm: cannot remove '${locked}': Permission denied`);
        }
      }
      for (const path of machine.persistentFiles.keys()) {
        if (path.startsWith(`${directory}/`)) machine.persistentFiles.delete(path);
      }
      return ok();
    }
    case "lock-attachments": {
      // `chmod a-w` over files only leaves the directory writable; a recursive chmod would also
      // clear the directory's own write bit, which is the case this models.
      const directory = lockedAttachmentDirectory(command);
      if (directory && !command.includes("-type f")) machine.readOnlyDirectories.add(directory);
      return ok();
    }
    case "clear-outbox":
      for (const path of machine.persistentFiles.keys()) {
        if (path.startsWith("outbox/")) machine.persistentFiles.delete(path);
      }
      return ok();
    case "list-outbox": {
      const lines = [...machine.persistentFiles.entries()]
        .filter(([path]) => path.startsWith("outbox/") && !path.slice(7).includes("/"))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([path, bytes]) => [
          sha256(bytes),
          String(bytes.byteLength),
          Buffer.from(path.slice("outbox/".length), "utf8").toString("base64"),
        ].join(" "));
      return ok([
        "companion-outbox-manifest-begin",
        ...lines,
        "companion-outbox-manifest-end",
        "",
      ].join("\n"));
    }
    case "read-outbox-chunk": {
      const request = outboxChunkRequest(command);
      if (!request) return failed("simulated outbox chunk request is unreadable");
      const bytes = machine.persistentFiles.get(`outbox/${request.name}`);
      // `dd` on a missing file writes nothing and this shim answers the same way, so the caller's
      // whole-file digest check is what reports the loss.
      const slice = bytes
        ? bytes.subarray(
            request.index * request.chunkBytes,
            (request.index + 1) * request.chunkBytes,
          )
        : Buffer.alloc(0);
      const encoded = machine.mangleOutboxChunkBytes === null
        ? slice.toString("base64")
        : slice.subarray(0, machine.mangleOutboxChunkBytes).toString("base64");
      return ok([
        "companion-outbox-chunk-begin",
        encoded,
        "companion-outbox-chunk-end",
        "",
      ].join("\n"));
    }
    case "unsupported": {
      const digest = sha256(command);
      machine.unknownCommandDigests.push(digest);
      return failed(`unsupported simulated Box command (${digest.slice(0, 12)})`, 127);
    }
  }
}
