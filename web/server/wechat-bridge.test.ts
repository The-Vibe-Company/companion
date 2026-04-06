// Tests for wechat-bridge.ts — command parsing, dangerous tool detection, helpers
import { describe, it, expect } from "vitest";
import { parseCommand, isDangerousTool } from "./wechat-bridge.js";

// ── parseCommand ──────────────────────────────────────────────────────────

describe("parseCommand", () => {
  it("identifies plain text messages", () => {
    const result = parseCommand("Hello, how are you?");
    expect(result).toEqual({ type: "message", text: "Hello, how are you?" });
  });

  it("parses /new command", () => {
    const result = parseCommand("/new");
    expect(result).toEqual({ type: "command", command: "new", args: "" });
  });

  it("parses /help command", () => {
    const result = parseCommand("/help");
    expect(result).toEqual({ type: "command", command: "help", args: "" });
  });

  it("parses /switch with argument", () => {
    const result = parseCommand("/switch 2");
    expect(result).toEqual({ type: "command", command: "switch", args: "2" });
  });

  it("parses /model with multi-word argument", () => {
    const result = parseCommand("/model claude-sonnet-4-6");
    expect(result).toEqual({ type: "command", command: "model", args: "claude-sonnet-4-6" });
  });

  it("handles command case-insensitively", () => {
    const result = parseCommand("/HELP");
    expect(result).toEqual({ type: "command", command: "help", args: "" });
  });

  it("handles /mode with argument", () => {
    const result = parseCommand("/mode bypassPermissions");
    expect(result).toEqual({ type: "command", command: "mode", args: "bypassPermissions" });
  });

  it("handles /allow and /deny", () => {
    expect(parseCommand("/allow")).toEqual({ type: "command", command: "allow", args: "" });
    expect(parseCommand("/deny")).toEqual({ type: "command", command: "deny", args: "" });
  });

  it("handles unknown commands", () => {
    const result = parseCommand("/foobar extra args");
    expect(result).toEqual({ type: "command", command: "foobar", args: "extra args" });
  });

  it("handles empty text", () => {
    const result = parseCommand("");
    expect(result).toEqual({ type: "message", text: "" });
  });

  it("handles text starting with space", () => {
    const result = parseCommand(" /not a command");
    expect(result).toEqual({ type: "message", text: " /not a command" });
  });

  // /new with folder name argument
  it("parses /new with folder name", () => {
    const result = parseCommand("/new test-project");
    expect(result).toEqual({ type: "command", command: "new", args: "test-project" });
  });

  // /dir command
  it("parses /dir command", () => {
    const result = parseCommand("/dir");
    expect(result).toEqual({ type: "command", command: "dir", args: "" });
  });

  it("parses /dir with path argument", () => {
    const result = parseCommand("/dir src/components");
    expect(result).toEqual({ type: "command", command: "dir", args: "src/components" });
  });

  it("parses /dir with recursive flag", () => {
    const result = parseCommand("/dir -r src");
    expect(result).toEqual({ type: "command", command: "dir", args: "-r src" });
  });
});

// ── isDangerousTool ──────────────────────────────────────────────────────

describe("isDangerousTool", () => {
  it("marks safe tools as not dangerous", () => {
    expect(isDangerousTool("Read", {})).toBe(false);
    expect(isDangerousTool("Glob", {})).toBe(false);
    expect(isDangerousTool("Grep", {})).toBe(false);
    expect(isDangerousTool("LS", {})).toBe(false);
    expect(isDangerousTool("WebSearch", {})).toBe(false);
    expect(isDangerousTool("TodoRead", {})).toBe(false);
    expect(isDangerousTool("TaskList", {})).toBe(false);
    expect(isDangerousTool("TaskGet", {})).toBe(false);
  });

  it("marks context7 tools as safe", () => {
    expect(isDangerousTool("mcp__context7__resolve-library-id", {})).toBe(false);
    expect(isDangerousTool("mcp__context7__query-docs", {})).toBe(false);
  });

  it("marks ALL Bash commands as dangerous — CLI decides permissions, not WeChat bridge", () => {
    // Even harmless-looking commands like ls, git status are marked dangerous
    // because if the CLI sent a control_request, it decided this needs approval.
    // The WeChat bridge must not second-guess the CLI's permission decision.
    expect(isDangerousTool("Bash", { command: "ls -la" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "git status" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "npm test" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "echo hello" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "rm -rf /" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "npx skills find glm" })).toBe(true);
  });

  it("marks Write as dangerous", () => {
    expect(isDangerousTool("Write", { file_path: "/tmp/test.txt" })).toBe(true);
  });

  it("marks Edit as dangerous", () => {
    expect(isDangerousTool("Edit", { file_path: "src/index.ts" })).toBe(true);
  });

  it("marks unknown tools as dangerous", () => {
    expect(isDangerousTool("SomeCustomTool", {})).toBe(true);
    expect(isDangerousTool("Agent", {})).toBe(true);
    expect(isDangerousTool("Skill", {})).toBe(true);
  });
});
