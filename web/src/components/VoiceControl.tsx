/**
 * VoiceControl — floating action button (FAB) for Gemini voice control.
 *
 * Renders a microphone button in the bottom-right corner. When clicked,
 * it starts a Gemini Live API voice session for hands-free control of
 * The Companion. Shows connection state, live transcript, and tool call info.
 */

import { useEffect, useCallback } from "react";
import { useStore } from "../store.js";
import { startVoiceSession, stopVoiceSession } from "../utils/voice-session.js";

/** Human-readable labels for tool calls. */
const TOOL_LABELS: Record<string, string> = {
  create_session: "Creating session…",
  send_message: "Sending message…",
  approve_permission: "Approving permission…",
  deny_permission: "Denying permission…",
  approve_all_permissions: "Approving all permissions…",
  navigate_page: "Navigating…",
  switch_session: "Switching session…",
  list_sessions: "Listing sessions…",
  interrupt_session: "Interrupting session…",
  get_session_status: "Getting status…",
};

export function VoiceControl() {
  const active = useStore((s) => s.voiceActive);
  const connecting = useStore((s) => s.voiceConnecting);
  const listening = useStore((s) => s.voiceListening);
  const speaking = useStore((s) => s.voiceSpeaking);
  const transcript = useStore((s) => s.voiceTranscript);
  const lastToolCall = useStore((s) => s.voiceLastToolCall);
  const error = useStore((s) => s.voiceError);

  const isExpanded = active || connecting || !!error;

  // Escape key stops voice session
  useEffect(() => {
    if (!active && !connecting) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        stopVoiceSession();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, connecting]);

  // Auto-clear error after 5 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      useStore.getState().setVoiceError(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [error]);

  const handleClick = useCallback(() => {
    if (active || connecting) {
      stopVoiceSession();
    } else {
      startVoiceSession();
    }
  }, [active, connecting]);

  const toolLabel = lastToolCall ? (TOOL_LABELS[lastToolCall.name] || lastToolCall.name) : null;

  // Truncate transcript for display (last 200 chars)
  const displayTranscript = transcript.length > 200
    ? "…" + transcript.slice(-200)
    : transcript;

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2"
      style={{ pointerEvents: "none" }}
    >
      {/* Expanded panel (transcript + tool call info) */}
      {isExpanded && (
        <div
          className={`
            w-[280px] sm:w-[320px] rounded-2xl border shadow-lg backdrop-blur-sm
            transition-all duration-300 animate-[fadeSlideIn_0.2s_ease-out]
            ${error
              ? "bg-cc-error/5 border-cc-error/20"
              : "bg-cc-card/95 border-cc-border"
            }
          `}
          style={{ pointerEvents: "auto" }}
          role="status"
          aria-live="polite"
        >
          <div className="px-4 py-3 space-y-2">
            {/* Status line */}
            <div className="flex items-center gap-2 text-xs font-medium">
              {error ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-cc-error shrink-0" />
                  <span className="text-cc-error truncate">{error}</span>
                </>
              ) : connecting ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-cc-warning animate-pulse shrink-0" />
                  <span className="text-cc-warning">Connecting to Gemini…</span>
                </>
              ) : speaking ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-cc-primary shrink-0 animate-pulse" />
                  <span className="text-cc-primary">Speaking…</span>
                </>
              ) : listening ? (
                <>
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cc-primary/60" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-cc-primary" />
                  </span>
                  <span className="text-cc-primary">Listening…</span>
                </>
              ) : null}
            </div>

            {/* Tool call info */}
            {toolLabel && !error && (
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60 shrink-0">
                  <path d="M14.7 3.3a1 1 0 010 1.4l-5 5a1 1 0 01-1.4 0l-2-2a1 1 0 011.4-1.4L9 7.6l4.3-4.3a1 1 0 011.4 0zM5.5 7.5L3 10v2h2l2.5-2.5" />
                </svg>
                <span className="truncate">{toolLabel}</span>
              </div>
            )}

            {/* Transcript */}
            {displayTranscript && !error && (
              <p className="text-xs text-cc-fg/80 leading-relaxed max-h-[80px] overflow-y-auto break-words">
                {displayTranscript}
              </p>
            )}
          </div>
        </div>
      )}

      {/* FAB button */}
      <button
        onClick={handleClick}
        className={`
          relative flex items-center justify-center
          w-12 h-12 sm:w-14 sm:h-14 rounded-full
          shadow-lg transition-all duration-200
          cursor-pointer select-none
          ${error
            ? "bg-cc-error/10 border-2 border-cc-error/30 text-cc-error hover:bg-cc-error/20"
            : active
              ? "bg-cc-primary text-white shadow-[0_4px_20px_rgba(217,119,87,0.35)] hover:bg-cc-primary-hover"
              : connecting
                ? "bg-cc-card border-2 border-cc-warning/40 text-cc-warning"
                : "bg-cc-card border border-cc-border text-cc-muted hover:text-cc-fg hover:border-cc-primary/30 hover:shadow-[0_4px_16px_rgba(217,119,87,0.15)]"
          }
        `}
        style={{ pointerEvents: "auto" }}
        aria-label={active ? "Stop voice control" : "Start voice control"}
        title={active ? "Stop voice control (Esc)" : "Start Gemini voice control"}
      >
        {/* Connecting spinner */}
        {connecting && (
          <span className="absolute inset-0 rounded-full border-2 border-cc-warning/30 border-t-cc-warning animate-spin" />
        )}

        {/* Active pulse ring */}
        {active && !connecting && (
          <span className="absolute inset-0 rounded-full animate-ping bg-cc-primary/20" style={{ animationDuration: "2s" }} />
        )}

        {/* Icon: microphone (idle/listening) or stop (active) */}
        {active ? (
          // Stop icon
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 relative z-10">
            <rect x="4" y="4" width="8" height="8" rx="1" />
          </svg>
        ) : (
          // Microphone icon
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 relative z-10">
            <path d="M8 1a2 2 0 00-2 2v4a2 2 0 004 0V3a2 2 0 00-2-2z" />
            <path d="M4.5 6.5a.5.5 0 00-1 0V7a4.5 4.5 0 004 4.473V13H6a.5.5 0 000 1h4a.5.5 0 000-1H8.5v-1.527A4.5 4.5 0 0012.5 7v-.5a.5.5 0 00-1 0V7a3.5 3.5 0 11-7 0v-.5z" />
          </svg>
        )}
      </button>
    </div>
  );
}
