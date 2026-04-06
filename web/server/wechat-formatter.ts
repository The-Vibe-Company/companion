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
