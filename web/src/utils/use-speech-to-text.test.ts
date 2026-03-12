// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSpeechToText } from "./use-speech-to-text.js";

// Mock SpeechRecognition API
class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
}

let savedSpeechRecognition: unknown;

beforeEach(() => {
  savedSpeechRecognition = (window as unknown as Record<string, unknown>).SpeechRecognition;
  (window as unknown as Record<string, unknown>).SpeechRecognition = MockSpeechRecognition;
});

afterEach(() => {
  if (savedSpeechRecognition !== undefined) {
    (window as unknown as Record<string, unknown>).SpeechRecognition = savedSpeechRecognition;
  } else {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  }
  vi.restoreAllMocks();
});

describe("useSpeechToText", () => {
  it("reports isSupported=true when SpeechRecognition is available", () => {
    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );
    expect(result.current.isSupported).toBe(true);
  });

  it("reports isSupported=false when SpeechRecognition is not available", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;

    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );
    expect(result.current.isSupported).toBe(false);
    expect(result.current.isListening).toBe(false);
  });

  it("starts listening when startListening is called", () => {
    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.startListening();
    });

    expect(result.current.isListening).toBe(true);
  });

  it("stops listening when stopListening is called", () => {
    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);

    act(() => {
      result.current.stopListening();
    });
    expect(result.current.isListening).toBe(false);
  });

  it("toggles listening state with toggleListening", () => {
    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    // Toggle on
    act(() => {
      result.current.toggleListening();
    });
    expect(result.current.isListening).toBe(true);

    // Toggle off
    act(() => {
      result.current.toggleListening();
    });
    expect(result.current.isListening).toBe(false);
  });

  it("does not double-start when already listening", () => {
    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.startListening();
    });

    // Second start should be no-op
    act(() => {
      result.current.startListening();
    });

    expect(result.current.isListening).toBe(true);
  });

  it("does not throw when stopListening called while not listening", () => {
    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    // Should not throw
    act(() => {
      result.current.stopListening();
    });

    expect(result.current.isListening).toBe(false);
  });

  it("initializes with default state", () => {
    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    expect(result.current.isListening).toBe(false);
    expect(result.current.interimText).toBe("");
  });

  it("cleans up recognition on unmount", () => {
    const { unmount } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    // Should not throw during unmount
    unmount();
  });

  it("handles startListening gracefully when not supported", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;

    const { result } = renderHook(() =>
      useSpeechToText({ onTranscript: vi.fn() }),
    );

    // Should be no-op, not throw
    act(() => {
      result.current.startListening();
    });
    expect(result.current.isListening).toBe(false);

    act(() => {
      result.current.toggleListening();
    });
    expect(result.current.isListening).toBe(false);
  });
});
