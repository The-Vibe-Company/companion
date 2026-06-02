import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredClaudeSession {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  slug?: string;
  lastActivityAt: number;
  sourceFile: string;
}

export interface DiscoverClaudeSessionsOptions {
  limit?: number;
  projectsRoot?: string;
}

const DEFAULT_DISCOVERY_LIMIT = 200;
const MAX_DISCOVERY_LIMIT = 1000;
const METADATA_SCAN_BYTES = 1024 * 1024; // 1 MiB from file head is enough for first metadata records.

function extractMetadataFromJsonl(
  filePath: string,
): Pick<DiscoveredClaudeSession, "sessionId" | "cwd" | "gitBranch" | "slug"> | null {
  let content = "";
  const buffer = Buffer.allocUnsafe(METADATA_SCAN_BYTES);
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const bytesRead = readSync(fd, buffer, 0, METADATA_SCAN_BYTES, 0);
    content = buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // no-op
      }
    }
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        sessionId?: unknown;
        cwd?: unknown;
        gitBranch?: unknown;
        slug?: unknown;
      };
      if (typeof parsed.sessionId !== "string" || typeof parsed.cwd !== "string") {
        continue;
      }
      return {
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        gitBranch: typeof parsed.gitBranch === "string" ? parsed.gitBranch : undefined,
        slug: typeof parsed.slug === "string" ? parsed.slug : undefined,
      };
    } catch {
      // Ignore malformed/truncated line fragments near chunk boundary.
    }
  }

  return null;
}

export function discoverClaudeSessions(
  options: DiscoverClaudeSessionsOptions = {},
): DiscoveredClaudeSession[] {
  const projectsRoot = options.projectsRoot
    || process.env.CLAUDE_PROJECTS_DIR
    || join(homedir(), ".claude", "projects");
  const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : DEFAULT_DISCOVERY_LIMIT;
  const limit = Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Math.floor(requestedLimit || DEFAULT_DISCOVERY_LIMIT)));

  if (!existsSync(projectsRoot)) return [];

  const sessionFiles: Array<{ filePath: string; mtimeMs: number }> = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(projectsRoot, projectDir);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(projectPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(projectPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = join(projectPath, entry);
      try {
        const fileStats = statSync(filePath);
        if (!fileStats.isFile()) continue;
        sessionFiles.push({
          filePath,
          mtimeMs: fileStats.mtimeMs,
        });
      } catch {
        // Skip deleted/corrupt entries.
      }
    }
  }

  sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const uniqueBySessionId = new Map<string, DiscoveredClaudeSession>();
  for (const candidate of sessionFiles) {
    if (uniqueBySessionId.size >= limit) break;

    const metadata = extractMetadataFromJsonl(candidate.filePath);
    if (!metadata) continue;

    const prev = uniqueBySessionId.get(metadata.sessionId);
    if (prev && prev.lastActivityAt >= candidate.mtimeMs) {
      continue;
    }

    uniqueBySessionId.set(metadata.sessionId, {
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
      gitBranch: metadata.gitBranch,
      slug: metadata.slug,
      lastActivityAt: candidate.mtimeMs,
      sourceFile: candidate.filePath,
    });
  }

  return Array.from(uniqueBySessionId.values())
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit)
    .map((session) => ({
      ...session,
      // Defensive fallback if older records don't carry sessionId in JSONL.
      sessionId: session.sessionId || basename(session.sourceFile, ".jsonl"),
    }));
}
