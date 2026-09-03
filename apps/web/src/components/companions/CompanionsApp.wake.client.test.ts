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
 * A send that wakes an asleep Companion leaves the whole thread on the woken state, not just the
 * status chip. The regression this guards is a thread that kept the runtime it was opened with: the
 * chip said the Box was online while the composer footer still offered "Wake Luna to deliver", the
 * live sync that projects Pi's reply never started, and only a reload agreed with itself.
 *
 * It runs at this level because the projection is what is under test: the send request, the runtime
 * read the chip uses, and the poll cadence that follows all live in this component, and no lower
 * level can see that the footer and the chip read one state.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const companionId = "11111111-1111-4111-8111-111111111111";

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

const asleep: Companion = {
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
    state: "stopped",
    daemon_state: "stopped",
    replying: false,
    box_id: null,
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

/**
 * A control plane that wakes on send, the way THE-335 does: the message is persisted first, the Box
 * and Pi are started, and the runtime projection this Companion reads is running from then on.
 * `piAcceptsOnWake: false` reproduces the Box that came up while Pi refused the first prompt, so the
 * message stays durable and pending until the next sync hands it over.
 */
function controlPlane(options: { piAcceptsOnWake: boolean; holdSend?: boolean }) {
  const entries: CompanionTranscriptEntry[] = [];
  const requests: string[] = [];
  const runtime = { ...asleep.runtime };
  let ordinal = 0;
  let delivered = -1;
  let owed = 0;
  let lastClientMessageId = "00000000-0000-4000-8000-000000000000";
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const companion = (): Companion => ({ ...asleep, runtime: { ...runtime } });

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

  const thread = (): Thread => ({
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: entries.map((entry) => ({ ...entry })),
    active_turn: owed > 0 ? projectedTurn("running") : null,
    queued_count: entries
      .filter((entry) => entry.role === "user")
      .filter((entry) => entry.ordinal > delivered).length,
    interrupted_turn: null,
    last_message_at: entries.at(-1)?.created_at ?? null,
    last_read_ordinal: null,
  });

  const wake = () => {
    runtime.state = "running";
    runtime.daemon_state = "running";
    runtime.box_id = "bx_23456789";
    runtime.desktop_available = true;
    runtime.last_started_at = new Date().toISOString();
  };

  const startWake = () => {
    runtime.state = "provisioning";
    runtime.daemon_state = "starting";
    runtime.box_id = "bx_23456789";
    runtime.desktop_available = false;
  };

  /** Hand Pi everything it has not received, the way one sync does. */
  const deliverPending = () => {
    const pending = entries.filter((entry) => entry.role === "user" && entry.ordinal > delivered);
    if (!pending.length) return;
    delivered = pending.at(-1)!.ordinal;
    owed += pending.length;
  };

  const settleReplies = () => {
    while (owed > 0) {
      owed -= 1;
      entries.push({
        event_id: `pi:${entries.length}`,
        ordinal: ordinal++,
        role: "assistant",
        content: "On it.",
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

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content: string;
        client_message_id?: string;
      };
      const eventId = `msg:${body.client_message_id ?? String(entries.length)}`;
      lastClientMessageId = body.client_message_id ?? lastClientMessageId;
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
      }
      if (options.holdSend) startWake();
      else wake();
      if (options.holdSend) await held;
      if (options.piAcceptsOnWake) deliverPending();
      return json({
        turn: projectedTurn("queued"),
      });
    }
    if (url.includes("/routines")) return json({ routines: [] });
    if (url.includes("/triggers")) return json({ triggers: [] });
    if (url.includes("/runtime")) {
      return json({ companion: companion() });
    }
    if (url.includes("/thread")) {
      deliverPending();
      settleReplies();
      return json({ thread: thread() });
    }
    return json({});
  });

  return {
    fetchMock,
    entries,
    runtimeReads: () => requests.filter((request) => request.includes("/runtime")).length,
    posts: () => requests.filter((request) => request.endsWith("/messages")).length,
    boxCameUp: wake,
    releaseSend: () => release(),
  };
}

const roots: Root[] = [];

async function openThread() {
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
      initialCompanions: [asleep],
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId: companionId,
    }));
  });
  return container;
}

async function send(container: HTMLElement, value: string) {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(composer, value);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/** Let the open thread poll, whichever cadence it is on. */
async function poll(times: number) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
  }
}

const footer = (container: HTMLElement) =>
  container.querySelector("[data-slot='composer-hint']")?.textContent ?? "";
const chip = (container: HTMLElement) => container.querySelector(".chat-box")?.textContent ?? "";
const wakeControls = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].filter((button) => button.textContent === "Wake");

describe("CompanionsApp wake on send", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("moves the footer off a wake the send already performed", async () => {
    // The Box comes up but Pi refuses the first prompt, so the message stays pending: the footer has
    // something to say about it, and what it must not say is that this Companion needs waking.
    const api = controlPlane({ piAcceptsOnWake: false });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread();

    expect(footer(container)).toContain("Enter sends");
    expect(chip(container)).toContain("Asleep");

    await send(container, "Draft the launch note");

    expect(footer(container)).not.toContain("Wake Luna to deliver.");
    expect(footer(container)).toContain("1 message is saved and queued.");
    expect(chip(container)).toContain("Online");
    expect(api.runtimeReads()).toBeGreaterThan(0);

    // The woken thread now syncs, so the message Pi refused is delivered and answered without anyone
    // reloading the page.
    await poll(1);

    expect(api.posts()).toBe(1);
    expect(api.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(container.textContent).toContain("On it.");
    expect(footer(container)).toContain("Enter sends");
  });

  it("never exposes a separate wake control before or after an automatic start", async () => {
    const api = controlPlane({ piAcceptsOnWake: true });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread();

    expect(wakeControls(container)).toHaveLength(0);

    await send(container, "Draft the launch note");

    expect(wakeControls(container)).toHaveLength(0);
    expect(chip(container)).toContain("Online");
    // The bounded enqueue ACK is queued; only a later PostgreSQL poll may claim Pi accepted it.
    expect(footer(container)).toContain("1 message is saved and queued.");

    // A woken thread pulls Pi, so the reply arrives on the live cadence instead of on a reload.
    await poll(1);

    expect(container.textContent).toContain("On it.");
  });

  it("moves Starting to Online while the send request is still waiting on the wake", async () => {
    const api = controlPlane({ piAcceptsOnWake: true, holdSend: true });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread();

    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter?.call(composer, "Draft the launch note");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(api.posts()).toBe(1);
    expect(chip(container)).toContain("Starting");
    expect(wakeControls(container)).toHaveLength(0);

    api.boxCameUp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(chip(container)).toContain("Online");
    expect(footer(container)).not.toContain("Wake");

    await act(async () => {
      api.releaseSend();
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
