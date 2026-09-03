/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- The recording SQL double intentionally captures unparsed driver rows so each decoder boundary can be tested. */

import { describe, expect, it } from "vitest";
import {
  PostgresRuntimeStore,
  RuntimeAttachmentExpiredError,
  RuntimeCredentialSnapshotChangedError,
  type RuntimeSqlClient,
  type RuntimeSqlRow,
} from "./store";
import type { LeaseFence } from "./types";
import {
  ATTEMPT_ID,
  CLAIM_TOKEN,
  COMPANION_ID,
  MESSAGE_EVENT_ID,
  ORG_ID,
  TURN_ID,
} from "./test/fixtures";

class RecordingSql implements RuntimeSqlClient {
  readonly calls: Array<{ query: string; parameters: unknown[] }> = [];
  rows: RuntimeSqlRow[] = [];

  async unsafe<T extends RuntimeSqlRow[]>(
    query: string,
    parameters: unknown[] = [],
  ): Promise<T> {
    this.calls.push({ query, parameters });
    const rows = this.rows.map((row) => {
      const copy = { ...row };
      if (query.includes("companion_runtime_get_routine_material")) {
        Object.assign(copy, {
          relay_source_content: row.relay_source_content ?? null,
          routine_snapshot_id: row.routine_snapshot_id ?? null,
          routine_name: row.routine_name ?? null,
          routine_isolated: row.routine_isolated ?? false,
          routine_context_id: row.routine_context_id ?? null,
          routine_context_sha256: row.routine_context_sha256 ?? null,
          routine_context_content: row.routine_context_content ?? null,
          trigger_name: null,
          trigger_mode: null,
        });
      }
      if (query.includes("companion_runtime_get_trigger_material")) {
        Object.assign(copy, {
          trigger_name: row.trigger_name ?? null,
          trigger_mode: row.trigger_mode ?? null,
        });
      }
      if (query.includes("companion_runtime_project_event_batch_v2")) {
        copy.routine_returned = row.routine_returned ?? false;
      }
      return copy;
    });
    // SAFETY: The fixture rows are the exact shape requested by each SQL call in these tests.
    return rows as T;
  }
}

const fence: LeaseFence = {
  orgId: ORG_ID,
  companionId: COMPANION_ID,
  claimToken: CLAIM_TOKEN,
  claimEpoch: 3n,
  gateEpoch: 4n,
  executorId: "executor-1",
  workKind: "operation",
  workId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("PostgresRuntimeStore", () => {
  it("maps the database expiry guard to a stable non-retryable runtime failure", async () => {
    const sql: RuntimeSqlClient = {
      unsafe: async () => { throw { code: "P5220" }; },
    };
    const store = new PostgresRuntimeStore(sql);

    await expect(store.getMaterial({
      ...fence,
      workKind: "attempt",
      workId: ATTEMPT_ID,
    }, 30)).rejects.toBeInstanceOf(RuntimeAttachmentExpiredError);
  });

  it("reads only aggregate self-heal telemetry through the narrow runtime function", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      pending_recovery_count: 3,
      oldest_recovery_age_seconds: 47.5,
      auto_abandoned_count: 12,
      stalled_recovery_count: 2,
      max_recovery_attempt_count: 78,
    }];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.recoveryMetrics()).resolves.toEqual({
      pendingCount: 3,
      oldestAgeSeconds: 47.5,
      autoAbandonedCount: 12,
      stalledCount: 2,
      maxAttemptCount: 78,
    });
    expect(sql.calls[0]?.query).toContain("public.companion_runtime_recovery_metrics()");
    expect(sql.calls[0]?.query).not.toContain("companion_id");
  });

  it("claims only through the self-healing material and delete-resume protocol guards", async () => {
    const sql = new RecordingSql();
    const store = new PostgresRuntimeStore(sql);

    await store.claimWork({ executorId: "executor-1", limit: 2, leaseSeconds: 30, gateEpoch: 4n });

    expect(sql.calls[0]?.query).toContain(
      "$4::bigint, 7::integer, 1::integer",
    );
  });

  it("reauthorizes through the cleanup-aware protocol-7 contract", async () => {
    const sql = new RecordingSql();
    const store = new PostgresRuntimeStore(sql);

    await expect(store.renewAndAuthorize(fence, 30)).resolves.toBeNull();

    expect(sql.calls[0]?.query).toContain("public.companion_runtime_renew_and_authorize_v3(");
    expect(sql.calls[0]?.query).toContain("source_pi_invocation_id");
  });

  it("uses the exact fenced parameter order for accepted delete deferral", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ deferred: true }];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.deferDelete(fence)).resolves.toBe(true);

    expect(sql.calls[0]?.query).toContain("public.companion_runtime_defer_delete(");
    expect(sql.calls[0]?.parameters).toEqual([
      ORG_ID,
      COMPANION_ID,
      CLAIM_TOKEN,
      "3",
      "4",
      "executor-1",
      "operation",
      fence.workId,
    ]);
  });

  it("uses the exact fenced parameter order for duplicate cleanup checkpoints", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      box_id: "bx_2345678a",
      status: "delete_requested",
      provider_operation_id: "delete-op",
      checkpoint_sequence: "8",
    }];
    const store = new PostgresRuntimeStore(sql);

    await store.checkpointDuplicateCleanup(fence, {
      boxId: "bx_2345678a",
      expectedSequence: 7n,
      nextStatus: "delete_requested",
      providerOperationId: "delete-op",
    });

    expect(sql.calls[0]?.query).toContain("public.companion_runtime_checkpoint_duplicate_cleanup(");
    expect(sql.calls[0]?.parameters).toEqual([
      ORG_ID,
      COMPANION_ID,
      CLAIM_TOKEN,
      "3",
      "4",
      "executor-1",
      "operation",
      fence.workId,
      "bx_2345678a",
      "7",
      "delete_requested",
      "delete-op",
    ]);
  });

  it("decodes the durable attempt/output proof from the material definer", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: MESSAGE_EVENT_ID,
      prompt_text: "hello",
      turn_started_at: new Date("2026-08-26T13:42:17.000Z"),
      member_timezone: "America/New_York",
      decision_request_kind: null,
      decision_response_payload: null,
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      attachments: [{
        id: "3f1d8a52-0c47-4e3b-9a19-7bd0c5e4a611",
        storage_key: "companion-attachments/org/companion/message/0-" + "a".repeat(64),
        content_type: "image/png",
        byte_size: 2048,
        sha256: "a".repeat(64),
        filename: "chart.png",
        position: 0,
      }],
      credential_snapshot_matches: true,
      box_id: "bx_2345678a",
      agent_hosted_url: null,
      agent_token_ciphertext: null,
      agent_observed_at: null,
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30);

    expect(result).toMatchObject({
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      turnStartedAt: new Date("2026-08-26T13:42:17.000Z"),
      memberTimezone: "America/New_York",
      hasVisibleOutput: true,
      attachments: [{ filename: "chart.png", contentType: "image/png", position: 0 }],
      boxId: "bx_2345678a",
      agentEndpoint: null,
    });
    expect(sql.calls[0]?.query).toContain("public.companion_runtime_get_material(");
    expect(sql.calls[0]?.query).toContain("attempt_id");
    expect(sql.calls[0]?.query).toContain("has_visible_output");
    expect(sql.calls[0]?.query).toContain("attachments");
    expect(sql.calls[0]?.query).toContain("box_id");
    expect(sql.calls[0]?.query).toContain("agent_hosted_url");
    expect(sql.calls[0]?.query).toContain("agent_token_ciphertext");
    expect(sql.calls[0]?.query).toContain("agent_observed_at");
    expect(sql.calls[0]?.query).toContain("public.companion_runtime_get_turn_context(");
    expect(sql.calls[0]?.query).not.toContain("public.companion_runtime_get_trigger_material(");
    expect(sql.calls).toHaveLength(1);
  });

  it("loads trigger identity only for a trigger-origin isolated run", async () => {
    const sql = new RecordingSql();
    const triggerId = "55555555-5555-4555-8555-555555555555";
    sql.rows = [{
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: MESSAGE_EVENT_ID,
      prompt_text: "payload",
      turn_started_at: new Date("2026-08-26T13:42:17.000Z"),
      member_timezone: "UTC",
      decision_request_kind: null,
      decision_response_payload: null,
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: false,
      attachments: [],
      credential_snapshot_matches: true,
      box_id: "bx_2345678a",
      agent_hosted_url: null,
      agent_token_ciphertext: null,
      agent_observed_at: null,
      routine_snapshot_id: triggerId,
      routine_name: null,
      routine_isolated: false,
      routine_context_id: null,
      routine_context_sha256: null,
      routine_context_content: null,
      relay_source_content: null,
      trigger_name: "CI failed on main",
      trigger_mode: "notify",
    }];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.getMaterial({
      ...fence,
      workKind: "attempt",
      workId: ATTEMPT_ID,
    }, 30)).resolves.toMatchObject({
      routineId: triggerId,
      routineName: null,
      triggerName: "CI failed on main",
      triggerMode: "notify",
    });

    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[1]?.query).toContain("public.companion_runtime_get_trigger_material(");
  });

  it("accepts the multiline context produced while preparing an isolated routine run", async () => {
    const sql = new RecordingSql();
    const contextId = "2a1d4f26-268e-4b8b-b254-24194374fb0a";
    const content = "--- Main conversation context ---\n\n## Stable summary\nNo summary yet.\n";
    sql.rows = [{
      isolated: true,
      context_id: contextId,
      context_sha256: "d".repeat(64),
      context_content: content,
    }];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.prepareRoutineRun({
      ...fence,
      workKind: "attempt",
      workId: ATTEMPT_ID,
    })).resolves.toEqual({
      id: contextId,
      sha256: "d".repeat(64),
      content,
    });

    expect(sql.calls[0]?.query).toContain("public.companion_runtime_prepare_routine_run(");
  });

  it("decodes a complete agent endpoint and refuses a partial or malformed one", async () => {
    const base = {
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: MESSAGE_EVENT_ID,
      prompt_text: "hello",
      turn_started_at: new Date("2026-08-26T13:42:17.000Z"),
      member_timezone: "UTC",
      decision_request_kind: null,
      decision_response_payload: null,
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      attachments: [],
      credential_snapshot_matches: true,
      box_id: "bx_2345678a",
      agent_hosted_url: "https://abc-8790.on.ascii.dev/boxes/bx_2345678a",
      agent_token_ciphertext: "ciphertext-envelope",
      agent_observed_at: new Date("2026-08-18T12:00:00.000Z"),
    };
    const complete = new RecordingSql();
    complete.rows = [base];
    await expect(
      new PostgresRuntimeStore(complete)
        .getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30),
    ).resolves.toMatchObject({
      boxId: "bx_2345678a",
      agentEndpoint: {
        hostedUrl: "https://abc-8790.on.ascii.dev/boxes/bx_2345678a",
        tokenCiphertext: "ciphertext-envelope",
        observedAt: new Date("2026-08-18T12:00:00.000Z"),
      },
    });

    for (const drifted of [
      // Half an endpoint is a contract violation, exactly as the database CHECK says.
      { ...base, agent_token_ciphertext: null },
      { ...base, agent_hosted_url: null },
      { ...base, agent_observed_at: null },
      { ...base, agent_observed_at: "2026-08-18T12:00:00.000Z" },
      { ...base, agent_hosted_url: "x".repeat(2_049) },
      { ...base, box_id: "not-a-box" },
    ]) {
      const sql = new RecordingSql();
      sql.rows = [drifted];
      await expect(
        new PostgresRuntimeStore(sql)
          .getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30),
      ).rejects.toThrow();
    }
  });

  it("refuses staging material whose names, digests, or ordering drifted from the contract", async () => {
    const base = {
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: MESSAGE_EVENT_ID,
      prompt_text: "hello",
      turn_started_at: new Date("2026-08-26T13:42:17.000Z"),
      member_timezone: "UTC",
      decision_request_kind: null,
      decision_response_payload: null,
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      credential_snapshot_matches: true,
      box_id: "bx_2345678a",
      agent_hosted_url: null,
      agent_token_ciphertext: null,
      agent_observed_at: null,
    };
    const attachment = {
      id: "3f1d8a52-0c47-4e3b-9a19-7bd0c5e4a611",
      storage_key: "companion-attachments/org/companion/message/0-" + "a".repeat(64),
      content_type: "image/png",
      byte_size: 2048,
      sha256: "a".repeat(64),
      filename: "chart.png",
      position: 0,
    };
    for (const drifted of [
      { ...attachment, filename: "../escape.png" },
      { ...attachment, sha256: "not-a-digest" },
      { ...attachment, content_type: "application/zip" },
      { ...attachment, byte_size: 20 * 1024 * 1024 },
      { ...attachment, position: 3 },
    ]) {
      const sql = new RecordingSql();
      sql.rows = [{ ...base, attachments: [drifted] }];
      const store = new PostgresRuntimeStore(sql);
      await expect(
        store.getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30),
      ).rejects.toThrow();
    }
  });

  it("hands the harvested outputs to the definer as a jsonb array, not a JSON string", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ recorded: 1, has_visible_output: true }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.recordAttemptOutputs(
      { ...fence, workKind: "attempt", workId: ATTEMPT_ID },
      {
        attachments: [{
          storageKey: `companion-attachments/org/companion/outputs/attempt/0-${"d".repeat(64)}`,
          contentType: "image/png",
          byteSize: 512,
          sha256: "d".repeat(64),
          filename: "plot.png",
        }],
        activityAt: new Date("2026-08-18T12:00:00.000Z"),
      },
    );

    expect(result).toEqual({ recorded: 1, hasVisibleOutput: true });
    expect(sql.calls[0]?.query).toContain("public.companion_runtime_record_attempt_outputs(");
    // Pre-stringifying arrives as a JSON *string*, whose jsonb_typeof is not `array`, and the
    // definer refuses it. The driver serializes the array itself.
    const attachments = sql.calls[0]?.parameters?.[8];
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments).toEqual([expect.objectContaining({
      filename: "plot.png",
      content_type: "image/png",
      byte_size: 512,
      position: 0,
    })]);
  });

  it("returns null when the harvest fence is stale rather than inventing a result", async () => {
    const sql = new RecordingSql();
    sql.rows = [];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.recordAttemptOutputs(
      { ...fence, workKind: "attempt", workId: ATTEMPT_ID },
      { attachments: [], activityAt: new Date("2026-08-18T12:00:00.000Z") },
    )).resolves.toBeNull();
  });

  it("accepts a config_proposal decision kind from the material definer", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: null,
      prompt_text: null,
      turn_started_at: null,
      member_timezone: null,
      decision_request_kind: "config_proposal",
      decision_response_payload: { type: "extension_ui_response", id: "config-1", confirmed: true },
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      credential_snapshot_matches: true,
      box_id: "bx_2345678a",
      agent_hosted_url: null,
      agent_token_ciphertext: null,
      agent_observed_at: null,
      attachments: [],
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getMaterial({ ...fence, workKind: "decision", workId: ATTEMPT_ID }, 30);

    expect(result).toMatchObject({
      decisionRequestKind: "config_proposal",
      decisionResponsePayload: {
        type: "extension_ui_response",
        id: "config-1",
        confirmed: true,
      },
    });
  });

  it("accepts a routine_proposal decision kind from the material definer", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: null,
      prompt_text: null,
      turn_started_at: null,
      member_timezone: null,
      decision_request_kind: "routine_proposal",
      decision_response_payload: { type: "extension_ui_response", id: "routine-1", confirmed: true },
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      credential_snapshot_matches: true,
      box_id: "bx_2345678a",
      agent_hosted_url: null,
      agent_token_ciphertext: null,
      agent_observed_at: null,
      attachments: [],
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getMaterial({ ...fence, workKind: "decision", workId: ATTEMPT_ID }, 30);

    expect(result).toMatchObject({
      decisionRequestKind: "routine_proposal",
      decisionResponsePayload: {
        type: "extension_ui_response",
        id: "routine-1",
        confirmed: true,
      },
    });
  });

  it("accepts a trigger_proposal decision kind from the material definer", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      message_event_id: null,
      prompt_text: null,
      turn_started_at: null,
      member_timezone: null,
      decision_request_kind: "trigger_proposal",
      decision_response_payload: { type: "extension_ui_response", id: "trigger-1", confirmed: true },
      provider_material: [],
      skill_material: [],
      mcp_material: [],
      model_input: null,
      has_visible_output: true,
      credential_snapshot_matches: true,
      box_id: "bx_2345678a",
      agent_hosted_url: null,
      agent_token_ciphertext: null,
      agent_observed_at: null,
      attachments: [],
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getMaterial({ ...fence, workKind: "decision", workId: ATTEMPT_ID }, 30);

    expect(result).toMatchObject({
      decisionRequestKind: "trigger_proposal",
      decisionResponsePayload: {
        type: "extension_ui_response",
        id: "trigger-1",
        confirmed: true,
      },
    });
  });

  it("decodes a claim-fenced config catalog without credentials", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      catalog: {
        companion: { model_id: "fixture-model", provider_id: "anthropic", persona: null },
        skills: [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          slug: "search",
          name: "search",
          description: "Search the workspace",
          selected: true,
        }],
        plugins: [],
        note: "Propose changes with propose_config.",
      },
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getConfigCatalog(fence, 30);

    expect(sql.calls[0]?.query).toContain("public.companion_runtime_get_config_catalog(");
    expect(result?.companion.model_id).toBe("fixture-model");
    expect(result?.skills).toEqual([{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      slug: "search",
      name: "search",
      description: "Search the workspace",
      selected: true,
    }]);
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|wrapped_dek|auth_tag/i);
  });

  it("reads a claim-fenced ephemeral hub token once", async () => {
    const sql = new RecordingSql();
    const expiresAt = new Date("2026-08-16T18:00:00.000Z");
    sql.rows = [{
      token: "cmp_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expires_at: expiresAt,
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.mintHubToken(fence, 30);

    expect(sql.calls[0]?.query).toContain("public.companion_runtime_mint_hub_token(");
    expect(result).toEqual({
      token: "cmp_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expiresAt,
    });
  });

  it("claims only lane-aware self-healing material protocol 7 and reads the dedicated MCP broker capability", async () => {
    const sql = new RecordingSql();
    const expiresAt = new Date("2026-08-16T18:00:00.000Z");
    sql.rows = [];
    const store = new PostgresRuntimeStore(sql);

    await store.claimWork({ executorId: "executor-1", limit: 2, leaseSeconds: 30, gateEpoch: 4n });
    expect(sql.calls[0]?.query).toContain("$4::bigint, 7::integer");

    sql.rows = [{ token: `cmp_mcp_${"a".repeat(48)}`, expires_at: expiresAt }];
    await expect(store.mintMcpBrokerToken(fence, 30)).resolves.toEqual({
      token: `cmp_mcp_${"a".repeat(48)}`,
      expiresAt,
    });
    expect(sql.calls[1]?.query).toContain("public.companion_runtime_mint_mcp_broker_token(");

    sql.rows = [{ token: `cmp_ctl_${"b".repeat(48)}`, expires_at: expiresAt }];
    await expect(store.mintControlToken(fence, 30)).resolves.toEqual({
      token: `cmp_ctl_${"b".repeat(48)}`,
      expiresAt,
    });
    expect(sql.calls[2]?.query).toContain("public.companion_runtime_mint_control_token(");
  });

  it("records and publishes material only through the narrow fenced functions", async () => {
    const sql = new RecordingSql();
    const store = new PostgresRuntimeStore(sql);
    const materialExpiresAt = new Date("2026-08-16T18:00:00.000Z");
    sql.rows = [{ recorded: true }];

    await expect(store.recordMaterialSnapshot(fence, {
      clientSurface: "web",
      materialExpiresAt,
      agentEndpoint: { hostedUrl: "https://abc-8790.on.ascii.dev", tokenCiphertext: "ct" },
    })).resolves.toBe(true);
    expect(sql.calls[0]?.query).toContain("public.companion_runtime_record_material_snapshot(");
    expect(sql.calls[0]?.parameters.slice(-4)).toEqual([
      "web",
      materialExpiresAt,
      "https://abc-8790.on.ascii.dev",
      "ct",
    ]);

    sql.rows = [{ published: true }];
    await expect(store.publishMaterialSnapshot(fence, {
      piInvocationId: "pi-new",
    })).resolves.toBe(true);
    expect(sql.calls[1]?.query).toContain("public.companion_runtime_publish_material_snapshot(");
    expect(sql.calls[1]?.parameters.at(-1)).toBe("pi-new");
  });

  it("rejects material whose dispatch-time credential snapshot changed", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ credential_snapshot_matches: false }];
    const store = new PostgresRuntimeStore(sql);

    await expect(store.getMaterial({ ...fence, workKind: "attempt", workId: ATTEMPT_ID }, 30))
      .rejects.toBeInstanceOf(RuntimeCredentialSnapshotChangedError);
  });

  it("reads terminal output proof without fetching credential material", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      checkpoint: "agent_settled",
      event_cursor: "42",
      has_visible_output: true,
      outputs_harvested: false,
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.getAttemptTerminalProjection({
      ...fence,
      workKind: "attempt",
      workId: ATTEMPT_ID,
    });

    expect(result).toEqual({
      checkpoint: "agent_settled",
      eventCursor: 42n,
      hasVisibleOutput: true,
      outputsHarvested: false,
    });
    expect(sql.calls[0]?.query).toContain(
      "public.companion_runtime_get_attempt_terminal_projection(",
    );
    expect(sql.calls[0]?.query).not.toContain("provider_material");
  });

  it("passes structured event batches to postgres.js for one jsonb serialization", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      checkpoint_sequence: "3",
      event_cursor: "10",
      has_visible_output: true,
    }];
    const store = new PostgresRuntimeStore(sql);

    const result = await store.projectEventBatch(
      { ...fence, workKind: "attempt", workId: ATTEMPT_ID },
      {
        expectedSequence: 2n,
        piInvocationId: "pi-invocation-1",
        events: [{
          sequence: 10n,
          type: "assistant",
          entry_key: "assistant:10",
          content: "hello",
        }],
        throughCursor: 10n,
        unknownEventCount: 0,
        malformedEventCount: 0,
        oversizedEventCount: 0,
      },
    );

    expect(result).toEqual({
      checkpointSequence: 3n,
      eventCursor: 10n,
      hasVisibleOutput: true,
      routineReturned: false,
    });
    expect(sql.calls[0]?.parameters[10]).toEqual([{
      sequence: "10",
      type: "assistant",
      entry_key: "assistant:10",
      content: "hello",
    }]);
    expect(Array.isArray(sql.calls[0]?.parameters[10])).toBe(true);
  });

  it("maps a lost response from a mutating definer to an indeterminate outcome", async () => {
    const sql: RuntimeSqlClient = {
      unsafe: async () => {
        throw Object.assign(new Error("connection closed after command"), {
          code: "CONNECTION_CLOSED",
        });
      },
    };
    const store = new PostgresRuntimeStore(sql);

    await expect(store.settle(fence, { terminalStatus: "succeeded" }))
      .rejects.toMatchObject({
        name: "RuntimeStoreIndeterminateError",
        cause: expect.objectContaining({ message: "connection closed after command" }),
      });
  });
});
