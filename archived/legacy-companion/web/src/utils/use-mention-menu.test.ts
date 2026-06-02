// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mockListPrompts = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    listPrompts: (...args: unknown[]) => mockListPrompts(...args),
  },
}));

import { useMentionMenu } from "./use-mention-menu.js";

const samplePrompts = [
  { id: "1", name: "review", content: "Please review this code", scope: "global" as const, createdAt: Date.now(), updatedAt: Date.now() },
  { id: "2", name: "refactor", content: "Refactor this module", scope: "global" as const, createdAt: Date.now(), updatedAt: Date.now() },
  { id: "3", name: "test-review", content: "Review the tests", scope: "global" as const, createdAt: Date.now(), updatedAt: Date.now() },
];

describe("useMentionMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPrompts.mockResolvedValue(samplePrompts);
  });

  it("returns closed menu when no @ is typed", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "hello world", caretPos: 11, cwd: "/repo" }),
    );
    // Wait for prompt loading to finish
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(false);
    expect(result.current.mentionContext).toBe(null);
  });

  it("detects @ at start of text", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);
    expect(result.current.mentionContext).toEqual({ query: "", start: 0, end: 1 });
  });

  it("detects @ after whitespace", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "hello @rev", caretPos: 10, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);
    expect(result.current.mentionContext).toEqual({ query: "rev", start: 6, end: 10 });
  });

  it("does not detect @ in the middle of a word", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "email@test", caretPos: 10, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(false);
    expect(result.current.mentionContext).toBe(null);
  });

  it("filters prompts with startsWith priority", async () => {
    // Type @rev — should match "review" (startsWith) first, then "test-review" (includes)
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@rev", caretPos: 4, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);
    expect(result.current.filteredPrompts.map((p) => p.name)).toEqual(["review", "test-review"]);
  });

  it("shows all prompts when @ is typed without a query", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.filteredPrompts).toHaveLength(3);
  });

  it("selectPrompt returns correct nextText and nextCursor", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "hello @rev", caretPos: 10, cwd: "/repo" }),
    );
    await act(async () => {});

    const output = result.current.selectPrompt(samplePrompts[0]);
    // "hello " + "Please review this code " = "hello Please review this code "
    expect(output.nextText).toBe("hello Please review this code ");
    // Cursor should be at end of inserted content + space
    expect(output.nextCursor).toBe("hello Please review this code ".length);
  });

  it("closes the menu when enabled is false", async () => {
    const { result, rerender } = renderHook(
      (props) => useMentionMenu(props),
      { initialProps: { text: "@", caretPos: 1, cwd: "/repo", enabled: true } },
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);

    rerender({ text: "@", caretPos: 1, cwd: "/repo", enabled: false });
    expect(result.current.mentionMenuOpen).toBe(false);
  });

  it("loads prompts on mount via api.listPrompts", async () => {
    renderHook(() =>
      useMentionMenu({ text: "", caretPos: 0, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledWith("/repo");
  });

  it("reloads prompts when cwd changes", async () => {
    const { rerender } = renderHook(
      (props) => useMentionMenu(props),
      { initialProps: { text: "", caretPos: 0, cwd: "/repo-a" } },
    );
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledWith("/repo-a");

    rerender({ text: "", caretPos: 0, cwd: "/repo-b" });
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledWith("/repo-b");
  });

  it("filters out prompts with empty names", async () => {
    mockListPrompts.mockResolvedValue([
      ...samplePrompts,
      { id: "4", name: "  ", content: "empty name", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }),
    );
    await act(async () => {});
    // The empty-name prompt should be filtered out
    expect(result.current.filteredPrompts).toHaveLength(3);
  });
});
