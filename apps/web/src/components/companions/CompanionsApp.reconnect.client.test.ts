// @vitest-environment happy-dom
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- Existing tests predate the incremental anti-slop gate. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionProvidersResponse,
  CompanionThread as Thread,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionsApp, type CompanionNavigation } from "./CompanionsApp";

/**
 * A transcript that stops updating has to say so — quietly.
 *
 * The failure this guards against is the silent one: the network drops, every poll fails, and the
 * surface keeps showing a conversation frozen mid-turn with an Online chip beside it. The reader
 * has no way to tell a Companion that is thinking from a connection that is gone. One failed poll
 * is weather and must not raise anything; from the second the header says "Reconnecting…", and the
 * first poll that answers takes the word away again. The transcript itself is never covered by an
 * alert — it is not wrong, it may just be behind.
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

const runningCompanion: Companion = {
  id: companionId,
  name: "Luna",
  persona: "Incident research assistant",
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
    disk_layout_version: 6,
    desktop_available: true,
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

const emptyThread: Thread = {
  companion_id: companionId,
  viewer_id: "user-1",
  access: "owner",
  read_only: false,
  can_send: true,
  entries: [],
  active_turn: null,
  queued_count: 1,
  interrupted_turn: null,
  last_message_at: null,
  last_read_ordinal: null,
};

/** An API whose thread reads can be cut off and restored, the way a dropped network looks. */
function flakyControlPlane() {
  let online = true;

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/routines")) return json({ routines: [] });
    if (url.includes("/triggers")) return json({ triggers: [] });
    if (url.includes("/thread")) {
      if (!online && (method === "POST" || method === "GET")) {
        throw new TypeError("Failed to fetch");
      }
      return json({ thread: emptyThread });
    }
    if (url.includes("/runtime")) return json({ companion: runningCompanion });
    if (url.includes("/v1/companions")) return json({ companions: [runningCompanion] });
    return json({});
  });

  return {
    fetchMock,
    drop: () => { online = false; },
    restore: () => { online = true; },
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
      initialCompanions: [runningCompanion],
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId: companionId,
    }));
  });
  return container;
}

async function wait(seconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1_000);
  });
}

// The live region stays mounted so announcements are reliable; only its text toggles.
const reconnecting = (container: HTMLElement) =>
  container.querySelector(".chat-reconnecting")?.textContent || null;

describe("CompanionsApp when thread polls stop answering", () => {
  let api: ReturnType<typeof flakyControlPlane>;

  beforeEach(() => {
    vi.useFakeTimers();
    api = flakyControlPlane();
    vi.stubGlobal("fetch", api.fetchMock);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says Reconnecting after repeated failures and clears it on the first answer", async () => {
    const container = await openThread();
    await wait(3);
    expect(reconnecting(container)).toBeNull();

    api.drop();
    // One failure alone must not raise the word.
    await wait(2.5);
    expect(reconnecting(container)).toBeNull();
    await wait(8);
    expect(reconnecting(container)).toContain("Reconnecting");
    // The conversation is not wrong, so no alert covers it.
    expect(container.querySelector(".companions-error")).toBeNull();

    api.restore();
    await wait(20);
    expect(reconnecting(container)).toBeNull();
  });

  it("backs the poll cadence off while failing instead of hammering a dead network", async () => {
    const container = await openThread();
    await wait(4);
    const readsBeforeDrop = api.fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/thread")).length;

    api.drop();
    // Second-by-second so each failed poll's state lands before the next timer fires, the way real
    // time does; one sixty-second leap would fire the stale cadence without ever re-arming it.
    for (let second = 0; second < 60; second += 1) await wait(1);
    expect(reconnecting(container)).toContain("Reconnecting");
    const readsWhileDown = api.fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/thread")).length - readsBeforeDrop;

    // Sixty seconds at the live cadence would be ~30 requests; the backed-off cadence stays in the
    // single digits without ever stopping entirely.
    expect(readsWhileDown).toBeGreaterThan(2);
    expect(readsWhileDown).toBeLessThan(15);
  });

  it("revalidates immediately when the network comes back", async () => {
    const container = await openThread();
    await wait(4);
    api.drop();
    await wait(30);
    expect(reconnecting(container)).toContain("Reconnecting");

    api.restore();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(reconnecting(container)).toBeNull();
  });
});
