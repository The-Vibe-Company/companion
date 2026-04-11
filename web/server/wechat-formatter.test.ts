// Tests for wechat-formatter.ts — tool call display, permission formatting,
// Markdown conversion, WeChat message splitting, and turn-level tool summaries.
import { describe, it, expect } from "vitest";
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary, formatToolCallFailure, formatAskUserQuestion, formatSystemEvent, formatStatusChange, formatAuthStatus, formatToolProgress, formatPermissionAutoResolved, formatSessionPhase, formatPromptSuggestions, formatRateLimitEvent, formatToolResultPreview } from "./wechat-formatter.js";

// ── formatToolCall ─────────────────────────────────────────────────────────

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

  // TodoWrite, TaskList, etc. are suppressed because they are internal bookkeeping
  // tools that would add noise to the WeChat conversation.
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

  // MCP tools (e.g. mcp__context7__resolve-library-id) now have dedicated formatting
  // instead of falling through to the generic JSON.stringify formatter.
  it("handles MCP context7 resolve with dedicated format", () => {
    const result = formatToolCall("mcp__context7__resolve-library-id", { query: "react" });
    expect(result).toContain("📚 查找库: react");
  });

  // Regression: extractToolUses used to truncate JSON.stringify(input) to 200 chars,
  // which cut off file_path when content was large. Now input is passed as object.
  it("formats Write tool with large content — file_path still visible", () => {
    const result = formatToolCall("Write", {
      file_path: "src/components/VeryLongComponentName.tsx",
      content: "x".repeat(5000),
    });
    expect(result).toBe("✏️ 写入: src/components/VeryLongComponentName.tsx");
  });

  it("formats Edit tool with large old_string — file_path still visible", () => {
    const result = formatToolCall("Edit", {
      file_path: "package.json",
      old_string: "x".repeat(5000),
      new_string: "y".repeat(5000),
    });
    expect(result).toBe("📝 编辑: package.json");
  });
});

// ── formatPermissionRequest ────────────────────────────────────────────────

describe("formatPermissionRequest", () => {
  it("formats Bash permission — shows command", () => {
    const result = formatPermissionRequest("Bash", { command: "rm -rf /tmp/old_logs" });
    expect(result).toContain("执行命令:");
    expect(result).toContain("rm -rf /tmp/old_logs");
    expect(result).toContain("/y 批准");
    expect(result).toContain("/n 拒绝");
  });

  it("formats Write permission — shows file_path and content preview", () => {
    const result = formatPermissionRequest("Write", {
      file_path: "src/app.ts",
      content: "export function hello() { return 42; }",
    });
    expect(result).toContain("写入文件: src/app.ts");
    expect(result).toContain("内容预览:");
    expect(result).toContain("export function hello()");
  });

  it("formats Edit permission — shows file_path and replacement", () => {
    const result = formatPermissionRequest("Edit", {
      file_path: "package.json",
      old_string: "version: 1.0.0",
      new_string: "version: 2.0.0",
    });
    expect(result).toContain("编辑文件: package.json");
    expect(result).toContain("替换:");
    expect(result).toContain("version: 1.0.0");
    expect(result).toContain("→");
    expect(result).toContain("version: 2.0.0");
  });

  it("formats Agent permission — shows description", () => {
    const result = formatPermissionRequest("Agent", {
      description: "探索 src 目录下的代码结构",
    });
    expect(result).toContain("子任务: 探索 src 目录下的代码结构");
  });

  it("formats unknown tool — shows tool name and description or input", () => {
    const result = formatPermissionRequest("CustomTool", { action: "do thing" }, "A custom tool");
    expect(result).toContain("CustomTool");
    expect(result).toContain("A custom tool");
  });

  it("formats unknown tool without description — falls back to input", () => {
    const result = formatPermissionRequest("CustomTool", { key: "value" });
    expect(result).toContain("CustomTool");
    expect(result).toContain("key");
  });

  it("always includes approval instructions", () => {
    const result = formatPermissionRequest("Bash", { command: "ls" });
    expect(result).toContain("/y 批准");
    expect(result).toContain("/n 拒绝");
  });
});

// ── splitForWeChat ─────────────────────────────────────────────────────────

describe("splitForWeChat", () => {
  it("returns single chunk for short text", () => {
    const result = splitForWeChat("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("splits at paragraph boundary", () => {
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const text = `${para1}\n\n${para2}`;
    const result = splitForWeChat(text);
    expect(result.length).toBe(2);
    // Should split at paragraph boundary and add page indicators
    expect(result[0]).toContain(para1);
    expect(result[1]).toContain(para2);
    expect(result[0]).toMatch(/\[1\/2\]/);
    expect(result[1]).toMatch(/\[2\/2\]/);
  });

  it("adds page indicators when splitting into multiple messages", () => {
    const para1 = "a".repeat(3000);
    const para2 = "b".repeat(3000);
    const text = `${para1}\n\n${para2}`;
    const result = splitForWeChat(text);
    expect(result.length).toBe(2);
    expect(result[0]).toMatch(/\[1\/2\]/);
    expect(result[1]).toMatch(/\[2\/2\]/);
  });

  it("does not add page indicators for single chunk", () => {
    const result = splitForWeChat("Short message");
    expect(result[0]).not.toContain("[1/1]");
  });

  // Code blocks must never be split mid-way — splitting inside ``` would produce
  // broken formatting in WeChat. The splitter backs up to before the code block.
  it("does not split inside code blocks", () => {
    const code = "```js\n" + "x".repeat(3990) + "\n```";
    const prefix = "a".repeat(50);
    const text = `${prefix}\n\n${code}`;
    const result = splitForWeChat(text);
    // The code block should not be split — it should stay together
    for (const chunk of result) {
      if (chunk.includes("```js")) {
        // Must also contain the closing ```
        expect(chunk.includes("```")).toBe(true);
      }
    }
  });

  // Tiny trailing chunks (< 200 chars) are merged into the previous chunk to
  // avoid sending a near-empty second message with a page indicator.
  it("merges small trailing chunks (< 200 chars) with previous", () => {
    const para1 = "a".repeat(3000);
    const para2 = "short";
    const text = `${para1}\n\n${para2}`;
    const result = splitForWeChat(text);
    // The short para2 should be merged with para1
    expect(result.length).toBe(1);
  });

  it("falls back to newline boundary when no paragraph break", () => {
    const line1 = "a".repeat(3000);
    const line2 = "b".repeat(3000);
    const text = `${line1}\n${line2}`;
    const result = splitForWeChat(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  // When no paragraph or newline boundaries exist (e.g. a very long single word),
  // the splitter falls back to a hard cut at the character limit.
  it("handles hard split when no boundaries available", () => {
    const text = "a".repeat(8000);
    const result = splitForWeChat(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4010); // 4000 + page indicator overhead
    }
  });

  // Empty input should produce no chunks — nothing to send to WeChat.
  it("handles empty string", () => {
    expect(splitForWeChat("")).toEqual([]);
  });
});

// ── formatMarkdown ─────────────────────────────────────────────────────────

describe("formatMarkdown", () => {
  it("converts fenced code blocks to indented blocks", () => {
    const input = "```typescript\nconsole.log('hi');\n```";
    const result = formatMarkdown(input);
    expect(result).toBe("  │ console.log('hi');");
  });

  it("converts # headings to bracket format", () => {
    expect(formatMarkdown("# Title")).toBe("【Title】");
  });

  it("converts ## headings to line format", () => {
    expect(formatMarkdown("## Section")).toBe("━━ Section ━━");
  });

  it("converts - list items to bullet points", () => {
    expect(formatMarkdown("- item one\n- item two")).toBe("• item one\n• item two");
  });

  it("converts blockquotes to line prefix", () => {
    expect(formatMarkdown("> some quote")).toBe("┃ some quote");
  });

  it("converts [text](url) links to text (url)", () => {
    expect(formatMarkdown("[click here](https://example.com)")).toBe("click here (https://example.com)");
  });

  it("converts horizontal rules", () => {
    expect(formatMarkdown("---")).toBe("──────────────");
  });

  it("preserves plain text", () => {
    expect(formatMarkdown("Hello world")).toBe("Hello world");
  });

  it("handles mixed markdown in one message", () => {
    const input = "# Title\n\nSome text with a [link](https://example.com).\n\n- item 1\n- item 2";
    const result = formatMarkdown(input);
    expect(result).toContain("【Title】");
    expect(result).toContain("link (https://example.com)");
    expect(result).toContain("• item 1");
    expect(result).toContain("• item 2");
  });

  // Content inside code blocks must be preserved verbatim — markdown symbols
  // like # and - are literal code, not formatting directives.
  it("preserves code block content as-is (no markdown processing inside)", () => {
    const input = "```js\n# not a heading\n- not a list\n```";
    const result = formatMarkdown(input);
    expect(result).toContain("# not a heading");
    expect(result).toContain("- not a list");
    expect(result).not.toContain("【not a heading】");
  });

  it("handles multiple code blocks", () => {
    const input = "```js\ncode1\n```\n\ntext\n\n```js\ncode2\n```";
    const result = formatMarkdown(input);
    expect(result).toContain("  │ code1");
    expect(result).toContain("  │ code2");
    expect(result).toContain("text");
  });

  it("handles empty string", () => {
    expect(formatMarkdown("")).toBe("");
  });

  // Defensive: upstream may pass null/undefined if the CLI emits an empty field.
  it("handles undefined/null gracefully", () => {
    expect(formatMarkdown(null as unknown as string)).toBe("");
  });
});

// ── formatToolSummary ──────────────────────────────────────────────────────

// formatToolSummary produces a one-line Chinese summary of tool activity per
// turn (e.g. "本轮: 读取 3 个文件 · 编辑 1 个文件"). It suppresses internal
// bookkeeping tools and skips the summary entirely when only 1-2 safe tools
// ran (too noisy for the user).
describe("formatToolSummary", () => {
  it("formats single tool type", () => {
    const tools = [
      { name: "Read", input: { file_path: "a.ts" } },
      { name: "Read", input: { file_path: "b.ts" } },
      { name: "Read", input: { file_path: "c.ts" } },
    ];
    const result = formatToolSummary(tools);
    expect(result).toBe("📊 本轮: 读取 3 个文件");
  });

  it("formats multiple tool types with separator", () => {
    const tools = [
      { name: "Read", input: { file_path: "a.ts" } },
      { name: "Read", input: { file_path: "b.ts" } },
      { name: "Read", input: { file_path: "c.ts" } },
      { name: "Edit", input: { file_path: "d.ts" } },
      { name: "Bash", input: { command: "npm test" } },
    ];
    const result = formatToolSummary(tools);
    expect(result).toBe("📊 本轮: 读取 3 个文件 · 编辑 1 个文件 · 运行 1 个命令");
  });

  it("returns empty string for empty array", () => {
    expect(formatToolSummary([])).toBe("");
  });

  it("returns empty string for only suppressed tools (TodoWrite)", () => {
    const tools = [
      { name: "TodoWrite", input: { todos: [] } },
    ];
    expect(formatToolSummary(tools)).toBe("");
  });

  it("groups unknown tools as 执行 N 个操作", () => {
    const tools = [
      { name: "CustomTool1", input: {} },
      { name: "CustomTool2", input: {} },
    ];
    const result = formatToolSummary(tools);
    expect(result).toContain("执行 2 个操作");
  });

  it("filters out suppressed tools from summary", () => {
    const tools = [
      { name: "Read", input: { file_path: "a.ts" } },
      { name: "TodoWrite", input: { todos: [] } },
      { name: "Read", input: { file_path: "b.ts" } },
      { name: "Read", input: { file_path: "c.ts" } },
    ];
    const result = formatToolSummary(tools);
    expect(result).toBe("📊 本轮: 读取 3 个文件");
  });

  it("skips summary for 1-2 safe-only tools (auto-approved, too noisy)", () => {
    const tools = [
      { name: "Read", input: { file_path: "a.ts" } },
    ];
    expect(formatToolSummary(tools)).toBe("");

    const twoSafe = [
      { name: "Read", input: { file_path: "a.ts" } },
      { name: "Glob", input: { pattern: "*.ts" } },
    ];
    expect(formatToolSummary(twoSafe)).toBe("");
  });

  it("shows summary for 3+ safe tools", () => {
    const tools = [
      { name: "Read", input: { file_path: "a.ts" } },
      { name: "Read", input: { file_path: "b.ts" } },
      { name: "Read", input: { file_path: "c.ts" } },
    ];
    const result = formatToolSummary(tools);
    expect(result).toBe("📊 本轮: 读取 3 个文件");
  });

  it("shows summary for any count of non-safe tools", () => {
    const tools = [
      { name: "Edit", input: { file_path: "a.ts" } },
    ];
    const result = formatToolSummary(tools);
    expect(result).toBe("📊 本轮: 编辑 1 个文件");
  });
});

// ── formatToolCallFailure ─────────────────────────────────────────────────

describe("formatToolCallFailure", () => {
  it("formats a tool failure with truncated content", () => {
    const result = formatToolCallFailure("Bash", "Error: command failed with exit code 1");
    expect(result).toBe("❌ 失败: Bash\nError: command failed with exit code 1");
  });

  it("truncates long error content to 300 chars", () => {
    const longError = "x".repeat(500);
    const result = formatToolCallFailure("Bash", longError);
    expect(result.length).toBeLessThan(350);
    expect(result).toContain("❌ 失败: Bash\n");
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles empty content", () => {
    const result = formatToolCallFailure("Bash", "");
    expect(result).toBe("❌ 失败: Bash\n");
  });
});

// ── formatAskUserQuestion ──────────────────────────────────────────────────

describe("formatAskUserQuestion", () => {
  it("formats single question with options", () => {
    const input = {
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          options: [
            { label: "Option A", description: "Faster" },
            { label: "Option B", description: "Safer" },
          ],
          multiSelect: false,
        },
      ],
    };
    const result = formatAskUserQuestion(input);
    expect(result).toContain("❓ Which approach?");
    expect(result).toContain("1. Option A");
    expect(result).toContain("   Faster");
    expect(result).toContain("2. Option B");
    expect(result).toContain("   Safer");
    expect(result).toContain("回复序号选择");
  });

  it("formats question without descriptions", () => {
    const input = {
      questions: [
        {
          question: "Confirm?",
          header: "Confirm",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
          multiSelect: false,
        },
      ],
    };
    const result = formatAskUserQuestion(input);
    expect(result).toContain("1. Yes");
    expect(result).toContain("2. No");
  });

  it("handles empty questions gracefully", () => {
    const result = formatAskUserQuestion({ questions: [] });
    expect(result).toBe("");
  });

  it("handles missing questions field", () => {
    const result = formatAskUserQuestion({});
    expect(result).toBe("");
  });

  it("includes Other option for free-text answers", () => {
    const input = {
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "desc" }],
          multiSelect: false,
        },
      ],
    };
    const result = formatAskUserQuestion(input);
    expect(result).toMatch(/\d+\.\s+其他/);
  });
});

// ── formatSystemEvent ───────────────────────────────────────────────────────

// formatSystemEvent converts CLI system events to WeChat-friendly messages.
// Only task_notification, files_persisted, hook_started, and hook_response
// produce visible output. hook_progress and compact_boundary are suppressed.
describe("formatSystemEvent", () => {
  // task_notification uses `summary` (from CLITaskNotificationMessage) and `status`
  // (completed/failed/stopped) — not processName/command/exitCode which don't exist
  it("formats task_notification with completed status", () => {
    const result = formatSystemEvent({ subtype: "task_notification", summary: "npm test", status: "completed" });
    expect(result).toBe("🔔 后台任务完成: npm test");
  });

  it("formats task_notification with no status (defaults to success)", () => {
    const result = formatSystemEvent({ subtype: "task_notification", summary: "npm test" });
    expect(result).toBe("🔔 后台任务完成: npm test");
  });

  it("formats task_notification with failed status", () => {
    const result = formatSystemEvent({ subtype: "task_notification", summary: "npm test", status: "failed" });
    expect(result).toBe("❌ 后台任务失败: npm test");
  });

  it("formats task_notification with task_id fallback when no summary", () => {
    const result = formatSystemEvent({ subtype: "task_notification", task_id: "task-123", status: "completed" });
    expect(result).toBe("🔔 后台任务完成: task-123");
  });

  it("formats task_notification with stopped status (treated as success)", () => {
    const result = formatSystemEvent({ subtype: "task_notification", summary: "build.sh", status: "stopped" });
    expect(result).toBe("🔔 后台任务完成: build.sh");
  });

  // files_persisted uses `{ filename, file_id }[]` objects, not string[]
  it("formats files_persisted with file list", () => {
    const result = formatSystemEvent({
      subtype: "files_persisted",
      files: [{ filename: "src/app.ts", file_id: "abc" }, { filename: "src/index.ts", file_id: "def" }],
    });
    expect(result).toBe("💾 文件已保存: src/app.ts, src/index.ts");
  });

  it("formats files_persisted with many files (truncated)", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"].map((f, i) => ({ filename: f, file_id: String(i) }));
    const result = formatSystemEvent({ subtype: "files_persisted", files });
    expect(result).toContain("等6个文件");
  });

  it("formats files_persisted with no files", () => {
    const result = formatSystemEvent({ subtype: "files_persisted", files: [] });
    expect(result).toBe("💾 文件已保存");
  });

  // hook events use snake_case fields (hook_name, exit_code) matching CLIHookStartedMessage
  it("formats hook_started", () => {
    const result = formatSystemEvent({ subtype: "hook_started", hook_name: "pre-commit" });
    expect(result).toBe("🪝 Hook 开始: pre-commit");
  });

  it("formats hook_response with success", () => {
    const result = formatSystemEvent({ subtype: "hook_response", hook_name: "pre-commit", exit_code: 0 });
    expect(result).toBe("🪝 Hook 完成: pre-commit");
  });

  it("formats hook_response with failure", () => {
    const result = formatSystemEvent({ subtype: "hook_response", hook_name: "pre-commit", exit_code: 1 });
    expect(result).toBe("🪝 Hook 失败: pre-commit (exit: 1)");
  });

  it("returns empty for suppressed hook_progress", () => {
    const result = formatSystemEvent({ subtype: "hook_progress" });
    expect(result).toBe("");
  });

  it("returns empty for compact_boundary", () => {
    const result = formatSystemEvent({ subtype: "compact_boundary" });
    expect(result).toBe("");
  });

  it("returns empty for unknown subtypes", () => {
    const result = formatSystemEvent({ subtype: "unknown_event" });
    expect(result).toBe("");
  });
});

// ── formatStatusChange ──────────────────────────────────────────────────────

// formatStatusChange notifies WeChat users when the CLI enters "compacting"
// state (context window compression). Other statuses are silent.
describe("formatStatusChange", () => {
  it("formats compacting status", () => {
    const result = formatStatusChange("compacting");
    expect(result).toBe("🔄 正在压缩上下文，请稍候...");
  });

  it("returns empty for idle status", () => {
    expect(formatStatusChange("idle")).toBe("");
  });

  it("returns empty for running status", () => {
    expect(formatStatusChange("running")).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(formatStatusChange("")).toBe("");
  });
});

// ── formatAuthStatus ────────────────────────────────────────────────────────

// formatAuthStatus extracts error messages from auth_status events. If there
// is no error, nothing is shown (auth success is not interesting).
describe("formatAuthStatus", () => {
  it("formats auth error", () => {
    const result = formatAuthStatus({ error: "Token expired" });
    expect(result).toBe("🔐 认证错误: Token expired");
  });

  it("returns empty when no error", () => {
    const result = formatAuthStatus({ status: "ok" });
    expect(result).toBe("");
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(500);
    const result = formatAuthStatus({ error: longError });
    expect(result.length).toBeLessThan(350);
    expect(result).toContain("...");
  });
});

// ── formatToolProgress ──────────────────────────────────────────────────────

// formatToolProgress shows a running tool's elapsed time, but only for tools
// that have been running longer than minSeconds (default 30s). This avoids
// noise from fast tools.
describe("formatToolProgress", () => {
  it("formats progress for tool running > 30s", () => {
    const result = formatToolProgress("Bash", "tool-123", 45);
    expect(result).toBe("⏳ 运行 已运行 45s");
  });

  it("returns empty for tool running < 30s", () => {
    const result = formatToolProgress("Bash", "tool-123", 15);
    expect(result).toBe("");
  });

  it("returns empty for tool running exactly 30s (boundary)", () => {
    const result = formatToolProgress("Bash", "tool-123", 30);
    expect(result).toBe("⏳ 运行 已运行 30s");
  });

  it("uses custom minSeconds threshold", () => {
    const result = formatToolProgress("Bash", "tool-123", 10, 60);
    expect(result).toBe("");
  });

  it("uses known tool verb for display", () => {
    const result = formatToolProgress("Read", "tool-456", 35);
    expect(result).toBe("⏳ 读取 已运行 35s");
  });

  it("falls back to tool name for unknown tools", () => {
    const result = formatToolProgress("CustomTool", "tool-789", 40);
    expect(result).toBe("⏳ CustomTool 已运行 40s");
  });
});

// ── formatPermissionAutoResolved ────────────────────────────────────────────

// formatPermissionAutoResolved shows when the AI validator auto-approved or
// auto-denied a permission request. Includes the tool name and reason.
describe("formatPermissionAutoResolved", () => {
  it("formats auto-approve for Bash", () => {
    const result = formatPermissionAutoResolved("Bash", { command: "ls" }, "allow", "Read-only listing command");
    expect(result).toContain("🤖 AI自动批准");
    expect(result).toContain("执行: ls");
    expect(result).toContain("Read-only listing command");
  });

  it("formats auto-deny for Write", () => {
    const result = formatPermissionAutoResolved("Write", { file_path: "/etc/passwd" }, "deny", "Writing to system file");
    expect(result).toContain("🤖 AI自动拒绝");
    expect(result).toContain("写入: /etc/passwd");
    expect(result).toContain("Writing to system file");
  });

  it("uses tool name when formatToolCall returns empty (suppressed tool)", () => {
    const result = formatPermissionAutoResolved("TodoWrite", {}, "allow", "Internal tool");
    expect(result).toContain("🤖 AI自动批准");
    expect(result).toContain("TodoWrite");
  });

  it("truncates long reason", () => {
    const longReason = "x".repeat(300);
    const result = formatPermissionAutoResolved("Bash", { command: "ls" }, "allow", longReason);
    expect(result).toContain("...");
  });
});

// ── formatSessionPhase ──────────────────────────────────────────────────────

// formatSessionPhase shows messages for key phase transitions. "starting"
// always shows. "ready" only shows the first time. "terminated" is handled
// by session:exited instead.
describe("formatSessionPhase", () => {
  it("formats starting phase", () => {
    const result = formatSessionPhase("terminated", "starting", false);
    expect(result).toBe("⏳ 正在启动会话...");
  });

  it("formats first ready phase", () => {
    const result = formatSessionPhase("starting", "ready", true);
    expect(result).toBe("✅ 会话就绪");
  });

  it("returns empty for subsequent ready phases (e.g. after compacting)", () => {
    const result = formatSessionPhase("compacting", "ready", false);
    expect(result).toBe("");
  });

  it("returns empty for terminated phase (handled by session:exited)", () => {
    const result = formatSessionPhase("streaming", "terminated", false);
    expect(result).toBe("");
  });

  it("returns empty for other phases (streaming, initializing, etc.)", () => {
    expect(formatSessionPhase("ready", "streaming", false)).toBe("");
    expect(formatSessionPhase("starting", "initializing", false)).toBe("");
  });
});

// ── formatPromptSuggestions ─────────────────────────────────────────────────

// formatPromptSuggestions shows up to 3 next-turn prompt suggestions.
describe("formatPromptSuggestions", () => {
  it("formats up to 3 suggestions", () => {
    const result = formatPromptSuggestions(["Run tests", "Check coverage", "Deploy"]);
    expect(result).toContain("💡 你可以问:");
    expect(result).toContain("1. Run tests");
    expect(result).toContain("2. Check coverage");
    expect(result).toContain("3. Deploy");
  });

  it("truncates to 3 suggestions even if more provided", () => {
    const result = formatPromptSuggestions(["A", "B", "C", "D", "E"]);
    expect(result).toContain("1. A");
    expect(result).toContain("2. B");
    expect(result).toContain("3. C");
    expect(result).not.toContain("4. D");
  });

  it("returns empty for empty array", () => {
    expect(formatPromptSuggestions([])).toBe("");
  });

  it("truncates long suggestions", () => {
    const longSuggestion = "x".repeat(200);
    const result = formatPromptSuggestions([longSuggestion]);
    expect(result).toContain("...");
  });
});

// ── MCP tool formatting ────────────────────────────────────────────────────
//
// Known MCP tools get human-readable labels instead of raw JSON dumps.

describe("formatToolCall — MCP tools", () => {
  it("formats context7 resolve-library-id", () => {
    const result = formatToolCall("mcp__context7__resolve-library-id", { libraryName: "react", query: "react" });
    expect(result).toBe("📚 查找库: react");
  });

  it("formats context7 query-docs", () => {
    const result = formatToolCall("mcp__context7__query-docs", { query: "how to use hooks" });
    expect(result).toBe("📚 查询文档: how to use hooks");
  });

  it("formats puppeteer navigate", () => {
    const result = formatToolCall("mcp__puppeteer__puppeteer_navigate", { url: "https://example.com" });
    expect(result).toBe("🌐 打开页面: https://example.com");
  });

  it("formats puppeteer screenshot", () => {
    const result = formatToolCall("mcp__puppeteer__puppeteer_screenshot", { name: "homepage" });
    expect(result).toBe("📸 截图: homepage");
  });

  it("formats puppeteer click", () => {
    const result = formatToolCall("mcp__puppeteer__puppeteer_click", { selector: "#btn" });
    expect(result).toBe("👆 点击: #btn");
  });

  it("formats puppeteer fill", () => {
    const result = formatToolCall("mcp__puppeteer__puppeteer_fill", { selector: "input[name=q]", value: "test" });
    expect(result).toBe("⌨️ 填写: input[name=q]");
  });

  it("formats puppeteer evaluate generically", () => {
    const result = formatToolCall("mcp__puppeteer__puppeteer_evaluate", { script: "1+1" });
    expect(result).toBe("🌐 浏览器: evaluate");
  });

  it("formats sentry issue lookup", () => {
    const result = formatToolCall("mcp__sentry__get_sentry_issue", { issue_id_or_url: "PROJ-123" });
    expect(result).toBe("🐛 Sentry: PROJ-123");
  });

  it("suppresses sequential thinking (internal)", () => {
    const result = formatToolCall("mcp__sequential-thinking__sequentialthinking", { thought: "hmm" });
    expect(result).toBe("");
  });

  it("formats web reader", () => {
    const result = formatToolCall("mcp__web_reader__webReader", { url: "https://example.com" });
    expect(result).toBe("🌐 读取网页: https://example.com");
  });

  it("falls back to generic for unknown MCP tools", () => {
    const result = formatToolCall("mcp__unknown__some_tool", { key: "val" });
    expect(result).toContain("mcp__unknown__some_tool");
    expect(result).toContain("key");
  });
});

// ── formatRateLimitEvent ────────────────────────────────────────────────────

// formatRateLimitEvent shows rate limit errors with optional retry hint.
describe("formatRateLimitEvent", () => {
  it("formats rate limit error", () => {
    const result = formatRateLimitEvent({ error: "Too many requests" });
    expect(result).toBe("⏱️ 速率限制: Too many requests");
  });

  it("includes retry hint when retry_after_ms is present", () => {
    const result = formatRateLimitEvent({ error: "Rate limited", retry_after_ms: 30000 });
    expect(result).toContain("速率限制: Rate limited");
    expect(result).toContain("等待 30s 后重试");
  });

  it("returns empty when no error", () => {
    expect(formatRateLimitEvent({ status: "ok" })).toBe("");
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(300);
    const result = formatRateLimitEvent({ error: longError });
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(250);
  });

  it("handles zero retry_after_ms", () => {
    const result = formatRateLimitEvent({ error: "Limited", retry_after_ms: 0 });
    // retry_after_ms is 0 which is falsy — no retry hint
    expect(result).toBe("⏱️ 速率限制: Limited");
  });
});

// ── formatToolResultPreview ─────────────────────────────────────────────────

// formatToolResultPreview shows a brief preview of non-error tool results.
describe("formatToolResultPreview", () => {
  it("formats tool result with known tool verb", () => {
    const result = formatToolResultPreview("Bash", "command output here");
    expect(result).toContain("📄 运行:");
    expect(result).toContain("command output here");
  });

  it("formats with generic verb for unknown tool", () => {
    const result = formatToolResultPreview("CustomTool", "some result");
    expect(result).toContain("📄 结果:");
    expect(result).toContain("some result");
  });

  it("returns empty for empty content", () => {
    expect(formatToolResultPreview("Bash", "")).toBe("");
    expect(formatToolResultPreview("Bash", "   ")).toBe("");
  });

  it("truncates long content to 150 chars", () => {
    const longContent = "x".repeat(300);
    const result = formatToolResultPreview("Bash", longContent);
    expect(result.length).toBeLessThan(180);
    expect(result).toContain("...");
  });
});
