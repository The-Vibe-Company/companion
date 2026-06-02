import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";

describe("hasContainerClaudeAuth", () => {
  let tempHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "claude-auth-test-"));
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

  it("returns true when auth env vars are provided", () => {
    expect(hasContainerClaudeAuth({ ANTHROPIC_API_KEY: "sk-test" })).toBe(true);
    expect(hasContainerClaudeAuth({ ANTHROPIC_AUTH_TOKEN: "tok-test" })).toBe(true);
    expect(hasContainerClaudeAuth({ CLAUDE_CODE_AUTH_TOKEN: "tok-test" })).toBe(true);
  });

  it("returns true when known auth files exist under ~/.claude", () => {
    const claudeDir = join(tempHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".credentials.json"), "{\"token\":\"x\"}");

    expect(hasContainerClaudeAuth()).toBe(true);
  });

  it("returns false when neither env nor auth files are present", () => {
    expect(hasContainerClaudeAuth()).toBe(false);
  });
});

