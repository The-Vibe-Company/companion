// @vitest-environment jsdom
/**
 * Tests for voice-session.ts orchestrator.
 *
 * Validates the lifecycle of a voice session: starting (fetches API key,
 * creates audio + Gemini client, wires callbacks), stopping (cleans up),
 * and error handling (no key, mic denied).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useStore } from "../store.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock api module
vi.mock("../api.js", () => ({
  api: {
    getGeminiKey: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
  },
  createSessionStream: vi.fn(),
}));

// Mock AudioCapture & AudioPlayback
const mockCaptureStart = vi.fn().mockResolvedValue(undefined);
const mockCaptureStop = vi.fn();
const mockPlaybackPlay = vi.fn();
const mockPlaybackStop = vi.fn();

vi.mock("./voice-audio.js", () => ({
  AudioCapture: class {
    start = mockCaptureStart;
    stop = mockCaptureStop;
    onAudioChunk: ((b: string) => void) | null = null;
    active = false;
  },
  AudioPlayback: class {
    play = mockPlaybackPlay;
    stop = mockPlaybackStop;
    isPlaying = false;
    onPlaybackEnd: (() => void) | null = null;
  },
}));

// Mock GeminiLiveClient
const mockClientConnect = vi.fn();
const mockClientDisconnect = vi.fn();
const mockClientSendAudio = vi.fn();
const mockClientSendToolResponse = vi.fn();
let capturedCallbacks: Record<string, (...args: unknown[]) => void> = {};

vi.mock("./gemini-live.js", () => ({
  GeminiLiveClient: class {
    connect = mockClientConnect;
    disconnect = mockClientDisconnect;
    sendAudio = mockClientSendAudio;
    sendToolResponse = mockClientSendToolResponse;
    connected = false;
    constructor(_apiKey: string, callbacks: Record<string, (...args: unknown[]) => void>) {
      capturedCallbacks = callbacks;
    }
  },
}));

// Mock voice-tools
vi.mock("./voice-tools.js", () => ({
  executeVoiceTool: vi.fn().mockResolvedValue({ success: true }),
  TOOL_DECLARATIONS: [{ name: "test_tool" }],
  VOICE_SYSTEM_INSTRUCTION: "Test system instruction",
}));

describe("voice-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = {};
    useStore.getState().resetVoice();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── startVoiceSession ──────────────────────────────────────────────────

  it("sets voiceConnecting on start and voiceActive on ready", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession } = await import("./voice-session.js");
    const promise = startVoiceSession();

    // Should set connecting
    expect(useStore.getState().voiceConnecting).toBe(true);

    await promise;

    // Should have created the client and called connect
    expect(mockClientConnect).toHaveBeenCalled();

    // Simulate Gemini ready
    capturedCallbacks.onReady();

    expect(useStore.getState().voiceActive).toBe(true);
    expect(useStore.getState().voiceConnecting).toBe(false);
    expect(useStore.getState().voiceListening).toBe(true);
  });

  it("sets error when no API key configured", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "" });

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();

    expect(useStore.getState().voiceError).toContain("not configured");
    expect(useStore.getState().voiceConnecting).toBe(false);
  });

  it("sets error when API key fetch fails", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockRejectedValue(new Error("Network error"));

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();

    expect(useStore.getState().voiceError).toBe("Network error");
    expect(useStore.getState().voiceConnecting).toBe(false);
  });

  // ── Callback wiring ───────────────────────────────────────────────────

  it("onAudio callback plays audio and sets voiceSpeaking", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();
    capturedCallbacks.onReady();

    // Simulate audio from Gemini
    capturedCallbacks.onAudio("base64audio");

    expect(useStore.getState().voiceSpeaking).toBe(true);
    expect(mockPlaybackPlay).toHaveBeenCalledWith("base64audio");
  });

  it("onText callback appends to transcript", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();
    capturedCallbacks.onReady();

    capturedCallbacks.onText("Hello ");
    capturedCallbacks.onText("World");

    expect(useStore.getState().voiceTranscript).toBe("Hello World");
  });

  it("onToolCall executes tool and sends response", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();
    capturedCallbacks.onReady();

    await capturedCallbacks.onToolCall({ id: "call-1", name: "list_sessions", args: {} });

    expect(useStore.getState().voiceLastToolCall).toEqual({
      name: "list_sessions",
      args: {},
    });

    // Wait for async tool execution
    await vi.waitFor(() => {
      expect(mockClientSendToolResponse).toHaveBeenCalledWith("call-1", "list_sessions", { success: true });
    });
  });

  it("onError calls the error callback (triggers cleanup)", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();

    // onError in voice-session.ts sets error then calls stopVoiceSession()
    // which calls cleanup() which calls resetVoice().
    // So voiceError will be briefly set, then reset to null.
    // We verify the cleanup was called by checking that disconnect was invoked.
    capturedCallbacks.onError("Connection lost");

    expect(mockClientDisconnect).toHaveBeenCalled();
  });

  it("onInterrupted stops playback", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();
    capturedCallbacks.onReady();

    capturedCallbacks.onInterrupted();

    expect(mockPlaybackStop).toHaveBeenCalled();
    expect(useStore.getState().voiceSpeaking).toBe(false);
  });

  it("onDisconnect resets voice state", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();
    capturedCallbacks.onReady();

    capturedCallbacks.onDisconnect();

    expect(useStore.getState().voiceActive).toBe(false);
    expect(useStore.getState().voiceConnecting).toBe(false);
  });

  // ── stopVoiceSession ──────────────────────────────────────────────────

  it("stopVoiceSession cleans up and resets state", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    const { startVoiceSession, stopVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();
    capturedCallbacks.onReady();

    stopVoiceSession();

    expect(mockCaptureStop).toHaveBeenCalled();
    expect(mockPlaybackStop).toHaveBeenCalled();
    expect(mockClientDisconnect).toHaveBeenCalled();
    expect(useStore.getState().voiceActive).toBe(false);
  });

  // ── isVoiceSessionActive ──────────────────────────────────────────────

  it("isVoiceSessionActive reflects store state", async () => {
    const { isVoiceSessionActive } = await import("./voice-session.js");

    expect(isVoiceSessionActive()).toBe(false);

    useStore.getState().setVoiceActive(true);
    expect(isVoiceSessionActive()).toBe(true);
  });

  // ── Prevents double start ─────────────────────────────────────────────

  it("does not double-start if already connecting", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    useStore.getState().setVoiceConnecting(true);

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();

    // Should not have tried to fetch the key since already connecting
    expect(api.getGeminiKey).not.toHaveBeenCalled();
  });

  it("does not double-start if already active", async () => {
    const { api } = await import("../api.js");
    vi.mocked(api.getGeminiKey).mockResolvedValue({ key: "test-key" });

    useStore.getState().setVoiceActive(true);

    const { startVoiceSession } = await import("./voice-session.js");
    await startVoiceSession();

    expect(api.getGeminiKey).not.toHaveBeenCalled();
  });
});
