/* oxlint-disable anti-slop/no-module-mocking -- Existing tests predate the incremental anti-slop gate. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Companion, CompanionProvidersResponse } from "@companion/contracts";
import { describe, expect, it, vi } from "vitest";
import { CompanionsApp, type CompanionNavigation } from "./CompanionsApp";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

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
  mineCount: 3,
  orgCount: 5,
  installedCount: 1,
  installedUpdateCount: 0,
  localUpdateCount: 0,
  archivedCount: 15,
};

const providers: CompanionProvidersResponse = {
  catalog: [
    { id: "anthropic", name: "Claude", auth_methods: ["api_key", "subscription"], description: "", models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }] },
  ],
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

function companion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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
    ...overrides,
  };
}

function render(
  companions: Companion[],
  initialCompanionId?: string | null,
  initialPluginsOpen = false,
  initialSettingsCompanionId?: string | null,
  initialProviders: CompanionProvidersResponse | null = providers,
) {
  return renderToStaticMarkup(React.createElement(CompanionsApp, {
    orgs: [org],
    currentOrg: org,
    viewer: { id: "user-1", name: "Ada", email: "ada@example.test", initials: "A", avatarUrl: null },
    navigation,
    skills: [],
    initialCompanions: companions,
    initialProviders,
    initialPlugins: [{
      id: "44444444-4444-4444-8444-444444444444",
      provider: "linear",
      label: "work",
      transport: "http",
      endpoint: "https://mcp.linear.example",
      connected: true,
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    }],
    initialCompanionId,
    initialPluginsOpen,
    initialSettingsCompanionId,
  }));
}

describe("CompanionsApp", () => {
  it("lists workspace Companions in the sidebar roster with a blob avatar and status", () => {
    const markup = render([
      companion(),
      companion({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Milo",
        persona: "Developer assistant",
        access: "viewer",
        pinned: false,
        hidden: false,
        unread: false,
        runtime: { ...companion().runtime, state: "stopped", box_id: null },
      }),
    ]);

    expect(markup).toContain(">Luna<");
    expect(markup).toContain(">Milo<");
    // The avatar is the blob icon, idle while nothing is replying, with the presence dot on it.
    expect(markup).toContain('class="companion-icon companion-icon--idle"');
    expect(markup).toContain("cmprow__dot--ok");
    // Status rides in the row's accessible name and as a screen-reader word, never colour alone.
    expect(markup).toContain('title="Luna — Online"');
    expect(markup).toContain('title="Milo — Asleep"');
    expect(markup).toContain('class="cmprow__statusword sr-only">Online<');
    expect(markup).toContain('class="cmprow__statusword sr-only">Asleep<');
    expect(markup).toContain("New companion");
    // Persona and access were list columns; the roster row carries neither.
    expect(markup).not.toContain("Content marketing assistant");
    expect(markup).not.toContain("Developer assistant");
    expect(markup).not.toContain("Search companions");
    // Secondary actions stay out of the row until its single menu opens.
    expect(markup.match(/aria-label="Actions for/g)).toHaveLength(2);
    expect(markup).not.toContain(">Share<");
    expect(markup).not.toContain(">Settings<");
  });

  it("animates the roster blob only for a Pi-acknowledged reply", () => {
    const markup = render([
      companion({
        runtime: { ...companion().runtime, replying: true },
      }),
    ]);

    expect(markup).toContain('class="companion-icon companion-icon--thinking"');
    expect(markup).not.toContain("companion-icon--idle");
  });

  it("keeps hidden Companions out of the roster behind a collapsed Hidden disclosure", () => {
    const markup = render([
      companion({ name: "Visible" }),
      companion({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Stashed",
        hidden: true,
      }),
    ]);
    expect(markup).toContain("Visible");
    // Hidden rows live behind the disclosure, collapsed by default, so the name stays off screen
    // until a member expands it — where the row's menu offers unhide.
    expect(markup).toContain(">Hidden<");
    expect(markup).toContain('class="cmpnav__hiddenhead" aria-expanded="false"');
    expect(markup).not.toContain("Stashed");
    expect(markup.match(/aria-label="Actions for/g)).toHaveLength(1);
  });

  it("carries the Error status on the roster row's name and screen-reader word", () => {
    const markup = render([
      companion({
        runtime: {
          ...companion().runtime,
          state: "error",
          daemon_state: "error",
          replying: false,
          last_error: "Box runtime is not configured; set COMPANION_BOX_API_KEY",
        },
      }),
    ]);

    expect(markup).toContain('title="Luna — Error"');
    expect(markup).toContain('class="cmprow__statusword sr-only">Error<');
    expect(markup).toContain("cmprow__dot--danger");
    // The recorded reason lived on the retired list chip; the roster row does not surface it.
    expect(markup).not.toContain("COMPANION_BOX_API_KEY");
  });

  it("offers creation from the empty welcome pane instead of a dead list", () => {
    const markup = render([]);

    expect(markup).toContain("No Companions yet");
    expect(markup).toContain("Create a Companion with a name and a connected model provider.");
    expect(markup).toContain('class="btn-primary"');
    expect(markup).toContain("New companion");
    expect(markup).toContain('class="cmpnav__add" aria-label="New companion"');
    // Browsing exists only once there is something to browse; search left with the list.
    expect(markup).not.toContain("Browse companions");
    expect(markup).not.toContain("Search companions");
  });

  it("keeps creation gated while provider settings are still loading", () => {
    const markup = render([], null, false, null, null);

    expect(markup).toContain("Loading provider settings…");
    expect(markup).toContain('class="btn-primary" disabled=""');
    expect(markup).toContain('title="Provider settings are loading"');
    expect(markup).toContain('title="Provider settings are still loading"');
  });

  it("keeps the sidebar in Companions mode with the Skills switch available", () => {
    const markup = render([companion()]);

    expect(markup).toContain("Workspace mode");
    expect(markup).toContain("cmprow");
    expect(markup).not.toContain("My Skills");
  });

  it("opens the chat thread for a deep-linked Companion instead of the welcome pane", () => {
    const markup = render([companion()], "11111111-1111-4111-8111-111111111111");

    expect(markup).toContain("Chat with Luna");
    expect(markup).toContain("Back to Companions");
    expect(markup).not.toContain("companions-main--home");
  });

  it("falls back to the welcome pane when the deep-linked Companion is not visible", () => {
    const markup = render([companion()], "33333333-3333-4333-8333-333333333333");

    expect(markup).toContain('class="companions-main companions-main--home"');
    expect(markup).toContain("Pick a Companion in the sidebar to open its thread.");
    expect(markup).not.toContain("Chat with Luna");
  });

  it("renders Plugins as a separate web surface and keeps it out of chat", () => {
    const plugins = render([companion()], null, true);
    expect(plugins).toContain("Connect approved plugins or add a custom MCP server.");
    expect(plugins).toContain("Linear");
    expect(plugins).toContain("work");
    expect(plugins).not.toContain("Chat with Luna");

    const chat = render([companion()], companion().id);
    expect(chat).toContain("Chat with Luna");
    // Plugins is sidebar navigation, reachable from an open thread; the thread itself carries no
    // plugin chrome and no way to enter a connector credential.
    const chatSurface = chat.slice(chat.indexOf("<main"));
    expect(chatSurface).not.toContain(">Plugins<");
    expect(chat).not.toContain("Add MCP");
  });

  it("renders settings as a separate surface for a runner and keeps them off the welcome pane", () => {
    const settings = render([companion()], null, false, companion().id);

    expect(settings).toContain("Companion settings");
    expect(settings).toContain("Instructions");
    expect(settings).toContain("1. Provider");
    expect(settings).toContain("2. Model");
    expect(settings).toContain("Delete Companion");
    expect(settings).not.toContain("companions-main--home");
    expect(settings).not.toContain("Chat with Luna");
  });
});
