/**
 * Product promise: Runtime v3 release measurement follows the accepted user occurrence through
 * Pi acknowledgement and settlement without exposing tenant or conversation identities.
 * Regression guarded: losing acceptance-to-ACK correlation must fail the release measurement.
 * Why unit-level: the report is a pure public seam over durable timestamp rows.
 * Sensitivity: removing correlation validation or changing the percentile inputs makes this fail.
 */
import { describe, expect, it } from "vitest";

import {
  createRuntimeV3AcceptanceReport,
  type RuntimeV3MeasurementFact,
} from "./measurement";

const minute = 60_000;
const now = new Date("2027-01-01T01:00:00.000Z");

function fact(overrides: Partial<RuntimeV3MeasurementFact> = {}): RuntimeV3MeasurementFact {
  return {
    lane: "main",
    wakePath: "creation",
    boxProvider: "ascii",
    modelProvider: "anthropic",
    modelId: "claude-test",
    state: "succeeded",
    acceptedAt: new Date("2027-01-01T00:00:00.000Z"),
    firstClaimedAt: new Date("2027-01-01T00:00:01.000Z"),
    boxReadyAt: new Date("2027-01-01T00:00:03.000Z"),
    stagingCompletedAt: new Date("2027-01-01T00:00:05.000Z"),
    piReadyAt: new Date("2027-01-01T00:00:07.000Z"),
    admissionKind: "prompt",
    admittedAt: new Date("2027-01-01T00:00:09.000Z"),
    firstActivityAt: new Date("2027-01-01T00:00:10.000Z"),
    lastActivityAt: new Date("2027-01-01T00:00:10.000Z"),
    settledAt: new Date("2027-01-01T00:00:13.000Z"),
    claimCount: 1,
    ...overrides,
  };
}

describe("Runtime v3 acceptance measurement report", () => {
  it("reports product percentiles separately from queue, stall, and takeover safety clocks", () => {
    const report = createRuntimeV3AcceptanceReport([
      fact(),
      fact({
        wakePath: "archived_wake",
        acceptedAt: new Date("2027-01-01T00:10:00.000Z"),
        firstClaimedAt: new Date("2027-01-01T00:10:02.000Z"),
        boxReadyAt: new Date("2027-01-01T00:10:06.000Z"),
        stagingCompletedAt: new Date("2027-01-01T00:10:09.000Z"),
        piReadyAt: new Date("2027-01-01T00:10:11.000Z"),
        admittedAt: new Date("2027-01-01T00:10:14.000Z"),
        firstActivityAt: new Date("2027-01-01T00:10:15.000Z"),
        lastActivityAt: new Date("2027-01-01T00:10:15.000Z"),
        settledAt: new Date("2027-01-01T00:10:20.000Z"),
        claimCount: 2,
      }),
      fact({
        lane: "background",
        wakePath: "warm",
        state: "queued",
        acceptedAt: new Date(now.getTime() - 12 * minute),
        firstClaimedAt: null,
        boxReadyAt: null,
        stagingCompletedAt: null,
        piReadyAt: null,
        admissionKind: null,
        admittedAt: null,
        firstActivityAt: null,
        lastActivityAt: null,
        settledAt: null,
        claimCount: 0,
      }),
      fact({
        wakePath: "warm",
        state: "running",
        acceptedAt: new Date(now.getTime() - 20 * minute),
        firstClaimedAt: new Date(now.getTime() - 19 * minute),
        boxReadyAt: new Date(now.getTime() - 21 * minute),
        stagingCompletedAt: new Date(now.getTime() - 21 * minute),
        piReadyAt: new Date(now.getTime() - 21 * minute),
        admittedAt: new Date(now.getTime() - 18 * minute),
        firstActivityAt: new Date(now.getTime() - 17 * minute),
        lastActivityAt: new Date(now.getTime() - 11 * minute),
        settledAt: null,
      }),
    ], now);

    expect(report.releaseMeasurementReady).toBe(true);
    expect(report.product).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lane: "main",
        wakePath: "creation",
        sampleCount: 1,
        create: { samples: 1, p50Ms: 2_000, p95Ms: 2_000 },
        preparation: { samples: 1, p50Ms: 4_000, p95Ms: 4_000 },
        sendToAck: { samples: 1, p50Ms: 9_000, p95Ms: 9_000 },
        wakeToAck: { samples: 1, p50Ms: 8_000, p95Ms: 8_000 },
        terminalization: { samples: 1, p50Ms: 4_000, p95Ms: 4_000 },
      }),
    ]));
    expect(report.safety).toEqual({
      oldestQueueAgeMs: 12 * minute,
      queued: 1,
      stalled: 1,
      takeovers: 1,
    });
    expect(JSON.stringify(report)).not.toMatch(
      /orgId|companionId|actorId|transcript|url|token|payload|invocation|eventId/i,
    );
  });

  it("fails the release measurement when an ACK loses its acceptance correlation", () => {
    const report = createRuntimeV3AcceptanceReport([
      fact({ acceptedAt: null }),
    ], now);

    expect(report.releaseMeasurementReady).toBe(false);
    expect(report.correlation).toEqual({ acknowledged: 1, complete: 0, missing: 1 });
  });
});
