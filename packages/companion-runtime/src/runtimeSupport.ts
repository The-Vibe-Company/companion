/**
 * Narrow process support shared by Runtime v3 and the API desktop proxy.
 * This module exposes transports and redaction helpers, never durable execution semantics.
 */
export {
  DESKTOP_REQUEST_ID_HEADER,
  DESKTOP_REQUEST_MAX_SKEW_SECONDS,
  DESKTOP_REQUEST_PATH,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIMESTAMP_HEADER,
  signDesktopRequest,
  verifyDesktopRequest,
} from "./desktopAuth";
export {
  expurgateRuntimeMessage,
} from "./errors";
export { CompanionImageRegistry, IMAGE_BUILD_BACKOFF_MS } from "./imageRegistry";
export {
  createJsonRuntimeProcessLog,
  describeThrownError,
} from "./logging";
export type { RuntimeLogRecord, RuntimeProcessLog } from "./logging";
export { validatePiJournalRead } from "./piEvents";
export {
  RuntimeExternalDependencyError,
  RuntimeTerminalPreparationError,
} from "./ports";
export type {
  BrokerPromptWriteOutcome,
  BrokerWriteOutcome,
  RuntimeBoxControl,
} from "./ports";
/**
 * Runtime v3's narrow Pi transport. Its `attemptId` fields are the fixed Pi broker wire name and
 * always carry the durable Turn id; they do not expose or identify a hosted-runtime attempt row.
 */
export type { RuntimePiControl as RuntimeV3PiTransport } from "./ports";
export { decodeRuntimeV3PreparationSnapshot } from "./types";
