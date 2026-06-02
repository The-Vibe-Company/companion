/**
 * Storage and indexing for curated recording files.
 *
 * Recordings uploaded or imported into the hub live in ~/.companion/hub/recordings/
 * (separate from the auto-recording directory to avoid rotation cleanup).
 * An index file (index.json) provides fast listing without re-parsing JSONL.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { COMPANION_HOME } from "../paths.js";
import { loadRecording } from "../replay.js";
import type { RecordingHeader, RecordingEntry } from "../recorder.js";
import type { BackendType } from "../session-types.js";
import { getMaxUploadBytes } from "./hub-config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HubRecordingMeta {
  id: string;
  filename: string;
  sessionId: string;
  backendType: BackendType;
  startedAt: number;
  duration: number;
  entryCount: number;
  cwd: string;
  tags: string[];
  importedAt: number;
  messageTypeSummary: Record<string, number>;
}

export interface HubRecordingSummary extends HubRecordingMeta {
  toolNames: string[];
  permissionCount: number;
}

// ─── HubStore ────────────────────────────────────────────────────────────────

const HUB_DIR = join(COMPANION_HOME, "hub");
const RECORDINGS_DIR = join(HUB_DIR, "recordings");
const INDEX_PATH = join(HUB_DIR, "index.json");

export class HubStore {
  private index: Map<string, HubRecordingMeta> = new Map();
  private dirCreated = false;

  constructor() {
    this.ensureDir();
    this.loadIndex();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Import a recording from the auto-recordings directory by copying it. */
  importLocal(sourcePath: string): HubRecordingMeta {
    this.validateFileSize(sourcePath);
    const recording = loadRecording(sourcePath);
    const id = randomUUID();
    const destFilename = `${id}.jsonl`;
    const destPath = join(RECORDINGS_DIR, destFilename);
    copyFileSync(sourcePath, destPath);
    const meta = this.buildMeta(id, destFilename, recording.header, recording.entries);
    this.index.set(id, meta);
    this.saveIndex();
    return meta;
  }

  /** Import from raw JSONL content (e.g. from an upload). */
  importContent(content: string, originalFilename?: string): HubRecordingMeta {
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    if (sizeBytes > getMaxUploadBytes()) {
      throw new Error(`File too large: ${Math.round(sizeBytes / 1024 / 1024)}MB exceeds limit`);
    }

    // Validate by parsing
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) throw new Error("Recording file is empty");

    const header = JSON.parse(lines[0]) as RecordingHeader;
    if (!header._header || header.version !== 1) {
      throw new Error("Invalid recording header: missing _header or version !== 1");
    }
    if (header.backend_type !== "claude" && header.backend_type !== "codex") {
      throw new Error(`Invalid backend_type: ${header.backend_type}`);
    }

    // Spot-check entries
    const entries: RecordingEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as RecordingEntry;
        if (typeof entry.ts !== "number" || !entry.dir || typeof entry.raw !== "string" || !entry.ch) {
          throw new Error(`Malformed entry at line ${i + 1}`);
        }
        entries.push(entry);
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new Error(`Malformed JSON at line ${i + 1}`);
        }
        throw err;
      }
    }

    const id = randomUUID();
    const destFilename = `${id}.jsonl`;
    const destPath = join(RECORDINGS_DIR, destFilename);
    writeFileSync(destPath, content, "utf-8");

    const meta = this.buildMeta(id, originalFilename || destFilename, header, entries);
    this.index.set(id, meta);
    this.saveIndex();
    return meta;
  }

  list(): HubRecordingMeta[] {
    return Array.from(this.index.values()).sort((a, b) => b.importedAt - a.importedAt);
  }

  get(id: string): HubRecordingMeta | null {
    return this.index.get(id) ?? null;
  }

  /** Load the full recording content from disk. */
  loadRecording(id: string) {
    const meta = this.index.get(id);
    if (!meta) return null;
    const filePath = this.recordingPath(id);
    if (!existsSync(filePath)) return null;
    return loadRecording(filePath);
  }

  /** Get the file path for a recording. */
  recordingPath(id: string): string {
    return join(RECORDINGS_DIR, `${id}.jsonl`);
  }

  delete(id: string): boolean {
    const meta = this.index.get(id);
    if (!meta) return false;
    const filePath = this.recordingPath(id);
    try {
      unlinkSync(filePath);
    } catch {
      // File may already be gone
    }
    this.index.delete(id);
    this.saveIndex();
    return true;
  }

  updateTags(id: string, tags: string[]): HubRecordingMeta | null {
    const meta = this.index.get(id);
    if (!meta) return null;
    meta.tags = tags;
    this.saveIndex();
    return meta;
  }

  /** Get a summary with tool names and permission count. */
  getSummary(id: string): HubRecordingSummary | null {
    const recording = this.loadRecording(id);
    if (!recording) return null;
    const meta = this.index.get(id);
    if (!meta) return null;

    const toolNames = new Set<string>();
    let permissionCount = 0;

    for (const entry of recording.entries) {
      if (entry.dir !== "out" || entry.ch !== "browser") continue;
      try {
        const msg = JSON.parse(entry.raw);
        if (msg.type === "permission_request" && msg.tool_name) {
          toolNames.add(msg.tool_name);
          permissionCount++;
        }
      } catch {
        // Skip unparseable
      }
    }

    return { ...meta, toolNames: Array.from(toolNames), permissionCount };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private buildMeta(
    id: string,
    filename: string,
    header: RecordingHeader,
    entries: RecordingEntry[],
  ): HubRecordingMeta {
    const typeSummary: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.dir !== "out" || entry.ch !== "browser") continue;
      try {
        const msg = JSON.parse(entry.raw);
        const type = msg.type || "unknown";
        typeSummary[type] = (typeSummary[type] || 0) + 1;
      } catch {
        // Skip
      }
    }

    const firstTs = entries[0]?.ts ?? header.started_at;
    const lastTs = entries[entries.length - 1]?.ts ?? firstTs;

    return {
      id,
      filename,
      sessionId: header.session_id,
      backendType: header.backend_type,
      startedAt: header.started_at,
      duration: lastTs - firstTs,
      entryCount: entries.length,
      cwd: header.cwd,
      tags: [],
      importedAt: Date.now(),
      messageTypeSummary: typeSummary,
    };
  }

  private validateFileSize(path: string): void {
    const stat = statSync(path);
    if (stat.size > getMaxUploadBytes()) {
      throw new Error(`File too large: ${Math.round(stat.size / 1024 / 1024)}MB exceeds limit`);
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    mkdirSync(RECORDINGS_DIR, { recursive: true });
    this.dirCreated = true;
  }

  private loadIndex(): void {
    try {
      if (existsSync(INDEX_PATH)) {
        const raw = readFileSync(INDEX_PATH, "utf-8");
        const entries = JSON.parse(raw) as HubRecordingMeta[];
        for (const entry of entries) {
          this.index.set(entry.id, entry);
        }
      }
    } catch {
      // Start fresh if index is corrupted
      this.index.clear();
    }
  }

  private saveIndex(): void {
    const entries = Array.from(this.index.values());
    writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), "utf-8");
  }
}
