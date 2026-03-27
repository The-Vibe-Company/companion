/**
 * Voice session orchestrator — ties together AudioCapture, AudioPlayback,
 * GeminiLiveClient, tool execution, and Zustand store updates.
 *
 * Usage:
 * ```ts
 * await startVoiceSession();  // Connects to Gemini, starts mic
 * stopVoiceSession();         // Disconnects, stops mic/playback
 * ```
 */

import { AudioCapture, AudioPlayback } from "./voice-audio.js";
import { GeminiLiveClient, type GeminiLiveCallbacks } from "./gemini-live.js";
import { executeVoiceTool, TOOL_DECLARATIONS, VOICE_SYSTEM_INSTRUCTION } from "./voice-tools.js";
import { useStore } from "../store.js";
import { api } from "../api.js";

let capture: AudioCapture | null = null;
let playback: AudioPlayback | null = null;
let client: GeminiLiveClient | null = null;

/**
 * Start a voice session: fetch Gemini API key, connect to Gemini Live API,
 * start microphone capture, and wire everything together.
 */
export async function startVoiceSession(): Promise<void> {
  const store = useStore.getState();

  // Prevent double-start
  if (store.voiceActive || store.voiceConnecting) return;

  store.setVoiceConnecting(true);
  store.setVoiceError(null);
  store.setVoiceTranscript("");
  store.setVoiceLastToolCall(null);

  // 1. Fetch Gemini API key
  let apiKey: string;
  try {
    const response = await api.getGeminiKey();
    apiKey = response.key;
    if (!apiKey?.trim()) {
      store.setVoiceError("Gemini API key not configured. Go to Settings → Gemini Voice to add your key.");
      store.setVoiceConnecting(false);
      return;
    }
  } catch (e) {
    store.setVoiceError(e instanceof Error ? e.message : "Failed to fetch Gemini API key");
    store.setVoiceConnecting(false);
    return;
  }

  // 2. Create audio components
  capture = new AudioCapture();
  playback = new AudioPlayback();

  playback.onPlaybackEnd = () => {
    useStore.getState().setVoiceSpeaking(false);
  };

  // 3. Create Gemini Live client with callbacks
  const callbacks: GeminiLiveCallbacks = {
    onReady: () => {
      const s = useStore.getState();
      s.setVoiceActive(true);
      s.setVoiceConnecting(false);
      s.setVoiceListening(true);

      // Start microphone capture
      capture?.start().catch((err) => {
        const msg = err instanceof Error ? err.message : "Microphone access denied";
        useStore.getState().setVoiceError(msg);
        stopVoiceSession();
      });
    },

    onAudio: (base64Pcm) => {
      useStore.getState().setVoiceSpeaking(true);
      playback?.play(base64Pcm);
    },

    onText: (text) => {
      useStore.getState().appendVoiceTranscript(text);
    },

    onToolCall: async (call) => {
      const s = useStore.getState();
      s.setVoiceLastToolCall({ name: call.name, args: call.args });

      try {
        const result = await executeVoiceTool(call.name, call.args);
        client?.sendToolResponse(call.id, call.name, result);
      } catch (e) {
        const errorResult = { error: e instanceof Error ? e.message : String(e) };
        client?.sendToolResponse(call.id, call.name, errorResult);
      }
    },

    onError: (error) => {
      useStore.getState().setVoiceError(error);
      stopVoiceSession();
    },

    onDisconnect: () => {
      // Clean up state when Gemini disconnects
      cleanup();
    },

    onInterrupted: () => {
      // User barge-in: stop playing audio so the mic can pick up user speech
      playback?.stop();
      useStore.getState().setVoiceSpeaking(false);
    },
  };

  client = new GeminiLiveClient(apiKey, callbacks, {
    systemInstruction: VOICE_SYSTEM_INSTRUCTION,
    tools: TOOL_DECLARATIONS,
  });

  // 4. Wire audio capture → Gemini
  capture.onAudioChunk = (base64Pcm) => {
    client?.sendAudio(base64Pcm);
  };

  // 5. Connect to Gemini
  client.connect();
}

/**
 * Stop the voice session: disconnect from Gemini, stop mic and playback.
 */
export function stopVoiceSession(): void {
  cleanup();
}

/**
 * Check if a voice session is currently active.
 */
export function isVoiceSessionActive(): boolean {
  return useStore.getState().voiceActive;
}

// ─── Internal cleanup ────────────────────────────────────────────────────────

function cleanup(): void {
  if (capture) {
    capture.stop();
    capture = null;
  }
  if (playback) {
    playback.stop();
    playback = null;
  }
  if (client) {
    client.disconnect();
    client = null;
  }
  useStore.getState().resetVoice();
}
