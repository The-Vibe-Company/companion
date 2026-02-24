// @vitest-environment jsdom
//
// Tests for the useSTT hook.
//
// The hook's key responsibilities:
//   - Manages a Web Worker lifecycle (create on mount, terminate on unmount)
//   - Drives a status state machine: idle → loading-model → ready → recording → transcribing
//   - Captures microphone audio via AudioContext / ScriptProcessorNode
//   - Appends transcribed text via the returned `transcript` field
//   - Surfaces mic/transcription errors with a 3-second auto-reset

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSTT } from "./useSTT.js";

// ─── Controllable Worker mock ─────────────────────────────────────────────────
//
// Each renderHook call creates a new Worker instance. We keep a reference to
// the most-recently created one so tests can inspect postMessage calls and
// simulate incoming messages.

let lastWorker: MockWorker | null = null;

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWorker = this;
  }

  /** Simulate a message arriving from the worker to the hook. */
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

vi.stubGlobal("Worker", MockWorker);

// ─── AudioContext mock ────────────────────────────────────────────────────────
//
// createScriptProcessor returns a processor whose onaudioprocess we can trigger
// from tests to simulate captured audio frames.
// AudioContext must be a class (not vi.fn) so that `new AudioContext()` works
// correctly in Vitest 4.

const mockTrack = { stop: vi.fn() };
const mockStream = { getTracks: vi.fn(() => [mockTrack]) };

const mockSilentDest = {};
const mockProcessor = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  // The hook assigns this; tests read it back to simulate audio frames.
  onaudioprocess: null as ((ev: AudioProcessingEvent) => void) | null,
};
const mockSource = { connect: vi.fn() };

let lastAudioCtx: MockAudioContext | null = null;
class MockAudioContext {
  sampleRate = 44100;
  createMediaStreamSource = vi.fn(() => mockSource);
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  createScriptProcessor = vi.fn(() => mockProcessor);
  createMediaStreamDestination = vi.fn(() => mockSilentDest);
  close = vi.fn().mockResolvedValue(undefined);
  constructor() { lastAudioCtx = this; }
}

vi.stubGlobal("AudioContext", MockAudioContext);

// ─── getUserMedia mock ────────────────────────────────────────────────────────

const mockGetUserMedia = vi.fn();
Object.defineProperty(navigator, "mediaDevices", {
  value: { getUserMedia: mockGetUserMedia },
  writable: true,
  configurable: true,
});

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  lastWorker = null;
  lastAudioCtx = null;
  mockGetUserMedia.mockReset();
  mockProcessor.connect.mockClear();
  mockProcessor.disconnect.mockClear();
  mockProcessor.onaudioprocess = null;
  mockSource.connect.mockClear();
  mockTrack.stop.mockClear();
  mockStream.getTracks.mockClear();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Perform a full startRecording sequence: call startRecording and resolve getUserMedia. */
async function startRecording(
  result: { current: ReturnType<typeof useSTT> },
  stream = mockStream as unknown as MediaStream,
) {
  mockGetUserMedia.mockResolvedValueOnce(stream);
  await act(async () => {
    await result.current.startRecording();
  });
}

/** Helper to simulate a single audio frame arriving in the processor. */
function emitAudioFrame(samples: number[]) {
  const channelData = new Float32Array(samples);
  mockProcessor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => channelData },
  } as unknown as AudioProcessingEvent);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useSTT — initial state", () => {
  it("starts in idle status with empty transcript and no error", () => {
    const { result } = renderHook(() => useSTT());
    expect(result.current.status).toBe("idle");
    expect(result.current.transcript).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("creates a Worker on mount", () => {
    renderHook(() => useSTT());
    expect(lastWorker).toBeTruthy();
  });

  it("terminates the worker on unmount", () => {
    const { unmount } = renderHook(() => useSTT());
    const worker = lastWorker!;
    unmount();
    expect(worker.terminate).toHaveBeenCalled();
  });
});

describe("useSTT — startRecording", () => {
  it("sends load message to worker on first call", async () => {
    const { result } = renderHook(() => useSTT());
    await startRecording(result);
    expect(lastWorker!.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "load" }),
    );
  });

  it("calls getUserMedia with audio: true", async () => {
    const { result } = renderHook(() => useSTT());
    await startRecording(result);
    expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("transitions to loading-model when model is not yet loaded", async () => {
    // Worker sends 'loading' to simulate the model starting to download
    const { result } = renderHook(() => useSTT());
    await startRecording(result);

    act(() => {
      lastWorker!.emit({ type: "loading" });
    });

    expect(result.current.status).toBe("loading-model");
  });

  it("transitions directly to recording when model already loaded", async () => {
    // Simulate model pre-loaded by sending ready before startRecording
    const { result } = renderHook(() => useSTT());

    act(() => {
      lastWorker!.emit({ type: "ready" });
    });
    expect(result.current.status).toBe("ready");

    await startRecording(result);
    // Model is already loaded — status should jump straight to recording
    expect(result.current.status).toBe("recording");
  });

  it("is a no-op when already capturing", async () => {
    const { result } = renderHook(() => useSTT());
    mockGetUserMedia.mockResolvedValue(mockStream);

    await act(async () => { await result.current.startRecording(); });
    const firstCallCount = lastWorker!.postMessage.mock.calls.length;

    await act(async () => { await result.current.startRecording(); });
    // No additional postMessage or getUserMedia calls
    expect(lastWorker!.postMessage.mock.calls.length).toBe(firstCallCount);
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
  });

  it("skips the load message on second recording when model is already loaded", async () => {
    const { result } = renderHook(() => useSTT());

    // First recording
    await startRecording(result);
    act(() => { lastWorker!.emit({ type: "ready" }); });

    // Stop and simulate transcription completing
    act(() => { result.current.stopRecording(); });
    act(() => { lastWorker!.emit({ type: "result", text: "hello" }); });

    lastWorker!.postMessage.mockClear();

    // Second recording — should NOT send load again
    await startRecording(result);
    const loadCalls = lastWorker!.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "load",
    );
    expect(loadCalls).toHaveLength(0);
  });
});

describe("useSTT — worker message handling", () => {
  it("transitions to ready when worker sends ready (not capturing)", () => {
    const { result } = renderHook(() => useSTT());
    act(() => { lastWorker!.emit({ type: "ready" }); });
    expect(result.current.status).toBe("ready");
  });

  it("transitions to recording when worker sends ready while capturing", async () => {
    const { result } = renderHook(() => useSTT());
    // Start recording while model is still loading
    await startRecording(result);
    act(() => { lastWorker!.emit({ type: "loading" }); });
    expect(result.current.status).toBe("loading-model");

    // Now model finishes loading while mic is already open
    act(() => { lastWorker!.emit({ type: "ready" }); });
    expect(result.current.status).toBe("recording");
  });

  it("sets transcript and returns to ready on result message", async () => {
    const { result } = renderHook(() => useSTT());
    await startRecording(result);
    act(() => { lastWorker!.emit({ type: "ready" }); });
    act(() => { result.current.stopRecording(); });

    act(() => { lastWorker!.emit({ type: "result", text: "hello world" }); });

    expect(result.current.transcript).toBe("hello world");
    expect(result.current.status).toBe("ready");
  });

  it("sets error state and auto-resets to idle on worker error (model not loaded)", () => {
    const { result } = renderHook(() => useSTT());

    act(() => { lastWorker!.emit({ type: "error", message: "Something broke" }); });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Something broke");

    // After 3 seconds the error should auto-clear and return to idle
    act(() => { vi.advanceTimersByTime(3000); });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("auto-resets to ready (not idle) on error when model was loaded", async () => {
    const { result } = renderHook(() => useSTT());
    act(() => { lastWorker!.emit({ type: "ready" }); });

    act(() => { lastWorker!.emit({ type: "error", message: "fail" }); });
    act(() => { vi.advanceTimersByTime(3000); });

    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });
});

describe("useSTT — stopRecording", () => {
  it("sends transcribe message to worker with audio and sampling rate", async () => {
    const { result } = renderHook(() => useSTT());
    await startRecording(result);
    act(() => { lastWorker!.emit({ type: "ready" }); });

    // Simulate some captured audio
    emitAudioFrame([0.1, 0.2, 0.3]);

    act(() => { result.current.stopRecording(); });

    const transcribeCall = lastWorker!.postMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "transcribe",
    );
    expect(transcribeCall).toBeTruthy();
    expect((transcribeCall![0] as { sampling_rate: number }).sampling_rate).toBe(44100);
    expect((transcribeCall![0] as { audio: Float32Array }).audio).toBeInstanceOf(Float32Array);
  });

  it("transitions to transcribing state", async () => {
    const { result } = renderHook(() => useSTT());
    await startRecording(result);
    act(() => { lastWorker!.emit({ type: "ready" }); });
    emitAudioFrame([0.5]);

    act(() => { result.current.stopRecording(); });

    expect(result.current.status).toBe("transcribing");
  });

  it("returns to idle (not transcribing) when no audio was captured", async () => {
    const { result } = renderHook(() => useSTT());
    await startRecording(result);
    act(() => { lastWorker!.emit({ type: "ready" }); });
    // No emitAudioFrame — zero chunks

    act(() => { result.current.stopRecording(); });

    // No transcribe message sent
    const transcribeCall = lastWorker!.postMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "transcribe",
    );
    expect(transcribeCall).toBeUndefined();
    expect(result.current.status).toBe("ready");
  });

  it("disconnects processor and stops media stream tracks", async () => {
    const { result } = renderHook(() => useSTT());
    await startRecording(result);
    act(() => { result.current.stopRecording(); });

    expect(mockProcessor.disconnect).toHaveBeenCalled();
    expect(mockTrack.stop).toHaveBeenCalled();
  });

  it("is a no-op when not currently capturing", () => {
    const { result } = renderHook(() => useSTT());
    act(() => { result.current.stopRecording(); });
    expect(lastWorker!.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "transcribe" }),
    );
  });
});

describe("useSTT — getUserMedia errors", () => {
  it("sets error state when mic access is denied", async () => {
    const { result } = renderHook(() => useSTT());
    mockGetUserMedia.mockRejectedValueOnce(
      new Error("Permission denied"),
    );

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/denied/i);
  });

  it("auto-resets error state after 3 seconds", async () => {
    const { result } = renderHook(() => useSTT());
    mockGetUserMedia.mockRejectedValueOnce(new Error("NotAllowedError"));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.status).toBe("error");

    act(() => { vi.advanceTimersByTime(3000); });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});

describe("useSTT — cleanup on unmount", () => {
  it("stops media stream and closes AudioContext when unmounted while recording", async () => {
    const { result, unmount } = renderHook(() => useSTT());
    await startRecording(result);
    act(() => { lastWorker!.emit({ type: "ready" }); });

    unmount();

    expect(mockTrack.stop).toHaveBeenCalled();
    expect(lastAudioCtx!.close).toHaveBeenCalled();
  });

  it("cancels the error-reset timeout on unmount to prevent state-after-unmount", async () => {
    const { result, unmount } = renderHook(() => useSTT());

    act(() => { lastWorker!.emit({ type: "error", message: "oops" }); });
    expect(result.current.status).toBe("error");

    // Unmount before the 3-second timeout fires
    unmount();

    // Advancing time should not throw a "cannot update unmounted component" error
    expect(() => {
      act(() => { vi.advanceTimersByTime(3000); });
    }).not.toThrow();
  });
});
