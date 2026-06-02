import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getName,
  setName,
  getAllNames,
  removeName,
  _resetForTest,
} from "./session-names.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "session-names-test-"));
  _resetForTest(join(tempDir, "session-names.json"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("session-names", () => {
  it("returns undefined for unknown session", () => {
    expect(getName("unknown")).toBeUndefined();
  });

  it("setName + getName round-trip", () => {
    setName("s1", "Fix auth bug");
    expect(getName("s1")).toBe("Fix auth bug");
  });

  it("persists to disk", () => {
    setName("s1", "My Session");
    const raw = readFileSync(join(tempDir, "session-names.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data).toEqual({ s1: "My Session" });
  });

  it("getAllNames returns a copy of all names", () => {
    setName("s1", "First");
    setName("s2", "Second");
    const all = getAllNames();
    expect(all).toEqual({ s1: "First", s2: "Second" });
    // Verify it's a copy (mutating doesn't affect internal state)
    all.s3 = "Third";
    expect(getName("s3")).toBeUndefined();
  });

  it("removeName deletes a name", () => {
    setName("s1", "Session One");
    removeName("s1");
    expect(getName("s1")).toBeUndefined();
    const raw = readFileSync(join(tempDir, "session-names.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({});
  });

  it("overwrites existing name", () => {
    setName("s1", "Old Name");
    setName("s1", "New Name");
    expect(getName("s1")).toBe("New Name");
  });

  it("creates parent directories if needed", () => {
    const nestedPath = join(tempDir, "nested", "dir", "names.json");
    _resetForTest(nestedPath);
    setName("s1", "Deep Session");
    expect(getName("s1")).toBe("Deep Session");
  });

  it("loads existing data from disk on first access", () => {
    // Write data to file before any module access
    writeFileSync(
      join(tempDir, "session-names.json"),
      JSON.stringify({ existing: "Pre-existing Name" }),
    );
    // Reset to re-read from the file
    _resetForTest(join(tempDir, "session-names.json"));
    expect(getName("existing")).toBe("Pre-existing Name");
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(join(tempDir, "session-names.json"), "NOT VALID JSON");
    _resetForTest(join(tempDir, "session-names.json"));
    expect(getName("any")).toBeUndefined();
  });
});
