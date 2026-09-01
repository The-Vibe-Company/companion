/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- Existing row fixtures predate the incremental anti-slop gate. */

import { describe, expect, it } from "vitest";
import {
  RuntimeRowDecodeError,
  decodeRuntimeAuthorizationRow,
  decodeRuntimeClaimRow,
} from "./types";
import {
  ATTEMPT_ID,
  CLAIM_TOKEN,
  COMPANION_ID,
  ORG_ID,
  TURN_ID,
} from "./test/fixtures";

function claimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG_ID,
    companion_id: COMPANION_ID,
    claim_token: CLAIM_TOKEN,
    claim_epoch: "9007199254740993",
    gate_epoch: "1",
    work_kind: "attempt",
    work_id: ATTEMPT_ID,
    actor_id: "user-1",
    client_surface: "web",
    runtime_generation: "1",
    checkpoint: "starting",
    checkpoint_sequence: "0",
    turn_id: TURN_ID,
    turn_status: "starting",
    attempt_status: "starting",
    dispatch_state: "pending",
    event_cursor: "0",
    unknown_event_count: 0,
    malformed_event_count: 0,
    oversized_event_count: 0,
    cold_start_deadline_at: new Date("2026-08-16T12:03:00.000Z"),
    inactivity_deadline_at: null,
    absolute_deadline_at: new Date("2026-08-16T14:00:00.000Z"),
    operation_kind: null,
    operation_started_at: null,
    operation_attempt_count: null,
    provider_operation_id: null,
    target_settings_revision: null,
    target_skills_revision: null,
    decision_status: null,
    decision_delivery_state: null,
    ...overrides,
  };
}

function authorizationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authorized: true,
    denial_code: null,
    lease_expires_at: new Date("2026-08-16T12:00:30.000Z"),
    authorization_actor_id: "user-1",
    decision_actor_id: null,
    client_surface: "web",
    runtime_generation: "1",
    box_id: "bx_23456789",
    box_state: "ready",
    pi_state: "idle",
    pi_invocation_id: "pi-1",
    disk_layout_version: 14,
    applied_settings_revision: "1",
    applied_skills_revision: 1,
    model_id: "provider/model",
    persona: null,
    can_write_skills: false,
    provider_refs: [],
    skill_refs: [],
    mcp_refs: [],
    desired_settings_revision: "1",
    skills_revision: 1,
    work_checkpoint: "starting",
    work_checkpoint_sequence: "0",
    turn_id: TURN_ID,
    turn_status: "starting",
    attempt_status: "starting",
    dispatch_state: "pending",
    event_cursor: "0",
    unknown_event_count: 0,
    malformed_event_count: 0,
    oversized_event_count: 0,
    cold_start_deadline_at: new Date("2026-08-16T12:03:00.000Z"),
    inactivity_deadline_at: null,
    absolute_deadline_at: new Date("2026-08-16T14:00:00.000Z"),
    operation_kind: null,
    operation_started_at: null,
    operation_attempt_count: null,
    provider_operation_id: null,
    target_settings_revision: null,
    target_skills_revision: null,
    decision_status: null,
    decision_delivery_state: null,
    decision_request_key: null,
    decision_response_text: null,
    ...overrides,
  };
}

describe("runtime SQL row refinement", () => {
  it("preserves bigint values beyond Number.MAX_SAFE_INTEGER and allows a null initial stall deadline", () => {
    const claim = decodeRuntimeClaimRow(claimRow());
    expect(claim.claimEpoch).toBe(9_007_199_254_740_993n);
    expect(claim.inactivityDeadlineAt).toBeNull();
  });

  it("rejects a bigint that was not selected as text", () => {
    expect(() => decodeRuntimeClaimRow(claimRow({ claim_epoch: 1 })))
      .toThrow(RuntimeRowDecodeError);
  });

  it("accepts an attempt authorization from desired revisions without operation target columns", () => {
    const authorization = decodeRuntimeAuthorizationRow(authorizationRow(), "attempt");
    expect(authorization.desiredSettingsRevision).toBe(1n);
    expect(authorization.targetSettingsRevision).toBeNull();
  });

  it("rejects authorized resource work without a model capability snapshot", () => {
    expect(() => decodeRuntimeAuthorizationRow(authorizationRow({ model_id: null }), "attempt"))
      .toThrow(RuntimeRowDecodeError);
  });

  it("rejects an authorized attempt with a nullable actor before external effects", () => {
    expect(() => decodeRuntimeAuthorizationRow(
      authorizationRow({ authorization_actor_id: null }),
      "attempt",
    )).toThrow(RuntimeRowDecodeError);
  });

  it("rejects settings claims that omit the frozen revision snapshot", () => {
    expect(() => decodeRuntimeClaimRow(claimRow({
      work_kind: "settings",
      work_id: COMPANION_ID,
      checkpoint: "applying",
      turn_id: null,
      turn_status: null,
      attempt_status: null,
      dispatch_state: null,
      event_cursor: null,
      unknown_event_count: null,
      malformed_event_count: null,
      oversized_event_count: null,
      cold_start_deadline_at: null,
      absolute_deadline_at: null,
      target_settings_revision: null,
      target_skills_revision: null,
    }))).toThrow(RuntimeRowDecodeError);
  });

  it("accepts settings claims that carry the frozen revision snapshot", () => {
    const claim = decodeRuntimeClaimRow(claimRow({
      work_kind: "settings",
      work_id: COMPANION_ID,
      checkpoint: "applying",
      turn_id: null,
      turn_status: null,
      attempt_status: null,
      dispatch_state: null,
      event_cursor: null,
      unknown_event_count: null,
      malformed_event_count: null,
      oversized_event_count: null,
      cold_start_deadline_at: null,
      absolute_deadline_at: null,
      target_settings_revision: "1",
      target_skills_revision: 1,
    }));
    expect(claim.workKind).toBe("settings");
    if (claim.workKind === "settings") {
      expect(claim.targetSettingsRevision).toBe(1n);
      expect(claim.targetSkillsRevision).toBe(1);
    }
  });

  it("accepts stop claims with no client surface or resource snapshot", () => {
    const claim = decodeRuntimeClaimRow(claimRow({
      work_kind: "operation",
      work_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      client_surface: null,
      checkpoint: "pending",
      turn_id: null,
      turn_status: null,
      attempt_status: null,
      dispatch_state: null,
      event_cursor: null,
      unknown_event_count: null,
      malformed_event_count: null,
      oversized_event_count: null,
      absolute_deadline_at: null,
      operation_kind: "stop",
      operation_started_at: new Date("2026-08-16T12:00:00.000Z"),
      operation_attempt_count: 1,
      target_skills_revision: 1,
    }));
    expect(claim.workKind).toBe("operation");
    if (claim.workKind === "operation") expect(claim.clientSurface).toBeNull();
  });

  it("accepts a protocol-6 recovery claim without a captured resource snapshot", () => {
    const claim = decodeRuntimeClaimRow(claimRow({
      work_kind: "operation",
      work_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      client_surface: null,
      checkpoint: "pending",
      turn_status: "interrupted",
      attempt_status: null,
      dispatch_state: "ambiguous",
      event_cursor: null,
      unknown_event_count: null,
      malformed_event_count: null,
      oversized_event_count: null,
      operation_kind: "restart_pi",
      operation_started_at: new Date("2026-08-16T12:00:00.000Z"),
      operation_attempt_count: 78,
      target_settings_revision: null,
      target_skills_revision: null,
    }));

    expect(claim).toMatchObject({
      workKind: "operation",
      operationKind: "restart_pi",
      clientSurface: null,
      operationAttemptCount: 78,
    });
  });

  it("accepts only an exact resource-free recovery authorization", () => {
    const row = authorizationRow({
      authorization_actor_id: null,
      client_surface: null,
      model_id: null,
      persona: null,
      can_write_skills: null,
      desired_settings_revision: null,
      skills_revision: null,
      work_checkpoint: "pending",
      turn_status: "interrupted",
      attempt_status: null,
      operation_kind: "restart_pi",
      operation_started_at: new Date("2026-08-16T12:00:00.000Z"),
      operation_attempt_count: 78,
      operation_trigger: "recovery",
      operation_lane: "main",
      source_dispatch_state: "ambiguous",
      source_pi_invocation_id: "pi-interrupted",
      target_settings_revision: null,
      target_skills_revision: null,
    });

    expect(decodeRuntimeAuthorizationRow(row, "operation")).toMatchObject({
      operationTrigger: "recovery",
      operationLane: "main",
      sourceDispatchState: "ambiguous",
      sourcePiInvocationId: "pi-interrupted",
      authorizationActorId: null,
      modelId: null,
    });
    expect(decodeRuntimeAuthorizationRow({
      ...row,
      source_pi_invocation_id: null,
    }, "operation")).toMatchObject({
      sourceDispatchState: "ambiguous",
      sourcePiInvocationId: null,
    });
  });

  it("keeps Box identity on a stop denial so the executor can abort Pi", () => {
    const authorization = decodeRuntimeAuthorizationRow(authorizationRow({
      authorized: false,
      denial_code: "turn_cancel_requested",
      model_id: null,
      persona: null,
      can_write_skills: null,
      desired_settings_revision: null,
      skills_revision: null,
    }), "attempt");
    expect(authorization).toMatchObject({
      authorized: false,
      denialCode: "turn_cancel_requested",
      boxId: "bx_23456789",
    });
  });
});
