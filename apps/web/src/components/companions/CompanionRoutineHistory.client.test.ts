// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- The rendered drawer test replaces only its bounded HTTP client. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CompanionRoutineRunDetail,
  CompanionRoutineRunSummary,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const historyApi = vi.hoisted(() => ({
  listCompanionRoutineRuns: vi.fn(),
  readCompanionRoutineRun: vi.fn(),
}));

vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...historyApi,
}));

const { CompanionRoutineHistory } = await import("./CompanionRoutineHistory");

// SAFETY: React's test harness reads this documented global flag; the test owns its boolean value.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const secondRunId = "44444444-4444-4444-8444-444444444444";
const roots: Root[] = [];

const summary: CompanionRoutineRunSummary = {
  run_id: runId,
  companion_id: companionId,
  routine: { id: routineId, name: "Morning brief" },
  status: "succeeded",
  outcome: "surfaced",
  surface_mode: "notify",
  main_entry_event_id: "routine-return:1",
  relay_turn_id: null,
  created_at: "2026-08-27T09:00:00.000Z",
  started_at: "2026-08-27T09:00:01.000Z",
  settled_at: "2026-08-27T09:00:05.000Z",
  error: null,
};

const firstPage: CompanionRoutineRunDetail = {
  ...summary,
  internal_entries: [{
    event_id: "routine:assistant:1",
    ordinal: 0,
    role: "assistant",
    content: "Checked the overnight deployment.",
    reasoning: "Compared the release with the incident log.",
    tool: null,
    decision: null,
    created_at: "2026-08-27T09:00:02.000Z",
  }],
  next_entry_cursor: 1,
};

function interruptedDetail(): CompanionRoutineRunDetail {
  return {
    ...firstPage,
    status: "interrupted",
    outcome: "error",
    surface_mode: null,
    main_entry_event_id: null,
    recovery_status: "pending",
    settled_at: "2026-08-27T09:10:00.000Z",
    error: {
      code: "turn_stalled",
      message: "The Companion stopped making progress.",
      action: "retry",
    },
    next_entry_cursor: null,
  };
}

const secondPage: CompanionRoutineRunDetail = {
  ...summary,
  internal_entries: [{
    event_id: "routine:tool:2",
    ordinal: 1,
    role: "tool",
    content: "",
    reasoning: null,
    tool: {
      call_id: "tool-1",
      kind: "shell",
      name: "bash",
      title: "pnpm test",
      status: "ok",
      detail: "42 tests passed",
      screenshot: null,
    },
    decision: null,
    created_at: "2026-08-27T09:00:04.000Z",
  }],
  next_entry_cursor: null,
};

const alternateSummary: CompanionRoutineRunSummary = {
  ...summary,
  run_id: secondRunId,
  created_at: "2026-08-27T10:00:00.000Z",
  started_at: "2026-08-27T10:00:01.000Z",
  settled_at: "2026-08-27T10:00:05.000Z",
};

const alternateDetail: CompanionRoutineRunDetail = {
  ...alternateSummary,
  internal_entries: [{
    ...firstPage.internal_entries[0]!,
    event_id: "routine:assistant:alternate",
    content: "The later run completed cleanly.",
    created_at: "2026-08-27T10:00:02.000Z",
  }],
  next_entry_cursor: null,
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(run: string | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async () => {
    await act(async () => root.render(React.createElement(CompanionRoutineHistory, {
      orgId: "org-1",
      companionId,
      target: { routineId, runId: run, name: "Morning brief" },
      memberTimezone: "UTC",
      onClose: () => undefined,
    })));
  };
  await render();
  await flush();
  return { container };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === name);
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

describe("Companion routine history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyApi.listCompanionRoutineRuns.mockResolvedValue({
      runs: [summary],
      next_cursor: null,
    });
    historyApi.readCompanionRoutineRun
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("moves from newest-first run history into the private paginated transcript", async () => {
    const { container } = await mount();

    expect(container.textContent).toContain("Notified in main chat");
    expect(container.textContent).toContain("Completed");
    expect(historyApi.listCompanionRoutineRuns).toHaveBeenCalledWith(
      "org-1",
      companionId,
      routineId,
      { limit: 20, cursor: undefined },
    );

    const runButton = container.querySelector<HTMLButtonElement>(".routine-history__run-button");
    await act(async () => runButton?.click());
    await flush();

    expect(container.textContent).toContain("Internal transcript");
    expect(container.textContent).toContain("Checked the overnight deployment.");
    expect(container.textContent).toContain("Reasoning");
    expect(container.textContent).not.toContain("42 tests passed");

    await act(async () => buttonNamed(container, "Load more transcript").click());
    await flush();

    expect(historyApi.readCompanionRoutineRun).toHaveBeenLastCalledWith(
      "org-1",
      companionId,
      runId,
      { entryLimit: 50, entryCursor: 1 },
    );
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).toContain("Tool details");
  });

  it("opens a marker-linked run directly and keeps a path back to the routine list", async () => {
    const { container } = await mount(runId);

    expect(container.textContent).toContain("Routine run");
    expect(container.textContent).toContain("Checked the overnight deployment.");
    expect(container.querySelector("button[aria-label='Back to Morning brief runs']")).not.toBeNull();
  });

  it("ignores stale detail failures after selecting a different run", async () => {
    let rejectFirst!: (cause: Error) => void;
    let resolveSecond!: (detail: CompanionRoutineRunDetail) => void;
    const firstRequest = new Promise<CompanionRoutineRunDetail>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondRequest = new Promise<CompanionRoutineRunDetail>((resolve) => {
      resolveSecond = resolve;
    });
    historyApi.listCompanionRoutineRuns.mockResolvedValue({
      runs: [summary, alternateSummary],
      next_cursor: null,
    });
    historyApi.readCompanionRoutineRun.mockReset();
    historyApi.readCompanionRoutineRun.mockImplementation(
      (_orgId: string, _companionId: string, requestedRunId: string) => (
        requestedRunId === runId ? firstRequest : secondRequest
      ),
    );

    const { container } = await mount();
    const runButtons = () => [
      ...container.querySelectorAll<HTMLButtonElement>(".routine-history__run-button"),
    ];
    await act(async () => runButtons()[0]?.click());
    await flush();
    const back = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Back to Morning brief runs']",
    );
    await act(async () => back?.click());
    await flush();
    await act(async () => runButtons()[1]?.click());

    await act(async () => resolveSecond(alternateDetail));
    await flush();
    expect(container.textContent).toContain("The later run completed cleanly.");

    await act(async () => rejectFirst(new Error("stale first-run failure")));
    await flush();
    expect(container.textContent).not.toContain("stale first-run failure");
    expect(container.textContent).toContain("The later run completed cleanly.");
  });

  it("shows automatic cleanup without exposing replay or cancellation actions", async () => {
    const interrupted = interruptedDetail();
    historyApi.readCompanionRoutineRun.mockReset().mockResolvedValue(interrupted);

    const { container } = await mount(runId);

    expect(container.textContent).toContain("Automatic cleanup for this run is queued");
    expect(container.textContent).toContain("will not be replayed");
    expect(container.textContent).not.toContain("Retry run");
    expect(container.textContent).not.toContain("Cancel run");
  });

  it("polls active cleanup metadata without losing transcript pages already loaded", async () => {
    vi.useFakeTimers();
    const interrupted = { ...interruptedDetail(), next_entry_cursor: 1 };
    const interruptedSecondPage = {
      ...interrupted,
      internal_entries: secondPage.internal_entries,
      next_entry_cursor: null,
    };
    historyApi.readCompanionRoutineRun.mockReset()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(interruptedSecondPage)
      .mockResolvedValueOnce({ ...interrupted, recovery_status: "completed" });

    const { container } = await mount(runId);
    await act(async () => buttonNamed(container, "Load more transcript").click());
    await flush();
    expect(container.textContent).toContain("pnpm test");

    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    await flush();

    expect(container.textContent).toContain("Automatic cleanup for this run is complete");
    expect(container.textContent).toContain("pnpm test");
    expect(historyApi.readCompanionRoutineRun).toHaveBeenCalledTimes(3);
  });

  it("shows pending backoff when a running cleanup cycle is re-armed", async () => {
    vi.useFakeTimers();
    const running = { ...interruptedDetail(), recovery_status: "running" as const };
    historyApi.readCompanionRoutineRun.mockReset()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, recovery_status: "pending" });

    const { container } = await mount(runId);
    expect(container.textContent).toContain("Automatic cleanup for this run is running");

    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    await flush();

    expect(container.textContent).toContain("Automatic cleanup for this run is queued");
  });

  it("keeps completed cleanup proof when an older transcript page arrives later", async () => {
    vi.useFakeTimers();
    const running = {
      ...interruptedDetail(),
      recovery_status: "running" as const,
      next_entry_cursor: 1,
    };
    historyApi.readCompanionRoutineRun.mockReset()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, recovery_status: "completed" })
      .mockResolvedValueOnce({
        ...running,
        internal_entries: secondPage.internal_entries,
        next_entry_cursor: null,
      });

    const { container } = await mount(runId);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    await flush();
    expect(container.textContent).toContain("Automatic cleanup for this run is complete");

    await act(async () => buttonNamed(container, "Load more transcript").click());
    await flush();

    expect(container.textContent).toContain("Automatic cleanup for this run is complete");
    expect(container.textContent).toContain("pnpm test");
  });
});
