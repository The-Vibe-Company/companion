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
    default: {
      // MCP tool-specific formatting for known MCP servers
      const mcpResult = formatMcpToolCall(toolName, input);
      if (mcpResult === null) return ""; // null = suppress
      if (mcpResult !== "") return mcpResult; // non-empty = formatted
      return `🔧 ${toolName}: ${truncate(JSON.stringify(input), TOOL_DISPLAY_LIMIT)}`;
    }
  }
}

/** Format known MCP tool calls with human-readable labels.
 *  Returns: string = formatted text, null = suppress, "" = unknown (use generic) */
function formatMcpToolCall(toolName: string, input: ToolInput): string | null {
  // context7: library documentation lookup
  if (toolName === "mcp__context7__resolve-library-id") {
    return `📚 查找库: ${truncate(String(input.libraryName ?? input.query ?? ""), TOOL_DISPLAY_LIMIT)}`;
  }
  if (toolName === "mcp__context7__query-docs") {
    return `📚 查询文档: ${truncate(String(input.query ?? ""), TOOL_DISPLAY_LIMIT)}`;
  }
  // Puppeteer: browser automation
  if (toolName.startsWith("mcp__puppeteer__")) {
    const action = toolName.split("__").pop() ?? "";
    if (action === "puppeteer_navigate") return `🌐 打开页面: ${truncate(String(input.url ?? ""), TOOL_DISPLAY_LIMIT)}`;
    if (action === "puppeteer_screenshot") return `📸 截图: ${truncate(String(input.name ?? ""), TOOL_DISPLAY_LIMIT)}`;
    if (action === "puppeteer_click") return `👆 点击: ${truncate(String(input.selector ?? ""), TOOL_DISPLAY_LIMIT)}`;
    if (action === "puppeteer_fill") return `⌨️ 填写: ${truncate(String(input.selector ?? ""), TOOL_DISPLAY_LIMIT)}`;
    return `🌐 浏览器: ${action.replace("puppeteer_", "")}`;
  }
  // Sentry: error tracking
  if (toolName === "mcp__sentry__get_sentry_issue") {
    return `🐛 Sentry: ${truncate(String(input.issue_id_or_url ?? ""), TOOL_DISPLAY_LIMIT)}`;
  }
  // Sequential thinking
  if (toolName === "mcp__sequential-thinking__sequentialthinking") {
    return null; // suppress — internal reasoning, not interesting to user
  }
  // Web reader
  if (toolName === "mcp__web_reader__webReader") {
    return `🌐 读取网页: ${truncate(String(input.url ?? ""), TOOL_DISPLAY_LIMIT)}`;
  }
  return "";
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

/** Format a system event for WeChat display. Returns empty string for suppressed events. */
export function formatSystemEvent(event: { subtype: string; [key: string]: unknown }): string {
  switch (event.subtype) {
    case "task_notification": {
      const label = String(event.summary ?? event.task_id ?? "unknown");
      const status = event.status as string | undefined;
      if (status === "failed") {
        return `❌ 后台任务失败: ${truncate(label, TOOL_DISPLAY_LIMIT)}`;
      }
      return `🔔 后台任务完成: ${truncate(label, TOOL_DISPLAY_LIMIT)}`;
    }
    case "files_persisted": {
      const rawFiles = event.files as Array<{ filename: string; file_id: string }> | undefined;
      const filenames = rawFiles?.map((f) => f.filename).filter(Boolean);
      if (filenames && filenames.length > 0) {
        const fileList = filenames.length <= 5
          ? filenames.map((f) => truncate(f, 80)).join(", ")
          : `${filenames.slice(0, 4).map((f) => truncate(f, 80)).join(", ")} 等${filenames.length}个文件`;
        return `💾 文件已保存: ${fileList}`;
      }
      return "💾 文件已保存";
    }
    case "hook_started": {
      const hookName = String(event.hook_name ?? "unknown");
      return `🪝 Hook 开始: ${truncate(hookName, TOOL_DISPLAY_LIMIT)}`;
    }
    case "hook_response": {
      const hookName = String(event.hook_name ?? "unknown");
      const exitCode = event.exit_code as number | undefined;
      if (exitCode === 0 || exitCode === undefined) {
        return `🪝 Hook 完成: ${truncate(hookName, TOOL_DISPLAY_LIMIT)}`;
      }
      return `🪝 Hook 失败: ${truncate(hookName, TOOL_DISPLAY_LIMIT)} (exit: ${exitCode})`;
    }
    // Suppress noisy/uninteresting subtypes
    case "hook_progress":
    case "compact_boundary":
      return "";
    default:
      return "";
  }
}

/** Format a status change for WeChat display. Returns empty string for uninteresting statuses. */
export function formatStatusChange(status: string): string {
  if (status === "compacting") {
    return "🔄 正在压缩上下文，请稍候...";
  }
  return "";
}

/** Format an auth status message for WeChat display. */
export function formatAuthStatus(message: Record<string, unknown>): string {
  const error = message.error as string | undefined;
  if (!error) return "";
  return `🔐 认证错误: ${truncate(error, 300)}`;
}

/** Format tool progress for WeChat display. Returns empty string if too short. */
export function formatToolProgress(
  toolName: string,
  toolUseId: string,
  elapsedSeconds: number,
  minSeconds: number = 30,
): string {
  if (elapsedSeconds < minSeconds) return "";
  const label = TOOL_VERB_MAP[toolName]?.verb ?? toolName;
  return `⏳ ${label} 已运行 ${Math.round(elapsedSeconds)}s`;
}

/** Format an AI auto-resolved permission for WeChat display. */
export function formatPermissionAutoResolved(
  toolName: string,
  input: Record<string, unknown>,
  behavior: "allow" | "deny",
  reason: string,
): string {
  const label = behavior === "allow" ? "批准" : "拒绝";
  const formatted = formatToolCall(toolName, input);
  const toolDisplay = formatted || toolName;
  return `🤖 AI自动${label}: ${toolDisplay}\n原因: ${truncate(reason, 150)}`;
}

/** Format a session phase change for WeChat display. Returns empty string for uninteresting transitions. */
export function formatSessionPhase(
  from: string,
  to: string,
  isFirstReady: boolean,
): string {
  // Only notify on specific transitions
  switch (to) {
    case "starting":
      return "⏳ 正在启动会话...";
    case "ready":
      if (isFirstReady) return "✅ 会话就绪";
      return ""; // Don't notify on subsequent ready (after compacting, etc.)
    case "terminated":
      return ""; // Handled by session:exited
    default:
      return "";
  }
}

/** Format a rate limit event for WeChat display. Returns empty string if not actionable. */
export function formatRateLimitEvent(message: Record<string, unknown>): string {
  const error = message.error as string | undefined;
  const retryAfter = message.retry_after_ms as number | undefined;
  if (!error) return "";
  const retryHint = retryAfter ? ` (等待 ${Math.round(retryAfter / 1000)}s 后重试)` : "";
  return `⏱️ 速率限制: ${truncate(error, 200)}${retryHint}`;
}

/** Format a tool result preview for WeChat display. Shows a brief summary of non-error tool results. */
export function formatToolResultPreview(toolName: string, content: string): string {
  if (!content.trim()) return "";
  const preview = truncate(content.trim(), 150);
  const verb = TOOL_VERB_MAP[toolName]?.verb ?? "结果";
  return `📄 ${verb}: ${preview}`;
}

/** Format prompt suggestions for WeChat display. */
export function formatPromptSuggestions(suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  const lines: string[] = ["💡 你可以问:"];
  suggestions.slice(0, 3).forEach((s, i) => {
    lines.push(`${i + 1}. ${truncate(s, 80)}`);
  });
  return lines.join("\n");
}
