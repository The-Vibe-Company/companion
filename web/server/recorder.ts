import { mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BackendType } from "./session-types.js";
import { COMPANION_HOME } from "./paths.js";
import { countFileLines } from "./fs-utils.js";

const DEFAULT_MAX_LINES = 1_000_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Redact IDE `authToken` values from a raw protocol payload before it lands
 * on disk. `mcp_set_servers` carries the IDE's auth token and that payload
 * is otherwise stripped from browser + session-store paths; recordings must
 * not become the one place where it leaks.
 *
 * Regex-based so it works on any JSON depth without parsing, and so a
 * malformed payload still gets redacted rather than written verbatim.
 */
const AUTH_TOKEN_PATTERN = /"authToken"\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*"/g;
export function redactAuthTokens(raw: string): string {
  if (!raw || raw.indexOf("authToken") === -1) return raw;
  return raw.replace(AUTH_TOKEN_PATTERN, '"authToken":"[REDACTED]"');
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecordingHeader {
  _header: true;
  version: 1;
  session_id: string;
  backend_type: BackendType;
  started_at: number;
  cwd: string;
}

export type RecordingDirection = "in" | "out";
export type RecordingChannel = "cli" | "browser";

export type RecordingLifecycleEvent =
  | "ws_open"
  | "ws_close"
  | "ws_error"
  | "reconnect_attempt"
  | "reconnect_success";

export interface RecordingEntry {
  ts: number;
  dir: RecordingDirection;
  raw: string;
  ch: RecordingChannel;
  /** Optional connection lifecycle event (for disconnection diagnostics). */
  event?: RecordingLifecycleEvent;
  /** Optional metadata for lifecycle events (e.g. close code, error message). */
  meta?: Record<string, unknown>;
}

export interface RecordingFileMeta {
  filename: string;
  sessionId: string;
  backendType: string;
  startedAt: string;
  /** Number of lines in the file (header + entries). */
  lines: number;
}

// ─── SessionRecorder ─────────────────────────────────────────────────────────

/**
 * Writes raw messages for a single session to a JSONL file.
 * First line is a header with session metadata; subsequent lines are entries.
 * Tracks its own line count so the manager can enforce the global limit.
 */
export class SessionRecorder {
  readonly filePath: string;
  private closed = false;
  private _recordWriteErrorLogged = false;
  /** Number of lines written (1 for the header at construction). */
  lineCount = 1;

  constructor(
    sessionId: string,
    backendType: BackendType,
    cwd: string,
    outputDir: string,
  ) {
    const ts = new Date().toISOString().replace(/:/g, "-");
    const suffix = randomBytes(3).toString("hex");
    const filename = `${sessionId}_${backendType}_${ts}_${suffix}.jsonl`;
    this.filePath = join(outputDir, filename);

    const header: RecordingHeader = {
      _header: true,
      version: 1,
      session_id: sessionId,
      backend_type: backendType,
      started_at: Date.now(),
      cwd,
    };
    appendFileSync(this.filePath, JSON.stringify(header) + "\n");
  }

  record(dir: RecordingDirection, raw: string, channel: RecordingChannel): void {
    if (this.closed) return;
    const entry: RecordingEntry = {
      ts: Date.now(),
      dir,
      raw: redactAuthTokens(raw),
      ch: channel,
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
      this.lineCount++;
    } catch (err) {
      // Never throw — recording must not disrupt normal operation.
      // But log once so operators can diagnose disk/permission issues.
      if (!this._recordWriteErrorLogged) {
        this._recordWriteErrorLogged = true;
        console.warn(`[recorder] Write failed for ${this.filePath}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Record a connection lifecycle event (open, close, error, reconnect). */
  recordEvent(
    event: RecordingLifecycleEvent,
    channel: RecordingChannel,
    meta?: Record<string, unknown>,
  ): void {
    if (this.closed) return;
    const entry: RecordingEntry = {
      ts: Date.now(),
      dir: "in",
      raw: "",
      ch: channel,
      event,
      ...(meta ? { meta } : {}),
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
      this.lineCount++;
    } catch (err) {
      if (!this._recordWriteErrorLogged) {
        this._recordWriteErrorLogged = true;
        console.warn(`[recorder] Write failed for ${this.filePath}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}

// ─── RecorderManager ─────────────────────────────────────────────────────────

/**
 * Manages recording for all sessions.
 *
 * Always enabled by default. Disable explicitly with COMPANION_RECORD=0.
 *
 * Automatic rotation: when total lines across all recording files exceed
 * maxLines (default 1 000 000, override with COMPANION_RECORDINGS_MAX_LINES),
 * the oldest files are deleted until we're back under the limit.
 */
export class RecorderManager {
  private globalEnabled: boolean;
  private recordingsDir: string;
  private maxLines: number;
  private perSessionEnabled = new Set<string>();
  private perSessionDisabled = new Set<string>();
  private recorders = new Map<string, SessionRecorder>();
  private dirCreated = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: {
    globalEnabled?: boolean;
    recordingsDir?: string;
    maxLines?: number;
  }) {
    this.globalEnabled = options?.globalEnabled ?? RecorderManager.resolveEnabled();
    this.recordingsDir =
      options?.recordingsDir ??
      process.env.COMPANION_RECORDINGS_DIR ??
      join(COMPANION_HOME, "recordings");
    this.maxLines =
      options?.maxLines ??
      (Number(process.env.COMPANION_RECORDINGS_MAX_LINES) || DEFAULT_MAX_LINES);

    if (this.globalEnabled) {
      // Run cleanup at startup (async, non-blocking) and periodically
      this.cleanup();
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  /**
   * Always on unless explicitly disabled with COMPANION_RECORD=0|false.
   */
  private static resolveEnabled(): boolean {
    const env = process.env.COMPANION_RECORD;
    if (env === "0" || env === "false") return false;
    return true;
  }

  isGloballyEnabled(): boolean {
    return this.globalEnabled;
  }

  getRecordingsDir(): string {
    return this.recordingsDir;
  }

  getMaxLines(): number {
    return this.maxLines;
  }

  isRecording(sessionId: string): boolean {
    if (this.perSessionDisabled.has(sessionId)) return false;
    return this.globalEnabled || this.perSessionEnabled.has(sessionId);
  }

  enableForSession(sessionId: string): void {
    this.perSessionDisabled.delete(sessionId);
    this.perSessionEnabled.add(sessionId);
  }

  disableForSession(sessionId: string): void {
    this.perSessionEnabled.delete(sessionId);
    this.perSessionDisabled.add(sessionId);
    this.stopRecording(sessionId);
  }

  /**
   * Record a raw message. No-op if recording is disabled for this session.
   * Lazily creates the SessionRecorder on first call.
   */
  record(
    sessionId: string,
    dir: RecordingDirection,
    raw: string,
    channel: RecordingChannel,
    backendType: BackendType,
    cwd: string,
  ): void {
    if (!this.isRecording(sessionId)) return;

    let recorder = this.recorders.get(sessionId);
    if (!recorder) {
      this.ensureDir();
      recorder = new SessionRecorder(sessionId, backendType, cwd, this.recordingsDir);
      this.recorders.set(sessionId, recorder);
    }
    recorder.record(dir, raw, channel);
  }

  /** Record a connection lifecycle event for diagnostics. */
  recordEvent(
    sessionId: string,
    event: RecordingLifecycleEvent,
    channel: RecordingChannel,
    meta?: Record<string, unknown>,
  ): void {
    const recorder = this.recorders.get(sessionId);
    if (recorder) {
      recorder.recordEvent(event, channel, meta);
    }
  }

  stopRecording(sessionId: string): void {
    const recorder = this.recorders.get(sessionId);
    if (recorder) {
      recorder.close();
      this.recorders.delete(sessionId);
    }
  }

  getRecordingStatus(sessionId: string): { filePath?: string } {
    const recorder = this.recorders.get(sessionId);
    return recorder ? { filePath: recorder.filePath } : {};
  }

  listRecordings(): RecordingFileMeta[] {
    try {
      const files = readdirSync(this.recordingsDir);
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((filename) => {
          // Format: {sessionId}_{backendType}_{ISO-timestamp}_{suffix}.jsonl
          const withoutExt = filename.replace(/\.jsonl$/, "");
          const firstUnderscore = withoutExt.indexOf("_");
          const secondUnderscore = withoutExt.indexOf("_", firstUnderscore + 1);
          if (firstUnderscore === -1 || secondUnderscore === -1) {
            return { filename, sessionId: "", backendType: "", startedAt: "", lines: 0 };
          }
          // Count lines — fast: just count newlines
          const lines = countFileLines(join(this.recordingsDir, filename));
          return {
            filename,
            sessionId: withoutExt.substring(0, firstUnderscore),
            backendType: withoutExt.substring(firstUnderscore + 1, secondUnderscore),
            startedAt: withoutExt.substring(secondUnderscore + 1),
            lines,
          };
        });
    } catch {
      return [];
    }
  }

  closeAll(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [, recorder] of this.recorders) {
      recorder.close();
    }
    this.recorders.clear();
  }

  /**
   * Delete oldest recording files until total lines are under maxLines.
   * Skips files that belong to active (currently recording) sessions.
   */
  cleanup(): number {
    try {
      this.ensureDir();
      const files = readdirSync(this.recordingsDir).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) return 0;

      // Build list with line counts and mtime, sorted oldest-first
      const activeFiles = new Set<string>();
      for (const rec of this.recorders.values()) {
        activeFiles.add(rec.filePath);
      }

      const entries: { filename: string; path: string; lines: number; mtimeMs: number }[] = [];
      let totalLines = 0;

      for (const filename of files) {
        const fullPath = join(this.recordingsDir, filename);
        const lines = countFileLines(fullPath);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
        entries.push({ filename, path: fullPath, lines, mtimeMs });
        totalLines += lines;
      }

      if (totalLines <= this.maxLines) return 0;

      // Sort oldest first (lowest mtime = oldest)
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let deleted = 0;
      for (const entry of entries) {
        if (totalLines <= this.maxLines) break;
        // Don't delete files that are actively being written to
        if (activeFiles.has(entry.path)) continue;
        try {
          unlinkSync(entry.path);
          totalLines -= entry.lines;
          deleted++;
        } catch {
          // File may have been removed concurrently
        }
      }

      if (deleted > 0) {
        console.log(`[recorder] Cleanup: deleted ${deleted} old recording(s), ${totalLines} lines remaining`);
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    mkdirSync(this.recordingsDir, { recursive: true });
    this.dirCreated = true;
  }
}

