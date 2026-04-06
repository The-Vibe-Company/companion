import { describe, it, expect } from "vitest";
import { formatToolCall } from "./wechat-formatter.js";

describe("formatToolCall", () => {
  it("formats Bash tool — extracts command", () => {
    const result = formatToolCall("Bash", { command: "npm test" });
    expect(result).toBe("🔧 执行: npm test");
  });

  it("formats Read tool — extracts file_path", () => {
    const result = formatToolCall("Read", { file_path: "src/index.ts" });
    expect(result).toBe("📖 读取: src/index.ts");
  });

  it("formats Write tool — extracts file_path", () => {
    const result = formatToolCall("Write", { file_path: "src/app.ts" });
    expect(result).toBe("✏️ 写入: src/app.ts");
  });

  it("formats Edit tool — extracts file_path", () => {
    const result = formatToolCall("Edit", { file_path: "package.json" });
    expect(result).toBe("📝 编辑: package.json");
  });

  it("formats Glob tool — extracts pattern", () => {
    const result = formatToolCall("Glob", { pattern: "**/*.test.ts" });
    expect(result).toBe("🔍 搜索文件: **/*.test.ts");
  });

  it("formats Grep tool — extracts pattern from input", () => {
    const result = formatToolCall("Grep", { pattern: "parseCommand" });
    expect(result).toBe("🔍 搜索内容: parseCommand");
  });

  it("formats WebSearch tool — extracts query", () => {
    const result = formatToolCall("WebSearch", { query: "bun install guide" });
    expect(result).toBe("🌐 搜索: bun install guide");
  });

  it("formats Agent tool — extracts description or prompt", () => {
    const result = formatToolCall("Agent", { description: "探索代码库" });
    expect(result).toBe("🤖 子任务: 探索代码库");
  });

  it("formats Agent tool — falls back to prompt when no description", () => {
    const result = formatToolCall("Agent", { prompt: "Find all TODOs" });
    expect(result).toBe("🤖 子任务: Find all TODOs");
  });

  it("returns empty string for TodoWrite (suppressed)", () => {
    const result = formatToolCall("TodoWrite", { todos: [] });
    expect(result).toBe("");
  });

  it("formats unknown tools generically", () => {
    const result = formatToolCall("MyCustomTool", { action: "do something" });
    expect(result).toBe('🔧 MyCustomTool: {"action":"do something"}');
  });

  it("truncates long input to 200 chars", () => {
    const longCommand = "x".repeat(300);
    const result = formatToolCall("Bash", { command: longCommand });
    // "🔧 执行: " prefix + truncated content + "..."
    expect(result.length).toBeLessThan(220);
    expect(result).toContain("...");
  });

  it("handles empty input", () => {
    const result = formatToolCall("Bash", {});
    expect(result).toBe("🔧 执行: ");
  });

  it("handles MCP tools generically", () => {
    const result = formatToolCall("mcp__context7__resolve-library-id", { query: "react" });
    expect(result).toContain("mcp__context7__resolve-library-id");
  });
});
