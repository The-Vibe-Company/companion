// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installClipboardWriteFallback, resetClipboardFallbackForTests } from "./clipboard.js";

describe("installClipboardWriteFallback", () => {
  beforeEach(() => {
    resetClipboardFallbackForTests();
  });

  it("falls back to execCommand when clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommandMock,
    });

    installClipboardWriteFallback();
    await window.navigator.clipboard.writeText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommandMock).toHaveBeenCalledWith("copy");
  });

  it("defines clipboard.writeText when clipboard is missing", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommandMock,
    });

    installClipboardWriteFallback();
    await window.navigator.clipboard.writeText("fallback");

    expect(execCommandMock).toHaveBeenCalledWith("copy");
  });

  it("keeps promise pending when both native and fallback copy fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommandMock = vi.fn().mockReturnValue(false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommandMock,
    });

    installClipboardWriteFallback();
    const copyPromise = window.navigator.clipboard.writeText("hello");
    const outcome = await Promise.race([
      copyPromise.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(outcome).toBe("pending");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommandMock).toHaveBeenCalledWith("copy");
  });
});
