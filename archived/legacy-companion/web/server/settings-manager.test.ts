import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSettings,
  updateSettings,
  _resetForTest,
  DEFAULT_ANTHROPIC_MODEL,
} from "./settings-manager.js";

let tempDir: string;
let settingsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "settings-manager-test-"));
  settingsPath = join(tempDir, "settings.json");
  _resetForTest(settingsPath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("settings-manager", () => {
  it("returns defaults when file is missing", () => {
    expect(getSettings()).toEqual({
      anthropicApiKey: "",
      anthropicModel: DEFAULT_ANTHROPIC_MODEL,
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

  it("updates and persists settings", () => {
    const updated = updateSettings({ anthropicApiKey: "sk-ant-key" });
    expect(updated.anthropicApiKey).toBe("sk-ant-key");
    expect(updated.anthropicModel).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(updated.linearApiKey).toBe("");
    expect(updated.updatedAt).toBeGreaterThan(0);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.anthropicApiKey).toBe("sk-ant-key");
    expect(saved.anthropicModel).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(saved.linearApiKey).toBe("");
  });

  it("loads existing settings from disk", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        anthropicApiKey: "existing",
        anthropicModel: "claude-haiku-3",
        linearApiKey: "lin_api_abc",
        updatedAt: 123,
      }),
      "utf-8",
    );

    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      anthropicApiKey: "existing",
      anthropicModel: "claude-haiku-3",
      linearApiKey: "lin_api_abc",
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
      updatedAt: 123,
    });
  });

  it("falls back to defaults for invalid JSON", () => {
    writeFileSync(settingsPath, "not-json", "utf-8");
    _resetForTest(settingsPath);

    expect(getSettings().anthropicModel).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  // Migration: existing users with the old dot-form model ID should be auto-corrected
  it("migrates persisted claude-sonnet-4.6 (dot) to claude-sonnet-4-6 (hyphen)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        anthropicApiKey: "sk-ant-existing",
        anthropicModel: "claude-sonnet-4.6",
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    const settings = getSettings();
    expect(settings.anthropicModel).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(settings.anthropicApiKey).toBe("sk-ant-existing");
  });

  it("updates only model while preserving existing key", () => {
    updateSettings({ anthropicApiKey: "sk-ant-key" });
    const updated = updateSettings({ anthropicModel: "claude-haiku-3" });

    expect(updated.anthropicApiKey).toBe("sk-ant-key");
    expect(updated.anthropicModel).toBe("claude-haiku-3");
    expect(updated.linearApiKey).toBe("");
  });

  it("uses default model when empty model is provided", () => {
    const updated = updateSettings({ anthropicModel: "" });
    expect(updated.anthropicModel).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("normalizes malformed file shape to defaults", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        anthropicApiKey: 123,
        anthropicModel: null,
        linearApiKey: 123,
        updatedAt: "x",
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      anthropicApiKey: "",
      anthropicModel: DEFAULT_ANTHROPIC_MODEL,
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

  it("updates linear key without touching anthropic settings", () => {
    updateSettings({ anthropicApiKey: "sk-ant-key", anthropicModel: "claude-sonnet-4-6" });
    const updated = updateSettings({ linearApiKey: "lin_api_123" });

    expect(updated.anthropicApiKey).toBe("sk-ant-key");
    expect(updated.anthropicModel).toBe("claude-sonnet-4-6");
    expect(updated.linearApiKey).toBe("lin_api_123");
  });

  it("ignores undefined patch values and preserves existing keys", () => {
    updateSettings({ anthropicApiKey: "sk-ant-key", linearApiKey: "lin_api_123" });
    const updated = updateSettings({
      anthropicApiKey: undefined,
      anthropicModel: "claude-haiku-3",
      linearApiKey: undefined,
    });

    expect(updated.anthropicApiKey).toBe("sk-ant-key");
    expect(updated.anthropicModel).toBe("claude-haiku-3");
    expect(updated.linearApiKey).toBe("lin_api_123");
  });

  it("updates updateChannel to prerelease", () => {
    const updated = updateSettings({ updateChannel: "prerelease" });
    expect(updated.updateChannel).toBe("prerelease");
  });

  it("defaults updateChannel to stable for invalid values", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ updateChannel: "invalid" }),
      "utf-8",
    );
    _resetForTest(settingsPath);
    expect(getSettings().updateChannel).toBe("stable");
  });

  it("preserves updateChannel when updating other settings", () => {
    updateSettings({ updateChannel: "prerelease" });
    const updated = updateSettings({ anthropicModel: "claude-haiku-3" });
    expect(updated.updateChannel).toBe("prerelease");
  });

  // ─── publicUrl tests ────────────────────────────────────────────────────────

  // Default settings include publicUrl as empty string
  it("default settings include publicUrl as empty string", () => {
    expect(getSettings().publicUrl).toBe("");
  });

  // updateSettings saves publicUrl when a valid URL is provided
  it("saves publicUrl via updateSettings", () => {
    const updated = updateSettings({ publicUrl: "https://example.com" });
    expect(updated.publicUrl).toBe("https://example.com");

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.publicUrl).toBe("https://example.com");
  });

  // updateSettings strips trailing slashes from publicUrl
  it("strips trailing slashes from publicUrl", () => {
    const updated = updateSettings({ publicUrl: "https://example.com///" });
    expect(updated.publicUrl).toBe("https://example.com");
  });

  // Missing publicUrl in raw JSON on disk normalizes to empty string
  it("normalizes missing publicUrl in raw JSON to empty string", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        anthropicApiKey: "key",
        anthropicModel: "claude-sonnet-4-6",
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getSettings().publicUrl).toBe("");
  });

  // Updating other settings preserves an existing publicUrl value
  it("preserves publicUrl when updating other settings", () => {
    updateSettings({ publicUrl: "https://example.com" });
    const updated = updateSettings({ anthropicModel: "claude-haiku-3" });
    expect(updated.publicUrl).toBe("https://example.com");
  });
});
