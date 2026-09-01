import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";

import {
  createCompanionControlRequest,
  grantCompanionPeerAccess,
  listCompanionDelegations,
  type CompanionControlAuthorization,
} from "../src/companionControl";

const authorization: CompanionControlAuthorization = {
  orgId: "11111111-1111-4111-8111-111111111111",
  companionId: "22222222-2222-4222-8222-222222222222",
  actorId: "owner-1",
  turnId: "33333333-3333-4333-8333-333333333333",
  attemptId: "44444444-4444-4444-8444-444444444444",
};

function databaseReturning(rows: unknown[]): Db {
  // SAFETY: these projection tests exercise only `database.execute`, which this fake implements.
  const database: Db = Object.create(null);
  Object.defineProperty(database, "execute", {
    value: vi.fn(async () => rows),
  });
  return database;
}

describe("Companion control public projections", () => {
  it("strips private control-request columns returned by SQL", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const request = await createCompanionControlRequest({
      authorization,
      id: "55555555-5555-4555-8555-555555555555",
      kind: "model_change",
      action: "change_model",
      summary: "Change model",
      payload: { model_id: "provider/model" },
      requestKey: "request-key",
      requestDigest: "a".repeat(64),
      requiredAccess: "editor",
      database: databaseReturning([{
        id: "55555555-5555-4555-8555-555555555555",
        org_id: authorization.orgId,
        companion_id: authorization.companionId,
        source_turn_id: authorization.turnId,
        source_attempt_id: authorization.attemptId,
        request_key: "private-request-key",
        request_digest: "a".repeat(64),
        required_access: "editor",
        kind: "model_change",
        action: "change_model",
        summary: "Change model",
        payload: { model_id: "provider/model" },
        status: "pending",
        requested_by_id: "owner-1",
        decided_by_id: null,
        result: null,
        error_code: null,
        error_message: null,
        expires_at: new Date("2026-09-01T01:00:00.000Z"),
        decided_at: null,
        applied_at: null,
        continuation_turn_id: null,
        created_at: now,
        updated_at: now,
      }]),
    });

    expect(request).not.toHaveProperty("org_id");
    expect(request).not.toHaveProperty("request_key");
    expect(request).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
      status: "pending",
      expires_at: "2026-09-01T01:00:00.000Z",
    });
  });

  it("strips private peer-grant and delegation columns returned by SQL", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const sourceId = authorization.companionId;
    const targetId = "66666666-6666-4666-8666-666666666666";
    const grant = await grantCompanionPeerAccess({
      orgId: authorization.orgId,
      sourceCompanionId: sourceId,
      targetCompanionId: targetId,
      targetName: "Researcher",
      database: databaseReturning([{
        id: "77777777-7777-4777-8777-777777777777",
        org_id: authorization.orgId,
        source_companion_id: sourceId,
        target_companion_id: targetId,
        granted_by_id: "owner-1",
        revoked_by_id: null,
        revoked_at: null,
        created_at: now,
        updated_at: now,
      }]),
    });
    expect(grant).not.toHaveProperty("org_id");
    expect(grant).not.toHaveProperty("revoked_by_id");

    const delegations = await listCompanionDelegations({
      orgId: authorization.orgId,
      companionId: sourceId,
      database: databaseReturning([{
        id: "88888888-8888-4888-8888-888888888888",
        org_id: authorization.orgId,
        source_companion_id: sourceId,
        source_companion_name: "Coordinator",
        target_companion_id: targetId,
        target_companion_name: "Researcher",
        actor_id: "owner-1",
        source_turn_id: authorization.turnId,
        source_attempt_id: authorization.attemptId,
        target_turn_id: "99999999-9999-4999-8999-999999999999",
        root_turn_id: authorization.turnId,
        parent_delegation_id: null,
        depth: 1,
        response_mode: "relay",
        status: "queued",
        delivery_status: "pending",
        request_key: "private-request-key",
        request_digest: "b".repeat(64),
        source_result_event_id: null,
        source_relay_turn_id: null,
        delivery_error_code: null,
        settled_at: null,
        delivered_at: null,
        created_at: now,
        updated_at: now,
      }]),
    });
    expect(delegations[0]).not.toHaveProperty("org_id");
    expect(delegations[0]).not.toHaveProperty("request_key");
    expect(delegations[0]).toMatchObject({
      source_companion_name: "Coordinator",
      target_companion_name: "Researcher",
      response_mode: "relay",
    });
  });
});
