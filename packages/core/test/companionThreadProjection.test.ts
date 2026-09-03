import { describe, expect, it } from "vitest";
import type { CompanionTranscriptEntry } from "@companion/contracts";
import {
  collapseRoutineNotifyEntries,
  type RoutineNotifyReturn,
} from "../src/companionRuntimeApi";

const ROUTINE_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_RUN_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_RUN_ID = "33333333-3333-4333-8333-333333333333";
const THIRD_RUN_ID = "44444444-4444-4444-8444-444444444444";

function marker(
  runId: string,
  ordinal: number,
  name = "Skills Hub",
  routineId = ROUTINE_ID,
): CompanionTranscriptEntry {
  return {
    event_id: `msg:${runId}`,
    ordinal,
    role: "user",
    content: "Check for Skills Hub updates.",
    reasoning: null,
    author_id: "owner-1",
    author_name: "Owner",
    tool: null,
    decision: null,
    routine: { id: routineId, name, run_id: runId },
    trigger: null,
    turn_id: runId,
    queued: false,
    attachments: [],
    created_at: `2026-08-${String(ordinal + 10).padStart(2, "0")}T08:00:00.000Z`,
  };
}

function update(runId: string, ordinal: number, content: string): CompanionTranscriptEntry {
  return {
    event_id: `routine-return:${runId}`,
    ordinal,
    role: "assistant",
    content,
    reasoning: null,
    author_id: null,
    author_name: null,
    tool: null,
    decision: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    attachments: [],
    created_at: `2026-08-${String(ordinal + 10).padStart(2, "0")}T08:00:01.000Z`,
  };
}

function ordinary(ordinal: number): CompanionTranscriptEntry {
  return {
    event_id: `msg:ordinary-${ordinal}`,
    ordinal,
    role: "user",
    content: "What changed?",
    reasoning: null,
    author_id: "owner-1",
    author_name: "Owner",
    tool: null,
    decision: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    attachments: [],
    created_at: "2026-08-20T08:00:00.000Z",
  };
}

function returned(
  runId: string,
  name = "Skills Hub",
  routineId = ROUTINE_ID,
): RoutineNotifyReturn {
  return {
    run_id: runId,
    routine_id: routineId,
    routine_name: name,
    main_entry_event_id: `routine-return:${runId}`,
  };
}

describe("routine notify thread projection", () => {
  it("collapses consecutive returns from the same routine onto the latest full update", () => {
    const entries = [
      marker(FIRST_RUN_ID, 0),
      update(FIRST_RUN_ID, 1, "Skills Hub: 1.86.0 → 1.87.0."),
      marker(SECOND_RUN_ID, 2),
      update(SECOND_RUN_ID, 3, "Skills Hub: 1.87.0 → 1.88.0."),
      marker(THIRD_RUN_ID, 4),
      update(THIRD_RUN_ID, 5, "Skills Hub: 1.88.0 → 1.89.0."),
    ];

    const projected = collapseRoutineNotifyEntries(entries, [
      returned(FIRST_RUN_ID),
      returned(SECOND_RUN_ID),
      returned(THIRD_RUN_ID),
    ]);

    expect(projected.map((entry) => entry.event_id)).toEqual([
      `msg:${THIRD_RUN_ID}`,
      `routine-return:${THIRD_RUN_ID}`,
    ]);
    expect(projected[1]?.content).toBe("Skills Hub: 1.88.0 → 1.89.0.");
    expect(projected[1]?.routine_notify_group).toMatchObject({
      routine_name: "Skills Hub",
      total_count: 3,
    });
  });

  it("breaks a group when an ordinary turn appears between notify returns", () => {
    const projected = collapseRoutineNotifyEntries([
      marker(FIRST_RUN_ID, 0),
      update(FIRST_RUN_ID, 1, "First"),
      ordinary(2),
      marker(SECOND_RUN_ID, 3),
      update(SECOND_RUN_ID, 4, "Second"),
    ], [returned(FIRST_RUN_ID), returned(SECOND_RUN_ID)]);

    expect(projected).toHaveLength(5);
    expect(projected.every((entry) => entry.routine_notify_group == null)).toBe(true);
  });

  it("does not combine different routines that reuse the same display name", () => {
    const otherRoutineId = "55555555-5555-4555-8555-555555555555";
    const projected = collapseRoutineNotifyEntries([
      marker(FIRST_RUN_ID, 0),
      update(FIRST_RUN_ID, 1, "First"),
      marker(SECOND_RUN_ID, 2, "Skills Hub", otherRoutineId),
      update(SECOND_RUN_ID, 3, "Second"),
    ], [
      returned(FIRST_RUN_ID),
      returned(SECOND_RUN_ID, "Skills Hub", otherRoutineId),
    ]);

    expect(projected).toHaveLength(4);
    expect(projected.every((entry) => entry.routine_notify_group == null)).toBe(true);
  });

  it("preserves every hidden entry in deterministic inline expansion order", () => {
    const source = [
      marker(FIRST_RUN_ID, 0),
      update(FIRST_RUN_ID, 1, "First"),
      marker(SECOND_RUN_ID, 2),
      update(SECOND_RUN_ID, 3, "Second"),
    ];
    const first = collapseRoutineNotifyEntries(source, [
      returned(FIRST_RUN_ID),
      returned(SECOND_RUN_ID),
    ]);
    const second = collapseRoutineNotifyEntries(source, [
      returned(FIRST_RUN_ID),
      returned(SECOND_RUN_ID),
    ]);
    const group = first[1]?.routine_notify_group;

    expect(first).toEqual(second);
    expect([
      ...(group?.hidden_entries ?? []),
      ...first,
    ].map((entry) => entry.event_id)).toEqual(source.map((entry) => entry.event_id));
  });

  it("normalizes historical tied ordinals before collapsing routine returns", () => {
    const firstMarker = marker(FIRST_RUN_ID, 0);
    const firstUpdate = update(FIRST_RUN_ID, 0, "First");
    const secondMarker = marker(SECOND_RUN_ID, 1);
    const secondUpdate = update(SECOND_RUN_ID, 1, "Second");
    const notifyReturns = [returned(FIRST_RUN_ID), returned(SECOND_RUN_ID)];

    const first = collapseRoutineNotifyEntries([
      secondUpdate,
      firstMarker,
      secondMarker,
      firstUpdate,
    ], notifyReturns);
    const second = collapseRoutineNotifyEntries([
      firstUpdate,
      secondMarker,
      firstMarker,
      secondUpdate,
    ], notifyReturns);

    expect(first).toEqual(second);
    expect(first.map((entry) => entry.event_id)).toEqual([
      secondMarker.event_id,
      secondUpdate.event_id,
    ]);
    expect(first[1]?.routine_notify_group?.hidden_entries.map((entry) => entry.event_id)).toEqual([
      firstMarker.event_id,
      firstUpdate.event_id,
    ]);
  });

  it("keeps notify returns with attachments visible and outside later groups", () => {
    const attached = update(SECOND_RUN_ID, 3, "See the report.");
    attached.attachments = [{
      id: "55555555-5555-4555-8555-555555555555",
      kind: "pi_output",
      content_type: "image/png",
      byte_size: 128,
      filename: "report.png",
      position: 0,
      availability: "available",
      expires_at: "2026-09-02T12:00:00.000Z",
    }];
    const projected = collapseRoutineNotifyEntries([
      marker(FIRST_RUN_ID, 0),
      update(FIRST_RUN_ID, 1, "First"),
      marker(SECOND_RUN_ID, 2),
      attached,
      marker(THIRD_RUN_ID, 4),
      update(THIRD_RUN_ID, 5, "Third"),
    ], [returned(FIRST_RUN_ID), returned(SECOND_RUN_ID), returned(THIRD_RUN_ID)]);

    expect(projected).toHaveLength(6);
    expect(projected.every((entry) => entry.routine_notify_group == null)).toBe(true);
  });
});
