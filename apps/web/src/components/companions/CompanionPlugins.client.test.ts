// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionPluginAccount } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionPlugins, type CompanionPluginsApi } from "./CompanionPlugins";

const api = {
  deleteCompanionPlugin: vi.fn<CompanionPluginsApi["deleteCompanionPlugin"]>(),
  saveCompanionPlugin: vi.fn<CompanionPluginsApi["saveCompanionPlugin"]>(),
  startCompanionPluginOAuth: vi.fn<CompanionPluginsApi["startCompanionPluginOAuth"]>(),
} satisfies CompanionPluginsApi;
const { deleteCompanionPlugin, saveCompanionPlugin, startCompanionPluginOAuth } = api;

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const account: CompanionPluginAccount = {
  id: "44444444-4444-4444-8444-444444444444",
  provider: "linear",
  label: "work",
  transport: "http",
  endpoint: "https://mcp.example.test/linear",
  connected: true,
  created_at: "2026-08-13T00:00:00.000Z",
  updated_at: "2026-08-13T00:00:00.000Z",
};

const roots: Root[] = [];

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(initialAccounts: CompanionPluginAccount[] = []) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionPlugins, {
      orgId: "org-1",
      initialAccounts,
      onBack: () => {},
      api,
    }));
  });
  await flush();
  return container;
}

function setValue(form: HTMLFormElement, name: string, value: string) {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${name} input`);
  input.value = value;
}

function requireForm(container: ParentNode, selector: string): HTMLFormElement {
  const form = container.querySelector(selector);
  if (!(form instanceof HTMLFormElement)) throw new Error(`Missing form: ${selector}`);
  return form;
}

function requireInput(container: ParentNode, selector: string): HTMLInputElement {
  const input = container.querySelector(selector);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${selector}`);
  return input;
}

function requireButton(container: ParentNode, selector: string): HTMLButtonElement {
  const button = container.querySelector(selector);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${selector}`);
  return button;
}

function setControlled(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openAndSubmit(container: HTMLElement) {
  const add = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Add custom MCP"));
  await act(async () => add?.click());

  const form = requireForm(container, "#companion-plugin-create");
  setValue(form, "provider", "linear");
  setValue(form, "label", "work");
  setValue(form, "endpoint", "https://mcp.example.test/linear");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CompanionPlugins", () => {
  beforeEach(() => {
    window.location.href = "http://localhost/companions";
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("submits live custom-MCP form values and adds the labeled account", async () => {
    saveCompanionPlugin.mockResolvedValue(account);
    const container = await mount();

    await openAndSubmit(container);

    expect(saveCompanionPlugin).toHaveBeenCalledWith("org-1", {
      provider: "linear",
      label: "work",
      transport: "http",
      url: "https://mcp.example.test/linear",
      args: [],
    });
    expect(container.textContent).toContain("Connected");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("clears the busy state and reports a failed request", async () => {
    saveCompanionPlugin.mockRejectedValue(new Error("Request timed out. Try connecting again."));
    const container = await mount();

    await openAndSubmit(container);

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("Request timed out. Try connecting again.");
    const submit = requireButton(container, 'button[form="companion-plugin-create"]');
    expect(submit?.textContent).toContain("Connect MCP");
    expect(submit.disabled).toBe(false);
  });

  it("renders only the internal catalog and starts OAuth with a required label", async () => {
    startCompanionPluginOAuth.mockResolvedValue(
      "https://mcp.linear.app/authorize?state=signed-state",
    );
    const container = await mount();

    const sectionTitles = Array.from(
      container.querySelectorAll(".companions-plugin-section__title"),
      (heading) => heading.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(sectionTitles).toEqual(["Connected", "Available plugins"]);
    expect(container.textContent).toContain("No plugins connected yet.");
    expect(container.querySelector(".companions-plugin-empty")).not.toBeNull();
    expect(container.textContent).toContain(
      "Connect Linear, GitHub, Notion, Conductor, Slack, Gmail, or Sentry below, or add a custom MCP server.",
    );
    expect(container.textContent).toContain("Available plugins");
    expect(container.textContent).toContain("Linear");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Git clone, commit, and push");
    expect(container.textContent).toContain("Notion");
    expect(container.textContent).not.toContain("Browse the registry");
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.textContent).toContain("Conductor");
    expect(container.textContent).toContain("Slack");
    expect(container.textContent).toContain("create drafts for review in Gmail");
    expect(container.textContent).toContain("Sentry issues, events, traces, releases, and debugging context");
    expect(container.querySelectorAll(".companions-catalog-card")).toHaveLength(7);
    expect(container.querySelector('[data-plugin-mark="linear"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-mark="github"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-mark="notion"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-mark="conductor"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-mark="slack"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-mark="gmail"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-mark="sentry"]')).not.toBeNull();

    const connectButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".companions-catalog-card button"),
    ).find((button) => button.textContent === "Connect");
    await act(async () => connectButton?.click());

    const dialog = requireForm(container, "#companion-catalog-connect");
    const label = requireInput(dialog, "input");
    expect(container.querySelector(".companions-plugin-dialog--linear")).not.toBeNull();
    expect(container.querySelector(".og-dialog__ic svg")).not.toBeNull();
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain("Continue with OAuth");
    await act(async () => setControlled(label, "personal"));
    await act(async () => {
      dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(startCompanionPluginOAuth).toHaveBeenCalledWith("org-1", {
      server_name: "app.linear/linear",
      label: "personal",
    });
    expect(saveCompanionPlugin).not.toHaveBeenCalled();
    expect(window.location.href).toBe("https://mcp.linear.app/authorize?state=signed-state");
  });

  it("states the no-send boundary before Gmail OAuth", async () => {
    const container = await mount();
    const gmailCard = Array.from(
      container.querySelectorAll<HTMLElement>(".companions-catalog-card"),
    ).find((card) => card.textContent?.includes("Gmail"));

    await act(async () => {
      gmailCard?.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(container.querySelector(".companions-plugin-dialog--gmail")).not.toBeNull();
    expect(container.textContent).toContain("It never sends email.");
  });

  it("opens an approved control OAuth request and preserves its attachment binding", async () => {
    window.location.href = "http://localhost/companions?view=plugins&connect=github"
      + "&control_companion=11111111-1111-4111-8111-111111111111"
      + "&control_request=22222222-2222-4222-8222-222222222222";
    startCompanionPluginOAuth.mockResolvedValue(
      "https://github.com/login/oauth/authorize?state=signed-state",
    );

    const container = await mount();
    const form = requireForm(container, "#companion-catalog-connect");
    await act(async () => setControlled(requireInput(form, "input"), "work"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(startCompanionPluginOAuth).toHaveBeenCalledWith("org-1", {
      server_name: "io.github.github/github-mcp-server",
      label: "work",
      companion_id: "11111111-1111-4111-8111-111111111111",
      control_request_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("shows the connected callback result and removes OAuth query parameters", async () => {
    window.location.href = "http://localhost/companions?view=plugins&oauth=connected";

    const container = await mount([account]);

    expect(container.querySelector('[role="status"]')?.textContent).toBe("MCP account connected.");
    expect(container.textContent).toContain("work");
    expect(container.querySelector(".companions-plugin-row [data-plugin-mark=\"linear\"]")).not.toBeNull();
    expect(container.textContent).toContain("1 account");
    expect(Array.from(container.querySelectorAll(".companions-catalog-card button"), (button) => button.textContent))
      .toEqual(["Add account", "Connect", "Connect", "Connect", "Connect", "Connect", "Connect"]);
    expect(window.location.search).toBe("?view=plugins");
  });

  it("confirms GitHub trigger authority separately from per-Companion MCP attachment", async () => {
    window.location.href = "http://localhost/companions?view=plugins&oauth=connected&provider=github";

    const container = await mount();

    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("GitHub connected. Trigger registration is live for every Companion; MCP tools can now be attached separately.");
    expect(window.location.search).toBe("?view=plugins");
  });

  it("names Gmail as read and draft access after OAuth returns", async () => {
    window.location.href = "http://localhost/companions?view=plugins&oauth=connected&provider=gmail";

    const container = await mount();

    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("Gmail connected for reading and drafts.");
    expect(window.location.search).toBe("?view=plugins");
  });

  it("reports an OAuth start failure and restores the submit action", async () => {
    startCompanionPluginOAuth.mockRejectedValue(new Error("OAuth service is unavailable."));
    const container = await mount();
    const connectButton = requireButton(container, ".companions-catalog-card button");
    await act(async () => connectButton.click());
    const form = requireForm(container, "#companion-catalog-connect");
    await act(async () => setControlled(requireInput(form, "input"), "work"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("OAuth service is unavailable.");
    expect(requireButton(container, 'button[form="companion-catalog-connect"]').disabled)
      .toBe(false);
  });

  it("starts only one OAuth flow while the first request is pending", async () => {
    startCompanionPluginOAuth.mockReturnValue(new Promise(() => undefined));
    const container = await mount();
    const connectButton = requireButton(container, ".companions-catalog-card button");
    await act(async () => connectButton.click());
    const form = requireForm(container, "#companion-catalog-connect");
    await act(async () => setControlled(requireInput(form, "input"), "work"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(startCompanionPluginOAuth).toHaveBeenCalledTimes(1);
    expect(requireButton(container, 'button[form="companion-catalog-connect"]').disabled)
      .toBe(true);
  });

  it("disconnects an existing labeled account without changing the catalog", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    deleteCompanionPlugin.mockResolvedValue(undefined);
    const container = await mount([account]);
    const disconnect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disconnect Linear work"]',
    );

    await act(async () => disconnect?.click());

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("unavailable to every Companion"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("cannot register or receive events"));
    expect(deleteCompanionPlugin).toHaveBeenCalledWith("org-1", account.id);
    expect(container.querySelector('.companions-plugin-label')).toBeNull();
    expect(container.querySelector(
      'button[aria-label="Disconnect Linear work"]',
    )).toBeNull();
    expect(container.querySelectorAll(".companions-catalog-card")).toHaveLength(7);
    expect(container.textContent).not.toContain("1 account");
    expect(Array.from(
      container.querySelectorAll(".companions-catalog-card button"),
      (button) => button.textContent,
    )).toEqual(["Connect", "Connect", "Connect", "Connect", "Connect", "Connect", "Connect"]);
  });

  it("keeps the member-wide provider connected when disconnect is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const container = await mount([account]);

    await act(async () => container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disconnect Linear work"]',
    )?.click());

    expect(deleteCompanionPlugin).not.toHaveBeenCalled();
    expect(container.textContent).toContain("1 account");
  });

  it("explains a duplicate-label callback and removes the error parameter", async () => {
    window.location.href = "http://localhost/companions?view=plugins&oauth_error=duplicate_label";

    const container = await mount();

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe("That provider already has an account with this label.");
    expect(window.location.search).toBe("?view=plugins");
  });
});
