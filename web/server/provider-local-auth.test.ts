import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyLocalCliAuth } from "./provider-local-auth.js";

function stream(text: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("verifyLocalCliAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a real Claude CLI command for local auth verification", async () => {
    const spawn = vi.fn(() => ({
      exited: Promise.resolve(0),
      stdout: stream("OK"),
      stderr: stream(""),
      kill: vi.fn(),
    }));
    vi.stubGlobal("Bun", { spawn });

    await expect(verifyLocalCliAuth("claude")).resolves.toEqual({ valid: true });
    expect(spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p"]),
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("runs a real Codex CLI command for local auth verification", async () => {
    const spawn = vi.fn(() => ({
      exited: Promise.resolve(0),
      stdout: stream("OK"),
      stderr: stream(""),
      kill: vi.fn(),
    }));
    vi.stubGlobal("Bun", { spawn });

    await expect(verifyLocalCliAuth("codex")).resolves.toEqual({ valid: true });
    expect(spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["codex", "exec"]),
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
    );
    const [command] = spawn.mock.calls[0] as unknown as [string[]];
    expect(command).not.toContain("--ask-for-approval");
  });

  it("returns a redacted CLI error when local auth fails", async () => {
    const spawn = vi.fn(() => ({
      exited: Promise.resolve(1),
      stdout: stream(""),
      stderr: stream("invalid sk-ant-secret-token"),
      kill: vi.fn(),
    }));
    vi.stubGlobal("Bun", { spawn });

    await expect(verifyLocalCliAuth("claude")).resolves.toEqual({
      valid: false,
      error: "invalid sk-***",
    });
  });
});
