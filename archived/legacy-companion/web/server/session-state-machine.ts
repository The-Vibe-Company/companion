// Formal session state machine for the Companion server.
// Centralizes session phase definitions and validates transitions.

import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";

/**
 * The formal phases a session can be in.
 *
 * - starting:            CLI process spawned, WS not yet connected
 * - initializing:        CLI WS connected, awaiting system.init
 * - ready:               Idle, awaiting user input
 * - streaming:           Claude generating output (stream_event / assistant)
 * - awaiting_permission: Tool call pending user approval
 * - compacting:          Context window compaction in progress
 * - reconnecting:        CLI socket dropped, within grace period
 * - terminated:          Process exited or killed
 */
export type SessionPhase =
  | "starting"
  | "initializing"
  | "ready"
  | "streaming"
  | "awaiting_permission"
  | "compacting"
  | "reconnecting"
  | "terminated";

/** Payload emitted on every successful state transition. */
export interface SessionTransitionEvent {
  sessionId: string;
  from: SessionPhase;
  to: SessionPhase;
  trigger: string;
  timestamp: number;
}

/**
 * Defines which (from -> to) transitions are valid.
 * Any transition not listed here will be blocked with a warning.
 */
export const VALID_TRANSITIONS: ReadonlyMap<
  SessionPhase,
  ReadonlySet<SessionPhase>
> = new Map([
  [
    "starting",
    new Set<SessionPhase>(["initializing", "streaming", "reconnecting", "terminated"]),
  ],
  [
    "initializing",
    new Set<SessionPhase>(["ready", "streaming", "reconnecting", "terminated"]),
  ],
  [
    "ready",
    new Set<SessionPhase>([
      "streaming",
      "compacting",
      "reconnecting",
      "terminated",
    ]),
  ],
  [
    "streaming",
    new Set<SessionPhase>([
      "ready",
      "initializing",
      "awaiting_permission",
      "compacting",
      "reconnecting",
      "terminated",
    ]),
  ],
  [
    "awaiting_permission",
    new Set<SessionPhase>(["streaming", "ready", "reconnecting", "terminated"]),
  ],
  [
    "compacting",
    new Set<SessionPhase>([
      "ready",
      "streaming",
      "reconnecting",
      "terminated",
    ]),
  ],
  [
    "reconnecting",
    new Set<SessionPhase>(["initializing", "starting", "ready", "streaming", "terminated"]),
  ],
  ["terminated", new Set<SessionPhase>(["starting"])],
]);

type TransitionListener = (event: SessionTransitionEvent) => void;

export class SessionStateMachine {
  private _phase: SessionPhase;
  private readonly _sessionId: string;
  private _listeners: TransitionListener[] = [];

  constructor(sessionId: string, initialPhase: SessionPhase = "starting") {
    this._sessionId = sessionId;
    this._phase = initialPhase;
  }

  get phase(): SessionPhase {
    return this._phase;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Attempt a state transition.
   * Returns true if successful (or same-state no-op), false if blocked.
   * Invalid transitions are logged but never throw.
   */
  transition(to: SessionPhase, trigger: string): boolean {
    if (this._phase === to) return true;

    const allowed = VALID_TRANSITIONS.get(this._phase);
    if (!allowed || !allowed.has(to)) {
      metricsCollector.recordError("invalid_state_transition");
      log.warn("state-machine", "Blocked invalid transition", {
        sessionId: this._sessionId,
        from: this._phase,
        to,
        trigger,
      });
      return false;
    }

    const event: SessionTransitionEvent = {
      sessionId: this._sessionId,
      from: this._phase,
      to,
      trigger,
      timestamp: Date.now(),
    };

    this._phase = to;

    // Snapshot listeners so additions/removals during iteration are safe
    const snapshot = this._listeners.slice();
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        console.error(
          `[state-machine] Listener error for ${this._sessionId}:`,
          err,
        );
      }
    }

    return true;
  }

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onTransition(listener: TransitionListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Force-set state without validation or listener notification.
   * Used for restoring state from disk.
   */
  forceState(phase: SessionPhase): void {
    this._phase = phase;
  }

  // -- Guard methods --

  /** True only when session is idle and ready for a new user message. */
  canAcceptUserMessage(): boolean {
    return this._phase === "ready";
  }

  /** True only when a permission request is pending. */
  canRespondToPermission(): boolean {
    return this._phase === "awaiting_permission";
  }

  /** True when the CLI socket is expected to be reachable. */
  canSendToCLI(): boolean {
    return (
      this._phase !== "terminated" &&
      this._phase !== "reconnecting" &&
      this._phase !== "starting"
    );
  }

  /** True when the session has not terminated. */
  isActive(): boolean {
    return this._phase !== "terminated";
  }

  /** True only when the session is idle (ready). */
  isIdle(): boolean {
    return this._phase === "ready";
  }
}
