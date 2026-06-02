import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { COMPANION_HOME } from "./paths.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorktreeMapping {
  sessionId: string;
  repoRoot: string;
  branch: string;
  /** Actual git branch in the worktree (may differ from `branch` for -wt-N branches) */
  actualBranch?: string;
  worktreePath: string;
  createdAt: number;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const TRACKER_PATH = join(COMPANION_HOME, "worktrees.json");

// ─── Tracker ────────────────────────────────────────────────────────────────

export class WorktreeTracker {
  private mappings: WorktreeMapping[] = [];

  constructor() {
    this.load();
  }

  load(): WorktreeMapping[] {
    try {
      if (existsSync(TRACKER_PATH)) {
        const raw = readFileSync(TRACKER_PATH, "utf-8");
        this.mappings = JSON.parse(raw) as WorktreeMapping[];
      }
    } catch {
      this.mappings = [];
    }
    return this.mappings;
  }

  private save(): void {
    mkdirSync(dirname(TRACKER_PATH), { recursive: true });
    writeFileSync(TRACKER_PATH, JSON.stringify(this.mappings, null, 2), "utf-8");
  }

  addMapping(mapping: WorktreeMapping): void {
    // Remove any existing mapping for this session
    this.mappings = this.mappings.filter((m) => m.sessionId !== mapping.sessionId);
    this.mappings.push(mapping);
    this.save();
  }

  removeBySession(sessionId: string): WorktreeMapping | null {
    const idx = this.mappings.findIndex((m) => m.sessionId === sessionId);
    if (idx === -1) return null;
    const [removed] = this.mappings.splice(idx, 1);
    this.save();
    return removed;
  }

  getBySession(sessionId: string): WorktreeMapping | null {
    return this.mappings.find((m) => m.sessionId === sessionId) || null;
  }

  getSessionsForWorktree(worktreePath: string): WorktreeMapping[] {
    return this.mappings.filter((m) => m.worktreePath === worktreePath);
  }

  getSessionsForRepo(repoRoot: string): WorktreeMapping[] {
    return this.mappings.filter((m) => m.repoRoot === repoRoot);
  }

  isWorktreeInUse(worktreePath: string, excludeSessionId?: string): boolean {
    return this.mappings.some(
      (m) => m.worktreePath === worktreePath && m.sessionId !== excludeSessionId,
    );
  }
}
