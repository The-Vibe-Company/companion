import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { COMPANION_HOME } from "./paths.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StoredLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  branchName: string;
  priorityLabel: string;
  stateName: string;
  stateType: string;
  teamName: string;
  teamKey: string;
  teamId: string;
  assigneeName?: string;
  updatedAt?: string;
  /** Which Linear connection this issue belongs to (for multi-connection support) */
  connectionId?: string;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(COMPANION_HOME, "session-linear-issues.json");

// ─── Store ───────────────────────────────────────────────────────────────────

let issues: Record<string, StoredLinearIssue> = {};
let loaded = false;
let filePath = DEFAULT_PATH;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      issues = JSON.parse(raw) as Record<string, StoredLinearIssue>;
    }
  } catch {
    issues = {};
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(issues, null, 2), "utf-8");
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getLinearIssue(sessionId: string): StoredLinearIssue | undefined {
  ensureLoaded();
  return issues[sessionId];
}

export function setLinearIssue(sessionId: string, issue: StoredLinearIssue): void {
  ensureLoaded();
  issues[sessionId] = issue;
  persist();
}

export function removeLinearIssue(sessionId: string): void {
  ensureLoaded();
  delete issues[sessionId];
  persist();
}

export function getAllLinearIssues(): Record<string, StoredLinearIssue> {
  ensureLoaded();
  return { ...issues };
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  issues = {};
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
}
