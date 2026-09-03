import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import type { CompanionControlAuthorization } from "@companion/core";
import type { CompanionControlJsonValue } from "@companion/contracts";
import {
  executeCompanionControlMcp,
  type CompanionControlMcpDependencies,
} from "./companionControlMcp";

const dependencies: CompanionControlMcpDependencies = {
  cancelCompanionDelegationTurn: vi.fn(),
  companionControlActor: vi.fn(),
  finishCompanionControlInvocation: vi.fn(),
  getCompanionDelegation: vi.fn(),
  registerCompanionControlInvocation: vi.fn(),
  updateCompanionV2: vi.fn(),
};

const authorization: CompanionControlAuthorization = {
  orgId: "11111111-1111-4111-8111-111111111111",
  companionId: "22222222-2222-4222-8222-222222222222",
  actorId: "actor-1",
  turnId: "33333333-3333-4333-8333-333333333333",
  attemptId: "44444444-4444-4444-8444-444444444444",
};
const companion = {
  id: authorization.companionId,
  name: "Renamed",
  persona: null,
  model_id: null,
  selected_skill_ids: [],
  can_write_skills: false,
  selected_mcp_account_ids: [],
  owner_id: authorization.actorId,
  access: "owner" as const,
  pinned: false,
  hidden: false,
  muted: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 1,
    state: "running" as const,
    daemon_state: "running" as const,
    box_id: "bx_test",
    provider_ids: [],
    provider_credential_generation: null,
    disk_layout_version: 14,
    desktop_available: false,
    replying: false,
    last_error: null,
    skills_revision: 1,
    skills_applied_revision: 1,
    skills_applied_at: null,
    skills_last_error: null,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
    latest_operation: null,
  },
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

// SAFETY: every database-facing dependency used by these tests is replaced above.
const database = {} as Db;

function updateSelfCall(name: string, id = "call-1") {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call" as const,
    params: { name: "companion_update_self", arguments: { name } },
  };
}

describe("executeCompanionControlMcp idempotence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dependencies.companionControlActor)
      .mockResolvedValue({ id: "actor-1", email: "owner@example.com", name: "Owner" });
    vi.mocked(dependencies.updateCompanionV2).mockResolvedValue(companion);
    vi.mocked(dependencies.finishCompanionControlInvocation).mockImplementation(async ({ result }) => result);
  });

  it("returns the stored response without repeating a direct mutation", async () => {
    let storedResult: Record<string, CompanionControlJsonValue> | null = null;
    vi.mocked(dependencies.registerCompanionControlInvocation)
      .mockResolvedValueOnce({ replayed: false, result: null })
      .mockImplementationOnce(async () => ({ replayed: true, result: storedResult }));
    vi.mocked(dependencies.finishCompanionControlInvocation).mockImplementationOnce(async ({ result }) => {
      storedResult = result;
      return result;
    });

    const first = await executeCompanionControlMcp({
      raw: updateSelfCall("Renamed"), authorization, database, dependencies,
    });
    const replay = await executeCompanionControlMcp({
      raw: updateSelfCall("Renamed"), authorization, database, dependencies,
    });

    expect(replay).toEqual(first);
    expect(dependencies.updateCompanionV2).toHaveBeenCalledTimes(1);
    expect(dependencies.finishCompanionControlInvocation).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the invocation key collides with different arguments", async () => {
    vi.mocked(dependencies.registerCompanionControlInvocation).mockRejectedValueOnce(
      new Error("Companion control invocation key collision"),
    );

    const result = await executeCompanionControlMcp({
      raw: updateSelfCall("Different"), authorization, database, dependencies,
    });

    expect(result).toMatchObject({
      id: "call-1",
      result: { isError: true },
    });
    expect(dependencies.companionControlActor).not.toHaveBeenCalled();
    expect(dependencies.updateCompanionV2).not.toHaveBeenCalled();
    expect(dependencies.finishCompanionControlInvocation).not.toHaveBeenCalled();
  });

  it("hashes the complete JSON-RPC id instead of truncating long ids into one invocation key", async () => {
    vi.mocked(dependencies.registerCompanionControlInvocation)
      .mockRejectedValue(new Error("stop after identity capture"));
    const sharedPrefix = "x".repeat(300);

    await executeCompanionControlMcp({
      raw: updateSelfCall("Renamed", `${sharedPrefix}-one`), authorization, database, dependencies,
    });
    await executeCompanionControlMcp({
      raw: updateSelfCall("Renamed", `${sharedPrefix}-two`), authorization, database, dependencies,
    });

    const first = vi.mocked(dependencies.registerCompanionControlInvocation).mock.calls[0]?.[0];
    const second = vi.mocked(dependencies.registerCompanionControlInvocation).mock.calls[1]?.[0];
    expect(first?.requestKey).toMatch(new RegExp(`^${authorization.attemptId}:[0-9a-f]{64}$`));
    expect(second?.requestKey).toMatch(new RegExp(`^${authorization.attemptId}:[0-9a-f]{64}$`));
    expect(first?.requestKey).not.toBe(second?.requestKey);
  });

  it("cancels a delegation through its Runtime v3 target Turn seam", async () => {
    const delegationId = "55555555-5555-4555-8555-555555555555";
    const targetCompanionId = "66666666-6666-4666-8666-666666666666";
    const targetTurnId = "77777777-7777-4777-8777-777777777777";
    vi.mocked(dependencies.registerCompanionControlInvocation)
      .mockResolvedValue({ replayed: false, result: null });
    vi.mocked(dependencies.getCompanionDelegation).mockResolvedValue({
      id: delegationId,
      source_companion_id: authorization.companionId,
      source_companion_name: "Source",
      target_companion_id: targetCompanionId,
      target_companion_name: "Target",
      source_turn_id: authorization.turnId,
      target_turn_id: targetTurnId,
      root_turn_id: authorization.turnId,
      parent_delegation_id: null,
      depth: 1,
      response_mode: "notify",
      status: "queued",
      delivery_status: "pending",
      created_at: "2026-09-01T00:00:00.000Z",
      settled_at: null,
    });
    vi.mocked(dependencies.cancelCompanionDelegationTurn).mockResolvedValue({
      id: targetTurnId,
      companion_id: targetCompanionId,
      client_message_id: "88888888-8888-4888-8888-888888888888",
      status: "cancelled",
      queue_sequence: 1,
      latest_attempt: null,
      admission_state: "pending",
      admitted_at: null,
      replying: false,
      error: null,
      state_changed_at: "2026-09-01T00:00:00.000Z",
      settled_at: "2026-09-01T00:00:00.000Z",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    });

    const result = await executeCompanionControlMcp({
      raw: {
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "tools/call",
        params: { name: "companion_cancel_delegation", arguments: { delegation_id: delegationId } },
      },
      authorization,
      database,
      dependencies,
    });

    expect(result).toMatchObject({ result: { structuredContent: {
      delegation_id: delegationId,
      target_turn: { id: targetTurnId, status: "cancelled" },
    } } });
    expect(dependencies.cancelCompanionDelegationTurn).toHaveBeenCalledWith({
      orgId: authorization.orgId,
      sourceCompanionId: authorization.companionId,
      delegationId,
      database,
    });
  });
});
