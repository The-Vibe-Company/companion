import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRecording,
  filterEntries,
  getExpectedBrowserMessages,
  getIncomingCLIMessages,
} from "./replay.js";
import type { RecordingHeader, RecordingEntry } from "./recorder.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "replay-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHeader(overrides: Partial<RecordingHeader> = {}): RecordingHeader {
  return {
    _header: true,
    version: 1,
    session_id: "test-session",
    backend_type: "claude",
    started_at: 1739654400000,
    cwd: "/project",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RecordingEntry> = {}): RecordingEntry {
  return {
    ts: Date.now(),
    dir: "in",
    raw: '{"type":"system","subtype":"init"}',
    ch: "cli",
    ...overrides,
  };
}

/** Write a JSONL recording file and return its path. */
function writeRecording(
  header: RecordingHeader,
  entries: RecordingEntry[],
  filename = "test.jsonl",
): string {
  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
  const filePath = join(tempDir, filename);
  writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

// ─── loadRecording ───────────────────────────────────────────────────────────

describe("loadRecording", () => {
  it("parses a valid JSONL recording with header and entries", () => {
    const header = makeHeader();
    const entries = [
      makeEntry({ dir: "in", raw: '{"type":"system"}', ch: "cli" }),
      makeEntry({ dir: "out", raw: '{"type":"session_init"}', ch: "browser" }),
    ];
    const path = writeRecording(header, entries);

    const recording = loadRecording(path);

    expect(recording.header._header).toBe(true);
    expect(recording.header.version).toBe(1);
    expect(recording.header.session_id).toBe("test-session");
    expect(recording.header.backend_type).toBe("claude");
    expect(recording.entries).toHaveLength(2);
    expect(recording.entries[0].dir).toBe("in");
    expect(recording.entries[0].ch).toBe("cli");
    expect(recording.entries[1].dir).toBe("out");
    expect(recording.entries[1].ch).toBe("browser");
  });

  it("throws on empty file", () => {
    const path = join(tempDir, "empty.jsonl");
    writeFileSync(path, "");

    expect(() => loadRecording(path)).toThrow("empty");
  });

  it("throws on missing header", () => {
    // Write a file where the first line is not a header
    const path = join(tempDir, "no-header.jsonl");
    writeFileSync(path, '{"ts":123,"dir":"in","raw":"hello","ch":"cli"}\n');

    expect(() => loadRecording(path)).toThrow("Invalid recording header");
  });

  it("throws on wrong header version", () => {
    const path = join(tempDir, "bad-version.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ _header: true, version: 99, session_id: "x", backend_type: "claude", started_at: 0, cwd: "/" }) + "\n",
    );

    expect(() => loadRecording(path)).toThrow("version");
  });

  it("skips malformed entry lines gracefully", () => {
    // A recording file where one entry line is corrupt (simulating truncation)
    const header = makeHeader();
    const path = join(tempDir, "corrupt-entry.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(header),
        JSON.stringify(makeEntry({ raw: "good" })),
        "{not valid json!!!",
        JSON.stringify(makeEntry({ raw: "also-good" })),
      ].join("\n") + "\n",
    );

    const recording = loadRecording(path);
    expect(recording.entries).toHaveLength(2);
    expect(recording.entries[0].raw).toBe("good");
    expect(recording.entries[1].raw).toBe("also-good");
  });

  it("preserves raw strings exactly", () => {
    // Raw strings should be stored verbatim, including any internal formatting
    const rawWithSpaces = '{"type":"system",  "subtype": "init"}';
    const header = makeHeader();
    const entries = [makeEntry({ raw: rawWithSpaces })];
    const path = writeRecording(header, entries);

    const recording = loadRecording(path);
    expect(recording.entries[0].raw).toBe(rawWithSpaces);
  });

  it("handles header-only file (no entries)", () => {
    const header = makeHeader();
    const path = writeRecording(header, []);

    const recording = loadRecording(path);
    expect(recording.header.session_id).toBe("test-session");
    expect(recording.entries).toHaveLength(0);
  });
});

// ─── filterEntries ───────────────────────────────────────────────────────────

describe("filterEntries", () => {
  it("filters by direction and channel", () => {
    const entries = [
      makeEntry({ dir: "in", ch: "cli", raw: "a" }),
      makeEntry({ dir: "out", ch: "cli", raw: "b" }),
      makeEntry({ dir: "in", ch: "browser", raw: "c" }),
      makeEntry({ dir: "out", ch: "browser", raw: "d" }),
    ];

    expect(filterEntries(entries, "in", "cli")).toHaveLength(1);
    expect(filterEntries(entries, "in", "cli")[0].raw).toBe("a");

    expect(filterEntries(entries, "out", "browser")).toHaveLength(1);
    expect(filterEntries(entries, "out", "browser")[0].raw).toBe("d");

    expect(filterEntries(entries, "out", "cli")).toHaveLength(1);
    expect(filterEntries(entries, "in", "browser")).toHaveLength(1);
  });
});

// ─── getExpectedBrowserMessages ──────────────────────────────────────────────

describe("getExpectedBrowserMessages", () => {
  it("returns raw strings of outgoing browser messages", () => {
    const entries = [
      makeEntry({ dir: "in", ch: "cli", raw: "cli-in" }),
      makeEntry({ dir: "out", ch: "browser", raw: "browser-out-1" }),
      makeEntry({ dir: "out", ch: "cli", raw: "cli-out" }),
      makeEntry({ dir: "out", ch: "browser", raw: "browser-out-2" }),
    ];

    const result = getExpectedBrowserMessages(entries);
    expect(result).toEqual(["browser-out-1", "browser-out-2"]);
  });
});

// ─── getIncomingCLIMessages ──────────────────────────────────────────────────

describe("getIncomingCLIMessages", () => {
  it("returns raw strings of incoming CLI messages", () => {
    const entries = [
      makeEntry({ dir: "in", ch: "cli", raw: "cli-in-1" }),
      makeEntry({ dir: "out", ch: "browser", raw: "browser-out" }),
      makeEntry({ dir: "in", ch: "cli", raw: "cli-in-2" }),
      makeEntry({ dir: "in", ch: "browser", raw: "browser-in" }),
    ];

    const result = getIncomingCLIMessages(entries);
    expect(result).toEqual(["cli-in-1", "cli-in-2"]);
  });
});
