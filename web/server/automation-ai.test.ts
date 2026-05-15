import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTest, updateSettings } from "./settings-manager.js";
import { getAutomationAiModel, resolveAutomationAiProvider, runAutomationAi } from "./automation-ai.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";

vi.mock("./claude-container-auth.js", () => ({
  hasContainerClaudeAuth: vi.fn(() => false),
}));

vi.mock("./codex-container-auth.js", () => ({
  hasContainerCodexAuth: vi.fn(() => false),
}));

let tempDir: string;
const mockSpawn = vi.fn();

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "automation-ai-test-"));
  _resetForTest(join(tempDir, "settings.json"));
  vi.clearAllMocks();
  vi.mocked(hasContainerClaudeAuth).mockReturnValue(false);
  vi.mocked(hasContainerCodexAuth).mockReturnValue(false);
  mockSpawn.mockReturnValue({
    exited: Promise.resolve(0),
    stdout: streamFromText("ok"),
    stderr: streamFromText(""),
    kill: vi.fn(),
  });
  vi.stubGlobal("Bun", { spawn: mockSpawn });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("resolveAutomationAiProvider", () => {
  it("prefers Claude when Claude local auth is available", () => {
    vi.mocked(hasContainerClaudeAuth).mockReturnValue(true);
    expect(resolveAutomationAiProvider()).toBe("claude");
  });

  it("uses Codex when only Codex auth is available", () => {
    vi.mocked(hasContainerCodexAuth).mockReturnValue(true);
    expect(resolveAutomationAiProvider()).toBe("codex");
  });

  it("honors the session backend when both providers are available", () => {
    vi.mocked(hasContainerClaudeAuth).mockReturnValue(true);
    vi.mocked(hasContainerCodexAuth).mockReturnValue(true);
    expect(resolveAutomationAiProvider("codex")).toBe("codex");
    expect(resolveAutomationAiProvider("claude")).toBe("claude");
  });
});

describe("getAutomationAiModel", () => {
  it("does not reuse a Claude model for Codex", () => {
    updateSettings({ anthropicModel: "claude-sonnet-4-6" });
    expect(getAutomationAiModel("codex")).toBe("gpt-5-mini");
  });

  it("does not reuse a GPT model for Claude", () => {
    updateSettings({ anthropicModel: "gpt-5-mini" });
    expect(getAutomationAiModel("claude")).toBe("claude-sonnet-4-6");
  });
});

describe("runAutomationAi", () => {
  it("spawns Claude CLI with injected API-key auth", async () => {
    updateSettings({
      claudeAuthMethod: "apiKey",
      claudeApiKey: "sk-ant-1",
      claudeBaseUrl: "https://claude-proxy.example.com",
      anthropicModel: "claude-haiku-3",
    });

    const result = await runAutomationAi("hello", { preferredBackend: "claude" });

    expect(result).toMatchObject({ ok: true, provider: "claude", model: "claude-haiku-3", text: "ok" });
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "--model", "claude-haiku-3", "-p", "hello"]),
      expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "sk-ant-1",
          ANTHROPIC_BASE_URL: "https://claude-proxy.example.com",
        }),
      }),
    );
  });

  it("spawns Codex CLI with injected API-key auth", async () => {
    updateSettings({
      codexAuthMethod: "apiKey",
      openaiApiKey: "sk-openai-1",
      openaiBaseUrl: "https://openai-proxy.example.com/v1",
      anthropicModel: "gpt-5-mini",
    });

    const result = await runAutomationAi("hello", { preferredBackend: "codex" });

    expect(result).toMatchObject({ ok: true, provider: "codex", model: "gpt-5-mini", text: "ok" });
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["codex", "exec", "--model", "gpt-5-mini", "hello"]),
      expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_API_KEY: "sk-openai-1",
          OPENAI_BASE_URL: "https://openai-proxy.example.com/v1",
        }),
      }),
    );
  });

  it("returns a clear reason when no provider auth is available", async () => {
    const result = await runAutomationAi("hello");
    expect(result).toEqual({
      ok: false,
      reason: "No verified Claude Code or Codex auth method is configured",
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
