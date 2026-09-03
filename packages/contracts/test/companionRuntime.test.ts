import { describe, expect, it } from "vitest";
import type { CompanionTurn, CompanionTurnAttempt } from "../src/companionRuntime";

import {
  cancelCompanionTurnInputSchema,
  companionActiveTurnSchema,
  companionInterruptedTurnSchema,
  companionLifecycleAcceptedSchema,
  companionOperationAcceptedResponseSchema,
  companionOperationSchema,
  companionQueuedTurnSchema,
  companionRuntimeSafeErrorSchema,
  companionTurnSchema,
} from "../src/companionRuntime";

const companionId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const operationId = "66666666-6666-4666-8666-666666666666";
const createdAt = "2026-08-17T12:00:00.000+00:00";

const safeError = {
  code: "dispatch_ambiguous",
  message: "Pi may have received this prompt.",
  action: "retry" as const,
};

function attempt(overrides: Partial<CompanionTurnAttempt> = {}): CompanionTurnAttempt {
  return {
    id: attemptId,
    turn_id: turnId,
    attempt_number: 1,
    retry_id: null,
    status: "running",
    dispatch_state: "accepted",
    pi_invocation_id: "pi-invocation-1",
    dispatch_accepted_at: createdAt,
    error: null,
    started_at: createdAt,
    settled_at: null,
    ...overrides,
  };
}

function turn(overrides: Partial<CompanionTurn> = {}): CompanionTurn {
  return {
    id: turnId,
    companion_id: companionId,
    client_message_id: messageId,
    status: "running",
    queue_sequence: 1,
    latest_attempt: attempt(),
    replying: true,
    error: null,
    state_changed_at: createdAt,
    settled_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

describe("Companion Runtime v3 public contracts", () => {
  it("projects an honest bounded external block without dependency identifiers", () => {
    const parsed = companionTurnSchema.parse(turn({
      status: "queued",
      replying: false,
      latest_attempt: null,
      external_block: {
        classification: "model",
        source: "delegation",
        message: "This work is blocked until the selected model is usable again.",
      },
    }));
    expect(parsed.external_block).toEqual({
      classification: "model",
      source: "delegation",
      message: "This work is blocked until the selected model is usable again.",
    });
    expect(JSON.stringify(parsed.external_block)).not.toMatch(/tenant|credential|url|payload/i);
  });

  it("bounds persisted errors to one safe line and one supported action", () => {
    expect(companionRuntimeSafeErrorSchema.parse(safeError)).toEqual(safeError);
    expect(companionRuntimeSafeErrorSchema.parse({
      ...safeError,
      message: "🧪".repeat(500),
    }).message).toBe("🧪".repeat(500));
    expect(() => companionRuntimeSafeErrorSchema.parse({
      ...safeError,
      message: "provider payload\nsecret",
    })).toThrow();
    expect(() => companionRuntimeSafeErrorSchema.parse({
      ...safeError,
      message: "x".repeat(501),
    })).toThrow();
    expect(() => companionRuntimeSafeErrorSchema.parse({
      ...safeError,
      message: "🧪".repeat(501),
    })).toThrow();
    expect(() => companionRuntimeSafeErrorSchema.parse({
      ...safeError,
      action: "replay",
    })).toThrow();
  });

  it("exposes replying only for a positively acknowledged running attempt", () => {
    expect(companionActiveTurnSchema.parse(turn()).replying).toBe(true);
    expect(() => companionTurnSchema.parse(turn({
      latest_attempt: attempt({ dispatch_state: "write_intent", dispatch_accepted_at: null }),
    }))).toThrow();
    expect(() => companionTurnSchema.parse(turn({
      status: "needs_input",
      latest_attempt: attempt({ status: "needs_input" }),
    }))).toThrow();
    expect(companionTurnSchema.parse(turn({
      replying: false,
      latest_attempt: attempt({ dispatch_state: "write_intent", dispatch_accepted_at: null }),
    })).replying).toBe(false);
  });

  it("projects Runtime v3 admission without inventing an attempt", () => {
    const admitted = turn({
      status: "admitted",
      latest_attempt: null,
      admission_state: "accepted",
      admitted_at: createdAt,
      replying: true,
    });
    expect(companionActiveTurnSchema.parse(admitted)).toMatchObject({
      status: "admitted",
      admission_state: "accepted",
      replying: true,
      latest_attempt: null,
    });
    expect(() => companionTurnSchema.parse({
      ...admitted,
      admission_state: "pending",
      admitted_at: null,
    })).toThrow();
  });

  it("keeps queued and interrupted turns distinct and enforces terminal errors", () => {
    const queued = turn({
      status: "queued",
      latest_attempt: null,
      replying: false,
    });
    expect(companionQueuedTurnSchema.parse(queued).status).toBe("queued");
    expect(() => companionActiveTurnSchema.parse(queued)).toThrow();

    const interrupted = turn({
      status: "interrupted",
      latest_attempt: attempt({
        status: "interrupted",
        dispatch_state: "ambiguous",
        dispatch_accepted_at: null,
        error: safeError,
        settled_at: createdAt,
      }),
      replying: false,
      error: safeError,
      settled_at: createdAt,
    });
    expect(companionInterruptedTurnSchema.parse(interrupted).error).toEqual(safeError);
    expect(() => companionTurnSchema.parse({ ...interrupted, error: null })).toThrow();

    expect(companionTurnSchema.parse(interrupted).recovery_status).toBeUndefined();
    expect(companionTurnSchema.parse({
      ...interrupted,
      recovery_status: "pending",
    }).recovery_status).toBe("pending");
    expect(companionTurnSchema.parse({
      ...interrupted,
      recovery_status: "future_cleanup_phase",
    }).recovery_status).toBeNull();
    expect(companionTurnSchema.parse({
      ...interrupted,
      resolution: "auto_abandoned",
      recovery_status: "completed",
    }).recovery_status).toBe("completed");
  });

  it("projects lifecycle operations without provider payloads", () => {
    const operation = {
      id: operationId,
      companion_id: companionId,
      request_id: null,
      source_turn_id: null,
      kind: "restart_pi",
      trigger: "user",
      status: "pending",
      queue_sequence: 2,
      checkpoint: "pending",
      attempt_count: 0,
      error: null,
      created_at: createdAt,
      started_at: null,
      settled_at: null,
    };
    expect(companionOperationAcceptedResponseSchema.parse({ operation }).operation.kind)
      .toBe("restart_pi");
    expect(() => companionOperationSchema.parse({
      ...operation,
      provider_operation_id: "secret-provider-detail",
    })).toThrow();
  });

  it("requires an empty Cancel body", () => {
    expect(cancelCompanionTurnInputSchema.parse({})).toEqual({});
    expect(() => cancelCompanionTurnInputSchema.parse({ rollback: true })).toThrow();
  });

  it("accepts only v3 lifecycle intent and monotonic revision", () => {
    expect(companionLifecycleAcceptedSchema.parse({ intent: "recycle_pi", revision: "4" }))
      .toEqual({ intent: "recycle_pi", revision: "4" });
    expect(() => companionLifecycleAcceptedSchema.parse({ intent: "restart_box", revision: "4" }))
      .toThrow();
  });
});
