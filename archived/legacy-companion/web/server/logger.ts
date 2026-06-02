// Lightweight structured logger for the Companion server.
// Provides JSON-structured log output for operational events while
// keeping the familiar console.log interface for human-readable logs.
//
// Log file persistence:
//   By default, all log output is also written to ~/.companion/logs/ with
//   automatic rotation (oldest files deleted when total lines exceed 2M).
//   Disable with COMPANION_LOG_FILE=0, override dir with COMPANION_LOG_DIR,
//   and configure rotation with COMPANION_LOG_MAX_LINES.
//
// Usage:
//   import { log } from "./logger.js";
//   log.info("ws-bridge", "Browser connected", { sessionId, browsers: 3 });
//   log.warn("orchestrator", "Git fetch failed", { sessionId, error: "..." });
//   log.error("cli-launcher", "Process crashed", { sessionId, exitCode: 1 });

import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { countFileLines } from "./fs-utils.js";

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  [key: string]: unknown;
}

const STRUCTURED = process.env.COMPANION_LOG_FORMAT === "json";

function formatEntry(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>): string {
  if (STRUCTURED) {
    const entry: LogEntry = {
      ...data,
      ts: new Date().toISOString(),
      level,
      module,
      msg,
    };
    return JSON.stringify(entry);
  }

  // Human-readable format (default): [module] msg key=value key=value
  let line = `[${module}] ${msg}`;
  if (data) {
    const pairs = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    if (pairs) line += ` | ${pairs}`;
  }
  return line;
}

// ─── Log File Writer ────────────────────────────────────────────────────────

const DEFAULT_LOG_MAX_LINES = 2_000_000;
const LOG_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Writes log lines to a file under ~/.companion/logs/ with automatic rotation.
 * A new log file is created each time the server starts. When total lines across
 * all log files exceed maxLines (default 2M), the oldest files are deleted.
 *
 * Follows the same pattern as RecorderManager for recordings.
 */
export class LogFileWriter {
  readonly filePath: string;
  private logsDir: string;
  private maxLines: number;
  private fd: number;
  private closed = false;
  private dirCreated = false;
  private initialCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { logsDir?: string; maxLines?: number }) {
    this.logsDir = options?.logsDir ?? LogFileWriter.resolveDir();
    this.maxLines =
      options?.maxLines ??
      (Number(process.env.COMPANION_LOG_MAX_LINES) || DEFAULT_LOG_MAX_LINES);

    this.ensureDir();

    // Create a new log file for this server run and keep the fd open
    const ts = new Date().toISOString().replace(/:/g, "-");
    const pid = process.pid;
    this.filePath = join(this.logsDir, `companion_${ts}_${pid}.log`);
    this.fd = openSync(this.filePath, "a");

    // Defer initial cleanup so it doesn't block the event loop at startup
    this.initialCleanupTimer = setTimeout(() => {
      this.initialCleanupTimer = null;
      this.cleanup();
    }, 2000);
    if (this.initialCleanupTimer.unref) this.initialCleanupTimer.unref();
    this.cleanupTimer = setInterval(() => this.cleanup(), LOG_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private static resolveDir(): string {
    return process.env.COMPANION_LOG_DIR ?? join(COMPANION_HOME, "logs");
  }

  /** Whether log file writing is enabled. Disable with COMPANION_LOG_FILE=0|false. */
  static isEnabled(): boolean {
    const env = process.env.COMPANION_LOG_FILE;
    if (env === "0" || env === "false") return false;
    return true;
  }

  getLogsDir(): string {
    return this.logsDir;
  }

  getMaxLines(): number {
    return this.maxLines;
  }

  write(line: string): void {
    if (this.closed) return;
    try {
      writeSync(this.fd, line + "\n");
    } catch {
      // Never throw — logging must not disrupt normal operation
    }
  }

  /**
   * Delete oldest log files until total lines are under maxLines.
   * Skips the current log file (still being written to).
   */
  cleanup(): number {
    try {
      this.ensureDir();
      const files = readdirSync(this.logsDir).filter((f) => f.endsWith(".log"));
      if (files.length === 0) return 0;

      const entries: { filename: string; path: string; lines: number; mtimeMs: number }[] = [];
      let totalLines = 0;

      for (const filename of files) {
        const fullPath = join(this.logsDir, filename);
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

      // Sort oldest first
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let deleted = 0;
      for (const entry of entries) {
        if (totalLines <= this.maxLines) break;
        // Don't delete the current log file
        if (entry.path === this.filePath) continue;
        try {
          unlinkSync(entry.path);
          totalLines -= entry.lines;
          deleted++;
        } catch {
          // File may have been removed concurrently
        }
      }

      if (deleted > 0) {
        // Log to console only (avoid recursion)
        console.log(`[logger] Cleanup: deleted ${deleted} old log file(s), ${totalLines} lines remaining`);
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  close(): void {
    this.closed = true;
    if (this.initialCleanupTimer) {
      clearTimeout(this.initialCleanupTimer);
      this.initialCleanupTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try { closeSync(this.fd); } catch { /* ignore */ }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    mkdirSync(this.logsDir, { recursive: true });
    this.dirCreated = true;
  }
}

// ─── Singleton file writer (initialized lazily) ─────────────────────────────

let fileWriter: LogFileWriter | null = null;

/**
 * Initialize the log file writer. Call once at server startup.
 * Returns the writer instance for status reporting, or null if disabled.
 */
export function initLogFile(options?: { logsDir?: string; maxLines?: number }): LogFileWriter | null {
  if (!LogFileWriter.isEnabled()) return null;
  if (fileWriter) {
    fileWriter.close();
  }
  fileWriter = new LogFileWriter(options);
  return fileWriter;
}

/** Shut down the log file writer (clears cleanup timer). */
export function closeLogFile(): void {
  if (fileWriter) {
    fileWriter.close();
    fileWriter = null;
  }
}

// ─── Public logger ──────────────────────────────────────────────────────────

export const log = {
  info(module: string, msg: string, data?: Record<string, unknown>): void {
    const line = formatEntry("info", module, msg, data);
    console.log(line);
    fileWriter?.write(line);
  },

  warn(module: string, msg: string, data?: Record<string, unknown>): void {
    const line = formatEntry("warn", module, msg, data);
    console.warn(line);
    fileWriter?.write(line);
  },

  error(module: string, msg: string, data?: Record<string, unknown>): void {
    const line = formatEntry("error", module, msg, data);
    console.error(line);
    fileWriter?.write(line);
  },
};
