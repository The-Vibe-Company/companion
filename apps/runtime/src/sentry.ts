import {
  describeThrownError,
  expurgateRuntimeMessage,
  type RuntimeLogRecord,
  type RuntimeProcessLog,
} from "@companion/companion-runtime";
import * as Sentry from "@sentry/node";
import { sanitizeSentryEvent } from "./sentrySanitize";

const SERVICE = "runtime";

type CapturedException = Parameters<typeof Sentry.captureException>[0];

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    tracesSampleRate: 0,
    release: process.env.SENTRY_RELEASE,
    attachStacktrace: true,
    initialScope: { tags: { service: SERVICE } },
    beforeSend: sanitizeSentryEvent,
  });
}

export function captureRuntimeException(
  error: CapturedException,
  operation = "runtime.process",
  capture: (captured: Error) => void = Sentry.captureException,
): void {
  const described = describeThrownError(error);
  const sanitized = new Error(described.message);
  sanitized.name = described.name;
  const stack = error instanceof Error ? expurgateRuntimeMessage(error.stack, "") : "";
  if (stack) sanitized.stack = stack;
  Sentry.withScope((scope) => {
    scope.setLevel("error");
    scope.setTag("operation", operation);
    scope.setFingerprint([SERVICE, operation, described.stableCode?.toString() ?? "unknown"]);
    capture(sanitized);
  });
}

type RuntimeLogCapture = (
  level: "info" | "warn" | "error",
  event: string,
  expurgatedRecord: string,
) => void;

/**
 * Sentry is the alerting boundary; the JSON process log remains the complete diagnostic stream.
 * Keep one repeated error group visible without turning a tight runtime retry/takeover loop into an
 * event storm. This is deliberately process-local: replicas remain independent and a deploy may
 * emit one fresh event per key.
 */
export const SENTRY_RUNTIME_ERROR_COOLDOWN_MS = 15 * 60_000;

function captureRuntimeLog(
  level: "info" | "warn" | "error",
  event: string,
  expurgatedRecord: string,
): void {
  const sentryLevel = level === "error" ? "error" : "warning";
  Sentry.withScope((scope) => {
    scope.setLevel(sentryLevel);
    scope.setTag("runtime.event", event);
    scope.setTag("operation", event);
    scope.setFingerprint([SERVICE, event]);
    scope.setExtra("runtime_record", expurgatedRecord);
    Sentry.captureMessage(event, sentryLevel);
  });
}

function captureRecord(capture: RuntimeLogCapture, level: "info" | "warn" | "error", record: RuntimeLogRecord): void {
  const event = expurgateRuntimeMessage(record.event, "runtime.event");
  const expurgatedRecord = expurgateRuntimeMessage(JSON.stringify(record), "{}");
  capture(level, event, expurgatedRecord);
}

/** Mirror expurgated errors into Sentry, at most once per runtime event key per cooldown. */
export function createSentryRuntimeProcessLog(
  log: RuntimeProcessLog,
  capture: RuntimeLogCapture = captureRuntimeLog,
  now: () => number = Date.now,
): RuntimeProcessLog {
  const lastCapturedAt = new Map<string, number>();
  return {
    error(record) {
      log.error(record);
      const previous = lastCapturedAt.get(record.event);
      const current = now();
      if (previous !== undefined && current - previous < SENTRY_RUNTIME_ERROR_COOLDOWN_MS) return;
      lastCapturedAt.set(record.event, current);
      captureRecord(capture, "error", record);
    },
    warn(record) {
      log.warn(record);
    },
    info(record) {
      log.info(record);
    },
  };
}

export { Sentry };
