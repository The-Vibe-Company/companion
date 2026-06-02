import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { MessageBubble } from "./MessageBubble.js";
import {
  getToolIcon,
  getToolLabel,
  getPreview,
  ToolIcon,
} from "./ToolBlock.js";
import type { ChatMessage, ContentBlock, SdkSessionInfo } from "../types.js";
import type { ToolActivityEntry } from "../store/tasks-slice.js";
import { formatElapsed, formatTokenCount } from "../utils/format.js";
import { ToolExecutionBar } from "./ToolExecutionBar.js";
import { ToolTurnSummary } from "./ToolTurnSummary.js";

const FEED_PAGE_SIZE = 100;
const RESUME_HISTORY_PAGE_SIZE = 40;
const SCROLL_TOP_PREFETCH_PX = 120;
const savedDistanceFromBottomBySession = new Map<string, number>();

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_SDK_SESSIONS: SdkSessionInfo[] = [];

function formatResumeSourcePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return path;
  return parts.slice(-2).join("/");
}

// ─── Message-level grouping ─────────────────────────────────────────────────

interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolMsgGroup {
  kind: "tool_msg_group";
  toolName: string;
  items: ToolItem[];
  firstId: string;
}

interface SubagentGroup {
  kind: "subagent";
  taskToolUseId: string;
  description: string;
  agentType: string;
  backend?: "claude" | "codex";
  status?: string;
  receiverCount?: number;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  children: FeedEntry[];
}

type FeedEntry =
  | { kind: "message"; msg: ChatMessage }
  | ToolMsgGroup
  | SubagentGroup;

/**
 * Get the dominant tool name if this message is "tool-only"
 * (assistant message whose contentBlocks are ALL tool_use of the same name).
 * Returns null if it has text/thinking or mixed tool types.
 */
function getToolOnlyName(msg: ChatMessage): string | null {
  if (msg.role !== "assistant") return null;
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return null;

  let toolName: string | null = null;
  for (const b of blocks) {
    if (b.type === "text" && b.text.trim()) return null;
    if (b.type === "thinking") return null;
    if (b.type === "tool_use") {
      if (toolName === null) toolName = b.name;
      else if (toolName !== b.name) return null;
    }
  }
  return toolName;
}

function extractToolItems(msg: ChatMessage): ToolItem[] {
  const blocks = msg.contentBlocks || [];
  return blocks
    .filter(
      (
        b,
      ): b is ContentBlock & {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      } => b.type === "tool_use",
    )
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

/** Get Task tool_use IDs from a feed entry */
function getTaskIdsFromEntry(entry: FeedEntry): string[] {
  if (entry.kind === "message") {
    const blocks = entry.msg.contentBlocks || [];
    return blocks
      .filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use",
      )
      .filter((b) => b.name === "Task")
      .map((b) => b.id);
  }
  if (entry.kind === "tool_msg_group" && entry.toolName === "Task") {
    return entry.items.map((item) => item.id);
  }
  return [];
}

/** Group consecutive same-tool messages */
function groupToolMessages(messages: ChatMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const msg of messages) {
    const toolName = getToolOnlyName(msg);

    if (toolName) {
      const last = entries[entries.length - 1];
      if (last?.kind === "tool_msg_group" && last.toolName === toolName) {
        last.items.push(...extractToolItems(msg));
        continue;
      }
      entries.push({
        kind: "tool_msg_group",
        toolName,
        items: extractToolItems(msg),
        firstId: msg.id,
      });
    } else {
      entries.push({ kind: "message", msg });
    }
  }

  return entries;
}

/** Build feed entries with subagent nesting */
function buildEntries(
  messages: ChatMessage[],
  taskInfo: Map<
    string,
    {
      description: string;
      agentType: string;
      backend?: "claude" | "codex";
      status?: string;
      receiverCount?: number;
      senderThreadId?: string;
      receiverThreadIds?: string[];
    }
  >,
  childrenByParent: Map<string, ChatMessage[]>,
): FeedEntry[] {
  const grouped = groupToolMessages(messages);

  const result: FeedEntry[] = [];
  for (const entry of grouped) {
    result.push(entry);

    // After each entry containing Task tool_use(s), insert subagent groups
    const taskIds = getTaskIdsFromEntry(entry);
    for (const taskId of taskIds) {
      const children = childrenByParent.get(taskId);
      if (children && children.length > 0) {
        const info = taskInfo.get(taskId) || {
          description: "Subagent",
          agentType: "",
        };
        const childEntries = buildEntries(children, taskInfo, childrenByParent);
        result.push({
          kind: "subagent",
          taskToolUseId: taskId,
          description: info.description,
          agentType: info.agentType,
          backend: info.backend,
          status: info.status,
          receiverCount: info.receiverCount,
          senderThreadId: info.senderThreadId,
          receiverThreadIds: info.receiverThreadIds,
          children: childEntries,
        });
      }
    }
  }

  return result;
}

function groupMessages(messages: ChatMessage[]): FeedEntry[] {
  // Phase 1: Find all Task tool_use IDs across all messages
  const taskInfo = new Map<
    string,
    {
      description: string;
      agentType: string;
      backend?: "claude" | "codex";
      status?: string;
      receiverCount?: number;
      senderThreadId?: string;
      receiverThreadIds?: string[];
    }
  >();
  for (const msg of messages) {
    if (!msg.contentBlocks) continue;
    for (const b of msg.contentBlocks) {
      if (b.type === "tool_use" && b.name === "Task") {
        const { input, id } = b;
        const receiverThreadIds = Array.isArray(input?.receiver_thread_ids)
          ? input.receiver_thread_ids.filter(
              (threadId): threadId is string =>
                typeof threadId === "string" && threadId.length > 0,
            )
          : undefined;
        const receiverCount =
          receiverThreadIds && receiverThreadIds.length > 0
            ? receiverThreadIds.length
            : undefined;
        const senderThreadId =
          typeof input?.sender_thread_id === "string" &&
          input.sender_thread_id.length > 0
            ? input.sender_thread_id
            : undefined;
        const hasCodexMetadata =
          typeof input?.codex_status === "string" ||
          senderThreadId !== undefined ||
          receiverCount !== undefined;
        taskInfo.set(id, {
          description: String(input?.description || "Subagent"),
          agentType: String(input?.subagent_type || ""),
          backend: hasCodexMetadata ? "codex" : "claude",
          status:
            typeof input?.codex_status === "string"
              ? input.codex_status
              : undefined,
          receiverCount,
          senderThreadId,
          receiverThreadIds,
        });
      }
    }
  }

  // If no Task tool_uses found, skip the overhead
  if (taskInfo.size === 0) {
    return groupToolMessages(messages);
  }

  // Phase 2: Partition into top-level and child messages
  const childrenByParent = new Map<string, ChatMessage[]>();
  const topLevel: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.parentToolUseId && taskInfo.has(msg.parentToolUseId)) {
      let arr = childrenByParent.get(msg.parentToolUseId);
      if (!arr) {
        arr = [];
        childrenByParent.set(msg.parentToolUseId, arr);
      }
      arr.push(msg);
    } else {
      topLevel.push(msg);
    }
  }

  // Phase 3: Build grouped entries with subagent nesting
  return buildEntries(topLevel, taskInfo, childrenByParent);
}

// ─── Components ──────────────────────────────────────────────────────────────

function ToolMessageGroup({ group }: { group: ToolMsgGroup }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(group.toolName);
  const label = getToolLabel(group.toolName);
  const count = group.items.length;

  // Single item — don't group, render inline
  if (count === 1) {
    const item = group.items[0];
    return (
      <div className="animate-[fadeSlideIn_0.3s_ease-out]">
        <div className="flex items-start gap-3">
          <AssistantAvatar />
          <div className="flex-1 min-w-0">
            <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card tool-card">
              <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
                >
                  <path d="M6 4l4 4-4 4" />
                </svg>
                <ToolIcon type={iconType} />
                <span className="text-xs font-medium text-cc-fg">{label}</span>
                <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
                  {getPreview(item.name, item.input)}
                </span>
              </button>
              {open && (
                <div className="px-3 pb-3 pt-0 border-t border-cc-border mt-0">
                  <pre className="mt-2 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                    {JSON.stringify(item.input, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Multi-item group
  return (
    <div className="animate-[fadeSlideIn_0.3s_ease-out]">
      <div className="flex items-start gap-3">
        <AssistantAvatar />
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card tool-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-xs font-medium text-cc-fg">{label}</span>
              <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
                {count}
              </span>
            </button>

            {open && (
              <div className="border-t border-cc-border px-3 py-1.5">
                {group.items.map((item, i) => {
                  const preview = getPreview(item.name, item.input);
                  return (
                    <div
                      key={item.id || i}
                      className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate"
                    >
                      <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                      <span className="truncate">
                        {preview || JSON.stringify(item.input).slice(0, 80)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedEntries({ entries, toolActivity }: { entries: FeedEntry[]; toolActivity?: ToolActivityEntry[] }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === "tool_msg_group") {
          return <ToolMessageGroup key={entry.firstId || i} group={entry} />;
        }
        if (entry.kind === "subagent") {
          return <SubagentContainer key={entry.taskToolUseId} group={entry} />;
        }
        const msg = entry.msg;
        const toolUseIds = getToolUseIdsFromMessage(msg);
        const matchingActivity = toolActivity && toolUseIds.length > 0
          ? toolActivity.filter((a) => toolUseIds.includes(a.toolUseId))
          : [];
        // Show turn summary after assistant messages with completed tool calls
        const allComplete = matchingActivity.length > 0 && matchingActivity.every((a) => a.completedAt);
        return (
          <div key={msg.id}>
            <MessageBubble message={msg} />
            {allComplete && <ToolTurnSummary entries={matchingActivity} />}
          </div>
        );
      })}
    </>
  );
}

/** Extract tool_use IDs from a message's content blocks. */
function getToolUseIdsFromMessage(msg: ChatMessage): string[] {
  if (!msg.contentBlocks?.length) return [];
  return msg.contentBlocks
    .filter((b): b is ContentBlock & { type: "tool_use"; id: string } => b.type === "tool_use")
    .map((b) => b.id);
}

function normalizeSubagentStatus(status?: string): {
  label: string;
  className: string;
  summaryLabel: "pending" | "running" | "completed" | "failed";
} | null {
  if (!status) return null;
  const normalized = status.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "completed") {
    return {
      label: "completed",
      summaryLabel: "completed",
      className: "text-green-600 bg-green-500/15",
    };
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "errored"
  ) {
    return {
      label: "failed",
      summaryLabel: "failed",
      className: "text-cc-error bg-cc-error/10",
    };
  }
  if (
    normalized === "pending" ||
    normalized === "pendinginit" ||
    normalized === "pending_init"
  ) {
    return {
      label: "pending",
      summaryLabel: "pending",
      className: "text-amber-700 bg-amber-500/15",
    };
  }
  if (
    normalized === "running" ||
    normalized === "inprogress" ||
    normalized === "in_progress" ||
    normalized === "started"
  ) {
    return {
      label: "running",
      summaryLabel: "running",
      className: "text-blue-600 bg-blue-500/15",
    };
  }
  return {
    label: status,
    summaryLabel: "running",
    className: "text-amber-700 bg-amber-500/15",
  };
}

function SubagentContainer({ group }: { group: SubagentGroup }) {
  const [open, setOpen] = useState(false);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const childCount = group.children.length;
  const status = normalizeSubagentStatus(group.status);
  const receiverCount = group.receiverCount;
  const senderThreadId = group.senderThreadId;
  const receiverThreadIds = group.receiverThreadIds || [];
  const backend = group.backend || "claude";

  // Get the last visible entry for a compact preview
  const lastEntry = group.children[group.children.length - 1];
  const lastPreview = useMemo(() => {
    if (!lastEntry) return "";
    if (lastEntry.kind === "tool_msg_group") {
      return `${getToolLabel(lastEntry.toolName)}${lastEntry.items.length > 1 ? ` ×${lastEntry.items.length}` : ""}`;
    }
    if (lastEntry.kind === "message" && lastEntry.msg.role === "assistant") {
      const text = lastEntry.msg.content?.trim();
      if (text) return text.length > 60 ? text.slice(0, 60) + "..." : text;
      const toolBlock = lastEntry.msg.contentBlocks?.find(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use",
      );
      if (toolBlock) return getToolLabel(toolBlock.name);
    }
    return "";
  }, [lastEntry]);

  return (
    <div className="animate-[fadeSlideIn_0.3s_ease-out]">
      <div className="ml-10 border-l border-cc-border/50 pl-4">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="relative z-10 flex items-center gap-1.5 py-1 text-left cursor-pointer group w-full"
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-2.5 h-2.5 text-cc-muted/40 group-hover:text-cc-muted/70 transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span className="text-[11px] font-medium text-cc-primary/70">
            {label}
          </span>
          {agentType && (
            <span className="text-[10px] text-cc-muted/50">
              {agentType}
            </span>
          )}
          <span className="text-[10px] text-cc-muted/40">
            {backend === "codex" ? "Codex" : "Claude"}
          </span>
          {status && (
            <span
              className={`text-[10px] ${status.className}`}
            >
              {status.label}
            </span>
          )}
          {receiverCount !== undefined && (
            <span className="text-[10px] text-cc-muted/40">
              {receiverCount} agent{receiverCount === 1 ? "" : "s"}
            </span>
          )}
          {!open && lastPreview && (
            <span className="text-[11px] text-cc-muted/40 truncate ml-1 font-mono-code">
              {lastPreview}
            </span>
          )}
          <span className="text-[10px] text-cc-muted/40 tabular-nums shrink-0 ml-auto">
            {childCount}
          </span>
        </button>

        {open && (
          <div className="space-y-3 pb-2 mt-1">
            {(senderThreadId || receiverThreadIds.length > 0) && (
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-cc-muted/50 pl-4">
                {senderThreadId && (
                  <span className="font-mono-code">sender: {senderThreadId}</span>
                )}
                {receiverThreadIds.length > 0 && (
                  <span>receivers: {receiverThreadIds.map(id => (
                    <span key={id} className="font-mono-code ml-1">{id}</span>
                  ))}</span>
                )}
              </div>
            )}
            <FeedEntries entries={group.children} />
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div className="w-7 h-7 rounded-full avatar-ring flex items-center justify-center shrink-0 mt-0.5">
      <div className="avatar-inner w-full h-full rounded-full flex items-center justify-center">
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
          <path d="M8 2L10.5 6.5L15 8L10.5 9.5L8 14L5.5 9.5L1 8L5.5 6.5L8 2Z" />
        </svg>
      </div>
    </div>
  );
}

// ─── Main Feed ───────────────────────────────────────────────────────────────

export function MessageFeed({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const sdkSession = useStore((s) =>
    (s.sdkSessions || EMPTY_SDK_SESSIONS).find(
      (session) => session.sessionId === sessionId,
    ),
  );
  const streamingStartedAt = useStore((s) =>
    s.streamingStartedAt.get(sessionId),
  );
  const streamingOutputTokens = useStore((s) =>
    s.streamingOutputTokens.get(sessionId),
  );
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const toolActivity = useStore((s) => s.toolActivity.get(sessionId));
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const [elapsed, setElapsed] = useState(0);
  const [visibleCount, setVisibleCount] = useState(FEED_PAGE_SIZE);
  const [resumeHistoryMessages, setResumeHistoryMessages] = useState<
    ChatMessage[]
  >([]);
  const [resumeHistoryCursor, setResumeHistoryCursor] = useState(0);
  const [resumeHistoryHasMore, setResumeHistoryHasMore] = useState(false);
  const [resumeHistoryLoaded, setResumeHistoryLoaded] = useState(false);
  const [resumeHistoryLoading, setResumeHistoryLoading] = useState(false);
  const [resumeHistoryError, setResumeHistoryError] = useState("");
  const resumeHistoryMessageIdsRef = useRef<Set<string>>(new Set());
  const chatTabReentryTick = useStore(
    (s) => s.chatTabReentryTickBySession.get(sessionId) ?? 0,
  );
  const hasStreamingAssistant = useMemo(
    () => messages.some((m) => m.role === "assistant" && m.isStreaming),
    [messages],
  );
  const resumeSourceSessionId = useMemo(() => {
    if (sdkSession?.backendType === "codex") return "";
    return (sdkSession?.resumeSessionAt || "").trim();
  }, [sdkSession?.backendType, sdkSession?.resumeSessionAt]);
  const canLoadResumeHistory = resumeSourceSessionId.length > 0;
  const resumeModeLabel = sdkSession?.forkSession
    ? "Forked from"
    : "Continuing from";
  const mergedMessages = useMemo(() => {
    if (resumeHistoryMessages.length === 0) return messages;
    const deduped: ChatMessage[] = [];
    const seen = new Set<string>();
    for (const msg of resumeHistoryMessages) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      deduped.push(msg);
    }
    for (const msg of messages) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      deduped.push(msg);
    }
    return deduped;
  }, [resumeHistoryMessages, messages]);

  const grouped = useMemo(
    () => groupMessages(mergedMessages),
    [mergedMessages],
  );

  // Reset paging/transcript state when switching sessions.
  useEffect(() => {
    setVisibleCount(FEED_PAGE_SIZE);
    setResumeHistoryMessages([]);
    setResumeHistoryCursor(0);
    setResumeHistoryHasMore(false);
    setResumeHistoryLoaded(false);
    setResumeHistoryLoading(false);
    setResumeHistoryError("");
    resumeHistoryMessageIdsRef.current = new Set();
  }, [sessionId, resumeSourceSessionId]);

  const totalEntries = grouped.length;
  const hasMore = totalEntries > visibleCount;
  const visibleEntries = hasMore
    ? grouped.slice(totalEntries - visibleCount)
    : grouped;
  const hiddenCount = totalEntries - visibleEntries.length;

  const handleLoadMore = useCallback(() => {
    const el = containerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setVisibleCount((c) => c + FEED_PAGE_SIZE);
    // Preserve scroll position after DOM updates
    requestAnimationFrame(() => {
      if (el) {
        const newHeight = el.scrollHeight;
        el.scrollTop += newHeight - prevHeight;
      }
    });
  }, []);

  const loadResumeHistoryPage = useCallback(
    async (options: { preserveScroll?: boolean } = {}) => {
      if (
        !canLoadResumeHistory ||
        !resumeSourceSessionId ||
        resumeHistoryLoading
      )
        return;

      const container = containerRef.current;
      const previousHeight = container?.scrollHeight ?? 0;
      const cursor = resumeHistoryLoaded ? resumeHistoryCursor : 0;

      setResumeHistoryLoading(true);
      setResumeHistoryError("");
      try {
        const page = await api.getClaudeSessionHistory(resumeSourceSessionId, {
          cursor,
          limit: RESUME_HISTORY_PAGE_SIZE,
        });

        const incoming = page.messages.map(
          (msg): ChatMessage => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            contentBlocks:
              msg.role === "assistant" ? msg.contentBlocks : undefined,
            timestamp: msg.timestamp || Date.now(),
            model: msg.role === "assistant" ? msg.model : undefined,
            stopReason: msg.role === "assistant" ? msg.stopReason : undefined,
          }),
        );

        const uniqueIncoming: ChatMessage[] = [];
        for (const msg of incoming) {
          if (resumeHistoryMessageIdsRef.current.has(msg.id)) continue;
          resumeHistoryMessageIdsRef.current.add(msg.id);
          uniqueIncoming.push(msg);
        }

        setResumeHistoryMessages((prev) => [...uniqueIncoming, ...prev]);
        setResumeHistoryCursor(page.nextCursor);
        setResumeHistoryHasMore(page.hasMore);
        setResumeHistoryLoaded(true);

        if (uniqueIncoming.length > 0) {
          setVisibleCount((count) => count + uniqueIncoming.length);
        }

        if (options.preserveScroll !== false && container) {
          requestAnimationFrame(() => {
            const newHeight = container.scrollHeight;
            container.scrollTop += newHeight - previousHeight;
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setResumeHistoryError(message || "Failed to load previous history");
        if (!resumeHistoryLoaded) {
          setResumeHistoryMessages([]);
          setResumeHistoryCursor(0);
          setResumeHistoryHasMore(false);
        }
      } finally {
        setResumeHistoryLoading(false);
      }
    },
    [
      canLoadResumeHistory,
      resumeSourceSessionId,
      resumeHistoryLoading,
      resumeHistoryLoaded,
      resumeHistoryCursor,
    ],
  );

  // Tick elapsed time every second while generating
  useEffect(() => {
    if (!streamingStartedAt && sessionStatus !== "running") {
      setElapsed(0);
      return;
    }
    const start = streamingStartedAt || Date.now();
    setElapsed(Date.now() - start);
    const interval = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(interval);
  }, [streamingStartedAt, sessionStatus]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    const distanceFromBottom = Math.max(
      0,
      el.scrollHeight - el.clientHeight - el.scrollTop,
    );
    savedDistanceFromBottomBySession.set(sessionId, distanceFromBottom);

    if (
      canLoadResumeHistory &&
      resumeHistoryLoaded &&
      resumeHistoryHasMore &&
      !resumeHistoryLoading &&
      el.scrollTop <= SCROLL_TOP_PREFETCH_PX
    ) {
      void loadResumeHistoryPage({ preserveScroll: true });
    }
  }

  const scrollToBottomInstant = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const previousBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = previousBehavior;
  }, []);

  const restoreSavedScrollPosition = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const previousBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    const savedDistance = savedDistanceFromBottomBySession.get(sessionId);
    if (typeof savedDistance === "number") {
      el.scrollTop = Math.max(
        0,
        el.scrollHeight - el.clientHeight - savedDistance,
      );
    } else {
      el.scrollTop = el.scrollHeight;
    }
    el.style.scrollBehavior = previousBehavior;
  }, [sessionId]);

  // On mount / session switch, restore previous reading position (or default to bottom).
  useEffect(() => {
    requestAnimationFrame(() => restoreSavedScrollPosition());
  }, [sessionId, restoreSavedScrollPosition]);

  // Persist the current scroll position for this session on unmount.
  useEffect(() => {
    return () => {
      const el = containerRef.current;
      if (!el) return;
      const distanceFromBottom = Math.max(
        0,
        el.scrollHeight - el.clientHeight - el.scrollTop,
      );
      savedDistanceFromBottomBySession.set(sessionId, distanceFromBottom);
    };
  }, [sessionId]);

  // Only force bottom on explicit workspace tab switch back to chat.
  useEffect(() => {
    if (!chatTabReentryTick) return;
    requestAnimationFrame(() => scrollToBottomInstant());
  }, [chatTabReentryTick, scrollToBottomInstant]);

  useEffect(() => {
    if (isNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  if (mergedMessages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-5 select-none px-6">
        {/* Animated sparkle icon */}
        <div className="relative">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cc-primary/10 to-cc-primary/5 border border-cc-primary/15 flex items-center justify-center shadow-[0_4px_20px_rgba(217,119,87,0.08)]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="w-7 h-7 text-cc-primary"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <div className="absolute -top-1 -right-1 w-3 h-3">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary/40 animate-[gentle-bounce_2s_ease-in-out_infinite]">
              <path d="M8 2L10.5 6.5L15 8L10.5 9.5L8 14L5.5 9.5L1 8L5.5 6.5L8 2Z" />
            </svg>
          </div>
        </div>
        <div className="text-center max-w-xs">
          {canLoadResumeHistory ? (
            <>
              <p className="text-sm text-cc-fg font-medium mb-1.5">
                This session has prior context
              </p>
              <p className="text-xs text-cc-muted leading-relaxed mb-4">
                {resumeModeLabel}{" "}
                <span className="font-mono-code text-cc-fg/70">{resumeSourceSessionId.slice(0, 8)}</span>.
                Load earlier messages when needed.
              </p>
              <button
                onClick={() =>
                  void loadResumeHistoryPage({ preserveScroll: false })
                }
                disabled={resumeHistoryLoading}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-cc-fg bg-cc-card border border-cc-border rounded-xl hover:bg-cc-hover hover:border-cc-primary/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                  <path d="M8 2v12M3 9l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {resumeHistoryLoading ? "Loading..." : "Load previous history"}
              </button>
              {resumeHistoryError && (
                <p className="text-xs text-cc-error mt-2">
                  {resumeHistoryError}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-[15px] text-cc-fg font-medium mb-1.5">
                Start a conversation
              </p>
              <p className="text-xs text-cc-muted leading-relaxed">
                Send a message to begin working with The Companion.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden">
      {/* Top fade — softens the scroll edge under the top bar */}
      <div className="pointer-events-none absolute top-0 inset-x-0 h-6 bg-gradient-to-b from-cc-bg to-transparent z-10" />
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overflow-x-hidden overscroll-y-contain px-4 sm:px-6 py-5 sm:py-8"
      >
        <div className="max-w-3xl mx-auto space-y-5 sm:space-y-7">
          {canLoadResumeHistory && !resumeHistoryLoaded && (
            <div className="rounded-xl border border-cc-border bg-cc-card p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-cc-fg">
                    {resumeModeLabel} existing Claude thread
                  </p>
                  <p className="text-[11px] text-cc-muted mt-1">
                    {resumeSourceSessionId}{" "}
                    {sdkSession?.cwd
                      ? `· ${formatResumeSourcePath(sdkSession.cwd)}`
                      : ""}
                  </p>
                </div>
                <button
                  onClick={() =>
                    void loadResumeHistoryPage({ preserveScroll: true })
                  }
                  disabled={resumeHistoryLoading}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cc-fg bg-cc-card border border-cc-border rounded-lg hover:bg-cc-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {resumeHistoryLoading
                    ? "Loading..."
                    : "Load previous history"}
                </button>
              </div>
              {resumeHistoryError && (
                <p className="text-xs text-cc-error mt-2">
                  {resumeHistoryError}
                </p>
              )}
            </div>
          )}

          {canLoadResumeHistory && resumeHistoryLoaded && (
            <div className="flex justify-center">
              <p className="text-[11px] text-cc-muted">
                {resumeHistoryHasMore
                  ? resumeHistoryLoading
                    ? "Loading older transcript..."
                    : "Scroll to top to load older transcript"
                  : "Loaded all available prior transcript"}
              </p>
            </div>
          )}

          {hasMore && (
            <div className="flex justify-center pb-3">
              <button
                onClick={handleLoadMore}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-cc-muted hover:text-cc-fg bg-cc-card border border-cc-border rounded-xl hover:bg-cc-hover hover:border-cc-primary/20 transition-all cursor-pointer shadow-[0_2px_6px_rgba(0,0,0,0.03)]"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="w-3.5 h-3.5"
                >
                  <path d="M8 3v10M3 8l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Load {Math.min(FEED_PAGE_SIZE, hiddenCount)} more
                <span className="text-cc-muted/50 tabular-nums">({hiddenCount} hidden)</span>
              </button>
            </div>
          )}
          <FeedEntries entries={visibleEntries} toolActivity={toolActivity} />

          {/* Tool progress indicator */}
          {toolProgress && toolProgress.size > 0 && !hasStreamingAssistant && (
            <ToolExecutionBar tools={Array.from(toolProgress.values())} />
          )}

          {/* Compacting context indicator */}
          {sessionStatus === "compacting" && (
            <div className="flex items-center gap-2 text-[11px] text-cc-warning font-mono-code pl-10 py-1">
              <svg
                className="w-3.5 h-3.5 animate-spin shrink-0"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="8" cy="8" r="6" opacity="0.2" />
                <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
              </svg>
              <span>Compacting context...</span>
            </div>
          )}

          {/* Generation stats bar */}
          {sessionStatus === "running" && elapsed > 0 && (
            <div className="flex items-center gap-2 text-[11px] text-cc-muted font-mono-code pl-10 stats-glow py-1">
              <span className="inline-block w-2 h-2 rounded-full bg-cc-primary animate-[typing-breathe_1.5s_ease-in-out_infinite]" />
              <span className="text-cc-fg/70">Generating</span>
              <span className="text-cc-muted/30">|</span>
              <span className="tabular-nums">{formatElapsed(elapsed)}</span>
              {(streamingOutputTokens ?? 0) > 0 && (
                <>
                  <span className="text-cc-muted/30">|</span>
                  <span className="tabular-nums">{formatTokenCount(streamingOutputTokens!)} tokens</span>
                </>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
