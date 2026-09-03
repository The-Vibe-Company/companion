import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerCompanionRoutineDecisionV2,
  claimDueCompanionRoutines,
  createCompanionRoutineV2,
  createCompanionV2,
  deleteCompanionRoutineV2,
  fireCompanionRoutine,
  failCompanionRoutineFire,
  listCompanionRoutinesV2,
  listCompanionRoutineRunsV2,
  getCompanionRoutineRunV2,
  listCompanionsV2,
  readCompanionThreadV2,
  routineFireMessageId,
  saveCompanionProvider,
  setCompanionWorkspaceShareV2,
  updateCompanionRoutineV2,
} from "@companion/core";
import { COMPANION_ROUTINE_MAX_PER_COMPANION } from "@companion/contracts";
import { schema, withTenantContext, type Db } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

/**
 * Routines cross the same Drizzle boundary as every other control-plane write, and the worker
 * carries a claimed instant back through JavaScript before it fences the fire. Only a real database
 * proves the round trip: the raw SQL surface is covered elsewhere, but the parameter binding, the
 * stored precision of `next_fire_at`, and the masked transcript projection are only visible here.
 */
describe("Companion routines over the real database", () => {
  let fixture: IntegrationFixture;
  let companionId: string;
  const masterKey = Buffer.alloc(32, 71);

  async function asActor<T>(actor: TestActor, action: (database: Db) => Promise<T>): Promise<T> {
    return withTenantContext({ orgId: fixture.orgA, userId: actor.id }, action);
  }

  function draft(name: string, cron = "0 9 * * 1-5") {
    return { name, prompt: `Write the ${name} summary.`, cron, timezone: "UTC" };
  }

  async function seedRoutineProposal(input: {
    requestKey: string;
    proposal: {
      kind: "routine";
      name: string;
      prompt: string;
      cron: string;
      timezone: string;
    };
  }): Promise<void> {
    const turnId = randomUUID();
    const attemptId = randomUUID();
    const clientMessageId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const decision = {
      request_id: input.requestKey,
      kind: "routine",
      name: "propose_routine",
      title: `Propose ${input.proposal.name}`,
      detail: "Create or update a scheduled routine.",
      status: "pending",
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: expiresAt.toISOString(),
      proposal: input.proposal,
    };

    await integrationSql`
      insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
      values (${fixture.orgA}::uuid, ${companionId}::uuid, 3, now())
      on conflict (companion_id) do update
      set next_ordinal = greatest(companion_threads.next_ordinal, 3), updated_at = now()
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
        0, 'user', 'Propose a routine', ${fixture.owner.id}
      )
    `;
    await integrationSql`
      insert into companion_turns (
        id, org_id, companion_id, client_message_id, message_event_id,
        queue_sequence, actor_id, client_surface, status,
        inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${turnId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid,
        ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
        ${fixture.owner.id}, 'native_mobile', 'needs_input',
        null, now() + interval '2 hours'
      )
    `;
    await integrationSql`
      insert into companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, provider_credential_refs, selected_skill_ids,
        selected_mcp_account_ids, mcp_credential_refs,
        status, checkpoint, dispatch_state, command_id,
        dispatch_accepted_at, pi_invocation_id, last_activity_at
      ) values (
        ${attemptId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
        1, ${fixture.owner.id}, 1, 1, 1, 'claude-opus-4-8',
        ${JSON.stringify(["anthropic"])}::jsonb,
        ${JSON.stringify([{ provider_id: "anthropic", credential_generation: randomUUID(), credential_version: 1 }])}::jsonb,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'needs_input', 'needs_input', 'accepted', ${randomUUID()}::uuid,
        now(), ${`pi-${attemptId}`}, now()
      )
    `;
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${input.requestKey}, 'routine_proposal', ${expiresAt.toISOString()},
        ${JSON.stringify(input.proposal)}::jsonb
      )
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, decision
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`decision:${input.requestKey}`},
        1, 'decision', ${decision.title}, ${JSON.stringify(decision)}::jsonb
      )
    `;
  }

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "integration-secret",
      masterKey,
      database: integrationDb,
    });
    const companion = await asActor(fixture.owner, (database) => createCompanionV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      name: "Routine runner",
      persona: "Runs scheduled prompts",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }));
    companionId = companion.id;
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("creates, lists, updates, and deletes a routine through the ordinary tenant boundary", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    expect(created).toMatchObject({ name: "Daily standup", enabled: true, timezone: "UTC" });
    // A schedule that never crosses the boundary intact is the failure this suite exists for.
    expect(created.next_fire_at).not.toBeNull();
    expect(new Date(created.next_fire_at!).getTime()).toBeGreaterThan(Date.now());

    const listed = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(listed).toEqual([created]);

    const disabled = await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      enabled: false,
      database,
    }));
    expect(disabled).toMatchObject({ enabled: false, next_fire_at: null });

    const reenabled = await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      cron: "*/30 * * * *",
      enabled: true,
      database,
    }));
    expect(reenabled.cron).toBe("*/30 * * * *");
    expect(reenabled.next_fire_at).not.toBeNull();

    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));
    await expect(asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }))).resolves.toEqual([]);
  });

  it("approves a same-name proposal in place, resets failures, and returns the routine", async () => {
    const existing = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    const previousNextFireAt = existing.next_fire_at;
    await integrationDb
      .update(schema.companionRoutines)
      .set({
        lastErrorCode: "fire_failed",
        lastErrorMessage: "The previous run failed.",
        lastErrorAt: new Date(),
        consecutiveFailures: 4,
        nextFireAt: new Date(Date.now() - 1_000),
      })
      .where(eq(schema.companionRoutines.id, existing.id));
    const staleWorkerId = "routine-proposal-stale-worker";
    const [staleClaim] = await claimDueCompanionRoutines({
      workerId: staleWorkerId,
      database: integrationDb,
    });
    expect(staleClaim?.routineId).toBe(existing.id);
    const proposal = {
      kind: "routine" as const,
      name: "daily STANDUP",
      prompt: "Write the revised standup.",
      cron: "30 10 * * 1-5",
      timezone: "America/New_York",
    };
    const requestKey = randomUUID();
    await seedRoutineProposal({ requestKey, proposal });

    const approved = await asActor(fixture.owner, (database) =>
      answerCompanionRoutineDecisionV2({
        orgId: fixture.orgA,
        companionId,
        requestId: requestKey,
        decision: "allow",
        database,
      }));

    expect(approved).toMatchObject({
      id: existing.id,
      name: existing.name,
      prompt: proposal.prompt,
      cron: proposal.cron,
      timezone: proposal.timezone,
      enabled: true,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
    });
    expect(approved?.next_fire_at).not.toBe(previousNextFireAt);
    expect(new Date(approved!.next_fire_at!).getTime()).toBeGreaterThan(Date.now());

    const [claimState] = await integrationDb
      .select({
        claimedBy: schema.companionRoutines.claimedBy,
        leaseExpiresAt: schema.companionRoutines.leaseExpiresAt,
      })
      .from(schema.companionRoutines)
      .where(eq(schema.companionRoutines.id, existing.id));
    expect(claimState).toEqual({ claimedBy: null, leaseExpiresAt: null });

    await failCompanionRoutineFire({
      workerId: staleWorkerId,
      orgId: fixture.orgA,
      routineId: existing.id,
      errorCode: "fire_failed",
      errorMessage: "The stale worker must not settle.",
      nextFireAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      database: integrationDb,
    });

    const routines = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({
      id: existing.id,
      prompt: proposal.prompt,
      next_fire_at: approved!.next_fire_at,
      last_error_code: null,
      consecutive_failures: 0,
    });
    const [audit] = await integrationSql<{ action: string; target_id: string; mode: string }[]>`
      select action, target_id, metadata ->> 'mode' as mode
      from audit_log
      where org_id = ${fixture.orgA}::uuid
        and target_type = 'companion_routine'
        and target_id = ${existing.id}
        and action = 'companion.routine.proposal.approved'
      order by created_at desc
      limit 1
    `;
    expect(audit).toEqual({
      action: "companion.routine.proposal.approved",
      target_id: existing.id,
      mode: "updated",
    });
  });

  it("creates a fresh routine when the proposed same-name routine was deleted", async () => {
    const existing = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    const proposal = {
      kind: "routine" as const,
      name: "Daily standup",
      prompt: "Write a fresh standup.",
      cron: "45 11 * * 1-5",
      timezone: "UTC",
    };
    const requestKey = randomUUID();
    await seedRoutineProposal({ requestKey, proposal });
    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: existing.id,
      database,
    }));

    const approved = await asActor(fixture.owner, (database) =>
      answerCompanionRoutineDecisionV2({
        orgId: fixture.orgA,
        companionId,
        requestId: requestKey,
        decision: "allow",
        database,
      }));

    expect(approved).toMatchObject({
      prompt: proposal.prompt,
      cron: proposal.cron,
      timezone: proposal.timezone,
      enabled: true,
    });
    expect(approved?.id).toEqual(expect.any(String));
    expect(approved?.id).not.toBe(existing.id);
    await expect(asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }))).resolves.toEqual([approved]);
  });

  it("refuses an unschedulable cadence, a Viewer write, an outsider, and the eleventh routine", async () => {
    await expect(asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Too eager", "* * * * *"),
      database,
    }))).rejects.toMatchObject({ code: "interval_too_short" });
    await expect(asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Nowhere", "0 9 * * 1-5"),
      timezone: "Mars/Olympus",
      database,
    }))).rejects.toMatchObject({ code: "invalid_timezone" });

    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));
    await expect(asActor(fixture.developer, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Viewer routine"),
      database,
    }))).rejects.toThrow();
    await expect(withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => listCompanionRoutinesV2({ orgId: fixture.orgB, companionId, database }),
    )).rejects.toThrow();

    for (let index = 0; index < COMPANION_ROUTINE_MAX_PER_COMPANION; index += 1) {
      await asActor(fixture.owner, (database) => createCompanionRoutineV2({
        orgId: fixture.orgA,
        companionId,
        ...draft(`Routine ${index}`),
        database,
      }));
    }
    await expect(asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("One too many"),
      database,
    }))).rejects.toThrow();
  });

  it("claims a due routine, fires it once as the Owner, and hides the prompt behind its name", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));

    const claimed = await claimDueCompanionRoutines({
      workerId: "integration-routine-worker",
      database: integrationDb,
    });
    const claim = claimed.find((entry) => entry.routineId === created.id);
    expect(claim).toMatchObject({ orgId: fixture.orgA, companionId, name: "Daily standup" });

    const clientMessageId = routineFireMessageId({
      routineId: claim!.routineId,
      scheduledFor: claim!.scheduledFor,
    });
    const fired = await fireCompanionRoutine({
      workerId: "integration-routine-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId,
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    expect(fired).toEqual({ outcome: "fired", replayed: false });

    const thread = await asActor(fixture.owner, (database) => readCompanionThreadV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(thread.entries.some((candidate) => candidate.routine !== null)).toBe(false);
    expect(JSON.stringify(thread.entries)).not.toContain("Write the Daily standup summary.");
    const [run] = await integrationSql<Array<{ turnId: string; actorId: string; prompt: string }>>`
      select turn_row.id::text as "turnId",turn_row.actor_id as "actorId",run.prompt
      from companion_v3_routine_runs run join companion_v3_turns turn_row on turn_row.id=run.turn_id
      where run.routine_id=${created.id}::uuid
    `;
    expect(run).toEqual({
      turnId: expect.any(String), actorId: fixture.owner.id,
      prompt: "Write the Daily standup summary.",
    });

    // The conversation list is read by everyone who can see the Companion, and the fire is recorded
    // as the Owner. Leaking the prompt there would read as something the Owner just typed.
    const [listed] = await asActor(fixture.owner, (database) => listCompanionsV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      database,
    }));
    expect(JSON.stringify(listed!.last_message)).not.toContain("Write the Daily standup summary.");

    const [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({ consecutive_failures: 0, last_error_code: null });
    expect(after!.last_fired_at).not.toBeNull();
  });

  it("records a classified fire failure without persisting a provider payload", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Flaky"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    await claimDueCompanionRoutines({
      workerId: "integration-routine-worker",
      database: integrationDb,
    });

    await failCompanionRoutineFire({
      workerId: "integration-routine-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      errorCode: "fire_failed",
      errorMessage: "Companion routine fire failed",
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });

    const [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({
      last_error_code: "fire_failed",
      last_error_message: "Companion routine fire failed",
      consecutive_failures: 1,
      enabled: true,
    });
  });

  it("atomically cancels queued routine turns on disable and delete, and rolls back the purge", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Queue cleanup"),
      database,
    }));

    const fireQueued = async (workerId: string): Promise<string> => {
      await integrationDb
        .update(schema.companionRoutines)
        .set({ nextFireAt: new Date() })
        .where(eq(schema.companionRoutines.id, created.id));
      const [claim] = await claimDueCompanionRoutines({ workerId, database: integrationDb });
      if (!claim) throw new Error("expected the queue cleanup routine to become due");
      await fireCompanionRoutine({
        workerId,
        orgId: fixture.orgA,
        routineId: created.id,
        clientMessageId: routineFireMessageId({ routineId: created.id, scheduledFor: claim.scheduledFor }),
        scheduledFor: claim.scheduledFor,
        nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
        database: integrationDb,
      });
      const [turn] = await integrationDb
        .select({ id: schema.companionV3Turns.id })
        .from(schema.companionV3Turns)
        .innerJoin(schema.companionV3RoutineRuns, and(
          eq(schema.companionV3RoutineRuns.orgId, schema.companionV3Turns.orgId),
          eq(schema.companionV3RoutineRuns.companionId, schema.companionV3Turns.companionId),
          eq(schema.companionV3RoutineRuns.turnId, schema.companionV3Turns.id),
        ))
        .where(and(
          eq(schema.companionV3RoutineRuns.routineSnapshotId, created.id),
          eq(schema.companionV3Turns.state, "queued"),
        ))
        .orderBy(desc(schema.companionV3Turns.createdAt), desc(schema.companionV3Turns.id));
      if (!turn) throw new Error("expected a queued routine turn");
      return turn.id;
    };

    const disabledTurnId = await fireQueued("integration-routine-disable-cleanup");
    await expect(integrationSql.begin(async (tx) => {
      await tx`
        update companion_routines
        set enabled = false, next_fire_at = null
        where id = ${created.id}::uuid
      `;
      throw new Error("rollback routine disable");
    })).rejects.toThrow("rollback routine disable");

    const [afterRollback] = await integrationSql<Array<{ enabled: boolean }>>`
      select enabled from companion_routines where id = ${created.id}::uuid
    `;
    expect(afterRollback).toEqual({ enabled: true });
    const [queuedAfterRollback] = await integrationSql<Array<{ state: string; outcome: string }>>`
      select turn_row.state::text as state, run.outcome
      from companion_v3_turns turn_row join companion_v3_routine_runs run on run.turn_id=turn_row.id
      where turn_row.id = ${disabledTurnId}::uuid
    `;
    expect(queuedAfterRollback).toEqual({ state: "queued", outcome: "pending" });
    const startAfterRollback = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_operations
      where source_turn_id = ${disabledTurnId}::uuid and kind = 'start'
    `;
    expect(startAfterRollback).toEqual([]);

    await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      enabled: false,
      database,
    }));
    const [disabledTurn] = await integrationSql<Array<{
      state: string;
      turnOutcome: string | null;
      runOutcome: string;
    }>>`
      select turn_row.state::text as state,turn_row.outcome::text as "turnOutcome",
        run.outcome as "runOutcome"
      from companion_v3_turns turn_row join companion_v3_routine_runs run on run.turn_id=turn_row.id
      where turn_row.id = ${disabledTurnId}::uuid
    `;
    expect(disabledTurn).toEqual({
      state: "cancelled",
      turnOutcome: "cancelled",
      runOutcome: "cancelled",
    });
    const disabledStart = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_operations
      where source_turn_id = ${disabledTurnId}::uuid and kind = 'start'
    `;
    expect(disabledStart).toEqual([]);
    const [disabledRoutine] = await integrationDb
      .select({ failures: schema.companionRoutines.consecutiveFailures })
      .from(schema.companionRoutines)
      .where(eq(schema.companionRoutines.id, created.id));
    expect(disabledRoutine?.failures).toBe(0);

    await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      enabled: true,
      database,
    }));
    const deletedTurnId = await fireQueued("integration-routine-delete-cleanup");
    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));

    const [deletedTurn] = await integrationSql<Array<{
      state: string;
      routineId: string | null;
      routineName: string | null;
      turnOutcome: string | null;
      runOutcome: string;
    }>>`
      select turn_row.state::text as state,run.routine_id::text as "routineId",
        run.routine_name as "routineName",turn_row.outcome::text as "turnOutcome",
        run.outcome as "runOutcome"
      from companion_v3_turns turn_row join companion_v3_routine_runs run on run.turn_id=turn_row.id
      where turn_row.id = ${deletedTurnId}::uuid
    `;
    expect(deletedTurn).toEqual({
      state: "cancelled",
      routineId: null,
      routineName: "Queue cleanup",
      turnOutcome: "cancelled",
      runOutcome: "cancelled",
    });
    const deletedStart = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_operations
      where source_turn_id = ${deletedTurnId}::uuid and kind = 'start'
    `;
    expect(deletedStart).toEqual([]);
  });

  it("keeps cancellations and execution failures in history without auto-disabling the routine", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Failure accounting"),
      database,
    }));
    let fireIndex = 0;
    const fireNextRun = async (): Promise<string> => {
      await integrationDb
        .update(schema.companionRoutines)
        .set({ nextFireAt: new Date() })
        .where(eq(schema.companionRoutines.id, created.id));
      const workerId = `integration-routine-outcome-${fireIndex++}`;
      const claimed = await claimDueCompanionRoutines({ workerId, database: integrationDb });
      const claim = claimed.find((entry) => entry.routineId === created.id);
      if (!claim) throw new Error("expected the routine outcome fixture to be due");
      const clientMessageId = routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim.scheduledFor,
      });
      await fireCompanionRoutine({
        workerId,
        orgId: fixture.orgA,
        routineId: created.id,
        clientMessageId,
        scheduledFor: claim.scheduledFor,
        nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
        database: integrationDb,
      });
      const run = await integrationDb.query.companionV3Turns.findFirst({
        where: eq(schema.companionV3Turns.clientMessageId, clientMessageId),
      });
      if (!run) throw new Error("expected a fired routine run");
      return run.id;
    };
    const settleRun = async (
      runId: string,
      outcome: "failed" | "interrupted",
      errorCode: string,
      errorMessage: string,
    ) => {
      await integrationSql.begin(async (tx) => {
        await tx`
          update companion_v3_turns set state=${outcome}::companion_v3_turn_state,
            outcome=${outcome}::companion_v3_turn_outcome,outcome_code=${errorCode},
            outcome_message=${errorMessage},outcome_action='none',settled_at=now(),updated_at=now()
          where id=${runId}::uuid
        `;
        await tx`
          update companion_v3_routine_runs set outcome=${outcome},settled_at=now()
          where turn_id=${runId}::uuid
        `;
      });
    };
    const settleNextRun = async (
      outcome: "failed" | "interrupted",
      errorCode: string,
      errorMessage: string,
    ) => {
      await settleRun(await fireNextRun(), outcome, errorCode, errorMessage);
    };

    for (let index = 0; index < 5; index += 1) {
      await settleNextRun(
        "interrupted",
        "routine_session_cancelled",
        "Routine Pi session was cancelled before launch.",
      );
    }
    let [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({ consecutive_failures: 0, enabled: true });

    for (let index = 0; index < 5; index += 1) {
      await settleNextRun("failed", "provider_unavailable", "The routine provider is unavailable.");
    }
    [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({
      enabled: true,
    });
    const [history] = await integrationSql<Array<{
      failed: number;
      interrupted: number;
    }>>`
      select count(*) filter(where outcome='failed')::integer as failed,
        count(*) filter(where outcome='interrupted')::integer as interrupted
      from companion_v3_routine_runs where routine_snapshot_id=${created.id}::uuid
    `;
    expect(history).toEqual({ failed: 5, interrupted: 5 });
  });

  it("does not apply an old run outcome to a recreated routine generation", async () => {
    const routineId = randomUUID();
    await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      id: routineId,
      ...draft("Original generation"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, routineId));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-generation",
      database: integrationDb,
    });
    if (!claim) throw new Error("expected the original routine generation to be due");
    await fireCompanionRoutine({
      workerId: "integration-routine-generation",
      orgId: fixture.orgA,
      routineId,
      clientMessageId: routineFireMessageId({ routineId, scheduledFor: claim.scheduledFor }),
      scheduledFor: claim.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    const oldRun = await integrationDb.query.companionV3RoutineRuns.findFirst({
      where: eq(schema.companionV3RoutineRuns.routineSnapshotId, routineId),
      orderBy: (run, { desc }) => [desc(run.createdAt), desc(run.turnId)],
    });
    if (!oldRun) throw new Error("expected the original routine run");

    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId,
      database,
    }));
    await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      id: routineId,
      ...draft("Replacement generation"),
      database,
    }));

    await integrationSql.begin(async (tx) => {
      await tx`
        update companion_v3_turns set state='failed',outcome='failed',
          outcome_code='provider_unavailable',
          outcome_message='The old routine provider was unavailable.',outcome_action='none',
          settled_at=now(),updated_at=now() where id=${oldRun.turnId}::uuid
      `;
      await tx`
        update companion_v3_routine_runs set outcome='failed',settled_at=now()
        where turn_id=${oldRun.turnId}::uuid
      `;
    });

    const [replacement] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(replacement).toMatchObject({
      id: routineId,
      name: "Replacement generation",
      consecutive_failures: 0,
      enabled: true,
      last_error_code: null,
    });
  });

  it("keeps private run history tenant-scoped and references one notify payload in the main thread", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Deployment check"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-history-worker",
      database: integrationDb,
    });
    expect(claim?.routineId).toBe(created.id);
    await fireCompanionRoutine({
      workerId: "integration-routine-history-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim!.scheduledFor,
      }),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });

    const [run] = await integrationDb
      .select({ id: schema.companionV3RoutineRuns.turnId })
      .from(schema.companionV3RoutineRuns)
      .where(eq(schema.companionV3RoutineRuns.routineSnapshotId, created.id));
    expect(run).toBeDefined();

    await integrationDb.insert(schema.companionV3RoutineRunEntries).values([
      {
        orgId: fixture.orgA,
        companionId,
        runId: run!.id,
        eventId: "routine:work:1",
        ordinal: 0,
        role: "assistant",
        content: "Inspected the deployment before returning.",
      },
      {
        orgId: fixture.orgA,
        companionId,
        runId: run!.id,
        eventId: "routine:work:2",
        ordinal: 1,
        role: "assistant",
        content: "Prepared the terminal notification.",
      },
    ]);
    const mainEntryEventId = `routine-return:${run!.id}`;
    await integrationSql.begin(async (tx) => {
      await tx`
        insert into companion_threads(org_id,companion_id,next_ordinal,last_message_at)
        values(${fixture.orgA}::uuid,${companionId}::uuid,1,now())
        on conflict(companion_id) do update set next_ordinal=companion_threads.next_ordinal+1,
          last_message_at=now(),updated_at=now()
      `;
      const [thread] = await tx<Array<{ ordinal: number }>>`
        select next_ordinal-1 as ordinal from companion_threads
        where companion_id=${companionId}::uuid
      `;
      await tx`
        insert into companion_transcript_entries(
          org_id,companion_id,event_id,ordinal,role,content)
        values(${fixture.orgA}::uuid,${companionId}::uuid,${mainEntryEventId},
          ${thread!.ordinal},'assistant','The deployment is healthy.')
      `;
      await tx`
        update companion_v3_turns set state='succeeded',outcome='succeeded',settled_at=now(),
          updated_at=now() where id=${run!.id}::uuid
      `;
      await tx`
        update companion_v3_routine_runs set outcome='notify',surface_mode='notify',
          main_entry_event_id=${mainEntryEventId},next_ordinal=2,settled_at=now()
        where turn_id=${run!.id}::uuid
      `;
    });

    const projectedThread = await asActor(fixture.owner, (database) => readCompanionThreadV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(projectedThread.entries.map((entry) => entry.event_id)).toEqual([
      mainEntryEventId,
    ]);
    expect(JSON.stringify(projectedThread.entries)).not.toContain("Inspected the deployment");
    expect(JSON.stringify(projectedThread.entries)).not.toContain("This later call must not win.");

    await integrationSql`
      update companion_v3_turns set state='failed',outcome='failed',
        outcome_code='provider_unavailable',
        outcome_message='Reconnect the routine provider credential.',
        outcome_action='reconnect_provider',updated_at=now() where id=${run!.id}::uuid
    `;
    const ownerDetail = await asActor(fixture.owner, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      database,
    }));
    expect(ownerDetail.error).toEqual({
      code: "provider_unavailable",
      message: "Reconnect the routine provider credential.",
      action: "reconnect_provider",
    });

    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));
    const viewerHistory = await asActor(fixture.developer, (database) =>
      listCompanionRoutineRunsV2({
        orgId: fixture.orgA,
        companionId,
        routineId: created.id,
        database,
      }));
    expect(viewerHistory).toMatchObject({ next_cursor: null });
    expect(viewerHistory.runs).toHaveLength(1);
    expect(viewerHistory.runs[0]).toMatchObject({
      run_id: run!.id,
      outcome: "surfaced",
      surface_mode: "notify",
      main_entry_event_id: mainEntryEventId,
      relay_turn_id: null,
    });
    const detail = await asActor(fixture.developer, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      entryLimit: 1,
      database,
    }));
    expect(detail.internal_entries).toEqual([expect.objectContaining({
      event_id: "routine:work:1",
      content: "Inspected the deployment before returning.",
    })]);
    expect(detail.next_entry_cursor).toBe(0);
    const secondPage = await asActor(fixture.developer, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      entryLimit: 1,
      entryCursor: detail.next_entry_cursor ?? undefined,
      database,
    }));
    expect(secondPage.internal_entries).toEqual([expect.objectContaining({
      event_id: "routine:work:2",
      content: "Prepared the terminal notification.",
    })]);
    expect(secondPage.next_entry_cursor).toBeNull();
    expect(detail.error).toEqual({
      code: "runtime_unavailable",
      message: "Companion runtime needs attention.",
      action: "none",
    });
    expect(JSON.stringify(detail)).not.toContain("The deployment is healthy.");

    await expect(withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => getCompanionRoutineRunV2({
        orgId: fixture.orgB,
        companionId,
        runId: run!.id,
        database,
      }),
    )).rejects.toThrow();

    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));
    await expect(asActor(fixture.developer, (database) => listCompanionRoutineRunsV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }))).resolves.toMatchObject({ runs: [expect.objectContaining({ run_id: run!.id })] });
  });

  it("projects an additive-rollout main-session reply as a virtual notify result", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Legacy compatibility"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-legacy-worker",
      database: integrationDb,
    });
    await fireCompanionRoutine({
      workerId: "integration-routine-legacy-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim!.scheduledFor,
      }),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });

    const legacyRows = await integrationSql.begin(async (tx) => {
      await tx`select set_config('app.org_id',${fixture.orgA},true),
        set_config('app.user_id',${fixture.owner.id},true)`;
      return tx<Array<{ turn: { id: string } }>>`
        select turn from companion_api_enqueue_turn(
          ${fixture.orgA}::uuid,${companionId}::uuid,${randomUUID()}::uuid,
          'Legacy routine prompt','web','[]'::jsonb,${created.id}::uuid,'Legacy compatibility')
      `;
    });
    const run = { id: legacyRows[0]!.turn.id };
    const marker = await integrationDb.query.companionTranscriptEntries.findFirst({
      where: eq(schema.companionTranscriptEntries.turnId, run!.id),
    });
    const legacyReplyEventId = `v2:legacy:${run!.id}:assistant`;
    await integrationDb.insert(schema.companionTranscriptEntries).values({
      orgId: fixture.orgA,
      companionId,
      turnId: run!.id,
      eventId: legacyReplyEventId,
      ordinal: (marker?.ordinal ?? 0) + 1,
      role: "assistant",
      content: "This reply was produced by the pre-cutover main Pi session.",
    });
    await integrationDb
      .update(schema.companionTurns)
      .set({
        status: "succeeded",
        inactivityDeadlineAt: null,
        absoluteDeadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        settledAt: new Date(),
      })
      .where(eq(schema.companionTurns.id, run!.id));

    const history = await asActor(fixture.owner, (database) => listCompanionRoutineRunsV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));
    expect(history.runs).toEqual(expect.arrayContaining([expect.objectContaining({
      run_id: run!.id,
      status: "succeeded",
      outcome: "surfaced",
      surface_mode: "notify",
      main_entry_event_id: legacyReplyEventId,
      relay_turn_id: null,
    })]));
    const detail = await asActor(fixture.owner, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      database,
    }));
    expect(detail.internal_entries).toEqual([expect.objectContaining({
      event_id: marker!.eventId,
      role: "user",
    })]);
    expect(JSON.stringify(detail.internal_entries)).not.toContain(
      "This reply was produced by the pre-cutover main Pi session.",
    );
  });

  it("references a hidden ordinary turn for relay without projecting its synthetic prompt", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Relay check"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-relay-worker",
      database: integrationDb,
    });
    await fireCompanionRoutine({
      workerId: "integration-routine-relay-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim!.scheduledFor,
      }),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    const [run] = await integrationDb
      .select({ id: schema.companionV3RoutineRuns.turnId })
      .from(schema.companionV3RoutineRuns)
      .where(eq(schema.companionV3RoutineRuns.routineSnapshotId, created.id));
    const relayClientMessageId = randomUUID();
    const mainEntryEventId = `routine-return:${run!.id}`;
    const [relay] = await integrationSql.begin(async (tx) => {
      const admitted = await tx<Array<{ turnId: string }>>`
        select turn_id::text as "turnId" from companion_v3_admit_turn(
          ${fixture.orgA}::uuid,${companionId}::uuid,${relayClientMessageId}::uuid,
          ${`msg:${relayClientMessageId}`},${fixture.owner.id},'main')
      `;
      await tx`
        update companion_v3_turns set routine_relay_source_event_id=${mainEntryEventId}
        where id=${admitted[0]!.turnId}::uuid
      `;
      await tx`
        insert into companion_threads(org_id,companion_id,next_ordinal,last_message_at)
        values(${fixture.orgA}::uuid,${companionId}::uuid,1,now())
        on conflict(companion_id) do update set next_ordinal=companion_threads.next_ordinal+1,
          last_message_at=now(),updated_at=now()
      `;
      const [thread] = await tx<Array<{ ordinal: number }>>`
        select next_ordinal-1 as ordinal from companion_threads where companion_id=${companionId}::uuid
      `;
      await tx`
        insert into companion_transcript_entries(org_id,companion_id,event_id,ordinal,role,content)
        values(${fixture.orgA}::uuid,${companionId}::uuid,${mainEntryEventId},${thread!.ordinal},
          'assistant','Please explain the failed deployment.')
      `;
      await tx`
        update companion_v3_turns set state='succeeded',outcome='succeeded',settled_at=now(),updated_at=now()
        where id=${run!.id}::uuid
      `;
      await tx`
        update companion_v3_routine_runs set outcome='relay',surface_mode='relay',
          main_entry_event_id=${mainEntryEventId},relay_turn_id=${admitted[0]!.turnId}::uuid,settled_at=now()
        where turn_id=${run!.id}::uuid
      `;
      return admitted;
    });
    const relayTurn = await integrationDb.query.companionV3Turns.findFirst({
      where: eq(schema.companionV3Turns.id, relay!.turnId),
    });
    expect(relayTurn).toMatchObject({
      routineRelaySourceEventId: `routine-return:${run!.id}`,
      state: "queued",
    });

    const projectedThread = await asActor(fixture.owner, (database) => readCompanionThreadV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    const serialized = JSON.stringify(projectedThread.entries);
    expect(serialized).toContain("Please explain the failed deployment.");
    expect(serialized).not.toContain("Respond to the surfaced routine entry");
    expect(projectedThread.entries.filter((entry) =>
      entry.content === "Please explain the failed deployment.")).toHaveLength(1);
  });

  it("keeps a claimed instant comparable after the worker's JavaScript round trip", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Precision"),
      database,
    }));
    // PostgreSQL now() carries microseconds while the column keeps milliseconds. Keep the instant
    // unambiguously due as well, so a fast transaction boundary cannot make this precision test
    // depend on the wall clock advancing before the worker claim.
    await integrationSql`
      update companion_routines set next_fire_at = now() - interval '1 second'
      where id = ${created.id}::uuid
    `;
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-worker",
      database: integrationDb,
    });
    const stored = await integrationDb.query.companionRoutines.findFirst({
      where: eq(schema.companionRoutines.id, created.id),
    });
    expect(claim!.scheduledFor.getTime()).toBe(stored!.nextFireAt!.getTime());

    const fired = await fireCompanionRoutine({
      workerId: "integration-routine-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: randomUUID(),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    expect(fired.outcome).toBe("fired");
  });

  it("denies an expired routine proposal without creating a routine", async () => {
    const turnId = randomUUID();
    const attemptId = randomUUID();
    const clientMessageId = randomUUID();
    const requestKey = randomUUID();
    // A poll/runtime sweep can lag the wall-clock deadline, leaving an expired card visibly
    // pending for a short window. Explicit denial is still fail-closed and must win that race.
    const expiresAt = new Date(Date.now() - 60_000);
    const proposal = {
      kind: "routine",
      name: "conductor-progress-check",
      prompt: "Check every active Conductor workspace and report its progress.",
      cron: "*/30 * * * *",
      timezone: "Europe/Paris",
    };

    await integrationSql`
      insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
      values (${fixture.orgA}::uuid, ${companionId}::uuid, 2, now())
      on conflict (companion_id) do update
      set next_ordinal = 2, updated_at = now()
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
        0, 'user', 'Propose a Conductor progress routine', ${fixture.owner.id}
      )
    `;
    await integrationSql`
      insert into companion_turns (
        id, org_id, companion_id, client_message_id, message_event_id,
        queue_sequence, actor_id, client_surface, status,
        inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${turnId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid,
        ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
        ${fixture.owner.id}, 'native_mobile', 'needs_input',
        null, now() + interval '2 hours'
      )
    `;
    await integrationSql`
      insert into companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, provider_credential_refs, selected_skill_ids,
        selected_mcp_account_ids, mcp_credential_refs,
        status, checkpoint, dispatch_state, command_id,
        dispatch_accepted_at, pi_invocation_id, last_activity_at
      ) values (
        ${attemptId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
        1, ${fixture.owner.id}, 1, 1, 1, 'claude-opus-4-8',
        ${JSON.stringify(["anthropic"])}::jsonb,
        ${JSON.stringify([{ provider_id: "anthropic", credential_generation: randomUUID(), credential_version: 1 }])}::jsonb,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'needs_input', 'needs_input', 'accepted', ${randomUUID()}::uuid,
        now(), ${`pi-${attemptId}`}, now()
      )
    `;
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${requestKey}, 'routine_proposal', ${expiresAt.toISOString()},
        ${JSON.stringify(proposal)}::jsonb
      )
    `;
    const decision = {
      request_id: requestKey,
      kind: "routine",
      name: "propose_routine",
      title: "Check every Conductor workspace every 30 minutes",
      detail: "Monitor all active Conductor workspaces.",
      status: "pending",
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: expiresAt.toISOString(),
      proposal,
    };
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, decision
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`decision:${requestKey}`},
        1, 'decision', ${decision.title}, ${JSON.stringify(decision)}::jsonb
      )
    `;

    await asActor(fixture.owner, (database) => answerCompanionRoutineDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: requestKey,
      decision: "deny",
      database,
    }));

    // The runtime expiry sweep may win the row lock after the HTTP preflight saw `pending` but
    // before this answer function selects it. Deny treats that actorless terminal row as the same
    // fail-closed outcome instead of returning a conflict.
    const sweptRequestKey = randomUUID();
    const sweptAt = new Date();
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, decision_status, responded_at, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${sweptRequestKey}, 'routine_proposal', 'expired', ${sweptAt.toISOString()},
        ${expiresAt.toISOString()}, ${JSON.stringify(proposal)}::jsonb
      )
    `;
    await asActor(fixture.owner, (database) => answerCompanionRoutineDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: sweptRequestKey,
      decision: "deny",
      database,
    }));

    // The exception is deliberately one-way: expiry can never be bypassed to create a routine.
    const expiredAllowRequestKey = randomUUID();
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${expiredAllowRequestKey}, 'routine_proposal', ${expiresAt.toISOString()},
        ${JSON.stringify(proposal)}::jsonb
      )
    `;
    await expect(asActor(fixture.owner, (database) => answerCompanionRoutineDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: expiredAllowRequestKey,
      decision: "allow",
      database,
    }))).rejects.toMatchObject({
      code: "routine_update_failed",
      httpStatus: 409,
      message: "Unable to apply the routine proposal. Please try again.",
    });

    await expect(asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }))).resolves.toEqual([]);
    const [delivery] = await integrationDb
      .select({ decisionStatus: schema.companionDecisionDeliveries.decisionStatus })
      .from(schema.companionDecisionDeliveries)
      .where(eq(schema.companionDecisionDeliveries.requestKey, requestKey));
    expect(delivery).toEqual({ decisionStatus: "denied" });
    const [entry] = await integrationDb
      .select({ decision: schema.companionTranscriptEntries.decision })
      .from(schema.companionTranscriptEntries)
      .where(eq(schema.companionTranscriptEntries.eventId, `decision:${requestKey}`));
    expect(entry?.decision).toMatchObject({ status: "denied", decided_by_id: fixture.owner.id });
    const [swept] = await integrationDb
      .select({ decisionStatus: schema.companionDecisionDeliveries.decisionStatus })
      .from(schema.companionDecisionDeliveries)
      .where(eq(schema.companionDecisionDeliveries.requestKey, sweptRequestKey));
    expect(swept).toEqual({ decisionStatus: "expired" });
  });
});
