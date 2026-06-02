import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

describe("logger", () => {
  let log: typeof import("./logger.js").log;
  const originalEnv = process.env.COMPANION_LOG_FORMAT;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COMPANION_LOG_FORMAT;
    } else {
      process.env.COMPANION_LOG_FORMAT = originalEnv;
    }
  });

  describe("human-readable format (default)", () => {
    beforeEach(async () => {
      delete process.env.COMPANION_LOG_FORMAT;
      const mod = await import("./logger.js");
      log = mod.log;
    });

    it("formats info messages with bracket prefix", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("ws-bridge", "Browser connected", { sessionId: "abc-123", browsers: 3 });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain("[ws-bridge]");
      expect(output).toContain("Browser connected");
      expect(output).toContain("sessionId=abc-123");
      expect(output).toContain("browsers=3");
      spy.mockRestore();
    });

    it("formats warn messages", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      log.warn("orchestrator", "Relaunch limit reached", { sessionId: "s1" });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain("[orchestrator]");
      expect(output).toContain("Relaunch limit reached");
      spy.mockRestore();
    });

    it("formats error messages", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      log.error("cli-launcher", "Process crashed", { exitCode: 1 });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain("[cli-launcher]");
      expect(output).toContain("exitCode=1");
      spy.mockRestore();
    });

    it("handles messages without data", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("server", "Started");
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toBe("[server] Started");
      spy.mockRestore();
    });
  });

  describe("JSON format (COMPANION_LOG_FORMAT=json)", () => {
    beforeEach(async () => {
      process.env.COMPANION_LOG_FORMAT = "json";
      const mod = await import("./logger.js");
      log = mod.log;
    });

    it("outputs valid JSON with required fields", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("ws-bridge", "CLI connected", { sessionId: "s1" });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("ws-bridge");
      expect(parsed.msg).toBe("CLI connected");
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.ts).toBeDefined();
      spy.mockRestore();
    });

    it("core metadata fields cannot be overwritten by caller data", () => {
      // Caller-supplied keys with names matching core fields should not
      // overwrite ts, level, module, or msg.
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("real-module", "real message", {
        level: "error" as any,
        module: "evil",
        msg: "overwritten",
        ts: "tampered",
      });
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("real-module");
      expect(parsed.msg).toBe("real message");
      expect(parsed.ts).not.toBe("tampered");
      spy.mockRestore();
    });
  });
});

describe("LogFileWriter", () => {
  let LogFileWriter: typeof import("./logger.js").LogFileWriter;
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    // Create a unique temp directory for each test to avoid cross-contamination
    tmpDir = join(tmpdir(), `companion-log-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    const mod = await import("./logger.js");
    LogFileWriter = mod.LogFileWriter;
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates a log file in the specified directory", () => {
    // Verify that constructing a LogFileWriter creates a .log file
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000 });
    try {
      const files = readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
      expect(files).toHaveLength(1);
      expect(writer.filePath).toContain(tmpDir);
      expect(writer.filePath).toMatch(/\.log$/);
    } finally {
      writer.close();
    }
  });

  it("writes log lines to the file", () => {
    // Write multiple lines and verify they appear in the file
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000 });
    try {
      writer.write("[server] Line one");
      writer.write("[server] Line two");
      writer.write("[server] Line three");

      const content = readFileSync(writer.filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("[server] Line one");
      expect(lines[1]).toBe("[server] Line two");
      expect(lines[2]).toBe("[server] Line three");
    } finally {
      writer.close();
    }
  });

  it("includes PID in the filename for uniqueness across server runs", () => {
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000 });
    try {
      // Filename format: companion_{iso-timestamp}_{pid}.log
      const filename = writer.filePath.split("/").pop()!;
      expect(filename).toContain(`_${process.pid}.log`);
      expect(filename).toMatch(/^companion_/);
    } finally {
      writer.close();
    }
  });

  it("exposes logsDir and maxLines for status reporting", () => {
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 42 });
    try {
      expect(writer.getLogsDir()).toBe(tmpDir);
      expect(writer.getMaxLines()).toBe(42);
    } finally {
      writer.close();
    }
  });

  describe("rotation", () => {
    it("deletes oldest log files when total lines exceed maxLines", () => {
      // Pre-create two old log files with known line counts and distinct mtimes
      // so rotation deletes the oldest first.
      const oldFile1 = join(tmpDir, "companion_2020-01-01T00-00-00_1.log");
      const oldFile2 = join(tmpDir, "companion_2020-06-01T00-00-00_2.log");
      writeFileSync(oldFile1, "line1\nline2\nline3\nline4\nline5\n");
      writeFileSync(oldFile2, "line1\nline2\nline3\nline4\nline5\n");

      // Set explicit mtimes: oldFile1 is oldest, oldFile2 is newer
      const past1 = new Date("2020-01-01");
      const past2 = new Date("2020-06-01");
      utimesSync(oldFile1, past1, past1);
      utimesSync(oldFile2, past2, past2);

      // maxLines = 8: total is 5 + 5 = 10 lines > 8, so oldest file (oldFile1)
      // gets deleted bringing total to 5 which is <= 8.
      const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 8 });
      try {
        // Initial cleanup is deferred — run it explicitly for the test
        writer.cleanup();
        const files = readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
        // oldFile1 should have been deleted by cleanup, oldFile2 and current remain
        expect(files).toHaveLength(2);
        // The oldest file should be gone
        expect(files.some((f) => f.includes("2020-01-01"))).toBe(false);
        // The newer old file should still exist
        expect(files.some((f) => f.includes("2020-06-01"))).toBe(true);
      } finally {
        writer.close();
      }
    });

    it("does not delete the current log file during cleanup", () => {
      // Pre-create one old file that puts us over the limit, with an old mtime
      const oldFile = join(tmpDir, "companion_2020-01-01T00-00-00_1.log");
      writeFileSync(oldFile, "line1\nline2\nline3\n");
      utimesSync(oldFile, new Date("2020-01-01"), new Date("2020-01-01"));

      // maxLines = 2 means we're over limit but the current file must survive
      const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 2 });
      try {
        writer.write("current line 1");
        writer.write("current line 2");
        writer.write("current line 3");

        // Force another cleanup pass
        const deleted = writer.cleanup();
        expect(deleted).toBeGreaterThanOrEqual(0);

        // Current file must still exist and be writable
        writer.write("still works");
        const content = readFileSync(writer.filePath, "utf-8");
        expect(content).toContain("still works");
      } finally {
        writer.close();
      }
    });

    it("returns the number of files deleted during cleanup", () => {
      // Create 3 old files with 5 lines each = 15 lines total, with distinct mtimes
      for (let i = 0; i < 3; i++) {
        const f = join(tmpDir, `companion_2020-0${i + 1}-01T00-00-00_${i}.log`);
        writeFileSync(f, "a\nb\nc\nd\ne\n");
        const past = new Date(`2020-0${i + 1}-01`);
        utimesSync(f, past, past);
      }

      // maxLines = 5 means we need to delete at least 2 old files
      const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 5 });
      try {
        // Initial cleanup is deferred — run it explicitly for the test
        writer.cleanup();
        const files = readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
        // At most the newest old file + current file should remain
        expect(files.length).toBeLessThanOrEqual(2);
      } finally {
        writer.close();
      }
    });
  });

  describe("isEnabled", () => {
    const origLogFile = process.env.COMPANION_LOG_FILE;

    afterEach(() => {
      if (origLogFile === undefined) {
        delete process.env.COMPANION_LOG_FILE;
      } else {
        process.env.COMPANION_LOG_FILE = origLogFile;
      }
    });

    it("returns true by default (no env var set)", async () => {
      delete process.env.COMPANION_LOG_FILE;
      vi.resetModules();
      const mod = await import("./logger.js");
      expect(mod.LogFileWriter.isEnabled()).toBe(true);
    });

    it("returns false when COMPANION_LOG_FILE=0", async () => {
      process.env.COMPANION_LOG_FILE = "0";
      vi.resetModules();
      const mod = await import("./logger.js");
      expect(mod.LogFileWriter.isEnabled()).toBe(false);
    });

    it("returns false when COMPANION_LOG_FILE=false", async () => {
      process.env.COMPANION_LOG_FILE = "false";
      vi.resetModules();
      const mod = await import("./logger.js");
      expect(mod.LogFileWriter.isEnabled()).toBe(false);
    });
  });
});

describe("initLogFile / closeLogFile", () => {
  let initLogFile: typeof import("./logger.js").initLogFile;
  let closeLogFile: typeof import("./logger.js").closeLogFile;
  let log: typeof import("./logger.js").log;
  let tmpDir: string;

  const origLogFile = process.env.COMPANION_LOG_FILE;
  const origLogFormat = process.env.COMPANION_LOG_FORMAT;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), `companion-log-init-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    delete process.env.COMPANION_LOG_FILE;
    delete process.env.COMPANION_LOG_FORMAT;
    const mod = await import("./logger.js");
    initLogFile = mod.initLogFile;
    closeLogFile = mod.closeLogFile;
    log = mod.log;
  });

  afterEach(() => {
    closeLogFile();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (origLogFile === undefined) {
      delete process.env.COMPANION_LOG_FILE;
    } else {
      process.env.COMPANION_LOG_FILE = origLogFile;
    }
    if (origLogFormat === undefined) {
      delete process.env.COMPANION_LOG_FORMAT;
    } else {
      process.env.COMPANION_LOG_FORMAT = origLogFormat;
    }
  });

  it("tees log output to file after initialization", () => {
    // Initialize the log file writer, then verify that log.info writes to both
    // console and the log file
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const writer = initLogFile({ logsDir: tmpDir });
    expect(writer).not.toBeNull();

    log.info("test-module", "Hello world");

    // Console should have been called
    expect(consoleSpy).toHaveBeenCalledOnce();

    // File should contain the same line
    const content = readFileSync(writer!.filePath, "utf-8");
    expect(content).toContain("[test-module] Hello world");

    consoleSpy.mockRestore();
  });

  it("returns null when disabled via env var", async () => {
    process.env.COMPANION_LOG_FILE = "0";
    vi.resetModules();
    const mod = await import("./logger.js");
    const writer = mod.initLogFile({ logsDir: tmpDir });
    expect(writer).toBeNull();
  });

  it("stops writing to file after closeLogFile()", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const writer = initLogFile({ logsDir: tmpDir });
    expect(writer).not.toBeNull();

    log.info("mod", "before close");
    closeLogFile();
    log.info("mod", "after close");

    // Console gets both calls
    expect(consoleSpy).toHaveBeenCalledTimes(2);

    // File should only have the first line (closeLogFile nulls out the writer
    // so subsequent writes are no-ops to the file)
    const content = readFileSync(writer!.filePath, "utf-8");
    expect(content).toContain("before close");
    expect(content).not.toContain("after close");

    consoleSpy.mockRestore();
  });
});
