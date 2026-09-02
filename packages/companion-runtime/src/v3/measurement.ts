export const RUNTIME_V3_WAKE_PATHS = ["warm", "creation", "archived_wake"] as const;
export type RuntimeV3WakePath = (typeof RUNTIME_V3_WAKE_PATHS)[number];

export interface RuntimeV3MeasurementFact {
  inProductWindow: boolean;
  lane: "main" | "background";
  wakePath: RuntimeV3WakePath;
  boxProvider: string;
  modelProvider: string;
  modelId: string;
  state: "queued" | "admitted" | "running" | "needs_input"
    | "succeeded" | "failed" | "interrupted" | "cancelled";
  acceptedAt: Date | null;
  firstClaimedAt: Date | null;
  boxReadyAt: Date | null;
  stagingCompletedAt: Date | null;
  piReadyAt: Date | null;
  admissionKind: "prompt" | "steer" | null;
  admittedAt: Date | null;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  settledAt: Date | null;
  claimCount: number;
}

export interface RuntimeV3Percentiles {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface RuntimeV3AcceptanceSeries {
  lane: RuntimeV3MeasurementFact["lane"];
  wakePath: RuntimeV3WakePath;
  boxProvider: string;
  modelProvider: string;
  modelId: string;
  sampleCount: number;
  create: RuntimeV3Percentiles;
  preparation: RuntimeV3Percentiles;
  sendToAck: RuntimeV3Percentiles;
  wakeToAck: RuntimeV3Percentiles;
  terminalization: RuntimeV3Percentiles;
}

export interface RuntimeV3AcceptanceReport {
  releaseMeasurementReady: boolean;
  correlation: { acknowledged: number; complete: number; missing: number };
  product: RuntimeV3AcceptanceSeries[];
  safety: {
    oldestQueueAgeMs: number | null;
    queued: number;
    stalled: number;
    takeovers: number;
  };
}

const STALL_AFTER_MS = 10 * 60_000;
const TERMINAL_STATES = new Set<RuntimeV3MeasurementFact["state"]>([
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);

/**
 * Aggregate-only Runtime v3 release measurement. Identifiers never enter the interface, so every
 * adapter and caller receives the same expurgated report shape by construction.
 */
export function createRuntimeV3AcceptanceReport(
  facts: readonly RuntimeV3MeasurementFact[],
  now = new Date(),
): RuntimeV3AcceptanceReport {
  const productFacts = facts.filter((fact) => fact.inProductWindow);
  const acknowledged = productFacts.filter((fact) => validDate(fact.admittedAt));
  const complete = acknowledged.filter(completeCorrelation);
  const groups = new Map<string, RuntimeV3MeasurementFact[]>();
  for (const fact of acknowledged) {
    const key = [
      fact.lane,
      fact.wakePath,
      fact.boxProvider,
      fact.modelProvider,
      fact.modelId,
    ].join("\u001f");
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  const product = [...groups.values()].map(series).sort((left, right) =>
    seriesKey(left).localeCompare(seriesKey(right)));
  const queued = facts.filter((fact) => fact.state === "queued");
  const queueAges = queued.flatMap((fact) => {
    const acceptedAt = validDate(fact.acceptedAt);
    return acceptedAt ? [duration(acceptedAt, now)] : [];
  });
  const stalled = facts.filter((fact) =>
    (fact.state === "admitted" || fact.state === "running")
    && validDate(fact.lastActivityAt) !== null
    && duration(fact.lastActivityAt!, now) >= STALL_AFTER_MS).length;
  const missing = acknowledged.length - complete.length;
  return {
    releaseMeasurementReady: missing === 0,
    correlation: { acknowledged: acknowledged.length, complete: complete.length, missing },
    product,
    safety: {
      oldestQueueAgeMs: queueAges.length > 0 ? Math.max(...queueAges) : null,
      queued: queued.length,
      stalled,
      takeovers: facts.reduce((count, fact) => count + Math.max(0, fact.claimCount - 1), 0),
    },
  };
}

function completeCorrelation(fact: RuntimeV3MeasurementFact): boolean {
  const admissionComplete = validDate(fact.acceptedAt) !== null
    && validDate(fact.firstClaimedAt) !== null
    && validDate(fact.boxReadyAt) !== null
    && validDate(fact.stagingCompletedAt) !== null
    && validDate(fact.piReadyAt) !== null
    && fact.admissionKind !== null;
  if (!admissionComplete) return false;
  return !TERMINAL_STATES.has(fact.state)
    || (validDate(fact.firstActivityAt) !== null && validDate(fact.settledAt) !== null);
}

function series(facts: RuntimeV3MeasurementFact[]): RuntimeV3AcceptanceSeries {
  const first = facts[0]!;
  return {
    lane: first.lane,
    wakePath: first.wakePath,
    boxProvider: first.boxProvider,
    modelProvider: first.modelProvider,
    modelId: first.modelId,
    sampleCount: facts.length,
    create: percentiles(facts.flatMap((fact) =>
      fact.wakePath === "creation" ? between(fact.firstClaimedAt, fact.boxReadyAt) : [])),
    preparation: percentiles(facts.flatMap((fact) =>
      between(fact.boxReadyAt, fact.piReadyAt))),
    sendToAck: percentiles(facts.flatMap((fact) =>
      between(fact.acceptedAt, fact.admittedAt))),
    wakeToAck: percentiles(facts.flatMap((fact) =>
      between(fact.firstClaimedAt, fact.admittedAt))),
    terminalization: percentiles(facts.flatMap((fact) =>
      between(fact.admittedAt, fact.settledAt))),
  };
}

function between(start: Date | null, end: Date | null): number[] {
  const validStart = validDate(start);
  const validEnd = validDate(end);
  if (!validStart || !validEnd || validEnd < validStart) return [];
  return [duration(validStart, validEnd)];
}

function duration(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function percentiles(values: number[]): RuntimeV3Percentiles {
  if (values.length === 0) return { samples: 0, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
  };
}

function nearestRank(sorted: number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

function validDate(value: Date | null): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function seriesKey(value: Pick<RuntimeV3AcceptanceSeries,
  "lane" | "wakePath" | "boxProvider" | "modelProvider" | "modelId">): string {
  return [value.lane, value.wakePath, value.boxProvider, value.modelProvider, value.modelId]
    .join("\u001f");
}
