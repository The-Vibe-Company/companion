/**
 * Narrow process support shared by Runtime v3 and the API desktop proxy.
 * No v2 kernel, scheduler, store, attempt, operation, retry, handler, or claim is exported.
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
export { RuntimeAttachmentExpiredError } from "./store";
export { CompanionImageRegistry, IMAGE_BUILD_BACKOFF_MS } from "./imageRegistry";
export {
  createJsonRuntimeProcessLog,
  describeThrownError,
} from "./logging";
export type { RuntimeLogRecord, RuntimeProcessLog } from "./logging";
export { validatePiJournalRead } from "./piEvents";
export { createRuntimeVisibleTextRedactor } from "./projectionRedaction";
export {
  RuntimeExternalDependencyError,
  RuntimeTerminalPreparationError,
} from "./ports";
export type {
  BrokerPromptWriteOutcome,
  BrokerWriteOutcome,
  RuntimeAttachmentStager,
  RuntimeBoxControl,
  RuntimeMaterialProvider,
  RuntimeOutboxHarvester,
  RuntimePiControl,
  RuntimeProjectionRedactorFactory,
  RuntimeResourceStager,
} from "./ports";
export type {
  RuntimeAuthorization,
  RuntimeOutputAttachment,
  RuntimeWorkMaterial,
} from "./types";
export { decodeRuntimeV3PreparationSnapshot } from "./types";
