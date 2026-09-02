/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Existing simulator boundary parsing predates the incremental anti-slop gate. */

import {
  appendPiEvent,
  appendPiFault,
  appendPiProcessExit,
  createBoxSimCommandMachine,
  executeBoxCommand,
  normalizeBoxPath,
  putBoxFile,
  sha256,
  type BoxSimCommandMachine,
} from "./commandShims";
import {
  BoxSimHttpError,
  DEFAULT_BOX_SIM_DEFAULTS,
  type BoxSimBox,
  type BoxSimBoxState,
  type BoxSimCommandResult,
  type BoxSimDefaults,
  type BoxSimDeletionOperation,
  type BoxSimFaultAction,
  type BoxSimFaultRule,
  type BoxSimFaultRuleInput,
  type BoxSimNamedSnapshot,
  type BoxSimPiControllerFactory,
  type BoxSimRequestJournalEntry,
  type BoxSimStateSnapshot,
} from "./protocol";

interface BoxRecord {
  box: BoxSimBox;
  pendingStates: BoxSimBoxState[];
  setupScriptSha256: string | null;
  machine: BoxSimCommandMachine;
}

interface NamedSnapshotRecord {
  snapshot: BoxSimNamedSnapshot;
  files: Map<string, Buffer>;
  layoutInstalled: boolean;
}

interface DeletionRecord {
  operation: BoxSimDeletionOperation;
  remainingPolls: number;
  updatedTick: number;
}

export interface BoxSimulatorOptions {
  defaults?: Partial<BoxSimDefaults>;
  /** `null` explicitly disables Pi; omission is interpreted by the server, not this state class. */
  piControllerFactory?: BoxSimPiControllerFactory | null;
}

export interface CreateBoxInput {
  ttlSeconds?: number;
  setupScript?: string;
  /** Accepted for provider fidelity, intentionally not retained in simulator state. */
  env?: Record<string, unknown>;
  environment?: string;
  noEnv?: boolean;
  /** Clone persistent files from a ready named snapshot. */
  from?: string;
  idempotencyKey?: string;
}

const NAMED_SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAMED_SNAPSHOT_LIMIT = 10;
const BOX_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const BOX_ID_SEED = "23456789";
// ascii.dev exposes `provisioned` once the disk is bootable and accepts file/command work before
// its later readiness observation. The runtime image builder intentionally starts staging there.
const RUNNABLE_STATES = new Set<BoxSimBoxState>(["provisioned", "ready", "running", "idle"]);
const BOX_STATES = new Set<BoxSimBoxState>([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
]);

function publicBox(record: BoxRecord): BoxSimBox {
  return { ...record.box };
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new BoxSimHttpError(400, "invalid_request", `${name} must be a positive integer`);
  }
  return Number(value);
}

function assertNamedSnapshotName(name: string): string {
  if (!NAMED_SNAPSHOT_NAME.test(name)) {
    throw new BoxSimHttpError(400, "invalid_request", "invalid named snapshot name");
  }
  return name;
}

function validateDefaults(input: Partial<BoxSimDefaults>, current: BoxSimDefaults): BoxSimDefaults {
  if (input.archiveStates !== undefined && !Array.isArray(input.archiveStates)) {
    throw new BoxSimHttpError(
      400,
      "invalid_defaults",
      "archiveStates must contain at least one valid Box state",
    );
  }
  const archiveStates = input.archiveStates === undefined
    ? [...current.archiveStates]
    : [...input.archiveStates];
  if (archiveStates.length === 0 || archiveStates.some((state) => !BOX_STATES.has(state))) {
    throw new BoxSimHttpError(
      400,
      "invalid_defaults",
      "archiveStates must contain at least one valid Box state",
    );
  }
  if (archiveStates.at(-1) !== "archived") {
    throw new BoxSimHttpError(400, "invalid_defaults", "archiveStates must end in archived");
  }
  const scenario = input.piScenario ?? current.piScenario;
  if (typeof scenario !== "string" || scenario.trim() === "") {
    throw new BoxSimHttpError(400, "invalid_defaults", "piScenario must be a non-empty string");
  }
  if (input.desktopAvailable !== undefined && typeof input.desktopAvailable !== "boolean") {
    throw new BoxSimHttpError(400, "invalid_defaults", "desktopAvailable must be a boolean");
  }
  return {
    createPolls: input.createPolls === undefined
      ? current.createPolls
      : validatePositiveInteger(input.createPolls, "createPolls"),
    resumePolls: input.resumePolls === undefined
      ? current.resumePolls
      : validatePositiveInteger(input.resumePolls, "resumePolls"),
    deletePolls: input.deletePolls === undefined
      ? current.deletePolls
      : validatePositiveInteger(input.deletePolls, "deletePolls"),
    ttlSeconds: input.ttlSeconds === undefined
      ? current.ttlSeconds
      : validatePositiveInteger(input.ttlSeconds, "ttlSeconds"),
    desktopAvailable: input.desktopAvailable ?? current.desktopAvailable,
    archiveStates,
    piScenario: scenario.trim(),
  };
}

function observedReadyStates(
  polls: number,
  initial: "provisioning" | "archived" | "cloning",
): BoxSimBoxState[] {
  if (polls === 1) return ["ready"];
  const fill: BoxSimBoxState = initial === "cloning" ? "cloning" : "provisioning";
  const result = Array<BoxSimBoxState>(polls - 1).fill(fill);
  result[result.length - 1] = "provisioned";
  result.push("ready");
  return result;
}

function incrementSeed(seed: string, amount: number): string {
  const digits = [...seed].map((character) => {
    const value = BOX_ID_ALPHABET.indexOf(character);
    if (value < 0) throw new Error("invalid deterministic Box id seed");
    return value;
  });
  let carry = amount;
  for (let index = digits.length - 1; index >= 0 && carry > 0; index -= 1) {
    const value = digits[index]! + carry;
    digits[index] = value % BOX_ID_ALPHABET.length;
    carry = Math.floor(value / BOX_ID_ALPHABET.length);
  }
  if (carry > 0) throw new Error("deterministic Box id space exhausted");
  return digits.map((digit) => BOX_ID_ALPHABET[digit]!).join("");
}

function cloneFileMap(files: Map<string, Buffer>): Map<string, Buffer> {
  return new Map([...files.entries()].map(([path, bytes]) => [path, Buffer.from(bytes)]));
}

function publicNamedSnapshot(record: NamedSnapshotRecord): BoxSimNamedSnapshot {
  return { ...record.snapshot };
}

function sortedObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

export class BoxSimulator {
  #defaults: BoxSimDefaults;
  readonly #initialDefaults: BoxSimDefaults;
  readonly #piControllerFactory: BoxSimPiControllerFactory | undefined;
  readonly #boxes = new Map<string, BoxRecord>();
  readonly #createIdempotency = new Map<string, { fingerprint: string; boxId: string }>();
  readonly #namedSnapshots = new Map<string, NamedSnapshotRecord>();
  readonly #deletions = new Map<string, DeletionRecord>();
  readonly #faults = new Map<string, BoxSimFaultRule>();
  readonly #requests: BoxSimRequestJournalEntry[] = [];
  #hostedUrlFactory: ((port: number) => string) | undefined;
  #tick = 0;
  #boxSequence = 0;
  #deletionSequence = 0;
  #faultSequence = 0;
  #requestSequence = 0;
  #desktopSequence = 0;

  constructor(options: BoxSimulatorOptions = {}) {
    const base: BoxSimDefaults = {
      ...DEFAULT_BOX_SIM_DEFAULTS,
      archiveStates: [...DEFAULT_BOX_SIM_DEFAULTS.archiveStates],
    };
    this.#defaults = validateDefaults(options.defaults ?? {}, base);
    this.#initialDefaults = { ...this.#defaults, archiveStates: [...this.#defaults.archiveStates] };
    this.#piControllerFactory = options.piControllerFactory ?? undefined;
  }

  get defaults(): BoxSimDefaults {
    return { ...this.#defaults, archiveStates: [...this.#defaults.archiveStates] };
  }

  get currentTick(): number {
    return this.#tick;
  }

  #nextTick(): number {
    this.#tick += 1;
    return this.#tick;
  }

  #record(boxId: string): BoxRecord {
    const record = this.#boxes.get(boxId);
    if (!record) throw new BoxSimHttpError(404, "box_not_found", `Box ${boxId} was not found`);
    return record;
  }

  #deletion(operationId: string): DeletionRecord {
    const record = this.#deletions.get(operationId);
    if (!record) {
      throw new BoxSimHttpError(
        404,
        "deletion_operation_not_found",
        `Deletion operation ${operationId} was not found`,
      );
    }
    return record;
  }

  /**
   * Wire the base URL a `host <port>` registration mints. The server owns the agent listener and
   * only knows its address after listen(), so the factory is late-bound here and copied onto every
   * machine, including ones created before the server attached to a caller-supplied simulator.
   */
  setHostedUrlFactory(factory: ((port: number) => string) | undefined): void {
    this.#hostedUrlFactory = factory;
    for (const { machine } of this.#boxes.values()) machine.hostedUrlFactory = factory;
  }

  configureDefaults(patch: Partial<BoxSimDefaults>): BoxSimDefaults {
    this.#defaults = validateDefaults(patch, this.#defaults);
    this.#nextTick();
    return this.defaults;
  }

  async reset(): Promise<void> {
    await Promise.allSettled([...this.#boxes.values()].map(async ({ machine }) => {
      await machine.piController?.dispose();
    }));
    this.#boxes.clear();
    this.#createIdempotency.clear();
    this.#namedSnapshots.clear();
    this.#deletions.clear();
    this.#faults.clear();
    this.#requests.length = 0;
    this.#defaults = {
      ...this.#initialDefaults,
      archiveStates: [...this.#initialDefaults.archiveStates],
    };
    this.#tick = 0;
    this.#boxSequence = 0;
    this.#deletionSequence = 0;
    this.#faultSequence = 0;
    this.#requestSequence = 0;
    this.#desktopSequence = 0;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#boxes.values()].map(async ({ machine }) => {
      await machine.piController?.dispose();
    }));
  }

  recordRequest(input: {
    surface: "box" | "control";
    method: string;
    path: string;
    body?: unknown;
  }): void {
    this.#requestSequence += 1;
    this.#requests.push({
      sequence: this.#requestSequence,
      tick: this.#tick,
      surface: input.surface,
      method: input.method,
      path: input.path,
      bodyKeys: sortedObjectKeys(input.body),
    });
  }

  async createBox(input: CreateBoxInput = {}): Promise<BoxSimBox> {
    const idempotencyKey = input.idempotencyKey?.trim();
    const fingerprint = JSON.stringify({ ...input, idempotencyKey: undefined });
    if (idempotencyKey) {
      const prior = this.#createIdempotency.get(idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new BoxSimHttpError(409, "idempotency_key_reused", "Idempotency key was reused");
        }
        return publicBox(this.#record(prior.boxId));
      }
    }
    const from = typeof input.from === "string" ? input.from.trim() : "";
    let cloned: NamedSnapshotRecord | undefined;
    if (from) {
      cloned = this.#namedSnapshots.get(from);
      if (!cloned || cloned.snapshot.status !== "ready") {
        throw new BoxSimHttpError(404, "unknown_snapshot", `Named snapshot ${from} was not found`);
      }
    }
    const id = `bx_${incrementSeed(BOX_ID_SEED, this.#boxSequence)}`;
    this.#boxSequence += 1;
    const tick = this.#nextTick();
    const machine = createBoxSimCommandMachine({ boxId: id, scenario: this.#defaults.piScenario });
    machine.hostedUrlFactory = this.#hostedUrlFactory;
    if (cloned) {
      machine.persistentFiles = cloneFileMap(cloned.files);
      machine.layoutInstalled = cloned.layoutInstalled;
    }
    const cloning = Boolean(cloned);
    const record: BoxRecord = {
      box: {
        id,
        name: `box-sim-${id.slice(3)}`,
        state: cloning ? "cloning" : "provisioning",
        desktopAvailable: this.#defaults.desktopAvailable,
        setupStatus: "running",
        setupError: null,
        ttlSeconds: input.ttlSeconds === undefined
          ? this.#defaults.ttlSeconds
          : validatePositiveInteger(input.ttlSeconds, "ttlSeconds"),
        createdTick: tick,
        updatedTick: tick,
      },
      pendingStates: observedReadyStates(
        this.#defaults.createPolls,
        cloning ? "cloning" : "provisioning",
      ),
      setupScriptSha256: typeof input.setupScript === "string" ? sha256(input.setupScript) : null,
      machine,
    };
    this.#boxes.set(id, record);
    if (idempotencyKey) this.#createIdempotency.set(idempotencyKey, { fingerprint, boxId: id });
    if (this.#piControllerFactory) {
      try {
        machine.piController = this.#piControllerFactory({
          boxId: id,
          appendEvent: (event) => appendPiEvent(machine, event),
          appendFault: (fault) => appendPiFault(machine, fault),
          currentInvocationId: () => machine.daemon.invocationId,
        });
        await machine.piController.setScenario(this.#defaults.piScenario);
      } catch {
        this.#boxes.delete(id);
        await Promise.resolve(machine.piController?.dispose()).catch(() => undefined);
        throw new BoxSimHttpError(502, "pi_scenario_failed", "Pi simulator scenario could not be set");
      }
    }
    return publicBox(record);
  }

  listNamedSnapshots(): BoxSimNamedSnapshot[] {
    this.#nextTick();
    return [...this.#namedSnapshots.values()]
      .map((record) => this.#settleNamedSnapshot(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getNamedSnapshot(name: string): BoxSimNamedSnapshot {
    const record = this.#namedSnapshots.get(assertNamedSnapshotName(name));
    if (!record) {
      throw new BoxSimHttpError(404, "unknown_snapshot", `Named snapshot ${name} was not found`);
    }
    this.#nextTick();
    return this.#settleNamedSnapshot(record);
  }

  saveNamedSnapshot(input: { boxId: string; name: string }): BoxSimNamedSnapshot {
    const name = assertNamedSnapshotName(input.name);
    const record = this.#record(input.boxId);
    if (!this.#namedSnapshots.has(name) && this.#namedSnapshots.size >= NAMED_SNAPSHOT_LIMIT) {
      throw new BoxSimHttpError(409, "named_snapshot_limit", "Named snapshot limit reached");
    }
    const tick = this.#nextTick();
    const saved: NamedSnapshotRecord = {
      snapshot: {
        name,
        status: "saving",
        sourceBoxId: record.box.id,
        createdAt: new Date(Date.UTC(2026, 7, 19, 0, 0, tick)).toISOString(),
      },
      files: cloneFileMap(record.machine.persistentFiles),
      layoutInstalled: record.machine.layoutInstalled,
    };
    this.#namedSnapshots.set(name, saved);
    return publicNamedSnapshot(saved);
  }

  deleteNamedSnapshot(name: string): void {
    const key = assertNamedSnapshotName(name);
    if (!this.#namedSnapshots.delete(key)) {
      throw new BoxSimHttpError(404, "unknown_snapshot", `Named snapshot ${name} was not found`);
    }
    this.#nextTick();
  }

  #settleNamedSnapshot(record: NamedSnapshotRecord): BoxSimNamedSnapshot {
    if (record.snapshot.status === "saving") record.snapshot.status = "ready";
    return publicNamedSnapshot(record);
  }

  getBox(boxId: string, advance = true): BoxSimBox {
    const record = this.#record(boxId);
    const tick = this.#nextTick();
    if (advance) this.#advanceRecord(record, 1, tick);
    return publicBox(record);
  }

  listBoxes(input: { cursor?: string | null; limit?: number; sort?: "asc" | "desc" } = {}): {
    boxes: BoxSimBox[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  } {
    this.#nextTick();
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
    const ordered = [...this.#boxes.values()]
      .sort((left, right) => left.box.id.localeCompare(right.box.id));
    if (input.sort === "desc") ordered.reverse();
    const cursorIndex = input.cursor
      ? ordered.findIndex((record) => record.box.id === input.cursor)
      : -1;
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const page = ordered.slice(start, start + limit);
    const hasMore = start + page.length < ordered.length;
    return {
      boxes: page.map(publicBox),
      pageInfo: {
        hasMore,
        nextCursor: hasMore ? page.at(-1)?.box.id ?? null : null,
      },
    };
  }

  patchBox(boxId: string, patch: { name?: string; ttlSeconds?: number }): BoxSimBox {
    const record = this.#record(boxId);
    const tick = this.#nextTick();
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BoxSimHttpError(400, "invalid_request", "name must not be empty");
      const duplicate = [...this.#boxes.values()].some((candidate) =>
        candidate.box.id !== boxId && candidate.box.name === name);
      if (duplicate) throw new BoxSimHttpError(409, "box_name_conflict", `Box name ${name} is in use`);
      record.box.name = name;
    }
    if (patch.ttlSeconds !== undefined) {
      record.box.ttlSeconds = validatePositiveInteger(patch.ttlSeconds, "ttlSeconds");
    }
    record.box.updatedTick = tick;
    return publicBox(record);
  }

  async stopBox(boxId: string): Promise<BoxSimBox> {
    const record = this.#record(boxId);
    if (record.box.state === "archived" || record.box.state === "archiving") {
      throw new BoxSimHttpError(409, "box_already_stopping", `Box ${boxId} is already stopping`);
    }
    const tick = this.#nextTick();
    // A provider stop tears down the machine even when the client did not first stop its daemon.
    // Preserve the Box disk, but make every process and tmpfs-backed credential disappear.
    await Promise.resolve(record.machine.piController?.stop()).catch(() => undefined);
    record.machine.daemon.status = "inactive";
    record.machine.daemon.invocationId = null;
    record.machine.daemon.rpcReady = false;
    record.machine.volatileFiles.clear();
    const states = [...this.#defaults.archiveStates];
    record.box.state = states.shift()!;
    record.box.desktopAvailable = false;
    record.box.updatedTick = tick;
    record.pendingStates = states;
    return publicBox(record);
  }

  resumeBox(boxId: string, input: { ttlSeconds?: number } = {}): BoxSimBox {
    const record = this.#record(boxId);
    if (record.box.state !== "archived" && record.box.state !== "idle") {
      throw new BoxSimHttpError(409, "box_not_resumable", `Box ${boxId} cannot resume from ${record.box.state}`);
    }
    const tick = this.#nextTick();
    record.box.state = "provisioning";
    record.box.desktopAvailable = this.#defaults.desktopAvailable;
    record.box.updatedTick = tick;
    if (input.ttlSeconds !== undefined) {
      record.box.ttlSeconds = validatePositiveInteger(input.ttlSeconds, "ttlSeconds");
    }
    // ascii.dev writes its boot playbook during resume. Runtime-image warmup must observe this
    // provider-owned artifact before a snapshot is eligible for publication.
    putBoxFile(
      record.machine,
      ".ascii/playbook.json",
      Buffer.from('{"provider":"box-sim","boot":"resumed"}\n'),
    );
    record.pendingStates = observedReadyStates(this.#defaults.resumePolls, "archived");
    return publicBox(record);
  }

  async deleteBox(boxId: string): Promise<BoxSimDeletionOperation> {
    const record = this.#record(boxId);
    if (record.machine.piController) {
      await Promise.resolve(record.machine.piController.dispose()).catch(() => undefined);
    }
    this.#boxes.delete(boxId);
    this.#deletionSequence += 1;
    const tick = this.#nextTick();
    const operation: BoxSimDeletionOperation = {
      id: `bdop_${this.#deletionSequence.toString(16).padStart(32, "0")}`,
      targetId: boxId,
      status: "pending",
      attemptCount: 0,
      requestedAt: new Date(tick * 1_000).toISOString(),
      completedAt: null,
    };
    this.#deletions.set(operation.id, {
      operation,
      remainingPolls: this.#defaults.deletePolls,
      updatedTick: tick,
    });
    return { ...operation };
  }

  getDeletionOperation(operationId: string, advance = true): BoxSimDeletionOperation {
    const record = this.#deletion(operationId);
    const tick = this.#nextTick();
    if (
      advance
      && record.operation.status !== "completed"
      && record.operation.status !== "blocked"
    ) {
      record.remainingPolls -= 1;
      record.operation.status = record.remainingPolls <= 0 ? "completed" : "processing";
      record.operation.attemptCount = 1;
      record.operation.completedAt = record.operation.status === "completed"
        ? new Date(tick * 1_000).toISOString()
        : null;
      record.updatedTick = tick;
    }
    return { ...record.operation };
  }

  setDeletionOperationStatus(
    operationId: string,
    status: BoxSimDeletionOperation["status"],
  ): BoxSimDeletionOperation {
    if (!["pending", "processing", "blocked", "completed"].includes(status)) {
      throw new BoxSimHttpError(400, "invalid_deletion_status", "invalid deletion operation status");
    }
    const record = this.#deletion(operationId);
    const tick = this.#nextTick();
    record.operation.status = status;
    if (status === "processing" || status === "blocked" || status === "completed") {
      record.operation.attemptCount = Math.max(1, record.operation.attemptCount);
    }
    record.operation.completedAt = status === "completed"
      ? new Date(tick * 1_000).toISOString()
      : null;
    record.updatedTick = tick;
    return { ...record.operation };
  }

  writeFile(input: {
    boxId: string;
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
  }): { path: string; encoding: "utf8" | "base64"; size: number } {
    const record = this.#runnableRecord(input.boxId);
    const encoding = input.encoding ?? "utf8";
    if (typeof input.content !== "string") {
      throw new BoxSimHttpError(400, "invalid_request", "content must be a string");
    }
    if (encoding !== "utf8" && encoding !== "base64") {
      throw new BoxSimHttpError(400, "invalid_request", "encoding must be utf8 or base64");
    }
    let bytes: Buffer;
    if (encoding === "base64") {
      const compact = input.content.replace(/\s+/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
        throw new BoxSimHttpError(400, "invalid_base64", "content is not valid base64");
      }
      bytes = Buffer.from(compact, "base64");
    } else {
      bytes = Buffer.from(input.content, "utf8");
    }
    let path: string;
    try {
      path = normalizeBoxPath(input.path);
    } catch (error) {
      throw new BoxSimHttpError(400, "invalid_path", error instanceof Error ? error.message : "invalid path");
    }
    putBoxFile(record.machine, path, bytes);
    record.box.updatedTick = this.#nextTick();
    return { path, encoding, size: bytes.byteLength };
  }

  async executeCommand(input: {
    boxId: string;
    command: string;
    timeoutSeconds?: number;
  }): Promise<BoxSimCommandResult> {
    const record = this.#runnableRecord(input.boxId);
    if (typeof input.command !== "string" || input.command.length === 0) {
      throw new BoxSimHttpError(400, "invalid_request", "command must be a non-empty string");
    }
    const timeoutSeconds = input.timeoutSeconds === undefined
      ? 60
      : validatePositiveInteger(input.timeoutSeconds, "timeoutSeconds");
    const result = await executeBoxCommand(record.machine, input.command, timeoutSeconds);
    record.box.updatedTick = this.#nextTick();
    return result;
  }

  mintDesktop(boxId: string, transport: "vnc" | "webrtc"): {
    desktopUrl: string | null;
    provisioning: boolean;
  } {
    const record = this.#record(boxId);
    this.#nextTick();
    if (!RUNNABLE_STATES.has(record.box.state)) {
      throw new BoxSimHttpError(409, "box_not_running", `Box ${boxId} is not running`);
    }
    if (!record.box.desktopAvailable) return { desktopUrl: null, provisioning: false };
    this.#desktopSequence += 1;
    const token = this.#desktopSequence.toString(10).padStart(4, "0");
    return {
      desktopUrl: `https://desktop.box-sim.invalid/${boxId}/${transport}?token=sim-${token}`,
      provisioning: false,
    };
  }

  tickBox(boxId: string, count = 1): BoxSimBox {
    const record = this.#record(boxId);
    const ticks = validatePositiveInteger(count, "count");
    for (let index = 0; index < ticks; index += 1) {
      this.#advanceRecord(record, 1, this.#nextTick());
    }
    return publicBox(record);
  }

  async setScenario(boxId: string, scenario: string): Promise<void> {
    const record = this.#record(boxId);
    if (typeof scenario !== "string" || scenario.trim() === "") {
      throw new BoxSimHttpError(400, "invalid_scenario", "scenario must be a non-empty string");
    }
    await record.machine.piController?.setScenario(scenario.trim());
    record.machine.daemon.scenario = scenario.trim();
    record.box.updatedTick = this.#nextTick();
  }

  async crashPi(boxId: string): Promise<void> {
    const record = this.#record(boxId);
    await record.machine.piController?.crash();
    appendPiProcessExit(record.machine);
    record.machine.daemon.status = "failed";
    record.machine.daemon.rpcReady = false;
    record.machine.daemon.stderrLog += "simulated Pi process crashed\n";
    record.box.updatedTick = this.#nextTick();
  }

  /**
   * Put files in Pi's outbox, as if Pi had produced them during a turn. This is the deterministic
   * stand-in for an agent deciding to show the user an image, so a harvest can be driven exactly.
   */
  seedOutbox(boxId: string, files: { name: string; base64: string }[]): number {
    const machine = this.#record(boxId).machine;
    for (const file of files) {
      if (typeof file?.name !== "string" || !file.name || file.name.includes("/")) {
        throw new BoxSimHttpError(400, "invalid_outbox_file", "outbox file name is invalid");
      }
      if (typeof file.base64 !== "string") {
        throw new BoxSimHttpError(400, "invalid_outbox_file", "outbox file bytes are invalid");
      }
      putBoxFile(machine, `outbox/${file.name}`, Buffer.from(file.base64, "base64"));
    }
    this.#record(boxId).box.updatedTick = this.#nextTick();
    return files.length;
  }

  /**
   * Truncate every outbox chunk the Box returns, reproducing the command transport's habit of
   * mangling large bodies. Null restores an honest transport.
   */
  setOutboxTransportMangling(boxId: string, mangleChunkBytes: number | null): void {
    if (
      mangleChunkBytes !== null
      && (!Number.isSafeInteger(mangleChunkBytes) || mangleChunkBytes < 0)
    ) {
      throw new BoxSimHttpError(400, "invalid_mangling", "mangleChunkBytes must be null or >= 0");
    }
    this.#record(boxId).machine.mangleOutboxChunkBytes = mangleChunkBytes;
  }

  /** Local test hook. Unlike the control snapshot, this may expose virtual file contents. */
  commandMachine(boxId: string): BoxSimCommandMachine {
    return this.#record(boxId).machine;
  }

  addFault(input: BoxSimFaultRuleInput): BoxSimFaultRule {
    if (typeof input.point !== "string" || input.point.trim() === "") {
      throw new BoxSimHttpError(400, "invalid_fault", "fault point must be a non-empty string");
    }
    const occurrence = input.occurrence === undefined
      ? 1
      : validatePositiveInteger(input.occurrence, "occurrence");
    if (input.repeat !== undefined && typeof input.repeat !== "boolean") {
      throw new BoxSimHttpError(400, "invalid_fault", "fault repeat must be a boolean");
    }
    if (!input.action || typeof input.action !== "object") {
      throw new BoxSimHttpError(400, "invalid_fault", "fault action must be an object");
    }
    switch (input.action.kind) {
      case "http":
        if (!Number.isSafeInteger(input.action.status) || input.action.status < 400 || input.action.status > 599) {
          throw new BoxSimHttpError(400, "invalid_fault", "HTTP fault status must be between 400 and 599");
        }
        if (input.action.code !== undefined && typeof input.action.code !== "string") {
          throw new BoxSimHttpError(400, "invalid_fault", "HTTP fault code must be a string");
        }
        if (input.action.message !== undefined && typeof input.action.message !== "string") {
          throw new BoxSimHttpError(400, "invalid_fault", "HTTP fault message must be a string");
        }
        break;
      case "command":
        if (input.action.success !== undefined && typeof input.action.success !== "boolean") {
          throw new BoxSimHttpError(400, "invalid_fault", "command fault success must be a boolean");
        }
        if (
          input.action.exitCode !== undefined
          && input.action.exitCode !== null
          && !Number.isSafeInteger(input.action.exitCode)
        ) {
          throw new BoxSimHttpError(400, "invalid_fault", "command fault exitCode must be an integer or null");
        }
        if (input.action.stdout !== undefined && typeof input.action.stdout !== "string") {
          throw new BoxSimHttpError(400, "invalid_fault", "command fault stdout must be a string");
        }
        if (input.action.stderr !== undefined && typeof input.action.stderr !== "string") {
          throw new BoxSimHttpError(400, "invalid_fault", "command fault stderr must be a string");
        }
        break;
      case "disconnect":
      case "stall":
        break;
      default:
        throw new BoxSimHttpError(400, "invalid_fault", "unknown fault action kind");
    }
    this.#faultSequence += 1;
    const id = input.id?.trim() || `flt_${this.#faultSequence.toString(10).padStart(4, "0")}`;
    if (this.#faults.has(id)) throw new BoxSimHttpError(409, "fault_conflict", `Fault ${id} exists`);
    const rule: BoxSimFaultRule = {
      ...input,
      id,
      point: input.point.trim(),
      occurrence,
      repeat: input.repeat ?? false,
      visits: 0,
      fired: 0,
    };
    this.#faults.set(id, rule);
    this.#nextTick();
    return structuredClone(rule);
  }

  removeFault(id: string): boolean {
    const removed = this.#faults.delete(id);
    if (removed) this.#nextTick();
    return removed;
  }

  consumeFault(point: string): BoxSimFaultAction | null {
    for (const rule of this.#faults.values()) {
      if (rule.point !== point) continue;
      rule.visits += 1;
      const fires = rule.repeat ? rule.visits >= rule.occurrence : rule.visits === rule.occurrence;
      if (!fires) continue;
      rule.fired += 1;
      this.#nextTick();
      return structuredClone(rule.action);
    }
    return null;
  }

  snapshot(): BoxSimStateSnapshot {
    const boxes = [...this.#boxes.values()]
      .sort((left, right) => left.box.id.localeCompare(right.box.id))
      .map((record) => {
        const files = [
          ...[...record.machine.persistentFiles.entries()].map(([path, bytes]) => ({
            path,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
            volatile: false,
          })),
          ...[...record.machine.volatileFiles.entries()].map(([path, bytes]) => ({
            path,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
            volatile: true,
          })),
        ].sort((left, right) => left.path.localeCompare(right.path));
        return {
          ...publicBox(record),
          pendingStates: [...record.pendingStates],
          setupScriptSha256: record.setupScriptSha256,
          files,
          daemon: {
            status: record.machine.daemon.status,
            invocationId: record.machine.daemon.invocationId,
            layoutMarker: record.machine.persistentFiles.get(
              ".companion/runtime/state/pi-layout.version",
            )?.toString("utf8").trim() || null,
            rpcReady: record.machine.daemon.rpcReady,
            activeAttemptId: record.machine.daemon.activeAttemptId,
            tailCursor: record.machine.daemon.brokerJournal.at(-1)?.sequence ?? 0,
            acknowledgedCursor: record.machine.daemon.brokerAcknowledgedCursor,
            counters: { ...record.machine.daemon.brokerCounters },
            restartCount: record.machine.daemon.restartCount,
            scenario: record.machine.daemon.scenario,
            stderrSha256: sha256(record.machine.daemon.stderrLog),
            unknownCommandDigests: [...record.machine.unknownCommandDigests],
          },
        };
      });
    return {
      tick: this.#tick,
      defaults: this.defaults,
      boxes,
      deletions: [...this.#deletions.values()]
        .map(({ operation }) => ({ ...operation }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      namedSnapshots: [...this.#namedSnapshots.values()]
        .map((record) => publicNamedSnapshot(record))
        .sort((left, right) => left.name.localeCompare(right.name)),
      faults: [...this.#faults.values()].map((rule) => structuredClone(rule)),
      requests: this.#requests.map((request) => ({ ...request, bodyKeys: [...request.bodyKeys] })),
    };
  }

  #runnableRecord(boxId: string): BoxRecord {
    const record = this.#record(boxId);
    if (!RUNNABLE_STATES.has(record.box.state)) {
      throw new BoxSimHttpError(409, "box_not_running", `Box ${boxId} is not running`);
    }
    return record;
  }

  #advanceRecord(record: BoxRecord, count: number, tick: number): void {
    for (let index = 0; index < count; index += 1) {
      const state = record.pendingStates.shift();
      if (!state) break;
      record.box.state = state;
      if (state === "ready" || state === "running") {
        record.box.setupStatus = "done";
        record.box.setupError = null;
        record.box.desktopAvailable = this.#defaults.desktopAvailable;
      } else if (state === "archiving" || state === "archived") {
        record.box.desktopAvailable = false;
      }
      record.box.updatedTick = tick;
    }
  }
}
