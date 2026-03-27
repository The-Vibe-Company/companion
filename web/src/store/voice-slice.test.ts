// @vitest-environment jsdom
/**
 * Tests for the voice Zustand slice.
 *
 * Validates that voice state (active, connecting, listening, speaking,
 * transcript, tool calls, errors) is managed correctly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./index.js";

describe("voice-slice", () => {
  beforeEach(() => {
    // Reset entire store to get clean voice state
    useStore.getState().resetVoice();
  });

  it("has correct initial state", () => {
    const state = useStore.getState();
    expect(state.voiceActive).toBe(false);
    expect(state.voiceConnecting).toBe(false);
    expect(state.voiceListening).toBe(false);
    expect(state.voiceSpeaking).toBe(false);
    expect(state.voiceTranscript).toBe("");
    expect(state.voiceLastToolCall).toBeNull();
    expect(state.voiceError).toBeNull();
  });

  it("setVoiceActive updates state", () => {
    useStore.getState().setVoiceActive(true);
    expect(useStore.getState().voiceActive).toBe(true);

    useStore.getState().setVoiceActive(false);
    expect(useStore.getState().voiceActive).toBe(false);
  });

  it("setVoiceConnecting updates state", () => {
    useStore.getState().setVoiceConnecting(true);
    expect(useStore.getState().voiceConnecting).toBe(true);
  });

  it("setVoiceListening updates state", () => {
    useStore.getState().setVoiceListening(true);
    expect(useStore.getState().voiceListening).toBe(true);
  });

  it("setVoiceSpeaking updates state", () => {
    useStore.getState().setVoiceSpeaking(true);
    expect(useStore.getState().voiceSpeaking).toBe(true);
  });

  it("setVoiceTranscript replaces transcript", () => {
    useStore.getState().setVoiceTranscript("Hello");
    expect(useStore.getState().voiceTranscript).toBe("Hello");

    useStore.getState().setVoiceTranscript("World");
    expect(useStore.getState().voiceTranscript).toBe("World");
  });

  it("appendVoiceTranscript appends to existing transcript", () => {
    useStore.getState().setVoiceTranscript("Hello ");
    useStore.getState().appendVoiceTranscript("World");
    expect(useStore.getState().voiceTranscript).toBe("Hello World");

    useStore.getState().appendVoiceTranscript("!");
    expect(useStore.getState().voiceTranscript).toBe("Hello World!");
  });

  it("appendVoiceTranscript works from empty string", () => {
    useStore.getState().appendVoiceTranscript("First");
    expect(useStore.getState().voiceTranscript).toBe("First");
  });

  it("setVoiceLastToolCall stores tool call info", () => {
    const toolCall = { name: "create_session", args: { prompt: "hello" } };
    useStore.getState().setVoiceLastToolCall(toolCall);
    expect(useStore.getState().voiceLastToolCall).toEqual(toolCall);
  });

  it("setVoiceLastToolCall clears with null", () => {
    useStore.getState().setVoiceLastToolCall({ name: "test", args: {} });
    useStore.getState().setVoiceLastToolCall(null);
    expect(useStore.getState().voiceLastToolCall).toBeNull();
  });

  it("setVoiceError sets and clears errors", () => {
    useStore.getState().setVoiceError("Connection failed");
    expect(useStore.getState().voiceError).toBe("Connection failed");

    useStore.getState().setVoiceError(null);
    expect(useStore.getState().voiceError).toBeNull();
  });

  it("resetVoice clears all voice state back to initial", () => {
    // Set all fields to non-initial values
    const store = useStore.getState();
    store.setVoiceActive(true);
    store.setVoiceConnecting(true);
    store.setVoiceListening(true);
    store.setVoiceSpeaking(true);
    store.setVoiceTranscript("Some transcript");
    store.setVoiceLastToolCall({ name: "test", args: { foo: "bar" } });
    store.setVoiceError("Some error");

    // Reset
    useStore.getState().resetVoice();

    // Verify all fields are back to initial
    const reset = useStore.getState();
    expect(reset.voiceActive).toBe(false);
    expect(reset.voiceConnecting).toBe(false);
    expect(reset.voiceListening).toBe(false);
    expect(reset.voiceSpeaking).toBe(false);
    expect(reset.voiceTranscript).toBe("");
    expect(reset.voiceLastToolCall).toBeNull();
    expect(reset.voiceError).toBeNull();
  });
});
