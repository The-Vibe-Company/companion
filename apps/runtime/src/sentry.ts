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

type RuntimeLogBreadcrumb = (
  level: "info" | "warning",
  event: string,
  expurgatedRecord: string,
) => void;

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

function captureRuntimeBreadcrumb(
  level: "info" | "warning",
  event: string,
  expurgatedRecord: string,
): void {
  Sentry.addBreadcrumb({
    category: "runtime",
    level,
    message: event,
    data: { runtime_record: expurgatedRecord },
  });
}

function captureRecord<TLevel extends string>(
  capture: (level: TLevel, event: string, expurgatedRecord: string) => void,
  level: TLevel,
  record: RuntimeLogRecord,
): void {
  const event = expurgateRuntimeMessage(record.event, "runtime.event");
  const expurgatedRecord = expurgateRuntimeMessage(JSON.stringify(record), "{}");
  capture(level, event, expurgatedRecord);
}

/** Capture errors as Sentry events; retain operational warnings and failed timings as breadcrumbs. */
export function createSentryRuntimeProcessLog(
  log: RuntimeProcessLog,
  capture: RuntimeLogCapture = captureRuntimeLog,
  breadcrumb: RuntimeLogBreadcrumb = captureRuntimeBreadcrumb,
): RuntimeProcessLog {
  return {
    error(record) {
      log.error(record);
      captureRecord(capture, "error", record);
    },
    warn(record) {
      log.warn(record);
      captureRecord(breadcrumb, "warning", record);
    },
    info(record) {
      log.info(record);
      if (record.ok === false) captureRecord(breadcrumb, "warning", record);
    },
  };
}

export { Sentry };
