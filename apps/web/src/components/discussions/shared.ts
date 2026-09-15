import type { Companion, DiscussionSnapshot } from "@/api";

export const POLL_INTERVAL = 2_500;
export const MAX_FILES = 5;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const ACCEPTED_FILES = "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,application/json,.md,.markdown,.txt,.csv,.json";

export type PendingAttachment = { file: File; id: string; position: number };
export type StoredDraft = { attempted?: boolean; content: string; targetCompanionId: string | null; clientMessageId: string; files: Array<{ id: string; name: string; size: number; position?: number }> };
export type CompanionMap = Map<string, Companion>;

export function draftKey(userId: string, discussionId: string) { return `companions.build:discussion-draft:${userId}:${discussionId}`; }
export function targetKey(userId: string, discussionId: string) { return `companions.build:discussion-target:${userId}:${discussionId}`; }

export function readDraft(userId: string, discussionId: string): StoredDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(userId, discussionId)) ?? "null") as StoredDraft | null;
    return value && typeof value.content === "string" && typeof value.clientMessageId === "string" && Array.isArray(value.files) ? value : null;
  } catch { return null; }
}

export function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

/** Roster and thread stamp: a time today, a weekday this week, a date before that. */
export function timeLabel(value: string, now = new Date()) {
  const date = new Date(value);
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  if (date >= midnight) return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  const week = new Date(midnight); week.setDate(week.getDate() - 6);
  if (date >= week) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}

export function dayLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(value));
}

export function fullDateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

/** One calm line from Markdown, for roster previews. */
export function stripPreview(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function statusLabel(value: string) { return value.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase()); }

export function workStatus(value: string) {
  return ({ queued: "Task received", preparing: "Getting ready", running: "Working", needs_input: "Needs your answer", succeeded: "Completed", failed: "Failed", interrupted: "Interrupted", cancelled: "Stopped" } as Record<string, string>)[value] ?? statusLabel(value);
}

export function orderedTasks(tasks: DiscussionSnapshot["tasks"]) {
  return [...tasks].sort((a, b) => (a.status === "needs_input" ? 0 : activeStatus(a.status) ? 1 : 2) - (b.status === "needs_input" ? 0 : activeStatus(b.status) ? 1 : 2) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

export function activeStatus(value: string) { return ["queued", "preparing", "running", "needs_input"].includes(value); }

export function compareSequence(left: string, right: string) { const a = String(left).replace(/^0+(?=\d)/, ""), b = String(right).replace(/^0+(?=\d)/, ""); return a.length - b.length || a.localeCompare(b); }

export function mergeMessages(...groups: DiscussionSnapshot["messages"][]) { const byId = new Map(groups.flat().map(message => [message.id, message])); return [...byId.values()].sort((a, b) => compareSequence(a.sequence, b.sequence) || a.id.localeCompare(b.id)); }

const GROUPING_WINDOW = 5 * 60_000;
export type GroupedMessage = { message: DiscussionSnapshot["messages"][number]; day: string | null; header: boolean };

/** A day opens with its own separator; the same author keeps one header for five minutes. */
export function groupMessages(messages: DiscussionSnapshot["messages"]): GroupedMessage[] {
  let previous: DiscussionSnapshot["messages"][number] | null = null;
  return messages.map(message => {
    const day = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString() ? message.createdAt : null;
    const continued = previous !== null
      && day === null
      && previous.role === message.role
      && (previous.companionId ?? null) === (message.companionId ?? null)
      && Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUPING_WINDOW;
    previous = message;
    return { message, day, header: !continued };
  });
}
