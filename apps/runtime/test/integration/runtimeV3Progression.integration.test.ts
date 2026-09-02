/**
 * Product promise: Runtime v3 keeps FIFO, lane independence, and executor fencing as PostgreSQL
 * facts while callers use the closed TypeScript progression interface. The v2 executor and direct
 * process-role table access cannot bypass the Runtime v3 capability surface.
 *
 * Why integrated: FORCE RLS, split grants, SKIP LOCKED, and monotonic takeover epochs only exist in
 * a real migrated PostgreSQL database. An in-memory adapter cannot prove them.
 * Sensitivity: removing org scoping, fencing, split grants, or either independent lane loop makes
 * a named assertion fail; replacing PostgreSQL with an in-memory fake invalidates the suite.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createRuntimeV3Convergence,
  createRuntimeV3WarmTurnAdvance,
} from "@companion/companion-runtime/v3/internal";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeV3PostgresConvergence,
  createRuntimeV3PostgresWarmConvergence,
  createRuntimeV3PostgresWarmTurnPersistence,
} from "../../src/runtimeV3ProgressionStore";

const ownerUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const apiUrl = process.env.DATABASE_API_URL;
const workerUrl = process.env.DATABASE_WORKER_URL;
const runtimeUrl = process.env.DATABASE_COMPANION_RUNTIME_URL;
if (!ownerUrl?.trim() || !apiUrl?.trim() || !workerUrl?.trim() || !runtimeUrl?.trim()) {
  throw new Error("Runtime v3 integration test requires migration, API, worker, and runtime database URLs");
}

const ownerSql = postgres(ownerUrl, { max: 2 });
const apiSql = postgres(apiUrl, { max: 2 });
const workerSql = postgres(workerUrl, { max: 2 });
const runtimeSql = postgres(runtimeUrl, { max: 3 });
let apiRole = "";
let workerRole = "";
let runtimeRole = "";
let originalRuntimeGate: {
  enabled: boolean;
  enabledAt: Date | null;
  disabledAt: Date | null;
} | undefined;
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const ids = {
  org: randomUUID(),
  owner: `runtime-v3-owner-${suffix}`,
  editor: `runtime-v3-editor-${suffix}`,
  outsider: `runtime-v3-outsider-${suffix}`,
  companion: randomUUID(),
};

async function asApiActor(
  orgId: string,
  userId: string,
  query: (sql: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  await apiSql.begin(async (sql) => {
    await sql`select set_config('app.org_id', ${orgId}, true)`;
    await sql`select set_config('app.user_id', ${userId}, true)`;
    await query(sql);
  });
}

async function asApi(query: (sql: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await asApiActor(ids.org, ids.owner, query);
}

async function admitMain(commandId: string): Promise<void> {
  await asApi(async (sql) => {
    await sql`select * from public.companion_v3_api_admit_turn(
      ${ids.org}::uuid, ${ids.companion}::uuid, ${commandId}::uuid,
      ${`msg:${commandId}`}
    )`;
  });
}

describe("Runtime v3 progression facts", () => {
  beforeAll(async () => {
    const [apiRows, workerRows, runtimeRows] = await Promise.all([
      apiSql<Array<{ currentUser: string }>>`select current_user as "currentUser"`,
      workerSql<Array<{ currentUser: string }>>`select current_user as "currentUser"`,
      runtimeSql<Array<{ currentUser: string }>>`select current_user as "currentUser"`,
    ]);
    apiRole = apiRows[0]!.currentUser;
    workerRole = workerRows[0]!.currentUser;
    runtimeRole = runtimeRows[0]!.currentUser;
    // The preceding Runtime v2 grant tests intentionally scrub every non-fixture grantee from
    // the shared disposable database. Reapply the production capability hook so this suite is
    // order-independent and proves the real API/worker/runtime roles used below.
    const grantsSource = await readFile(fileURLToPath(
      new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
    ), "utf8");
    const beginMarker = "-- companion-runtime-grants-begin";
    const endMarker = "-- companion-runtime-grants-end";
    const begin = grantsSource.indexOf(beginMarker);
    const end = grantsSource.indexOf(endMarker);
    if (begin < 0 || end <= begin) throw new Error("runtime grant hook markers are missing");
    await ownerSql`select
      set_config('companion.api_role', ${apiRole}, false),
      set_config('companion.worker_role', ${workerRole}, false),
      set_config('companion.companion_runtime_role', ${runtimeRole}, false),
      set_config('companion.retired_runtime_role', '', false)`;
    await ownerSql.unsafe(grantsSource.slice(begin + beginMarker.length, end).trim());
    const gateRows = await ownerSql<Array<{
      enabled: boolean;
      enabledAt: Date | null;
      disabledAt: Date | null;
    }>>`
      select enabled, enabled_at as "enabledAt", disabled_at as "disabledAt"
      from public.companion_runtime_control where id = 'runtime-v2' for update`;
    originalRuntimeGate = gateRows[0];
    await ownerSql`update public.companion_runtime_control
      set enabled = true, enabled_at = coalesce(enabled_at, clock_timestamp()), disabled_at = null
      where id = 'runtime-v2'`;
    await ownerSql.unsafe(`
      insert into public."user" (id, name, email, email_verified)
      values ('${ids.owner}', 'Owner', '${ids.owner}@example.test', true);
      insert into public."user" (id, name, email, email_verified)
      values ('${ids.editor}', 'Editor', '${ids.editor}@example.test', true);
      insert into public."user" (id, name, email, email_verified)
      values ('${ids.outsider}', 'Outsider', '${ids.outsider}@example.test', true);
      insert into public.organizations (id, name, slug)
      values ('${ids.org}', 'Runtime v3', 'runtime-v3-${suffix}');
      insert into public.memberships (org_id, user_id, org_role)
      values ('${ids.org}', '${ids.owner}', 'owner');
      insert into public.memberships (org_id, user_id, org_role)
      values ('${ids.org}', '${ids.editor}', 'developer');
      insert into public.companions (id, org_id, owner_id, name)
      values ('${ids.companion}', '${ids.org}', '${ids.owner}', 'Runtime v3 test');
      insert into public.companion_provider_connections(
        org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
        wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
      ) values (
        '${ids.org}', 'anthropic', 'api_key', 'ciphertext', 'iv', 'tag',
        'dek', 'wiv', 'wtag', 'key', '${ids.owner}'
      );
      update public.companions
      set model_id = 'claude-test', provider_ids = '["anthropic"]'::jsonb
      where id = '${ids.companion}';
      insert into public.companion_workspace_access(
        org_id, companion_id, owner_id, role, granted_by
      ) values ('${ids.org}', '${ids.companion}', '${ids.owner}', 'editor', '${ids.owner}');
    `);
  });

  beforeEach(async () => {
    await ownerSql`delete from public.companion_v3_instances
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid`;
  });

  afterAll(async () => {
    if (originalRuntimeGate) {
      await ownerSql`update public.companion_runtime_control
        set enabled = ${originalRuntimeGate.enabled},
          enabled_at = ${originalRuntimeGate.enabledAt},
          disabled_at = ${originalRuntimeGate.disabledAt}
        where id = 'runtime-v2'`;
    }
    await ownerSql`delete from public.companions where id = ${ids.companion}::uuid`;
    await ownerSql`delete from public.organizations where id = ${ids.org}::uuid`;
    await ownerSql`delete from public."user" where id = ${ids.owner}`;
    await ownerSql`delete from public."user" where id = ${ids.editor}`;
    await ownerSql`delete from public."user" where id = ${ids.outsider}`;
    await Promise.all([
      apiSql.end({ timeout: 1 }),
      workerSql.end({ timeout: 1 }),
      runtimeSql.end({ timeout: 1 }),
      ownerSql.end({ timeout: 1 }),
    ]);
  });

  it("admits main and background Turns FIFO through separate process capabilities", async () => {
    const mainOne = randomUUID();
    const mainTwo = randomUUID();
    const background = randomUUID();
    await admitMain(mainOne);
    await admitMain(mainTwo);
    let replay: Array<{ replayed: boolean }> = [];
    await asApi(async (sql) => {
      replay = await sql<Array<{ replayed: boolean }>>`
        select replayed from public.companion_v3_api_admit_turn(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${mainOne}::uuid, ${`msg:${mainOne}`}
        )`;
    });
    await workerSql`select * from public.companion_v3_worker_admit_turn(
      ${ids.org}::uuid, ${ids.companion}::uuid, ${background}::uuid,
      ${`msg:${background}`}, ${ids.owner}
    )`;

    const mainClaim = await runtimeSql<Array<{
      commandId: string;
      lane: string;
      turnId: string;
      token: string;
      epoch: string;
      gate: string;
    }>>`
      select command_id as "commandId", lane::text, turn_id as "turnId",
        claim_token as token, claim_epoch::text as epoch, gate_epoch::text as gate
      from public.companion_v3_runtime_claim(
        'runtime-a', 'main', 30, 3
      )`;
    const backgroundClaim = await runtimeSql<Array<{ commandId: string; lane: string }>>`
      select command_id as "commandId", lane::text from public.companion_v3_runtime_claim(
        'runtime-b', 'background', 30, 3
      )`;

    expect(mainClaim).toEqual([expect.objectContaining({ commandId: mainOne, lane: "main" })]);
    expect(backgroundClaim).toEqual([{ commandId: background, lane: "background" }]);
    expect(replay).toEqual([{ replayed: true }]);
    let lifecycle: Array<{ intent: string; revision: string }> = [];
    await asApi(async (sql) => {
      lifecycle = await sql<Array<{ intent: string; revision: string }>>`
        select intent::text, revision::text
        from public.companion_v3_api_desire_lifecycle(
          ${ids.org}::uuid, ${ids.companion}::uuid, 'archive'
        )`;
    });
    expect(lifecycle).toEqual([{ intent: "archive", revision: "2" }]);
    await runtimeSql`select public.companion_v3_runtime_complete(
      ${ids.org}::uuid, ${ids.companion}::uuid, 'main', ${mainClaim[0]!.turnId}::uuid,
      ${mainClaim[0]!.token}::uuid, ${mainClaim[0]!.epoch}::bigint,
      ${mainClaim[0]!.gate}::bigint,
      'succeeded', null, null, null, 3
    )`;
    const nextMain = await runtimeSql<Array<{ commandId: string }>>`
      select command_id as "commandId"
      from public.companion_v3_runtime_claim('runtime-a', 'main', 30, 3)`;
    expect(nextMain).toEqual([{ commandId: mainTwo }]);
  });

  it("resolves concurrent retries of one client message to one Turn", async () => {
    const command = randomUUID();
    const admissions: Array<Array<{ turnId: string; replayed: boolean }>> = [[], []];
    await Promise.all(admissions.map(async (_rows, index) => {
      await asApi(async (sql) => {
        admissions[index] = await sql<Array<{ turnId: string; replayed: boolean }>>`
          select turn_id as "turnId", replayed
          from public.companion_v3_api_admit_turn(
            ${ids.org}::uuid, ${ids.companion}::uuid, ${command}::uuid, ${`msg:${command}`}
          )`;
      });
    }));

    expect(new Set(admissions.flat().map((admission) => admission.turnId)).size).toBe(1);
    expect(admissions.flat().map((admission) => admission.replayed).sort()).toEqual([false, true]);
  });

  it("claims warm work only after runtime-owned v3 preparation is durable", async () => {
    const command = randomUUID();
    await admitMain(command);

    const unprepared = await runtimeSql<Array<{ commandId: string }>>`
      select command_id as "commandId"
      from public.companion_v3_runtime_claim_warm('runtime-warm-readiness', 'main', 30, 3)`;
    expect(unprepared).toEqual([]);

    await ownerSql`update public.companion_v3_instances
      set box_id = 'bx_23456789', pi_invocation_id = 'invocation-ready',
        prepared_at = clock_timestamp()
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid`;
    const prepared = await runtimeSql<Array<{ commandId: string }>>`
      select command_id as "commandId"
      from public.companion_v3_runtime_claim_warm('runtime-warm-readiness', 'main', 30, 3)`;
    expect(prepared).toEqual([{ commandId: command }]);
  });

  it("fails closed before Pi when current provider authority is revoked", async () => {
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, box_id, pi_invocation_id, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-authority',
      clock_timestamp()
    )`;
    const command = randomUUID();
    await asApi(async (sql) => {
      await sql`select * from public.companion_v3_api_enqueue_warm_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${command}::uuid, 'authorized warm text'
      )`;
    });
    const convergence = createRuntimeV3PostgresWarmConvergence(runtimeSql);
    const claim = await convergence.claimLane({ executorId: "runtime-authority", lane: "main" });
    expect(claim).not.toBeNull();

    await ownerSql`delete from public.companion_provider_connections
      where org_id = ${ids.org}::uuid and provider_id = 'anthropic'`;
    await expect(createRuntimeV3PostgresWarmTurnPersistence(runtimeSql).authorize(claim!))
      .resolves.toBeNull();
    await ownerSql`insert into public.companion_provider_connections(
      org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
      wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
    ) values (
      ${ids.org}::uuid, 'anthropic', 'api_key', 'ciphertext', 'iv', 'tag',
      'dek', 'wiv', 'wtag', 'key', ${ids.owner}
    )`;
  });

  it("keeps one Turn owner when preparation changes across idempotent retries", async () => {
    const legacyMessage = randomUUID();
    await ownerSql`insert into public.companion_runtime_instances(org_id, companion_id)
      values (${ids.org}::uuid, ${ids.companion}::uuid)`;
    let legacy: Array<{ turn: { id: string }; replayed: boolean }> = [];
    await asApi(async (sql) => {
      legacy = await sql<Array<{ turn: { id: string }; replayed: boolean }>>`
        select turn, replayed from public.companion_api_enqueue_turn(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${legacyMessage}::uuid,
          'accepted before v3 preparation', 'web', '[]'::jsonb
        )`;
    });
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, box_id, pi_invocation_id, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-switch',
      clock_timestamp()
    )`;
    await asApi(async (sql) => {
      const v3 = await sql`select * from public.companion_v3_api_enqueue_warm_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${legacyMessage}::uuid,
        'accepted before v3 preparation'
      )`;
      expect(v3).toHaveLength(0);
      const replay = await sql<Array<{ turn: { id: string }; replayed: boolean }>>`
        select turn, replayed from public.companion_api_enqueue_turn(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${legacyMessage}::uuid,
          'accepted before v3 preparation', 'web', '[]'::jsonb
        )`;
      expect(replay).toEqual([{ turn: expect.objectContaining({ id: legacy[0]!.turn.id }), replayed: true }]);
    });
  });

  it("projects a Runtime v3 needs-input state from PostgreSQL after Pi admission", async () => {
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, box_id, pi_invocation_id, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-question',
      clock_timestamp()
    )`;
    const command = randomUUID();
    let sent: Array<{ turn: { id: string } }> = [];
    await asApi(async (sql) => {
      sent = await sql<Array<{ turn: { id: string } }>>`select turn
        from public.companion_v3_api_enqueue_warm_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${command}::uuid, 'ask me a question'
      )`;
    });
    const convergence = createRuntimeV3Convergence({
      persistence: createRuntimeV3PostgresWarmConvergence(runtimeSql),
      advance: createRuntimeV3WarmTurnAdvance({
        persistence: createRuntimeV3PostgresWarmTurnPersistence(runtimeSql),
        pi: {
          async prompt() {
            return { outcome: "accepted", invocationId: "invocation-question", initialCursor: 0n };
          },
          async read(input) {
            return {
              events: [{
                sequence: 1n,
                invocationId: input.invocationId,
                attemptId: input.turnId,
                kind: "pi_event" as const,
                event: {
                  type: "extension_ui_request",
                  id: "question-1",
                  method: "input",
                  title: "companion:question:Clarification",
                  placeholder: "Which environment should I inspect?",
                },
              }],
              nextCursor: 1n,
              acknowledgedCursor: 0n,
              hasMore: false,
            };
          },
          async acknowledge(input) { return input.through; },
        },
      }),
    });
    await expect(convergence.converge({ executorId: "runtime-needs-input" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });

    await ownerSql`update public.companion_v3_instances set prepared_at = null,
      box_id = null, pi_invocation_id = null
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid`;
    await asApi(async (sql) => {
      const replay = await sql<Array<{ turn: { id: string }; replayed: boolean }>>`
        select turn, replayed from public.companion_v3_api_enqueue_warm_turn(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${command}::uuid, 'ask me a question'
        )`;
      expect(replay).toEqual([{
        turn: expect.objectContaining({ id: sent[0]!.turn.id }),
        replayed: true,
      }]);
    });
    let projection: Array<{ activeTurn: { status: string }; isReplying: boolean }> = [];
    await asApi(async (sql) => {
      projection = await sql<Array<{ activeTurn: { status: string }; isReplying: boolean }>>`
        select active_turn as "activeTurn", is_replying as "isReplying"
        from public.companion_v3_api_read_projection(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${sql.json([`msg:${command}`])}::jsonb
        )`;
    });
    expect(projection).toEqual([{
      activeTurn: expect.objectContaining({ status: "needs_input" }),
      isReplying: false,
    }]);
  });

  it("settles warm text FIFO and releases a failed main lane before the next Turn", async () => {
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, box_id, pi_invocation_id, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-warm', clock_timestamp()
    )`;
    const first = randomUUID();
    const second = randomUUID();
    let firstSend: Array<{ turn: { id: string }; replayed: boolean }> = [];
    let replay: Array<{ turn: { id: string }; replayed: boolean }> = [];
    await asApi(async (sql) => {
      firstSend = await sql<Array<{ turn: { id: string }; replayed: boolean }>>`
        select turn, replayed from public.companion_v3_api_enqueue_warm_turn(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${first}::uuid, 'fail first'
        )`;
      replay = await sql<Array<{ turn: { id: string }; replayed: boolean }>>`
        select turn, replayed from public.companion_v3_api_enqueue_warm_turn(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${first}::uuid, 'fail first'
        )`;
      await sql`select * from public.companion_v3_api_enqueue_warm_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${second}::uuid, 'then answer'
      )`;
    });
    expect(firstSend[0]!.replayed).toBe(false);
    expect(replay).toEqual([{ turn: expect.objectContaining({ id: firstSend[0]!.turn.id }), replayed: true }]);

    let queued: Array<{ queuedCount: number; isReplying: boolean }> = [];
    await asApi(async (sql) => {
      queued = await sql<Array<{ queuedCount: number; isReplying: boolean }>>`
        select queued_count as "queuedCount", is_replying as "isReplying"
        from public.companion_v3_api_read_projection(
          ${ids.org}::uuid, ${ids.companion}::uuid,
          ${sql.json([`msg:${first}`, `msg:${second}`])}::jsonb
        )`;
    });
    expect(queued).toEqual([{ queuedCount: 2, isReplying: false }]);

    const basePersistence = createRuntimeV3PostgresWarmTurnPersistence(runtimeSql);
    const admissionReplying: boolean[] = [];
    const persistence = {
      ...basePersistence,
      async recordAdmission(...args: Parameters<typeof basePersistence.recordAdmission>) {
        const recorded = await basePersistence.recordAdmission(...args);
        await asApi(async (sql) => {
          const rows = await sql<Array<{ isReplying: boolean }>>`
            select is_replying as "isReplying"
            from public.companion_v3_api_read_projection(
              ${ids.org}::uuid, ${ids.companion}::uuid, '[]'::jsonb
            )`;
          admissionReplying.push(rows[0]!.isReplying);
        });
        return recorded;
      },
    };
    const attempts = new Map<string, "fail" | "answer">();
    const convergence = createRuntimeV3Convergence({
      persistence: createRuntimeV3PostgresWarmConvergence(runtimeSql),
      advance: createRuntimeV3WarmTurnAdvance({
        persistence,
        pi: {
          async prompt(input) {
            attempts.set(input.turnId, input.message === "fail first" ? "fail" : "answer");
            return { outcome: "accepted", invocationId: "invocation-warm", initialCursor: 0n };
          },
          async read(input) {
            if (attempts.get(input.turnId) === "fail") {
              return {
                events: [{
                  sequence: 1n,
                  invocationId: input.invocationId,
                  attemptId: input.turnId,
                  kind: "pi_process_exit",
                  exit: { code: 1, signal: null },
                }],
                nextCursor: 1n,
                acknowledgedCursor: 0n,
                hasMore: false,
              };
            }
            return {
              events: [
                {
                  sequence: 1n,
                  invocationId: input.invocationId,
                  attemptId: input.turnId,
                  kind: "pi_event",
                  event: {
                    type: "message_end",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "durable answer" }],
                      stopReason: "stop",
                    },
                  },
                },
                {
                  sequence: 2n,
                  invocationId: input.invocationId,
                  attemptId: input.turnId,
                  kind: "pi_event",
                  event: { type: "agent_settled" },
                },
              ],
              nextCursor: 2n,
              acknowledgedCursor: 0n,
              hasMore: false,
            };
          },
          async acknowledge(input) { return input.through; },
        },
      }),
    });

    await expect(convergence.converge({ executorId: "runtime-v3-warm" }))
      .resolves.toEqual({ progressed: 2, exhausted: false });
    expect(admissionReplying).toEqual([true, true]);

    const facts = await ownerSql<Array<{
      state: string;
      claimToken: string | null;
      assistantCount: number;
    }>>`
      select turn_row.state::text, lease.claim_token::text as "claimToken",
        (select count(*)::integer from public.companion_transcript_entries entry
          where entry.org_id = turn_row.org_id and entry.companion_id = turn_row.companion_id
            and entry.role = 'assistant') as "assistantCount"
      from public.companion_v3_turns turn_row
      join public.companion_v3_lane_leases lease
        on lease.org_id = turn_row.org_id and lease.companion_id = turn_row.companion_id
          and lease.lane = turn_row.lane
      where turn_row.command_id in (${first}::uuid, ${second}::uuid)
      order by turn_row.queue_sequence`;
    expect(facts).toEqual([
      { state: "failed", claimToken: null, assistantCount: 1 },
      { state: "succeeded", claimToken: null, assistantCount: 1 },
    ]);
    let terminal: Array<{ activeTurn: unknown; queuedCount: number; isReplying: boolean }> = [];
    await asApi(async (sql) => {
      terminal = await sql<Array<{ activeTurn: unknown; queuedCount: number; isReplying: boolean }>>`
        select active_turn as "activeTurn", queued_count as "queuedCount",
          is_replying as "isReplying"
        from public.companion_v3_api_read_projection(
          ${ids.org}::uuid, ${ids.companion}::uuid, '[]'::jsonb
        )`;
    });
    expect(terminal).toEqual([{ activeTurn: null, queuedCount: 0, isReplying: false }]);
  });

  it("increments lane fences monotonically and rejects stale completion", async () => {
    await admitMain(randomUUID());
    const first = await runtimeSql<Array<{ token: string; epoch: string; gate: string; turnId: string }>>`
      select claim_token as token, claim_epoch::text as epoch, gate_epoch::text as gate,
        turn_id as "turnId"
      from public.companion_v3_runtime_claim('runtime-c', 'main', 1, 3)`;
    await ownerSql`select pg_sleep(1.1)`;
    const second = await runtimeSql<Array<{ token: string; epoch: string; gate: string; turnId: string }>>`
      select claim_token as token, claim_epoch::text as epoch, gate_epoch::text as gate,
        turn_id as "turnId"
      from public.companion_v3_runtime_claim('runtime-d', 'main', 30, 3)`;

    expect(BigInt(second[0]!.epoch)).toBeGreaterThan(BigInt(first[0]!.epoch));
    const stale = await runtimeSql<Array<{ completed: boolean }>>`
      select public.companion_v3_runtime_complete(
        ${ids.org}::uuid, ${ids.companion}::uuid, 'main', ${first[0]!.turnId}::uuid,
        ${first[0]!.token}::uuid, ${first[0]!.epoch}::bigint,
        ${first[0]!.gate}::bigint,
        'release', null, null, null, 3
      ) as completed`;
    expect(stale[0]!.completed).toBe(false);
  });

  it("rejects a null completion outcome without releasing the lane lease", async () => {
    await admitMain(randomUUID());
    const claim = await runtimeSql<Array<{ token: string; epoch: string; gate: string; turnId: string }>>`
      select claim_token as token, claim_epoch::text as epoch, gate_epoch::text as gate,
        turn_id as "turnId"
      from public.companion_v3_runtime_claim('runtime-null-outcome', 'main', 30, 3)`;

    await expect(runtimeSql`select public.companion_v3_runtime_complete(
      ${ids.org}::uuid, ${ids.companion}::uuid, 'main', ${claim[0]!.turnId}::uuid,
      ${claim[0]!.token}::uuid, ${claim[0]!.epoch}::bigint,
      ${claim[0]!.gate}::bigint,
      ${null}::text, null, null, null, 3
    )`).rejects.toThrow(/invalid Runtime v3 completion/);

    const facts = await ownerSql<Array<{ state: string; token: string | null }>>`
      select turn_row.state::text, lease.claim_token::text as token
      from public.companion_v3_turns turn_row
      join public.companion_v3_lane_leases lease
        on lease.org_id = turn_row.org_id and lease.companion_id = turn_row.companion_id
          and lease.lane = turn_row.lane and lease.turn_id = turn_row.id
      where turn_row.id = ${claim[0]!.turnId}::uuid`;
    expect(facts).toEqual([{ state: "queued", token: claim[0]!.token }]);
  });

  it("rejects a null lease duration without materializing a lane claim", async () => {
    await admitMain(randomUUID());

    await expect(runtimeSql`select * from public.companion_v3_runtime_claim(
      'runtime-null-lease', 'main', ${null}::integer, 3
    )`).rejects.toThrow(/invalid Runtime v3 claim/);

    const facts = await ownerSql<Array<{
      state: string;
      token: string | null;
      gate: string | null;
      expiresAt: Date | null;
    }>>`
      select turn_row.state::text, lease.claim_token::text as token,
        lease.gate_epoch::text as gate, lease.expires_at as "expiresAt"
      from public.companion_v3_turns turn_row
      join public.companion_v3_lane_leases lease
        on lease.org_id = turn_row.org_id and lease.companion_id = turn_row.companion_id
          and lease.lane = turn_row.lane
      where turn_row.org_id = ${ids.org}::uuid
        and turn_row.companion_id = ${ids.companion}::uuid`;
    expect(facts).toEqual([{ state: "queued", token: null, gate: null, expiresAt: null }]);
  });

  it("invalidates held lane claims when the shared runtime gate advances", async () => {
    await admitMain(randomUUID());
    const claim = await runtimeSql<Array<{
      token: string;
      epoch: string;
      gate: string;
      turnId: string;
    }>>`
      select claim_token as token, claim_epoch::text as epoch, gate_epoch::text as gate,
        turn_id as "turnId"
      from public.companion_v3_runtime_claim('runtime-gate-fence', 'main', 30, 3)`;
    let disabledGate: string | undefined;
    try {
      const disabled = await runtimeSql<Array<{ enabled: boolean; gate: string }>>`
        select enabled, gate_epoch::text as gate
        from public.companion_runtime_disable(
          ${claim[0]!.gate}::bigint, 'runtime-v3-gate-test'
        )`;
      disabledGate = disabled[0]!.gate;
      expect(disabled).toEqual([{
        enabled: false,
        gate: expect.stringMatching(/^\d+$/),
      }]);
      expect(BigInt(disabledGate)).toBeGreaterThan(BigInt(claim[0]!.gate));

      const completion = await runtimeSql<Array<{ completed: boolean }>>`
        select public.companion_v3_runtime_complete(
          ${ids.org}::uuid, ${ids.companion}::uuid, 'main', ${claim[0]!.turnId}::uuid,
          ${claim[0]!.token}::uuid, ${claim[0]!.epoch}::bigint,
          ${claim[0]!.gate}::bigint, 'succeeded', null, null, null, 3
        ) as completed`;
      expect(completion).toEqual([{ completed: false }]);

      const facts = await ownerSql<Array<{
        state: string;
        token: string | null;
        gate: string | null;
        epoch: string;
      }>>`
        select turn_row.state::text, lease.claim_token::text as token,
          lease.gate_epoch::text as gate, lease.claim_epoch::text as epoch
        from public.companion_v3_turns turn_row
        join public.companion_v3_lane_leases lease
          on lease.org_id = turn_row.org_id and lease.companion_id = turn_row.companion_id
            and lease.lane = turn_row.lane
        where turn_row.id = ${claim[0]!.turnId}::uuid`;
      expect(facts).toEqual([{
        state: "queued",
        token: null,
        gate: null,
        epoch: expect.stringMatching(/^\d+$/),
      }]);
      expect(BigInt(facts[0]!.epoch)).toBeGreaterThan(BigInt(claim[0]!.epoch));
    } finally {
      if (disabledGate) {
        await ownerSql`select * from public.companion_runtime_enable(
          ${disabledGate}::bigint, 'runtime-v3-gate-test'
        )`;
      }
    }
  });

  it("drives PostgreSQL claims through the closed progression interface", async () => {
    await admitMain(randomUUID());
    const progression = createRuntimeV3Convergence({
      persistence: createRuntimeV3PostgresConvergence(runtimeSql),
      advance: async () => ({ kind: "succeeded" }),
    });

    await expect(progression.converge({ executorId: "runtime-progression" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
  });

  it("progresses an available background lane without waiting for main", async () => {
    const main = randomUUID();
    const backgroundOne = randomUUID();
    const backgroundTwo = randomUUID();
    await admitMain(main);
    await workerSql`select * from public.companion_v3_worker_admit_turn(
      ${ids.org}::uuid, ${ids.companion}::uuid, ${backgroundOne}::uuid,
      ${`msg:${backgroundOne}`}, ${ids.owner}
    )`;
    await workerSql`select * from public.companion_v3_worker_admit_turn(
      ${ids.org}::uuid, ${ids.companion}::uuid, ${backgroundTwo}::uuid,
      ${`msg:${backgroundTwo}`}, ${ids.owner}
    )`;
    let releaseMain!: () => void;
    const mainWait = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    const convergencePersistence = createRuntimeV3PostgresConvergence(runtimeSql);
    const progression = createRuntimeV3Convergence({
      persistence: convergencePersistence,
      advance: async (claim) => {
        if (claim.turn.lane === "main") await mainWait;
        return { kind: "succeeded" };
      },
    });

    const convergence = progression.converge({ executorId: "runtime-independent-lanes" });
    await vi.waitFor(async () => {
      const rows = await ownerSql<Array<{ state: string }>>`
        select state::text from public.companion_v3_turns
        where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid
          and command_id in (${backgroundOne}::uuid, ${backgroundTwo}::uuid)
        order by queue_sequence`;
      expect(rows).toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
    });
    releaseMain();
    await expect(convergence).resolves.toEqual({ progressed: 3, exhausted: false });
  });

  it("forces RLS and keeps v3 facts behind split role grants", async () => {
    const tables = await ownerSql<Array<{ name: string; rls: boolean; forced: boolean }>>`
      select relname as name, relrowsecurity as rls, relforcerowsecurity as forced
      from pg_catalog.pg_class
      where relname in ('companion_v3_instances', 'companion_v3_turns', 'companion_v3_lane_leases')
      order by relname`;
    expect(tables).toEqual([
      { name: "companion_v3_instances", rls: true, forced: true },
      { name: "companion_v3_lane_leases", rls: true, forced: true },
      { name: "companion_v3_turns", rls: true, forced: true },
    ]);
    const absentAttemptArtifacts = await ownerSql<Array<{
      attempts: string | null;
      operations: string | null;
    }>>`
      select to_regclass('public.companion_v3_turn_attempts')::text as attempts,
        to_regclass('public.companion_v3_operations')::text as operations`;
    expect(absentAttemptArtifacts).toEqual([{ attempts: null, operations: null }]);
    const grants = await ownerSql<Array<{
      apiAdmit: boolean;
      apiClaim: boolean;
      workerAdmit: boolean;
      workerClaim: boolean;
      runtimeAdmit: boolean;
      runtimeClaim: boolean;
    }>>`
      select
        has_function_privilege(${apiRole},
          'public.companion_v3_api_admit_turn(uuid,uuid,uuid,text)', 'EXECUTE') as "apiAdmit",
        has_function_privilege(${apiRole},
          'public.companion_v3_runtime_claim(text,public.companion_v3_lane,integer,integer)', 'EXECUTE') as "apiClaim",
        has_function_privilege(${workerRole},
          'public.companion_v3_worker_admit_turn(uuid,uuid,uuid,text,text)', 'EXECUTE') as "workerAdmit",
        has_function_privilege(${workerRole},
          'public.companion_v3_runtime_claim(text,public.companion_v3_lane,integer,integer)', 'EXECUTE') as "workerClaim",
        has_function_privilege(${runtimeRole},
          'public.companion_v3_api_admit_turn(uuid,uuid,uuid,text)', 'EXECUTE') as "runtimeAdmit",
        has_function_privilege(${runtimeRole},
          'public.companion_v3_runtime_claim(text,public.companion_v3_lane,integer,integer)', 'EXECUTE') as "runtimeClaim"`;
    expect(grants).toEqual([{
      apiAdmit: true,
      apiClaim: false,
      workerAdmit: true,
      workerClaim: false,
      runtimeAdmit: false,
      runtimeClaim: true,
    }]);
    await expect(apiSql`select * from public.companion_v3_turns`).rejects.toMatchObject({ code: "42501" });
    await expect(workerSql`select * from public.companion_v3_turns`).rejects.toMatchObject({ code: "42501" });
    await expect(runtimeSql`select * from public.companion_v3_turns`).rejects.toMatchObject({ code: "42501" });
    await expect(runtimeSql`select * from public.companion_v3_runtime_claim('old', 'main', 30, 2)`)
      .rejects.toMatchObject({ code: "42501" });
  });

  it("keeps v3 work non-activatable while the existing runtime gate is disabled", async () => {
    await admitMain(randomUUID());
    await ownerSql.begin(async (sql) => {
      const rows = await sql<Array<{
        enabled: boolean;
        enabledAt: Date | null;
        disabledAt: Date | null;
      }>>`
        select enabled, enabled_at as "enabledAt", disabled_at as "disabledAt"
        from public.companion_runtime_control where id = 'runtime-v2' for update`;
      await sql`update public.companion_runtime_control
        set enabled = false, enabled_at = null, disabled_at = clock_timestamp()
        where id = 'runtime-v2'`;
      const claims = await sql<Array<{ turnId: string }>>`
        select turn_id as "turnId"
        from public.companion_v3_runtime_claim('runtime-disabled', 'main', 30, 3)`;
      expect(claims).toEqual([]);
      await sql`update public.companion_runtime_control
        set enabled = ${rows[0]!.enabled}, enabled_at = ${rows[0]!.enabledAt},
          disabled_at = ${rows[0]!.disabledAt}
        where id = 'runtime-v2'`;
    });
  });

  it("fails closed for cross-tenant, non-member, and revoked-owner admission", async () => {
    const crossTenant = randomUUID();
    const crossTenantCommand = randomUUID();
    await expect(asApiActor(crossTenant, ids.owner, async (sql) => {
      await sql`select * from public.companion_v3_api_admit_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${crossTenantCommand}::uuid,
        ${`msg:${crossTenantCommand}`}
      )`;
    })).rejects.toMatchObject({ code: "42501" });
    await expect(asApiActor(ids.org, ids.outsider, async (sql) => {
      const command = randomUUID();
      await sql`select * from public.companion_v3_api_admit_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${command}::uuid, ${`msg:${command}`}
      )`;
    })).rejects.toMatchObject({ code: "42501" });

    const initialEditorCommand = randomUUID();
    await asApiActor(ids.org, ids.editor, async (sql) => {
      await sql`select * from public.companion_v3_api_admit_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${initialEditorCommand}::uuid,
        ${`msg:${initialEditorCommand}`}
      )`;
    });
    await ownerSql`delete from public.companion_workspace_access
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid`;
    try {
      const command = randomUUID();
      await expect(asApiActor(ids.org, ids.editor, async (sql) => {
        await sql`select * from public.companion_v3_api_admit_turn(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${command}::uuid, ${`msg:${command}`}
        )`;
      })).rejects.toMatchObject({ code: "P0002" });
    } finally {
      await ownerSql`insert into public.companion_workspace_access(
        org_id, companion_id, owner_id, role, granted_by
      ) values (${ids.org}::uuid, ${ids.companion}::uuid, ${ids.owner}, 'editor', ${ids.owner})
      on conflict (companion_id) do update set role = excluded.role`;
    }
  });
});
