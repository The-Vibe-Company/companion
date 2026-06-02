import type { ServerWebSocket } from "bun";
import type { BrowserSocketData, Session, SocketData } from "./ws-bridge-types.js";
import type {
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
} from "./session-types.js";

/**
 * Infer the CLI's current status from server-side session state.
 * Used as a ground-truth correction after event replay to prevent
 * stale "running"/"generating" state when `result` was pruned from
 * the event buffer.
 */
function inferCliStatus(session: Session): "idle" | "running" | "compacting" | null {
  if (session.state.is_compacting) return "compacting";
  const last = session.messageHistory[session.messageHistory.length - 1];
  if (!last) return "idle";
  // `result` means the last turn completed → idle
  if (last.type === "result") return "idle";
  // `assistant` means CLI sent a response and is executing tools or streaming → running
  if (last.type === "assistant") return "running";
  // For other types (user_message, system_event), default to idle
  return "idle";
}

export function handleSessionSubscribe(
  session: Session,
  ws: ServerWebSocket<SocketData> | undefined,
  lastSeq: number,
  sendToBrowser: (ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) => void,
  isHistoryBackedEvent: (msg: ReplayableBrowserIncomingMessage) => boolean,
): void {
  if (!ws) return;
  const data = ws.data as BrowserSocketData;
  data.subscribed = true;
  const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  data.lastAckSeq = lastAckSeq;

  if (lastAckSeq === 0 && session.messageHistory.length > 0) {
    sendToBrowser(ws, {
      type: "message_history",
      messages: session.messageHistory,
    });
  }

  if (session.eventBuffer.length === 0) return;
  if (lastAckSeq >= session.nextEventSeq - 1) return;

  const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
  const hasGap = lastAckSeq > 0 && lastAckSeq < earliest - 1;
  if (hasGap) {
    if (session.messageHistory.length > 0) {
      sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }
    const transientMissed = session.eventBuffer
      .filter((evt) => evt.seq > lastAckSeq && !isHistoryBackedEvent(evt.message));
    if (transientMissed.length > 0) {
      sendToBrowser(ws, {
        type: "event_replay",
        events: transientMissed,
      });
    }
    // Send ground-truth status after replay to correct stale streaming state
    sendToBrowser(ws, { type: "status_change", status: inferCliStatus(session) });
    // Send authoritative session_phase so replayed transient phases don't leave stale cliConnected
    sendToBrowser(ws, {
      type: "session_phase",
      phase: session.stateMachine.phase,
      previousPhase: session.stateMachine.phase,
    });
    return;
  }

  const sentFullHistory = lastAckSeq === 0 && session.messageHistory.length > 0;
  const missed = session.eventBuffer.filter(
    (evt) => evt.seq > lastAckSeq && (!sentFullHistory || !isHistoryBackedEvent(evt.message)),
  );
  if (missed.length === 0) return;
  sendToBrowser(ws, {
    type: "event_replay",
    events: missed,
  });
  // Send ground-truth status after replay to correct stale streaming state
  sendToBrowser(ws, { type: "status_change", status: inferCliStatus(session) });
  // Send authoritative session_phase so replayed transient phases don't leave stale cliConnected
  sendToBrowser(ws, {
    type: "session_phase",
    phase: session.stateMachine.phase,
    previousPhase: session.stateMachine.phase,
  });
}

export function handleSessionAck(
  session: Session,
  ws: ServerWebSocket<SocketData> | undefined,
  lastSeq: number,
  persistSession: (session: Session) => void,
): void {
  const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  if (ws) {
    const data = ws.data as BrowserSocketData;
    const prior = typeof data.lastAckSeq === "number" ? data.lastAckSeq : 0;
    data.lastAckSeq = Math.max(prior, normalized);
  }
  if (normalized > session.lastAckSeq) {
    session.lastAckSeq = normalized;
    persistSession(session);
  }
}
