import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type {
  SessionState,
  BrowserIncomingMessage,
  PermissionRequest,
  BufferedBrowserEvent,
} from "./session-types.js";

// ─── Serializable session shape ─────────────────────────────────────────────

export interface PersistedSession {
  id: string;
  state: SessionState;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  pendingPermissions: [string, PermissionRequest][];
  eventBuffer?: BufferedBrowserEvent[];
  nextEventSeq?: number;
  lastAckSeq?: number;
  processedClientMessageIds?: string[];
  archived?: boolean;
}

// ─── Store ──────────────────────────────────────────────────────────────────

// Default storage lives under $HOME/.companion/sessions so it survives system
// reboots. Most Linux distros wipe /tmp at boot, so the legacy location lost
// every session whenever the host restarted. The legacy path is migrated once
// (see migrateLegacyDir below) when a SessionStore is constructed without an
// explicit dir argument.
const defaultDir = (): string => join(homedir(), ".companion", "sessions");
const legacyDir = (): string => join(tmpdir(), "vibe-sessions");

export class SessionStore {
  private dir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dir?: string) {
    this.dir = dir || defaultDir();
    mkdirSync(this.dir, { recursive: true });
    if (!dir) this.migrateLegacyDir();
  }

  /**
   * One-shot copy of any leftover files from the legacy `$TMPDIR/vibe-sessions/`
   * location into the new default dir. Per-file: skipped if the file already
   * exists in the new dir (so existing data wins). Source files are removed
   * after a successful copy so subsequent boots don't re-migrate the same
   * stale state.
   */
  private migrateLegacyDir(): void {
    const src = legacyDir();
    if (src === this.dir) return;
    let files: string[];
    try {
      files = readdirSync(src);
    } catch {
      return; // legacy dir does not exist — nothing to do
    }
    let migrated = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const srcPath = join(src, file);
      const dstPath = join(this.dir, file);
      try {
        // Skip if destination already has data for this file.
        readFileSync(dstPath);
        continue;
      } catch {}
      try {
        copyFileSync(srcPath, dstPath);
        try { unlinkSync(srcPath); } catch {}
        migrated++;
      } catch {
        // Permissions / disk full — keep going so we migrate as much as we can.
      }
    }
    if (migrated > 0) {
      console.log(`[session-store] Migrated ${migrated} file(s) from ${src} to ${this.dir}`);
    }
  }

  private filePath(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** Debounced write — batches rapid changes (e.g. multiple stream events). */
  save(session: PersistedSession): void {
    const existing = this.debounceTimers.get(session.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(session.id);
      this.saveSync(session);
    }, 150);
    this.debounceTimers.set(session.id, timer);
  }

  /** Immediate write — use for critical state changes. */
  saveSync(session: PersistedSession): void {
    try {
      writeFileSync(this.filePath(session.id), JSON.stringify(session), "utf-8");
    } catch (err) {
      console.error(`[session-store] Failed to save session ${session.id}:`, err);
    }
  }

  /** Load a single session from disk. */
  load(sessionId: string): PersistedSession | null {
    try {
      const raw = readFileSync(this.filePath(sessionId), "utf-8");
      return JSON.parse(raw) as PersistedSession;
    } catch {
      return null;
    }
  }

  /** Load all sessions from disk. */
  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json") && f !== "launcher.json");
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), "utf-8");
          sessions.push(JSON.parse(raw));
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Dir doesn't exist yet
    }
    return sessions;
  }

  /** Set the archived flag on a persisted session. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const session = this.load(sessionId);
    if (!session) return false;
    session.archived = archived;
    this.saveSync(session);
    return true;
  }

  /** Remove a session file from disk. */
  remove(sessionId: string): void {
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
    try {
      unlinkSync(this.filePath(sessionId));
    } catch {
      // File may not exist
    }
  }

  /** Persist launcher state (separate file). */
  saveLauncher(data: unknown): void {
    try {
      writeFileSync(join(this.dir, "launcher.json"), JSON.stringify(data), "utf-8");
    } catch (err) {
      console.error("[session-store] Failed to save launcher state:", err);
    }
  }

  /** Load launcher state. */
  loadLauncher<T>(): T | null {
    try {
      const raw = readFileSync(join(this.dir, "launcher.json"), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Cancel all pending debounce timers (for clean test teardown). */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  get directory(): string {
    return this.dir;
  }
}
