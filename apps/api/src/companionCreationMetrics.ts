import { Sentry } from "./sentry";

interface MetricSink {
  count(name: string, value: number, options?: {
    attributes?: Record<string, string | number | boolean>;
  }): void;
  distribution(name: string, value: number, options?: {
    unit?: string;
    attributes?: Record<string, string | number | boolean>;
  }): void;
}

/** THE-513 creation SLO: bounded duration and outcome only, never tenant or Companion identity. */
export function recordCompanionCreationMetrics(input: {
  durationMs: number;
  outcome: "accepted" | "rejected";
  sink?: MetricSink;
}): void {
  const sink = input.sink ?? Sentry.metrics;
  const attributes = { outcome: input.outcome };
  sink.count("companion.creation.requests", 1, { attributes });
  sink.distribution("companion.creation.duration", Math.max(0, input.durationMs), {
    unit: "millisecond",
    attributes,
  });
}
