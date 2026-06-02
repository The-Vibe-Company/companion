import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getLinearIssue,
  setLinearIssue,
  getAllLinearIssues,
  removeLinearIssue,
  _resetForTest,
  type StoredLinearIssue,
} from "./session-linear-issues.js";

let tempDir: string;

const mockIssue: StoredLinearIssue = {
  id: "issue-1",
  identifier: "ENG-123",
  title: "Fix auth bug",
  description: "Authentication is broken when using SSO",
  url: "https://linear.app/team/issue/ENG-123",
  branchName: "eng-123-fix-auth-bug",
  priorityLabel: "High",
  stateName: "In Progress",
  stateType: "started",
  teamName: "Engineering",
  teamKey: "ENG",
  teamId: "team-1",
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "session-linear-issues-test-"));
  _resetForTest(join(tempDir, "session-linear-issues.json"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("session-linear-issues", () => {
  it("returns undefined for unknown session", () => {
    expect(getLinearIssue("unknown")).toBeUndefined();
  });

  it("setLinearIssue + getLinearIssue round-trip", () => {
    setLinearIssue("s1", mockIssue);
    expect(getLinearIssue("s1")).toEqual(mockIssue);
  });

  it("persists to disk", () => {
    setLinearIssue("s1", mockIssue);
    const raw = readFileSync(join(tempDir, "session-linear-issues.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.s1).toEqual(mockIssue);
  });

  it("getAllLinearIssues returns a copy", () => {
    setLinearIssue("s1", mockIssue);
    const all = getAllLinearIssues();
    expect(all.s1).toEqual(mockIssue);
    // Verify it's a copy (mutating doesn't affect internal state)
    all.s2 = mockIssue;
    expect(getLinearIssue("s2")).toBeUndefined();
  });

  it("removeLinearIssue deletes the mapping", () => {
    setLinearIssue("s1", mockIssue);
    removeLinearIssue("s1");
    expect(getLinearIssue("s1")).toBeUndefined();
    const raw = readFileSync(join(tempDir, "session-linear-issues.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({});
  });

  it("overwrites existing issue", () => {
    setLinearIssue("s1", mockIssue);
    const updated = { ...mockIssue, stateName: "Done", stateType: "completed" };
    setLinearIssue("s1", updated);
    expect(getLinearIssue("s1")).toEqual(updated);
  });

  it("creates parent directories if needed", () => {
    const nestedPath = join(tempDir, "nested", "dir", "issues.json");
    _resetForTest(nestedPath);
    setLinearIssue("s1", mockIssue);
    expect(getLinearIssue("s1")).toEqual(mockIssue);
  });

  it("loads existing data from disk on first access", () => {
    // Write data to file before any module access
    writeFileSync(
      join(tempDir, "session-linear-issues.json"),
      JSON.stringify({ existing: mockIssue }),
    );
    _resetForTest(join(tempDir, "session-linear-issues.json"));
    expect(getLinearIssue("existing")).toEqual(mockIssue);
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(join(tempDir, "session-linear-issues.json"), "NOT VALID JSON");
    _resetForTest(join(tempDir, "session-linear-issues.json"));
    expect(getLinearIssue("any")).toBeUndefined();
  });

  it("supports multiple sessions with different issues", () => {
    const issue2 = { ...mockIssue, id: "issue-2", identifier: "ENG-456", title: "Add dark mode" };
    setLinearIssue("s1", mockIssue);
    setLinearIssue("s2", issue2);
    expect(getLinearIssue("s1")?.identifier).toBe("ENG-123");
    expect(getLinearIssue("s2")?.identifier).toBe("ENG-456");
    const all = getAllLinearIssues();
    expect(Object.keys(all)).toHaveLength(2);
  });
});
