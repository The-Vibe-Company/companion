import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

// ─── Unified Backend Adapter Interface ───────────────────────────────────────
// Both Claude Code (NDJSON WebSocket) and Codex (JSON-RPC stdio/WS) implement
// this so that application code never branches on BackendType for message routing.

/**
 * Unified interface for backend communication.
 *
 * Adapters translate between the backend-native protocol and the common
 * BrowserIncomingMessage / BrowserOutgoingMessage types used by the bridge
 * and the frontend.
 */
export interface IBackendAdapter {
  /** Send a browser-originated message to the backend. Returns true if accepted. */
  send(msg: BrowserOutgoingMessage): boolean;

  /** Whether the backend transport is currently connected and ready. */
  isConnected(): boolean;

  /** Gracefully disconnect the backend transport. */
  disconnect(): Promise<void>;

  // ── Event registration (called once at attachment time) ──

  /**
   * Register callback for messages to forward to browsers.
   * The adapter translates backend-native protocol into BrowserIncomingMessage.
   */
  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void;

  /**
   * Register callback for session metadata updates (CLI session ID, model, cwd).
   * Used for --resume tracking and state synchronization.
   */
  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void;

  /** Register callback for transport disconnection. */
  onDisconnect(cb: () => void): void;

  /** Register callback for initialization errors. */
  onInitError?(cb: (error: string) => void): void;

  // ── Optional capabilities (not all backends support these) ──

  /** Return backend-specific rate limits, if available (Codex only). */
  getRateLimits?(): {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null;

  /** Handle transport-level close (used when WS proxy drops). */
  handleTransportClose?(): void;
}
