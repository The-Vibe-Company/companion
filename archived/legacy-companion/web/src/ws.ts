import { useStore } from "./store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, ContentBlock, ChatMessage, TaskItem, ProcessItem, ProcessStatus, SdkSessionInfo, McpServerConfig, BackgroundAgentItem } from "./types.js";
import { generateUniqueSessionName } from "./utils/names.js";
import { playNotificationSound } from "./utils/notification-sound.js";
import { getPreview } from "./components/ToolBlock.js";
import type { ToolActivityEntry } from "./store/tasks-slice.js";

const WS_RECONNECT_DELAY_MS = 2000;
const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSeqBySession = new Map<string, number>();
const taskCounters = new Map<string, number>();
const streamingPhaseBySession = new Map<string, "thinking" | "text">();
const streamingDraftMessageIdBySession = new Map<string, string>();
const pendingOutgoingBySession = new Map<string, BrowserOutgoingMessage[]>();
/** Track processed tool_use IDs to prevent duplicate task creation */
const processedToolUseIds = new Map<string, Set<string>>();

function isSocketUsable(ws: WebSocket | undefined): boolean {
  return !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function shouldReconnectSession(sessionId: string): boolean {
  const store = useStore.getState();
  const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
  if (sdkSession) return !sdkSession.archived;
  // Fallback for freshly-created sessions that may not be in sdkSessions yet.
  return store.currentSessionId === sessionId;
}

function getReconnectCandidates(): string[] {
  const store = useStore.getState();
  const ids = new Set<string>();
  for (const s of store.sdkSessions) {
    if (!s.archived) ids.add(s.sessionId);
  }
  if (store.currentSessionId) ids.add(store.currentSessionId);
  return Array.from(ids);
}

// ── Page visibility handling ─────────────────────────────────────────────────
// Mobile browsers (Android Chrome, iOS Safari) aggressively kill WebSocket
// connections when the page is backgrounded. Without this handler, the frontend
// enters a rapid connect/disconnect cycle: WS opens, browser kills it, 2s
// reconnect timer fires, WS opens again, browser kills it again...
//
// Solution: when the page becomes hidden, pause all reconnect attempts. When
// the page becomes visible again, immediately reconnect all active sessions.
let pageHidden = typeof document !== "undefined" ? document.hidden : false;

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pageHidden = true;
      // Cancel all pending reconnect timers — no point reconnecting while hidden
      for (const [sessionId, timer] of reconnectTimers) {
        clearTimeout(timer);
        reconnectTimers.delete(sessionId);
      }
    } else {
      pageHidden = false;
      // Page is visible again — reconnect all known active sessions.
      for (const sessionId of getReconnectCandidates()) {
        // Re-check in case sdkSessions changed after candidate collection.
        if (!shouldReconnectSession(sessionId)) continue;
        const ws = sockets.get(sessionId);
        if (!isSocketUsable(ws)) {
          if (ws) {
            try { ws.close(); } catch {}
            sockets.delete(sessionId);
          }
          connectSession(sessionId);
        }
      }
    }
  });
}

function normalizePath(path: string): string {
  const isAbs = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

function resolveSessionFilePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith("/")) return normalizePath(filePath);
  if (!cwd) return normalizePath(filePath);
  return normalizePath(`${cwd}/${filePath}`);
}

function isPathInSessionScope(filePath: string, cwd?: string): boolean {
  if (!cwd) return true;
  const normalizedCwd = normalizePath(cwd);
  return filePath === normalizedCwd || filePath.startsWith(`${normalizedCwd}/`);
}

function getProcessedSet(sessionId: string): Set<string> {
  let set = processedToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    processedToolUseIds.set(sessionId, set);
  }
  return set;
}

function extractTasksFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const processed = getProcessedSet(sessionId);

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input, id: toolUseId } = block;

    // Deduplicate by tool_use_id
    if (toolUseId) {
      if (processed.has(toolUseId)) continue;
      processed.add(toolUseId);
    }

    // TodoWrite: full replacement — { todos: [{ content, status, activeForm }] }
    if (name === "TodoWrite") {
      const todos = input.todos as { content?: string; status?: string; activeForm?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const tasks: TaskItem[] = todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content || "Task",
          description: "",
          activeForm: t.activeForm,
          status: (t.status as TaskItem["status"]) || "pending",
        }));
        store.setTasks(sessionId, tasks);
        taskCounters.set(sessionId, tasks.length);
      }
      continue;
    }

    // TaskCreate: incremental add — { subject, description, activeForm }
    if (name === "TaskCreate") {
      const count = (taskCounters.get(sessionId) || 0) + 1;
      taskCounters.set(sessionId, count);
      const task = {
        id: String(count),
        subject: (input.subject as string) || "Task",
        description: (input.description as string) || "",
        activeForm: input.activeForm as string | undefined,
        status: "pending" as const,
      };
      store.addTask(sessionId, task);
      continue;
    }

    // TaskUpdate: incremental update — { taskId, status, owner, activeForm, addBlockedBy }
    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<TaskItem> = {};
        if (input.status) updates.status = input.status as TaskItem["status"];
        if (input.owner) updates.owner = input.owner as string;
        if (input.activeForm !== undefined) updates.activeForm = input.activeForm as string;
        if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy as string[];
        store.updateTask(sessionId, taskId, updates);
      }
    }
  }
}

function extractChangedFilesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const sessionCwd =
    store.sessions.get(sessionId)?.cwd ||
    store.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd;
  let dirty = false;
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input } = block;
    if ((name === "Edit" || name === "Write") && typeof input.file_path === "string") {
      const resolvedPath = resolveSessionFilePath(input.file_path, sessionCwd);
      if (isPathInSessionScope(resolvedPath, sessionCwd)) {
        dirty = true;
      }
    }
  }
  if (dirty) store.bumpChangedFilesTick(sessionId);
}

/** Pending background Bash calls awaiting their tool_result (keyed by sessionId → toolUseId) */
const pendingBackgroundBash = new Map<string, Map<string, { command: string; description: string; startedAt: number }>>();

const BG_RESULT_REGEX = /Command running in background with ID:\s*(\S+)\.\s*Output is being written to:\s*(\S+)/;

function extractProcessesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();

  for (const block of blocks) {
    // Phase 1: Detect Bash tool_use with run_in_background
    if (block.type === "tool_use" && block.name === "Bash") {
      const input = block.input as Record<string, unknown>;
      if (input.run_in_background === true) {
        let sessionPending = pendingBackgroundBash.get(sessionId);
        if (!sessionPending) {
          sessionPending = new Map();
          pendingBackgroundBash.set(sessionId, sessionPending);
        }
        sessionPending.set(block.id, {
          command: (input.command as string) || "",
          description: (input.description as string) || "",
          startedAt: Date.now(),
        });
      }
    }

    // Phase 2: Match tool_result to a pending background Bash
    if (block.type === "tool_result") {
      const toolUseId = block.tool_use_id;
      const sessionPending = pendingBackgroundBash.get(sessionId);
      const pending = sessionPending?.get(toolUseId);
      if (sessionPending && pending) {
        const content = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
            : "";

        const match = content.match(BG_RESULT_REGEX);
        if (match) {
          const processItem: ProcessItem = {
            taskId: match[1],
            toolUseId,
            command: pending.command,
            description: pending.description,
            outputFile: match[2],
            status: "running",
            startedAt: pending.startedAt,
          };
          store.addProcess(sessionId, processItem);
        }

        sessionPending.delete(toolUseId);
        if (sessionPending.size === 0) {
          pendingBackgroundBash.delete(sessionId);
        }
      }
    }
  }
}

/** Pending background Agent calls awaiting their tool_result */
const pendingBackgroundAgents = new Map<string, Map<string, { name: string; description: string; agentType: string; startedAt: number }>>();
/** Separate dedup set for background agents (shared processedToolUseIds is consumed by task extraction) */
const processedAgentIds = new Map<string, Set<string>>();

function extractBackgroundAgentsFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  let agentProcessed = processedAgentIds.get(sessionId);
  if (!agentProcessed) {
    agentProcessed = new Set();
    processedAgentIds.set(sessionId, agentProcessed);
  }

  for (const block of blocks) {
    // Phase 1: Detect Agent tool_use with run_in_background
    if (block.type === "tool_use" && block.name === "Agent") {
      if (block.id && agentProcessed.has(block.id)) continue;
      const input = block.input as Record<string, unknown>;
      if (input.run_in_background === true) {
        if (block.id) agentProcessed.add(block.id);
        let sessionPending = pendingBackgroundAgents.get(sessionId);
        if (!sessionPending) {
          sessionPending = new Map();
          pendingBackgroundAgents.set(sessionId, sessionPending);
        }
        const agentItem: BackgroundAgentItem = {
          toolUseId: block.id,
          name: (input.name as string) || (input.description as string) || "Background agent",
          description: (input.description as string) || "",
          agentType: (input.subagent_type as string) || "general-purpose",
          status: "running",
          startedAt: Date.now(),
        };
        sessionPending.set(block.id, {
          name: agentItem.name,
          description: agentItem.description,
          agentType: agentItem.agentType,
          startedAt: agentItem.startedAt,
        });
        store.addBackgroundAgent(sessionId, agentItem);
      }
    }

    // Phase 2: Match tool_result to a pending background Agent
    if (block.type === "tool_result") {
      const toolUseId = block.tool_use_id;
      const sessionPending = pendingBackgroundAgents.get(sessionId);
      const pending = sessionPending?.get(toolUseId);
      if (sessionPending && pending) {
        const content = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
            : "";
        const isError = block.is_error === true;
        store.updateBackgroundAgent(sessionId, toolUseId, {
          status: isError ? "failed" : "completed",
          completedAt: Date.now(),
          summary: content.length > 200 ? content.slice(0, 200) + "..." : content,
        });
        sessionPending.delete(toolUseId);
        if (sessionPending.size === 0) {
          pendingBackgroundAgents.delete(sessionId);
        }
      }
    }
  }
}

function sendBrowserNotification(title: string, body: string, tag: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, tag });
}

function summarizeSystemEvent(
  event: Extract<BrowserIncomingMessage, { type: "system_event" }>["event"],
): string | null {
  if (event.subtype === "compact_boundary") {
    return `Context compacted (${event.compact_metadata.trigger}, pre-tokens: ${event.compact_metadata.pre_tokens}).`;
  }

  if (event.subtype === "task_notification") {
    const summary = event.summary ? ` ${event.summary}` : "";
    return `Task ${event.status}: ${event.task_id}.${summary}`;
  }

  if (event.subtype === "files_persisted") {
    const persisted = event.files.length;
    const failed = event.failed.length;
    if (failed > 0) {
      return `Persisted ${persisted} file(s), ${failed} failed.`;
    }
    return `Persisted ${persisted} file(s).`;
  }

  if (event.subtype === "hook_started") {
    return `Hook started: ${event.hook_name} (${event.hook_event}).`;
  }

  if (event.subtype === "hook_response") {
    const exitCode = typeof event.exit_code === "number" ? ` (exit ${event.exit_code})` : "";
    return `Hook ${event.outcome}: ${event.hook_name} (${event.hook_event})${exitCode}.`;
  }

  // hook_progress can be high-volume; keep it out of chat by default.
  return null;
}

let idCounter = 0;
let clientMsgCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

function enqueueOutgoing(sessionId: string, msg: BrowserOutgoingMessage) {
  const queued = pendingOutgoingBySession.get(sessionId) || [];
  queued.push(msg);
  pendingOutgoingBySession.set(sessionId, queued);
}

function flushQueuedOutgoing(sessionId: string, ws: WebSocket) {
  const queued = pendingOutgoingBySession.get(sessionId);
  if (!queued?.length || ws.readyState !== WebSocket.OPEN) return;
  pendingOutgoingBySession.delete(sessionId);
  for (const msg of queued) {
    ws.send(JSON.stringify(msg));
  }
}

/** Accumulated streaming content per session — thinking and text tracked separately */
const streamingBlocksBySession = new Map<string, { thinking: string; text: string }>();

function setStreamingDraftMessage(sessionId: string, content: string, phase?: "thinking" | "text") {
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const existingDraftId = streamingDraftMessageIdBySession.get(sessionId);

  // Remove ALL orphaned streaming drafts (messages with isStreaming that aren't
  // the tracked draft). This prevents duplicates when message_history merges or
  // reconnects leave stale drafts in the array.
  let messages = existing.filter(
    (m) => !m.isStreaming || m.id === existingDraftId,
  );

  let draftIndex = -1;
  if (existingDraftId) {
    draftIndex = messages.findIndex((m) => m.id === existingDraftId);
    if (draftIndex === -1) {
      streamingDraftMessageIdBySession.delete(sessionId);
    }
  }

  if (draftIndex === -1) {
    const id = `stream-${sessionId}-${nextId()}`;
    streamingDraftMessageIdBySession.set(sessionId, id);
    messages = [...messages, {
      id,
      role: "assistant" as const,
      content,
      timestamp: Date.now(),
      isStreaming: true,
      streamingPhase: phase,
    }];
  } else {
    messages = [...messages];
    const prev = messages[draftIndex];
    messages[draftIndex] = {
      ...prev,
      role: "assistant",
      content,
      isStreaming: true,
      streamingPhase: phase,
    };
  }

  store.setMessages(sessionId, messages);
}

function clearStreamingDraftMessage(sessionId: string) {
  streamingDraftMessageIdBySession.delete(sessionId);

  // Remove ALL streaming draft messages, not just the tracked one.
  // This guards against orphaned drafts from reconnects or message_history merges.
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const next = existing.filter((m) => !m.isStreaming);
  if (next.length !== existing.length) {
    store.setMessages(sessionId, next);
  }
}

function nextClientMsgId(): string {
  return `cmsg-${Date.now()}-${++clientMsgCounter}`;
}

export function createClientMessageId(): string {
  return nextClientMsgId();
}

const IDEMPOTENT_OUTGOING_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
  "set_ai_validation",
]);

function getWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = localStorage.getItem("companion_auth_token") || "";
  return `${proto}//${location.host}/ws/browser/${sessionId}?token=${encodeURIComponent(token)}`;
}

function getLastSeqStorageKey(sessionId: string): string {
  return `companion:last-seq:${sessionId}`;
}

function getLastSeq(sessionId: string): number {
  const cached = lastSeqBySession.get(sessionId);
  if (typeof cached === "number") return cached;
  try {
    const raw = localStorage.getItem(getLastSeqStorageKey(sessionId));
    const parsed = raw ? Number(raw) : 0;
    const normalized = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    lastSeqBySession.set(sessionId, normalized);
    return normalized;
  } catch {
    return 0;
  }
}

function setLastSeq(sessionId: string, seq: number): void {
  const normalized = Math.max(0, Math.floor(seq));
  lastSeqBySession.set(sessionId, normalized);
  try {
    localStorage.setItem(getLastSeqStorageKey(sessionId), String(normalized));
  } catch {
    // ignore storage errors
  }
}

function ackSeq(sessionId: string, seq: number): void {
  sendToSession(sessionId, { type: "session_ack", last_seq: seq });
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Stable dedup key for a content block — ignores mutable metadata like `signature`. */
function contentBlockKey(block: ContentBlock): string {
  if (block.type === "thinking") return `thinking:${block.thinking}`;
  if (block.type === "text") return `text:${block.text}`;
  if (block.type === "tool_use") return `tool_use:${block.id}`;
  if (block.type === "tool_result") return `tool_result:${block.tool_use_id}`;
  return JSON.stringify(block);
}

function mergeContentBlocks(prev?: ContentBlock[], next?: ContentBlock[]): ContentBlock[] | undefined {
  const prevBlocks = prev || [];
  const nextBlocks = next || [];
  if (prevBlocks.length === 0 && nextBlocks.length === 0) return undefined;

  // Build a map of next blocks for in-place replacement of matching prev blocks.
  const nextByKey = new Map<string, ContentBlock>();
  for (const block of nextBlocks) {
    nextByKey.set(contentBlockKey(block), block);
  }

  const merged: ContentBlock[] = [];
  const seen = new Set<string>();

  // Prev blocks first (preserves chronological order), replaced by next if matching.
  for (const block of prevBlocks) {
    const key = contentBlockKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(nextByKey.get(key) || block);
  }
  // Append any next blocks not already covered by prev.
  for (const block of nextBlocks) {
    const key = contentBlockKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(block);
  }
  return merged;
}

function buildToolActivityEntry(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  startedAt: number,
  parentToolUseId?: string | null,
): ToolActivityEntry {
  return {
    toolUseId,
    toolName,
    preview: getPreview(toolName, input),
    startedAt,
    elapsedSeconds: 0,
    isError: false,
    parentToolUseId: parentToolUseId || undefined,
  };
}

function mergeAssistantMessage(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  const mergedBlocks = mergeContentBlocks(previous.contentBlocks, incoming.contentBlocks);
  const mergedContent = mergedBlocks && mergedBlocks.length > 0
    ? extractTextFromBlocks(mergedBlocks)
    : (incoming.content || previous.content);

  return {
    ...previous,
    ...incoming,
    content: mergedContent,
    contentBlocks: mergedBlocks,
    // Keep the original timestamp position when this is an in-place assistant update.
    timestamp: previous.timestamp ?? incoming.timestamp,
    // Explicitly clear stale streaming marker when incoming is final.
    isStreaming: incoming.isStreaming,
  };
}

function upsertAssistantMessage(sessionId: string, incoming: ChatMessage) {
  const store = useStore.getState();
  const existing = store.messages.get(sessionId) || [];
  const index = existing.findIndex((m) => m.role === "assistant" && m.id === incoming.id);
  if (index === -1) {
    store.appendMessage(sessionId, incoming);
    return;
  }

  const messages = [...existing];
  messages[index] = mergeAssistantMessage(messages[index], incoming);
  store.setMessages(sessionId, messages);
}

function handleMessage(sessionId: string, event: MessageEvent) {
  let data: BrowserIncomingMessage;
  try {
    data = JSON.parse(event.data);
  } catch {
    console.warn(`[ws] Failed to parse incoming message for session ${sessionId}:`, event.data?.substring?.(0, 120));
    return;
  }

  // Promote to "connected" on first valid message (proves subscription succeeded)
  const store = useStore.getState();
  if (store.connectionStatus.get(sessionId) === "connecting") {
    store.setConnectionStatus(sessionId, "connected");
  }

  handleParsedMessage(sessionId, data);
}

function handleParsedMessage(
  sessionId: string,
  data: BrowserIncomingMessage,
  options: { processSeq?: boolean; ackSeqMessage?: boolean } = {},
) {
  const { processSeq = true, ackSeqMessage = true } = options;
  const store = useStore.getState();

  if (processSeq && typeof data.seq === "number") {
    const previous = getLastSeq(sessionId);
    if (data.seq <= previous) return;
    setLastSeq(sessionId, data.seq);
    if (ackSeqMessage) {
      ackSeq(sessionId, data.seq);
    }
  }

  switch (data.type) {
    case "session_init": {
      const existingSession = store.sessions.get(sessionId);
      store.addSession(data.session);
      store.setCliConnected(sessionId, true);
      store.setCliReconnecting(sessionId, false);
      if (!existingSession) {
        store.setSessionStatus(sessionId, "idle");
      }
      if (!store.sessionNames.has(sessionId)) {
        const existingNames = new Set(store.sessionNames.values());
        const name = generateUniqueSessionName(existingNames);
        store.setSessionName(sessionId, name);
      }
      break;
    }

    case "session_update": {
      store.updateSession(sessionId, data.session);
      break;
    }

    case "assistant": {
      const msg = data.message;
      const textContent = extractTextFromBlocks(msg.content);
      const chatMsg: ChatMessage = {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks: msg.content,
        timestamp: data.timestamp || Date.now(),
        parentToolUseId: data.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
      };
      // Clear any streaming draft first, then upsert the real message.
      // Using clearStreamingDraftMessage + upsertAssistantMessage instead of
      // finalizeStreamingDraftMessage avoids duplicates when the CLI sends
      // multiple assistant messages for the same turn (e.g. thinking → text →
      // tool_use) and streaming deltas create new drafts between them.
      clearStreamingDraftMessage(sessionId);
      upsertAssistantMessage(sessionId, chatMsg);
      store.setStreaming(sessionId, null);
      streamingPhaseBySession.delete(sessionId);
      // Reset streaming text accumulators so subsequent deltas in the same
      // turn don't re-show content that was already committed in the real
      // assistant message (prevents the "3-4 duplicate lines" streaming bug).
      streamingBlocksBySession.delete(sessionId);
      // Clear progress only for completed tools (tool_result blocks), not all tools.
      // Blanket clear would cause flickering during concurrent tool execution.
      if (msg.content?.length) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            store.clearToolProgress(sessionId, block.tool_use_id);
          }
        }
      }
      store.setSessionStatus(sessionId, "running");

      // Start timer if not already started (for non-streaming tool calls)
      if (!store.streamingStartedAt.has(sessionId)) {
        store.setStreamingStats(sessionId, { startedAt: Date.now() });
      }

      // Track tool activity for execution timeline
      if (msg.content?.length) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            const input = (block as { input?: Record<string, unknown> }).input || {};
            store.addToolActivity(sessionId, buildToolActivityEntry(
              block.id,
              block.name,
              input,
              data.timestamp || Date.now(),
              data.parent_tool_use_id,
            ));
          }
          if (block.type === "tool_result") {
            store.updateToolActivity(sessionId, block.tool_use_id, {
              completedAt: Date.now(),
              isError: Boolean(block.is_error),
            });
          }
        }
      }

      // Extract tasks and changed files from tool_use content blocks
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
        extractProcessesFromBlocks(sessionId, msg.content);
        extractBackgroundAgentsFromBlocks(sessionId, msg.content);
      }

      break;
    }

    case "stream_event": {
      const evt = data.event as Record<string, unknown>;
      if (evt && typeof evt === "object") {
        // message_start → mark generation start time
        if (evt.type === "message_start") {
          streamingPhaseBySession.delete(sessionId);
          streamingBlocksBySession.delete(sessionId);
          clearStreamingDraftMessage(sessionId);
          if (!store.streamingStartedAt.has(sessionId)) {
            store.setStreamingStats(sessionId, { startedAt: Date.now(), outputTokens: 0 });
          }
        }

        // content_block_delta → accumulate streaming text
        if (evt.type === "content_block_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const parts = streamingBlocksBySession.get(sessionId) || { thinking: "", text: "" };
            // Reset thinking accumulator on phase transition so that if
            // thinking resumes later it starts fresh (avoids showing stale
            // concatenated thinking from a previous block).
            if (streamingPhaseBySession.get(sessionId) === "thinking") {
              parts.thinking = "";
            }
            parts.text += delta.text;
            streamingBlocksBySession.set(sessionId, parts);
            streamingPhaseBySession.set(sessionId, "text");
            // Show only the response text in the streaming draft
            store.setStreaming(sessionId, parts.text);
            setStreamingDraftMessage(sessionId, parts.text, "text");
          }
          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            const parts = streamingBlocksBySession.get(sessionId) || { thinking: "", text: "" };
            parts.thinking += delta.thinking;
            streamingBlocksBySession.set(sessionId, parts);
            streamingPhaseBySession.set(sessionId, "thinking");
            // Show thinking text directly as faded inline text
            store.setStreaming(sessionId, parts.thinking);
            setStreamingDraftMessage(sessionId, parts.thinking, "thinking");
          }
        }

        // message_delta → extract output token count
        if (evt.type === "message_delta") {
          const usage = (evt as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            store.setStreamingStats(sessionId, { outputTokens: usage.output_tokens });
          }
        }
      }
      break;
    }

    case "result": {
      // Flush processed tool IDs at end of turn — deduplication only needed
      // within a single turn. Preserves memory in long-running sessions.
      processedToolUseIds.delete(sessionId);
      processedAgentIds.delete(sessionId);

      const r = data.data;
      const sessionUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      };
      // Forward lines changed if present
      if (typeof r.total_lines_added === "number") {
        sessionUpdates.total_lines_added = r.total_lines_added;
      }
      if (typeof r.total_lines_removed === "number") {
        sessionUpdates.total_lines_removed = r.total_lines_removed;
      }
      // Compute context % from modelUsage if available
      if (r.modelUsage) {
        for (const usage of Object.values(r.modelUsage)) {
          if (usage.contextWindow > 0) {
            const pct = Math.round(
              ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
            );
            sessionUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
          }
        }
      }
      store.updateSession(sessionId, sessionUpdates);
      clearStreamingDraftMessage(sessionId);
      store.setStreaming(sessionId, null);
      streamingPhaseBySession.delete(sessionId);
      streamingBlocksBySession.delete(sessionId);
      store.setStreamingStats(sessionId, null);
      store.clearToolProgress(sessionId);
      store.setSessionStatus(sessionId, "idle");
      // Play notification sound if enabled and tab is not focused
      if (!document.hasFocus() && store.notificationSound) {
        playNotificationSound();
      }
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification("Session completed", "Claude finished the task", sessionId);
      }
      if (r.is_error && r.errors?.length) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Error: ${r.errors.join(", ")}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "permission_request": {
      store.addPermission(sessionId, data.request);
      if (!document.hasFocus() && store.notificationDesktop) {
        const req = data.request;
        sendBrowserNotification(
          "Permission needed",
          `${req.tool_name}: approve or deny`,
          req.request_id,
        );
      }
      // Also extract tasks and changed files from permission requests
      const req = data.request;
      if (req.tool_name && req.input) {
        const permBlocks = [{
          type: "tool_use" as const,
          id: req.tool_use_id,
          name: req.tool_name,
          input: req.input,
        }];
        extractTasksFromBlocks(sessionId, permBlocks);
        extractChangedFilesFromBlocks(sessionId, permBlocks);
        extractProcessesFromBlocks(sessionId, permBlocks);
        extractBackgroundAgentsFromBlocks(sessionId, permBlocks);
      }
      break;
    }

    case "permission_cancelled": {
      store.removePermission(sessionId, data.request_id);
      break;
    }

    case "permission_auto_resolved": {
      store.addAiResolvedPermission(sessionId, {
        request: data.request,
        behavior: data.behavior,
        reason: data.reason,
        timestamp: Date.now(),
      });
      break;
    }

    case "tool_progress": {
      store.setToolProgress(sessionId, data.tool_use_id, {
        toolName: data.tool_name,
        elapsedSeconds: data.elapsed_time_seconds,
      });
      // Also update tool activity elapsed time
      store.updateToolActivity(sessionId, data.tool_use_id, {
        elapsedSeconds: data.elapsed_time_seconds,
      });
      break;
    }

    case "tool_use_summary": {
      // For Claude Code, tool_use content blocks in the assistant message
      // already render the tool call via ToolBlock/EditBlock — rendering a
      // duplicate system message would be redundant.
      // For Codex, tool_use blocks may not be present, so we still render.
      const backend = store.sdkSessions.find(
        (s) => s.sessionId === sessionId,
      )?.backendType;
      if (backend === "codex") {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: data.summary,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "user_message": {
      store.appendMessage(sessionId, {
        id: data.id || nextId(),
        role: "user",
        content: data.content,
        timestamp: data.timestamp || Date.now(),
      });
      store.clearPromptSuggestions(sessionId);
      break;
    }

    case "system_event": {
      // Update structured process state from task_notification
      if (data.event?.subtype === "task_notification") {
        const { task_id, status, summary: taskSummary } = data.event;
        if (task_id && status) {
          store.updateProcess(sessionId, task_id, {
            status: status as ProcessStatus,
            completedAt: Date.now(),
            summary: taskSummary || undefined,
          });
        }
      }

      const summary = summarizeSystemEvent(data.event);
      if (!summary) break;
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: summary,
        timestamp: data.timestamp || Date.now(),
      });
      break;
    }

    case "status_change": {
      if (data.status === "compacting") {
        store.setSessionStatus(sessionId, "compacting");
      } else {
        store.setSessionStatus(sessionId, data.status);
      }
      break;
    }

    case "auth_status": {
      if (data.error) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Auth error: ${data.error}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "error": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.message,
        timestamp: Date.now(),
      });
      break;
    }

    case "session_phase": {
      const phase = data.phase;
      if (phase === "terminated") {
        store.setCliConnected(sessionId, false);
        store.setCliReconnecting(sessionId, false);
        store.setSessionStatus(sessionId, null);
      } else if (phase === "reconnecting") {
        store.setCliConnected(sessionId, false);
        store.setCliReconnecting(sessionId, true);
        store.setSessionStatus(sessionId, null);
      } else if (phase === "starting" || phase === "initializing") {
        store.setCliConnected(sessionId, false);
        store.setCliReconnecting(sessionId, true);
      } else {
        store.setCliConnected(sessionId, true);
        store.setCliReconnecting(sessionId, false);
        if (phase === "ready") store.setSessionStatus(sessionId, "idle");
        else if (phase === "streaming") store.setSessionStatus(sessionId, "running");
        else if (phase === "compacting") store.setSessionStatus(sessionId, "compacting");
        else if (phase === "awaiting_permission") store.setSessionStatus(sessionId, "running");
      }
      break;
    }

    case "cli_disconnected": {
      store.setCliConnected(sessionId, false);
      store.setCliReconnecting(sessionId, false);
      store.setSessionStatus(sessionId, null);
      break;
    }

    case "cli_connected": {
      store.setCliConnected(sessionId, true);
      store.setCliReconnecting(sessionId, false);
      break;
    }

    case "session_name_update": {
      // Only apply auto-name if user hasn't manually renamed (still has random Adj+Noun name)
      const currentName = store.sessionNames.get(sessionId);
      const isRandomName = currentName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentName);
      if (!currentName || isRandomName) {
        store.setSessionName(sessionId, data.name);
        store.markRecentlyRenamed(sessionId);
      }
      break;
    }

    case "pr_status_update": {
      store.setPRStatus(sessionId, { available: data.available, pr: data.pr });
      break;
    }

    case "mcp_status": {
      store.setMcpServers(sessionId, data.servers);
      break;
    }

    case "message_history": {
      const chatMessages: ChatMessage[] = [];
      const toolActivityById = new Map<string, ToolActivityEntry>();
      for (let i = 0; i < data.messages.length; i++) {
        const histMsg = data.messages[i];
        if (histMsg.type === "user_message") {
          chatMessages.push({
            id: histMsg.id || nextId(),
            role: "user",
            content: histMsg.content,
            timestamp: histMsg.timestamp,
          });
        } else if (histMsg.type === "assistant") {
          const msg = histMsg.message;
          const textContent = extractTextFromBlocks(msg.content);
          const assistantMsg: ChatMessage = {
            id: msg.id,
            role: "assistant",
            content: textContent,
            contentBlocks: msg.content,
            timestamp: histMsg.timestamp || Date.now(),
            parentToolUseId: histMsg.parent_tool_use_id,
            model: msg.model,
            stopReason: msg.stop_reason,
          };
          const existingIndex = chatMessages.findIndex((m) => m.role === "assistant" && m.id === assistantMsg.id);
          if (existingIndex === -1) {
            chatMessages.push(assistantMsg);
          } else {
            chatMessages[existingIndex] = mergeAssistantMessage(chatMessages[existingIndex], assistantMsg);
          }
          // Also extract tasks, changed files, and background processes from history
          if (msg.content?.length) {
            extractTasksFromBlocks(sessionId, msg.content);
            extractChangedFilesFromBlocks(sessionId, msg.content);
            extractProcessesFromBlocks(sessionId, msg.content);
            extractBackgroundAgentsFromBlocks(sessionId, msg.content);
            const baseTimestamp = histMsg.timestamp || Date.now();
            for (const block of msg.content) {
              if (block.type === "tool_use") {
                const input = (block as { input?: Record<string, unknown> }).input || {};
                const existing = toolActivityById.get(block.id);
                toolActivityById.set(
                  block.id,
                  existing ?? buildToolActivityEntry(
                    block.id,
                    block.name,
                    input,
                    baseTimestamp,
                    histMsg.parent_tool_use_id,
                  ),
                );
              }
              if (block.type === "tool_result") {
                const existing = toolActivityById.get(block.tool_use_id);
                if (existing) {
                  toolActivityById.set(block.tool_use_id, {
                    ...existing,
                    completedAt: baseTimestamp,
                    isError: existing.isError || Boolean(block.is_error),
                    elapsedSeconds: Math.max(
                      existing.elapsedSeconds,
                      existing.completedAt ? existing.elapsedSeconds : Math.max(0, (baseTimestamp - existing.startedAt) / 1000),
                    ),
                  });
                }
              }
            }
          }
        } else if (histMsg.type === "result") {
          const r = histMsg.data;
          if (r.is_error && r.errors?.length) {
            chatMessages.push({
              id: `hist-error-${i}`,
              role: "system",
              content: `Error: ${r.errors.join(", ")}`,
              timestamp: Date.now(),
            });
          }
          // Track cost/turns from history result, same as the live result handler
          const resultUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
            total_cost_usd: r.total_cost_usd,
            num_turns: r.num_turns,
          };
          if (typeof r.total_lines_added === "number") {
            resultUpdates.total_lines_added = r.total_lines_added;
          }
          if (typeof r.total_lines_removed === "number") {
            resultUpdates.total_lines_removed = r.total_lines_removed;
          }
          if (r.modelUsage) {
            for (const usage of Object.values(r.modelUsage)) {
              if ((usage as { contextWindow: number; inputTokens: number; outputTokens: number }).contextWindow > 0) {
                const u = usage as { contextWindow: number; inputTokens: number; outputTokens: number };
                const pct = Math.round(((u.inputTokens + u.outputTokens) / u.contextWindow) * 100);
                resultUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
              }
            }
          }
          store.updateSession(sessionId, resultUpdates);
        } else if (histMsg.type === "system_event") {
          const summary = summarizeSystemEvent(histMsg.event);
          if (!summary) continue;
          chatMessages.push({
            id: `hist-system-event-${i}`,
            role: "system",
            content: summary,
            timestamp: histMsg.timestamp || Date.now(),
          });
        }
      }
      if (chatMessages.length > 0) {
        const existing = store.messages.get(sessionId) || [];
        if (existing.length === 0) {
          // Initial connect: history is the full truth
          store.setMessages(sessionId, chatMessages);
        } else {
          // Reconnect: merge history with live messages, upserting duplicate assistant IDs.
          const merged = [...existing];
          for (const incoming of chatMessages) {
            const idx = merged.findIndex((m) => m.id === incoming.id);
            if (idx === -1) {
              merged.push(incoming);
              continue;
            }
            const current = merged[idx];
            if (current.role === "assistant" && incoming.role === "assistant") {
              merged[idx] = mergeAssistantMessage(current, incoming);
            } else {
              merged[idx] = incoming;
            }
          }
          merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
          store.setMessages(sessionId, merged);
        }
      }
      store.setToolActivity(sessionId, Array.from(toolActivityById.values()).sort((a, b) => a.startedAt - b.startedAt));
      // Fix: if the last history message is a `result`, the session's last turn
      // is complete. Clear any stale streaming state that event_replay might not
      // correct (e.g. when `result` was pruned from the 600-event buffer).
      const lastHistMsg = data.messages[data.messages.length - 1];
      if (lastHistMsg?.type === "result") {
        clearStreamingDraftMessage(sessionId);
        store.setStreaming(sessionId, null);
        streamingPhaseBySession.delete(sessionId);
        streamingBlocksBySession.delete(sessionId);
        store.setStreamingStats(sessionId, null);
        store.clearToolProgress(sessionId);
        store.setSessionStatus(sessionId, "idle");
      }
      break;
    }

    case "event_replay": {
      let latestProcessed: number | undefined;
      for (const evt of data.events) {
        const previous = getLastSeq(sessionId);
        if (evt.seq <= previous) continue;
        setLastSeq(sessionId, evt.seq);
        latestProcessed = evt.seq;
        handleParsedMessage(
          sessionId,
          evt.message as BrowserIncomingMessage,
          { processSeq: false, ackSeqMessage: false },
        );
      }
      if (typeof latestProcessed === "number") {
        ackSeq(sessionId, latestProcessed);
      }
      break;
    }

    case "prompt_suggestion": {
      const suggestions = (data as BrowserIncomingMessage & { type: "prompt_suggestion"; suggestions: string[] }).suggestions;
      store.setPromptSuggestions(sessionId, suggestions);
      break;
    }

    case "streamlined_text": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "assistant",
        content: data.text,
        timestamp: Date.now(),
      });
      break;
    }

    case "streamlined_tool_use_summary": {
      // Streamlined mode emits summary-only tool activity instead of the richer
      // assistant/tool_use_summary flow, so surface it as a system message.
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.tool_summary,
        timestamp: Date.now(),
      });
      break;
    }

    default: {
      console.debug("[ws] Unhandled message type:", (data as { type: string }).type);
      break;
    }
  }
}

export function connectSession(sessionId: string) {
  const existing = sockets.get(sessionId);
  if (isSocketUsable(existing)) return;
  if (existing) {
    try { existing.close(); } catch {}
    sockets.delete(sessionId);
  }

  const store = useStore.getState();
  store.setConnectionStatus(sessionId, "connecting");

  const ws = new WebSocket(getWsUrl(sessionId));
  sockets.set(sessionId, ws);

  ws.onopen = () => {
    // Stay in "connecting" until we receive the first message from the server,
    // proving the subscription succeeded. handleMessage promotes to "connected".
    const lastSeq = getLastSeq(sessionId);
    ws.send(JSON.stringify({ type: "session_subscribe", last_seq: lastSeq }));
    flushQueuedOutgoing(sessionId, ws);
    // Clear any reconnect timer
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(sessionId);
    }
  };

  ws.onmessage = (event) => handleMessage(sessionId, event);

  ws.onclose = () => {
    // Guard against stale close events from a replaced socket.
    if (sockets.get(sessionId) !== ws) return;
    sockets.delete(sessionId);
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect(sessionId: string) {
  if (reconnectTimers.has(sessionId)) return;
  // Don't schedule reconnect when page is hidden — mobile browsers will just
  // kill the new connection too, creating a wasteful connect/disconnect cycle.
  // The visibilitychange handler will reconnect when the page becomes visible.
  if (pageHidden) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    // Re-check visibility — page may have been hidden during the delay
    if (pageHidden) return;
    if (shouldReconnectSession(sessionId)) connectSession(sessionId);
  }, WS_RECONNECT_DELAY_MS);
  reconnectTimers.set(sessionId, timer);
}

export function disconnectSession(sessionId: string) {
  const timer = reconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionId);
  }
  const ws = sockets.get(sessionId);
  if (ws) {
    ws.close();
    sockets.delete(sessionId);
  }
  useStore.getState().setConnectionStatus(sessionId, "disconnected");
  processedToolUseIds.delete(sessionId);
  processedAgentIds.delete(sessionId);
  pendingBackgroundBash.delete(sessionId);
  taskCounters.delete(sessionId);
  streamingPhaseBySession.delete(sessionId);
  streamingDraftMessageIdBySession.delete(sessionId);
  streamingBlocksBySession.delete(sessionId);
  lastSeqBySession.delete(sessionId);
  pendingOutgoingBySession.delete(sessionId);
}

export function disconnectAll() {
  for (const [id] of sockets) {
    disconnectSession(id);
  }
}

export function connectAllSessions(sessions: SdkSessionInfo[]) {
  // Skip connection attempts when page is hidden — mobile browsers kill
  // backgrounded WS connections, so connecting here would just cycle.
  if (pageHidden) return;
  for (const s of sessions) {
    if (!s.archived) {
      connectSession(s.sessionId);
    }
  }
}

export function waitForConnection(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const ws = sockets.get(sessionId);
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error("Connection timeout"));
    }, 10000);
  });
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage) {
  const ws = sockets.get(sessionId);
  let outgoing: BrowserOutgoingMessage = msg;
  const isIdempotent = IDEMPOTENT_OUTGOING_TYPES.has(msg.type);
  if (isIdempotent) {
    switch (msg.type) {
      case "user_message":
      case "permission_response":
      case "interrupt":
      case "set_model":
      case "set_permission_mode":
      case "mcp_get_status":
      case "mcp_toggle":
      case "mcp_reconnect":
      case "mcp_set_servers":
      case "set_ai_validation":
        if (!msg.client_msg_id) {
          outgoing = { ...msg, client_msg_id: nextClientMsgId() };
        }
        break;
    }
  }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outgoing));
    return;
  }

  if (isIdempotent) {
    enqueueOutgoing(sessionId, outgoing);
  }
}

export function sendMcpGetStatus(sessionId: string) {
  sendToSession(sessionId, { type: "mcp_get_status" });
}

export function sendMcpToggle(sessionId: string, serverName: string, enabled: boolean) {
  sendToSession(sessionId, { type: "mcp_toggle", serverName, enabled });
}

export function sendMcpReconnect(sessionId: string, serverName: string) {
  sendToSession(sessionId, { type: "mcp_reconnect", serverName });
}

export function sendMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>) {
  sendToSession(sessionId, { type: "mcp_set_servers", servers });
}

export function sendSetAiValidation(
  sessionId: string,
  settings: {
    aiValidationEnabled?: boolean | null;
    aiValidationAutoApprove?: boolean | null;
    aiValidationAutoDeny?: boolean | null;
  },
) {
  sendToSession(sessionId, { type: "set_ai_validation", ...settings });
}
