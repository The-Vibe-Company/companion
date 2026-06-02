import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  _resetForTest,
  updateSettings,
} from "./settings-manager.js";
import { getEffectiveAiValidation } from "./ai-validation-settings.js";
import type { SessionState } from "./session-types.js";

let tempDir: string;
let settingsPath: string;

/** Minimal SessionState with only the fields needed for testing */
function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session",
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-validation-settings-test-"));
  settingsPath = join(tempDir, "settings.json");
  _resetForTest(settingsPath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("getEffectiveAiValidation", () => {
  it("returns global defaults when session fields are undefined", () => {
    // Global defaults: enabled=false, autoApprove=true, autoDeny=false
    const session = makeSessionState();
    const result = getEffectiveAiValidation(session);
    expect(result.enabled).toBe(false);
    expect(result.autoApprove).toBe(true);
    expect(result.autoDeny).toBe(false);
    expect(result.anthropicApiKey).toBe("");
  });

  it("returns global defaults when session fields are null (explicit inherit)", () => {
    const session = makeSessionState({
      aiValidationEnabled: null,
      aiValidationAutoApprove: null,
      aiValidationAutoDeny: null,
    });
    const result = getEffectiveAiValidation(session);
    expect(result.enabled).toBe(false);
    expect(result.autoApprove).toBe(true);
    expect(result.autoDeny).toBe(false);
  });

  it("session override wins over global when session fields are set", () => {
    // Set global to enabled
    updateSettings({ aiValidationEnabled: true, aiValidationAutoApprove: true, aiValidationAutoDeny: true });

    // Session overrides all three to different values
    const session = makeSessionState({
      aiValidationEnabled: false,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: false,
    });
    const result = getEffectiveAiValidation(session);
    expect(result.enabled).toBe(false);
    expect(result.autoApprove).toBe(false);
    expect(result.autoDeny).toBe(false);
  });

  it("session enabled=true overrides global enabled=false", () => {
    // Global: disabled
    const session = makeSessionState({ aiValidationEnabled: true });
    const result = getEffectiveAiValidation(session);
    expect(result.enabled).toBe(true);
  });

  it("mixed: session sets enabled, inherits autoApprove/autoDeny from global", () => {
    updateSettings({ aiValidationAutoApprove: false, aiValidationAutoDeny: false });

    const session = makeSessionState({
      aiValidationEnabled: true,
      aiValidationAutoApprove: null, // inherit global (false)
      aiValidationAutoDeny: undefined, // inherit global (false)
    });
    const result = getEffectiveAiValidation(session);
    expect(result.enabled).toBe(true);
    expect(result.autoApprove).toBe(false);
    expect(result.autoDeny).toBe(false);
  });

  it("anthropicApiKey always comes from global settings", () => {
    updateSettings({ anthropicApiKey: "sk-test-key-123" });

    const session = makeSessionState({ aiValidationEnabled: true });
    const result = getEffectiveAiValidation(session);
    expect(result.anthropicApiKey).toBe("sk-test-key-123");
  });

  it("returns empty API key when global has none, regardless of session settings", () => {
    const session = makeSessionState({ aiValidationEnabled: true });
    const result = getEffectiveAiValidation(session);
    expect(result.anthropicApiKey).toBe("");
  });
});
