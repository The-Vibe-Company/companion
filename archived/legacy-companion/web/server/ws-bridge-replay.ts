import type {
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
} from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";

export function isDuplicateClientMessage(session: Session, clientMsgId: string): boolean {
  return session.processedClientMessageIdSet.has(clientMsgId);
}

export function rememberClientMessage(
  session: Session,
  clientMsgId: string,
  processedClientMsgIdLimit: number,
  persistSession: (session: Session) => void,
): void {
  session.processedClientMessageIds.push(clientMsgId);
  session.processedClientMessageIdSet.add(clientMsgId);
  if (session.processedClientMessageIds.length > processedClientMsgIdLimit) {
    const overflow = session.processedClientMessageIds.length - processedClientMsgIdLimit;
    const removed = session.processedClientMessageIds.splice(0, overflow);
    for (const id of removed) {
      session.processedClientMessageIdSet.delete(id);
    }
  }
  persistSession(session);
}

export function shouldBufferForReplay(
  msg: BrowserIncomingMessage,
): msg is ReplayableBrowserIncomingMessage {
  return msg.type !== "session_init"
    && msg.type !== "message_history"
    && msg.type !== "event_replay";
}

export function isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
  return msg.type === "assistant"
    || msg.type === "result"
    || msg.type === "user_message"
    || (msg.type === "system_event" && msg.event.subtype !== "hook_progress")
    || msg.type === "error";
}

export function sequenceEvent(
  session: Session,
  msg: BrowserIncomingMessage,
  eventBufferLimit: number,
  persistSession: (session: Session) => void,
): BrowserIncomingMessage {
  const seq = session.nextEventSeq++;
  const sequenced = { ...msg, seq };
  if (shouldBufferForReplay(msg)) {
    session.eventBuffer.push({ seq, message: msg });
    if (session.eventBuffer.length > eventBufferLimit) {
      session.eventBuffer.splice(0, session.eventBuffer.length - eventBufferLimit);
    }
    persistSession(session);
  }
  return sequenced;
}
