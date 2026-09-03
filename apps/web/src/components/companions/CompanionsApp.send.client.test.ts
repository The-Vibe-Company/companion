// @vitest-environment happy-dom
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- Existing tests predate the incremental anti-slop gate. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionProvidersResponse,
  CompanionThread as Thread,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionsApp, type CompanionNavigation } from "./CompanionsApp";

/**
 * One Enter is one turn, measured where it can be counted: the requests the open thread makes. The
 * regression this guards is a send that reached the control plane twice — one Enter that persisted the
 * message and its reply twice over, and survived a reload — so the promise under test is that pressing
 * Enter once posts once, names that message once, and that the live poll that follows never sends
 * again.
 *
 * It runs at this level because no lower one can see it: the composer, the optimistic message, the
 * request queue, and the two-second sync poll all take part in a send, and the count that matters is
 * of `POST /v1/companions/:id/messages` on the wire.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const companionId = "11111111-1111-4111-8111-111111111111";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const org = {
  id: "org-1",
  name: "The Vibe Company",
  slug: "vibe",
  kind: "team" as const,
  myRole: "owner" as const,
  color: null,
  logoUrl: null,
};

const navigation: CompanionNavigation = {
  mineTreeRows: [],
  orgTreeRows: [],
  mineCount: 0,
  orgCount: 0,
  installedCount: 0,
  installedUpdateCount: 0,
  localUpdateCount: 0,
  archivedCount: 0,
};

const providers: CompanionProvidersResponse = {
  catalog: [{ id: "anthropic", name: "Claude", auth_methods: ["api_key"], description: "", models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }] }],
  connections: [{
    provider_id: "anthropic",
    auth_method: "api_key",
    connected_by: "user-1",
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  }],
  default_provider_id: "anthropic",
  can_manage: true,
};

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
    desktop_available: true,
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

const otherCompanion: Companion = {
  ...companion,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Sol",
};

/**
 * A control plane with one durable transcript and a Pi that answers each prompt it accepted. It
 * stores a message under the event id the sender named and refuses a second copy of it, the way the
 * transcript's primary key does, so a duplicated request shows up as a duplicated request rather than
 * as a second turn.
 */
function controlPlane(
  options: {
    holdSend?: boolean;
    dropFirstSend?: boolean;
    companion?: Companion;
    watermarkedPostTimeoutTail?: boolean;
    refuseDelivery?: boolean;
    holdReply?: boolean;
    holdThreadRead?: boolean;
  } = {},
) {
  const runtime = options.companion ?? companion;
  const entries: CompanionTranscriptEntry[] = options.watermarkedPostTimeoutTail
    ? [
        {
          event_id: "pi:read:tool:0",
          ordinal: 0,
          role: "tool",
          content: "/tmp/conductor-cli.png",
          author_id: null,
          author_name: null,
          tool: {
            call_id: "call-read",
            kind: "file",
            name: "read",
            title: "read /tmp/conductor-cli.png",
            status: "timeout",
            detail: "Timed out after 90 seconds without a tool result.",
            screenshot: null,
          },
          decision: null,
          attachments: [],
          reasoning: null,
          routine: null,
          trigger: null,
          turn_id: null,
          queued: false,
          created_at: "2026-08-15T18:00:00.000Z",
        },
        ...["Alors?", "Ca va?"].map((content, index): CompanionTranscriptEntry => ({
          event_id: `msg:watermarked:${index}`,
          ordinal: index + 1,
          role: "user",
          content,
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
          created_at: `2026-08-15T18:0${index + 1}:00.000Z`,
        })),
      ]
    : [];
  const sends: { content: string; clientMessageId: string | undefined }[] = [];
  const requests: string[] = [];
  let ordinal = entries.length;
  // THE-370 starts with the post-timeout tail already watermarked even though Pi never answered it.
  let delivered = options.watermarkedPostTimeoutTail ? ordinal - 1 : -1;
  let owed = 0;
  let lastClientMessageId = "00000000-0000-4000-8000-000000000000";
  let replyReleased = !options.holdReply;
  let dropped = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let releaseThread = () => {};
  const heldThread = new Promise<void>((resolve) => { releaseThread = resolve; });
  let holdNextThreadRead = options.holdThreadRead ?? false;

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const projectedTurn = (
    status: "queued" | "running",
  ): NonNullable<Thread["active_turn"]> => ({
    id: "22222222-2222-4222-8222-222222222222",
    companion_id: companionId,
    client_message_id: lastClientMessageId,
    status,
    queue_sequence: 1,
    admission_state: status === "running" ? "accepted" : "pending",
    admitted_at: status === "running" ? "2026-08-15T18:00:00.000Z" : null,
    replying: status === "running",
    error: null,
    state_changed_at: "2026-08-15T18:00:00.000Z",
    settled_at: null,
    created_at: "2026-08-15T18:00:00.000Z",
    updated_at: "2026-08-15T18:00:00.000Z",
  });

  const settleReplies = () => {
    while (replyReleased && owed > 0) {
      owed -= 1;
      entries.push({
        event_id: `pi:${entries.length}`,
        ordinal: ordinal++,
        role: "assistant",
        content: "It's 2026.",
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
        created_at: new Date().toISOString(),
      });
    }
  };

  const thread = (requestedCompanionId = companionId): Thread => {
    const threadEntries = requestedCompanionId === companionId ? entries : [];
    return {
    companion_id: requestedCompanionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: threadEntries.map((entry) => ({ ...entry })),
    active_turn: owed > 0 ? projectedTurn("running") : null,
    queued_count: threadEntries.filter((entry) => entry.role === "user" && entry.ordinal > delivered).length,
    interrupted_turn: null,
    last_message_at: threadEntries.at(-1)?.created_at ?? null,
    last_read_ordinal: null,
  };
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const requestedCompanionId = url.match(/\/companions\/([^/?]+)/)?.[1] ?? companionId;
    requests.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content: string;
        client_message_id?: string;
      };
      sends.push({ content: body.content, clientMessageId: body.client_message_id });
      lastClientMessageId = body.client_message_id ?? lastClientMessageId;
      const eventId = `msg:${body.client_message_id ?? String(sends.length)}`;
      if (!entries.some((entry) => entry.event_id === eventId)) {
        entries.push({
          event_id: eventId,
          ordinal: ordinal++,
          role: "user",
          content: body.content,
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
          created_at: new Date().toISOString(),
        });
        if (!options.refuseDelivery) {
          delivered = ordinal - 1;
          owed += 1;
        }
      }
      // THE-341: the turn is durable before the client necessarily receives the response. Model a
      // lost response by returning 500 after the first send has stored the message.
      if (options.dropFirstSend && dropped < 1) {
        dropped += 1;
        return new Response(JSON.stringify({ error: "Request failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (options.holdSend) await held;
      return json({
        turn: projectedTurn("queued"),
      });
    }
    if (url.includes("/routines")) return json({ routines: [] });
    if (url.includes("/triggers")) return json({ triggers: [] });
    if (url.includes("/thread")) {
      if (holdNextThreadRead) {
        holdNextThreadRead = false;
        // Materialize the response when the GET reaches the control plane, not when its delayed
        // bytes finally arrive. This is the stale snapshot a real overlapping send must reject.
        const snapshot = thread(requestedCompanionId);
        await heldThread;
        return json({ thread: snapshot });
      }
      settleReplies();
      return json({ thread: thread(requestedCompanionId) });
    }
    if (url.includes("/runtime")) return json({ companion: runtime });
    return json({});
  });

  return {
    fetchMock,
    entries,
    sends,
    /** Answer the send this control plane is holding open. */
    releaseSend: () => release(),
    releaseThread: () => releaseThread(),
    holdNextThreadRead: () => { holdNextThreadRead = true; },
    threadGets: () => requests.filter((request) => request.includes("/thread")).length,
    posts: () => requests.filter((request) => request.endsWith("/messages")).length,
    releaseReply: () => { replyReleased = true; },
  };
}

const roots: Root[] = [];

async function openThread(who: Companion = companion, companions: Companion[] = [who]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionsApp, {
      orgs: [org],
      currentOrg: org,
      viewer: { id: "user-1", name: "Ada", email: "ada@example.test", initials: "A", avatarUrl: null },
      navigation,
      skills: [],
      initialCompanions: companions,
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId: companionId,
    }));
  });
  return container;
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

/** Enter in the composer, which is what the primitives turn into one submit. */
async function pressEnter(container: HTMLElement) {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/** Let the active PostgreSQL thread projection poll at its three-second cadence. */
async function poll(times: number) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
  }
}

describe("CompanionsApp send", () => {
  let api: ReturnType<typeof controlPlane>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("with a control plane that answers at once", () => {
    beforeEach(() => {
      api = controlPlane();
      vi.stubGlobal("fetch", api.fetchMock);
    });

    it("persists one turn and one reply for one Enter", async () => {
      const container = await openThread();
      const composer = type(container, "What year is it?");

      await pressEnter(container);
      await poll(3);

      expect(api.posts()).toBe(1);
      expect(api.entries.map((entry) => `${entry.role}: ${entry.content}`)).toEqual([
        "user: What year is it?",
        "assistant: It's 2026.",
      ]);
      expect(composer.value).toBe("");
    });

    it("leaves an online thread's footer and chip exactly where they were", async () => {
      const container = await openThread();
      type(container, "What year is it?");

      await pressEnter(container);
      await poll(1);

      expect(container.querySelector("[data-slot='composer-hint']")?.textContent)
        .toBe("Enter sends. Shift + Enter starts a new line.");
      expect(container.querySelector(".chat-box")?.textContent).toContain("Online");
    });

    it("names the message it sends, so a replayed request cannot become a second turn", async () => {
      const container = await openThread();
      type(container, "What year is it?");

      await pressEnter(container);

      expect(api.sends).toHaveLength(1);
      expect(api.sends[0]?.clientMessageId).toMatch(UUID);
    });

    it("keeps the accepted message visible while its bounded ACK waits for the thread poll", async () => {
      const container = await openThread();
      type(container, "Keep this accepted message");

      await pressEnter(container);

      expect(container.querySelectorAll("[data-role='user']")).toHaveLength(1);
      expect(container.textContent).toContain("Keep this accepted message");
      expect(container.querySelector("[data-slot='composer-hint']")?.textContent)
        .toBe("1 message is saved and queued.");
    });

    it("keeps a refused ordinary send pending without claiming Pi is replying", async () => {
      api = controlPlane({ refuseDelivery: true });
      vi.stubGlobal("fetch", api.fetchMock);
      const container = await openThread();

      type(container, "Please try this turn");
      await pressEnter(container);
      await poll(1);

      expect(container.querySelector("[data-slot='composer-hint']")?.textContent)
        .toBe("1 message is saved and queued.");
      expect(container.querySelector("[data-slot='companion-replying']")).toBeNull();
    });

    it("keeps a refused post-timeout send visibly pending without reopening its chip or replying", async () => {
      api = controlPlane({ watermarkedPostTimeoutTail: true, refuseDelivery: true });
      vi.stubGlobal("fetch", api.fetchMock);
      const container = await openThread();

      expect(container.textContent).toContain("read /tmp/conductor-cli.png");
      expect(container.textContent).toContain("timed out");
      expect(container.querySelector("[data-slot='companion-replying']")).toBeNull();

      type(container, "ping THE-370");
      await pressEnter(container);
      // A timed-out turn never revives the old typing indicator while delivery/heal completes.
      expect(container.querySelector("[data-slot='companion-replying']")).toBeNull();
      await poll(1);

      expect(container.querySelector("[data-slot='composer-hint']")?.textContent)
        .toBe("1 message is saved and queued.");
      expect(api.entries.some((entry) => entry.role === "assistant")).toBe(false);
      expect(container.textContent).toContain("read /tmp/conductor-cli.png");
      expect(container.textContent).toContain("timed out");
      expect(container.querySelector("[data-slot='companion-replying']")).toBeNull();
    });

    it("shows replying only after Pi accepts the recovered post-timeout turn", async () => {
      api = controlPlane({ watermarkedPostTimeoutTail: true, holdReply: true });
      vi.stubGlobal("fetch", api.fetchMock);
      const container = await openThread();

      type(container, "ping THE-370");
      await pressEnter(container);
      await poll(1);

      // Re-open from the persisted send response so no optimistic composer state can supply the
      // signal: only the durable accepted attempt projection may make this recovered turn live.
      const confirmed = await openThread();
      expect(confirmed.querySelector("[data-slot='companion-replying']")).not.toBeNull();
      expect(confirmed.textContent).toContain("read /tmp/conductor-cli.png");
      expect(confirmed.textContent).toContain("timed out");

      api.releaseReply();
      await poll(1);

      expect(api.entries.at(-1)).toMatchObject({ role: "assistant", content: "It's 2026." });
      expect(confirmed.querySelector("[data-slot='companion-replying']")).toBeNull();
      expect(confirmed.textContent).toContain("timed out");
    });
  });

  describe("with a control plane that is slow to answer", () => {
    beforeEach(() => {
      api = controlPlane({ holdSend: true });
      vi.stubGlobal("fetch", api.fetchMock);
    });

    it("still sends once when the poll ticks while the send is in flight", async () => {
      const container = await openThread();
      const composer = type(container, "What year is it?");

      await act(async () => {
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        // Several poll ticks pass while the send is unanswered; none of them may send again, and the
        // message stays on screen once because it already carries the id it will be stored under.
        await vi.advanceTimersByTimeAsync(6_300);
      });

      expect(api.posts()).toBe(1);
      expect(container.querySelectorAll("[data-role='user']")).toHaveLength(1);
      expect(container.querySelector("[data-slot='companion-replying']")).toBeNull();

      await act(async () => {
        api.releaseSend();
        await vi.advanceTimersByTimeAsync(0);
      });
      await poll(1);

      expect(api.posts()).toBe(1);
      expect(api.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
      expect(composer.value).toBe("");
    });

    it("does not apply a held send after the reader switches threads", async () => {
      const container = await openThread(companion, [companion, otherCompanion]);
      type(container, "Only Luna should show this");

      await act(async () => {
        (container.querySelector("textarea") as HTMLTextAreaElement)
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await act(async () => {
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("Sol"))?.click();
      });

      expect(container.querySelector("h1")?.textContent).toBe("Sol");

      await act(async () => {
        api.releaseSend();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(container.querySelector("h1")?.textContent).toBe("Sol");
      expect(container.textContent).not.toContain("Only Luna should show this");
      expect(container.querySelector("textarea")).toHaveProperty("disabled", false);
    });
  });

  it("posts a send immediately while an older thread GET is still in flight", async () => {
    api = controlPlane({ holdThreadRead: true });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread();
    type(container, "Do not wait for the poll");

    await pressEnter(container);

    expect(api.posts()).toBe(1);
    expect(api.sends).toHaveLength(1);
    await act(async () => api.releaseThread());
  });

  it("does not let a pre-send thread snapshot erase the accepted turn", async () => {
    api = controlPlane();
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread();
    const initialReads = api.threadGets();

    api.holdNextThreadRead();
    await act(async () => vi.advanceTimersByTimeAsync(8_100));
    expect(api.threadGets()).toBe(initialReads + 1);

    type(container, "Keep the accepted turn visible");
    await pressEnter(container);
    expect(container.textContent).toContain("Keep the accepted turn visible");
    expect(container.querySelector("[data-slot='composer-hint']")?.textContent)
      .toBe("1 message is saved and queued.");

    await act(async () => {
      api.releaseThread();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(container.textContent).toContain("Keep the accepted turn visible");
    expect(container.querySelector("[data-slot='composer-hint']")?.textContent)
      .toBe("1 message is saved and queued.");
  });

  describe("when a send that woke an asleep Companion loses its request after persisting", () => {
    const asleep: Companion = {
      ...companion,
      runtime: {
        ...companion.runtime,
        state: "stopped",
        daemon_state: "stopped",
        replying: false,
        box_id: null,
        desktop_available: false,
      },
    };

    beforeEach(() => {
      api = controlPlane({ dropFirstSend: true, companion: asleep });
      vi.stubGlobal("fetch", api.fetchMock);
    });

    it("resends the same turn, so the composer clears with no toast and one message is stored", async () => {
      const container = await openThread(asleep);
      const composer = type(container, "What year is it?");

      // The response is lost after the turn becomes durable. The composer keeps the draft so
      // nothing typed is lost.
      await pressEnter(container);
      expect(composer.value).toBe("What year is it?");

      // Pressing Enter on the restored draft must name the turn already stored, not a second one.
      await pressEnter(container);
      await poll(1);

      expect(api.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
      expect(api.sends).toHaveLength(2);
      expect(api.sends[0]?.clientMessageId).toBe(api.sends[1]?.clientMessageId);
      expect(composer.value).toBe("");
      // The transient 500 cleared itself, and the successful resend leaves no error behind.
      expect(container.querySelector(".companions-error")).toBeNull();
    });
  });
});
