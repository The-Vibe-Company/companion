import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./settings-manager.js", () => ({
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
  getSettings: vi.fn(),
  supportsSamplingParams: (model: string) => {
    const m = model.trim().toLowerCase();
    if (m === "opus") return false;
    return !m.startsWith("claude-opus-4-7");
  },
}));

import { generateSessionTitle } from "./auto-namer.js";
import * as settingsManager from "./settings-manager.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settingsManager.getSettings).mockReturnValue({
    anthropicApiKey: "sk-ant-key",
    anthropicModel: "claude-sonnet-4-6",
    linearApiKey: "",
    linearAutoTransition: false,
    linearAutoTransitionStateId: "",
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
    linearOAuthClientId: "",
    linearOAuthClientSecret: "",
    linearOAuthWebhookSecret: "",
    linearOAuthAccessToken: "",
    linearOAuthRefreshToken: "",
    claudeCodeOAuthToken: "",
    openaiApiKey: "",
    onboardingCompleted: false,
    aiValidationEnabled: false,
    aiValidationAutoApprove: true,
    aiValidationAutoDeny: false,
    publicUrl: "",
    updateChannel: "stable",
    dockerAutoUpdate: false,
    updatedAt: 0,
  });
});

describe("generateSessionTitle", () => {
  it("returns parsed title from Anthropic response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Fix Auth Flow" }],
      }),
    });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");

    expect(title).toBe("Fix Auth Flow");
  });

  it("returns null when Anthropic key is not configured", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      anthropicApiKey: "",
      anthropicModel: "claude-sonnet-4-6",
      linearApiKey: "",
      linearAutoTransition: false,
      linearAutoTransitionStateId: "",
      linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      claudeCodeOAuthToken: "",
      openaiApiKey: "",
      onboardingCompleted: false,
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
      publicUrl: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
      updatedAt: 0,
    });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");

    expect(title).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("truncates message to 500 chars", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Short Title" }] }),
    });

    await generateSessionTitle("X".repeat(1000), "claude-sonnet-4-6");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find((m) => m.role === "user");
    expect(user?.content).toContain("Request:");
    expect(user?.content).toContain("X".repeat(500));
    expect(user?.content).not.toContain("X".repeat(501));
  });

  it("uses configured Anthropic model", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      anthropicApiKey: "sk-ant-key",
      anthropicModel: "claude-haiku-3",
      linearApiKey: "",
      linearAutoTransition: false,
      linearAutoTransitionStateId: "",
      linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      claudeCodeOAuthToken: "",
      openaiApiKey: "",
      onboardingCompleted: false,
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
      publicUrl: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
      updatedAt: 0,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Title" }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { model: string };
    expect(body.model).toBe("claude-haiku-3");
  });

  it("returns null when response is non-ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");

    expect(title).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");

    expect(title).toBeNull();
  });

  it("strips surrounding quotes from returned title", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "\"Refactor API Layer\"" }],
      }),
    });

    const title = await generateSessionTitle("Refactor API", "ignored");
    expect(title).toBe("Refactor API Layer");
  });

  it("returns null for titles >= 100 chars", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "A".repeat(100) }],
      }),
    });

    const title = await generateSessionTitle("Do a thing", "ignored");
    expect(title).toBeNull();
  });

  it("uses default model when configured model is empty", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      anthropicApiKey: "sk-ant-key",
      anthropicModel: "",
      linearApiKey: "",
      linearAutoTransition: false,
      linearAutoTransitionStateId: "",
      linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      claudeCodeOAuthToken: "",
      openaiApiKey: "",
      onboardingCompleted: false,
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
      publicUrl: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
      updatedAt: 0,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Title" }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { model: string };
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  it("calls Anthropic endpoint with x-api-key and anthropic-version headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Title" }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [url, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((req.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-key");
    expect((req.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
  });

  it("includes max_tokens in request body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Title" }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(256);
  });

  // Regression: Opus 4.7 removed `temperature`/`top_p`/`top_k` — sending any
  // of them returns 400. auto-namer hits the Anthropic API directly, so the
  // request body must omit `temperature` when the configured model is 4.7.
  it("omits temperature when model is claude-opus-4-7", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      ...vi.mocked(settingsManager.getSettings)(),
      anthropicModel: "claude-opus-4-7",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Title" }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body.model).toBe("claude-opus-4-7");
  });

  it("omits temperature when model is the 'opus' short alias", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      ...vi.mocked(settingsManager.getSettings)(),
      anthropicModel: "opus",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Title" }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
  });

  it("still sends temperature for sonnet/haiku/older opus", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      ...vi.mocked(settingsManager.getSettings)(),
      anthropicModel: "claude-sonnet-4-6",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Title" }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { temperature?: number };
    expect(body.temperature).toBe(0.2);
  });
});
