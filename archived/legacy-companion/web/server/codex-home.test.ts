import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_COMPANION_CODEX_HOME,
  getLegacyCodexHome,
  resolveCompanionCodexHome,
  resolveCompanionCodexSessionHome,
} from "./codex-home.js";

describe("codex-home", () => {
  it("DEFAULT_COMPANION_CODEX_HOME points to ~/.companion/codex-home", () => {
    expect(DEFAULT_COMPANION_CODEX_HOME).toBe(
      join(homedir(), ".companion", "codex-home"),
    );
  });

  it("getLegacyCodexHome returns ~/.codex", () => {
    expect(getLegacyCodexHome()).toBe(join(homedir(), ".codex"));
  });

  it("resolveCompanionCodexHome returns default when no explicit path given", () => {
    expect(resolveCompanionCodexHome()).toBe(DEFAULT_COMPANION_CODEX_HOME);
  });

  it("resolveCompanionCodexHome uses explicit path when provided", () => {
    const custom = "/tmp/my-codex-home";
    expect(resolveCompanionCodexHome(custom)).toBe(custom);
  });

  // Regression: resolveCompanionCodexHome must NOT read process.env.CODEX_HOME
  // because that points to the user's global ~/.codex and would break per-session isolation.
  it("resolveCompanionCodexHome ignores process.env.CODEX_HOME", () => {
    const original = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/tmp/global-codex";
      expect(resolveCompanionCodexHome()).toBe(DEFAULT_COMPANION_CODEX_HOME);
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it("resolveCompanionCodexSessionHome appends sessionId to base", () => {
    const sessionId = "abc-123";
    expect(resolveCompanionCodexSessionHome(sessionId)).toBe(
      join(DEFAULT_COMPANION_CODEX_HOME, sessionId),
    );
  });

  it("resolveCompanionCodexSessionHome uses explicit path", () => {
    const custom = "/tmp/my-codex-home";
    const sessionId = "xyz-789";
    expect(resolveCompanionCodexSessionHome(sessionId, custom)).toBe(
      join(custom, sessionId),
    );
  });
});
