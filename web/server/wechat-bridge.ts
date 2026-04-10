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
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary, formatToolCallFailure, formatAskUserQuestion } from "./wechat-formatter.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermission: { requestId: string; sessionId: string } | null;
  verboseMode: boolean;
  pendingAskQuestion: {
    requestId: string;
    sessionId: string;
    questions: Array<Record<string, unknown>>;
    currentIndex: number;
    answers: Record<string, string>;
  } | null;
}

interface PersistedMapping {
  sessionIds: string[];
  activeSessionIndex: number;
  verboseMode?: boolean;
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

/new [folder] — Create a new session (optionally in a subfolder)
/sessions — List your sessions
/switch <n> — Switch to session #n
/kill — Kill active session
/model <name> — Switch model
/mode <mode> — Set permission mode
/allow (or /y) — Approve pending permission
/deny (or /n) — Deny pending permission
/interrupt — Cancel current operation
/status — Show session status
/dir [path] — List folders in default directory
/verbose — Toggle tool notification mode (batch/verbose)
/help — Show this help

Other /commands (e.g. /compact, /clear) are forwarded to Claude Code.
Plain text is also sent to the active session.`;

// ── Helpers ────────────────────────────────────────────────────────────────

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

    // Check for pending AskUserQuestion — number response selects option
    const userSession = this.userSessions.get(userId);
    if (userSession?.pendingAskQuestion) {
      const pending = userSession.pendingAskQuestion;
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
      await this.sendReply(userId, `✅ 已选择: ${selectedLabel}`);

      // Advance to next question or submit all answers
      const nextIndex = pending.currentIndex + 1;
      if (nextIndex < pending.questions.length) {
        // More questions — show the next one
        pending.currentIndex = nextIndex;
        this.sendReply(userId, formatSingleQuestion(pending.questions, nextIndex));
      } else {
        // All questions answered — submit
        userSession.pendingAskQuestion = null;
        userSession.pendingPermission = null;
        this.wsBridge.injectPermissionResponse(pending.sessionId, pending.requestId, "allow", {
          questions: pending.questions,
          answers: pending.answers,
        });
      }
      return;
    }

    const parsed = parseCommand(text.trim());

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
      case "help":
        await this.sendReply(userId, HELP_TEXT);
        break;
      default:
        // Forward unknown /commands to the active Claude Code session
        // (e.g. /compact, /clear, /help from Claude Code itself)
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
      details.push(`ctx: ${(state.context_used_percent ?? 0).toFixed(0)}%`);
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
    if (!userSession?.pendingPermission) {
      await this.sendReply(userId, "No pending permission request. Tool calls shown with ℹ️ are informational and don't need approval.");
      return;
    }

    const { requestId, sessionId } = userSession.pendingPermission;
    userSession.pendingPermission = null;

    this.wsBridge.injectPermissionResponse(sessionId, requestId, behavior);
    await this.sendReply(userId, `Permission ${behavior === "allow" ? "approved" : "denied"}.`);
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
      `Context: ${(state.context_used_percent ?? 0).toFixed(0)}%`,
      `CWD: ${state.cwd}`,
      `Branch: ${state.git_branch || "none"}`,
      `Pending permissions: ${pendingPerms}`,
      `工具通知: ${(userSession?.verboseMode ?? false) ? "逐条" : "批量"}`,
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
    this.sessionRelayData.set(sessionId, { pendingText: "", lastTypingTs: 0, streamlinedSent: false, contentSent: false, lastBlockIndex: -1, toolAccumulator: [], lastUserFacingMessageTs: Date.now(), progressSent: false, toolNotifyBuffer: [], toolNotifyTimer: null });

    // Stream events — accumulate text
    const unsubStream = companionBus.on("message:stream_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const delta = extractTextDeltaFromStreamEvent(message);
      if (!delta) return;
      const relayData = this.sessionRelayData.get(sessionId);
      if (relayData) {
        // Add separator when content block index changes (multi-step agent loop)
        const event = (message as Record<string, unknown>).event as Record<string, unknown> | undefined;
        const blockIndex = typeof event?.index === "number" ? event.index : -1;
        if (relayData.lastBlockIndex >= 0 && blockIndex >= 0 && blockIndex !== relayData.lastBlockIndex && relayData.pendingText.length > 0) {
          relayData.pendingText += "\n\n";
        }
        if (blockIndex >= 0) {
          relayData.lastBlockIndex = blockIndex;
        }
        relayData.pendingText += delta;
        relayData.contentSent = true;
        // Throttle typing indicator to every 5 seconds
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

      // Fallback: if stream events didn't capture text, use assistant message text instead
      const relayData = this.sessionRelayData.get(sessionId);
      if (relayData && !relayData.pendingText.trim()) {
        const assistantText = extractTextFromAssistant(message);
        if (assistantText.trim()) {
          relayData.pendingText = assistantText.trim();
        }
      }

      // Extract and route tool calls to user notifications
      const tools = extractToolUses(message);
      if (tools.length > 0) {
        const userSession = this.userSessions.get(userId);
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
          if (verboseMode) {
            this.sendReply(userId, formatted);
          } else {
            if (relayData) {
              relayData.toolNotifyBuffer.push(formatted);
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
        relayData.pendingText = "";
        relayData.streamlinedSent = false;
        relayData.contentSent = false;
        relayData.lastBlockIndex = -1;
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

      // Reset tool accumulator and timestamp for next turn
      if (relayData) {
        relayData.toolAccumulator = [];
        relayData.lastUserFacingMessageTs = Date.now();
        relayData.progressSent = false;
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

    // Permission cancelled — clear stale pendingPermission state
    const unsubPermCancel = companionBus.on("session:permission-cancelled", ({ sessionId: sid, requestId }) => {
      if (sid !== sessionId) return;
      const userSession = this.userSessions.get(userId);
      if (userSession?.pendingPermission?.requestId === requestId) {
        userSession.pendingPermission = null;
        userSession.pendingAskQuestion = null;
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

    this.sessionCleanups.set(sessionId, cleanups);
  }

  private cleanupRelay(sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (relayData?.toolNotifyTimer) {
      clearTimeout(relayData.toolNotifyTimer);
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
    perm: { request_id: string; tool_name: string; input: Record<string, unknown>; description?: string },
  ): void {
    const settings = getSettings();
    const userSession = this.userSessions.get(userId);
    if (!userSession) return;

    // AskUserQuestion: format as numbered options, track pending state for response
    if (perm.tool_name === "AskUserQuestion") {
      const questions = Array.isArray(perm.input.questions) ? perm.input.questions as Array<Record<string, unknown>> : [];
      userSession.pendingAskQuestion = {
        requestId: perm.request_id,
        sessionId,
        questions,
        currentIndex: 0,
        answers: {},
      };
      userSession.pendingPermission = { requestId: perm.request_id, sessionId };
      // Show only the first question (subsequent ones shown after each answer)
      this.sendReply(userId, formatSingleQuestion(questions, 0));
      return;
    }

    if (settings.wechatAutoApproveSafe && !isDangerousTool(perm.tool_name, perm.input)) {
      // Auto-approve safe tools (Read, Glob, Grep, etc.)
      // pendingPermissions is already set by ws-bridge before emitting the event
      this.wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
      const formatted = formatToolCall(perm.tool_name, perm.input);
      this.sendReply(userId, formatted ? `✅ 自动批准: ${formatted}` : `✅ 自动批准: ${perm.tool_name}`);
    } else if (settings.wechatForwardDangerous) {
      // Forward to WeChat for approval — do NOT auto-approve
      userSession.pendingPermission = { requestId: perm.request_id, sessionId };
      this.sendReply(userId, formatPermissionRequest(perm.tool_name, perm.input, perm.description));
    } else {
      // Auto-approve everything (bypassPermissions mode)
      this.wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
    }
  }

  // ── Session Mapping ───────────────────────────────────────────────────

  private getOrCreateUserSession(userId: string): WeChatUserSession {
    let userSession = this.userSessions.get(userId);
    if (!userSession) {
      userSession = { sessionIds: [], activeSessionIndex: 0, pendingPermission: null, verboseMode: false, pendingAskQuestion: null };
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
          pendingPermission: null,
          verboseMode: mapping.verboseMode ?? false,
          pendingAskQuestion: null,
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
        const { userId, text } = this.sendQueue.shift()!;
        if (!this.bot?.isRunning) {
          console.warn("[wechat] Bot not running, dropping queued message");
          continue;
        }
        try {
          await this.bot.send(userId, text);
        } catch (err) {
          console.error("[wechat] Failed to send reply:", err);
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
