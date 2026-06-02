import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearClaudeSessionHistoryCacheForTests,
  getClaudeSessionHistoryPage,
} from "./claude-session-history.js";

const tempRoots: string[] = [];

function createTempProjectsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-history-test-"));
  tempRoots.push(root);
  return root;
}

function writeSessionHistoryFile(
  projectsRoot: string,
  projectDirName: string,
  sessionId: string,
  lines: Array<Record<string, unknown>>,
) {
  const projectDir = join(projectsRoot, projectDirName);
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  clearClaudeSessionHistoryCacheForTests();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("getClaudeSessionHistoryPage", () => {
  it("paginates chronologically while deduping assistant updates by message id", () => {
    // Validate the loader merges repeated assistant updates into one message
    // and returns cursor pages from newest backwards.
    const root = createTempProjectsRoot();
    const sessionId = "session-a";
    writeSessionHistoryFile(root, "-Users-test-repo", sessionId, [
      { type: "file-history-snapshot" },
      {
        type: "user",
        sessionId,
        uuid: "u-1",
        timestamp: "2026-02-20T10:00:00.000Z",
        message: { role: "user", content: "First prompt" },
      },
      {
        type: "assistant",
        sessionId,
        uuid: "a-1-1",
        timestamp: "2026-02-20T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "assistant-1",
          model: "claude-opus",
          stop_reason: null,
          content: [{ type: "thinking", thinking: "Thinking..." }],
        },
      },
      {
        type: "assistant",
        sessionId,
        uuid: "a-1-2",
        timestamp: "2026-02-20T10:00:02.000Z",
        message: {
          role: "assistant",
          id: "assistant-1",
          model: "claude-opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Merged final answer." }],
        },
      },
      {
        type: "user",
        sessionId,
        uuid: "u-meta",
        isMeta: true,
        timestamp: "2026-02-20T10:00:03.000Z",
        message: { role: "user", content: "<command-name>/exit</command-name>" },
      },
      {
        type: "user",
        sessionId,
        uuid: "u-tool-result",
        timestamp: "2026-02-20T10:00:04.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "tool output" }],
        },
      },
      {
        type: "user",
        sessionId,
        uuid: "u-2",
        timestamp: "2026-02-20T10:00:05.000Z",
        message: { role: "user", content: "Second prompt" },
      },
      {
        type: "assistant",
        sessionId,
        uuid: "a-2",
        timestamp: "2026-02-20T10:00:06.000Z",
        message: {
          role: "assistant",
          id: "assistant-2",
          model: "claude-opus",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
        },
      },
    ]);

    const latestPage = getClaudeSessionHistoryPage({
      sessionId,
      projectsRoot: root,
      limit: 2,
      cursor: 0,
    });

    expect(latestPage).not.toBeNull();
    expect(latestPage?.totalMessages).toBe(4);
    expect(latestPage?.hasMore).toBe(true);
    expect(latestPage?.nextCursor).toBe(2);
    expect(latestPage?.messages.map((msg) => msg.role)).toEqual(["user", "assistant"]);
    expect(latestPage?.messages[0].content).toBe("Second prompt");

    const olderPage = getClaudeSessionHistoryPage({
      sessionId,
      projectsRoot: root,
      limit: 2,
      cursor: latestPage?.nextCursor,
    });

    expect(olderPage).not.toBeNull();
    expect(olderPage?.hasMore).toBe(false);
    expect(olderPage?.messages.map((msg) => msg.role)).toEqual(["user", "assistant"]);
    expect(olderPage?.messages[1].content).toContain("Merged final answer.");
    expect(olderPage?.messages[1].content).toContain("Thinking...");
  });

  it("returns null when the session file cannot be found", () => {
    // Validate a clean null response for unknown sessions so routes can return 404.
    const root = createTempProjectsRoot();
    const page = getClaudeSessionHistoryPage({
      sessionId: "missing-session",
      projectsRoot: root,
      limit: 10,
    });
    expect(page).toBeNull();
  });
});
