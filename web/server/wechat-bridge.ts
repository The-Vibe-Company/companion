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

// ── Types ──────────────────────────────────────────────────────────────────

interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermission: { requestId: string; sessionId: string } | null;
}

interface PersistedMapping {
  sessionIds: string[];
  activeSessionIndex: number;
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

const DANGEROUS_BASH_PATTERN = /rm\s|rm$|rmdir|mkfs|dd\s|>\s*\/dev|chmod\s|chown\s|shutdown|reboot/i;

const WECHAT_MSG_LIMIT = 4000;

const PERSIST_PATH = join(COMPANION_HOME, "wechat-sessions.json");

const HELP_TEXT = `Companion WeChat Bot Commands:

/new [folder] — Create a new session (optionally in a subfolder)
/sessions — List your sessions
/switch <n> — Switch to session #n
/kill — Kill active session
/model <name> — Switch model
/mode <mode> — Set permission mode
/allow — Approve pending permission
/deny — Deny pending permission
/interrupt — Cancel current operation
/status — Show session status
/dir [path] — List folders in default directory
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

/** Check if a tool use is considered dangerous. */
export function isDangerousTool(toolName: string, input: Record<string, unknown>): boolean {
  if (SAFE_TOOLS.has(toolName)) return false;
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    return DANGEROUS_BASH_PATTERN.test(cmd);
  }
  // Write, Edit, Agent, and unknown tools are considered dangerous
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
function extractToolUses(msg: BrowserIncomingMessage): Array<{ name: string; input: string }> {
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
      input: toolBlock.input ? JSON.stringify(toolBlock.input).slice(0, 200) : "",
    }));
}

/** Split text into WeChat-safe chunks */
function splitForWeChat(text: string): string[] {
  if (text.length <= WECHAT_MSG_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= WECHAT_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }
    // Try to split at paragraph boundary
    let splitAt = remaining.lastIndexOf("\n\n", WECHAT_MSG_LIMIT);
    if (splitAt < WECHAT_MSG_LIMIT * 0.5) {
      // Try newline
      splitAt = remaining.lastIndexOf("\n", WECHAT_MSG_LIMIT);
    }
    if (splitAt < WECHAT_MSG_LIMIT * 0.5) {
      // Hard split
      splitAt = WECHAT_MSG_LIMIT;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
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
  private sessionRelayData = new Map<string, { pendingText: string; lastTypingTs: number }>();
  private userIdBySession = new Map<string, string>();
  // QR code data for web UI display
  private qrCodeData: string | null = null;

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
    });

    this.running = true;
    this.starting = false;
    this.qrCodeData = null;
    console.log("[wechat] Bot started and connected");
  }

  stop(): void {
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
        await this.cmdPermissionResponse(userId, "allow");
        break;
      case "deny":
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
      const phaseEmoji = phase === "idle" ? "🟢" : phase === "responding" ? "🔵" : phase === "awaiting_permission" ? "🟡" : "⚪";

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
      await this.sendReply(userId, "No pending permission request.");
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
    this.sessionRelayData.set(sessionId, { pendingText: "", lastTypingTs: 0 });

    // Stream events — accumulate text
    const unsubStream = companionBus.on("message:stream_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const delta = extractTextDeltaFromStreamEvent(message);
      if (!delta) return;
      const relayData = this.sessionRelayData.get(sessionId);
      if (relayData) {
        relayData.pendingText += delta;
        // Throttle typing indicator to every 5 seconds
        const now = Date.now();
        if (now - relayData.lastTypingTs > 5000) {
          relayData.lastTypingTs = now;
          this.sendTyping(userId).catch(() => {});
        }
      }
    });
    cleanups.push(unsubStream);

    // Assistant messages — extract tool uses only (text is already captured via stream events)
    const unsubAssistant = companionBus.on("message:assistant", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      // Report tool uses
      const tools = extractToolUses(message);
      if (tools.length > 0) {
        const toolSummary = tools
          .map((t) => `🔧 ${t.name}${t.input ? `: ${t.input.slice(0, 100)}` : ""}`)
          .join("\n");
        this.sendReply(userId, toolSummary).catch(() => {});
      }
    });
    cleanups.push(unsubAssistant);

    // Result — send accumulated response
    const unsubResult = companionBus.on("message:result", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      const text = relayData?.pendingText ?? "";
      if (relayData) relayData.pendingText = "";

      const result = message as Record<string, unknown>;
      const data = result.data as Record<string, unknown> | undefined;

      // Send the accumulated streaming text
      if (text.trim()) {
        const chunks = splitForWeChat(text.trim());
        for (const chunk of chunks) {
          this.sendReply(userId, chunk).catch(() => {});
        }
      } else if (typeof data?.result === "string" && data.result.trim()) {
        // Slash commands (e.g. /cost, /compact) return their response directly
        // in data.result without streaming — send it when no stream text was captured.
        const chunks = splitForWeChat(data.result.trim());
        for (const chunk of chunks) {
          this.sendReply(userId, chunk).catch(() => {});
        }
      }

      // Check for errors
      if (data?.is_error) {
        const errors = data.errors as string[] | undefined;
        if (errors?.length) {
          this.sendReply(userId, `Error: ${errors.join(", ")}`).catch(() => {});
        }
      }
    });
    cleanups.push(unsubResult);

    // Permission requests — auto-approve safe, forward dangerous
    const unsubPhase = companionBus.on("session:phase-changed", ({ sessionId: sid, to }) => {
      if (sid !== sessionId) return;
      if (to === "awaiting_permission") {
        this.handlePendingPermissions(sessionId, userId);
      }
    });
    cleanups.push(unsubPhase);

    // Session exited
    const unsubExited = companionBus.on("session:exited", ({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      this.cleanupRelay(sessionId);
      this.removeSessionFromUser(userId, sessionId);
      this.sendReply(userId, `Session ${sessionId.slice(0, 8)}... exited.`).catch(() => {});
    });
    cleanups.push(unsubExited);

    this.sessionCleanups.set(sessionId, cleanups);
  }

  private cleanupRelay(sessionId: string): void {
    const cleanups = this.sessionCleanups.get(sessionId);
    if (cleanups) {
      for (const cleanup of cleanups) cleanup();
      this.sessionCleanups.delete(sessionId);
    }
    this.sessionRelayData.delete(sessionId);
  }

  private handlePendingPermissions(sessionId: string, userId: string): void {
    const session = this.wsBridge.getSession(sessionId);
    if (!session) return;

    const settings = getSettings();
    const userSession = this.userSessions.get(userId);
    if (!userSession) return;

    for (const [requestId, perm] of session.pendingPermissions) {
      if (settings.wechatAutoApproveSafe && !isDangerousTool(perm.tool_name, perm.input)) {
        // Auto-approve safe tools
        this.wsBridge.injectPermissionResponse(sessionId, requestId, "allow", perm.input);
        this.sendReply(userId, `Auto-approved: ${perm.tool_name}`).catch(() => {});
      } else if (settings.wechatForwardDangerous) {
        // Forward to WeChat for approval
        userSession.pendingPermission = { requestId, sessionId };
        const desc = perm.description ?? perm.tool_name;
        const inputStr = JSON.stringify(perm.input).slice(0, 300);
        this.sendReply(userId, `⚠️ Permission needed:\nTool: ${perm.tool_name}\n${desc ? `Description: ${desc}\n` : ""}Input: ${inputStr}\n\nSend /allow or /deny`).catch(() => {});
      } else {
        // Auto-approve everything (bypassPermissions mode)
        this.wsBridge.injectPermissionResponse(sessionId, requestId, "allow", perm.input);
      }
    }
  }

  // ── Session Mapping ───────────────────────────────────────────────────

  private getOrCreateUserSession(userId: string): WeChatUserSession {
    let userSession = this.userSessions.get(userId);
    if (!userSession) {
      userSession = { sessionIds: [], activeSessionIndex: 0, pendingPermission: null };
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
      this.sendReply(userId, "No active session. Send /new to create one.").catch(() => {});
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
        };
      }
      mkdirSync(COMPANION_HOME, { recursive: true });
      writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[wechat] Failed to persist session mappings:", err);
    }
  }

  // ── WeChat Send Helpers ───────────────────────────────────────────────

  private async sendReply(userId: string, text: string): Promise<void> {
    if (!this.bot?.isRunning) return;
    try {
      // Smart split via SDK is preferred, but we pre-split for safety
      const chunks = splitForWeChat(text);
      for (const chunk of chunks) {
        await this.bot.send(userId, chunk);
      }
    } catch (err) {
      console.error("[wechat] Failed to send reply:", err);
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

  getStatus(): { running: boolean; starting: boolean; error: string | null; connectedUsers: number; qrCode: string | null } {
    return {
      running: this.running,
      starting: this.starting,
      error: this.startError,
      connectedUsers: this.userSessions.size,
      qrCode: this.qrCodeData,
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
