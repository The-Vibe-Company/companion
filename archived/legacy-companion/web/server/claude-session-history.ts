import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ContentBlock } from "./session-types.js";

const DEFAULT_HISTORY_PAGE_LIMIT = 40;
const MAX_HISTORY_PAGE_LIMIT = 200;

interface ClaudeSessionHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
  model?: string;
  stopReason?: string | null;
}

export interface ClaudeSessionHistoryPage {
  sourceFile: string;
  messages: ClaudeSessionHistoryMessage[];
  nextCursor: number;
  hasMore: boolean;
  totalMessages: number;
}

export interface ClaudeSessionHistoryPageOptions {
  sessionId: string;
  cursor?: number;
  limit?: number;
  projectsRoot?: string;
}

interface TimelineMessage extends ClaudeSessionHistoryMessage {
  order: number;
}

interface ParsedHistoryCacheEntry {
  sourceFile: string;
  mtimeMs: number;
  messages: ClaudeSessionHistoryMessage[];
}

const parsedHistoryCache = new Map<string, ParsedHistoryCacheEntry>();

function getProjectsRoot(projectsRoot?: string): string {
  return projectsRoot
    || process.env.CLAUDE_PROJECTS_DIR
    || join(homedir(), ".claude", "projects");
}

function getHistoryCacheKey(sessionId: string, projectsRoot: string): string {
  return `${projectsRoot}::${sessionId}`;
}

function resolveSessionSourceFile(
  sessionId: string,
  projectsRoot: string,
): { sourceFile: string; mtimeMs: number } | null {
  if (!sessionId || !existsSync(projectsRoot)) return null;

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch {
    return null;
  }

  let newest: { sourceFile: string; mtimeMs: number } | null = null;
  for (const projectDir of projectDirs) {
    const projectPath = join(projectsRoot, projectDir);
    let projectStats: ReturnType<typeof statSync>;
    try {
      projectStats = statSync(projectPath);
    } catch {
      continue;
    }
    if (!projectStats.isDirectory()) continue;

    const candidate = join(projectPath, `${sessionId}.jsonl`);
    let candidateStats: ReturnType<typeof statSync>;
    try {
      candidateStats = statSync(candidate);
    } catch {
      continue;
    }
    if (!candidateStats.isFile()) continue;
    if (!newest || candidateStats.mtimeMs > newest.mtimeMs) {
      newest = { sourceFile: candidate, mtimeMs: candidateStats.mtimeMs };
    }
  }

  return newest;
}

function parseTimestamp(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function extractUserContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim()) {
      parts.push(typed.text.trim());
    }
  }
  return parts.join("\n").trim();
}

function isCommandNoiseUserContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return trimmed.startsWith("<command-name>")
    || trimmed.startsWith("<command-message>")
    || trimmed.startsWith("<command-args>")
    || trimmed.startsWith("<local-command-caveat>")
    || trimmed.startsWith("<local-command-stdout>")
    || trimmed.startsWith("<local-command-stderr>");
}

function toContentBlocks(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ContentBlock[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      out.push({
        type: "thinking",
        thinking: block.thinking,
        budget_tokens: typeof block.budget_tokens === "number" ? block.budget_tokens : undefined,
      });
      continue;
    }
    if (
      block.type === "tool_use"
      && typeof block.id === "string"
      && typeof block.name === "string"
      && block.input
      && typeof block.input === "object"
    ) {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
      continue;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      let content: string | ContentBlock[] = "";
      if (typeof block.content === "string") {
        content = block.content;
      } else if (Array.isArray(block.content)) {
        content = toContentBlocks(block.content);
      }
      out.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content,
        is_error: block.is_error === true,
      });
    }
  }

  return out;
}

function extractAssistantContent(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mergeContentBlocks(
  previous?: ContentBlock[],
  next?: ContentBlock[],
): ContentBlock[] | undefined {
  const prev = previous || [];
  const nxt = next || [];
  if (prev.length === 0 && nxt.length === 0) return undefined;

  const merged: ContentBlock[] = [];
  const seen = new Set<string>();

  const pushUnique = (block: ContentBlock) => {
    const key = JSON.stringify(block);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(block);
  };

  for (const block of prev) pushUnique(block);
  for (const block of nxt) pushUnique(block);
  return merged;
}

function buildMessageId(
  sessionId: string,
  role: "user" | "assistant",
  baseId: string,
): string {
  return `resume-${sessionId}-${role}-${baseId}`;
}

function parseHistoryFile(
  sessionId: string,
  sourceFile: string,
): ClaudeSessionHistoryMessage[] {
  let fileContent: string;
  try {
    fileContent = readFileSync(sourceFile, "utf-8");
  } catch {
    return [];
  }

  const timeline: TimelineMessage[] = [];
  const assistantById = new Map<string, TimelineMessage>();
  let lineOrder = 0;

  for (const line of fileContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.isSidechain === true) continue;
    if (typeof parsed.sessionId === "string" && parsed.sessionId !== sessionId) continue;

    const fallbackTs = Date.now() + lineOrder;
    const timestamp = parseTimestamp(parsed.timestamp, fallbackTs);
    const message = parsed.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === "string" ? message.role : null;

    if (parsed.type === "user" && role === "user") {
      if (parsed.isMeta === true) {
        lineOrder++;
        continue;
      }
      const userContent = extractUserContent(message?.content);
      if (!userContent || isCommandNoiseUserContent(userContent)) {
        lineOrder++;
        continue;
      }
      const rawId =
        (typeof parsed.uuid === "string" && parsed.uuid)
        || (typeof parsed.parentUuid === "string" && parsed.parentUuid)
        || String(lineOrder);
      timeline.push({
        id: buildMessageId(sessionId, "user", rawId),
        role: "user",
        content: userContent,
        timestamp,
        order: lineOrder,
      });
      lineOrder++;
      continue;
    }

    if (parsed.type === "assistant" && role === "assistant") {
      const rawAssistantId =
        (typeof message?.id === "string" && message.id)
        || (typeof parsed.uuid === "string" && parsed.uuid)
        || String(lineOrder);
      const assistantId = buildMessageId(sessionId, "assistant", rawAssistantId);

      const incomingBlocks = toContentBlocks(message?.content);
      const existing = assistantById.get(assistantId);
      const mergedBlocks = mergeContentBlocks(existing?.contentBlocks, incomingBlocks);
      const nextContent = mergedBlocks ? extractAssistantContent(mergedBlocks) : "";

      if (existing) {
        existing.contentBlocks = mergedBlocks;
        existing.content = nextContent || existing.content;
        existing.model =
          (typeof message?.model === "string" ? message.model : undefined)
          || existing.model;
        existing.stopReason =
          (typeof message?.stop_reason === "string" || message?.stop_reason === null)
            ? (message.stop_reason as string | null)
            : existing.stopReason;
      } else {
        const created: TimelineMessage = {
          id: assistantId,
          role: "assistant",
          content: nextContent,
          contentBlocks: mergedBlocks,
          timestamp,
          model: typeof message?.model === "string" ? message.model : undefined,
          stopReason:
            (typeof message?.stop_reason === "string" || message?.stop_reason === null)
              ? (message.stop_reason as string | null)
              : null,
          order: lineOrder,
        };
        assistantById.set(assistantId, created);
        timeline.push(created);
      }
      lineOrder++;
      continue;
    }

    lineOrder++;
  }

  return timeline
    .filter((entry) => {
      if (entry.role === "assistant") {
        return (entry.content && entry.content.trim().length > 0)
          || (entry.contentBlocks && entry.contentBlocks.length > 0);
      }
      return entry.content.trim().length > 0;
    })
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.order - b.order;
    })
    .map(({ order, ...entry }) => entry);
}

function getParsedHistory(
  sessionId: string,
  projectsRoot: string,
): ParsedHistoryCacheEntry | null {
  const resolved = resolveSessionSourceFile(sessionId, projectsRoot);
  if (!resolved) return null;

  const cacheKey = getHistoryCacheKey(sessionId, projectsRoot);
  const cached = parsedHistoryCache.get(cacheKey);
  if (
    cached
    && cached.sourceFile === resolved.sourceFile
    && cached.mtimeMs === resolved.mtimeMs
  ) {
    return cached;
  }

  const parsed: ParsedHistoryCacheEntry = {
    sourceFile: resolved.sourceFile,
    mtimeMs: resolved.mtimeMs,
    messages: parseHistoryFile(sessionId, resolved.sourceFile),
  };
  parsedHistoryCache.set(cacheKey, parsed);
  return parsed;
}

export function getClaudeSessionHistoryPage(
  options: ClaudeSessionHistoryPageOptions,
): ClaudeSessionHistoryPage | null {
  const sessionId = options.sessionId.trim();
  if (!sessionId) return null;

  const projectsRoot = getProjectsRoot(options.projectsRoot);
  const parsed = getParsedHistory(sessionId, projectsRoot);
  if (!parsed) return null;

  const totalMessages = parsed.messages.length;
  const limit = Math.max(
    1,
    Math.min(
      MAX_HISTORY_PAGE_LIMIT,
      Number.isFinite(options.limit) ? Math.floor(options.limit as number) : DEFAULT_HISTORY_PAGE_LIMIT,
    ),
  );
  const cursorInput = Number.isFinite(options.cursor) ? Math.floor(options.cursor as number) : 0;
  const cursor = Math.max(0, Math.min(totalMessages, cursorInput));

  const endExclusive = Math.max(0, totalMessages - cursor);
  const start = Math.max(0, endExclusive - limit);
  const messages = parsed.messages.slice(start, endExclusive);
  const nextCursor = cursor + messages.length;

  return {
    sourceFile: parsed.sourceFile,
    messages,
    nextCursor,
    hasMore: start > 0,
    totalMessages,
  };
}

export function clearClaudeSessionHistoryCacheForTests(): void {
  parsedHistoryCache.clear();
}
