/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- The broker is the Pi JSONL/socket persistence boundary; all untrusted records are narrowed and bounded here before entering the typed runtime contract. */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const COMPANION_PI_BROKER_MAX_LINE_BYTES = 64 * 1024;
export const COMPANION_PI_BROKER_MAX_COMMAND_BYTES = 1024 * 1024;
export const COMPANION_PI_BROKER_SEGMENT_BYTES = 1024 * 1024;
export const COMPANION_PI_BROKER_READ_LIMIT = 256;
/** Leaves headroom beneath the Box adapter's 256 KiB correlated-response ceiling. */
export const COMPANION_PI_BROKER_READ_BYTES = 224 * 1024;

const SEGMENT_PATTERN = /^events-(\d{16})\.ndjson$/;
const ACK_FILE = "ack.cursor";
const COUNTERS_FILE = "counters.json";
const DISPATCH_LEDGER_MAX_RECORDS = 64;

/** Pi events understood by the Runtime v3 projection. New shapes are counted and ignored. */
export const COMPANION_PI_SUPPORTED_EVENT_TYPES = new Set([
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

export type PiJsonObject = Record<string, unknown>;

export interface CompanionPiBrokerCounters {
  malformedLines: number;
  oversizedLines: number;
  unterminatedLines: number;
  unknownEvents: number;
  unboundEvents: number;
  orphanResponses: number;
}

export type CompanionPiJournalRecord =
  | {
      sequence: number;
      invocationId: string;
      attemptId: string;
      kind: "pi_event";
      event: PiJsonObject;
    }
  | {
      sequence: number;
      invocationId: string;
      attemptId: string;
      kind: "pi_process_exit";
      exit: {
        code: number | null;
        signal: string | null;
      };
    };

export type CompanionPiJournalAppend =
  | Omit<Extract<CompanionPiJournalRecord, { kind: "pi_event" }>, "sequence">
  | Omit<Extract<CompanionPiJournalRecord, { kind: "pi_process_exit" }>, "sequence">;

export interface CompanionPiJournalRead {
  events: CompanionPiJournalRecord[];
  nextCursor: number;
  acknowledgedCursor: number;
  hasMore: boolean;
}

export interface CompanionPiRpcTransport {
  request(command: PiJsonObject): Promise<PiJsonObject>;
  send(command: PiJsonObject): Promise<void>;
}

export interface StrictLfJsonlDecoderOptions {
  maxLineBytes?: number;
  onRecord(record: PiJsonObject): void;
  onFault(fault: "malformed" | "oversized" | "unterminated"): void;
}

/**
 * Byte-framed LF JSONL decoder. It never retains an oversized record while waiting for its LF and
 * never hands malformed content to diagnostics, logs, or callers.
 */
export class StrictLfJsonlDecoder {
  readonly #maxLineBytes: number;
  readonly #onRecord: (record: PiJsonObject) => void;
  readonly #onFault: StrictLfJsonlDecoderOptions["onFault"];
  #chunks: Buffer[] = [];
  #bytes = 0;
  #discardingOversized = false;
  #finished = false;

  constructor(options: StrictLfJsonlDecoderOptions) {
    this.#maxLineBytes = positiveSafeInteger(
      options.maxLineBytes ?? COMPANION_PI_BROKER_MAX_LINE_BYTES,
      "maxLineBytes",
    );
    this.#onRecord = options.onRecord;
    this.#onFault = options.onFault;
  }

  push(chunk: Uint8Array): void {
    if (this.#finished) throw new Error("strict LF decoder is already finished");
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      this.#acceptPiece(bytes.subarray(start, index), true);
      start = index + 1;
    }
    if (start < bytes.length) this.#acceptPiece(bytes.subarray(start), false);
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#discardingOversized) this.#onFault("oversized");
    else if (this.#bytes > 0) this.#onFault("unterminated");
    this.#reset();
  }

  #acceptPiece(piece: Buffer, terminated: boolean): void {
    if (this.#discardingOversized) {
      if (terminated) {
        this.#onFault("oversized");
        this.#reset();
      }
      return;
    }

    if (this.#bytes + piece.length > this.#maxLineBytes) {
      this.#chunks = [];
      this.#bytes = 0;
      if (terminated) this.#onFault("oversized");
      else this.#discardingOversized = true;
      return;
    }

    if (piece.length > 0) {
      this.#chunks.push(Buffer.from(piece));
      this.#bytes += piece.length;
    }
    if (!terminated) return;

    if (this.#bytes === 0) {
      this.#reset();
      this.#onFault("malformed");
      return;
    }
    const line = this.#chunks.length === 1
      ? this.#chunks[0]!
      : Buffer.concat(this.#chunks, this.#bytes);
    this.#reset();
    // Literal CR is not part of layout-14 framing. Escaped `\\r` remains ordinary JSON bytes.
    if (line.includes(0x0d)) {
      this.#onFault("malformed");
      return;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      this.#onFault("malformed");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      this.#onFault("malformed");
      return;
    }
    if (!isJsonObject(parsed)) {
      this.#onFault("malformed");
      return;
    }
    // Journal or broker failures are operational failures, not malformed input. Let them escape so
    // systemd restarts the boundary instead of silently losing a valid Pi event.
    this.#onRecord(parsed);
  }

  #reset(): void {
    this.#chunks = [];
    this.#bytes = 0;
    this.#discardingOversized = false;
  }
}

export interface SegmentedCompanionPiJournalOptions {
  directory: string;
  segmentBytes?: number;
}

/** Durable single-consumer journal with monotonic sequence cursors and closed-segment retention. */
export class SegmentedCompanionPiJournal {
  readonly #directory: string;
  readonly #segmentBytes: number;
  #tail = 0;
  #acknowledged = 0;
  #counters: CompanionPiBrokerCounters = emptyCounters();
  #segmentsCache: JournalSegment[] = [];

  constructor(options: SegmentedCompanionPiJournalOptions) {
    this.#directory = options.directory;
    this.#segmentBytes = positiveSafeInteger(
      options.segmentBytes ?? COMPANION_PI_BROKER_SEGMENT_BYTES,
      "segmentBytes",
    );
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    this.#acknowledged = readCursor(join(this.#directory, ACK_FILE));
    this.#recoverSegments();
    this.#acknowledged = Math.min(this.#acknowledged, this.#tail);
    this.#counters = readCounters(join(this.#directory, COUNTERS_FILE));
    this.#persistAck();
    this.#persistCounters();
    this.#retainAcknowledgedSegments();
  }

  get tailCursor(): number {
    return this.#tail;
  }

  get acknowledgedCursor(): number {
    return this.#acknowledged;
  }

  get counters(): Readonly<CompanionPiBrokerCounters> {
    return { ...this.#counters };
  }

  append(record: CompanionPiJournalAppend): CompanionPiJournalRecord {
    if (this.#tail >= Number.MAX_SAFE_INTEGER) throw new Error("Pi event journal sequence exhausted");
    const complete = { ...record, sequence: this.#tail + 1 } as CompanionPiJournalRecord;
    const serialized = `${JSON.stringify(complete)}\n`;
    const encodedBytes = Buffer.byteLength(serialized);
    let segment = this.#currentSegment();
    let createdSegment = false;
    if (!segment || (segment.bytes > 0 && segment.bytes + encodedBytes > this.#segmentBytes)) {
      segment = {
        path: join(this.#directory, segmentName(complete.sequence)),
        start: complete.sequence,
        end: complete.sequence - 1,
        bytes: 0,
      };
      this.#segmentsCache.push(segment);
      createdSegment = true;
    }
    appendAndSync(segment.path, serialized);
    chmodSync(segment.path, 0o600);
    if (createdSegment) fsyncDirectory(this.#directory);
    segment.end = complete.sequence;
    segment.bytes += encodedBytes;
    this.#tail = complete.sequence;
    return complete;
  }

  read(after: number, limit = COMPANION_PI_BROKER_READ_LIMIT): CompanionPiJournalRead {
    const requestedAfter = nonNegativeSafeInteger(after, "after");
    const boundedLimit = positiveSafeInteger(limit, "limit");
    if (boundedLimit > COMPANION_PI_BROKER_READ_LIMIT) {
      throw new Error(`limit must be at most ${COMPANION_PI_BROKER_READ_LIMIT}`);
    }
    if (requestedAfter > this.#tail) throw new Error("cannot read beyond the journal tail");
    const effectiveAfter = Math.max(requestedAfter, this.#acknowledged);
    const events: CompanionPiJournalRecord[] = [];
    let responseBytes = 0;
    segments: for (const segment of this.#segments()) {
      if (segment.end <= effectiveAfter) continue;
      for (const record of readSegmentRecords(segment.path)) {
        if (record.sequence <= effectiveAfter) continue;
        const recordBytes = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (events.length > 0 && responseBytes + recordBytes > COMPANION_PI_BROKER_READ_BYTES) {
          break segments;
        }
        events.push(record);
        responseBytes += recordBytes;
        if (events.length === boundedLimit) break;
      }
      if (events.length === boundedLimit || responseBytes >= COMPANION_PI_BROKER_READ_BYTES) break;
    }
    const nextCursor = events.at(-1)?.sequence ?? effectiveAfter;
    return {
      events,
      nextCursor,
      acknowledgedCursor: this.#acknowledged,
      hasMore: nextCursor < this.#tail,
    };
  }

  acknowledge(through: number): number {
    const cursor = nonNegativeSafeInteger(through, "through");
    if (cursor > this.#tail) throw new Error("cannot acknowledge beyond the journal tail");
    if (cursor <= this.#acknowledged) return this.#acknowledged;
    // Publish the cursor in memory only after its durable atomic write. Otherwise a failed fsync or
    // rename would hide unacknowledged events for the rest of this broker invocation.
    this.#persistAck(cursor);
    this.#acknowledged = cursor;
    this.#retainAcknowledgedSegments();
    return this.#acknowledged;
  }

  /**
   * A fresh systemd invocation cannot resume the attempt bound by its predecessor. Retire that
   * predecessor's remaining records atomically so the explicitly interrupted turn cannot poison
   * the next user-requested retry with an forever-unacknowledgeable cursor.
   */
  beginInvocation(invocationId: string): number {
    if (!validOpaqueId(invocationId)) throw new Error("invocationId is invalid");
    if (this.#tail <= this.#acknowledged) return this.#acknowledged;
    const first = this.read(this.#acknowledged, 1).events[0];
    if (first && first.invocationId !== invocationId) return this.acknowledge(this.#tail);
    return this.#acknowledged;
  }

  recordFault(fault: keyof CompanionPiBrokerCounters): void {
    const current = this.#counters[fault];
    this.#counters[fault] = current >= Number.MAX_SAFE_INTEGER ? current : current + 1;
    this.#persistCounters();
  }

  #recoverSegments(): void {
    let expected: number | null = null;
    for (const path of this.#segmentPaths()) {
      recoverTrailingFragment(path);
      const records = readSegmentRecords(path);
      if (records.length === 0) {
        unlinkSync(path);
        continue;
      }
      const fileStart = segmentStart(path);
      if (fileStart !== records[0]!.sequence) {
        throw new Error("Pi event journal segment start does not match its first event");
      }
      if (expected === null) {
        if (fileStart > this.#acknowledged + 1) {
          throw new Error("Pi event journal begins after an unacknowledged sequence gap");
        }
        expected = fileStart;
      }
      for (const record of records) {
        if (record.sequence !== expected) {
          throw new Error("Pi event journal is not a contiguous monotonic sequence");
        }
        expected += 1;
      }
      this.#segmentsCache.push({
        path,
        start: records[0]!.sequence,
        end: records.at(-1)!.sequence,
        bytes: statSync(path).size,
      });
    }
    this.#tail = Math.max(this.#acknowledged, expected === null ? 0 : expected - 1);
  }

  #segments(): JournalSegment[] {
    return this.#segmentsCache;
  }

  #currentSegment(): JournalSegment | null {
    return this.#segments().at(-1) ?? null;
  }

  #segmentPaths(): string[] {
    return readdirSync(this.#directory)
      .filter((name) => SEGMENT_PATTERN.test(name))
      .sort()
      .map((name) => join(this.#directory, name));
  }

  #persistAck(cursor = this.#acknowledged): void {
    atomicWrite(join(this.#directory, ACK_FILE), `${cursor}\n`);
  }

  #persistCounters(): void {
    atomicWrite(join(this.#directory, COUNTERS_FILE), `${JSON.stringify(this.#counters)}\n`);
  }

  #retainAcknowledgedSegments(): void {
    let removed = false;
    while (this.#segmentsCache.length > 1) {
      const segment = this.#segmentsCache[0]!;
      if (segment.end > this.#acknowledged) break;
      unlinkSync(segment.path);
      this.#segmentsCache.shift();
      removed = true;
    }
    if (removed) fsyncDirectory(this.#directory);
  }
}

interface JournalSegment {
  path: string;
  start: number;
  end: number;
  bytes: number;
}

export interface CompanionPiBrokerOptions {
  invocationId: string;
  transport: CompanionPiRpcTransport;
  journal: SegmentedCompanionPiJournal;
  dispatchLedger?: CompanionPiDispatchLedger;
  layoutMarker?: string;
  outboxPath?: string;
}

export interface CompanionPiAcceptedDispatch {
  attemptId: string;
  responseAttemptId: string;
  commandId: string;
  invocationId: string;
  initialCursor: number;
  fingerprint: string;
}

export interface CompanionPiAmbiguousDispatch {
  attemptId: string;
  commandId: string;
  invocationId: string;
  fingerprint: string;
}

export interface CompanionPiDeliveredDecision {
  attemptId: string;
  commandId: string;
  invocationId: string;
  fingerprint: string;
}

/**
 * Small fsync-backed prompt ledger. Positive acknowledgements and ambiguous Pi writes are published
 * here before the broker answers its caller, so response loss or broker reconstruction never
 * replays the exact attempt. Records are scoped to one Pi invocation: a daemon restart cannot prove
 * what the previous Pi process accepted and deliberately starts with an empty ledger.
 */
export class CompanionPiDispatchLedger {
  readonly #path: string;
  readonly #invocationId: string;
  readonly #records = new Map<string, CompanionPiAcceptedDispatch>();
  readonly #ambiguousRecords = new Map<string, CompanionPiAmbiguousDispatch>();
  readonly #decisionRecords = new Map<string, CompanionPiDeliveredDecision>();

  constructor(options: { path: string; invocationId: string }) {
    if (!validOpaqueId(options.invocationId)) throw new Error("invocationId is invalid");
    this.#path = options.path;
    this.#invocationId = options.invocationId;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#load();
  }

  lookup(attemptId: string): CompanionPiAcceptedDispatch | null {
    const record = this.#records.get(attemptId);
    return record ? { ...record } : null;
  }

  lookupAmbiguous(attemptId: string): CompanionPiAmbiguousDispatch | null {
    const record = this.#ambiguousRecords.get(attemptId);
    return record ? { ...record } : null;
  }

  lookupDecision(commandId: string): CompanionPiDeliveredDecision | null {
    const record = this.#decisionRecords.get(commandId);
    return record ? { ...record } : null;
  }

  recordDecision(record: CompanionPiDeliveredDecision): CompanionPiDeliveredDecision {
    if (record.invocationId !== this.#invocationId) throw new Error("decision invocation is invalid");
    const existing = this.#decisionRecords.get(record.commandId);
    if (existing) {
      if (existing.attemptId !== record.attemptId || existing.fingerprint !== record.fingerprint) {
        throw new Error("decision ledger identity conflict");
      }
      return { ...existing };
    }
    const previous = [...this.#decisionRecords.values()].map((value) => ({ ...value }));
    this.#decisionRecords.set(record.commandId, { ...record });
    while (this.#decisionRecords.size > DISPATCH_LEDGER_MAX_RECORDS) {
      const oldest = this.#decisionRecords.keys().next().value;
      if (oldest === undefined) break;
      this.#decisionRecords.delete(oldest);
    }
    try {
      this.#persist();
    } catch (error) {
      this.#decisionRecords.clear();
      for (const value of previous) this.#decisionRecords.set(value.commandId, value);
      throw error;
    }
    return { ...record };
  }

  recordAmbiguous(record: CompanionPiAmbiguousDispatch): CompanionPiAmbiguousDispatch {
    if (record.invocationId !== this.#invocationId) throw new Error("dispatch invocation is invalid");
    const accepted = this.#records.get(record.attemptId);
    if (accepted) {
      if (accepted.commandId !== record.commandId || accepted.fingerprint !== record.fingerprint) {
        throw new Error("dispatch ledger identity conflict");
      }
      throw new Error("accepted dispatch cannot become ambiguous");
    }
    const existing = this.#ambiguousRecords.get(record.attemptId);
    if (existing) {
      if (existing.commandId !== record.commandId || existing.fingerprint !== record.fingerprint) {
        throw new Error("dispatch ledger identity conflict");
      }
      return { ...existing };
    }
    const previous = [...this.#ambiguousRecords.values()].map((value) => ({ ...value }));
    this.#ambiguousRecords.set(record.attemptId, { ...record });
    while (this.#ambiguousRecords.size > DISPATCH_LEDGER_MAX_RECORDS) {
      const oldest = this.#ambiguousRecords.keys().next().value;
      if (oldest === undefined) break;
      this.#ambiguousRecords.delete(oldest);
    }
    try {
      this.#persist();
    } catch (error) {
      this.#ambiguousRecords.clear();
      for (const value of previous) this.#ambiguousRecords.set(value.attemptId, value);
      throw error;
    }
    return { ...record };
  }

  record(record: CompanionPiAcceptedDispatch): CompanionPiAcceptedDispatch {
    if (record.invocationId !== this.#invocationId) throw new Error("dispatch invocation is invalid");
    const existing = this.#records.get(record.attemptId);
    if (existing) {
      if (existing.commandId !== record.commandId || existing.fingerprint !== record.fingerprint) {
        throw new Error("dispatch ledger identity conflict");
      }
      return { ...existing };
    }
    const previous = [...this.#records.values()].map((value) => ({ ...value }));
    this.#records.set(record.attemptId, { ...record });
    while (this.#records.size > DISPATCH_LEDGER_MAX_RECORDS) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
    try {
      this.#persist();
    } catch (error) {
      // Never let an in-memory record become a later positive answer when its durable write failed.
      // The Pi effect is already ambiguous; only a successfully fsynced record may resolve it.
      this.#records.clear();
      for (const value of previous) this.#records.set(value.attemptId, value);
      throw error;
    }
    return { ...record };
  }

  #load(): void {
    if (!existsSync(this.#path)) {
      this.#persist();
      return;
    }
    try {
      const value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (!isJsonObject(value) || value.invocationId !== this.#invocationId || !Array.isArray(value.records)) {
        this.#persist();
        return;
      }
      for (const candidate of value.records.slice(-DISPATCH_LEDGER_MAX_RECORDS)) {
        if (!validAcceptedDispatch(candidate, this.#invocationId)) continue;
        this.#records.set(candidate.attemptId, {
          ...candidate,
          responseAttemptId: typeof candidate.responseAttemptId === "string"
            ? candidate.responseAttemptId
            : candidate.attemptId,
        });
      }
      const ambiguousRecords = Array.isArray(value.ambiguousRecords) ? value.ambiguousRecords : [];
      for (const candidate of ambiguousRecords.slice(-DISPATCH_LEDGER_MAX_RECORDS)) {
        if (!validAmbiguousDispatch(candidate, this.#invocationId)) continue;
        this.#ambiguousRecords.set(candidate.attemptId, { ...candidate });
      }
      const decisionRecords = Array.isArray(value.decisionRecords) ? value.decisionRecords : [];
      for (const candidate of decisionRecords.slice(-DISPATCH_LEDGER_MAX_RECORDS)) {
        if (!validDeliveredDecision(candidate, this.#invocationId)) continue;
        this.#decisionRecords.set(candidate.commandId, { ...candidate });
      }
      this.#persist();
    } catch {
      // A corrupt or previous-version ledger proves nothing. Replace it before accepting work.
      this.#records.clear();
      this.#ambiguousRecords.clear();
      this.#decisionRecords.clear();
      this.#persist();
    }
  }

  #persist(): void {
    atomicWrite(this.#path, `${JSON.stringify({
      version: 3,
      invocationId: this.#invocationId,
      records: [...this.#records.values()],
      ambiguousRecords: [...this.#ambiguousRecords.values()],
      decisionRecords: [...this.#decisionRecords.values()],
    })}\n`);
  }
}

/** Serialized Pi command broker and sole owner of event-to-response association. */
export class CompanionPiBroker {
  readonly #invocationId: string;
  readonly #transport: CompanionPiRpcTransport;
  readonly #journal: SegmentedCompanionPiJournal;
  readonly #dispatchLedger: CompanionPiDispatchLedger | null;
  readonly #layoutMarker: string | null;
  readonly #outboxPath: string | null;
  #activeAttemptId: string | null = null;
  #activeAdmissionAmbiguous = false;
  #pendingPrompt: {
    attemptId: string;
    priorResponseAttemptId: string | null;
    initialCursor: number;
    promotedToRoot: boolean;
  } | null = null;
  readonly #ambiguousDispatches = new Map<string, { commandId: string; fingerprint: string }>();
  #commandSequence = 0;
  #commandTail: Promise<void> = Promise.resolve();

  constructor(options: CompanionPiBrokerOptions) {
    if (!validOpaqueId(options.invocationId)) throw new Error("invocationId is invalid");
    this.#invocationId = options.invocationId;
    this.#transport = options.transport;
    this.#journal = options.journal;
    this.#dispatchLedger = options.dispatchLedger ?? null;
    this.#layoutMarker = typeof options.layoutMarker === "string" && options.layoutMarker.length > 0
      ? options.layoutMarker.slice(0, 1024)
      : null;
    this.#outboxPath = options.outboxPath ?? null;
    this.#journal.beginInvocation(options.invocationId);
  }

  get activeAttemptId(): string | null {
    return this.#activeAttemptId;
  }

  command(command: PiJsonObject): Promise<PiJsonObject> {
    const run = this.#commandTail.then(() => this.#handleCommand(command));
    this.#commandTail = run.then(() => undefined, () => undefined);
    return run;
  }

  acceptPiRecord(record: PiJsonObject): void {
    if (record.type === "response") {
      this.#journal.recordFault("orphanResponses");
      return;
    }
    const eventType = typeof record.type === "string" ? record.type : null;
    if (!eventType || !COMPANION_PI_SUPPORTED_EVENT_TYPES.has(eventType)) {
      this.#journal.recordFault("unknownEvents");
      return;
    }
    if (eventType === "agent_settled" && !supportedAgentSettled(record)) {
      this.#journal.recordFault("unknownEvents");
      return;
    }
    const attemptId = this.#activeAttemptId;
    if (!attemptId) {
      this.#journal.recordFault("unboundEvents");
      return;
    }
    this.#journal.append({
      invocationId: this.#invocationId,
      attemptId,
      kind: "pi_event",
      event: record,
    });
    if (eventType === "agent_settled" && this.#activeAttemptId === attemptId) {
      this.#activeAttemptId = null;
      this.#activeAdmissionAmbiguous = false;
      if (this.#pendingPrompt?.priorResponseAttemptId === attemptId) {
        this.#pendingPrompt.promotedToRoot = true;
        this.#pendingPrompt.initialCursor = this.#journal.tailCursor;
        this.#activeAttemptId = this.#pendingPrompt.attemptId;
        this.#activeAdmissionAmbiguous = true;
      }
    }
  }

  acceptPiProcessExit(exit: { code: number | null; signal: string | null }): void {
    const attemptId = this.#activeAttemptId;
    if (!attemptId) {
      this.#journal.recordFault("unboundEvents");
      return;
    }
    this.#journal.append({
      invocationId: this.#invocationId,
      attemptId,
      kind: "pi_process_exit",
      exit: {
        code: Number.isSafeInteger(exit.code) ? exit.code : null,
        signal: typeof exit.signal === "string" ? exit.signal.slice(0, 32) : null,
      },
    });
    this.#activeAttemptId = null;
    this.#activeAdmissionAmbiguous = false;
  }

  async #handleCommand(command: PiJsonObject): Promise<PiJsonObject> {
    const id = validCommandId(command.id) ? command.id : null;
    const type = typeof command.type === "string" ? command.type : "invalid";
    try {
      if (id === null) throw new BrokerCommandError("invalid_command", "command id is required");
      const data = await this.#dispatch(type, command);
      return { id, type: "response", command: type, success: true, data };
    } catch (error) {
      const safe = error instanceof BrokerCommandError
        ? error
        : new BrokerCommandError("broker_unavailable", "Pi broker command failed");
      return {
        id,
        type: "response",
        command: type,
        success: false,
        error: {
          code: safe.code,
          message: safe.message,
          ambiguous: safe.ambiguous,
        },
      };
    }
  }

  async #dispatch(type: string, command: PiJsonObject): Promise<PiJsonObject> {
    switch (type) {
      case "broker_state":
        return this.#brokerState();
      case "runtime_state":
        return await this.#runtimeState();
      case "get_state":
        return normalizePiState(await this.#piRequest("get_state", {}));
      case "prompt":
        return this.#prompt(command);
      case "dispatch_status":
        return this.#dispatchStatus(command);
      case "abort":
        return this.#abort(command);
      case "extension_ui_response":
        return this.#extensionUiResponse(command);
      case "read_events": {
        const after = brokerCommandNonNegativeSafeInteger(command.after, "after");
        const limit = command.limit === undefined
          ? COMPANION_PI_BROKER_READ_LIMIT
          : brokerCommandPositiveSafeInteger(command.limit, "limit");
        if (limit > COMPANION_PI_BROKER_READ_LIMIT) {
          throw new BrokerCommandError(
            "invalid_command",
            `limit must be at most ${COMPANION_PI_BROKER_READ_LIMIT}`,
          );
        }
        if (after > this.#journal.tailCursor) {
          throw new BrokerCommandError("invalid_command", "cannot read beyond the journal tail");
        }
        return { ...this.#journal.read(after, limit) };
      }
      case "ack_events": {
        const through = brokerCommandNonNegativeSafeInteger(command.through, "through");
        if (through > this.#journal.tailCursor) {
          throw new BrokerCommandError(
            "invalid_command",
            "cannot acknowledge beyond the journal tail",
          );
        }
        return { acknowledgedCursor: this.#journal.acknowledge(through) };
      }
      default:
        throw new BrokerCommandError("unsupported_command", "unsupported Pi broker command");
    }
  }

  async #prompt(command: PiJsonObject): Promise<PiJsonObject> {
    const attemptId = requireOpaqueId(command.attemptId, "attemptId");
    const commandId = requireOpaqueId(command.id, "commandId");
    const expectedInvocationId = command.expectedInvocationId === undefined
      ? null
      : requireOpaqueId(command.expectedInvocationId, "expectedInvocationId");
    const message = typeof command.message === "string" ? command.message : "";
    if (!message) throw new BrokerCommandError("invalid_command", "prompt message is required");
    if (expectedInvocationId !== null && expectedInvocationId !== this.#invocationId) {
      throw new BrokerCommandError("invocation_mismatch", "prompt does not match the current Pi invocation");
    }
    const requiredInput = command.requiredInput === undefined
      ? ["text"]
      : Array.isArray(command.requiredInput)
      && command.requiredInput.length > 0
      && command.requiredInput.every((item) => item === "text" || item === "image")
        ? [...new Set(command.requiredInput)]
        : null;
    if (!requiredInput) {
      throw new BrokerCommandError("invalid_command", "requiredInput is required");
    }
    const fingerprint = companionPiDispatchFingerprint({
      attemptId,
      expectedInvocationId,
      message,
      requiredInput,
      clearOutbox: command.clearOutbox,
    });
    const recorded = this.#dispatchLedger?.lookup(attemptId) ?? null;
    if (recorded) {
      if (recorded.commandId !== commandId || recorded.fingerprint !== fingerprint) {
        throw new BrokerCommandError("dispatch_conflict", "attempt dispatch identity does not match");
      }
      return acceptedDispatchData(recorded, requiredInput);
    }
    const ambiguous = this.#ambiguousDispatches.get(attemptId)
      ?? this.#dispatchLedger?.lookupAmbiguous(attemptId);
    if (ambiguous) {
      if (ambiguous.commandId !== commandId || ambiguous.fingerprint !== fingerprint) {
        throw new BrokerCommandError("dispatch_conflict", "attempt dispatch identity does not match");
      }
      throw new BrokerCommandError(
        "pi_ack_ambiguous",
        "Pi prompt acknowledgement remains unavailable",
        true,
      );
    }
    if (this.#activeAdmissionAmbiguous) {
      throw new BrokerCommandError(
        "attempt_active",
        "the active Pi admission is ambiguous and cannot accept more work",
      );
    }
    const responseAttemptId = this.#activeAttemptId;
    if (
      responseAttemptId === null
      && this.#journal.tailCursor > this.#journal.acknowledgedCursor
    ) {
      throw new BrokerCommandError(
        "journal_pending",
        "Pi has a completed response awaiting durable acknowledgement",
      );
    }

    if (this.#outboxPath && command.clearOutbox !== true) {
      throw new BrokerCommandError("invalid_command", "clearOutbox is required");
    }
    if (this.#outboxPath && responseAttemptId === null) {
      mkdirSync(this.#outboxPath, { recursive: true, mode: 0o700 });
      for (const entry of readdirSync(this.#outboxPath)) {
        rmSync(join(this.#outboxPath, entry), { recursive: true, force: true });
      }
    }

    // Runtime reads strictly after the cursor returned with the ACK. Capture the boundary before
    // binding/writing the prompt so events emitted in the same stdout burst as Pi's response remain
    // visible to the attempt instead of being mistaken for already-consumed history.
    const pendingPrompt = {
      attemptId,
      priorResponseAttemptId: responseAttemptId,
      initialCursor: this.#journal.tailCursor,
      promotedToRoot: false,
    };
    this.#pendingPrompt = pendingPrompt;
    if (responseAttemptId === null) {
      this.#activeAttemptId = attemptId;
      this.#activeAdmissionAmbiguous = true;
    }
    let response: PiJsonObject;
    try {
      // Pi 0.84.2 decides inside prompt whether this starts idle work or joins the active run as a
      // steer. Its preflight response is the admission boundary; it is not proof of application.
      response = await this.#piRequest("prompt", { message, streamingBehavior: "steer" });
    } catch {
      this.#pendingPrompt = null;
      this.#recordAmbiguousDispatch({ attemptId, commandId, fingerprint });
      throw new BrokerCommandError(
        "pi_ack_ambiguous",
        "Pi prompt acknowledgement is unavailable",
        true,
      );
    }
    this.#pendingPrompt = null;
    const acceptedResponseAttemptId = pendingPrompt.promotedToRoot
      ? attemptId
      : responseAttemptId ?? attemptId;
    if (response.success === false) {
      if (acceptedResponseAttemptId === attemptId && this.#activeAttemptId === attemptId) {
        this.#activeAttemptId = null;
        this.#activeAdmissionAmbiguous = false;
      }
      throw new BrokerCommandError("pi_prompt_refused", "Pi refused the prompt");
    }
    if (response.success !== true) {
      this.#recordAmbiguousDispatch({ attemptId, commandId, fingerprint });
      throw new BrokerCommandError(
        "pi_ack_ambiguous",
        "Pi prompt acknowledgement is unavailable",
        true,
      );
    }
    const accepted: CompanionPiAcceptedDispatch = {
      attemptId,
      responseAttemptId: acceptedResponseAttemptId,
      commandId,
      invocationId: this.#invocationId,
      initialCursor: pendingPrompt.initialCursor,
      fingerprint,
    };
    try {
      this.#dispatchLedger?.record(accepted);
    } catch {
      // Pi accepted the prompt but its proof could not be made durable. The caller must keep the
      // attempt ambiguous; returning a positive ACK here would make takeover falsely replay-safe.
      this.#recordAmbiguousDispatch({ attemptId, commandId, fingerprint });
      throw new BrokerCommandError(
        "dispatch_ledger_unavailable",
        "Pi prompt acknowledgement could not be recorded",
        true,
      );
    }
    if (acceptedResponseAttemptId === attemptId) this.#activeAdmissionAmbiguous = false;
    return acceptedDispatchData(accepted, requiredInput);
  }

  #recordAmbiguousDispatch(record: {
    attemptId: string;
    commandId: string;
    fingerprint: string;
  }): void {
    this.#ambiguousDispatches.set(record.attemptId, {
      commandId: record.commandId,
      fingerprint: record.fingerprint,
    });
    try {
      this.#dispatchLedger?.recordAmbiguous({
        ...record,
        invocationId: this.#invocationId,
      });
    } catch {
      // The in-memory tombstone still prevents replay for this invocation. The caller remains
      // ambiguous because a failed durable write can never be upgraded to positive admission.
    }
  }

  #dispatchStatus(command: PiJsonObject): PiJsonObject {
    const attemptId = requireOpaqueId(command.attemptId, "attemptId");
    const commandId = requireOpaqueId(command.commandId, "commandId");
    const record = this.#dispatchLedger?.lookup(attemptId) ?? null;
    if (!record) return { status: "absent", attemptId, commandId };
    if (record.commandId !== commandId) {
      throw new BrokerCommandError("dispatch_conflict", "attempt dispatch identity does not match");
    }
    return {
      status: "accepted",
      fingerprint: record.fingerprint,
      ...acceptedDispatchData(record, ["text"]),
    };
  }

  async #abort(command: PiJsonObject): Promise<PiJsonObject> {
    const activeAttemptId = this.#activeAttemptId;
    if (command.attemptId !== undefined) {
      const requestedAttemptId = requireOpaqueId(command.attemptId, "attemptId");
      if (activeAttemptId && requestedAttemptId !== activeAttemptId) {
        throw new BrokerCommandError("attempt_mismatch", "abort does not match the active Pi attempt");
      }
    }
    if (!activeAttemptId) {
      return { aborted: false, invocationId: this.#invocationId };
    }
    let response: PiJsonObject;
    try {
      response = await this.#piRequest("abort", {});
    } catch {
      throw new BrokerCommandError(
        "pi_ack_ambiguous",
        "Pi abort acknowledgement is unavailable",
        true,
      );
    }
    if (response.success === false) {
      throw new BrokerCommandError("pi_abort_refused", "Pi refused the abort");
    }
    if (response.success !== true) {
      throw new BrokerCommandError(
        "pi_ack_ambiguous",
        "Pi abort acknowledgement is unavailable",
        true,
      );
    }
    // Clear the binding on a positive ACK so the next queued turn does not see a stale active
    // attempt while Pi's agent_settled event is still in flight.
    this.#activeAttemptId = null;
    this.#activeAdmissionAmbiguous = false;
    return { aborted: true, attemptId: activeAttemptId, invocationId: this.#invocationId };
  }

  async #extensionUiResponse(command: PiJsonObject): Promise<PiJsonObject> {
    const commandId = requireOpaqueId(command.id, "commandId");
    const requestedAttemptId = command.attemptId === undefined
      ? null
      : requireOpaqueId(command.attemptId, "attemptId");
    if (!isJsonObject(command.response) || command.response.type !== "extension_ui_response") {
      throw new BrokerCommandError("invalid_command", "extension UI response is invalid");
    }
    const responseId = command.response.id;
    if (!validCommandId(responseId)) {
      throw new BrokerCommandError("invalid_command", "extension UI response id is required");
    }
    const recorded = this.#dispatchLedger?.lookupDecision(commandId) ?? null;
    if (recorded) {
      const fingerprint = companionPiDecisionFingerprint({
        attemptId: requestedAttemptId ?? recorded.attemptId,
        response: command.response,
      });
      if (recorded.attemptId !== (requestedAttemptId ?? recorded.attemptId)
        || recorded.fingerprint !== fingerprint) {
        throw new BrokerCommandError("decision_conflict", "decision delivery identity does not match");
      }
      return {
        attemptId: recorded.attemptId,
        invocationId: recorded.invocationId,
        delivered: true,
      };
    }
    const activeAttemptId = this.#activeAttemptId;
    if (!activeAttemptId) {
      throw new BrokerCommandError("no_active_attempt", "no active Pi attempt can receive a decision");
    }
    if (requestedAttemptId !== null && requestedAttemptId !== activeAttemptId) {
      throw new BrokerCommandError("attempt_mismatch", "decision does not match the active Pi attempt");
    }
    const fingerprint = companionPiDecisionFingerprint({
      attemptId: activeAttemptId,
      response: command.response,
    });
    try {
      await this.#transport.send({ ...command.response });
    } catch {
      // Pi's one-way decision command has no correlated acknowledgement. A transport
      // failure can therefore happen after the bytes reached Pi; replaying it would
      // risk applying the same external decision twice.
      throw new BrokerCommandError(
        "decision_delivery_ambiguous",
        "Pi decision delivery is unavailable",
        true,
      );
    }
    try {
      this.#dispatchLedger?.recordDecision({
        attemptId: activeAttemptId,
        commandId,
        invocationId: this.#invocationId,
        fingerprint,
      });
    } catch {
      throw new BrokerCommandError(
        "decision_delivery_ambiguous",
        "Pi decision delivery could not be checkpointed",
        true,
      );
    }
    return {
      attemptId: activeAttemptId,
      invocationId: this.#invocationId,
      delivered: true,
    };
  }

  async #piRequest(type: string, fields: PiJsonObject): Promise<PiJsonObject> {
    this.#commandSequence += 1;
    const id = `broker:${this.#invocationId}:${this.#commandSequence}`;
    const response = await this.#transport.request({ id, type, ...fields });
    if (
      response.type !== "response"
      || response.id !== id
      || response.command !== type
    ) {
      throw new BrokerCommandError("pi_protocol", "Pi returned an uncorrelated response");
    }
    return response;
  }

  #brokerState(): PiJsonObject {
    return {
      invocationId: this.#invocationId,
      layoutMarker: this.#layoutMarker,
      activeAttemptId: this.#activeAttemptId,
      tailCursor: this.#journal.tailCursor,
      acknowledgedCursor: this.#journal.acknowledgedCursor,
      counters: this.#journal.counters,
    };
  }

  /** One correlated snapshot of broker identity plus Pi's current model input capabilities. */
  async #runtimeState(): Promise<PiJsonObject> {
    const state = normalizePiState(await this.#piRequest("get_state", {}));
    const model = isJsonObject(state.model) ? state.model : null;
    return {
      ...this.#brokerState(),
      modelInput: Array.isArray(model?.input) ? model.input : [],
    };
  }
}

/** Wire Pi stdout into the broker without ever exposing rejected line content. */
export function createCompanionPiOutputDecoder(input: {
  broker: CompanionPiBroker;
  journal: SegmentedCompanionPiJournal;
  maxLineBytes?: number;
}): StrictLfJsonlDecoder {
  return new StrictLfJsonlDecoder({
    maxLineBytes: input.maxLineBytes,
    onRecord: (record) => input.broker.acceptPiRecord(record),
    onFault(fault) {
      const counter = fault === "malformed"
        ? "malformedLines"
        : fault === "oversized"
          ? "oversizedLines"
          : "unterminatedLines";
      input.journal.recordFault(counter);
    },
  });
}

export class BrokerCommandError extends Error {
  readonly code: string;
  readonly ambiguous: boolean;

  constructor(code: string, message: string, ambiguous = false) {
    super(message);
    this.name = "BrokerCommandError";
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

export interface CompanionPiBrokerSocketOptions {
  broker: CompanionPiBroker;
  socketPath: string;
  maxCommandBytes?: number;
}

/** Start the owner-only one-command-per-connection Unix socket. */
export async function startCompanionPiBrokerSocket(
  options: CompanionPiBrokerSocketOptions,
): Promise<Server> {
  prepareSocketPath(options.socketPath);
  const maxCommandBytes = options.maxCommandBytes ?? COMPANION_PI_BROKER_MAX_COMMAND_BYTES;
  // Clients half-close after their sole command; keep the writable side alive for the async reply.
  const server = createServer({ allowHalfOpen: true }, (socket) => (
    handleSocket(socket, options.broker, maxCommandBytes)
  ));
  await listenOwnerOnlyCompanionPiSocket(server, options.socketPath);
  return server;
}

/** @internal Test seam for the post-listen permission failure cleanup path. */
export async function listenOwnerOnlyCompanionPiSocket(
  server: Server,
  socketPath: string,
  setSocketMode: (path: string) => void = (path) => chmodSync(path, 0o600),
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  try {
    setSocketMode(socketPath);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(socketPath);
    } catch {
      // Preserve the original permission failure.
    }
    throw error;
  }
}

export interface CompanionPiBrokerClientOptions {
  socketPath: string;
  command: PiJsonObject;
  timeoutMs?: number;
}

/** Runtime-side helper for the correlated one-shot broker socket protocol. */
export function sendCompanionPiBrokerCommand(
  options: CompanionPiBrokerClientOptions,
): Promise<PiJsonObject> {
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? 10_000, "timeoutMs");
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let settled = false;
    let response: PiJsonObject | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else if (!response) reject(new Error("Pi broker closed without a response"));
      else if (response.id !== options.command.id) reject(new Error("Pi broker response id mismatch"));
      else resolve(response);
    };
    const decoder = new StrictLfJsonlDecoder({
      maxLineBytes: COMPANION_PI_BROKER_MAX_COMMAND_BYTES,
      onRecord(record) {
        if (response) {
          finish(new Error("Pi broker returned more than one response"));
          return;
        }
        response = record;
      },
      onFault() {
        finish(new Error("Pi broker returned an invalid response"));
      },
    });
    const timeout = setTimeout(() => finish(new Error("Pi broker command timed out")), timeoutMs);
    socket.on("connect", () => socket.end(`${JSON.stringify(options.command)}\n`));
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("end", () => {
      decoder.finish();
      finish();
    });
    socket.on("error", (error) => finish(error));
  });
}

/** Preserve Pi's `input` capabilities while defensively normalizing a provider model catalog. */
export function normalizePiModelCatalog(value: unknown): PiJsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || !entry.id.trim()) return [];
    const input = Array.isArray(entry.input)
      ? [...new Set(entry.input.filter((item): item is string => typeof item === "string"))]
      : [];
    return [{ ...entry, id: entry.id.trim(), input }];
  });
}

function normalizePiState(response: PiJsonObject): PiJsonObject {
  if (response.success !== true || !isJsonObject(response.data)) {
    throw new BrokerCommandError("pi_state_unavailable", "Pi state is unavailable");
  }
  const state = { ...response.data };
  if (isJsonObject(state.model)) {
    const [model] = normalizePiModelCatalog([state.model]);
    if (model) state.model = model;
  }
  return state;
}

function handleSocket(socket: Socket, broker: CompanionPiBroker, maxCommandBytes: number): void {
  let answered = false;
  let received = false;
  const answer = (response: PiJsonObject): void => {
    if (answered) return;
    answered = true;
    socket.end(`${JSON.stringify(response)}\n`);
  };
  const decoder = new StrictLfJsonlDecoder({
    maxLineBytes: maxCommandBytes,
    onRecord(record) {
      // The first complete record owns the connection. Ignore any trailing bytes rather than
      // returning a failure after the first command may already have produced a side effect.
      if (received) return;
      received = true;
      void broker.command(record).then(answer, () => answer(invalidSocketResponse(record.id, "broker failed")));
    },
    onFault(fault) {
      if (received) return;
      received = true;
      answer(invalidSocketResponse(null, `invalid ${fault} command record`));
    },
  });
  socket.on("data", (chunk: Buffer) => decoder.push(chunk));
  socket.on("end", () => {
    decoder.finish();
    if (!received) answer(invalidSocketResponse(null, "one LF-terminated command is required"));
  });
  socket.on("error", () => socket.destroy());
}

function invalidSocketResponse(id: unknown, message: string): PiJsonObject {
  return {
    id: validCommandId(id) ? id : null,
    type: "response",
    command: "invalid",
    success: false,
    error: { code: "invalid_command", message, ambiguous: false },
  };
}

function prepareSocketPath(socketPath: string): void {
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  if (!existsSync(socketPath)) return;
  const stat = lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) {
    throw new Error("refusing to replace a non-owned Pi broker socket path");
  }
  unlinkSync(socketPath);
}

function segmentName(sequence: number): string {
  return `events-${String(sequence).padStart(16, "0")}.ndjson`;
}

function segmentStart(path: string): number {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = SEGMENT_PATTERN.exec(name);
  if (!match) throw new Error("invalid Pi event journal segment name");
  return Number.parseInt(match[1]!, 10);
}

function appendAndSync(path: string, value: string): void {
  appendFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const descriptor = openSync(temporary, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the original durable-write failure.
      }
    }
  }
}

function fsyncDirectory(path: string): void {
  const directoryDescriptor = openSync(path, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function recoverTrailingFragment(path: string): void {
  const descriptor = openSync(path, "r+");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return;
    const content = readFileSync(path);
    if (content.at(-1) === 0x0a) return;
    const newline = content.lastIndexOf(0x0a);
    truncateSync(path, newline < 0 ? 0 : newline + 1);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readSegmentRecords(path: string): CompanionPiJournalRecord[] {
  const text = readFileSync(path, "utf8");
  if (!text) return [];
  if (!text.endsWith("\n")) throw new Error("Pi event journal has an unterminated record");
  return text.slice(0, -1).split("\n").map((line) => {
    const value = JSON.parse(line) as unknown;
    if (!validJournalRecord(value)) throw new Error("Pi event journal contains an invalid record");
    return value;
  });
}

function validJournalRecord(value: unknown): value is CompanionPiJournalRecord {
  if (!isJsonObject(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0) {
    return false;
  }
  if (!validOpaqueId(value.invocationId)) return false;
  if (value.kind === "pi_event") {
    return validOpaqueId(value.attemptId) && isJsonObject(value.event);
  }
  if (value.kind === "pi_process_exit") {
    return validOpaqueId(value.attemptId) && isJsonObject(value.exit);
  }
  return false;
}

function validAcceptedDispatch(
  value: unknown,
  invocationId: string,
): value is CompanionPiAcceptedDispatch {
  return isJsonObject(value)
    && validOpaqueId(value.attemptId)
    && (value.responseAttemptId === undefined || validOpaqueId(value.responseAttemptId))
    && validOpaqueId(value.commandId)
    && value.invocationId === invocationId
    && Number.isSafeInteger(value.initialCursor)
    && Number(value.initialCursor) >= 0
    && typeof value.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function validAmbiguousDispatch(
  value: unknown,
  invocationId: string,
): value is CompanionPiAmbiguousDispatch {
  return isJsonObject(value)
    && validOpaqueId(value.attemptId)
    && validOpaqueId(value.commandId)
    && value.invocationId === invocationId
    && typeof value.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function validDeliveredDecision(
  value: unknown,
  invocationId: string,
): value is CompanionPiDeliveredDecision {
  return isJsonObject(value)
    && validOpaqueId(value.attemptId)
    && validOpaqueId(value.commandId)
    && value.invocationId === invocationId
    && typeof value.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function companionPiDecisionFingerprint(input: {
  attemptId: string;
  response: PiJsonObject;
}): string {
  return createHash("sha256").update(JSON.stringify({
    attemptId: input.attemptId,
    response: input.response,
  })).digest("hex");
}

export function companionPiDispatchFingerprint(input: {
  attemptId: string;
  expectedInvocationId?: unknown;
  message: string;
  requiredInput: unknown[];
  clearOutbox: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify({
    attemptId: input.attemptId,
    expectedInvocationId: typeof input.expectedInvocationId === "string"
      ? input.expectedInvocationId
      : null,
    message: input.message,
    requiredInput: input.requiredInput,
    clearOutbox: input.clearOutbox === true,
  })).digest("hex");
}

function acceptedDispatchData(
  record: CompanionPiAcceptedDispatch,
  requiredInput: unknown[],
): PiJsonObject {
  return {
    attemptId: record.attemptId,
    responseAttemptId: record.responseAttemptId,
    commandId: record.commandId,
    invocationId: record.invocationId,
    piAcknowledged: true,
    initialCursor: record.initialCursor,
    requiredInput,
    clearOutbox: true,
  };
}

function readCursor(path: string): number {
  if (!existsSync(path)) return 0;
  const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readCounters(path: string): CompanionPiBrokerCounters {
  if (!existsSync(path)) return emptyCounters();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isJsonObject(parsed)) return emptyCounters();
    const result = emptyCounters();
    for (const key of Object.keys(result) as Array<keyof CompanionPiBrokerCounters>) {
      const value = parsed[key];
      result[key] = Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
    }
    return result;
  } catch {
    return emptyCounters();
  }
}

function emptyCounters(): CompanionPiBrokerCounters {
  return {
    malformedLines: 0,
    oversizedLines: 0,
    unterminatedLines: 0,
    unknownEvents: 0,
    unboundEvents: 0,
    orphanResponses: 0,
  };
}

function isJsonObject(value: unknown): value is PiJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportedAgentSettled(record: PiJsonObject): boolean {
  return record.type === "agent_settled"
    && Object.keys(record).length === 1;
}

function validCommandId(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0 && value.length <= 256)
    || (typeof value === "number" && Number.isFinite(value));
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function requireOpaqueId(value: unknown, name: string): string {
  if (!validOpaqueId(value)) throw new BrokerCommandError("invalid_command", `${name} is invalid`);
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive safe integer`);
  return Number(value);
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return Number(value);
}

function brokerCommandPositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new BrokerCommandError("invalid_command", `${name} must be a positive safe integer`);
  }
  return Number(value);
}

function brokerCommandNonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new BrokerCommandError("invalid_command", `${name} must be a non-negative safe integer`);
  }
  return Number(value);
}
