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
