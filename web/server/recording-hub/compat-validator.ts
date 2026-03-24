/**
 * Compatibility validator for recorded sessions.
 *
 * Compares a recording's browser output messages structurally to detect
 * protocol drift. This catches changes when Claude Code or Codex update
 * their message format.
 */

import type { Recording } from "../replay.js";
import { filterEntries } from "../replay.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProtocolDiff {
  entryIndex: number;
  expected: { type: string; [key: string]: unknown };
  actual: { type: string; [key: string]: unknown } | null;
  kind: "missing" | "extra" | "type_mismatch" | "field_mismatch";
  details: string;
}

export interface ValidationResult {
  compatible: boolean;
  backendType: string;
  totalMessages: number;
  diffs: ProtocolDiff[];
  messageTypeBreakdown: Record<string, { count: number; issues: number }>;
}

// Fields to ignore during comparison (they change between runs)
const IGNORED_FIELDS = new Set([
  "timestamp",
  "ts",
  "created_at",
  "updated_at",
  "session_id",
  "uuid",
  "id",
  "request_id",
  "duration_ms",
  "duration_api_ms",
  "cost_usd",
  "total_cost_usd",
  "api_tokens",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
]);

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a recording's structural consistency.
 *
 * Checks that browser messages have expected types, required fields are present,
 * and message type distribution is reasonable.
 */
export function validateRecording(recording: Recording): ValidationResult {
  const browserMessages = filterEntries(recording.entries, "out", "browser");
  const diffs: ProtocolDiff[] = [];
  const typeBreakdown: Record<string, { count: number; issues: number }> = {};

  for (let i = 0; i < browserMessages.length; i++) {
    const entry = browserMessages[i];
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(entry.raw);
    } catch {
      diffs.push({
        entryIndex: i,
        expected: { type: "valid_json" },
        actual: null,
        kind: "missing",
        details: `Entry ${i}: unparseable JSON`,
      });
      continue;
    }

    const msgType = String(parsed.type || "unknown");

    if (!typeBreakdown[msgType]) {
      typeBreakdown[msgType] = { count: 0, issues: 0 };
    }
    typeBreakdown[msgType].count++;

    // Validate required fields per message type
    const issues = validateMessageStructure(msgType, parsed, i);
    for (const issue of issues) {
      diffs.push(issue);
      typeBreakdown[msgType].issues++;
    }
  }

  return {
    compatible: diffs.length === 0,
    backendType: recording.header.backend_type,
    totalMessages: browserMessages.length,
    diffs,
    messageTypeBreakdown: typeBreakdown,
  };
}

/**
 * Compare two recordings structurally.
 *
 * Useful for verifying that replaying CLI input through the adapter produces
 * the same browser output. Returns diffs where messages diverge.
 */
export function compareRecordings(
  expected: Recording,
  actual: { type: string; [key: string]: unknown }[],
): ProtocolDiff[] {
  const expectedMsgs = filterEntries(expected.entries, "out", "browser");
  const diffs: ProtocolDiff[] = [];

  const maxLen = Math.max(expectedMsgs.length, actual.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= expectedMsgs.length) {
      diffs.push({
        entryIndex: i,
        expected: { type: "none" },
        actual: actual[i],
        kind: "extra",
        details: `Extra message at index ${i}: type=${actual[i].type}`,
      });
      continue;
    }

    if (i >= actual.length) {
      let expectedParsed: Record<string, unknown>;
      try {
        expectedParsed = JSON.parse(expectedMsgs[i].raw);
      } catch {
        expectedParsed = { type: "unparseable" };
      }
      diffs.push({
        entryIndex: i,
        expected: expectedParsed as { type: string },
        actual: null,
        kind: "missing",
        details: `Missing message at index ${i}: expected type=${expectedParsed.type}`,
      });
      continue;
    }

    let expectedParsed: Record<string, unknown>;
    try {
      expectedParsed = JSON.parse(expectedMsgs[i].raw);
    } catch {
      diffs.push({
        entryIndex: i,
        expected: { type: "unparseable" },
        actual: actual[i],
        kind: "field_mismatch",
        details: `Entry ${i}: expected message has unparseable JSON`,
      });
      continue;
    }

    const actualMsg = actual[i];

    // Type must match
    if (expectedParsed.type !== actualMsg.type) {
      diffs.push({
        entryIndex: i,
        expected: expectedParsed as { type: string },
        actual: actualMsg as { type: string },
        kind: "type_mismatch",
        details: `Type mismatch at index ${i}: expected=${expectedParsed.type}, actual=${actualMsg.type}`,
      });
      continue;
    }

    // Check for missing/extra top-level fields (excluding ignored fields)
    const fieldDiffs = compareFields(expectedParsed, actualMsg, i);
    diffs.push(...fieldDiffs);
  }

  return diffs;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateMessageStructure(
  type: string,
  msg: Record<string, unknown>,
  index: number,
): ProtocolDiff[] {
  const issues: ProtocolDiff[] = [];

  // All messages must have a type field
  if (!msg.type) {
    issues.push({
      entryIndex: index,
      expected: { type: "any" },
      actual: msg as { type: string },
      kind: "field_mismatch",
      details: `Entry ${index}: missing 'type' field`,
    });
  }

  // Type-specific validation
  switch (type) {
    case "session_init":
      if (!msg.session || typeof msg.session !== "object") {
        issues.push({
          entryIndex: index,
          expected: { type, session: "object" },
          actual: msg as { type: string },
          kind: "field_mismatch",
          details: `Entry ${index}: session_init missing 'session' object`,
        });
      }
      break;

    case "permission_request":
      if (!msg.tool_name) {
        issues.push({
          entryIndex: index,
          expected: { type, tool_name: "string" },
          actual: msg as { type: string },
          kind: "field_mismatch",
          details: `Entry ${index}: permission_request missing 'tool_name'`,
        });
      }
      break;

    case "result":
      if (!msg.subtype) {
        issues.push({
          entryIndex: index,
          expected: { type, subtype: "string" },
          actual: msg as { type: string },
          kind: "field_mismatch",
          details: `Entry ${index}: result missing 'subtype'`,
        });
      }
      break;
  }

  return issues;
}

function compareFields(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  index: number,
): ProtocolDiff[] {
  const diffs: ProtocolDiff[] = [];

  const expectedKeys = Object.keys(expected).filter((k) => !IGNORED_FIELDS.has(k));
  const actualKeys = Object.keys(actual).filter((k) => !IGNORED_FIELDS.has(k));

  // Check for missing fields in actual
  for (const key of expectedKeys) {
    if (!(key in actual)) {
      diffs.push({
        entryIndex: index,
        expected: expected as { type: string },
        actual: actual as { type: string },
        kind: "field_mismatch",
        details: `Entry ${index}: missing field '${key}' in actual (type=${expected.type})`,
      });
    }
  }

  // Check for unexpected new fields in actual (informational, not necessarily a break)
  for (const key of actualKeys) {
    if (!(key in expected)) {
      diffs.push({
        entryIndex: index,
        expected: expected as { type: string },
        actual: actual as { type: string },
        kind: "field_mismatch",
        details: `Entry ${index}: new field '${key}' in actual (type=${actual.type})`,
      });
    }
  }

  return diffs;
}
