/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- The canonical serializer intentionally accepts schema-derived JSON values and validates cursor bytes before parsing. */

import { createHash } from "node:crypto";
import {
  COMPANION_SYNC_CURSOR_MAX_CHARACTERS,
  COMPANION_SYNC_CURSOR_MAX_RECORDS,
  COMPANION_SYNC_CURSOR_VERSION,
  COMPANION_THREAD_SYNC_CURSOR_TAIL_RECORDS,
  companionRosterSyncResponseSchema,
  companionThreadDeltaResponseSchema,
  type Companion,
  type CompanionRosterSyncResponse,
  type CompanionSection,
  type CompanionThread,
  type CompanionThreadDeltaResponse,
  type CompanionThreadMetadata,
  type CompanionTranscriptEntry,
} from "@companion/contracts";
import { z } from "zod";

/**
 * A cursor is a canonical, self-consistent snapshot of projection digests. It is not a
 * database offset: clients may replay it after an outage and still receive every changed or
 * deleted row since that snapshot. The payload intentionally contains no projection text.
 */
export class CompanionSyncCursorError extends Error {
  constructor(message = "invalid Companion sync cursor") {
    super(message);
    this.name = "CompanionSyncCursorError";
  }
}

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const cursorIdSchema = z.string().min(1).max(200).refine(
  (value) => !/[\r\n\0]/.test(value),
  "cursor id must be a single line",
);
const actorIdSchema = z.string().min(1).max(200).refine(
  (value) => !/[\r\n\0]/.test(value),
  "cursor actor id must be a single line",
);

const digestRecordSchema = z.object({
  id: cursorIdSchema,
  digest: digestSchema,
}).strict();

const threadDigestRecordSchema = digestRecordSchema.extend({
  ordinal: z.number().int().nonnegative(),
}).strict();

const rosterCursorSchema = z.object({
  v: z.literal(COMPANION_SYNC_CURSOR_VERSION),
  kind: z.literal("roster"),
  org_id: z.string().uuid(),
  actor_id: actorIdSchema,
  companions: z.array(digestRecordSchema).max(COMPANION_SYNC_CURSOR_MAX_RECORDS),
  sections: z.array(digestRecordSchema).max(COMPANION_SYNC_CURSOR_MAX_RECORDS),
  companion_ids: z.array(z.string().uuid()).max(COMPANION_SYNC_CURSOR_MAX_RECORDS),
  section_ids: z.array(z.string().uuid()).max(COMPANION_SYNC_CURSOR_MAX_RECORDS),
  projection_digest: digestSchema,
}).strict();

const legacyThreadCursorSchema = z.object({
  v: z.literal(COMPANION_SYNC_CURSOR_VERSION),
  kind: z.literal("thread"),
  org_id: z.string().uuid(),
  actor_id: actorIdSchema,
  companion_id: z.string().uuid(),
  /** Exact digests for the mutable transcript tail; the immutable prefix is one bounded digest. */
  // Accept previously issued 250-record cursors while emitting the smaller transport-safe tail.
  entries: z.array(threadDigestRecordSchema).max(250),
  entry_count: z.number().int().nonnegative().max(COMPANION_SYNC_CURSOR_MAX_RECORDS),
  prefix_count: z.number().int().nonnegative().max(COMPANION_SYNC_CURSOR_MAX_RECORDS),
  prefix_digest: digestSchema,
  metadata_digest: digestSchema,
  projection_digest: digestSchema,
}).strict();

const threadSequenceCursorSchema = z.object({
  v: z.literal(2),
  kind: z.literal("thread"),
  org_id: z.string().uuid(),
  actor_id: actorIdSchema,
  companion_id: z.string().uuid(),
  sequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
  projection_digest: digestSchema,
}).strict();

const threadWindowCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal("thread_window"),
  org_id: z.string().uuid(),
  actor_id: actorIdSchema,
  companion_id: z.string().uuid(),
  before_ordinal: z.number().int().nonnegative(),
  projection_digest: digestSchema,
}).strict();

const cursorPayloadSchema = z.union([
  rosterCursorSchema,
  legacyThreadCursorSchema,
  threadSequenceCursorSchema,
  threadWindowCursorSchema,
]);
type RosterCursor = z.infer<typeof rosterCursorSchema>;
type LegacyThreadCursor = z.infer<typeof legacyThreadCursorSchema>;
type ThreadSequenceCursor = z.infer<typeof threadSequenceCursorSchema>;
type ThreadWindowCursor = z.infer<typeof threadWindowCursorSchema>;
type CursorPayload = RosterCursor | LegacyThreadCursor | ThreadSequenceCursor | ThreadWindowCursor;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted recursively; array order remains meaningful projection order. */
export function canonicalCompanionSyncJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCompanionSyncJson(item)).join(",")}]`;
  }
  if (!isRecord(value)) return "null";
  const fields = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalCompanionSyncJson(value[key])}`);
  return `{${fields.join(",")}}`;
}

export function companionSyncDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCompanionSyncJson(value), "utf8")
    .digest("hex");
}

function encodeCursor(payload: CursorPayload): string {
  const encoded = Buffer.from(canonicalCompanionSyncJson(payload), "utf8").toString("base64url");
  if (encoded.length > COMPANION_SYNC_CURSOR_MAX_CHARACTERS) {
    throw new CompanionSyncCursorError("Companion sync cursor is too large");
  }
  return encoded;
}

/** Locale-independent ordering keeps digest maps byte-stable across server environments. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedDigestRecords(
  records: readonly { id: string; digest: string }[],
): { id: string; digest: string }[] {
  return [...records].sort((left, right) => compareStrings(left.id, right.id));
}

function assertSortedUnique(
  records: readonly { id: string; digest: string }[],
): void {
  for (let index = 1; index < records.length; index += 1) {
    if (compareStrings(records[index - 1]!.id, records[index]!.id) >= 0) {
      throw new CompanionSyncCursorError("invalid Companion sync cursor ordering");
    }
  }
}

function assertUniqueIds(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new CompanionSyncCursorError("invalid Companion sync cursor ordering");
  }
}

function assertOrderMatchesRecords(
  ids: readonly string[],
  records: readonly { id: string; digest: string }[],
): void {
  assertUniqueIds(ids);
  const recordIds = new Set(records.map((record) => record.id));
  if (ids.length !== records.length || ids.some((id) => !recordIds.has(id))) {
    throw new CompanionSyncCursorError("invalid Companion sync cursor ordering");
  }
}

function assertThreadRecords(
  records: readonly { id: string; digest: string; ordinal: number }[],
): void {
  // Ordinals identify transcript position but are not event identity. Defensive handling of
  // historical projections with tied ordinals keeps each event, while event IDs remain canonical
  // and unique so cursor integrity and replay semantics stay fail-closed.
  assertSortedUnique(records);
}

function decodeCursor(
  encoded: string,
  expected: {
    kind: CursorPayload["kind"];
    orgId: string;
    actorId: string;
    companionId?: string;
  },
): CursorPayload {
  if (
    encoded.length === 0
    || encoded.length > COMPANION_SYNC_CURSOR_MAX_CHARACTERS
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new CompanionSyncCursorError();
  }
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== encoded) {
      throw new CompanionSyncCursorError();
    }
    // SAFETY: The cursor bytes are bounded, canonical base64url, and are parsed immediately by the
    // strict discriminated cursor schema below before any value is used.
    const serialized = bytes.toString("utf8");
    const parsed = JSON.parse(serialized) as unknown;
    if (canonicalCompanionSyncJson(parsed) !== serialized) {
      throw new CompanionSyncCursorError();
    }
    const cursor = cursorPayloadSchema.parse(parsed);
    if (
      cursor.kind !== expected.kind
      || cursor.org_id !== expected.orgId
      || cursor.actor_id !== expected.actorId
      || (cursor.kind !== "roster" && cursor.companion_id !== expected.companionId)
    ) {
      throw new CompanionSyncCursorError();
    }
    if (cursor.kind === "roster") {
      assertSortedUnique(cursor.companions);
      assertSortedUnique(cursor.sections);
      assertOrderMatchesRecords(cursor.companion_ids, cursor.companions);
      assertOrderMatchesRecords(cursor.section_ids, cursor.sections);
      if (companionSyncDigest({
        companions: cursor.companions,
        sections: cursor.sections,
        companion_ids: cursor.companion_ids,
        section_ids: cursor.section_ids,
      }) !== cursor.projection_digest) {
        throw new CompanionSyncCursorError();
      }
    } else if (cursor.kind === "thread" && cursor.v === COMPANION_SYNC_CURSOR_VERSION) {
      assertThreadRecords(cursor.entries);
      if (cursor.prefix_count + cursor.entries.length !== cursor.entry_count) {
        throw new CompanionSyncCursorError();
      }
      if (companionSyncDigest({
        entries: cursor.entries,
        entry_count: cursor.entry_count,
        prefix_count: cursor.prefix_count,
        prefix_digest: cursor.prefix_digest,
        metadata_digest: cursor.metadata_digest,
      }) !== cursor.projection_digest) {
        throw new CompanionSyncCursorError();
      }
    } else if (cursor.kind === "thread") {
      if (companionSyncDigest({
        org_id: cursor.org_id,
        actor_id: cursor.actor_id,
        companion_id: cursor.companion_id,
        sequence: cursor.sequence,
      }) !== cursor.projection_digest) throw new CompanionSyncCursorError();
    } else if (companionSyncDigest({
      org_id: cursor.org_id,
      actor_id: cursor.actor_id,
      companion_id: cursor.companion_id,
      before_ordinal: cursor.before_ordinal,
    }) !== cursor.projection_digest) {
      throw new CompanionSyncCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof CompanionSyncCursorError) throw error;
    throw new CompanionSyncCursorError();
  }
}

function companionDigestRecords(companions: readonly Companion[]): { id: string; digest: string }[] {
  return sortedDigestRecords(companions.map((companion) => ({
    id: companion.id,
    digest: companionSyncDigest(companion),
  })));
}

function sectionDigestRecords(sections: readonly CompanionSection[]): { id: string; digest: string }[] {
  return sortedDigestRecords(sections.map((section) => ({
    id: section.id,
    digest: companionSyncDigest(section),
  })));
}

function orderedIds<T extends { id: string }>(values: readonly T[]): string[] {
  const ids = values.map((value) => value.id);
  assertUniqueIds(ids);
  return ids;
}

function entryDigestRecords(
  entries: readonly CompanionTranscriptEntry[],
): { id: string; digest: string; ordinal: number }[] {
  const records = [...entries]
    .map((entry) => ({
      id: entry.event_id,
      digest: companionSyncDigest(entry),
      ordinal: entry.ordinal,
    }))
    .sort((left, right) => compareStrings(left.id, right.id));
  assertThreadRecords(records);
  return records;
}

function rosterCursor(input: {
  orgId: string;
  actorId: string;
  companions: readonly Companion[];
  sections: readonly CompanionSection[];
}): string {
  const companionRecords = companionDigestRecords(input.companions);
  const sectionRecords = sectionDigestRecords(input.sections);
  const companionIds = orderedIds(input.companions);
  const sectionIds = orderedIds(input.sections);
  return encodeCursor({
    v: COMPANION_SYNC_CURSOR_VERSION,
    kind: "roster",
    org_id: input.orgId,
    actor_id: input.actorId,
    companions: companionRecords,
    sections: sectionRecords,
    companion_ids: companionIds,
    section_ids: sectionIds,
    projection_digest: companionSyncDigest({
      companions: companionRecords,
      sections: sectionRecords,
      companion_ids: companionIds,
      section_ids: sectionIds,
    }),
  });
}

function threadCursor(input: {
  orgId: string;
  actorId: string;
  companionId: string;
  entries: readonly CompanionTranscriptEntry[];
  metadata: CompanionThreadMetadata;
}): string {
  const orderedEntries = [...input.entries].sort(
    (left, right) => left.ordinal - right.ordinal || compareStrings(left.event_id, right.event_id),
  );
  if (orderedEntries.length > COMPANION_SYNC_CURSOR_MAX_RECORDS) {
    throw new CompanionSyncCursorError("Companion thread is too large for a sync cursor");
  }
  // Validate the complete projection before reducing it to a bounded cursor. Transcript ordinals
  // are ordered, and defensive handling permits historical tied ordinals; keeping a small exact
  // tail keeps the opaque query parameter below intermediary request-line limits, while a prefix
  // digest detects any exceptional historical edit or deletion and forces a reset.
  assertThreadRecords(entryDigestRecords(orderedEntries));
  const prefixCount = Math.max(
    0,
    orderedEntries.length - COMPANION_THREAD_SYNC_CURSOR_TAIL_RECORDS,
  );
  const prefixDigest = companionSyncDigest(entryDigestRecords(orderedEntries.slice(0, prefixCount)));
  const entryRecords = entryDigestRecords(orderedEntries.slice(prefixCount));
  const metadataDigest = companionSyncDigest(input.metadata);
  return encodeCursor({
    v: COMPANION_SYNC_CURSOR_VERSION,
    kind: "thread",
    org_id: input.orgId,
    actor_id: input.actorId,
    companion_id: input.companionId,
    entries: entryRecords,
    entry_count: orderedEntries.length,
    prefix_count: prefixCount,
    prefix_digest: prefixDigest,
    metadata_digest: metadataDigest,
    projection_digest: companionSyncDigest({
      entries: entryRecords,
      entry_count: orderedEntries.length,
      prefix_count: prefixCount,
      prefix_digest: prefixDigest,
      metadata_digest: metadataDigest,
    }),
  });
}

export function buildCompanionThreadSequenceCursor(input: {
  orgId: string;
  actorId: string;
  companionId: string;
  sequence: bigint;
}): string {
  if (input.sequence < 0n) throw new CompanionSyncCursorError();
  const binding = {
    org_id: input.orgId,
    actor_id: input.actorId,
    companion_id: input.companionId,
    sequence: input.sequence.toString(),
  };
  return encodeCursor({
    v: 2,
    kind: "thread",
    ...binding,
    projection_digest: companionSyncDigest(binding),
  });
}

export function readCompanionThreadSequenceCursor(input: {
  cursor: string;
  orgId: string;
  actorId: string;
  companionId: string;
}): bigint | null {
  const cursor = decodeCursor(input.cursor, {
    kind: "thread",
    orgId: input.orgId,
    actorId: input.actorId,
    companionId: input.companionId,
  });
  return cursor.kind === "thread" && cursor.v === 2 ? BigInt(cursor.sequence) : null;
}

export function buildCompanionThreadWindowCursor(input: {
  orgId: string;
  actorId: string;
  companionId: string;
  beforeOrdinal: number;
}): string {
  if (!Number.isSafeInteger(input.beforeOrdinal) || input.beforeOrdinal < 0) {
    throw new CompanionSyncCursorError();
  }
  const binding = {
    org_id: input.orgId,
    actor_id: input.actorId,
    companion_id: input.companionId,
    before_ordinal: input.beforeOrdinal,
  };
  return encodeCursor({
    v: 1,
    kind: "thread_window",
    ...binding,
    projection_digest: companionSyncDigest(binding),
  });
}

export function readCompanionThreadWindowCursor(input: {
  cursor: string;
  orgId: string;
  actorId: string;
  companionId: string;
}): number {
  const cursor = decodeCursor(input.cursor, {
    kind: "thread_window",
    orgId: input.orgId,
    actorId: input.actorId,
    companionId: input.companionId,
  });
  if (cursor.kind !== "thread_window") throw new CompanionSyncCursorError();
  return cursor.before_ordinal;
}

function changedRosterItems<T extends { id: string }>(
  current: readonly T[],
  prior: readonly { id: string; digest: string }[] | undefined,
): T[] {
  const priorDigests = new Map((prior ?? []).map((record) => [record.id, record.digest] as const));
  return current.filter((value) => {
    const previous = priorDigests.get(value.id);
    return previous === undefined || previous !== companionSyncDigest(value);
  });
}

function deletedRosterIds<T extends { id: string }>(
  current: readonly T[],
  prior: readonly { id: string; digest: string }[] | undefined,
  priorOrder: readonly string[] | undefined,
): string[] {
  const currentIds = new Set(current.map((value) => value.id));
  const priorIds = new Set((prior ?? []).map((record) => record.id));
  return (priorOrder ?? (prior ?? []).map((record) => record.id))
    .filter((id) => priorIds.has(id) && !currentIds.has(id));
}

/**
 * Build one roster response from the current authorized projections. The initial request and an
 * invalidated/absent cursor both have deliberately distinct behavior: only an absent cursor means
 * full sync; malformed cursors are rejected by decodeCursor so a client cannot silently lose data.
 */
export function buildCompanionRosterSync(input: {
  orgId: string;
  actorId: string;
  companions: readonly Companion[];
  sections: readonly CompanionSection[];
  cursor?: string;
}): CompanionRosterSyncResponse {
  const previous = input.cursor
    ? decodeCursor(input.cursor, {
        kind: "roster",
        orgId: input.orgId,
        actorId: input.actorId,
      })
    : undefined;
  const previousRoster = previous?.kind === "roster" ? previous : undefined;
  const companionIds = orderedIds(input.companions);
  const sectionIds = orderedIds(input.sections);
  const response = {
    cursor: rosterCursor(input),
    changed_companions: previousRoster
      ? changedRosterItems(input.companions, previousRoster.companions)
      : [...input.companions],
    deleted_companion_ids: previousRoster
      ? deletedRosterIds(input.companions, previousRoster.companions, previousRoster.companion_ids)
      : [],
    companion_ids: companionIds,
    changed_sections: previousRoster
      ? changedRosterItems(input.sections, previousRoster.sections)
      : [...input.sections],
    deleted_section_ids: previousRoster
      ? deletedRosterIds(input.sections, previousRoster.sections, previousRoster.section_ids)
      : [],
    section_ids: sectionIds,
  } satisfies CompanionRosterSyncResponse;
  return companionRosterSyncResponseSchema.parse(response);
}

function withoutThreadEntries(thread: CompanionThread): CompanionThreadMetadata {
  // Keep this copy explicit: a future thread field must be consciously included in the delta
  // metadata rather than accidentally smuggled into a cursor or omitted from the network response.
  const { entries: _entries, ...metadata } = thread;
  return metadata;
}

function changedThreadEntries(
  entries: readonly CompanionTranscriptEntry[],
  prior: readonly { id: string; digest: string; ordinal: number }[] | undefined,
): CompanionTranscriptEntry[] {
  const priorDigests = new Map((prior ?? []).map((record) => [record.id, record.digest] as const));
  return [...entries]
    .filter((entry) => {
      const previous = priorDigests.get(entry.event_id);
      return previous === undefined || previous !== companionSyncDigest(entry);
    })
    .sort((left, right) => left.ordinal - right.ordinal || compareStrings(left.event_id, right.event_id));
}

function deletedThreadEntryIds(
  entries: readonly CompanionTranscriptEntry[],
  prior: readonly { id: string; digest: string; ordinal: number }[] | undefined,
): string[] {
  const currentIds = new Set(entries.map((entry) => entry.event_id));
  return (prior ?? [])
    .filter((record) => !currentIds.has(record.id))
    .sort((left, right) => left.ordinal - right.ordinal || compareStrings(left.id, right.id))
    .map((record) => record.id);
}

/** Build an ordered thread delta while returning the latest non-entry metadata on every poll. */
export function buildCompanionThreadDelta(input: {
  orgId: string;
  actorId: string;
  companionId: string;
  thread: CompanionThread;
  cursor?: string;
}): CompanionThreadDeltaResponse {
  if (input.thread.companion_id !== input.companionId) {
    throw new Error("companion thread projection does not match requested Companion");
  }
  const previous = input.cursor
    ? decodeCursor(input.cursor, {
        kind: "thread",
        orgId: input.orgId,
        actorId: input.actorId,
        companionId: input.companionId,
      })
    : undefined;
  const previousThread = previous?.kind === "thread" && previous.v === 1 ? previous : undefined;
  const metadata = withoutThreadEntries(input.thread);
  const orderedEntries = [...input.thread.entries].sort(
    (left, right) => left.ordinal - right.ordinal || compareStrings(left.event_id, right.event_id),
  );
  const previousPrefix = previousThread
    ? orderedEntries.slice(0, previousThread.prefix_count)
    : [];
  const currentPrefixCount = Math.max(
    0,
    orderedEntries.length - COMPANION_THREAD_SYNC_CURSOR_TAIL_RECORDS,
  );
  const prefixStillMatches = previousThread !== undefined
    && currentPrefixCount >= previousThread.prefix_count
    && previousPrefix.length === previousThread.prefix_count
    && companionSyncDigest(entryDigestRecords(previousPrefix)) === previousThread.prefix_digest;
  const resetEntries = previousThread === undefined || !prefixStillMatches;
  const comparableEntries = previousThread
    ? orderedEntries.slice(previousThread.prefix_count)
    : orderedEntries;
  const response = {
    cursor: threadCursor({
      orgId: input.orgId,
      actorId: input.actorId,
      companionId: input.companionId,
      entries: input.thread.entries,
      metadata,
    }),
    reset_entries: resetEntries,
    changed_entries: resetEntries
      ? orderedEntries
      : changedThreadEntries(comparableEntries, previousThread.entries),
    deleted_event_ids: resetEntries
      ? []
      : deletedThreadEntryIds(comparableEntries, previousThread.entries),
    thread: metadata,
  } satisfies CompanionThreadDeltaResponse;
  return companionThreadDeltaResponseSchema.parse(response);
}

/** Decode and validate a cursor before expensive projection reads when a route wants early reject. */
export function validateCompanionSyncCursor(input: {
  cursor: string;
  kind: CursorPayload["kind"];
  orgId: string;
  actorId: string;
  companionId?: string;
}): void {
  decodeCursor(input.cursor, input);
}
