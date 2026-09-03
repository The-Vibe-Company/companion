// @vitest-environment happy-dom
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-module-mocking -- Existing tests predate the incremental anti-slop gate. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionProvidersResponse,
  CompanionThread as Thread,
} from "@companion/contracts";
import { COMPANION_LIFECYCLE_IDEMPOTENCY_HEADER } from "@companion/contracts/companion-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS,
  companionProviderSettingsCache,
} from "@/lib/companionProviderSettingsCache";
import { CompanionsApp, type CompanionNavigation } from "./CompanionsApp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush, refresh: () => {} }) }));

const companionsApi = vi.hoisted(() => ({
  duplicateCompanion: vi.fn(),
  deleteCompanionProvider: vi.fn(),
  getCompanionRuntime: vi.fn(),
  getCompanionThread: vi.fn(),
  listCompanions: vi.fn(),
  listCompanionProviders: vi.fn(),
  listCompanionRoutines: vi.fn(),
  listCompanionTriggers: vi.fn(),
  openCompanionDesktop: vi.fn(),
  saveCompanionProvider: vi.fn(),
  sendCompanionMessage: vi.fn(),
  setDefaultCompanionProvider: vi.fn(),
  setCompanionProvider: vi.fn(),
  startCompanionRuntime: vi.fn(),
  updateCompanionMemberState: vi.fn(),
}));

vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...companionsApi,
}));

const companionId = "11111111-1111-4111-8111-111111111111";
const viewer = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.test",
  initials: "A",
  avatarUrl: null,
};

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
  catalog: [{
    id: "anthropic",
    name: "Claude",
    auth_methods: ["api_key"],
    description: "",
    models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }],
  }],
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
    last_message: {
      preview: "Drafted the launch note.",
      role: "assistant",
      author_id: null,
      author_name: null,
      routine_name: null,
      trigger_name: null,
      created_at: "2026-08-14T09:05:00.000Z",
    },
    runtime: {
      generation: 1,
      state: "stopped",
      daemon_state: "stopped",
      replying: false,
      box_id: null,
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
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

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: [],
    last_message_at: null,
    last_read_ordinal: null,
    ...overrides,
    active_turn: overrides.active_turn ?? null,
    queued_count: overrides.queued_count ?? 0,
    interrupted_turn: overrides.interrupted_turn ?? null,
  };
}

const roots: Root[] = [];

async function render(
  companions: Companion[],
  openedId: string | null = null,
  initialProviderSettings: CompanionProvidersResponse | null = providers,
  initialSettingsCompanionId: string | null = null,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionsApp, {
      orgs: [org],
      currentOrg: org,
      viewer,
      navigation,
      skills: [],
      initialCompanions: companions,
      initialProviders: initialProviderSettings,
      initialPlugins: [],
      initialCompanionId: openedId,
      initialSettingsCompanionId,
    }));
  });
  return container;
}

function row(container: HTMLElement, index = 0) {
  return container.querySelectorAll(".cmprow")[index] as HTMLElement;
}

function setControlled(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function stubSettingsPickerFetches() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const body = path.includes("/v1/companion-plugins") ? { accounts: [] } : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
}

describe("CompanionsApp conversation list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companionProviderSettingsCache.clear();
    window.localStorage.clear();
    companionsApi.listCompanions.mockResolvedValue([companion()]);
    companionsApi.listCompanionProviders.mockResolvedValue(providers);
    companionsApi.getCompanionThread.mockResolvedValue(thread());
    companionsApi.getCompanionRuntime.mockResolvedValue(companion());
    companionsApi.listCompanionRoutines.mockResolvedValue([]);
    companionsApi.listCompanionTriggers.mockResolvedValue([]);
    companionsApi.deleteCompanionProvider.mockResolvedValue(undefined);
    companionsApi.saveCompanionProvider.mockResolvedValue({
      ...providers.connections[0]!,
      provider_id: "kimi-coding",
    });
    companionsApi.setDefaultCompanionProvider.mockResolvedValue(undefined);
    companionsApi.updateCompanionMemberState.mockImplementation(
      async (_orgId: string, _companionId: string, patch: Partial<Companion>) => companion(patch),
    );
    companionsApi.duplicateCompanion.mockResolvedValue(companion({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Luna copy",
    }));
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("shows each thread's last line, and marks the ones the reader's own watermark is behind", async () => {
    const container = await render([companion({ unread: true })]);

    expect(row(container).textContent).toContain("Drafted the launch note.");
    expect(row(container).querySelector(".cmprow__unread")).not.toBeNull();
  });

  it("renders the conversation list before the live provider catalog resolves", async () => {
    let resolveProviders!: (value: CompanionProvidersResponse) => void;
    companionsApi.listCompanionProviders.mockReturnValue(new Promise((resolve) => {
      resolveProviders = resolve;
    }));

    const container = await render([companion()], null, null);
    const newCompanion = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("New companion")) as HTMLButtonElement;

    expect(row(container).textContent).toContain("Drafted the launch note.");
    expect(newCompanion.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading provider settings",
    );
    expect(companionsApi.listCompanionProviders).toHaveBeenCalledWith("org-1");

    await act(async () => {
      resolveProviders(providers);
      await Promise.resolve();
    });

    expect(newCompanion.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("opens Companion settings immediately from a fresh provider cache without another request", async () => {
    stubSettingsPickerFetches();
    companionProviderSettingsCache.set(viewer.id, org.id, providers);

    const container = await render([companion()], null, null, companionId);

    expect(container.textContent).toContain("Companion settings");
    expect(container.textContent).not.toContain("Loading provider settings");
    expect(companionsApi.listCompanionProviders).not.toHaveBeenCalled();
  });

  it("keeps stale settings visible while one background refresh updates the cache", async () => {
    stubSettingsPickerFetches();
    const refreshed = {
      ...providers,
      catalog: providers.catalog.map((provider) => ({ ...provider, name: "Claude refreshed" })),
    };
    companionProviderSettingsCache.set(
      viewer.id,
      org.id,
      providers,
      Date.now() - COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS,
    );
    let resolveProviders!: (value: CompanionProvidersResponse) => void;
    companionsApi.listCompanionProviders.mockReturnValue(new Promise((resolve) => {
      resolveProviders = resolve;
    }));

    const container = await render([companion()], null, null, companionId);
    expect(container.textContent).toContain("Companion settings");
    expect(container.textContent).not.toContain("Loading provider settings");
    expect(companionsApi.listCompanionProviders).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveProviders(refreshed);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Claude refreshed");
    expect(companionProviderSettingsCache.read(viewer.id, org.id)?.providers).toEqual(refreshed);
  });

  it("keeps stale settings usable and offers Retry when the background refresh fails", async () => {
    stubSettingsPickerFetches();
    companionProviderSettingsCache.set(
      viewer.id,
      org.id,
      providers,
      Date.now() - COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS,
    );
    companionsApi.listCompanionProviders
      .mockRejectedValueOnce(new Error("Provider catalog unavailable."))
      .mockResolvedValueOnce(providers);

    const container = await render([companion()], null, null, companionId);
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    const retry = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry") as HTMLButtonElement;

    expect(container.textContent).toContain("Companion settings");
    expect(alert.textContent).toContain("Provider catalog unavailable.");
    expect(retry).toBeDefined();

    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(companionsApi.listCompanionProviders).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Companion settings");
  });

  it("writes provider mutations through to the shared cache", async () => {
    const connected: CompanionProvidersResponse = {
      ...providers,
      catalog: [
        ...providers.catalog,
        {
          id: "kimi-coding",
          name: "Kimi",
          auth_methods: ["api_key"],
          description: "",
          models: [{ id: "kimi-for-coding", name: "Kimi K2.7 Code", default: true }],
        },
      ],
      connections: [
        ...providers.connections,
        {
          ...providers.connections[0]!,
          provider_id: "kimi-coding",
        },
      ],
    };
    const container = await render([companion()], null, connected);

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Providers")?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Make default")?.click();
      await Promise.resolve();
    });

    expect(companionsApi.setDefaultCompanionProvider)
      .toHaveBeenCalledWith(org.id, "kimi-coding");
    expect(companionProviderSettingsCache.read(viewer.id, org.id)?.providers.default_provider_id)
      .toBe("kimi-coding");
  });

  it("writes a new API-key connection through to the shared cache", async () => {
    const connectable: CompanionProvidersResponse = {
      ...providers,
      catalog: [
        ...providers.catalog,
        {
          id: "kimi-coding",
          name: "Kimi",
          auth_methods: ["api_key"],
          description: "",
          models: [{ id: "kimi-for-coding", name: "Kimi K2.7 Code", default: true }],
        },
      ],
    };
    const container = await render([companion()], null, connectable);

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Providers")?.click();
    });
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      setControlled(key, "kimi-secret");
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>(".companions-provider-add")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(companionsApi.saveCompanionProvider).toHaveBeenCalledWith(org.id, "kimi-coding", {
      auth_method: "api_key",
      credential: "kimi-secret",
    });
    expect(companionProviderSettingsCache.read(viewer.id, org.id)?.providers.connections)
      .toEqual(expect.arrayContaining([expect.objectContaining({ provider_id: "kimi-coding" })]));
  });

  it("writes a provider disconnection through to the shared cache", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = await render([companion()], null, providers);

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Providers")?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Disconnect")?.click();
    });

    expect(companionsApi.deleteCompanionProvider).toHaveBeenCalledWith(org.id, "anthropic");
    expect(companionProviderSettingsCache.read(viewer.id, org.id)?.providers).toMatchObject({
      connections: [],
      default_provider_id: null,
    });
    confirm.mockRestore();
  });

  it("recovers provider actions after a failed request is retried", async () => {
    companionsApi.listCompanionProviders
      .mockRejectedValueOnce(new Error("Provider catalog unavailable."))
      .mockResolvedValueOnce(providers);

    const container = await render([], null, null);
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    const retry = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry") as HTMLButtonElement;

    expect(alert.textContent).toContain("Provider catalog unavailable.");
    expect(retry).toBeDefined();

    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const newCompanion = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("New companion")) as HTMLButtonElement;
    expect(companionsApi.listCompanionProviders).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(newCompanion.disabled).toBe(false);
  });

  it("shows provider failure and Retry without leaving an open thread", async () => {
    companionsApi.listCompanionProviders
      .mockRejectedValueOnce(new Error("Provider catalog unavailable."))
      .mockResolvedValueOnce(providers);

    const container = await render([companion()], companionId, null);
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    const retry = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry") as HTMLButtonElement;

    expect(alert.textContent).toContain("Provider catalog unavailable.");
    expect(container.textContent).toContain("Drafted the launch note.");

    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(companionsApi.listCompanionProviders).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect([...container.querySelectorAll("button")]
      .some((button) => button.textContent === "Providers")).toBe(true);
  });

  it("leaves a caught-up thread unmarked, whatever it last said", async () => {
    // Read state is the control plane's per-member watermark (THE-351), not this device's guess.
    const container = await render([companion({ unread: false })]);

    expect(row(container).textContent).toContain("Drafted the launch note.");
    expect(row(container).querySelector(".cmprow__unread")).toBeNull();
  });

  it("welcomes an empty workspace and points a full one at the sidebar roster", async () => {
    const empty = await render([]);
    expect(empty.querySelector(".companions-main--home")).not.toBeNull();
    expect(empty.querySelector(".companions-home__title")?.textContent).toContain("Companions");
    expect(empty.querySelector(".companions-home__count")?.textContent).toBe("0");
    expect(empty.querySelector(".companions-home__desc")?.textContent)
      .toBe("Create a Companion with a name and a connected model provider.");
    // Nothing to browse to yet: creation is the only action a member without Companions has.
    expect(empty.querySelector(".companions-home__browse")).toBeNull();
    expect(empty.querySelector(".cmpnav__empty")?.textContent).toBe("No Companions yet");

    act(() => roots.pop()?.unmount());
    empty.remove();

    const container = await render([
      companion(),
      companion({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Stashed",
        hidden: true,
      }),
    ]);

    // The count is the whole roster, hidden rows included; the copy hands over to the sidebar.
    expect(container.querySelector(".companions-home__count")?.textContent).toBe("2");
    expect(container.querySelector(".companions-home__desc")?.textContent)
      .toBe("Pick a Companion in the sidebar to open its thread.");
    const create = [...container.querySelectorAll("button")]
      .find((button) => button.classList.contains("btn-primary")
        && button.textContent?.includes("New companion")) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect(create.title).toBe("New companion");
    expect(container.querySelector(".companions-home__browse")?.textContent).toBe("Browse companions");
  });

  it("opens the single row menu from the keyboard without opening the chat", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;
    trigger.focus();

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for Luna"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Settings");
    expect(menu?.textContent).toContain("Share");
    expect(menu?.textContent).toContain("Pin");
    expect(menu?.textContent).toContain("Mark as unread");
    expect(menu?.textContent).toContain("Duplicate");
    expect(menu?.textContent).toContain("Hide");
    expect(menu?.querySelector(".companions-row-menu__danger")?.textContent).toBe("Delete");
    expect(document.activeElement?.textContent).toBe("Settings");
    expect(container.textContent).not.toContain("Chat with Luna");

    await act(async () => {
      menu?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.click();
    });
    expect(routerPush).toHaveBeenCalledWith(`/companions/${companionId}/settings`);
    expect(container.textContent).not.toContain("Chat with Luna");
  });

  it("keeps owner-only actions out of a Viewer's row menu", async () => {
    const container = await render([companion({ access: "viewer", owner_id: "user-2" })]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());

    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for Luna"]');
    expect(menu?.textContent).toContain("Settings");
    expect(menu?.textContent).toContain("Pin");
    expect(menu?.textContent).toContain("Mark as unread");
    expect(menu?.textContent).toContain("Hide");
    expect(menu?.textContent).not.toContain("Share");
    expect(menu?.textContent).not.toContain("Duplicate");
    expect(menu?.textContent).not.toContain("Delete");
  });

  it("keeps Delete out of an Editor's row menu", async () => {
    const container = await render([companion({ access: "editor", owner_id: "user-2" })]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());

    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for Luna"]');
    expect(menu?.textContent).toContain("Settings");
    expect(menu?.textContent).toContain("Hide");
    expect(menu?.textContent).not.toContain("Delete");
    expect(menu?.querySelector(".companions-row-menu__danger")).toBeNull();
  });

  it("opens the last menu action with ArrowUp", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;
    trigger.focus();

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    // Delete sits last on an owner's row, past Hide, so ArrowUp reaches destruction directly.
    expect(document.activeElement?.textContent).toBe("Delete");
  });

  it("moves Tab from the portal menu to the next row instead of losing focus", async () => {
    const nova = companion({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Nova",
    });
    const container = await render([companion(), nova]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    const firstItem = document.activeElement as HTMLButtonElement;
    await act(async () => {
      firstItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    // The next focusable past Luna's trigger is Nova's main row button in the sidebar roster.
    expect(document.activeElement?.classList.contains("cmprow__main")).toBe(true);
    expect(document.activeElement?.textContent).toContain("Nova");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("routes member-state actions through the row menu and applies the server result", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    const pin = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Pin")!;
    await act(async () => pin.click());
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(companionsApi.updateCompanionMemberState).toHaveBeenCalledWith(
      "org-1",
      companionId,
      { pinned: true },
    );
    expect(document.activeElement).toBe(trigger);

    // The server result landed on the row: its menu now offers the reverse action.
    await act(async () => trigger.click());
    expect([...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .some((item) => item.textContent === "Unpin")).toBe(true);
  });

  it("moves focus to the sidebar create button after hiding removes the active row", async () => {
    let resolveHide!: (value: Companion) => void;
    companionsApi.updateCompanionMemberState.mockReturnValue(new Promise((resolve) => {
      resolveHide = resolve;
    }));
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    const hide = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Hide")!;
    await act(async () => hide.click());
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      resolveHide(companion({ hidden: true }));
      await Promise.resolve();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    // The hidden row left the roster and its collapsed disclosure does not take focus, so
    // focus falls back to the create button rather than dropping to the document body.
    expect(document.activeElement).toBe(container.querySelector(".cmpnav__add"));
    expect(container.querySelector(".cmprow")).toBeNull();
    const disclosure = container.querySelector(".cmpnav__hiddenhead");
    expect(disclosure?.textContent).toContain("Hidden");
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
  });

  it("duplicates from the row menu and renders the returned Companion", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    const duplicate = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Duplicate")!;
    await act(async () => duplicate.click());

    expect(companionsApi.duplicateCompanion).toHaveBeenCalledWith("org-1", companionId);
    expect(container.textContent).toContain("Luna copy");
  });

  it("keeps hidden Companions behind the collapsed disclosure until Unhide restores the row with focus", async () => {
    const stashedId = "22222222-2222-4222-8222-222222222222";
    companionsApi.updateCompanionMemberState.mockResolvedValue(
      companion({ id: stashedId, name: "Stashed", hidden: false }),
    );
    const container = await render([
      companion({ name: "Visible" }),
      companion({ id: stashedId, name: "Stashed", hidden: true }),
    ]);

    // Collapsed on mount: a hidden row is out of the roster, kebab and all, until asked for.
    expect(container.querySelector('[aria-label="Actions for Stashed"]')).toBeNull();
    const disclosure = container.querySelector<HTMLButtonElement>(".cmpnav__hiddenhead")!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.textContent).toContain("Hidden");
    expect(disclosure.textContent).toContain("1");

    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".cmprow--hidden")?.textContent).toContain("Stashed");

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Stashed"]')!;
    await act(async () => trigger.click());

    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for Stashed"]');
    expect(menu?.textContent).toContain("Settings");
    expect(menu?.textContent).toContain("Unhide");
    expect(menu?.textContent).not.toContain("Pin");
    expect(menu?.querySelector(".companions-row-menu__danger")?.textContent).toBe("Delete");

    const unhide = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Unhide")!;
    await act(async () => {
      unhide.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    // The row is back in the roster, the disclosure is gone with its last tenant, and focus
    // followed the row it was acting on.
    expect(container.querySelector(".cmpnav__hidden")).toBeNull();
    const restored = [...container.querySelectorAll<HTMLButtonElement>(".cmprow__main")]
      .find((main) => main.textContent?.includes("Stashed"))!;
    expect(document.activeElement).toBe(restored);
  });

  it("opens the chat from the primary row button", async () => {
    const container = await render([companion()]);
    const main = container.querySelector<HTMLButtonElement>(".cmprow__main")!;

    await act(async () => main.click());

    expect(container.querySelector('[aria-label="Back to Companions"]')).not.toBeNull();
  });

  it("confirms kebab Delete and keeps one idempotency id across a failed attempt's retry", async () => {
    const requests: { url: string; method: string | undefined; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method,
        headers: { ...(init?.headers as Record<string, string>) },
      });
      // The runtime turns the first attempt away; the retry is accepted as durable intent.
      if (requests.length === 1) {
        return new Response(JSON.stringify({ message: "Runtime unavailable." }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ operation: { id: "op-1" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }));
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    const confirmDelete = async () => {
      await act(async () => trigger.click());
      await act(async () => {
        [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((item) => item.textContent === "Delete")!.click();
      });
      const dialog = container.querySelector(".companions-delete-dialog") as HTMLElement;
      expect(dialog.textContent).toContain("Delete Luna?");
      expect(dialog.textContent).toContain("permanently deleted after runtime confirmation");
      await act(async () => {
        [...dialog.querySelectorAll("button")]
          .find((button) => button.textContent === "Delete Companion")!.click();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
    };

    await confirmDelete();

    // The failed attempt surfaces where the member is, and the dialog does not linger.
    expect(container.querySelector(".companions-delete-dialog")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Runtime unavailable.");

    await confirmDelete();

    expect(container.querySelector(".companions-delete-dialog")).toBeNull();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(`/v1/companions/${companionId}`);
      expect(request.method).toBe("DELETE");
    }
    // One operation however many confirms it takes: the retry replays the very same request id.
    const requestId = requests[0]!.headers[COMPANION_LIFECYCLE_IDEMPOTENCY_HEADER];
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(requests[1]!.headers[COMPANION_LIFECYCLE_IDEMPOTENCY_HEADER]).toBe(requestId);
  });

  it("projects Stopping on the row once a delete is accepted, before the list drops it", async () => {
    companionsApi.getCompanionRuntime.mockResolvedValue(companion({
      runtime: { ...companion().runtime, state: "stopping" },
    }));
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ operation: { id: "op-1" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      })));
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Delete")!.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Delete Companion")!.click();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    // The 202 enqueued durable intent; the one runtime refresh reprojects the row so it never
    // sits there looking Asleep while the runtime tears its Box down.
    expect(container.querySelector(".companions-delete-dialog")).toBeNull();
    expect(companionsApi.getCompanionRuntime).toHaveBeenCalledWith("org-1", companionId);
    expect(row(container).querySelector(".cmprow__statusword")?.textContent).toContain("Stopping");
    expect(row(container).querySelector(".cmprow__main")?.getAttribute("title")).toBe("Luna — Stopping");
  });

  it("clears the mark on the thread it opens, including one reached by a deep link", async () => {
    companionsApi.getCompanionThread.mockResolvedValue(thread({
      entries: [{
        event_id: "pi:1",
        ordinal: 0,
        role: "assistant",
        content: "Drafted the launch note.",
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
        created_at: "2026-08-14T09:05:00.000Z",
      }],
    }));

    // Nobody clicked this row, so the optimistic clear on open never ran; the read that answers is
    // what the control plane already marked, and the row has to agree with it. Asserting the dot on
    // the open thread would prove nothing — an open thread is never dotted — so the thread is
    // closed first, which is the moment a row that never cleared would show one.
    const container = await render([companion({ unread: true })], companionId);

    const back = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Back to Companions") as HTMLButtonElement;
    await act(async () => {
      back.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(row(container).querySelector(".cmprow__unread")).toBeNull();
  });

  it("opens the existing model picker from a terminal model error without replaying chat", async () => {
    companionsApi.getCompanionThread.mockResolvedValue(thread({
      entries: [{
        event_id: "v3:22222222-2222-4222-8222-222222222222:error:17",
        ordinal: 0,
        role: "system",
        content: "The selected model is unavailable. Choose a different model and try again.",
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
        created_at: "2026-08-14T09:05:00.000Z",
      }],
    }));
    const container = await render([companion()], companionId);

    const changeModel = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Change model") as HTMLButtonElement;
    await act(async () => changeModel.click());

    expect(routerPush).toHaveBeenCalledWith(
      `/companions/${companionId}/settings#companion-model`,
    );
    expect(companionsApi.sendCompanionMessage).not.toHaveBeenCalled();
  });

  it("keeps a preview a runtime read did not answer with", async () => {
    // Runtime reads that update lifecycle state may report `last_message: null`; replacing the row
    // wholesale would blank the line the sidebar is showing.
    companionsApi.getCompanionRuntime.mockResolvedValue(
      companion({ last_message: null, runtime: { ...companion().runtime, state: "provisioning" } }),
    );
    const container = await render([companion()], companionId);

    expect(row(container).textContent).toContain("Drafted the launch note.");
  });

  it("names the routine in the list instead of leaking the prompt nobody typed", async () => {
    const container = await render([companion({
      last_message: {
        preview: "",
        role: "user",
        author_id: "owner-1",
        author_name: "Ada",
        routine_name: "Daily standup",
        trigger_name: null,
        created_at: "2026-08-14T09:30:00.000Z",
      },
    })]);

    expect(row(container).textContent).toContain("Routine: Daily standup");
    expect(row(container).textContent).not.toContain("Write the standup");
  });

  it("names the trigger in the list instead of leaking the composed webhook prompt", async () => {
    const container = await render([companion({
      last_message: {
        preview: "",
        role: "user",
        author_id: "owner-1",
        author_name: "Ada",
        routine_name: null,
        trigger_name: "CI failed",
        created_at: "2026-08-14T09:30:00.000Z",
      },
    })]);

    expect(row(container).textContent).toContain("Trigger: CI failed");
    expect(row(container).textContent).not.toContain("Summarize the failure");
  });

  const said = (ordinal: number) => ({
    event_id: `pi:${ordinal}`,
    ordinal,
    role: "assistant" as const,
    content: `Line ${ordinal}`,
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
    created_at: `2026-08-14T09:0${ordinal}:00.000Z`,
  });

  it("takes the read watermark once per thread, however often the thread is re-read", async () => {
    // The read that reports the watermark is also the read that advances it, so the next poll
    // reports a newer one. Capturing that would draw a divider above a line this reader is watching
    // arrive, seconds after they opened a thread they had never opened before.
    vi.useFakeTimers();
    let reads = 0;
    companionsApi.getCompanionThread.mockImplementation(async () => {
      reads += 1;
      return thread({
        entries: [said(0), said(1), said(2), said(3)],
        // A first visit, and then the watermark that this reader's own first read just moved.
        last_read_ordinal: reads === 1 ? null : 2,
      });
    });

    const container = await render([companion()], companionId);
    expect(container.querySelector("[data-slot='chat-new-separator']")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    expect(reads).toBeGreaterThan(1);
    expect(container.querySelector("[data-slot='chat-new-separator']")).toBeNull();
  });

  it("takes it again when the sidebar moves to another thread", async () => {
    // One thread's watermark must never judge another thread's transcript.
    const nova = "22222222-2222-4222-8222-222222222222";
    companionsApi.getCompanionThread.mockImplementation(async (_org: string, id: string) =>
      thread({
        companion_id: id,
        entries: [said(0), said(1), said(2), said(3)],
        // Luna is caught up; Nova has two lines this reader has not seen.
        last_read_ordinal: id === companionId ? 3 : 1,
      }));
    const container = await render(
      [companion(), companion({ id: nova, name: "Nova" })],
      companionId,
    );

    expect(container.querySelector("[data-slot='chat-new-separator']")).toBeNull();

    const nextRow = [...container.querySelectorAll(".cmprow")]
      .find((row) => row.querySelector(".cmprow__name")?.textContent === "Nova")
      ?.querySelector<HTMLButtonElement>(".cmprow__main");
    await act(async () => {
      nextRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector("[data-slot='chat-new-separator']")).not.toBeNull();
  });

  it("leaves the roster's order to the control plane when a read answers", async () => {
    // Pin order is the server's — pin age first, then recency — and the client does not know pin age.
    // Re-sorting here on every answer would move rows under the cursor and then lose the argument to
    // the next list poll, which puts them back.
    const nova = "22222222-2222-4222-8222-222222222222";
    const luna = companion({ pinned: true, updated_at: "2026-08-14T09:00:00.000Z" });
    const rows = [
      companion({ id: nova, name: "Nova", pinned: true, updated_at: "2026-08-10T09:00:00.000Z" }),
      luna,
    ];
    companionsApi.getCompanionRuntime.mockResolvedValue({
      ...luna,
      runtime: { ...luna.runtime, state: "provisioning" },
    });
    const container = await render(rows, companionId);

    const names = () => [...container.querySelectorAll(".cmprow__name")]
      .map((row) => row.textContent);
    expect(names()).toEqual(["Nova", "Luna"]);

    expect(names()).toEqual(["Nova", "Luna"]);
  });

  it("re-reads the list on a slow cadence without contacting a Box", async () => {
    vi.useFakeTimers();
    const container = await render([companion()]);
    companionsApi.listCompanions.mockResolvedValue([companion({
      last_message: {
        preview: "Then the pricing page.",
        role: "assistant",
        author_id: null,
        author_name: null,
        routine_name: null,
        trigger_name: null,
        created_at: "2026-08-14T09:30:00.000Z",
      },
    })]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(row(container).textContent).toContain("Then the pricing page.");
    // The list is the control-plane read model, and nothing about polling it observes or resumes a
    // Box for any Companion in it.
    expect(companionsApi.openCompanionDesktop).not.toHaveBeenCalled();
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
    expect(companionsApi.getCompanionRuntime).not.toHaveBeenCalled();
  });
});
