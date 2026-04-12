// ─── WeChat Bot Bridge ──────────────────────────────────────────────────────
// Bridges WeChat user messages with Companion CLI sessions.
// Each WeChat user gets their own independent Claude Code session with
// multi-turn conversation. Commands use / prefix (e.g. /new, /sessions).

import type { WsBridge } from "./ws-bridge.js";
import type { SessionOrchestrator, CreateSessionResult } from "./session-orchestrator.js";
import type { BrowserIncomingMessage, PermissionRequest } from "./session-types.js";
import { companionBus } from "./event-bus.js";
import { getSettings } from "./settings-manager.js";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { COMPANION_HOME } from "./paths.js";
import QRCode from "qrcode";
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary, formatToolCallFailure, formatAskUserQuestion, formatSystemEvent, formatStatusChange, formatAuthStatus, formatToolProgress, formatPermissionAutoResolved, formatSessionPhase, formatPromptSuggestions, formatRateLimitEvent, formatToolResultPreview } from "./wechat-formatter.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermissions: Map<string, {
    requestId: string;
    sessionId: string;
    toolName: string;
    agentId?: string;
    isAskUserQuestion: boolean;
    createdAt: number;
  }>;
  verboseMode: boolean;
  thinkingMode: boolean;
  pendingAskQuestions: Map<string, {
    requestId: string;
    sessionId: string;
    questions: Array<Record<string, unknown>>;
    currentIndex: number;
    answers: Record<string, string>;
    agentId?: string;
  }>;
}

interface PersistedMapping {
  sessionIds: string[];
  activeSessionIndex: number;
  verboseMode?: boolean;
  thinkingMode?: boolean;
}

type ParsedCommand =
  | { type: "message"; text: string }
  | { type: "command"; command: string; args: string };

// ── Constants ──────────────────────────────────────────────────────────────

const SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "WebSearch",
  "mcp__context7__resolve-library-id", "mcp__context7__query-docs",
  "TodoRead", "TaskList", "TaskGet",
]);

const MIN_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

const PERSIST_PATH = join(COMPANION_HOME, "wechat-sessions.json");

const HELP_TEXT = `Companion WeChat Bot Commands:

/new [folder] — 新建会话 / Create a new session
/sessions — 查看会话列表 / List your sessions
/switch <n> — 切换到第 n 个会话 / Switch to session #n
/kill — 终止当前会话 / Kill active session
/model <name> — 切换模型 / Switch model
/mode <mode> — 设置权限模式 / Set permission mode
/allow (或 /y) — 批准权限请求 / Approve pending permission
/deny (或 /n) — 拒绝权限请求 / Deny pending permission
/interrupt — 中断当前操作 / Cancel current operation
/status — 查看会话状态 / Show session status
/dir [path] — 浏览目录 / List folders in default directory
/verbose — 切换工具通知模式(批量/详细) / Toggle tool notification mode
/thinking — 切换思考过程显示 / Toggle extended thinking display
/reset — 清除上下文并创建新会话 / Clear context and start fresh session
/help — 显示此帮助 / Show this help

其他 /命令（如 /compact、/clear）会转发给 Claude Code。
直接发送文字即可与当前会话对话。`;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Generate a short session name from the first user message. */
export function formatSessionName(firstMessage: string): string {
  if (!firstMessage?.trim()) return "";
  // Take first line, truncate to 30 chars
  const firstLine = firstMessage.split("\n")[0]!.trim();
  if (firstLine.length <= 30) return firstLine;
  return firstLine.slice(0, 27) + "...";
}

/** Parse an incoming WeChat text into command or plain message. */
export function parseCommand(text: string): ParsedCommand {
  if (!text.startsWith("/")) return { type: "message", text };
  const parts = text.slice(1).split(/\s+/);
  const command = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1).join(" ");
  return { type: "command", command, args };
}

/** Format a single question from an AskUserQuestion input for WeChat display. */
export function formatSingleQuestion(questions: Array<Record<string, unknown>>, index: number): string {
  const q = questions[index];
  if (!q) return "";

  const parts: string[] = [];
  const questionText = String(q.question ?? "");
  if (questions.length > 1) {
    parts.push(`❓ [${index + 1}/${questions.length}] ${questionText}`);
  } else {
    parts.push(`❓ ${questionText}`);
  }
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
  parts.push(`${num}. 其他`);
  parts.push("   输入自定义回答");

  parts.push("");
  parts.push("回复序号选择 (如: 1)");
  return parts.join("\n");
}

/** Check if a tool use is considered dangerous.
 *  If the CLI sent a control_request, it already decided this tool needs approval.
 *  We only auto-approve truly read-only tools from SAFE_TOOLS; everything else is dangerous. */
export function isDangerousTool(toolName: string, _input: Record<string, unknown>): boolean {
  if (SAFE_TOOLS.has(toolName)) return false;
  // Bash, Write, Edit, Agent, Skill, and all unknown tools are considered dangerous
  return true;
}

/** Extract text from assistant message content blocks */
/** Format token count: show as K if >= 1000 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function extractTextFromAssistant(msg: BrowserIncomingMessage): string {
  if (msg.type !== "assistant") return "";
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Extract text deltas from stream events. */
function extractTextDeltaFromStreamEvent(msg: BrowserIncomingMessage): string {
  if (msg.type !== "stream_event") return "";
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "content_block_delta") return "";
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return "";
  return delta.text;
}

/** Extract tool use blocks from assistant message */
function extractToolUses(msg: BrowserIncomingMessage): Array<{ name: string; input: Record<string, unknown>; id?: string }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; name: string; input?: Record<string, unknown> } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_use"
      && typeof (b as Record<string, unknown>).name === "string")
    .map((toolBlock) => ({
      name: toolBlock.name,
      input: toolBlock.input ?? {},
      id: (toolBlock as Record<string, unknown>).id as string | undefined,
    }));
}

/** Extract tool_result blocks (errors only) from assistant message content. */
export function extractToolResults(msg: BrowserIncomingMessage): Array<{ tool_use_id: string; content: string; is_error: boolean }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; tool_use_id: string; content: string; is_error: boolean } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_result"
      && typeof (b as Record<string, unknown>).tool_use_id === "string"
      && (b as Record<string, unknown>).is_error === true)
    .map((b) => ({
      tool_use_id: b.tool_use_id,
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      is_error: true,
    }));
}

/** Extract non-error tool_result previews from assistant message content. */
function extractToolResultPreviews(msg: BrowserIncomingMessage): Array<{ tool_use_id: string; content: string }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; tool_use_id: string; content: unknown; is_error?: boolean } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_result"
      && typeof (b as Record<string, unknown>).tool_use_id === "string"
      && (b as Record<string, unknown>).is_error !== true)
    .map((b) => ({
      tool_use_id: b.tool_use_id,
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
    }));
}

/** Extract thinking content blocks from assistant message (fallback when stream missed them). */
function extractThinkingFromAssistant(msg: BrowserIncomingMessage): string {
  if (msg.type !== "assistant") return "";
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; thinking: string } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "thinking"
      && typeof (b as Record<string, unknown>).thinking === "string")
    .map((b) => b.thinking)
    .join("\n");
}

// ── WeChatBridge Class ─────────────────────────────────────────────────────

export class WeChatBridge {
  private wsBridge: WsBridge;
  private orchestrator: SessionOrchestrator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;
  private running = false;
  private starting = false;
  private startError: string | null = null;
  private userSessions = new Map<string, WeChatUserSession>();
  private sessionCleanups = new Map<string, Array<() => void>>();
  private sessionRelayData = new Map<string, {
    pendingText: string;
    lastTypingTs: number;
    streamlinedSent: boolean;
    contentSent: boolean;
    lastBlockIndex: number;
    toolAccumulator: Array<{ name: string; input: Record<string, unknown>; toolUseId?: string }>;
    lastUserFacingMessageTs: number;
    progressSent: boolean;
    toolNotifyBuffer: string[];
    toolNotifyTimer: ReturnType<typeof setTimeout> | null;
    phaseReadySeen: boolean;
    lastToolProgressTs: number;
    lastGitBranch: string;
    contextWarningSent: boolean;
    pendingThinking: string;
  }>();
  private userIdBySession = new Map<string, string>();
  // QR code data for web UI display
  private qrCodeData: string | null = null;
  // Auto-reconnect state
  private reconnectDelay = MIN_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;
  private reconnectAttempt = 0;
  // Send queue: serializes all bot.send() calls so concurrent fire-and-forget
  // sends (tool notifications + result text) don't overwhelm the WeChat SDK
  // and silently drop the last message.
  private sendQueue: Array<{ userId: string; text: string }> = [];
  private sending = false;

  constructor(wsBridge: WsBridge, orchestrator: SessionOrchestrator) {
    this.wsBridge = wsBridge;
    this.orchestrator = orchestrator;
    this.restoreSessionMappings();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start the WeChat bot in the background.
   * Returns immediately — the login/polling happens asynchronously.
   * Use getStatus() to poll for progress (starting → running / error).
   */
  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.intentionalStop = false;
    this.reconnectAttempt = 0;
    this.starting = true;
    this.startError = null;

    // Fire-and-forget: login + start happen in background
    this.doStart().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[wechat] Failed to start:", message);
      this.starting = false;
      this.startError = message;
    });
  }

  private async doStart(): Promise<void> {
    const { WeChatBot } = await import("@wechatbot/wechatbot");
    this.bot = new WeChatBot({
      storage: "file",
      storageDir: join(COMPANION_HOME, "wechat-bot"),
    });

    await this.bot.login({
      callbacks: {
        onQrUrl: async (url: string) => {
          try {
            this.qrCodeData = await QRCode.toDataURL(url, { width: 256, margin: 2 });
          } catch {
            this.qrCodeData = url;
          }
          console.log("[wechat] QR code ready for login scan");
        },
        onScanned: () => {
          console.log("[wechat] QR code scanned, waiting for confirmation...");
        },
      },
    });

    this.bot.onMessage(async (msg: { userId: string; text: string; type: string }) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        console.error("[wechat] Error handling message:", err);
      }
    });

    // bot.start() runs a long-poll loop that never resolves — fire and forget
    this.bot.start().catch((err: unknown) => {
      console.error("[wechat] Poll loop crashed:", err);
      this.running = false;
      this.starting = false;
      if (!this.intentionalStop) {
        this.scheduleReconnect();
      }
    });

    this.running = true;
    this.starting = false;
    this.reconnectDelay = MIN_RECONNECT_DELAY_MS;
    this.reconnectAttempt = 0;
    this.qrCodeData = null;
    console.log("[wechat] Bot started and connected");
  }

  stop(): void {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    if (!this.bot) return;
    try {
      this.bot.stop();
    } catch {
      // ignore
    }
    // Clean up all relay listeners
    for (const [sessionId, cleanups] of this.sessionCleanups) {
      for (const cleanup of cleanups) cleanup();
    }
    this.sessionCleanups.clear();
    this.running = false;
    console.log("[wechat] Bot stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  get qrCode(): string | null {
    return this.qrCodeData;
  }

  private scheduleReconnect(): void {
    if (this.intentionalStop) return;

    this.reconnectAttempt++;
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      this.startError = `Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts. Use the web UI to re-login.`;
      console.error(`[wechat] ${this.startError}`);
      return;
    }

    const delay = this.reconnectDelay;
    console.log(`[wechat] Auto-reconnect attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      try {
        await this.doStart();
      } catch (err) {
        console.error("[wechat] Reconnect attempt failed:", err);
        if (!this.intentionalStop) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Message Handling ──────────────────────────────────────────────────

  /**
   * Force re-login: stop bot, clear stored credentials, restart with fresh QR code.
   * User session mappings (Claude sessions) are preserved.
   */
  async relogin(): Promise<void> {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    this.running = false;
    this.starting = false;

    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // ignore
      }
    }

    // Clean up relay listeners
    for (const [, cleanups] of this.sessionCleanups) {
      for (const cleanup of cleanups) cleanup();
    }
    this.sessionCleanups.clear();

    // Clear stored credentials via SDK storage
    try {
      if (this.bot?.storage) {
        await this.bot.storage.clear();
      }
    } catch (err) {
      console.error("[wechat] Failed to clear credentials:", err);
    }

    this.bot = null;
    this.qrCodeData = null;
    this.startError = null;
    this.reconnectAttempt = 0;
    this.reconnectDelay = MIN_RECONNECT_DELAY_MS;

    // Fresh start — will show new QR code since credentials are cleared
    await this.start();
  }

  // ── Message Handling ──────────────────────────────────────────────────

  private async handleMessage(msg: { userId: string; text: string; type: string }): Promise<void> {
    const { userId, text, type } = msg;

    // Only handle text messages for now
    if (type !== "text" || !text.trim()) return;

    // Check user whitelist
    const settings = getSettings();
    if (settings.wechatAllowedUsers) {
      const allowed = settings.wechatAllowedUsers.split(",").map((s) => s.trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(userId)) {
        await this.sendReply(userId, "Access denied. Contact the admin to add your WeChat ID.");
        return;
      }
    }

    // Parse commands BEFORE AskUserQuestion interceptor so /allow, /deny, /interrupt
    // are not swallowed as free-text answers when both are pending concurrently.
    const parsed = parseCommand(text.trim());
    const userSession = this.userSessions.get(userId);

    // Check for pending AskUserQuestion — number response selects option
    // Only intercept plain text messages (not commands) when AskUserQuestion is pending
    if (parsed.type === "message" && userSession && userSession.pendingAskQuestions.size > 0) {
      // FIFO: take the first pending AskUserQuestion
      const entry = userSession.pendingAskQuestions.entries().next().value!;
      const [askRequestId, pending] = entry;
      const num = parseInt(text.trim(), 10);
      const q = pending.questions[pending.currentIndex];
      const options = Array.isArray(q?.options) ? q.options as Array<Record<string, string>> : [];

      let selectedLabel: string;
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        // Valid option number
        selectedLabel = options[num - 1].label;
      } else {
        // "Other" or any free-text — use the user's text
        selectedLabel = text.trim();
      }

      pending.answers[String(pending.currentIndex)] = selectedLabel;
      const agentLabel = pending.agentId ? "[子任务] " : "";
      await this.sendReply(userId, `✅ ${agentLabel}已选择: ${selectedLabel}`);

      // Advance to next question or submit all answers
      const nextIndex = pending.currentIndex + 1;
      if (nextIndex < pending.questions.length) {
        // More questions — show the next one
        pending.currentIndex = nextIndex;
        this.sendReply(userId, `${agentLabel}${formatSingleQuestion(pending.questions, nextIndex)}`);
      } else {
        // All questions answered — submit
        userSession.pendingAskQuestions.delete(askRequestId);
        userSession.pendingPermissions.delete(askRequestId);
        this.wsBridge.injectPermissionResponse(pending.sessionId, askRequestId, "allow", {
          questions: pending.questions,
          answers: pending.answers,
        });
      }
      return;
    }

    if (parsed.type === "message") {
      await this.handleUserMessage(userId, parsed.text);
    } else {
      await this.handleCommand(userId, parsed.command, parsed.args);
    }
  }

  private async handleUserMessage(userId: string, text: string): Promise<void> {
    const userSession = this.getOrCreateUserSession(userId);
    const sessionId = userSession.sessionIds[userSession.activeSessionIndex];

    if (!sessionId) {
      await this.sendReply(userId, "No active session. Send /new to create one.");
      return;
    }

    const session = this.wsBridge.getSession(sessionId);
    if (!session) {
      // Session no longer exists, clean up
      this.removeSessionFromUser(userId, sessionId);
      await this.sendReply(userId, "Session expired. Send /new to create a new one.");
      return;
    }

    // Set up relay if not already active
    this.ensureRelay(sessionId, userId);

    // Send typing indicator
    await this.sendTyping(userId);

    // Inject the user message
    this.wsBridge.injectUserMessage(sessionId, text);
  }

  private async handleCommand(userId: string, cmd: string, args: string): Promise<void> {
    switch (cmd) {
      case "new":
        await this.cmdNewSession(userId, args);
        break;
      case "sessions":
        await this.cmdListSessions(userId);
        break;
      case "switch":
        await this.cmdSwitchSession(userId, args);
        break;
      case "kill":
        await this.cmdKillSession(userId);
        break;
      case "model":
        await this.cmdSetModel(userId, args);
        break;
      case "mode":
        await this.cmdSetPermissionMode(userId, args);
        break;
      case "allow":
      case "y":
        await this.cmdPermissionResponse(userId, "allow");
        break;
      case "deny":
      case "n":
        await this.cmdPermissionResponse(userId, "deny");
        break;
      case "interrupt":
        await this.cmdInterrupt(userId);
        break;
      case "status":
        await this.cmdStatus(userId);
        break;
      case "dir":
        await this.cmdDir(userId, args);
        break;
      case "verbose":
        await this.cmdVerbose(userId);
        break;
      case "thinking":
        await this.cmdThinking(userId);
        break;
      case "help":
        await this.sendReply(userId, HELP_TEXT);
        break;
      case "reset":
        await this.cmdClear(userId);
        break;
      default:
        // Forward unknown /commands to the active Claude Code session
        // (e.g. /compact, /help from Claude Code itself)
        await this.handleUserMessage(userId, `/${cmd}${args ? " " + args : ""}`);
    }
  }

  // ── Command Implementations ───────────────────────────────────────────

  private async cmdNewSession(userId: string, args: string): Promise<void> {
    const settings = getSettings();
    const baseCwd = settings.wechatDefaultCwd || "";
    let cwd: string | undefined;

    if (args.trim() && baseCwd) {
      const folderName = args.trim();
      cwd = resolve(baseCwd, folderName);
      try {
        mkdirSync(cwd, { recursive: true });
      } catch (err) {
        await this.sendReply(userId, `Failed to create directory: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else if (baseCwd) {
      cwd = baseCwd;
    }

    const result: CreateSessionResult = await this.orchestrator.createSession({
      permissionMode: settings.wechatDefaultPermissionMode || "acceptEdits",
      ...(cwd ? { cwd } : {}),
    });

    if (!result.ok) {
      await this.sendReply(userId, `Failed to create session: ${result.error}`);
      return;
    }

    const sessionId = result.session.sessionId;
    const userSession = this.getOrCreateUserSession(userId);
    userSession.sessionIds.push(sessionId);
    userSession.activeSessionIndex = userSession.sessionIds.length - 1;
    this.userIdBySession.set(sessionId, userId);

    // Tag the session
    const session = this.wsBridge.getSession(sessionId);
    if (session) {
      session.state.wechatUserId = userId;
    }

    this.persistSessionMappings();
    this.ensureRelay(sessionId, userId);

    await this.sendReply(userId, `Session created: ${sessionId.slice(0, 8)}...\nModel: ${result.session.model || "default"}\nCWD: ${result.session.cwd}\n\nSession #${userSession.activeSessionIndex + 1} of ${userSession.sessionIds.length}`);
  }

  private async cmdListSessions(userId: string): Promise<void> {
    const userSession = this.userSessions.get(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      await this.sendReply(userId, "No sessions. Send /new to create one.");
      return;
    }

    const lines: string[] = [`📋 Your sessions (${userSession.sessionIds.length}):`];
    userSession.sessionIds.forEach((sid, i) => {
      const session = this.wsBridge.getSession(sid);
      const state = session?.state;
      const isActive = i === userSession.activeSessionIndex;

      if (!state) {
        lines.push("");
        lines.push(`#${i + 1} ${sid.slice(0, 8)}... (disconnected)${isActive ? " ← active" : ""}`);
        return;
      }

      const phase = session.stateMachine?.phase ?? "unknown";
      const phaseEmoji = phase === "ready" ? "🟢" : phase === "streaming" ? "🔵" : phase === "awaiting_permission" ? "🟡" : "⚪";

      lines.push("");
      lines.push(`${isActive ? "▶" : " "} #${i + 1} ${sid.slice(0, 8)}... ${isActive ? "← active" : ""}`);
      lines.push(`  ${phaseEmoji} ${phase} | ${state.model || "?"}`);
      lines.push(`  📁 ${state.cwd || "?"}`);

      const details: string[] = [];
      details.push(`turns: ${state.num_turns ?? 0}`);
      details.push(`cost: $${(state.total_cost_usd ?? 0).toFixed(4)}`);
      details.push(`in: ${fmtTokens(state.input_tokens ?? 0)}`);
      details.push(`out: ${fmtTokens(state.output_tokens ?? 0)}`);
      if (state.git_branch) details.push(`branch: ${state.git_branch}`);
      if (state.permissionMode) details.push(`mode: ${state.permissionMode}`);
      const pendingPerms = session.pendingPermissions.size;
      if (pendingPerms > 0) details.push(`⏳ ${pendingPerms} pending`);

      lines.push(`  ${details.join(" | ")}`);
    });

    lines.push("");
    lines.push("Send /switch <n> to switch, /status for details.");

    await this.sendReply(userId, lines.join("\n"));
  }

  private async cmdSwitchSession(userId: string, args: string): Promise<void> {
    const index = parseInt(args, 10) - 1;
    const userSession = this.userSessions.get(userId);
    if (!userSession || isNaN(index) || index < 0 || index >= userSession.sessionIds.length) {
      await this.sendReply(userId, `Invalid session number. Use /sessions to see your sessions.`);
      return;
    }
    userSession.activeSessionIndex = index;
    this.persistSessionMappings();
    const sid = userSession.sessionIds[index];
    await this.sendReply(userId, `Switched to session #${index + 1}: ${sid.slice(0, 8)}...`);
  }

  private async cmdKillSession(userId: string): Promise<void> {
    const userSession = this.userSessions.get(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      await this.sendReply(userId, "No active session to kill.");
      return;
    }

    const sessionId = userSession.sessionIds[userSession.activeSessionIndex];
    await this.orchestrator.killSession(sessionId);
    this.removeSessionFromUser(userId, sessionId);

    const msg = userSession.sessionIds.length > 0
      ? `Session killed. Switched to session #${userSession.activeSessionIndex + 1}.`
      : "Session killed. No more sessions.";
    await this.sendReply(userId, msg);
  }

  /** Clear context: kill current session and create a fresh one with the same cwd. */
  private async cmdClear(userId: string): Promise<void> {
    const userSession = this.userSessions.get(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      await this.sendReply(userId, "No active session. Send /new to create one.");
      return;
    }

    const oldSessionId = userSession.sessionIds[userSession.activeSessionIndex];
    const oldSession = this.wsBridge.getSession(oldSessionId);
    const cwd = oldSession?.state?.cwd;

    // Kill old session
    await this.orchestrator.killSession(oldSessionId);
    this.removeSessionFromUser(userId, oldSessionId);

    // Create new session with same cwd
    const settings = getSettings();
    const result: CreateSessionResult = await this.orchestrator.createSession({
      permissionMode: settings.wechatDefaultPermissionMode || "acceptEdits",
      ...(cwd ? { cwd } : {}),
    });

    if (!result.ok) {
      await this.sendReply(userId, `Failed to create new session: ${result.error}`);
      return;
    }

    const newSessionId = result.session.sessionId;
    userSession.sessionIds.push(newSessionId);
    userSession.activeSessionIndex = userSession.sessionIds.length - 1;
    this.userIdBySession.set(newSessionId, userId);

    const newSession = this.wsBridge.getSession(newSessionId);
    if (newSession) {
      newSession.state.wechatUserId = userId;
    }

    this.persistSessionMappings();
    this.ensureRelay(newSessionId, userId);

    await this.sendReply(userId, `🧹 上下文已清除，新会话已创建。\nSession: ${newSessionId.slice(0, 8)}... | CWD: ${cwd || "default"}`);
  }

  private async cmdSetModel(userId: string, args: string): Promise<void> {
    const model = args.trim();
    if (!model) {
      await this.sendReply(userId, "Usage: /model <name>\nExample: /model claude-sonnet-4-6");
      return;
    }
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    this.wsBridge.injectSetModel(sessionId, model);
    await this.sendReply(userId, `Model set to: ${model}`);
  }

  private async cmdSetPermissionMode(userId: string, args: string): Promise<void> {
    const mode = args.trim();
    if (!mode) {
      await this.sendReply(userId, "Usage: /mode <mode>\nOptions: bypassPermissions, acceptEdits, plan, default");
      return;
    }
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    this.wsBridge.injectSetPermissionMode(sessionId, mode);
    await this.sendReply(userId, `Permission mode set to: ${mode}`);
  }

  private async cmdPermissionResponse(userId: string, behavior: "allow" | "deny"): Promise<void> {
    const userSession = this.userSessions.get(userId);
    if (!userSession || userSession.pendingPermissions.size === 0) {
      await this.sendReply(userId, "No pending permission request. Tool calls shown with ℹ️ are informational and don't need approval.");
      return;
    }

    // FIFO: resolve the oldest pending permission
    const entry = userSession.pendingPermissions.entries().next().value!;
    const [requestId, pending] = entry;
    userSession.pendingPermissions.delete(requestId);

    this.wsBridge.injectPermissionResponse(pending.sessionId, requestId, behavior);
    const agentLabel = pending.agentId ? "[子任务] " : "";
    await this.sendReply(userId, `${agentLabel}Permission ${behavior === "allow" ? "approved" : "denied"}.`);
  }

  private async cmdInterrupt(userId: string): Promise<void> {
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    this.wsBridge.injectInterrupt(sessionId);
    await this.sendReply(userId, "Interrupt sent. The current operation will be cancelled.");
  }

  private async cmdStatus(userId: string): Promise<void> {
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    const session = this.wsBridge.getSession(sessionId);
    if (!session) {
      await this.sendReply(userId, "Session not found.");
      return;
    }
    const userSession = this.userSessions.get(userId);
    const state = session.state;
    const phase = session.stateMachine?.phase ?? "unknown";
    const pendingPerms = session.pendingPermissions.size;
    const lines = [
      `Session: ${sessionId.slice(0, 8)}...`,
      `Phase: ${phase}`,
      `Model: ${state.model || "?"}`,
      `Permission mode: ${state.permissionMode || "?"}`,
      `Turns: ${state.num_turns ?? 0}`,
      `Cost: $${(state.total_cost_usd ?? 0).toFixed(4)}`,
      `Input tokens: ${fmtTokens(state.input_tokens ?? 0)}`,
      `Output tokens: ${fmtTokens(state.output_tokens ?? 0)}`,
      `CWD: ${state.cwd}`,
      `Branch: ${state.git_branch || "none"}`,
      `Pending permissions: ${pendingPerms}`,
      `工具通知: ${(userSession?.verboseMode ?? false) ? "逐条" : "批量"}`,
      `思考显示: ${(userSession?.thinkingMode ?? false) ? "开启" : "关闭"}`,
    ];
    await this.sendReply(userId, lines.join("\n"));
  }

  private async cmdDir(userId: string, args: string): Promise<void> {
    const settings = getSettings();
    const baseCwd = settings.wechatDefaultCwd;
    if (!baseCwd) {
      await this.sendReply(userId, "Default working directory not configured. Set it in Settings > Default Working Directory.");
      return;
    }

    const subPath = args.trim();
    const targetDir = subPath ? resolve(baseCwd, subPath) : baseCwd;

    // Safety: ensure target is within baseCwd
    if (!targetDir.startsWith(resolve(baseCwd))) {
      await this.sendReply(userId, "Access denied: path is outside the default working directory.");
      return;
    }

    if (!existsSync(targetDir)) {
      await this.sendReply(userId, `Directory not found: ${subPath || baseCwd}`);
      return;
    }

    try {
      const recursive = subPath.includes("-r") || subPath.includes("--recursive");
      const cleanSubPath = subPath.replace(/-r\b|--recursive\b/g, "").trim();
      const actualDir = cleanSubPath ? resolve(baseCwd, cleanSubPath) : targetDir;

      const lines = this.listDirectory(actualDir, recursive, 0, 3);
      if (lines.length === 0) {
        await this.sendReply(userId, `Empty directory: ${cleanSubPath || "(root)"}`);
        return;
      }
      const header = cleanSubPath ? `Contents of ${cleanSubPath}:` : `Contents of default directory:`;
      await this.sendReply(userId, [header, ...lines].join("\n"));
    } catch (err) {
      await this.sendReply(userId, `Error listing directory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cmdVerbose(userId: string): Promise<void> {
    const userSession = this.getOrCreateUserSession(userId);
    userSession.verboseMode = !userSession.verboseMode;
    this.persistSessionMappings();
    if (userSession.verboseMode) {
      await this.sendReply(userId, "🔔 已切换到逐条模式 — 每个操作即时推送");
    } else {
      await this.sendReply(userId, "🔕 已切换到批量模式 — 操作每3秒合并推送");
    }
  }

  private async cmdThinking(userId: string): Promise<void> {
    const userSession = this.getOrCreateUserSession(userId);
    userSession.thinkingMode = !userSession.thinkingMode;
    this.persistSessionMappings();
    if (userSession.thinkingMode) {
      await this.sendReply(userId, "🧠 思考显示已开启 — 将展示 AI 的推理过程");
    } else {
      await this.sendReply(userId, "🧠 思考显示已关闭");
    }
  }

  /** Recursively list directory contents up to maxDepth levels. */
  private listDirectory(dir: string, recursive: boolean, depth: number, maxDepth: number): string[] {
    if (depth > maxDepth) return [`  ${"│ ".repeat(depth)}... (max depth reached)`];
    const lines: string[] = [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
    } catch {
      return [`  ${"│ ".repeat(depth)}(unreadable)`];
    }

    // Sort: directories first, then files, alphabetically
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return String(a.name).localeCompare(String(b.name));
    });

    for (const entry of sorted) {
      const name = String(entry.name);
      const prefix = "  " + "│ ".repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${prefix}📁 ${name}/`);
        if (recursive) {
          lines.push(...this.listDirectory(join(dir, name), true, depth + 1, maxDepth));
        }
      } else {
        lines.push(`${prefix}📄 ${name}`);
      }
    }
    return lines;
  }

  // ── Relay (companionBus subscriptions) ────────────────────────────────

  private ensureRelay(sessionId: string, userId: string): void {
    if (this.sessionCleanups.has(sessionId)) return;

    const cleanups: Array<() => void> = [];
    this.sessionRelayData.set(sessionId, { pendingText: "", lastTypingTs: 0, streamlinedSent: false, contentSent: false, lastBlockIndex: -1, toolAccumulator: [], lastUserFacingMessageTs: Date.now(), progressSent: false, toolNotifyBuffer: [], toolNotifyTimer: null, phaseReadySeen: false, lastToolProgressTs: 0, lastGitBranch: "", contextWarningSent: false, pendingThinking: "" });

    // Stream events — accumulate text + thinking
    const unsubStream = companionBus.on("message:stream_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      if (!relayData) return;

      const event = (message as Record<string, unknown>).event as Record<string, unknown> | undefined;
      if (!event || event.type !== "content_block_delta") return;

      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      const blockIndex = typeof event.index === "number" ? event.index : -1;

      // Handle thinking deltas
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        const userSession = this.userSessions.get(userId);
        if (userSession?.thinkingMode) {
          relayData.pendingThinking += delta.thinking;
        }
        // Still throttle typing indicator for thinking
        const now = Date.now();
        if (now - relayData.lastTypingTs > 5000) {
          relayData.lastTypingTs = now;
          this.sendTyping(userId).catch(() => {});
        }
        return;
      }

      // Handle text deltas
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        // Flush accumulated thinking before text content
        if (relayData.pendingThinking) {
          const thinkingText = relayData.pendingThinking.trim();
          if (thinkingText) {
            this.sendReply(userId, `🧠 思考:\n${formatMarkdown(thinkingText.length > 800 ? thinkingText.slice(0, 797) + "..." : thinkingText)}`);
          }
          relayData.pendingThinking = "";
        }
        // Add separator when content block index changes
        if (relayData.lastBlockIndex >= 0 && blockIndex >= 0 && blockIndex !== relayData.lastBlockIndex && relayData.pendingText.length > 0) {
          relayData.pendingText += "\n\n";
        }
        if (blockIndex >= 0) {
          relayData.lastBlockIndex = blockIndex;
        }
        relayData.pendingText += delta.text;
        relayData.contentSent = true;
        const now = Date.now();
        if (now - relayData.lastTypingTs > 5000) {
          relayData.lastTypingTs = now;
          this.sendTyping(userId).catch(() => {});
        }
      }
    });
    cleanups.push(unsubStream);

    // Streamlined text — send directly (complete text, not a delta)
    const unsubStreamlined = companionBus.on("message:streamlined_text", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const text = typeof raw.text === "string" ? raw.text : "";
      if (text.trim()) {
        this.sendReply(userId, formatMarkdown(text.trim()));
        const relayData = this.sessionRelayData.get(sessionId);
        if (relayData) {
          relayData.streamlinedSent = true;
          relayData.contentSent = true;
        }
      }
    });
    cleanups.push(unsubStreamlined);

    // Streamlined tool use summary — send as informational
    const unsubToolSummary = companionBus.on("message:streamlined_tool_use_summary", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const summary = typeof raw.tool_summary === "string" ? raw.tool_summary : "";
      if (summary.trim()) {
        this.sendReply(userId, `📋 ${summary}`);
      }
    });
    cleanups.push(unsubToolSummary);

    // Assistant messages — extract tool uses; use text as fallback if stream events missed it
    const unsubAssistant = companionBus.on("message:assistant", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;

      // Detect subagent messages via parent_tool_use_id
      const raw = message as Record<string, unknown>;
      const parentToolUseId = raw.parent_tool_use_id as string | undefined;
      const agentPrefix = parentToolUseId ? "[子任务] " : "";

      const relayData = this.sessionRelayData.get(sessionId);
      const userSession = this.userSessions.get(userId);

      // Thinking fallback: extract thinking blocks when stream events missed them
      if (relayData && userSession?.thinkingMode && !relayData.pendingThinking.trim()) {
        const thinkingText = extractThinkingFromAssistant(message);
        if (thinkingText.trim()) {
          relayData.pendingThinking = thinkingText.trim();
          this.sendReply(userId, `🧠 思考:\n${formatMarkdown(thinkingText.length > 800 ? thinkingText.slice(0, 797) + "..." : thinkingText)}`);
          relayData.pendingThinking = ""; // clear after sending
        }
      }

      // Fallback: if stream events didn't capture text, use assistant message text instead
      if (relayData && !relayData.pendingText.trim()) {
        const assistantText = extractTextFromAssistant(message);
        if (assistantText.trim()) {
          relayData.pendingText = assistantText.trim();
        }
      }

      // Extract and route tool calls to user notifications
      const tools = extractToolUses(message);
      if (tools.length > 0) {
        const verboseMode = userSession?.verboseMode ?? false;
        for (const t of tools) {
          // Parse input safely for accumulator and display
          const parsedInput = t.input;

          if (relayData) {
            relayData.toolAccumulator.push({ name: t.name, input: parsedInput, toolUseId: t.id });
          }

          // Route tool call to user notification
          const formatted = formatToolCall(t.name, parsedInput);
          if (!formatted) continue; // suppressed tools (TodoWrite, etc.)
          const labeled = `${agentPrefix}${formatted}`;
          if (verboseMode) {
            this.sendReply(userId, labeled);
          } else {
            if (relayData) {
              relayData.toolNotifyBuffer.push(labeled);
              if (!relayData.toolNotifyTimer) {
                relayData.toolNotifyTimer = setTimeout(() => this.flushToolNotifyBuffer(userId, sessionId), 3000);
              }
            }
          }
        }
      }

      // Detect tool failures and send immediate notifications
      const toolResults = extractToolResults(message);
      if (toolResults.length > 0 && relayData) {
        for (const result of toolResults) {
          const match = relayData.toolAccumulator.find(t => t.toolUseId === result.tool_use_id);
          const toolName = match?.name ?? "unknown";
          this.sendReply(userId, formatToolCallFailure(toolName, result.content));
        }
      }

      // Tool result previews: show brief non-error tool results in verbose mode
      if (userSession?.verboseMode && relayData) {
        const previews = extractToolResultPreviews(message);
        for (const preview of previews) {
          if (!preview.content.trim()) continue;
          const match = relayData.toolAccumulator.find(t => t.toolUseId === preview.tool_use_id);
          const toolName = match?.name ?? "unknown";
          // Only show previews for interesting tools (skip Read, Glob, Grep results — too verbose)
          if (!SAFE_TOOLS.has(toolName)) {
            const formatted = formatToolResultPreview(toolName, preview.content);
            if (formatted) {
              this.sendReply(userId, `${agentPrefix}${formatted}`);
            }
          }
        }
      }
    });
    cleanups.push(unsubAssistant);

    // Result — send the response text
    const unsubResult = companionBus.on("message:result", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      const streamText = relayData?.pendingText ?? "";
      const streamlinedSent = relayData?.streamlinedSent ?? false;
      const hadContent = relayData?.contentSent ?? false;
      // Reset all tracking state for this turn
      if (relayData) {
        // Flush any remaining thinking before reset
        if (relayData.pendingThinking) {
          const userSession = this.userSessions.get(userId);
          if (userSession?.thinkingMode) {
            const thinkingText = relayData.pendingThinking.trim();
            if (thinkingText) {
              this.sendReply(userId, `🧠 思考:\n${formatMarkdown(thinkingText.length > 800 ? thinkingText.slice(0, 797) + "..." : thinkingText)}`);
            }
          }
        }
        relayData.pendingText = "";
        relayData.streamlinedSent = false;
        relayData.contentSent = false;
        relayData.lastBlockIndex = -1;
        relayData.pendingThinking = "";
      }

      const result = message as Record<string, unknown>;
      const data = result.data as Record<string, unknown> | undefined;

      if (!streamlinedSent) {
        // Prefer data.result (definitive CLI response) over accumulated streaming text.
        // Streaming text may miss characters or arrive out of order;
        // data.result is the complete, final response from the CLI.
        const finalText = (typeof data?.result === "string" && data.result.trim())
          ? data.result.trim()
          : streamText.trim();

        if (finalText) {
          this.sendReply(userId, formatMarkdown(finalText));
        } else if (!hadContent) {
          if (!data?.is_error) {
            const toolSummary = formatToolSummary(relayData?.toolAccumulator ?? []);
            this.sendReply(userId, toolSummary || "(操作完成)");
          }
        }
      }

      // Always check for errors regardless of streamlinedSent
      if (data?.is_error) {
        const errors = data.errors as string[] | undefined;
        if (errors?.length) {
          this.sendReply(userId, `Error: ${errors.join(", ")}`);
        }
      }

      // Per-turn cost & context notification (feature 2)
      // Context usage warning when >80% (feature 1)
      // File change summary (feature: lines added/removed)
      const session = this.wsBridge.getSession(sessionId);
      if (session && !data?.is_error) {
        const cost = session.state.total_cost_usd ?? 0;
        const ctxPct = session.state.context_used_percent ?? 0;
        const turns = session.state.num_turns ?? 0;
        const linesAdded = session.state.total_lines_added ?? 0;
        const linesRemoved = session.state.total_lines_removed ?? 0;
        const statsParts: string[] = [];
        statsParts.push(`$${cost.toFixed(4)}`);
        statsParts.push(`in ${fmtTokens(session.state.input_tokens ?? 0)}`);
        statsParts.push(`out ${fmtTokens(session.state.output_tokens ?? 0)}`);
        statsParts.push(`turn #${turns}`);
        if (linesAdded > 0 || linesRemoved > 0) {
          statsParts.push(`${linesAdded > 0 ? `+${linesAdded}` : ""}${linesAdded > 0 && linesRemoved > 0 ? "/" : ""}${linesRemoved > 0 ? `-${linesRemoved}` : ""} 行`);
        }
        if (cost > 0 || (session.state.input_tokens ?? 0) > 0 || (session.state.output_tokens ?? 0) > 0) {
          this.sendReply(userId, `💰 ${statsParts.join(" · ")}`);
        }
        // Context warning: notify once when crossing 80%
        if (relayData && ctxPct >= 80 && !relayData.contextWarningSent) {
          relayData.contextWarningSent = true;
          this.sendReply(userId, `⚠️ 上下文使用已达 ${ctxPct.toFixed(0)}%，建议发送 /compact 压缩或 /new 开新会话`);
        }
        if (relayData && ctxPct < 60) {
          relayData.contextWarningSent = false;
        }
      }

      // Reset tool accumulator and timestamp for next turn
      if (relayData) {
        relayData.toolAccumulator = [];
        relayData.lastUserFacingMessageTs = Date.now();
        relayData.progressSent = false;
        relayData.lastToolProgressTs = 0;
      }
    });
    cleanups.push(unsubResult);

    // Permission requests — auto-approve safe, forward dangerous
    // Listen on session:permission-request (fires before AI validation in ws-bridge)
    const unsubPermReq = companionBus.on("session:permission-request", ({ sessionId: sid, request }) => {
      if (sid !== sessionId) return;
      this.handlePermissionRequest(sessionId, userId, request);
    });
    cleanups.push(unsubPermReq);

    // Permission cancelled — clean from Maps
    const unsubPermCancel = companionBus.on("session:permission-cancelled", ({ sessionId: sid, requestId }) => {
      if (sid !== sessionId) return;
      const userSession = this.userSessions.get(userId);
      if (!userSession) return;

      const wasInPerms = userSession.pendingPermissions.delete(requestId);
      const wasInAsk = userSession.pendingAskQuestions.delete(requestId);

      if (wasInPerms || wasInAsk) {
        this.sendReply(userId, "Permission request was cancelled.");
      }
    });
    cleanups.push(unsubPermCancel);

    // Session exited
    const unsubExited = companionBus.on("session:exited", ({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      this.cleanupRelay(sessionId);
      this.removeSessionFromUser(userId, sessionId);
      this.sendReply(userId, `Session ${sessionId.slice(0, 8)}... exited.`);
    });
    cleanups.push(unsubExited);

    // ── NEW: system_event (task_notification, files_persisted, hook events) ──
    const unsubSystemEvent = companionBus.on("message:system_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const event = raw.event as Record<string, unknown> | undefined;
      if (!event) return;
      const formatted = formatSystemEvent(event as { subtype: string; [key: string]: unknown });
      if (formatted) {
        this.sendReply(userId, formatted);
      }
    });
    cleanups.push(unsubSystemEvent);

    // ── NEW: status_change (compacting) ──
    const unsubStatusChange = companionBus.on("message:status_change", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const status = typeof raw.status === "string" ? raw.status : "";
      const formatted = formatStatusChange(status);
      if (formatted) {
        this.sendReply(userId, formatted);
      }
    });
    cleanups.push(unsubStatusChange);

    // ── NEW: tool_progress (long-running tool notifications, throttled) ──
    const unsubToolProgress = companionBus.on("message:tool_progress", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const relayData = this.sessionRelayData.get(sessionId);
      if (!relayData) return;

      // Throttle: at most one progress notification per 60s per session
      const now = Date.now();
      if (now - relayData.lastToolProgressTs < 60_000) return;

      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const toolUseId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : "";
      const elapsed = typeof raw.elapsed_time_seconds === "number" ? raw.elapsed_time_seconds : 0;
      const parentToolUseId = raw.parent_tool_use_id as string | null | undefined;

      // Subagent-specific progress hint
      if (toolName === "Agent" && elapsed >= 15) {
        const agentLabel = parentToolUseId ? "[子任务] " : "";
        relayData.lastToolProgressTs = now;
        this.sendReply(userId, `${agentLabel}🤖 子任务执行中... 已运行 ${Math.round(elapsed)}s`);
        return;
      }

      const formatted = formatToolProgress(toolName, toolUseId, elapsed);
      if (formatted) {
        relayData.lastToolProgressTs = now;
        this.sendReply(userId, formatted);
      }
    });
    cleanups.push(unsubToolProgress);

    // ── NEW: auth_status ──
    const unsubAuthStatus = companionBus.on("message:auth_status", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const formatted = formatAuthStatus(message as Record<string, unknown>);
      if (formatted) {
        this.sendReply(userId, formatted);
      }
    });
    cleanups.push(unsubAuthStatus);

    // ── NEW: permission_auto_resolved (AI validation) ──
    // Note: AI validation is skipped for WeChat sessions, but this event
    // can still fire if the setting is changed mid-session. Handle defensively.
    const unsubPermAuto = companionBus.on("session:permission-auto-resolved", ({ sessionId: sid, request, behavior, reason }) => {
      if (sid !== sessionId) return;
      const formatted = formatPermissionAutoResolved(request.tool_name, request.input, behavior, reason);
      if (formatted) {
        const agentLabel = request.agent_id ? "[子任务] " : "";
        this.sendReply(userId, `${agentLabel}${formatted}`);
      }
    });
    cleanups.push(unsubPermAuto);

    // ── NEW: session_phase (phase transitions) ──
    const unsubPhase = companionBus.on("session:phase-changed", ({ sessionId: sid, from, to }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      const isFirstReady = !relayData?.phaseReadySeen;
      const formatted = formatSessionPhase(from, to, isFirstReady);
      if (formatted) {
        this.sendReply(userId, formatted);
      }
      if (to === "ready" && relayData) {
        relayData.phaseReadySeen = true;
      }
    });
    cleanups.push(unsubPhase);

    // ── NEW: prompt_suggestion (next-turn suggestions) ──
    const unsubPromptSuggestion = companionBus.on("message:prompt_suggestion", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions as string[] : [];
      const formatted = formatPromptSuggestions(suggestions);
      if (formatted) {
        this.sendReply(userId, formatted);
      }
    });
    cleanups.push(unsubPromptSuggestion);

    // ── NEW: session auto-naming from first user message ──
    const unsubFirstTurn = companionBus.on("session:first-turn-completed", ({ sessionId: sid, firstUserMessage }) => {
      if (sid !== sessionId) return;
      const name = formatSessionName(firstUserMessage);
      if (name) {
        this.sendReply(userId, `📝 会话已命名: ${name}`);
      }
    });
    cleanups.push(unsubFirstTurn);

    // ── NEW: git branch change notification ──
    const unsubGitInfo = companionBus.on("session:git-info-ready", ({ sessionId: sid, branch }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      if (!relayData) return;
      if (relayData.lastGitBranch && relayData.lastGitBranch !== branch) {
        this.sendReply(userId, `🔀 分支切换: ${relayData.lastGitBranch} → ${branch}`);
      }
      relayData.lastGitBranch = branch;
    });
    cleanups.push(unsubGitInfo);

    // ── NEW: idle kill notification ──
    const unsubIdleKill = companionBus.on("session:idle-kill", ({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      this.cleanupRelay(sessionId);
      this.removeSessionFromUser(userId, sessionId);
      this.sendReply(userId, `⏰ 会话 ${sessionId.slice(0, 8)}... 因长时间无活动已自动关闭。\n发送 /new 创建新会话。`);
    });
    cleanups.push(unsubIdleKill);

    // ── NEW: relaunch notification (CLI reconnection) ──
    const unsubRelaunch = companionBus.on("session:relaunch-needed", ({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      this.sendReply(userId, "🔄 会话正在重新连接...");
    });
    cleanups.push(unsubRelaunch);

    // ── NEW: rate_limit_event ──
    const unsubRateLimit = companionBus.on("message:rate_limit_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const formatted = formatRateLimitEvent(message as Record<string, unknown>);
      if (formatted) {
        this.sendReply(userId, formatted);
      }
    });
    cleanups.push(unsubRateLimit);

    this.sessionCleanups.set(sessionId, cleanups);
  }

  private cleanupRelay(sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (relayData) {
      // Flush any buffered tool notifications before cleaning up
      if (relayData.toolNotifyBuffer.length > 0) {
        const userId = this.userIdBySession.get(sessionId);
        if (userId) this.flushToolNotifyBuffer(userId, sessionId);
      }
      if (relayData.toolNotifyTimer) {
        clearTimeout(relayData.toolNotifyTimer);
      }
    }
    const cleanups = this.sessionCleanups.get(sessionId);
    if (cleanups) {
      for (const cleanup of cleanups) cleanup();
      this.sessionCleanups.delete(sessionId);
    }
    this.sessionRelayData.delete(sessionId);
  }

  /** Flush pending tool notification buffer to WeChat. */
  private flushToolNotifyBuffer(userId: string, sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (!relayData || relayData.toolNotifyBuffer.length === 0) return;
    const merged = relayData.toolNotifyBuffer.join("\n");
    relayData.toolNotifyBuffer = [];
    relayData.toolNotifyTimer = null;
    this.sendReply(userId, merged);
  }

  /**
   * Handle a single permission request from the CLI.
   * This fires for EVERY permission request, before AI validation in ws-bridge.
   * The WeChat bridge gets first crack at handling permissions.
   */
  private handlePermissionRequest(
    sessionId: string,
    userId: string,
    perm: {
      request_id: string;
      tool_name: string;
      input: Record<string, unknown>;
      description?: string;
      agent_id?: string;
    },
  ): void {
    const settings = getSettings();
    const userSession = this.userSessions.get(userId);
    if (!userSession) {
      console.warn(`[wechat] No userSession for userId=${userId}, sessionId=${sessionId} — permission request from ${perm.agent_id ? "subagent" : "main"} dropped: ${perm.tool_name}`);
      return;
    }

    const agentLabel = perm.agent_id ? "[子任务] " : "";

    // AskUserQuestion: track in both Maps, show first question
    if (perm.tool_name === "AskUserQuestion") {
      const questions = Array.isArray(perm.input.questions) ? perm.input.questions as Array<Record<string, unknown>> : [];
      userSession.pendingAskQuestions.set(perm.request_id, {
        requestId: perm.request_id,
        sessionId,
        questions,
        currentIndex: 0,
        answers: {},
        agentId: perm.agent_id,
      });
      userSession.pendingPermissions.set(perm.request_id, {
        requestId: perm.request_id,
        sessionId,
        toolName: perm.tool_name,
        agentId: perm.agent_id,
        isAskUserQuestion: true,
        createdAt: Date.now(),
      });
      this.sendReply(userId, `${agentLabel}${formatSingleQuestion(questions, 0)}`);
      return;
    }

    if (settings.wechatAutoApproveSafe && !isDangerousTool(perm.tool_name, perm.input)) {
      // Auto-approve safe tools (Read, Glob, Grep, etc.)
      // pendingPermissions is already set by ws-bridge before emitting the event
      this.wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
      const formatted = formatToolCall(perm.tool_name, perm.input);
      this.sendReply(userId, formatted ? `✅ 自动批准: ${agentLabel}${formatted}` : `✅ 自动批准: ${agentLabel}${perm.tool_name}`);
    } else if (settings.wechatForwardDangerous) {
      // Forward to WeChat for approval — do NOT auto-approve
      userSession.pendingPermissions.set(perm.request_id, {
        requestId: perm.request_id,
        sessionId,
        toolName: perm.tool_name,
        agentId: perm.agent_id,
        isAskUserQuestion: false,
        createdAt: Date.now(),
      });
      this.sendReply(userId, `${agentLabel}${formatPermissionRequest(perm.tool_name, perm.input, perm.description)}`);
    } else {
      // Auto-approve everything (bypassPermissions mode)
      this.wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
    }
  }

  // ── Session Mapping ───────────────────────────────────────────────────

  private getOrCreateUserSession(userId: string): WeChatUserSession {
    let userSession = this.userSessions.get(userId);
    if (!userSession) {
      userSession = {
        sessionIds: [],
        activeSessionIndex: 0,
        pendingPermissions: new Map(),
        verboseMode: false,
        thinkingMode: false,
        pendingAskQuestions: new Map(),
      };
      this.userSessions.set(userId, userSession);
    }
    return userSession;
  }

  private removeSessionFromUser(userId: string, sessionId: string): void {
    const userSession = this.userSessions.get(userId);
    if (!userSession) return;
    const idx = userSession.sessionIds.indexOf(sessionId);
    if (idx >= 0) {
      userSession.sessionIds.splice(idx, 1);
      this.cleanupRelay(sessionId);
      this.userIdBySession.delete(sessionId);
      if (userSession.sessionIds.length === 0) {
        userSession.activeSessionIndex = 0;
      } else if (userSession.activeSessionIndex >= userSession.sessionIds.length) {
        userSession.activeSessionIndex = userSession.sessionIds.length - 1;
      }
    }
    // Purge orphaned permission/AskUserQuestion entries referencing the removed session
    for (const [key, val] of userSession.pendingPermissions) {
      if (val.sessionId === sessionId) userSession.pendingPermissions.delete(key);
    }
    for (const [key, val] of userSession.pendingAskQuestions) {
      if (val.sessionId === sessionId) userSession.pendingAskQuestions.delete(key);
    }
    this.persistSessionMappings();
  }

  private getActiveSessionId(userId: string): string | null {
    const userSession = this.userSessions.get(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      this.sendReply(userId, "No active session. Send /new to create one.");
      return null;
    }
    return userSession.sessionIds[userSession.activeSessionIndex] ?? null;
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private restoreSessionMappings(): void {
    try {
      if (!existsSync(PERSIST_PATH)) return;
      const data = JSON.parse(readFileSync(PERSIST_PATH, "utf-8")) as Record<string, PersistedMapping>;
      for (const [userId, mapping] of Object.entries(data)) {
        this.userSessions.set(userId, {
          sessionIds: mapping.sessionIds,
          activeSessionIndex: mapping.activeSessionIndex,
          pendingPermissions: new Map(),
          verboseMode: mapping.verboseMode ?? false,
          thinkingMode: mapping.thinkingMode ?? false,
          pendingAskQuestions: new Map(),
        });
        for (const sid of mapping.sessionIds) {
          this.userIdBySession.set(sid, userId);
        }
      }
      console.log(`[wechat] Restored ${this.userSessions.size} user session mappings`);
    } catch (err) {
      console.error("[wechat] Failed to restore session mappings:", err);
    }
  }

  private persistSessionMappings(): void {
    try {
      const data: Record<string, PersistedMapping> = {};
      for (const [userId, userSession] of this.userSessions) {
        data[userId] = {
          sessionIds: userSession.sessionIds,
          activeSessionIndex: userSession.activeSessionIndex,
          verboseMode: userSession.verboseMode,
          thinkingMode: userSession.thinkingMode,
        };
      }
      mkdirSync(COMPANION_HOME, { recursive: true });
      writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[wechat] Failed to persist session mappings:", err);
    }
  }

  // ── WeChat Send Helpers ───────────────────────────────────────────────

  /**
   * Queue a message for delivery. All sends are serialized through a FIFO queue
   * so that concurrent fire-and-forget calls (tool notifications + result text)
   * don't overwhelm the WeChat SDK and silently drop messages.
   */
  private sendReply(userId: string, text: string): void {
    const chunks = splitForWeChat(text);
    for (const chunk of chunks) {
      this.sendQueue.push({ userId, text: chunk });
    }
    this.drainSendQueue();
  }

  /** Process the send queue one message at a time. */
  private async drainSendQueue(): Promise<void> {
    if (this.sending) return; // already draining
    this.sending = true;
    try {
      while (this.sendQueue.length > 0) {
        const item = this.sendQueue.shift()!;
        if (!this.bot?.isRunning) {
          console.warn("[wechat] Bot not running, requeuing message");
          this.sendQueue.unshift(item);
          // Retry after a delay — if bot stays down, the next drain call
          // (triggered by sendReply or bot reconnect) will pick it up.
          setTimeout(() => this.drainSendQueue(), 5_000);
          return;
        }
        const maxRetries = 2;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            await this.bot.send(item.userId, item.text);
            break; // success
          } catch (err) {
            if (attempt < maxRetries) {
              console.warn(`[wechat] Send failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`, err);
              await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
            } else {
              console.error(`[wechat] Send failed after ${maxRetries + 1} attempts, dropping:`, err);
            }
          }
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendTyping(userId: string): Promise<void> {
    if (!this.bot?.isRunning) return;
    try {
      await this.bot.sendTyping(userId);
    } catch {
      // Typing indicator is best-effort
    }
  }

  // ── Public API for routes ─────────────────────────────────────────────

  getStatus(): { running: boolean; starting: boolean; error: string | null; connectedUsers: number; qrCode: string | null; reconnecting: boolean } {
    return {
      running: this.running,
      starting: this.starting,
      error: this.startError,
      connectedUsers: this.userSessions.size,
      qrCode: this.qrCodeData,
      reconnecting: this.reconnectTimer !== null,
    };
  }

  getSessions(): Array<{ userId: string; activeSession: string | null; sessionCount: number }> {
    return Array.from(this.userSessions.entries()).map(([userId, us]) => ({
      userId,
      activeSession: us.sessionIds[us.activeSessionIndex] ?? null,
      sessionCount: us.sessionIds.length,
    }));
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    const userSession = this.userSessions.get(userId);
    if (!userSession) return;
    for (const sid of userSession.sessionIds) {
      try {
        await this.orchestrator.killSession(sid);
      } catch {
        // ignore
      }
      this.cleanupRelay(sid);
      this.userIdBySession.delete(sid);
    }
    this.userSessions.delete(userId);
    this.persistSessionMappings();
  }
}
