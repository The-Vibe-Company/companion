import type {
  CompanionThreadDeltaResponse,
  CompanionThreadWindow,
} from "@companion/contracts";
import { Sentry } from "./sentry";

type MetricOptions = {
  unit?: string;
  attributes?: Record<string, string | number | boolean>;
};

export interface CompanionThreadMetricSink {
  count(name: string, value: number, options?: MetricOptions): void;
  distribution(name: string, value: number, options?: MetricOptions): void;
}

/**
 * Record only bounded numeric shape. No org, actor, Companion, cursor, event id, content, error, or
 * URL is accepted by this boundary, so thread-sync telemetry cannot accidentally become transcript
 * telemetry.
 */
export function recordCompanionThreadSyncMetrics(input: {
  kind: "window" | "delta";
  durationMs: number;
  payload: CompanionThreadWindow | CompanionThreadDeltaResponse;
  sink?: CompanionThreadMetricSink;
}): void {
  const sink = input.sink ?? Sentry.metrics;
  const bodyBytes = new TextEncoder().encode(JSON.stringify(input.payload)).byteLength;
  const changedCount = "changed_entries" in input.payload
    ? input.payload.changed_entries.length
    : input.payload.entries.length;
  const deletedCount = "deleted_event_ids" in input.payload
    ? input.payload.deleted_event_ids.length
    : 0;
  const hasMore = "has_more" in input.payload && input.payload.has_more === true;
  const attributes = { kind: input.kind, has_more: hasMore };

  sink.count("companion.thread_sync.responses", 1, { attributes });
  sink.distribution(
    "companion.thread_sync.duration",
    Math.max(0, input.durationMs),
    { unit: "millisecond", attributes },
  );
  sink.distribution(
    "companion.thread_sync.response_size",
    bodyBytes,
    { unit: "byte", attributes },
  );
  sink.distribution("companion.thread_sync.changed_entries", changedCount, { attributes });
  sink.distribution("companion.thread_sync.deleted_entries", deletedCount, { attributes });
}
