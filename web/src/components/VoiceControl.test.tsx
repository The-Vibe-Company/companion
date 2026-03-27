// @vitest-environment jsdom
/**
 * Tests for VoiceControl component.
 *
 * Validates rendering in different states (idle, connecting, listening,
 * speaking, error), accessibility, and user interactions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import { useStore } from "../store.js";
import { VoiceControl } from "./VoiceControl.js";

// Mock the voice-session module to prevent actual Gemini connections
vi.mock("../utils/voice-session.js", () => ({
  startVoiceSession: vi.fn(),
  stopVoiceSession: vi.fn(),
  isVoiceSessionActive: vi.fn(() => false),
}));

describe("VoiceControl", () => {
  beforeEach(() => {
    useStore.getState().resetVoice();
  });

  // ── Render tests ───────────────────────────────────────────────────────

  it("renders microphone button in idle state", () => {
    render(<VoiceControl />);
    const button = screen.getByRole("button", { name: /voice control/i });
    expect(button).toBeInTheDocument();
  });

  it("shows connecting state when voiceConnecting is true", () => {
    useStore.getState().setVoiceConnecting(true);
    render(<VoiceControl />);
    expect(screen.getByText(/connecting to gemini/i)).toBeInTheDocument();
  });

  it("shows listening state when voiceListening is true", () => {
    useStore.getState().setVoiceActive(true);
    useStore.getState().setVoiceListening(true);
    render(<VoiceControl />);
    expect(screen.getByText(/listening/i)).toBeInTheDocument();
  });

  it("shows speaking state when voiceSpeaking is true", () => {
    useStore.getState().setVoiceActive(true);
    useStore.getState().setVoiceSpeaking(true);
    render(<VoiceControl />);
    expect(screen.getByText(/speaking/i)).toBeInTheDocument();
  });

  it("shows transcript text when available", () => {
    useStore.getState().setVoiceActive(true);
    useStore.getState().setVoiceListening(true);
    useStore.getState().setVoiceTranscript("Create a new session");
    render(<VoiceControl />);
    expect(screen.getByText(/create a new session/i)).toBeInTheDocument();
  });

  it("shows tool call label when a tool is being executed", () => {
    useStore.getState().setVoiceActive(true);
    useStore.getState().setVoiceLastToolCall({ name: "create_session", args: {} });
    render(<VoiceControl />);
    expect(screen.getByText(/creating session/i)).toBeInTheDocument();
  });

  it("shows error state with error message", () => {
    useStore.getState().setVoiceError("Connection failed");
    render(<VoiceControl />);
    expect(screen.getByText(/connection failed/i)).toBeInTheDocument();
  });

  it("shows stop button when voice is active", () => {
    useStore.getState().setVoiceActive(true);
    render(<VoiceControl />);
    const button = screen.getByRole("button", { name: /stop voice control/i });
    expect(button).toBeInTheDocument();
  });

  // ── Interaction tests ──────────────────────────────────────────────────

  it("calls startVoiceSession when idle button is clicked", async () => {
    const { startVoiceSession } = await import("../utils/voice-session.js");
    const user = userEvent.setup();
    render(<VoiceControl />);

    const button = screen.getByRole("button", { name: /start voice control/i });
    await user.click(button);

    expect(startVoiceSession).toHaveBeenCalled();
  });

  it("calls stopVoiceSession when active button is clicked", async () => {
    const { stopVoiceSession } = await import("../utils/voice-session.js");
    useStore.getState().setVoiceActive(true);
    const user = userEvent.setup();
    render(<VoiceControl />);

    const button = screen.getByRole("button", { name: /stop voice control/i });
    await user.click(button);

    expect(stopVoiceSession).toHaveBeenCalled();
  });

  // ── Accessibility ──────────────────────────────────────────────────────

  it("passes axe accessibility scan in idle state", async () => {
    const { container } = render(<VoiceControl />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility scan in active state", async () => {
    useStore.getState().setVoiceActive(true);
    useStore.getState().setVoiceListening(true);
    useStore.getState().setVoiceTranscript("Test transcript");
    const { container } = render(<VoiceControl />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility scan in error state", async () => {
    useStore.getState().setVoiceError("Test error");
    const { container } = render(<VoiceControl />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
