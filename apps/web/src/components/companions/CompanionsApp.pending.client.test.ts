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
 * A Companion the control plane is still starting has to stop saying Starting on its own.
 *
 * Production reached the state this guards against: the wake finished, the Box came up, Pi answered
 * the queued message and the reply was on screen — and for about a minute the chip still read
 * Starting beside it until an unrelated action happened to re-read the row. The row itself was
 * right within a second of the Box coming up; nothing was reading
 * it. The Box-status poll only runs once the state is already `running`, and the request that starts a
 * wake answers once — before the lifecycle finishes, when it answers at all, since a wake can outlive
 * the proxy in front of the API.
 *
 * So the case here is a wake whose own response never arrives, which is the one that used to leave the
 * chip stranded: nothing but the pending poll can move it.
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

function companionIn(
  state: "provisioning" | "running" | "stopping" | "error",
  options: { replying?: boolean } = {},
): Companion {
  return {
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
      state,
      daemon_state: state === "running" ? "running" : state === "error" ? "error" : "starting",
      replying: options.replying ?? false,
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
      desktop_available: state === "running",
      last_error: state === "error" ? "Pi resources failed to prepare (exit 1)" : null,
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
}

const emptyThread: Thread = {
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

/**
 * A control plane mid-wake. Its `/runtime` projection reports whatever the lifecycle has reached, so
 * the test can land the wake the way the control plane does — by writing the row — rather than by
 * answering a request the browser may never hear back from. The roster list reads the same row, so
 * the sidebar cadence can be counted against the same lifecycle.
 */
function controlPlane(options: {
  wakeAnswers?: boolean;
  holdFirstRead?: boolean;
  initialState?: "provisioning" | "running" | "stopping" | "error";
  initialReplying?: boolean;
} = {}) {
  let settled = companionIn(options.initialState ?? "provisioning", {
    replying: options.initialReplying,
  });
  const runtimeReads: string[] = [];
  const threadReads: string[] = [];
  const listReads: string[] = [];
  let held = 0;
  let release = () => {};
  const holding = new Promise<void>((resolve) => { release = resolve; });

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/runtime/start")) {
      // A wake that outlives the proxy in front of the API: the lifecycle runs on, and this request
      // is never answered.
      if (!options.wakeAnswers) return await new Promise<Response>(() => {});
      return json({ companion: settled });
    }
    if (url.includes("/runtime")) {
      runtimeReads.push(url);
      // The first read answers last, carrying the state the Companion has since left.
      if (options.holdFirstRead && held++ === 0) {
        const stale = settled;
        await holding;
        return json({ companion: stale });
      }
      return json({ companion: settled });
    }
    if (url.endsWith("/v1/companions")) {
      listReads.push(url);
      return json({ companions: [settled] });
    }
    if (url.includes("/routines")) return json({ routines: [] });
    if (url.includes("/triggers")) return json({ triggers: [] });
    if (url.includes("/thread")) {
      if (method === "GET") threadReads.push(url);
      return json({ thread: emptyThread });
    }
    return json({});
  });

  return {
    fetchMock,
    runtimeReads,
    threadReads,
    listReads,
    /** What the wake writes when the Box and Pi are up: the state the chip is waiting for. */
    boxCameUp: () => { settled = companionIn("running"); },
    /** What a wake that fails writes instead. */
    wakeFailed: () => { settled = companionIn("error"); },
    /** Let the overtaken read finally answer. */
    releaseFirstRead: () => release(),
  };
}

const roots: Root[] = [];

async function mountApp(initial: Companion, initialCompanionId: string | null) {
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
      initialCompanions: [initial],
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId,
    }));
  });
  return container;
}

async function openThread(initial: Companion) {
  return mountApp(initial, companionId);
}

/** Time the browser spends waiting on a lifecycle, in seconds. */
async function wait(seconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1_000);
  });
}

/** The chip's visible half: the state word. What it reports about is its accessible name. */
const chip = (container: HTMLElement) => container.querySelector(".chat-box")?.textContent;
const wakeControl = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Wake") ?? null;

describe("CompanionsApp while a Companion is starting", () => {
  let api: ReturnType<typeof controlPlane>;

  beforeEach(() => {
    vi.useFakeTimers();
    api = controlPlane();
    vi.stubGlobal("fetch", api.fetchMock);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the Box online once the wake records it, without being asked again", async () => {
    const container = await openThread(companionIn("provisioning"));

    await wait(20);
    expect(chip(container)).toContain("Starting");

    api.boxCameUp();
    await wait(5);

    expect(chip(container)).toContain("Online");
    expect(wakeControl(container)).toBeNull();
  });

  it("reports a start that failed without exposing a separate wake action", async () => {
    const container = await openThread(companionIn("provisioning"));

    api.wakeFailed();
    await wait(5);

    expect(chip(container)).toContain("Error");
    expect(container.textContent).toContain("Pi resources failed to prepare");
    expect(wakeControl(container)).toBeNull();
  });

  it("watches the lifecycle with reads that never resume a Box", async () => {
    await openThread(companionIn("provisioning"));

    await wait(20);

    expect(api.runtimeReads.length).toBeGreaterThan(1);
    expect(api.runtimeReads.every((url) => url.endsWith("/runtime"))).toBe(true);
  });

  it("polls a stopping thread through the read model", async () => {
    api = controlPlane({ initialState: "stopping" });
    vi.stubGlobal("fetch", api.fetchMock);
    await openThread(companionIn("stopping"));

    await wait(5);

    expect(api.threadReads.length).toBeGreaterThan(0);
  });

  it("polls a provisioning thread through the read model", async () => {
    await openThread(companionIn("provisioning"));

    await wait(5);

    expect(api.threadReads.length).toBeGreaterThan(0);
  });

  it("keeps the Box online when an overtaken read finally answers", async () => {
    // Watching a lifecycle closely means these reads overlap, so one that answers late is carrying a
    // state the Companion has already left. It must not put Starting back on a chip that has arrived.
    api = controlPlane({ holdFirstRead: true });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread(companionIn("provisioning"));

    await wait(4);
    api.boxCameUp();
    await wait(8);
    expect(chip(container)).toContain("Online");

    await act(async () => {
      api.releaseFirstRead();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(chip(container)).toContain("Online");
  });

  it("stops watching once the lifecycle settles", async () => {
    await openThread(companionIn("provisioning"));
    api.boxCameUp();
    await wait(10);
    const watched = api.runtimeReads.length;
    expect(watched).toBeGreaterThan(1);

    await wait(30);

    // Stable lifecycle projection falls back to the eight-second read cadence.
    expect(api.runtimeReads.length - watched).toBeLessThanOrEqual(5);
  });

  it("watches the roster fast while a Companion nobody opened is replying", async () => {
    // A reply landing in a thread nobody has open shows only through the sidebar row, so the list
    // poll is the one thing tracking it. While any row is working the list reads every eight
    // seconds; the moment every row settles it returns to the slow cadence — and keeps going.
    api = controlPlane({ initialState: "running", initialReplying: true });
    vi.stubGlobal("fetch", api.fetchMock);
    await mountApp(companionIn("running", { replying: true }), null);

    await wait(17);
    expect(api.listReads.length).toBe(2);

    api.boxCameUp();
    await wait(8);
    const settledAt = api.listReads.length;

    // A settled roster would have read five more times at the fast cadence; it reads none.
    await wait(40);
    expect(api.listReads.length).toBe(settledAt);

    // Still watching, just slowly: the forty-five-second tick lands.
    await wait(10);
    expect(api.listReads.length).toBe(settledAt + 1);
  });
});
