import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CompanionRoutineNotifyReturn,
  CompanionThread,
  CompanionThreadDeltaResponse,
  CompanionThreadWindow,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import {
  collapseLoadedRoutineNotifyEntries,
  getCompanionThread,
  openCompanionThreadWindow,
  type SyncedCompanionThread,
} from "./companions";

const companionId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

function entry(index: number, overrides: Partial<CompanionTranscriptEntry> = {}): CompanionTranscriptEntry {
  return {
    event_id: `event:${index}`,
    ordinal: index,
    role: "assistant",
    content: `message ${index}`,
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
    created_at: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

const metadata: Omit<CompanionThread, "entries"> = {
  companion_id: companionId,
  viewer_id: "user-1",
  access: "owner",
  read_only: false,
  can_send: true,
  active_turn: null,
  queued_count: 0,
  interrupted_turn: null,
  last_message_at: "2026-08-31T12:00:00.000Z",
  last_read_ordinal: null,
};

type ThreadTestResponse = CompanionThreadWindow
  | CompanionThreadDeltaResponse
  | { thread: CompanionThread }
  | { error: string };

function response(body: ThreadTestResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounded Companion thread synchronization", () => {
  it("bootstraps only the latest 50-entry window", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => response({
      thread: metadata,
      entries: Array.from({ length: 50 }, (_, index) => entry(index + 1_951)),
      older_cursor: "older",
      sync_cursor: "sync-1",
      notify_returns: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const opened = await openCompanionThreadWindow(orgId, companionId);
    expect(opened.entries).toHaveLength(50);
    expect(opened.client_sync).toMatchObject({ cursor: "sync-1", older_cursor: "older" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/thread-window?limit=50");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/thread-delta");
  });

  it("drains has_more immediately while keeping an old-page reader on 150 mounted entries", async () => {
    const current: SyncedCompanionThread = {
      ...metadata,
      entries: Array.from({ length: 150 }, (_, index) => entry(index)),
      client_sync: {
        cursor: "sync-1",
        older_cursor: "older",
        notify_returns: [],
        unseen_new_count: 0,
        unseen_event_ids: [],
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        cursor: "sync-2",
        reset_entries: false,
        changed_entries: [entry(2_001)],
        deleted_event_ids: [],
        thread: metadata,
        has_more: true,
        notify_returns: [],
      }))
      .mockResolvedValueOnce(response({
        cursor: "sync-3",
        reset_entries: false,
        changed_entries: [entry(2_002)],
        deleted_event_ids: [],
        thread: metadata,
        has_more: false,
        notify_returns: [],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const next = await getCompanionThread(orgId, companionId, {
      cursor: "sync-1",
      current,
      preserveHistory: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(next.entries).toHaveLength(150);
    expect(next.client_sync).toMatchObject({
      cursor: "sync-3",
      unseen_new_count: 2,
      unseen_event_ids: ["event:2001", "event:2002"],
    });
  });

  it("refreshes the signed page boundary before live growth can mount more than 150 entries", async () => {
    const current: SyncedCompanionThread = {
      ...metadata,
      entries: Array.from({ length: 150 }, (_, index) => entry(index)),
      client_sync: {
        cursor: "sync-1",
        older_cursor: "stale-older",
        notify_returns: [],
        unseen_new_count: 0,
        unseen_event_ids: [],
      },
    };
    const latest = Array.from({ length: 50 }, (_, index) => entry(index + 102));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        cursor: "sync-2",
        reset_entries: false,
        changed_entries: [entry(151)],
        deleted_event_ids: [],
        thread: metadata,
        has_more: false,
        notify_returns: [],
      }))
      .mockResolvedValueOnce(response({
        thread: metadata,
        entries: latest,
        older_cursor: "fresh-older",
        sync_cursor: "sync-2",
        notify_returns: [],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const next = await getCompanionThread(orgId, companionId, {
      cursor: "sync-1",
      current,
    });

    expect(next.entries).toEqual(latest);
    expect(next.client_sync?.older_cursor).toBe("fresh-older");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/thread-window?limit=50");
  });

  it("falls back to the temporary full-thread route only when an old API lacks windows", async () => {
    const legacy: CompanionThread = { ...metadata, entries: [entry(1)] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: "not found" }, 404))
      .mockResolvedValueOnce(response({ thread: legacy }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(openCompanionThreadWindow(orgId, companionId)).resolves.toEqual(legacy);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/thread-window");
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/thread$/);
  });

  it("groups only adjacent routine notifications in the mounted window", () => {
    const routineId = "33333333-3333-4333-8333-333333333333";
    const runs = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    const entries = runs.flatMap((runId, index) => [
      entry(index * 2, {
        event_id: `marker:${index}`,
        role: "user",
        routine: { id: routineId, name: "Daily report", run_id: runId },
        turn_id: runId,
      }),
      entry(index * 2 + 1, { event_id: `return:${index}` }),
    ]);
    const returns: CompanionRoutineNotifyReturn[] = runs.map((runId, index) => ({
      run_id: runId,
      routine_id: routineId,
      routine_name: "Daily report",
      main_entry_event_id: `return:${index}`,
    }));

    const collapsed = collapseLoadedRoutineNotifyEntries(entries, returns);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[1]?.routine_notify_group).toMatchObject({
      routine_id: routineId,
      routine_name: "Daily report",
      total_count: 2,
    });
  });
});
