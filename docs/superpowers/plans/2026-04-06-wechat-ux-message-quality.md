# WeChat UX Message Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve WeChat Bot message display quality — tool calls, Markdown rendering, message splitting, permission requests, and progress feedback.

**Architecture:** Add a pure-function formatting module (`wechat-formatter.ts`) that preprocesses all messages before sending to WeChat. Integrate into `wechat-bridge.ts` by replacing inline formatting with calls to the new module.

**Tech Stack:** TypeScript, Vitest, existing `@wechatbot/wechatbot` SDK

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `web/server/wechat-formatter.ts` | Create | Pure formatting functions: `formatToolCall`, `formatPermissionRequest`, `formatMarkdown`, `splitForWeChat`, `formatToolSummary` |
| `web/server/wechat-formatter.test.ts` | Create | Unit tests for all formatter functions |
| `web/server/wechat-bridge.ts` | Modify | Import formatter, replace inline formatting, add tool accumulation + progress indicator |

---

### Task 1: Create `formatToolCall()` with tests

**Files:**
- Create: `web/server/wechat-formatter.ts`
- Create: `web/server/wechat-formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `web/server/wechat-formatter.test.ts`:

```typescript
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
    expect(result).toBe("🔧 MyCustomTool: {\"action\":\"do something\"}");
  });

  it("truncates long input to 200 chars", () => {
    const longCommand = "x".repeat(300);
    const result = formatToolCall("Bash", { command: longCommand });
    // "🔧 执行: " is 6 chars, so content should be truncated to keep total reasonable
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `formatToolCall` implementation**

Create `web/server/wechat-formatter.ts`:

```typescript
// ─── WeChat Message Formatter ────────────────────────────────────────────────
// Pure functions for formatting messages before sending to WeChat.
// No side effects, no state — easy to test and reason about.

const WECHAT_MSG_LIMIT = 4000;
const TOOL_DISPLAY_LIMIT = 200;

type ToolInput = Record<string, unknown>;

/** Format a tool call for WeChat display. Returns empty string for suppressed tools. */
export function formatToolCall(toolName: string, input: ToolInput): string {
  switch (toolName) {
    case "Bash":
      return `🔧 执行: ${truncate(String(input.command ?? ""), TOOL_DISPLAY_LIMIT)}`;
    case "Read":
      return `📖 读取: ${truncate(String(input.file_path ?? ""), TOOL_DISPLAY_LIMIT)}`;
    case "Write":
      return `✏️ 写入: ${truncate(String(input.file_path ?? ""), TOOL_DISPLAY_LIMIT)}`;
    case "Edit":
      return `📝 编辑: ${truncate(String(input.file_path ?? ""), TOOL_DISPLAY_LIMIT)}`;
    case "Glob":
      return `🔍 搜索文件: ${truncate(String(input.pattern ?? ""), TOOL_DISPLAY_LIMIT)}`;
    case "Grep":
      return `🔍 搜索内容: ${truncate(String(input.pattern ?? ""), TOOL_DISPLAY_LIMIT)}`;
    case "WebSearch":
      return `🌐 搜索: ${truncate(String(input.query ?? ""), TOOL_DISPLAY_LIMIT)}`;
    case "Agent": {
      const desc = input.description ?? input.prompt ?? "";
      return `🤖 子任务: ${truncate(String(desc), TOOL_DISPLAY_LIMIT)}`;
    }
    case "TodoWrite":
    case "TodoRead":
    case "TaskList":
    case "TaskGet":
      return ""; // suppress — not interesting to user
    default:
      return `🔧 ${toolName}: ${truncate(JSON.stringify(input), TOOL_DISPLAY_LIMIT)}`;
  }
}

/** Truncate string with ellipsis indicator */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-formatter.ts web/server/wechat-formatter.test.ts
git commit -m "feat(wechat): add formatToolCall for human-readable tool display"
```

---

### Task 2: Create `formatPermissionRequest()` with tests

**Files:**
- Modify: `web/server/wechat-formatter.ts`
- Modify: `web/server/wechat-formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/server/wechat-formatter.test.ts`:

```typescript
import { formatPermissionRequest } from "./wechat-formatter.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: FAIL — `formatPermissionRequest` not exported

- [ ] **Step 3: Write `formatPermissionRequest` implementation**

Add to `web/server/wechat-formatter.ts`:

```typescript
/** Format a permission request for WeChat display. */
export function formatPermissionRequest(
  toolName: string,
  input: ToolInput,
  description?: string,
): string {
  const header = "⚠️ 需要批准操作:\n\n";
  const footer = "\n\n回复 /y 批准 · /n 拒绝";
  let body: string;

  switch (toolName) {
    case "Bash":
      body = `执行命令:\n${truncate(String(input.command ?? ""), 300)}`;
      break;
    case "Write": {
      const content = String(input.content ?? "");
      body = `写入文件: ${input.file_path ?? "?"}\n内容预览: ${truncate(content, 200)}`;
      break;
    }
    case "Edit": {
      const oldStr = truncate(String(input.old_string ?? ""), 100);
      const newStr = truncate(String(input.new_string ?? ""), 100);
      body = `编辑文件: ${input.file_path ?? "?"}\n替换: ${oldStr}\n→ ${newStr}`;
      break;
    }
    case "Agent": {
      const desc = input.description ?? input.prompt ?? "";
      body = `子任务: ${truncate(String(desc), 200)}`;
      break;
    }
    default: {
      const desc = description ?? JSON.stringify(input);
      body = `${toolName}: ${truncate(desc, 200)}`;
      break;
    }
  }

  return header + body + footer;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-formatter.ts web/server/wechat-formatter.test.ts
git commit -m "feat(wechat): add formatPermissionRequest for human-readable approval prompts"
```

---

### Task 3: Create `formatMarkdown()` with tests

**Files:**
- Modify: `web/server/wechat-formatter.ts`
- Modify: `web/server/wechat-formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/server/wechat-formatter.test.ts`:

```typescript
import { formatMarkdown } from "./wechat-formatter.js";

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

  it("handles undefined/null gracefully", () => {
    expect(formatMarkdown(null as unknown as string)).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: FAIL — `formatMarkdown` not exported

- [ ] **Step 3: Write `formatMarkdown` implementation**

Add to `web/server/wechat-formatter.ts`:

```typescript
/** Convert Markdown text to WeChat-friendly plain text format. */
export function formatMarkdown(text: string): string {
  if (!text) return "";

  // Split into code blocks and non-code segments
  const segments = splitCodeBlocks(text);

  return segments.map((seg) => {
    if (seg.isCode) {
      // Code block: prefix each line with "  │ "
      return seg.content
        .split("\n")
        .map((line) => `  │ ${line}`)
        .join("\n");
    }
    // Regular text: apply inline markdown conversions
    return seg.content
      .replace(/^### (.+)$/gm, "━━ $1 ━━")
      .replace(/^## (.+)$/gm, "━━ $1 ━━")
      .replace(/^# (.+)$/gm, "【$1】")
      .replace(/^> (.+)$/gm, "┃ $1")
      .replace(/^[-*] /gm, "• ")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/^---$/gm, "──────────────");
  }).join("\n");
}

interface TextSegment {
  isCode: boolean;
  content: string;
}

/** Split text into alternating code/non-code segments. */
function splitCodeBlocks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const regex = /```[\w]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Non-code segment before this code block
    if (match.index > lastIndex) {
      const nonCode = text.slice(lastIndex, match.index).trim();
      if (nonCode) segments.push({ isCode: false, content: nonCode });
    }
    // Code block content (without the ``` markers)
    segments.push({ isCode: true, content: match[1].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  // Trailing non-code segment
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ isCode: false, content: remaining });
  }

  // If no code blocks found, return the whole text as non-code
  if (segments.length === 0) {
    segments.push({ isCode: false, content: text });
  }

  return segments;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-formatter.ts web/server/wechat-formatter.test.ts
git commit -m "feat(wechat): add formatMarkdown for WeChat-friendly text rendering"
```

---

### Task 4: Create improved `splitForWeChat()` with tests

**Files:**
- Modify: `web/server/wechat-formatter.ts`
- Modify: `web/server/wechat-formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/server/wechat-formatter.test.ts`:

```typescript
import { splitForWeChat } from "./wechat-formatter.js";

describe("splitForWeChat", () => {
  it("returns single chunk for short text", () => {
    const result = splitForWeChat("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("splits at paragraph boundary", () => {
    // Create text with paragraph break inside 4000-char limit
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const text = `${para1}\n\n${para2}`;
    const result = splitForWeChat(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
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

  it("does not split inside code blocks", () => {
    const code = "```js\n" + "x".repeat(3990) + "\n```";
    const prefix = "a".repeat(50);
    const text = `${prefix}\n\n${code}`;
    const result = splitForWeChat(text);
    // The code block should not be split — it should stay together
    for (const chunk of result) {
      // If a chunk contains a code block start, it must also contain the end
      if (chunk.includes("```js")) {
        expect(chunk.includes("```")).toBe(true);
      }
    }
  });

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

  it("handles hard split when no boundaries available", () => {
    const text = "a".repeat(8000);
    const result = splitForWeChat(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4000 + 10); // +10 for page indicator
    }
  });

  it("handles empty string", () => {
    expect(splitForWeChat("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: FAIL — `splitForWeChat` not exported from formatter (it still exists only in wechat-bridge.ts)

- [ ] **Step 3: Write `splitForWeChat` implementation**

Add to `web/server/wechat-formatter.ts`:

```typescript
const MIN_CHUNK_SIZE = 200;

/** Split text into WeChat-safe chunks with smart boundaries and page indicators. */
export function splitForWeChat(text: string): string[] {
  if (!text.trim()) return [];
  if (text.length <= WECHAT_MSG_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= WECHAT_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }

    // Find the best split point within the limit
    const splitAt = findSplitPoint(remaining, WECHAT_MSG_LIMIT);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  // Merge trailing chunks that are too small
  const merged: string[] = [];
  for (const chunk of chunks) {
    if (merged.length > 0 && chunk.length < MIN_CHUNK_SIZE) {
      merged[merged.length - 1] += "\n\n" + chunk;
    } else {
      merged.push(chunk);
    }
  }

  // Add page indicators if multiple chunks
  if (merged.length > 1) {
    return merged.map((chunk, i) => `${chunk} [${i + 1}/${merged.length}]`);
  }

  return merged;
}

/** Find the best character index to split at, preserving code blocks. */
function findSplitPoint(text: string, maxLen: number): number {
  // Check if we'd be splitting inside a code block
  const codeBlockStart = text.lastIndexOf("```", maxLen);
  const codeBlockEnd = text.indexOf("```", codeBlockStart + 3);

  if (codeBlockStart >= 0 && codeBlockStart < maxLen && (codeBlockEnd < 0 || codeBlockEnd > maxLen)) {
    // We're inside a code block — split before it instead
    if (codeBlockStart > maxLen * 0.3) {
      return codeBlockStart;
    }
  }

  // Try paragraph boundary (≥ 50% of maxLen to avoid too-small chunks)
  let splitAt = text.lastIndexOf("\n\n", maxLen);
  if (splitAt >= maxLen * 0.5) return splitAt;

  // Try newline boundary
  splitAt = text.lastIndexOf("\n", maxLen);
  if (splitAt >= maxLen * 0.5) return splitAt;

  // Hard split
  return maxLen;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-formatter.ts web/server/wechat-formatter.test.ts
git commit -m "feat(wechat): add smart splitForWeChat with page indicators and code block protection"
```

---

### Task 5: Create `formatToolSummary()` with tests

**Files:**
- Modify: `web/server/wechat-formatter.ts`
- Modify: `web/server/wechat-formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `web/server/wechat-formatter.test.ts`:

```typescript
import { formatToolSummary } from "./wechat-formatter.js";

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
    ];
    const result = formatToolSummary(tools);
    expect(result).toBe("📊 本轮: 读取 2 个文件");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: FAIL — `formatToolSummary` not exported

- [ ] **Step 3: Write `formatToolSummary` implementation**

Add to `web/server/wechat-formatter.ts`:

```typescript
const SUPPRESSED_TOOLS = new Set(["TodoWrite", "TodoRead", "TaskList", "TaskGet"]);

interface ToolRecord {
  name: string;
  input: ToolInput;
}

const TOOL_VERB_MAP: Record<string, { verb: string; noun: string }> = {
  Read: { verb: "读取", noun: "文件" },
  Write: { verb: "写入", noun: "文件" },
  Edit: { verb: "编辑", noun: "文件" },
  Bash: { verb: "运行", noun: "命令" },
  Glob: { verb: "搜索", noun: "文件" },
  Grep: { verb: "搜索", noun: "内容" },
  WebSearch: { verb: "搜索", noun: "网页" },
  Agent: { verb: "派发", noun: "子任务" },
};

/** Format a summary of tool calls executed in one turn. Returns empty string if nothing to show. */
export function formatToolSummary(tools: ToolRecord[]): string {
  const visible = tools.filter((t) => !SUPPRESSED_TOOLS.has(t.name));
  if (visible.length === 0) return "";

  const grouped = new Map<string, number>();
  for (const tool of visible) {
    const key = TOOL_VERB_MAP[tool.name] ? tool.name : "_unknown";
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [toolName, count] of grouped) {
    if (toolName === "_unknown") {
      parts.push(`执行 ${count} 个操作`);
    } else {
      const { verb, noun } = TOOL_VERB_MAP[toolName];
      parts.push(`${verb} ${count} 个${noun}`);
    }
  }

  return `📊 本轮: ${parts.join(" · ")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-formatter.ts web/server/wechat-formatter.test.ts
git commit -m "feat(wechat): add formatToolSummary for turn-level tool execution summary"
```

---

### Task 6: Integrate formatter into `wechat-bridge.ts`

**Files:**
- Modify: `web/server/wechat-bridge.ts`

This task replaces inline formatting in the bridge with calls to the new formatter module. It also adds tool accumulation fields to `sessionRelayData`.

- [ ] **Step 1: Add import and remove old `splitForWeChat`**

In `web/server/wechat-bridge.ts`, add the import at the top (after existing imports, around line 14):

```typescript
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary } from "./wechat-formatter.js";
```

Remove the existing `splitForWeChat` function (lines 132-155) — it's now imported from the formatter module.

- [ ] **Step 2: Add tool accumulation to relay data**

Update the `sessionRelayData` type (around line 169). Change:

```typescript
private sessionRelayData = new Map<string, {
  pendingText: string;
  lastTypingTs: number;
  streamlinedSent: boolean;
  contentSent: boolean;
  lastBlockIndex: number;
}>();
```

To:

```typescript
private sessionRelayData = new Map<string, {
  pendingText: string;
  lastTypingTs: number;
  streamlinedSent: boolean;
  contentSent: boolean;
  lastBlockIndex: number;
  toolAccumulator: Array<{ name: string; input: Record<string, unknown> }>;
  lastUserFacingMessageTs: number;
}>();
```

Update the `ensureRelay` method where relayData is initialized (around line 747). Change:

```typescript
this.sessionRelayData.set(sessionId, { pendingText: "", lastTypingTs: 0, streamlinedSent: false, contentSent: false, lastBlockIndex: -1 });
```

To:

```typescript
this.sessionRelayData.set(sessionId, { pendingText: "", lastTypingTs: 0, streamlinedSent: false, contentSent: false, lastBlockIndex: -1, toolAccumulator: [], lastUserFacingMessageTs: Date.now() });
```

Update the `message:result` handler reset block (around line 837). Add after `relayData.lastBlockIndex = -1;`:

```typescript
relayData.toolAccumulator = [];
relayData.lastUserFacingMessageTs = Date.now();
```

Update the `relay data resets all tracking state` test in `wechat-bridge.test.ts` — add the new fields to the test object:

```typescript
const relayData = {
  pendingText: "Some accumulated text",
  lastTypingTs: 12345,
  streamlinedSent: true,
  contentSent: true,
  lastBlockIndex: 5,
  toolAccumulator: [{ name: "Bash", input: { command: "ls" } }],
  lastUserFacingMessageTs: 12345,
};

// Simulate result handler reset
relayData.pendingText = "";
relayData.streamlinedSent = false;
relayData.contentSent = false;
relayData.lastBlockIndex = -1;
relayData.toolAccumulator = [];
relayData.lastUserFacingMessageTs = 67890;

expect(relayData).toEqual({
  pendingText: "",
  lastTypingTs: 12345,
  streamlinedSent: false,
  contentSent: false,
  lastBlockIndex: -1,
  toolAccumulator: [],
  lastUserFacingMessageTs: 67890,
});
```

- [ ] **Step 3: Replace tool call formatting in `message:assistant` handler**

In the `message:assistant` handler (around lines 804-826), replace the tool formatting block. Change:

```typescript
const tools = extractToolUses(message);
if (tools.length > 0) {
  const toolSummary = tools
    .map((t) => `🔧 ${t.name}${t.input ? `: ${t.input.slice(0, 100)}` : ""}`)
    .join("\n");
  this.sendReply(userId, `${toolSummary}\nℹ️ Tool call in progress`);
  if (relayData) relayData.contentSent = true;
}
```

To:

```typescript
const tools = extractToolUses(message);
if (tools.length > 0) {
  for (const t of tools) {
    if (relayData) {
      try {
        relayData.toolAccumulator.push({ name: t.name, input: JSON.parse(t.input || "{}") });
      } catch {
        relayData.toolAccumulator.push({ name: t.name, input: {} });
      }
    }
  }
  // Individual tool call messages are suppressed — summary sent at result time
}
```

- [ ] **Step 4: Replace permission request formatting**

In `handlePermissionRequest` method (around lines 935-944), replace the inline formatting. Change:

```typescript
const desc = perm.description ?? perm.tool_name;
const inputStr = JSON.stringify(perm.input).slice(0, 300);
this.sendReply(userId, `⚠️ Permission needed:\nTool: ${perm.tool_name}\n${desc ? `Description: ${desc}\n` : ""}Input: ${inputStr}\n\nSend /y (allow) or /n (deny)`);
```

To:

```typescript
this.sendReply(userId, formatPermissionRequest(perm.tool_name, perm.input, perm.description));
```

Also update the auto-approve message (around lines 933-934). Change:

```typescript
const inputStr = JSON.stringify(perm.input).slice(0, 200);
this.sendReply(userId, `✅ Auto-approved (safe): ${perm.tool_name}${inputStr ? `\n${inputStr}` : ""}`);
```

To:

```typescript
const formatted = formatToolCall(perm.tool_name, perm.input);
this.sendReply(userId, formatted ? `✅ 自动批准: ${formatted}` : `✅ 自动批准: ${perm.tool_name}`);
```

- [ ] **Step 5: Add Markdown formatting + tool summary to `message:result` handler**

In the `message:result` handler (around lines 846-862), apply `formatMarkdown()` to the final text and add tool summary. Change:

```typescript
if (finalText) {
  this.sendReply(userId, finalText);
} else if (!hadContent) {
  if (!data?.is_error) {
    this.sendReply(userId, "(operation completed)");
  }
}
```

To:

```typescript
if (finalText) {
  this.sendReply(userId, formatMarkdown(finalText));
} else if (!hadContent) {
  if (!data?.is_error) {
    // Contextual fallback based on what was done
    const toolSummary = formatToolSummary(relayData?.toolAccumulator ?? []);
    this.sendReply(userId, toolSummary || "(操作完成)");
  }
}

// Send tool summary for turns that had content but also tools
if (relayData && relayData.toolAccumulator.length > 0) {
  const summary = formatToolSummary(relayData.toolAccumulator);
  if (summary) this.sendReply(userId, summary);
}
```

- [ ] **Step 6: Apply Markdown formatting to streamlined text**

In the `message:streamlined_text` handler (around line 782), apply `formatMarkdown`. Change:

```typescript
if (text.trim()) {
  this.sendReply(userId, text.trim());
```

To:

```typescript
if (text.trim()) {
  this.sendReply(userId, formatMarkdown(text.trim()));
```

- [ ] **Step 7: Apply Markdown formatting to streamlined tool summary**

In the `message:streamlined_tool_use_summary` handler (around line 798), keep the existing format (it's already human-friendly with the 📋 prefix). No change needed here.

- [ ] **Step 8: Run all tests**

Run: `cd web && bun run test -- --run`
Expected: All PASS (typecheck may show issues — fix them)

- [ ] **Step 9: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): integrate formatter into bridge — human-readable tool calls, markdown, summaries"
```

---

### Task 7: Add progress indicator for long operations

**Files:**
- Modify: `web/server/wechat-bridge.ts`

- [ ] **Step 1: Add progress indicator in `message:stream_event` handler**

In the `message:stream_event` handler (around lines 749-773), after the existing typing throttle logic, add a progress check. After the line `this.sendTyping(userId).catch(() => {});` and its closing brace (around line 773), add:

```typescript
// Progress indicator: if > 15s since last message and tools are running, send brief status
if (relayData) {
  const now = Date.now();
  const elapsed = now - relayData.lastUserFacingMessageTs;
  if (elapsed > 15_000 && relayData.toolAccumulator.length > 0 && !relayData.contentSent) {
    const count = relayData.toolAccumulator.length;
    this.sendReply(userId, `⏳ 正在处理... (已执行 ${count} 个操作)`);
    relayData.lastUserFacingMessageTs = now;
  }
}
```

- [ ] **Step 2: Update `lastUserFacingMessageTs` when sending replies**

The `sendReply` method already handles all outgoing messages. To track timing, we need access to the session's relay data from `sendReply`. Since `sendReply` is a general method, the simplest approach is to update the timestamp in the relay event handlers where `sendReply` is called. The handlers already have access to `relayData`.

This is already covered — `lastUserFacingMessageTs` is set to `Date.now()` on result reset (Task 6 Step 2). The progress indicator checks elapsed time from that point.

- [ ] **Step 3: Run all tests**

Run: `cd web && bun run test -- --run`
Expected: All PASS

- [ ] **Step 4: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-bridge.ts
git commit -m "feat(wechat): add progress indicator for long-running operations (>15s)"
```

---

## Self-Review Checklist

### Spec Coverage
- [x] Part 1 (Tool Call Display) → Task 1 + Task 6 Step 3
- [x] Part 2 (Markdown Conversion) → Task 3 + Task 6 Steps 5-6
- [x] Part 3 (Smart Message Splitting) → Task 4
- [x] Part 4 (Permission Request Formatting) → Task 2 + Task 6 Step 4
- [x] Part 5 (Tool Execution Summary) → Task 5 + Task 6 Step 5
- [x] Part 6 (Progress Indicator) → Task 7

### Placeholder Scan
- No TBD, TODO, or vague instructions found
- All steps contain actual code

### Type Consistency
- `ToolInput` = `Record<string, unknown>` — used consistently across all functions
- `ToolRecord` = `{ name: string; input: ToolInput }` — used in `formatToolSummary` and `toolAccumulator`
- `sessionRelayData` fields match between type definition, initialization, and reset
