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
    if (match.index > lastIndex) {
      const nonCode = text.slice(lastIndex, match.index).trim();
      if (nonCode) segments.push({ isCode: false, content: nonCode });
    }
    segments.push({ isCode: true, content: match[1].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ isCode: false, content: remaining });
  }

  if (segments.length === 0) {
    segments.push({ isCode: false, content: text });
  }

  return segments;
}

/** Convert Markdown text to WeChat-friendly plain text format. */
export function formatMarkdown(text: string): string {
  if (!text) return "";

  const segments = splitCodeBlocks(text);

  return segments.map((seg) => {
    if (seg.isCode) {
      return seg.content
        .split("\n")
        .map((line) => `  │ ${line}`)
        .join("\n");
    }
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

const MIN_CHUNK_SIZE = 200;

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

  // Try paragraph boundary (≥ 50% of maxLen)
  let splitAt = text.lastIndexOf("\n\n", maxLen);
  if (splitAt >= maxLen * 0.5) return splitAt;

  // Try newline boundary
  splitAt = text.lastIndexOf("\n", maxLen);
  if (splitAt >= maxLen * 0.5) return splitAt;

  // Hard split
  return maxLen;
}

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

const SUPPRESSED_TOOLS = new Set(["TodoWrite", "TodoRead", "TaskList", "TaskGet"]);

/** Tools that are auto-approved and not interesting to summarize in small counts. */
const SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "WebSearch",
  "mcp__context7__resolve-library-id", "mcp__context7__query-docs",
]);

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

  // Skip summary if only 1-2 safe (auto-approved) tools — too noisy
  const nonSafe = visible.filter((t) => !SAFE_TOOLS.has(t.name));
  if (nonSafe.length === 0 && visible.length <= 2) return "";

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

/** Format a tool execution failure for WeChat display. */
export function formatToolCallFailure(toolName: string, content: string): string {
  return `❌ 失败: ${toolName}\n${truncate(content, 300)}`;
}

/** Format an AskUserQuestion tool input for WeChat display with numbered options. */
export function formatAskUserQuestion(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
  if (questions.length === 0) return "";

  const parts: string[] = [];
  for (const q of questions) {
    const questionText = String(q.question ?? "");
    if (questionText) parts.push(`❓ ${questionText}`);
    parts.push("");

    const options = Array.isArray(q.options) ? q.options as Array<Record<string, string>> : [];
    let num = 1;
    for (const opt of options) {
      const label = String(opt.label ?? "");
      const desc = String(opt.description ?? "");
      if (desc) {
        parts.push(`${num}. ${label}`);
        parts.push(`   ${desc}`);
      } else {
        parts.push(`${num}. ${label}`);
      }
      num++;
    }
    // Add "Other" option for free-text answers
    parts.push(`${num}. 其他`);
    parts.push("   输入自定义回答");
  }

  parts.push("");
  parts.push("回复序号选择 (如: 1)");
  return parts.join("\n");
}
