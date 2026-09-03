// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionLifecycleAccepted,
  CompanionProvidersResponse,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFetchError } from "@/lib/apiClient";
import { CompanionSettings } from "./CompanionSettings";

const companionApi = vi.hoisted(() => ({
  updateCompanion: vi.fn(),
  deleteCompanion: vi.fn(),
  getCompanionRuntime: vi.fn(),
  restartCompanionRuntime: vi.fn(),
  updateCompanionMemberState: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- legacy pattern predating the incremental anti-slop gate
vi.mock("@/lib/companions", () => companionApi);
// oxlint-disable-next-line anti-slop/no-module-mocking -- legacy pattern predating the incremental anti-slop gate
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  apiFetch: vi.fn(async (path: string) => {
    if (String(path).includes("/v1/companion-plugins")) return { accounts: [] };
    return [];
  }),
}));

// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- invariant checked by the surrounding validation
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const providers: CompanionProvidersResponse = {
  catalog: [
    {
      id: "anthropic",
      name: "Claude",
      auth_methods: ["api_key"],
      description: "",
      models: [
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
    },
    {
      id: "openai-codex",
      name: "Codex",
      auth_methods: ["subscription"],
      description: "",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", default: true }],
    },
  ],
  connections: [
    {
      provider_id: "anthropic",
      auth_method: "api_key",
      connected_by: "user-1",
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    },
    {
      provider_id: "openai-codex",
      auth_method: "subscription",
      connected_by: "user-1",
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    },
  ],
  default_provider_id: "anthropic",
  can_manage: true,
};

function companion(
  access: Companion["access"] = "owner",
  runtimeState: "running" | "stopped" | "error" = "stopped",
): Companion {
  return {
    id: companionId,
    name: "Luna",
    persona: "Check every source.",
    model_id: "claude-opus-4-8",
    selected_skill_ids: [],
    can_write_skills: true,
    selected_mcp_account_ids: [],
    owner_id: "user-1",
    access,
    pinned: false,
    hidden: false,
    unread: false,
    last_message: null,
    runtime: {
      generation: 1,
      state: runtimeState,
      daemon_state: runtimeState === "running"
        ? "running"
        : runtimeState === "error"
          ? "error"
          : "stopped",
      replying: false,
      box_id: access === "viewer" ? null : "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 14,
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
}

const recycleAccepted: CompanionLifecycleAccepted = { intent: "recycle_pi", revision: "2" };
const deleteAccepted: CompanionLifecycleAccepted = { intent: "delete", revision: "2" };

const roots: Root[] = [];

async function mount(who: Companion) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const onSaved = vi.fn();
  const onDeleted = vi.fn();
  await act(async () => {
    root.render(React.createElement(CompanionSettings, {
      orgId: "org-1",
      companion: who,
      providers,
      onBack: vi.fn(),
      onSaved,
      onDeleted,
    }));
  });
  return { container, onSaved, onDeleted };
}

function setControlled(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

async function click(control: HTMLElement) {
  await act(async () => control.click());
}

async function confirmRestart(container: HTMLElement) {
  await click(button(container, "Restart"));
  await click(button(document.querySelector<HTMLElement>('[role="dialog"]')!, "Restart"));
}

describe("CompanionSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companionApi.updateCompanion.mockImplementation(async (
      _orgId: string,
      _companionId: string,
      input: { name: string; persona: string | null; provider_id: string; model_id: string },
    ) => ({
      ...companion(),
      name: input.name,
      persona: input.persona,
      model_id: input.model_id,
      runtime: { ...companion().runtime, provider_ids: [input.provider_id] },
    }));
    companionApi.deleteCompanion.mockResolvedValue(deleteAccepted);
    companionApi.getCompanionRuntime.mockResolvedValue(companion("owner", "running"));
    companionApi.restartCompanionRuntime.mockImplementation(async (
      _orgId: string,
      _companionId: string,
      _input: { target: "pi" },
    ): Promise<CompanionLifecycleAccepted> => recycleAccepted);
  });

  afterEach(async () => {
    vi.useRealTimers();
    window.location.hash = "";
    while (roots.length) {
      const root = roots.pop();
      await act(async () => root?.unmount());
    }
    document.body.replaceChildren();
  });

  it("focuses the existing model picker when opened from a terminal model error", async () => {
    window.location.hash = "#companion-model";
    const { container } = await mount(companion("editor"));
    const selected = container.querySelector<HTMLInputElement>(
      'input[name="companion-settings-model"]:checked',
    );

    expect(selected).not.toBeNull();
    expect(document.activeElement).toBe(selected);
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBeNull();
  });

  it("announces model-save loading and failure from the existing settings flow", async () => {
    let rejectSave: (cause: Error) => void = () => undefined;
    companionApi.updateCompanion.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSave = reject;
    }));
    const { container } = await mount(companion("editor"));
    const form = container.querySelector("form")!;
    const sonnet = form.querySelector<HTMLInputElement>('input[value="claude-sonnet-4-6"]')!;

    await act(async () => sonnet.click());
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(button(container, "Saving...").disabled).toBe(true);

    await act(async () => rejectSave(new Error("Model settings could not be saved.")));
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Model settings could not be saved.",
    );
    expect(form.getAttribute("aria-busy")).toBeNull();
  });

  it("persists editable settings while preserving Owner-only deletion", async () => {
    const { container, onSaved } = await mount(companion("editor"));
    const form = container.querySelector("form")!;
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- invariant checked by the surrounding validation
    const name = form.elements.namedItem("name") as HTMLInputElement;
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- invariant checked by the surrounding validation
    const instructions = form.elements.namedItem("instructions") as HTMLTextAreaElement;
    const codex = form.querySelector<HTMLInputElement>('input[value="openai-codex"]')!;

    await act(async () => {
      setControlled(name, "Luna research");
      setControlled(instructions, "Challenge every source.");
      codex.click();
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // Skills Hub access is unconditional, so a save never carries a grant field for the database to
    // refuse and the settings form never offers one.
    expect(companionApi.updateCompanion).toHaveBeenCalledWith("org-1", companionId, {
      name: "Luna research",
      persona: "Challenge every source.",
      provider_id: "openai-codex",
      model_id: "gpt-5.5",
      selected_skill_ids: [],
      selected_mcp_account_ids: [],
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- icon catalogs use geometric domain terms
      icon: { shape: 1, mouth: 1, accessory: 1, color: 2 },
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Settings saved.");
    expect(container.textContent).not.toContain("Delete Companion");
    expect(container.textContent).not.toContain("Skills Hub API access");
    expect(container.textContent).not.toContain("grant active");
  });

  it("renders Viewer settings with no write or runtime controls", async () => {
    const { container } = await mount(companion("viewer"));

    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Save changes");
    expect(container.textContent).not.toContain("Restart Companion");
    expect(container.textContent).not.toContain("Delete Companion");
  });

  it("queues a Pi restart without claiming it already completed", async () => {
    const online = companion("editor", "running");
    const { container, onSaved } = await mount(online);

    await click(button(container, "Restart"));
    expect(companionApi.restartCompanionRuntime).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Active work may be interrupted");
    await click(button(dialog, "Restart"));

    expect(companionApi.restartCompanionRuntime).toHaveBeenCalledWith(
      "org-1",
      companionId,
      { target: "pi" },
      expect.stringMatching(UUID),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Restart accepted.");
    expect(container.textContent).not.toContain("Restart completed.");
  });

  it("keeps Pi recovery available while an existing runtime is in Error", async () => {
    const failed = companion("editor", "error");
    failed.runtime = {
      ...failed.runtime,
      last_error: "Pi was not idle with an empty broker queue before dispatch.",
    };
    const { container } = await mount(failed);

    expect(button(container, "Restart").disabled).toBe(false);
    await click(button(container, "Restart"));
    await click(button(document.querySelector<HTMLElement>('[role="dialog"]')!, "Restart"));

    expect(companionApi.restartCompanionRuntime).toHaveBeenCalledWith(
      "org-1",
      companionId,
      { target: "pi" },
      expect.stringMatching(UUID),
    );
  });

  it("accepts Pi-only recovery while an explicitly stopped Companion is offline", async () => {
    const { container } = await mount(companion("owner", "stopped"));

    expect(button(container, "Restart").disabled).toBe(false);
    expect(container.textContent).toContain(
      "Pi-only recovery remains available while this Companion is offline.",
    );
    await click(button(container, "Restart"));
    await click(button(document.querySelector<HTMLElement>('[role="dialog"]')!, "Restart"));
    expect(companionApi.restartCompanionRuntime).toHaveBeenCalledWith(
      "org-1",
      companionId,
      { target: "pi" },
      expect.stringMatching(UUID),
    );
  });

  it("exposes no full-Box control and sends only the Pi restart capability", async () => {
    const { container } = await mount(companion("owner", "running"));
    expect(container.querySelector('input[value="box"]')).toBeNull();
    expect(container.textContent).not.toContain("Full Box");
    await click(button(container, "Restart"));
    expect(companionApi.restartCompanionRuntime).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(button(dialog, "Restart"));
    expect(companionApi.restartCompanionRuntime).toHaveBeenCalledWith(
      "org-1",
      companionId,
      { target: "pi" },
      expect.stringMatching(UUID),
    );
  });

  it("surfaces a refused restart as an explicit error", async () => {
    companionApi.restartCompanionRuntime.mockRejectedValue(new Error("Restart was refused."));
    const { container } = await mount(companion("owner", "running"));

    await click(button(container, "Restart"));
    await click(button(document.querySelector<HTMLElement>('[role="dialog"]')!, "Restart"));

    expect(container.querySelector("[role='alert']")?.textContent).toContain("Restart was refused.");
    expect(container.textContent).not.toContain("restart accepted");
  });

  it("reuses the restart id after a response is lost", async () => {
    companionApi.restartCompanionRuntime
      .mockRejectedValueOnce(new ApiFetchError("Request timed out.", 408))
      .mockResolvedValueOnce(recycleAccepted);
    const { container } = await mount(companion("owner", "running"));

    await confirmRestart(container);
    await confirmRestart(container);

    expect(companionApi.restartCompanionRuntime).toHaveBeenCalledTimes(2);
    expect(companionApi.restartCompanionRuntime.mock.calls[1]?.[3]).toBe(
      companionApi.restartCompanionRuntime.mock.calls[0]?.[3],
    );
  });

  it("presents a running restart replay as in progress instead of newly accepted", async () => {
    vi.useFakeTimers();
    const runningProjection = companion("owner", "running");
    runningProjection.runtime = {
      ...runningProjection.runtime,
      lifecycle_intent: "recycle_pi",
    };
    companionApi.getCompanionRuntime.mockResolvedValue(runningProjection);
    companionApi.restartCompanionRuntime
      .mockRejectedValueOnce(new ApiFetchError("Request timed out.", 408))
      .mockResolvedValueOnce(recycleAccepted);
    const { container } = await mount(companion("owner", "running"));

    await confirmRestart(container);
    await confirmRestart(container);

    expect(container.textContent).toContain("Restart accepted.");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(container.textContent).toContain("Restart is in progress.");
    expect(container.textContent).not.toContain("Restart accepted.");
    expect(container.textContent).not.toContain("Restart completed.");
  });

  it("waits for a durable projection before presenting a restart replay as completed", async () => {
    vi.useFakeTimers();
    companionApi.getCompanionRuntime.mockResolvedValue(companion("owner", "running"));
    companionApi.restartCompanionRuntime
      .mockRejectedValueOnce(new ApiFetchError("Request timed out.", 408))
      .mockResolvedValueOnce(recycleAccepted);
    const { container } = await mount(companion("owner", "running"));

    await confirmRestart(container);
    await confirmRestart(container);

    expect(container.textContent).toContain("Restart accepted.");
    expect(container.textContent).not.toContain("Restart completed.");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(container.textContent).toContain("Restart completed.");
    expect(container.textContent).not.toContain("Restart accepted.");
  });

  it("polls an accepted restart every three seconds and surfaces its durable failure", async () => {
    vi.useFakeTimers();
    const failed = companion("owner", "running");
    failed.runtime = {
      ...failed.runtime,
      state: "error",
      daemon_state: "error",
      replying: false,
      last_error: "Pi could not stay running.",
    };
    companionApi.getCompanionRuntime.mockResolvedValue(failed);
    const { container } = await mount(companion("owner", "running"));

    await confirmRestart(container);
    expect(container.textContent).toContain("Restart accepted.");
    expect(companionApi.getCompanionRuntime).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(companionApi.getCompanionRuntime).toHaveBeenCalledOnce();
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Pi could not stay running.",
    );
    expect(container.textContent).not.toContain("Restart accepted.");
  });

  it("clears a transient restart polling error after a successful refresh", async () => {
    vi.useFakeTimers();
    companionApi.getCompanionRuntime
      .mockRejectedValueOnce(new Error("Network unavailable."))
      .mockResolvedValueOnce(companion("owner", "running"));
    const { container } = await mount(companion("owner", "running"));

    await confirmRestart(container);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Restart status could not be refreshed: Network unavailable.",
    );

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.textContent).toContain("Restart completed.");
  });

  it("keeps an accepted deletion visible until permanent Box deletion is confirmed", async () => {
    const deleting = companion("owner", "running");
    deleting.runtime = {
      ...deleting.runtime,
      state: "stopping",
      lifecycle_intent: "delete",
    };
    companionApi.getCompanionRuntime.mockResolvedValue(deleting);
    const { container, onDeleted } = await mount(companion("owner", "running"));

    await click(button(container, "Delete Companion"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("permanently deleted");
    await click(button(dialog, "Delete Companion"));

    expect(companionApi.deleteCompanion).toHaveBeenCalledWith(
      "org-1",
      companionId,
      expect.stringMatching(UUID),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Deletion accepted.");
    expect(button(container, "Deletion requested").disabled).toBe(true);
  });

  it("reuses the delete id after a lost response without inventing completion", async () => {
    companionApi.deleteCompanion
      .mockRejectedValueOnce(new ApiFetchError("Request timed out.", 408))
      .mockResolvedValueOnce(deleteAccepted);
    const { container } = await mount(companion("owner", "running"));

    await click(button(container, "Delete Companion"));
    await click(button(document.querySelector<HTMLElement>('[role="dialog"]')!, "Delete Companion"));
    await click(button(container, "Delete Companion"));
    await click(button(document.querySelector<HTMLElement>('[role="dialog"]')!, "Delete Companion"));

    expect(companionApi.deleteCompanion.mock.calls[1]?.[2]).toBe(
      companionApi.deleteCompanion.mock.calls[0]?.[2],
    );
    expect(container.textContent).toContain("Deletion accepted.");
  });

  it("clears a transient deletion polling error after a successful refresh", async () => {
    vi.useFakeTimers();
    companionApi.getCompanionRuntime
      .mockRejectedValueOnce(new Error("Network unavailable."))
      .mockResolvedValue(companion("owner", "running"));
    const { container } = await mount(companion("owner", "running"));

    await click(button(container, "Delete Companion"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(button(dialog, "Delete Companion"));
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Deletion is still queued, but its status could not be refreshed: Network unavailable.",
    );

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.textContent).toContain("Deletion accepted.");
  });

  it("replaces the local deletion acceptance when the durable operation fails", async () => {
    const failed = companion("owner", "running");
    failed.runtime = {
      ...failed.runtime,
      state: "error",
      daemon_state: "error",
      replying: false,
      lifecycle_intent: "delete",
      last_error: "The Box could not be deleted.",
    };
    companionApi.getCompanionRuntime.mockResolvedValue(failed);
    const { container } = await mount(companion("owner", "running"));

    await click(button(container, "Delete Companion"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(button(dialog, "Delete Companion"));

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "The Box could not be deleted.",
    );
    expect(container.textContent).not.toContain("Deletion accepted.");
    expect(button(container, "Retry Delete").disabled).toBe(false);
  });

  it("restores a failed deletion after reload with an actionable Retry Delete", async () => {
    const reloaded = companion("owner", "running");
    reloaded.runtime = {
      ...reloaded.runtime,
      state: "error",
      daemon_state: "error",
      replying: false,
      lifecycle_intent: "delete",
      last_error: "Deletion was interrupted before Box confirmation.",
    };

    const { container } = await mount(reloaded);

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Deletion was interrupted before Box confirmation.",
    );
    const retryDelete = button(container, "Retry Delete");
    expect(retryDelete.disabled).toBe(false);
    await click(retryDelete);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("leaves Settings only after the durable delete projection disappears", async () => {
    companionApi.getCompanionRuntime.mockRejectedValue(new ApiFetchError("Not found", 404));
    const { container, onDeleted } = await mount(companion("owner", "running"));

    await click(button(container, "Delete Companion"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(button(dialog, "Delete Companion"));

    expect(onDeleted).toHaveBeenCalledWith(companionId);
  });

  it("restores a running restart operation and its polling after reload", async () => {
    vi.useFakeTimers();
    const reloaded = companion("owner", "running");
    reloaded.runtime = {
      ...reloaded.runtime,
      state: "provisioning",
      lifecycle_intent: "recycle_pi",
    };
    companionApi.getCompanionRuntime.mockResolvedValue(reloaded);

    const { container } = await mount(reloaded);
    expect(container.textContent).toContain("Restart is in progress");
    expect(button(container, "Restart queued...").disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(companionApi.getCompanionRuntime).toHaveBeenCalled();
  });

  it("restores an archive lifecycle and its polling after reload", async () => {
    vi.useFakeTimers();
    const reloaded = companion("owner", "running");
    reloaded.runtime = {
      ...reloaded.runtime,
      state: "stopping",
      lifecycle_intent: "archive",
    };
    companionApi.getCompanionRuntime.mockResolvedValue(reloaded);

    await mount(reloaded);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(companionApi.getCompanionRuntime).toHaveBeenCalled();
  });

  it("restores deletion polling and disabled controls after reload", async () => {
    const reloaded = companion("owner", "running");
    reloaded.runtime = {
      ...reloaded.runtime,
      state: "stopping",
      lifecycle_intent: "delete",
    };
    companionApi.getCompanionRuntime.mockResolvedValue(reloaded);

    const { container } = await mount(reloaded);
    expect(container.textContent).toContain("Deletion is in progress");
    expect(button(container, "Deletion requested").disabled).toBe(true);
    expect(companionApi.getCompanionRuntime).toHaveBeenCalled();
  });
});
