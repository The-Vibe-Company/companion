/**
 * Zustand slice for voice control state.
 *
 * Tracks whether the voice session is active, connecting, listening,
 * or speaking, plus the current transcript and last tool call info.
 */

import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";

export interface VoiceSlice {
  /** Whether a Gemini voice session is currently active. */
  voiceActive: boolean;
  /** Whether we're currently connecting to Gemini. */
  voiceConnecting: boolean;
  /** Whether the microphone is actively capturing audio. */
  voiceListening: boolean;
  /** Whether Gemini audio is currently playing back. */
  voiceSpeaking: boolean;
  /** Current transcript text (from user speech or Gemini response). */
  voiceTranscript: string;
  /** The most recent tool call made by Gemini (for UI display). */
  voiceLastToolCall: { name: string; args: Record<string, unknown> } | null;
  /** Current error message, if any. */
  voiceError: string | null;

  setVoiceActive: (active: boolean) => void;
  setVoiceConnecting: (connecting: boolean) => void;
  setVoiceListening: (listening: boolean) => void;
  setVoiceSpeaking: (speaking: boolean) => void;
  setVoiceTranscript: (text: string) => void;
  appendVoiceTranscript: (text: string) => void;
  setVoiceLastToolCall: (call: { name: string; args: Record<string, unknown> } | null) => void;
  setVoiceError: (error: string | null) => void;
  resetVoice: () => void;
}

export const createVoiceSlice: StateCreator<AppState, [], [], VoiceSlice> = (set) => ({
  voiceActive: false,
  voiceConnecting: false,
  voiceListening: false,
  voiceSpeaking: false,
  voiceTranscript: "",
  voiceLastToolCall: null,
  voiceError: null,

  setVoiceActive: (active) => set({ voiceActive: active }),
  setVoiceConnecting: (connecting) => set({ voiceConnecting: connecting }),
  setVoiceListening: (listening) => set({ voiceListening: listening }),
  setVoiceSpeaking: (speaking) => set({ voiceSpeaking: speaking }),
  setVoiceTranscript: (text) => set({ voiceTranscript: text }),
  appendVoiceTranscript: (text) =>
    set((s) => ({ voiceTranscript: s.voiceTranscript + text })),
  setVoiceLastToolCall: (call) => set({ voiceLastToolCall: call }),
  setVoiceError: (error) => set({ voiceError: error }),
  resetVoice: () =>
    set({
      voiceActive: false,
      voiceConnecting: false,
      voiceListening: false,
      voiceSpeaking: false,
      voiceTranscript: "",
      voiceLastToolCall: null,
      voiceError: null,
    }),
});
