import * as Sentry from "@sentry/node";
import { sanitizeSentryEvent } from "./sentrySanitize";

const SERVICE = "worker";
type CapturedException = Parameters<typeof Sentry.captureException>[0];

export interface WorkerErrorContext {
  supervisor: "billing" | "github" | "skill-database" | "worker";
  operation: string;
  level?: "warning" | "error" | "fatal";
  retryable?: boolean;
}

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    release: process.env.SENTRY_RELEASE,
    attachStacktrace: true,
    initialScope: { tags: { service: SERVICE } },
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: sanitizeSentryEvent,
  });
}

export function captureWorkerError(error: CapturedException, context: WorkerErrorContext): void {
  Sentry.withScope((scope) => {
    scope.setLevel(context.level ?? "error");
    scope.setTag("supervisor", context.supervisor);
    scope.setTag("operation", context.operation);
    if (context.retryable !== undefined) scope.setTag("error.retryable", String(context.retryable));
    scope.setFingerprint([SERVICE, context.supervisor, context.operation, "{{ default }}"]);
    Sentry.captureException(error);
  });
}

export { Sentry };
