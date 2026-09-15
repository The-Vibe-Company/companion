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
