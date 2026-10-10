import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist the mock so it's available before the module import
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

import { countFileLines } from "./fs-utils.js";

describe("countFileLines", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  // --- Normal cases ---

  it("should_return_correct_count_when_file_has_multiple_lines", () => {
    // A file with 3 lines has 2 newline characters (no trailing newline)
    // But if saved with trailing newline, it has 3 newline characters
    const content = "line1\nline2\nline3\n";
    mockReadFileSync.mockReturnValue(Buffer.from(content));

    expect(countFileLines("/some/file.txt")).toBe(3);
  });

  it("should_return_zero_when_file_is_empty", () => {
    mockReadFileSync.mockReturnValue(Buffer.from(""));

    expect(countFileLines("/some/empty.txt")).toBe(0);
  });

  it("should_return_zero_when_file_has_single_line_without_newline", () => {
    // A single line with no trailing newline has zero 0x0A bytes
    mockReadFileSync.mockReturnValue(Buffer.from("hello world"));

    expect(countFileLines("/some/single.txt")).toBe(0);
  });

  it("should_return_one_when_file_has_single_line_with_trailing_newline", () => {
    mockReadFileSync.mockReturnValue(Buffer.from("hello world\n"));

    expect(countFileLines("/some/single-nl.txt")).toBe(1);
  });

  it("should_count_consecutive_newlines_when_file_has_blank_lines", () => {
    // Two consecutive newlines = 2 counts
    const content = "line1\n\nline3\n";
    mockReadFileSync.mockReturnValue(Buffer.from(content));

    expect(countFileLines("/some/blanks.txt")).toBe(3);
  });

  it("should_handle_windows_line_endings_when_file_has_crlf", () => {
    // \r\n should still count the \n bytes (0x0A)
    const content = "line1\r\nline2\r\nline3\r\n";
    mockReadFileSync.mockReturnValue(Buffer.from(content));

    expect(countFileLines("/some/windows.txt")).toBe(3);
  });

  it("should_handle_large_content_when_file_has_many_lines", () => {
    // Build a buffer with exactly 1000 newlines
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n") + "\n";
    mockReadFileSync.mockReturnValue(Buffer.from(lines));

    expect(countFileLines("/some/big.txt")).toBe(1000);
  });

  it("should_only_count_newline_bytes_when_file_has_binary_content", () => {
    // Binary buffer with exactly 2 0x0A bytes at known positions
    const buf = Buffer.from([0x00, 0x0a, 0xff, 0x0a, 0x42]);
    mockReadFileSync.mockReturnValue(buf);

    expect(countFileLines("/some/binary.bin")).toBe(2);
  });

  // --- Edge cases ---

  it("should_pass_path_to_readFileSync_when_called", () => {
    mockReadFileSync.mockReturnValue(Buffer.from(""));

    countFileLines("/my/specific/path.txt");

    expect(mockReadFileSync).toHaveBeenCalledWith("/my/specific/path.txt");
  });

  // --- Error handling ---

  it("should_return_zero_when_file_does_not_exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    expect(countFileLines("/nonexistent/file.txt")).toBe(0);
  });

  it("should_return_zero_when_permission_denied", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(countFileLines("/restricted/file.txt")).toBe(0);
  });

  it("should_return_zero_when_readFileSync_throws_any_error", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new TypeError("unexpected error");
    });

    expect(countFileLines("/broken/file.txt")).toBe(0);
  });
});
