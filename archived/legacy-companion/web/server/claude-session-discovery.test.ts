import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverClaudeSessions } from "./claude-session-discovery.js";

const tempRoots: string[] = [];

function createTempProjectsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-projects-test-"));
  tempRoots.push(root);
  return root;
}

function writeSessionFile(
  projectsRoot: string,
  projectDirName: string,
  fileName: string,
  payload: {
    sessionId: string;
    cwd: string;
    gitBranch?: string;
    slug?: string;
  },
  mtimeMs: number,
) {
  const projectDir = join(projectsRoot, projectDirName);
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, fileName);
  const content = `${JSON.stringify({ type: "file-history-snapshot" })}\n${JSON.stringify(payload)}\n`;
  writeFileSync(filePath, content, "utf-8");
  const mtime = new Date(mtimeMs);
  utimesSync(filePath, mtime, mtime);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("discoverClaudeSessions", () => {
  it("discovers persisted Claude sessions with cwd/branch metadata", () => {
    const root = createTempProjectsRoot();
    // Validate that a normal JSONL session file is parsed into resumable metadata.
    writeSessionFile(
      root,
      "-Users-test-repo",
      "session-a.jsonl",
      {
        sessionId: "session-a",
        cwd: "/Users/test/repo",
        gitBranch: "main",
        slug: "curious-babbage",
      },
      1000,
    );

    const sessions = discoverClaudeSessions({ projectsRoot: root, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-a",
      cwd: "/Users/test/repo",
      gitBranch: "main",
      slug: "curious-babbage",
    });
  });

  it("deduplicates by sessionId and keeps the most recently active record", () => {
    const root = createTempProjectsRoot();
    // Validate that when the same session appears in multiple files, the newest one wins.
    writeSessionFile(
      root,
      "-Users-test-repo",
      "session-a-old.jsonl",
      {
        sessionId: "session-a",
        cwd: "/Users/test/repo",
        gitBranch: "main",
      },
      1000,
    );
    writeSessionFile(
      root,
      "-Users-test-repo",
      "session-a-new.jsonl",
      {
        sessionId: "session-a",
        cwd: "/Users/test/repo",
        gitBranch: "feature/new-ui",
      },
      2000,
    );

    const sessions = discoverClaudeSessions({ projectsRoot: root, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].gitBranch).toBe("feature/new-ui");
    expect(sessions[0].lastActivityAt).toBe(2000);
  });

  it("applies the requested limit after sorting by recency", () => {
    const root = createTempProjectsRoot();
    // Validate that callers can bound result size for responsive UI pickers.
    writeSessionFile(
      root,
      "-Users-test-repo",
      "session-1.jsonl",
      { sessionId: "session-1", cwd: "/Users/test/repo-1" },
      1000,
    );
    writeSessionFile(
      root,
      "-Users-test-repo",
      "session-2.jsonl",
      { sessionId: "session-2", cwd: "/Users/test/repo-2" },
      2000,
    );
    writeSessionFile(
      root,
      "-Users-test-repo",
      "session-3.jsonl",
      { sessionId: "session-3", cwd: "/Users/test/repo-3" },
      3000,
    );

    const sessions = discoverClaudeSessions({ projectsRoot: root, limit: 2 });

    expect(sessions.map((s) => s.sessionId)).toEqual(["session-3", "session-2"]);
  });
});
