import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import type { CompanionControlAuthorization } from "@companion/core";
import type { CompanionControlJsonValue } from "@companion/contracts";
import {
  executeCompanionControlMcp,
  type CompanionControlMcpDependencies,
} from "./companionControlMcp";

const dependencies: CompanionControlMcpDependencies = {
  companionControlActor: vi.fn(),
  finishCompanionControlInvocation: vi.fn(),
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

function updateSelfCall(name: string) {
  return {
    jsonrpc: "2.0" as const,
    id: "call-1",
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
});
