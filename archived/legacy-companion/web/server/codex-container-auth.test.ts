import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasContainerCodexAuth } from "./codex-container-auth.js";

describe("hasContainerCodexAuth", () => {
  let tempHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
    prevHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns true when OPENAI_API_KEY env var is provided", () => {
    expect(hasContainerCodexAuth({ OPENAI_API_KEY: "sk-test" })).toBe(true);
  });

  it("returns true when CODEX_API_KEY env var is provided", () => {
    expect(hasContainerCodexAuth({ CODEX_API_KEY: "sk-test" })).toBe(true);
  });

  it("returns true when ~/.codex/auth.json exists on host", () => {
    const codexDir = join(tempHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), '{"token":"x"}');

    expect(hasContainerCodexAuth()).toBe(true);
  });

  it("returns false when neither env vars nor auth files are present", () => {
    expect(hasContainerCodexAuth()).toBe(false);
  });

  it("returns false when only unrelated env vars are present", () => {
    // Claude auth vars should NOT satisfy Codex auth
    expect(hasContainerCodexAuth({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(false);
  });
});
