// @vitest-environment happy-dom
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Existing tests predate the incremental anti-slop gate. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionOperation,
  CompanionRoutine,
  CompanionThread as Thread,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionThread, type CompanionContextPanel } from "./CompanionThread";
import { CHAT_VIEWPORT_SETTLE_MS } from "./useVisualViewportPin";

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
    latest_operation: null,
  },
  created_at: "2026-08-12T12:00:00.000Z",
  updated_at: "2026-08-12T12:00:00.000Z",
};

const thread: Thread = {
  companion_id: companionId,
  viewer_id: "user-1",
  access: "owner",
  read_only: false,
  can_send: true,
  entries: [],
  active_turn: null,
  queued_count: 0,
  interrupted_turn: null,
  last_message_at: null,
  last_read_ordinal: null,
};

const interruptedThread: Thread = {
  ...thread,
  interrupted_turn: {
    id: "22222222-2222-4222-8222-222222222222",
    companion_id: companionId,
    client_message_id: "33333333-3333-4333-8333-333333333333",
    status: "interrupted",
    queue_sequence: 1,
    latest_attempt: null,
    replying: false,
    error: {
      code: "dispatch_ambiguous",
      message: "Pi acknowledgement was not confirmed.",
      action: "retry",
    },
    state_changed_at: "2026-08-12T12:00:00.000Z",
    settled_at: "2026-08-12T12:00:00.000Z",
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  },
};

const retryOperation: CompanionOperation = {
  id: "44444444-4444-4444-8444-444444444444",
  companion_id: companionId,
  request_id: "55555555-5555-4555-8555-555555555555",
  source_turn_id: interruptedThread.interrupted_turn!.id,
  kind: "restart_pi",
  trigger: "user",
  status: "pending",
  queue_sequence: 2,
  checkpoint: "queued",
  attempt_count: 0,
  error: null,
  created_at: "2026-08-12T12:01:00.000Z",
  started_at: null,
  settled_at: null,
};

const roots: Root[] = [];

/** A closed context panel: what these cases render unless one asks for it open. */
function contextPanel(overrides: Partial<CompanionContextPanel> = {}): CompanionContextPanel {
  return {
    open: false,
    desktop: null,
    joining: false,
    error: null,
    onToggle: () => {},
    onJoin: () => {},
    ...overrides,
  };
}

async function mount(
  onSend: (content: string, clientMessageId: string) => Promise<boolean>,
  overrides: {
    companion?: Companion;
    thread?: Thread;
    onDesktop?: () => void;
    onRetryInterrupted?: (turnId: string, retryId: string) => Promise<CompanionOperation>;
    onCancelInterrupted?: (turnId: string) => Promise<void>;
    context?: Partial<CompanionContextPanel>;
    contextRoutines?: CompanionRoutine[];
    hasOlderMessages?: boolean;
    loadingOlderMessages?: boolean;
    onLoadOlderMessages?: () => Promise<void> | void;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionThread, {
      companion: overrides.companion ?? companion,
      thread: overrides.thread ?? thread,
      error: null,
      busy: false,
      openingDesktop: false,
      context: contextPanel(overrides.context),
      contextSkills: [],
      contextRoutines: overrides.contextRoutines ?? [],
      hasOlderMessages: overrides.hasOlderMessages ?? false,
      loadingOlderMessages: overrides.loadingOlderMessages ?? false,
      onLoadOlderMessages: overrides.onLoadOlderMessages,
      onBack: () => {},
      orgId: "org-1",
      onSend,
      onSettings: () => {},
      onThread: () => {},
      onDesktop: overrides.onDesktop ?? (() => {}),
      onRetryInterrupted: overrides.onRetryInterrupted ?? (async () => retryOperation),
      onCancelInterrupted: overrides.onCancelInterrupted ?? (async () => {}),
    }));
  });
  return container;
}

/** A mounted thread whose read model can be replaced, the way each poll replaces it in the app. */
async function mountPolling(
  initial: Thread,
  onRetryInterrupted: (turnId: string, retryId: string) => Promise<CompanionOperation> =
    async () => retryOperation,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const poll = async (next: Thread, who: Companion = companion) => {
    await act(async () => {
      root.render(React.createElement(CompanionThread, {
        companion: who,
        thread: next,
        error: null,
        busy: false,
        openingDesktop: false,
        context: contextPanel(),
        contextSkills: [],
        onBack: () => {},
        orgId: "org-1",
        onSend: async () => true,
        onSettings: () => {},
        onThread: () => {},
        onDesktop: () => {},
        onRetryInterrupted,
        onCancelInterrupted: async () => {},
      }));
    });
  };
  await poll(initial);
  return { container, poll };
}

function log(container: HTMLElement) {
  return (container.querySelector("[role='log']") as HTMLElement).textContent ?? "";
}

function boxChip(container: HTMLElement) {
  return container.querySelector(".chat-box") as HTMLElement;
}

function type(container: HTMLElement, value: string) {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(composer, value);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return composer;
}

async function send(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function sendButton(container: HTMLElement) {
  return container.querySelector("button[aria-label='Send message']") as HTMLButtonElement;
}

/** A finger landing on a control, which is the moment iOS starts resolving a tap. */
function pressed(target: Element) {
  const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function keyDown(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("CompanionThread composer", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("keeps interrupted work non-blocking and never exposes replay controls", async () => {
    const onSend = vi.fn(async () => true);
    const onRetryInterrupted = vi.fn(async () => retryOperation);
    const onCancelInterrupted = vi.fn(async () => {});
    const container = await mount(onSend, {
      thread: interruptedThread,
      onRetryInterrupted,
      onCancelInterrupted,
    });

    expect(container.textContent).toContain("Pi cleanup is queued automatically");
    expect(container.textContent).toContain("will not be replayed");
    expect(container.textContent).not.toContain("Retry turn");
    expect(container.textContent).not.toContain("Cancel turn");
    expect(sendButton(container).disabled).toBe(true);

    type(container, "Continue with the next task");
    expect(sendButton(container).disabled).toBe(false);
    await send(container);

    expect(onSend).toHaveBeenCalledWith(
      "Continue with the next task",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      [],
    );
    expect(onRetryInterrupted).not.toHaveBeenCalled();
    expect(onCancelInterrupted).not.toHaveBeenCalled();
  });

  it("reports a running automatic cleanup without unmounting a failed-send draft", async () => {
    const recoveringCompanion: Companion = {
      ...companion,
      runtime: {
        ...companion.runtime,
        recovery: {
          turn_id: interruptedThread.interrupted_turn!.id,
          lane: "main",
          status: "running",
        },
      },
    };
    const container = await mount(async () => false, {
      companion: recoveringCompanion,
      thread: interruptedThread,
    });
    const composer = type(container, "Keep this draft safe");

    await send(container);

    expect(container.textContent).toContain("Pi cleanup is running automatically");
    expect(composer.value).toBe("Keep this draft safe");
  });

  it("anchors the scroll position when an older page is prepended", async () => {
    let scrollHeight = 1_000;
    const onLoadOlderMessages = vi.fn(async () => { scrollHeight = 1_400; });
    const container = await mount(async () => true, {
      hasOlderMessages: true,
      onLoadOlderMessages,
    });
    const viewport = container.querySelector<HTMLElement>("[data-slot='aui_thread-viewport']")!;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    viewport.scrollTop = 120;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const load = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Load earlier messages")!;

    await act(async () => load.click());

    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    expect(viewport.scrollTop).toBe(520);
  });

  it("keeps the typed message when the send fails", async () => {
    const container = await mount(async () => false);
    const composer = type(container, "Draft the launch note");

    await send(container);

    expect(composer.value).toBe("Draft the launch note");
  });

  it("clears the composer once the message is persisted", async () => {
    const container = await mount(async () => true);
    const composer = type(container, "Draft the launch note");

    await send(container);

    expect(composer.value).toBe("");
  });

  it("reuses the message id when a restored draft is sent again", async () => {
    // THE-341: a response can be lost after the turn becomes durable. Pressing Enter on the restored
    // draft must name that same turn rather than mint a second one.
    const ids: string[] = [];
    let answer = false;
    const container = await mount(async (_content, clientMessageId) => {
      ids.push(clientMessageId);
      return answer;
    });
    const composer = type(container, "Draft the launch note");

    await send(container);
    expect(composer.value).toBe("Draft the launch note");

    answer = true;
    await send(container);

    expect(composer.value).toBe("");
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("mints a fresh id once a restored draft is edited before resending", async () => {
    // Reuse is only for the identical draft: a message the sender changed before retrying is a
    // different message, so it must name a different turn.
    const ids: string[] = [];
    const container = await mount(async (_content, clientMessageId) => {
      ids.push(clientMessageId);
      return false;
    });
    type(container, "Draft the launch note");
    await send(container);
    type(container, "Draft the changelog entry");
    await send(container);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("moves focus into the thread that just opened", async () => {
    const container = await mount(async () => true);

    expect(document.activeElement).toBe(container.querySelector("h1"));
  });

  it("shows the message while the control plane is still saving it", async () => {
    let settle: (saved: boolean) => void = () => {};
    const container = await mount(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    type(container, "Draft the launch note");

    await send(container);

    // The composer clears on send, so the message has to appear in the transcript immediately or the
    // text disappears with nothing to show for it.
    expect(log(container)).toContain("Draft the launch note");

    await act(async () => {
      settle(true);
    });

    // The bounded ACK carries no thread snapshot. Keep the accepted copy until a later poll returns
    // the same event id; clearing it at ACK would make the committed message disappear.
    expect(container.querySelectorAll("[data-role='user'] [aria-busy='true']")).toHaveLength(1);
  });

  it("sends one message even when the composer is submitted twice", async () => {
    const sent: string[] = [];
    let settle: (saved: boolean) => void = () => {};
    const container = await mount((content) => {
      sent.push(content);
      return new Promise<boolean>((resolve) => { settle = resolve; });
    });
    type(container, "Draft the launch note");

    await send(container);
    await send(container);
    await act(async () => {
      settle(true);
    });

    expect(sent).toEqual(["Draft the launch note"]);
  });

  it("names each message once, so a resent request can only be the same turn", async () => {
    const ids: string[] = [];
    const container = await mount(async (_content, clientMessageId) => {
      ids.push(clientMessageId);
      return true;
    });

    type(container, "Draft the launch note");
    await send(container);
    type(container, "And the changelog entry");
    await send(container);

    // One id per submission: the control plane stores the turn a resent request names once, and two
    // separate messages are still two turns.
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("shows one message when the saved thread arrives while the send is still in flight", async () => {
    // The message a composer shows carries the id the control plane stores it under, so a thread read
    // that lands mid-send replaces it instead of adding a second copy of the same turn.
    let sentId = "";
    let settle: (saved: boolean) => void = () => {};
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (next: Thread) => React.createElement(CompanionThread, {
      companion,
      thread: next,
      error: null,
      busy: false,
      openingDesktop: false,
      context: contextPanel(),
      contextSkills: [],
      onBack: () => {},
      orgId: "org-1",
      onSend: (_content: string, clientMessageId: string) => {
        sentId = clientMessageId;
        return new Promise<boolean>((resolve) => { settle = resolve; });
      },
      onSettings: () => {},
      onThread: () => {},
      onDesktop: () => {},
      onRetryInterrupted: async () => retryOperation,
      onCancelInterrupted: async () => {},
    });
    await act(async () => {
      root.render(render(thread));
    });
    type(container, "Draft the launch note");
    await send(container);

    await act(async () => {
      root.render(render({
        ...thread,
        entries: [{
          event_id: `msg:${sentId}`,
          ordinal: 0,
          role: "user",
          content: "Draft the launch note",
          author_id: "user-1",
          author_name: null,
          tool: null,
    decision: null,
    attachments: [],
          reasoning: null,
          routine: null,
          trigger: null,
          turn_id: null,
          queued: false,
          created_at: "2026-08-12T12:01:00.000Z",
        }],
      }));
    });

    expect(container.querySelectorAll("[data-role='user']")).toHaveLength(1);

    await act(async () => {
      settle(true);
    });

    expect(container.querySelectorAll("[data-role='user']")).toHaveLength(1);
  });

  it("hands the next Companion an empty composer instead of the previous draft", async () => {
    const atlas: Companion = { ...companion, id: "22222222-2222-4222-8222-222222222222", name: "Atlas" };
    const { container, poll } = await mountPolling(thread);
    type(container, "Draft the launch note");

    await poll(thread, atlas);

    // A draft belongs to the conversation it was written for; carrying it over would put it one
    // Enter away from the wrong Companion.
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the draft when Escape is pressed in the composer", async () => {
    const container = await mount(async () => true);
    const composer = type(container, "Draft the launch note");

    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(composer.value).toBe("Draft the launch note");
  });
});

describe("CompanionThread stream", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  const said = {
    event_id: "msg:1",
    ordinal: 0,
    role: "user" as const,
    content: "Draft the launch note",
    author_id: "user-1",
    author_name: null,
    tool: null,
    decision: null,
    attachments: [],
    reasoning: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    created_at: "2026-08-12T12:01:00.000Z",
  };

  const reply = (content: string) => ({
    event_id: "pi:512",
    ordinal: 1,
    role: "assistant" as const,
    content,
    author_id: null,
    author_name: null,
    tool: null,
    decision: null,
    attachments: [],
    reasoning: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: false,
    created_at: "2026-08-12T12:01:20.000Z",
  });

  it("grows a streamed reply in place instead of appending a second one", async () => {
    const { container, poll } = await mountPolling({ ...thread, entries: [said, reply("Skills Hub")] });
    const before = container.querySelector("[data-role='assistant']");

    await poll({ ...thread, entries: [said, reply("Skills Hub 2.4 is out. The migration is idempotent.")] });

    const after = container.querySelectorAll("[data-role='assistant']");
    expect(after).toHaveLength(1);
    // The same element carries the longer text: the reply is rewritten, never torn down and rebuilt,
    // which is what would make a streamed turn flicker.
    expect(after.item(0)).toBe(before);
    expect(after.item(0).textContent).toContain("The migration is idempotent.");
  });

  it("keeps a turn that arrives as more than one reply as one message", async () => {
    const { container, poll } = await mountPolling({
      ...thread,
      entries: [said, reply("Skills Hub 2.4 is out.")],
    });

    await poll({
      ...thread,
      entries: [
        said,
        reply("Skills Hub 2.4 is out."),
        {
          event_id: "pi:1180",
          ordinal: 2,
          role: "assistant" as const,
          content: "The migration is idempotent.",
          author_id: null,
          author_name: null,
          tool: null,
    decision: null,
    attachments: [],
          reasoning: null,
          routine: null,
          trigger: null,
          turn_id: null,
          queued: false,
          created_at: "2026-08-12T12:01:24.000Z",
        },
      ],
    });

    // Two entries, one turn: the second reply is another part of the same message rather than a
    // second message, so the turn is announced once and reads as one thing that happened.
    expect(container.querySelectorAll("[data-role='assistant']")).toHaveLength(1);
    expect(log(container).match(/Luna/g)).toHaveLength(1);
    expect(container.querySelectorAll("[data-role='assistant'] time")).toHaveLength(1);
    expect(log(container)).toContain("The migration is idempotent.");
  });

  it("shows a turn that only produced reasoning as Luna's reply", async () => {
    // A turn with no text part falls back to its thinking, so it arrives as an ordinary assistant
    // entry and has to read as a reply rather than as a note about the run.
    const { container } = await mountPolling({
      ...thread,
      entries: [said, reply("The note is already accurate, so there is nothing to change.")],
    });

    expect(container.querySelectorAll("[data-role='assistant']")).toHaveLength(1);
    expect(container.querySelectorAll("[data-role='system']")).toHaveLength(0);
    expect(log(container)).toContain("The note is already accurate");
  });

  it("closes a turn that produced nothing with a note instead of leaving the thread pending", async () => {
    const settled = {
      ...thread,
      entries: [
        said,
        {
          event_id: "pi:1602",
          ordinal: 1,
          role: "system" as const,
          content: "Pi ended the turn without a visible reply.",
          author_id: null,
          author_name: null,
          tool: null,
    decision: null,
    attachments: [],
          reasoning: null,
          routine: null,
          trigger: null,
          turn_id: null,
          queued: false,
          created_at: "2026-08-12T12:01:20.000Z",
        },
      ],
    };
    const { container, poll } = await mountPolling(settled);

    expect(container.querySelectorAll("[data-role='system']")).toHaveLength(1);
    // A note speaks about the Companion whose thread this is, not about Pi's runtime name.
    expect(log(container)).toContain("Luna ended the turn without a visible reply.");
    expect(log(container)).not.toContain("Pi ended the turn without a visible reply.");
    // The turn is closed, so nothing should still claim Luna is replying.
    expect(container.querySelectorAll("[data-slot='companion-replying']")).toHaveLength(0);

    // And it follows a rename, because the name is read at render rather than stored on the row.
    const atlas: Companion = { ...companion, name: "Atlas" };
    await poll(settled, atlas);

    expect(log(container)).toContain("Atlas ended the turn without a visible reply.");
    expect(log(container)).not.toContain("Luna ended the turn without a visible reply.");
  });
});

describe("CompanionThread Box chip", () => {
  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("shows one state word and keeps the compute it reports in its accessible name", async () => {
    // THE-345: `Box · asleep` does not fit beside Back, the name, settings, and the panel toggle at
    // 320px. The visible chip is the dot and the word — the word has to stay, because the
    // dot's colour is not allowed to be the only thing reporting status — and what the state is
    // about rides in the accessible name and the tooltip instead.
    const container = await mount(async () => true);
    const chip = boxChip(container);

    expect(chip.querySelector(".chat-box__state")?.textContent).toBe("Online");
    expect(chip.textContent).not.toContain("Box ·");
    expect(chip.getAttribute("aria-label")).toContain("Box · online");
    expect(chip.getAttribute("title")).toBe("Box · online");
  });

  it("hands a runner the Box desktop from the status chip", async () => {
    let opened = 0;
    const container = await mount(async () => true, { onDesktop: () => { opened += 1; } });

    await act(async () => {
      boxChip(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(opened).toBe(1);
  });

  it("keeps the Viewer's chip on the same two halves", async () => {
    const container = await mount(async () => true, {
      companion: { ...companion, access: "viewer" },
      thread: { ...thread, access: "viewer", read_only: true, can_send: false },
    });
    const chip = boxChip(container);

    expect(chip.querySelector(".chat-box__state")?.textContent).toBe("Online");
    expect(chip.getAttribute("aria-label")).toBe("Box · online");
  });

  it("leaves a Viewer's chip inert so reading a thread cannot reach Box", async () => {
    let opened = 0;
    const container = await mount(async () => true, {
      companion: { ...companion, access: "viewer", runtime: { ...companion.runtime, box_id: null } },
      thread: { ...thread, access: "viewer", read_only: true, can_send: false },
      onDesktop: () => { opened += 1; },
    });
    const chip = boxChip(container);

    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(chip.tagName).toBe("SPAN");
    expect(opened).toBe(0);
  });
});

/**
 * Product promise:
 * A runner watches the Box desktop beside the conversation instead of in another tab, and the tab is
 * still there for the person who wants the full screen. Nothing on the panel starts a Box, and a
 * Viewer — who must never start one — is never offered it.
 *
 * Why this test is component-level:
 * The panel and the conversation share the thread. What has to hold is that the second pane appears
 * beside the assistant-ui transcript rather than in place of it, and that the controls it carries are
 * exactly the ones the open Companion's access allows.
 */
describe("CompanionThread context panel", () => {
  const asleep: Companion = {
    ...companion,
    runtime: { ...companion.runtime, state: "stopped", daemon_state: "stopped" },
  };

  function panel(container: HTMLElement) {
    return container.querySelector(".chat-context") as HTMLElement | null;
  }

  function contextToggle(container: HTMLElement) {
    return container.querySelector(".chat-context-toggle") as HTMLButtonElement | null;
  }

  function actionNamed(container: HTMLElement, label: string) {
    return [...container.querySelectorAll(".chat-context button")]
      .find((button) => (button.textContent ?? "").includes(label)) as HTMLButtonElement | undefined;
  }

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("shows Screen, Skills, Routines, and Triggers without placeholder copy", async () => {
    const container = await mount(async () => true, { context: { open: true } });
    const headings = [...container.querySelectorAll(".chat-context h3")]
      .map((heading) => heading.textContent);

    expect(headings).toEqual(["Screen", "Skills", "Routines", "Triggers"]);
    expect(panel(container)?.textContent).not.toContain("coming soon");
    expect(panel(container)?.textContent).toContain("No routines connected.");
    expect(panel(container)?.textContent).toContain("No triggers connected.");
  });

  it("returns focus to the routine History action after its modal closes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      runs: [],
      next_cursor: null,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const routine: CompanionRoutine = {
      id: "33333333-3333-4333-8333-333333333333",
      companion_id: companionId,
      name: "Weekday brief",
      prompt: "Prepare the daily launch brief.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      enabled: true,
      next_fire_at: "2026-08-27T13:00:00.000Z",
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: "2026-08-20T09:00:00.000Z",
      updated_at: "2026-08-26T09:00:00.000Z",
    };
    const container = await mount(async () => true, {
      context: { open: true },
      contextRoutines: [routine],
    });
    const history = actionNamed(container, "History")!;

    await act(async () => {
      history.focus();
      history.click();
    });
    expect(container.querySelector("[role='dialog']")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(history);
  });

  it("shows a runner the live desktop beside the conversation once the Box is running", async () => {
    const container = await mount(async () => true, {
      context: {
        open: true,
        desktop: {
          desktop_url: "https://box.ascii.dev/vnc/bx_23456789?token=opaque",
          provisioning: false,
          automation: "lux",
          transport: "vnc",
        },
      },
    });
    const frame = container.querySelector(".chat-context__frame") as HTMLIFrameElement;

    expect(panel(container)).not.toBeNull();
    expect(frame.getAttribute("src")).toBe("https://box.ascii.dev/vnc/bx_23456789?token=opaque");
    expect(frame.getAttribute("title")).toBe("Luna's screen");
    // The desktop is another origin's document. Framing it must not hand it this app: no navigating
    // the top level away, and no popups opened as us.
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
    // The panel is a second pane, not a replacement: the conversation and its composer stay mounted.
    expect(container.querySelector(".chat-thread")).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    // The stream this join got is named rather than left for the picture to imply.
    expect(container.querySelector(".chat-context__transport")?.textContent).toBe("vnc");
  });

  it("keeps the desktop tab reachable from the panel", async () => {
    let opened = 0;
    const container = await mount(async () => true, {
      onDesktop: () => { opened += 1; },
      context: {
        open: true,
        desktop: {
          desktop_url: "https://box.ascii.dev/vnc/bx_23456789?token=opaque",
          provisioning: false,
          automation: "lux",
          transport: "vnc",
        },
      },
    });

    await act(async () => {
      actionNamed(container, "open desktop")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(opened).toBe(1);
  });

  it("mints another desktop when the runner reconnects the panel", async () => {
    let joins = 0;
    const container = await mount(async () => true, {
      context: { open: true, onJoin: () => { joins += 1; } },
    });

    await act(async () => {
      actionNamed(container, "Reconnect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Box rotates the stream token on every state change, so reconnecting asks for a URL rather than
    // replaying the last one.
    expect(joins).toBe(1);
  });

  it("explains that sending starts a sleeping Box instead of offering a lifecycle control", async () => {
    const container = await mount(async () => true, {
      companion: asleep,
      context: {
        open: true,
        // A stream minted before the Box stopped is not a stream: a sleeping Box has no desktop.
        desktop: {
          desktop_url: "https://box.ascii.dev/vnc/bx_23456789?token=stale",
          provisioning: false,
          automation: "lux",
          transport: "vnc",
        },
      },
    });

    expect(container.querySelector(".chat-context__frame")).toBeNull();
    expect(container.innerHTML).not.toContain("token=stale");
    expect(panel(container)?.textContent).toContain("this Box is not running");
    expect(panel(container)?.textContent).toContain("Send a message to start Luna");
    expect(actionNamed(container, "Wake")).toBeUndefined();
  });

  it("says why a join produced no screen without spelling out the URL", async () => {
    const container = await mount(async () => true, {
      context: {
        open: true,
        desktop: { desktop_url: null, provisioning: true, automation: "lux", transport: null },
        error: "The Box desktop is still starting. Reconnect in a moment.",
      },
    });

    expect(panel(container)?.textContent).toContain("The Box desktop is still starting");
    expect(container.querySelector(".chat-context__frame")).toBeNull();
  });

  it("never offers a Viewer the panel or its toggle", async () => {
    const container = await mount(async () => true, {
      companion: { ...companion, access: "viewer", runtime: { ...companion.runtime, box_id: null } },
      thread: { ...thread, access: "viewer", read_only: true, can_send: false },
      // Even asked for, the panel is not a Viewer's surface: they must never be handed a control that
      // looks as though it could start a Box.
      context: { open: true },
    });

    expect(contextToggle(container)).toBeNull();
    expect(panel(container)).toBeNull();
  });

  it("reports whether the panel is open on the control that opens it", async () => {
    let toggles = 0;
    const closed = await mount(async () => true, {
      context: { open: false, onToggle: () => { toggles += 1; } },
    });

    expect(contextToggle(closed)?.getAttribute("aria-pressed")).toBe("false");
    expect(contextToggle(closed)?.getAttribute("aria-label")).toBe("Show Companion details");
    expect(panel(closed)).toBeNull();

    await act(async () => {
      contextToggle(closed)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(toggles).toBe(1);

    const open = await mount(async () => true, { context: { open: true } });

    expect(contextToggle(open)?.getAttribute("aria-pressed")).toBe("true");
    expect(contextToggle(open)?.getAttribute("aria-label")).toBe("Hide Companion details");
  });

  it("takes the conversation out of reach while the panel is over it", async () => {
    // Below the two-pane width the panel covers the conversation. Left reachable, a keyboard walks
    // through the scrim into a composer nobody can see; focus has to go in and come back out.
    const narrow = { matches: true, addEventListener: () => {}, removeEventListener: () => {} };
    vi.stubGlobal("matchMedia", () => narrow);
    const container = await mount(async () => true, { context: { open: true } });

    const conversation = container.querySelector(".chat-thread") as HTMLElement;
    expect(conversation.inert).toBe(true);
    expect(container.querySelector(".chat-context-scrim")).not.toBeNull();

    vi.unstubAllGlobals();
  });
});

/**
 * Product promise:
 * A message can be sent from a phone: the Send control answers the finger that touched it, and the
 * keyboard's own Send key sends the draft.
 *
 * Regression caught:
 * THE-346 — sending from a phone stopped working. iOS resolves a tap on Send by blurring the composer
 * first, so the keyboard closes, the visual viewport grows, the thread pinned to it is laid out again,
 * and the `click` arrives where the button no longer is.
 *
 * Why this test is component-level:
 * The composer, the runtime it sends through, and the viewport pin all take part in one tap. The
 * failure is in how they are sequenced, which only shows up with all three mounted together.
 *
 * Failure proof:
 * Moving the send back to `click`, dropping the prevented default that keeps the field focused, or
 * letting the growing viewport through mid-tap each fails a case below.
 */
describe("CompanionThread mobile send", () => {
  class FakeVisualViewport extends EventTarget {
    height = 350;
    offsetTop = 24;
  }

  const viewport = new FakeVisualViewport();

  /** The tap iOS actually delivers: finger down, field blurred, keyboard on its way out. */
  function tapWithKeyboardClosing(container: HTMLElement) {
    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    pressed(sendButton(container));
    composer.dispatchEvent(new Event("focusout", { bubbles: true }));
    viewport.height = 640;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
  }

  beforeEach(() => {
    viewport.height = 350;
    viewport.offsetTop = 24;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("sends the draft on the press that starts the tap", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    const composer = type(container, "Draft the launch note");

    // The click never arrives in this test, which is exactly what the phone does when the shell moves
    // under the finger: if the message still goes out, the tap was never the thing carrying it.
    await act(async () => {
      tapWithKeyboardClosing(container);
    });

    expect(sent).toEqual(["Draft the launch note"]);
    expect(composer.value).toBe("");
  });

  it("refuses the press default so the composer keeps focus and the keyboard stays put", async () => {
    const container = await mount(async () => true);
    type(container, "Draft the launch note");

    let press!: PointerEvent;
    await act(async () => {
      press = pressed(sendButton(container));
    });

    // Letting the default through is what blurs the field, and the blur is what closes the keyboard
    // and moves everything the finger was aiming at.
    expect(press.defaultPrevented).toBe(true);
  });

  it("sends once when the browser follows the press with a click", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    type(container, "Draft the launch note");

    await act(async () => {
      pressed(sendButton(container));
      sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(sent).toEqual(["Draft the launch note"]);
  });

  it("leaves a refused draft alone when the click lands after the press that failed", async () => {
    // A refused send hands the text back to the composer. The click belonging to that same press must
    // not pick the restored draft up and send it again behind the sender's back.
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return false;
    });
    const composer = type(container, "Draft the launch note");

    await act(async () => {
      pressed(sendButton(container));
    });
    expect(composer.value).toBe("Draft the launch note");

    await act(async () => {
      sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(sent).toEqual(["Draft the launch note"]);
    expect(composer.value).toBe("Draft the launch note");
  });

  it("still sends when a click arrives long after a press whose own click was lost", async () => {
    // A phone that dropped the click leaves nothing to swallow. The next activation of the button is
    // a new message and must not be mistaken for the tail of the old one.
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const container = await mount(async (content) => {
        sent.push(content);
        return true;
      });
      type(container, "Draft the launch note");
      await act(async () => {
        tapWithKeyboardClosing(container);
      });
      expect(sent).toEqual(["Draft the launch note"]);

      type(container, "And the changelog entry");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      await act(async () => {
        sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      expect(sent).toEqual(["Draft the launch note", "And the changelog entry"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends a click no press came before, so the button stays reachable by keyboard", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    type(container, "Draft the launch note");

    await act(async () => {
      sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(sent).toEqual(["Draft the launch note"]);
  });

  it("asks the phone keyboard for a Send key", async () => {
    const container = await mount(async () => true);

    // A textarea offers `return`, which reads as a new line. Enter sends here, so the key has to say
    // so — the hint is the only thing that can tell the keyboard.
    expect(container.querySelector("textarea")?.getAttribute("enterkeyhint")).toBe("send");
  });

  it("sends on Enter and leaves Shift + Enter to the new line", async () => {
    const sent: string[] = [];
    const container = await mount(async (content) => {
      sent.push(content);
      return true;
    });
    const composer = type(container, "Draft the launch note");

    const newline = await keyDown(composer, { key: "Enter", shiftKey: true });

    // The composer does not touch this keystroke, so the browser inserts the line break itself.
    expect(newline.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);

    const submit = await keyDown(composer, { key: "Enter" });

    expect(submit.defaultPrevented).toBe(true);
    expect(sent).toEqual(["Draft the launch note"]);
    expect(composer.value).toBe("");
  });
});

/**
 * Product promise:
 * An open thread is sized on the box the phone keyboard leaves visible, so focusing the composer does
 * not push it behind the keyboard or pan the page.
 *
 * Regression caught:
 * THE-345 — `100dvh` is the layout viewport, which the keyboard does not shrink.
 *
 * Why this test is component-level:
 * The reporting has to start when a thread opens and stop when it closes; that lifecycle is the part
 * a stylesheet cannot state and arithmetic cannot prove.
 *
 * Failure proof:
 * Dropping the resize listener, or leaving the properties behind on unmount, fails a case below.
 */
describe("CompanionThread visual viewport", () => {
  class FakeVisualViewport extends EventTarget {
    height = 640;
    offsetTop = 0;
  }

  const viewport = new FakeVisualViewport();

  function pinned() {
    const root = document.documentElement;
    return {
      height: root.style.getPropertyValue("--chat-viewport-h"),
      top: root.style.getPropertyValue("--chat-viewport-top"),
    };
  }

  beforeEach(() => {
    viewport.height = 640;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("follows the keyboard shrinking and offsetting the visible box", async () => {
    await mount(async () => true);

    expect(pinned()).toEqual({ height: "640px", top: "0px" });

    await act(async () => {
      viewport.height = 350;
      viewport.offsetTop = 24;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(pinned()).toEqual({ height: "350px", top: "24px" });
  });

  it("waits out the tap that closed the keyboard before growing back", async () => {
    // THE-346: the growth arrives between the press and the click it would move out from under the
    // finger, so the pin holds the box it was on until that tap has been delivered.
    vi.useFakeTimers();
    try {
      await mount(async () => true);
      await act(async () => {
        viewport.height = 350;
        viewport.offsetTop = 24;
        viewport.dispatchEvent(new Event("resize"));
      });
      expect(pinned()).toEqual({ height: "350px", top: "24px" });

      await act(async () => {
        document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        viewport.height = 640;
        viewport.offsetTop = 0;
        viewport.dispatchEvent(new Event("resize"));
      });

      expect(pinned()).toEqual({ height: "350px", top: "24px" });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_VIEWPORT_SETTLE_MS);
      });

      // Nothing is left holding the thread short: the keyboard is gone and the page is whole again.
      expect(pinned()).toEqual({ height: "640px", top: "0px" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reporting once the thread is closed", async () => {
    await mount(async () => true);
    expect(pinned().height).toBe("640px");

    act(() => roots.splice(0).forEach((root) => root.unmount()));

    // A list page is an ordinary scrolling document; leaving a stale height behind would freeze it at
    // whatever the thread last measured.
    expect(pinned()).toEqual({ height: "", top: "" });
  });
});

/**
 * Product promise:
 * A wedged turn can be interrupted from a phone. Stop answers the finger that touched it.
 *
 * Regression caught:
 * Stop shipped on `click` alone while Send was moved onto the press for THE-346. Both buttons sit in
 * the same composer row, so both lose the click when iOS blurs the field, closes the keyboard, grows
 * the visual viewport and lays the row out again. On 2026-08-31 a member could not stop a wedged
 * Companion from their phone: messages queued behind a turn that would not end, and the one control
 * that could release the lane did nothing when tapped.
 *
 * Why this test is component-level:
 * The composer, the turn it stops, and the viewport pin all take part in one tap; the failure is in
 * how they are sequenced.
 *
 * Failure proof:
 * Moving Stop back to `click` alone fails the first case; dropping the prevented default fails the
 * second; running both handlers fails the third.
 */
describe("CompanionThread mobile stop", () => {
  class FakeVisualViewport extends EventTarget {
    height = 350;
    offsetTop = 24;
  }

  const viewport = new FakeVisualViewport();

  const activeThread: Thread = {
    ...thread,
    active_turn: {
      id: "66666666-6666-4666-8666-666666666666",
      companion_id: companionId,
      client_message_id: "77777777-7777-4777-8777-777777777777",
      status: "running",
      queue_sequence: 1,
      latest_attempt: null,
      replying: false,
      error: null,
      state_changed_at: "2026-08-12T12:00:00.000Z",
      settled_at: null,
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    },
  };

  function stopButton(container: HTMLElement) {
    return container.querySelector("[data-slot=composer-stop]") as HTMLButtonElement;
  }

  beforeEach(() => {
    viewport.height = 350;
    viewport.offsetTop = 24;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("stops the turn on the press that starts the tap", async () => {
    const stopped: string[] = [];
    const container = await mount(async () => true, {
      thread: activeThread,
      onCancelInterrupted: async (turnId) => {
        stopped.push(turnId);
      },
    });

    // The click never arrives, which is exactly what the phone does when the row moves under the
    // finger. If the turn still stops, the tap was never the thing carrying it.
    await act(async () => {
      const composer = container.querySelector("textarea") as HTMLTextAreaElement;
      pressed(stopButton(container));
      composer.dispatchEvent(new Event("focusout", { bubbles: true }));
      viewport.height = 640;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(stopped).toEqual(["66666666-6666-4666-8666-666666666666"]);
  });

  it("refuses the press default so the composer keeps focus and the keyboard stays put", async () => {
    const container = await mount(async () => true, { thread: activeThread });

    let press!: PointerEvent;
    await act(async () => {
      press = pressed(stopButton(container));
    });

    // Letting the default through is what blurs the field, and the blur is what moves the button
    // out from under the finger before its click can land.
    expect(press.defaultPrevented).toBe(true);
  });

  it("stops once when the browser follows the press with a click", async () => {
    const stopped: string[] = [];
    const container = await mount(async () => true, {
      thread: activeThread,
      onCancelInterrupted: async (turnId) => {
        stopped.push(turnId);
      },
    });

    await act(async () => {
      const stop = stopButton(container);
      pressed(stop);
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(stopped).toEqual(["66666666-6666-4666-8666-666666666666"]);
  });
});
