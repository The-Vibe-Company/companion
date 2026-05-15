import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./automation-ai.js", () => ({
  runAutomationAi: vi.fn(),
}));

import { generateSessionTitle } from "./auto-namer.js";
import { runAutomationAi } from "./automation-ai.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runAutomationAi).mockResolvedValue({
    ok: true,
    provider: "claude",
    model: "claude-haiku",
    text: "Fix Auth Flow",
  });
});

describe("generateSessionTitle", () => {
  it("returns parsed title from Automation AI response", async () => {
    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");
    expect(title).toBe("Fix Auth Flow");
  });

  it("returns null when Automation AI is not available", async () => {
    vi.mocked(runAutomationAi).mockResolvedValueOnce({
      ok: false,
      reason: "No verified Claude Code or Codex auth method is configured",
    });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");

    expect(title).toBeNull();
  });

  it("truncates message to 500 chars", async () => {
    await generateSessionTitle("X".repeat(1000), "claude-sonnet-4-6");

    const [prompt] = vi.mocked(runAutomationAi).mock.calls[0];
    expect(prompt).toContain("Request:");
    expect(prompt).toContain("X".repeat(500));
    expect(prompt).not.toContain("X".repeat(501));
  });

  it("passes the preferred backend to Automation AI", async () => {
    await generateSessionTitle("Fix login", "ignored", { preferredBackend: "codex" });

    expect(runAutomationAi).toHaveBeenCalledWith(
      expect.stringContaining("Generate a concise 3-5 word session title"),
      { timeoutMs: 15000, preferredBackend: "codex" },
    );
  });

  it("returns null when Automation AI fails", async () => {
    vi.mocked(runAutomationAi).mockResolvedValueOnce({
      ok: false,
      reason: "Codex automation request exited with code 1",
    });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");

    expect(title).toBeNull();
  });

  it("returns null when Automation AI throws", async () => {
    vi.mocked(runAutomationAi).mockRejectedValueOnce(new Error("network"));

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-6");

    expect(title).toBeNull();
  });

  it("strips surrounding quotes from returned title", async () => {
    vi.mocked(runAutomationAi).mockResolvedValueOnce({
      ok: true,
      provider: "claude",
      model: "claude-haiku",
      text: "\"Refactor API Layer\"",
    });

    const title = await generateSessionTitle("Refactor API", "ignored");
    expect(title).toBe("Refactor API Layer");
  });

  it("returns null for titles >= 100 chars", async () => {
    vi.mocked(runAutomationAi).mockResolvedValueOnce({
      ok: true,
      provider: "claude",
      model: "claude-haiku",
      text: "A".repeat(100),
    });

    const title = await generateSessionTitle("Do a thing", "ignored");
    expect(title).toBeNull();
  });
});
