import { log } from "./logger.js";

type BackendName = "claude" | "codex";
type Direction = "incoming" | "outgoing";
type MessageKind = "message" | "notification" | "request" | "parse_error";

interface ProtocolDriftOptions {
  backend: BackendName;
  sessionId: string;
  direction: Direction;
  messageKind: MessageKind;
  messageName: string;
  keys?: string[];
  rawPreview?: string;
  blockedForSafety?: boolean;
}

function truncate(value: string, max = 240): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function reportProtocolDrift(
  seen: Set<string>,
  options: ProtocolDriftOptions,
  emitError?: (message: string) => void,
): void {
  const dedupeKey = [
    options.backend,
    options.direction,
    options.messageKind,
    options.messageName,
  ].join(":");
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);

  log.warn("protocol-monitor", "Backend protocol drift detected", {
    backend: options.backend,
    sessionId: options.sessionId,
    direction: options.direction,
    messageKind: options.messageKind,
    messageName: options.messageName,
    keys: options.keys,
    rawPreview: options.rawPreview ? truncate(options.rawPreview) : undefined,
    blockedForSafety: options.blockedForSafety,
  });

  emitError?.(
    `${options.backend === "codex" ? "Codex" : "Claude"} protocol drift: unsupported ${options.direction} ${options.messageKind} "${options.messageName}". Companion may need an update.`,
  );
}
