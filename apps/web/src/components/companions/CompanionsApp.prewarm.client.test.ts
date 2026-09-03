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

/** Typing is local draft work. Only an accepted Send may create durable runtime work or wake Box. */

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

function companionIn(state: "stopped" | "stopping" | "running" | "error"): Companion {
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
      daemon_state: state === "running" ? "running" : "stopped",
      replying: false,
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
      desktop_available: false,
      last_error: state === "error" ? "Box start timed out" : null,
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

function controlPlane(initial: Companion) {
  const wakes: string[] = [];
  const wakeBodies: unknown[] = [];
  const messages: unknown[] = [];
  // The claim lands as the wake request does, so runtime reads report the lifecycle in flight even
  // though the wake request itself stays open the way a real one can.
  let settled = initial;
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/runtime/start")) {
      wakes.push(url);
      wakeBodies.push(JSON.parse(String(init?.body)));
      settled = {
        ...initial,
        runtime: { ...initial.runtime, state: "provisioning", daemon_state: "starting" },
      };
      return await new Promise<Response>(() => {});
    }
    if (method === "POST" && url.endsWith("/messages")) {
      const body = JSON.parse(String(init?.body)) as { client_message_id: string };
      messages.push(body);
      const now = "2026-08-17T00:00:00.000Z";
      return json({ turn: {
        id: "22222222-2222-4222-8222-222222222222",
        companion_id: companionId,
        client_message_id: body.client_message_id,
        status: "queued",
        queue_sequence: 1,
        replying: false,
        error: null,
        state_changed_at: now,
        settled_at: null,
        created_at: now,
        updated_at: now,
      } });
    }
    if (url.includes("/routines")) return json({ routines: [] });
    if (url.includes("/triggers")) return json({ triggers: [] });
    if (url.includes("/runtime")) return json({ companion: settled });
    if (url.includes("/thread")) return json({ thread: emptyThread });
    if (url.includes("/v1/companions")) return json({ companions: [settled] });
    return json({});
  });
  return { fetchMock, wakes, wakeBodies, messages };
}

const roots: Root[] = [];

async function openThread(initial: Companion) {
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
      initialCompanionId: companionId,
    }));
  });
  return container;
}

async function type(container: HTMLElement, text: string) {
  const field = container.querySelector("textarea") as HTMLTextAreaElement | null;
  expect(field).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, text);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function send(container: HTMLElement) {
  const field = container.querySelector("textarea");
  expect(field).not.toBeNull();
  await act(async () => {
    field!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

const chip = (container: HTMLElement) => container.querySelector(".chat-box")?.textContent;

describe("CompanionsApp wake-on-Send boundary", () => {
  let api: ReturnType<typeof controlPlane>;

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not prewarm an asleep Companion while a draft is typed", async () => {
    api = controlPlane(companionIn("stopped"));
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread(companionIn("stopped"));

    await type(container, "C");
    expect(api.wakes).toHaveLength(0);
    expect(api.wakeBodies).toHaveLength(0);
    expect(chip(container)).toContain("Asleep");

    await type(container, "Ca va");
    await type(container, "Ca va ?");
    expect(api.wakes).toHaveLength(0);

    await send(container);
    expect(api.messages).toHaveLength(1);
    expect(api.wakes).toHaveLength(0);
  });

  it("does not prewarm a retryably-errored Companion", async () => {
    api = controlPlane(companionIn("error"));
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread(companionIn("error"));

    await type(container, "Retry?");
    expect(api.wakes).toHaveLength(0);
  });

  it.each(["running", "stopping"] as const)(
    "never starts a wake while the Companion is %s",
    async (state) => {
      api = controlPlane(companionIn(state));
      vi.stubGlobal("fetch", api.fetchMock);
      const container = await openThread(companionIn(state));

      await type(container, "Hello");
      expect(api.wakes).toHaveLength(0);
    },
  );
});
