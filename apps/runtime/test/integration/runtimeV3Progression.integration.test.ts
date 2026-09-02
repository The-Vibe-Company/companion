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
  createRuntimeV3PostgresPreparationPersistence,
  createRuntimeV3PostgresWarmConvergence,
  createRuntimeV3PostgresWarmTurnPersistence,
} from "../../src/runtimeV3ProgressionStore";
import { runtimeV3AcceptanceReport } from "../../src/runtimeV3AcceptanceReport";

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

  it("creates a cold Companion, durably queues its first Turn, and claims preparation", async () => {
    let coldCompanion: string | null = null;
    const message = randomUUID();
    try {
      await asApi(async (sql) => {
        const created = await sql<Array<{ companionId: string }>>`
          select companion_id as "companionId" from public.companion_v3_api_create_companion(
          ${ids.org}::uuid, 'Cold Companion', null, 'anthropic', 'claude-test',
          '[]'::jsonb, true, '[]'::jsonb, null,
          1::smallint, 1::smallint, 1::smallint, 2::smallint
        )`;
        coldCompanion = created[0]!.companionId;
        const accepted = await sql<Array<{ turn: { status: string }; replayed: boolean }>>`
          select turn, replayed from public.companion_v3_api_enqueue_warm_turn(
            ${ids.org}::uuid, ${coldCompanion}::uuid, ${message}::uuid, 'hello immediately'
          )`;
        expect(accepted).toEqual([{
          turn: expect.objectContaining({ status: "queued" }),
          replayed: false,
        }]);
      });

      const claims = await runtimeSql<Array<{
        companionId: string;
        turnId: string | null;
        workKind: string;
        checkpoint: string;
        idempotencyKey: string;
        token: string;
        epoch: string;
        gate: string;
      }>>`
        select companion_id as "companionId", turn_id as "turnId", work_kind::text as "workKind",
          checkpoint, box_idempotency_key as "idempotencyKey", claim_token as token,
          claim_epoch::text as epoch, gate_epoch::text as gate
        from public.companion_v3_runtime_claim_preparation('runtime-cold', 30, 3)
      `;
      expect(claims).toEqual([expect.objectContaining({
        companionId: coldCompanion,
        turnId: expect.any(String),
        workKind: "preparation",
        checkpoint: "pending",
        idempotencyKey: expect.any(String),
      })]);

      const first = claims[0]!;
      await expect(runtimeSql`select public.companion_v3_runtime_checkpoint_preparation(
        ${ids.org}::uuid, ${coldCompanion}::uuid, ${first.token}::uuid,
        ${first.epoch}::bigint, ${first.gate}::bigint,
        'pending', 'box_created', 'bx_23456789', null, 3
      )`).resolves.toEqual([{ companion_v3_runtime_checkpoint_preparation: true }]);
      const readyClaim = (await runtimeSql<Array<{
        token: string; epoch: string; gate: string;
      }>>`select claim_token as token, claim_epoch::text as epoch, gate_epoch::text as gate
        from public.companion_v3_runtime_claim_preparation('runtime-cold-retry', 30, 3)`)[0]!;
      await expect(runtimeSql`select public.companion_v3_runtime_checkpoint_preparation(
        ${ids.org}::uuid, ${coldCompanion}::uuid, ${readyClaim.token}::uuid,
        ${readyClaim.epoch}::bigint, ${readyClaim.gate}::bigint,
        'box_created', 'box_ready', null, null, 3
      )`).resolves.toEqual([{ companion_v3_runtime_checkpoint_preparation: true }]);
      const retry = (await runtimeSql<Array<{
        token: string; epoch: string; gate: string;
      }>>`select claim_token as token, claim_epoch::text as epoch, gate_epoch::text as gate
        from public.companion_v3_runtime_claim_preparation('runtime-cold-defer', 30, 3)`)[0]!;
      await expect(runtimeSql`select public.companion_v3_runtime_defer_preparation(
        ${ids.org}::uuid, ${coldCompanion}::uuid, ${retry.token}::uuid,
        ${retry.epoch}::bigint, ${retry.gate}::bigint, 5,
        'companion_prepare_failed', 'Runtime execution failed.', 3
      )`).resolves.toEqual([{ companion_v3_runtime_defer_preparation: true }]);

      const queued = await ownerSql<Array<{
        state: string; errorCode: string; delaySeconds: number;
        firstClaimedAt: Date; boxReadyAt: Date;
      }>>`select turn_row.state::text, instance.preparation_error_code as "errorCode",
          turn_row.first_claimed_at as "firstClaimedAt", instance.box_ready_at as "boxReadyAt",
          extract(epoch from (instance.preparation_available_at - clock_timestamp()))::integer
            as "delaySeconds"
        from public.companion_v3_turns turn_row
        join public.companion_v3_instances instance using (org_id, companion_id)
        where turn_row.companion_id = ${coldCompanion}::uuid`;
      expect(queued[0]).toMatchObject({ state: "queued", errorCode: "companion_prepare_failed" });
      expect(queued[0]!.firstClaimedAt.getTime()).toBeLessThanOrEqual(
        queued[0]!.boxReadyAt.getTime(),
      );
      expect(queued[0]!.delaySeconds).toBeGreaterThanOrEqual(1);
      expect(queued[0]!.delaySeconds).toBeLessThanOrEqual(5);

      await asApi(async (sql) => {
        const replay = await sql<Array<{
          turn: { status: string; error: { code: string; message: string; action: string } };
        }>>`select turn from public.companion_v3_api_enqueue_warm_turn(
          ${ids.org}::uuid, ${coldCompanion}::uuid, ${message}::uuid, 'hello immediately'
        )`;
        expect(replay).toEqual([{ turn: expect.objectContaining({
          status: "queued",
          error: {
            code: "companion_prepare_failed",
            message: "Runtime execution failed.",
            action: "retry",
          },
        }) }]);
      });

      const durableSideEffects = await ownerSql<Array<{ operations: string; attempts: string }>>`
        select
          (select count(*)::text from public.companion_operations
            where companion_id = ${coldCompanion}::uuid) as operations,
          (select count(*)::text from public.companion_turn_attempts
            where companion_id = ${coldCompanion}::uuid) as attempts
      `;
      expect(durableSideEffects).toEqual([{ operations: "0", attempts: "0" }]);
    } finally {
      if (coldCompanion) {
        await ownerSql`delete from public.companions where id = ${coldCompanion}::uuid`;
      }
    }
  });

  it("keeps image retry and takeover fencing independent from Turns and lanes", async () => {
    const digest = `the515-${suffix}`;
    const imageName = `companion-l14-${suffix.slice(0, 12)}`;
    try {
      await runtimeSql`select * from public.companion_runtime_image_request(${digest}, ${imageName})`;
      const first = (await runtimeSql<Array<{ epoch: string }>>`
        select image_claim_epoch::text as epoch
        from public.companion_runtime_image_claim('image-builder-a', ${digest}, ${imageName})
      `)[0]!;
      await expect(runtimeSql`select public.companion_runtime_image_mark_building_box(
        ${digest}, ${first.epoch}::bigint, 'bx_23456789'
      )`).resolves.toEqual([{ companion_runtime_image_mark_building_box: true }]);

      await ownerSql`update public.companion_images
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where digest = ${digest}`;
      const takeover = (await runtimeSql<Array<{ epoch: string }>>`
        select image_claim_epoch::text as epoch
        from public.companion_runtime_image_claim('image-builder-b', ${digest}, ${imageName})
      `)[0]!;
      expect(BigInt(takeover.epoch)).toBe(BigInt(first.epoch) + 1n);

      await expect(runtimeSql`select public.companion_runtime_image_authorize_publish(
        ${digest}, ${first.epoch}::bigint, 'bx_23456789'
      )`).resolves.toEqual([{ companion_runtime_image_authorize_publish: false }]);
      await expect(runtimeSql`select public.companion_runtime_image_mark_delete_intent(
        ${digest}, ${first.epoch}::bigint, 'bx_23456789'
      )`).resolves.toEqual([{ companion_runtime_image_mark_delete_intent: false }]);
      await expect(runtimeSql`select public.companion_runtime_image_record_ready(
        ${digest}, ${first.epoch}::bigint, ${imageName}, null
      )`).resolves.toEqual([{ companion_runtime_image_record_ready: false }]);
      await expect(runtimeSql`select public.companion_runtime_image_authorize_publish(
        ${digest}, ${takeover.epoch}::bigint, 'bx_23456789'
      )`).resolves.toEqual([{ companion_runtime_image_authorize_publish: true }]);

      await expect(runtimeSql`select public.companion_runtime_image_record_failure(
        ${digest}, ${takeover.epoch}::bigint,
        'image_build_failed', 'A bounded expurgated failure.'
      )`).resolves.toEqual([{ companion_runtime_image_record_failure: "requested" }]);
      const retry = (await ownerSql<Array<{ delaySeconds: number; errorMessage: string }>>`
        select extract(epoch from (next_attempt_at - clock_timestamp()))::integer as "delaySeconds",
          last_error_message as "errorMessage"
        from public.companion_images where digest = ${digest}
      `)[0]!;
      expect(retry.delaySeconds).toBeGreaterThanOrEqual(299);
      expect(retry.delaySeconds).toBeLessThanOrEqual(360);
      expect(retry.errorMessage).toBe("A bounded expurgated failure.");
      await expect(runtimeSql`
        select * from public.companion_runtime_image_claim('image-builder-c', ${digest}, ${imageName})
      `).resolves.toEqual([]);
    } finally {
      await ownerSql`delete from public.companion_images where digest = ${digest}`;
    }
  });

  it("keeps a near-60-second preparation fenced through its checkpoint", async () => {
    const command = randomUUID();
    await admitMain(command);
    const persistence = createRuntimeV3PostgresPreparationPersistence(runtimeSql);
    const claim = await persistence.claim({ executorId: "runtime-long-preparation" });
    expect(claim).toMatchObject({ companionId: ids.companion, checkpoint: "pending" });
    if (!claim) throw new Error("preparation claim was not created");

    const [lease] = await ownerSql<Array<{ seconds: number }>>`
      update public.companion_v3_instances
      set preparation_claimed_at = clock_timestamp() - interval '59 seconds',
        preparation_expires_at = clock_timestamp() + interval '31 seconds'
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid
        and preparation_claim_token = ${claim.fence.token}::uuid
      returning extract(epoch from (preparation_expires_at - preparation_claimed_at))::integer
        as seconds
    `;
    expect(lease?.seconds).toBe(90);

    await expect(persistence.claim({ executorId: "runtime-concurrent-preparation" }))
      .resolves.toBeNull();
    await expect(persistence.checkpoint(claim, {
      next: "box_created",
      boxId: "bx_23456789",
    })).resolves.toBe(true);
    const [checkpointed] = await ownerSql<Array<{ checkpoint: string }>>`
      select preparation_checkpoint as checkpoint from public.companion_v3_instances
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid
    `;
    expect(checkpointed?.checkpoint).toBe("box_created");
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
        preparation_checkpoint = 'prepared', box_ready_at = current_timestamp,
        staging_completed_at = current_timestamp, prepared_at = current_timestamp
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid`;
    const prepared = await runtimeSql<Array<{ commandId: string }>>`
      select command_id as "commandId"
      from public.companion_v3_runtime_claim_warm('runtime-warm-readiness', 'main', 30, 3)`;
    expect(prepared).toEqual([{ commandId: command }]);
  });

  it("preserves the acceptance wake path when a created Box later reaches Pi admission", async () => {
    const command = randomUUID();
    await admitMain(command);
    await ownerSql`update public.companion_v3_instances
      set box_id = 'bx_23456789', pi_invocation_id = 'invocation-created',
        preparation_checkpoint = 'prepared', box_ready_at = current_timestamp,
        staging_completed_at = current_timestamp, prepared_at = current_timestamp
      where org_id = ${ids.org}::uuid and companion_id = ${ids.companion}::uuid`;
    const convergence = createRuntimeV3PostgresWarmConvergence(runtimeSql);
    const claim = await convergence.claimLane({ executorId: "runtime-created-path", lane: "main" });
    expect(claim).not.toBeNull();
    const persistence = createRuntimeV3PostgresWarmTurnPersistence(runtimeSql);
    await expect(persistence.recordAdmission(claim!, {
      invocationId: "invocation-created",
      cursor: 0n,
    })).resolves.toBe(true);

    const measured = await ownerSql<Array<{ wakePath: string }>>`
      select wake_path::text as "wakePath" from public.companion_v3_turns
      where command_id = ${command}::uuid`;
    expect(measured).toEqual([{ wakePath: "creation" }]);
  });

  it("classifies acceptance against an archived instance as an archived wake", async () => {
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, desired_lifecycle
    ) values (${ids.org}::uuid, ${ids.companion}::uuid, 'archive')`;
    const command = randomUUID();
    await admitMain(command);

    const measured = await ownerSql<Array<{ wakePath: string }>>`
      select wake_path::text as "wakePath" from public.companion_v3_turns
      where command_id = ${command}::uuid`;
    expect(measured).toEqual([{ wakePath: "archived_wake" }]);
  });

  it("fails closed before Pi when current provider authority is revoked", async () => {
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, box_id, pi_invocation_id, preparation_checkpoint,
      box_ready_at, staging_completed_at, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-authority',
      'prepared', current_timestamp, current_timestamp, current_timestamp
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
      org_id, companion_id, box_id, pi_invocation_id, preparation_checkpoint,
      box_ready_at, staging_completed_at, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-switch',
      'prepared', current_timestamp, current_timestamp, current_timestamp
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

  it("projects and resumes a Runtime v3 needs-input Turn without redispatching its prompt", async () => {
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, box_id, pi_invocation_id, preparation_checkpoint,
      box_ready_at, staging_completed_at, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-question',
      'prepared', current_timestamp, current_timestamp, current_timestamp
    )`;
    const command = randomUUID();
    let sent: Array<{ turn: { id: string } }> = [];
    await asApi(async (sql) => {
      sent = await sql<Array<{ turn: { id: string } }>>`select turn
        from public.companion_v3_api_enqueue_warm_turn(
        ${ids.org}::uuid, ${ids.companion}::uuid, ${command}::uuid, 'ask me a question'
      )`;
    });
    let reads = 0;
    const prompt = vi.fn(async () => ({
      outcome: "accepted" as const,
      invocationId: "invocation-question",
      initialCursor: 0n,
    }));
    const convergence = createRuntimeV3Convergence({
      persistence: createRuntimeV3PostgresWarmConvergence(runtimeSql),
      advance: createRuntimeV3WarmTurnAdvance({
        persistence: createRuntimeV3PostgresWarmTurnPersistence(runtimeSql),
        pi: {
          prompt,
          async read(input) {
            reads += 1;
            if (reads > 1) {
              return {
                events: [
                  {
                    sequence: 2n,
                    invocationId: input.invocationId,
                    attemptId: input.turnId,
                    kind: "pi_event" as const,
                    event: {
                      type: "message_end",
                      message: {
                        role: "assistant" as const,
                        content: [{ type: "text" as const, text: "Production." }],
                        stopReason: "stop" as const,
                      },
                    },
                  },
                  {
                    sequence: 3n,
                    invocationId: input.invocationId,
                    attemptId: input.turnId,
                    kind: "pi_event" as const,
                    event: { type: "agent_settled" as const },
                  },
                ],
                nextCursor: 3n,
                acknowledgedCursor: 1n,
                hasMore: false,
              };
            }
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

    let projection: Array<{ activeTurn: { status: string } | null; isReplying: boolean }> = [];
    await asApi(async (sql) => {
      projection = await sql<Array<{
        activeTurn: { status: string } | null;
        isReplying: boolean;
      }>>`
        select active_turn as "activeTurn", is_replying as "isReplying"
        from public.companion_v3_api_read_projection(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${sql.json([`msg:${command}`])}::jsonb
        )`;
    });
    expect(projection).toEqual([{
      activeTurn: expect.objectContaining({ status: "needs_input" }),
      isReplying: false,
    }]);

    await expect(convergence.converge({ executorId: "runtime-needs-input-resume" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
    expect(prompt).toHaveBeenCalledOnce();

    await asApi(async (sql) => {
      projection = await sql<Array<{
        activeTurn: { status: string } | null;
        isReplying: boolean;
      }>>`
        select active_turn as "activeTurn", is_replying as "isReplying"
        from public.companion_v3_api_read_projection(
          ${ids.org}::uuid, ${ids.companion}::uuid, ${sql.json([`msg:${command}`])}::jsonb
        )`;
    });
    expect(projection).toEqual([{ activeTurn: null, isReplying: false }]);

    await ownerSql`update public.companion_v3_instances set prepared_at = null,
      box_id = null, pi_invocation_id = null, preparation_checkpoint = 'pending',
      box_ready_at = null, staging_completed_at = null
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
  });

  it("settles warm text FIFO and releases a failed main lane before the next Turn", async () => {
    await ownerSql`insert into public.companion_v3_instances(
      org_id, companion_id, box_id, pi_invocation_id, preparation_checkpoint,
      box_ready_at, staging_completed_at, prepared_at
    ) values (
      ${ids.org}::uuid, ${ids.companion}::uuid, 'bx_23456789', 'invocation-warm',
      'prepared', current_timestamp, current_timestamp, current_timestamp
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
      wakePath: string;
      boxProvider: string;
      modelProvider: string;
      modelId: string;
      admissionKind: string;
      acceptedAt: Date;
      firstClaimedAt: Date;
      boxReadyAt: Date;
      stagingCompletedAt: Date;
      piReadyAt: Date;
      admittedAt: Date;
      firstActivityAt: Date;
      settledAt: Date;
      claimCount: number;
    }>>`
      select turn_row.state::text, lease.claim_token::text as "claimToken",
        (select count(*)::integer from public.companion_transcript_entries entry
          where entry.org_id = turn_row.org_id and entry.companion_id = turn_row.companion_id
            and entry.role = 'assistant'
            and entry.event_id like 'v3:' || turn_row.id::text || ':%') as "assistantCount",
        turn_row.wake_path::text as "wakePath", turn_row.box_provider as "boxProvider",
        turn_row.model_provider as "modelProvider", turn_row.model_id as "modelId",
        turn_row.admission_kind::text as "admissionKind",
        turn_row.accepted_at as "acceptedAt", turn_row.first_claimed_at as "firstClaimedAt",
        turn_row.box_ready_at as "boxReadyAt",
        turn_row.staging_completed_at as "stagingCompletedAt",
        turn_row.pi_ready_at as "piReadyAt", turn_row.admitted_at as "admittedAt",
        turn_row.first_activity_at as "firstActivityAt", turn_row.settled_at as "settledAt",
        turn_row.claim_count as "claimCount"
      from public.companion_v3_turns turn_row
      join public.companion_v3_lane_leases lease
        on lease.org_id = turn_row.org_id and lease.companion_id = turn_row.companion_id
          and lease.lane = turn_row.lane
      where turn_row.command_id in (${first}::uuid, ${second}::uuid)
      order by turn_row.queue_sequence`;
    expect(facts.map(({ state, claimToken, assistantCount }) => ({
      state,
      claimToken,
      assistantCount,
    }))).toEqual([
      { state: "failed", claimToken: null, assistantCount: 0 },
      { state: "succeeded", claimToken: null, assistantCount: 1 },
    ]);
    for (const measured of facts) {
      expect(measured).toMatchObject({
        wakePath: "warm",
        boxProvider: "ascii",
        modelProvider: "anthropic",
        modelId: "claude-test",
        admissionKind: "prompt",
        claimCount: 1,
      });
      for (const timestamp of [
        measured.acceptedAt,
        measured.firstClaimedAt,
        measured.boxReadyAt,
        measured.stagingCompletedAt,
        measured.piReadyAt,
        measured.admittedAt,
        measured.firstActivityAt,
        measured.settledAt,
      ]) expect(timestamp).toBeInstanceOf(Date);
      expect(measured.admittedAt.getTime()).toBeGreaterThanOrEqual(measured.acceptedAt.getTime());
      expect(measured.settledAt.getTime()).toBeGreaterThanOrEqual(measured.admittedAt.getTime());
    }
    const report = await runtimeV3AcceptanceReport(runtimeSql, {
      since: new Date(Date.now() - 60_000),
      until: new Date(Date.now() + 60_000),
    });
    expect(report).toMatchObject({
      releaseMeasurementReady: true,
      correlation: { acknowledged: 2, complete: 2, missing: 0 },
      safety: { queued: 0, stalled: 0, takeovers: 0 },
      product: [expect.objectContaining({
        lane: "main",
        wakePath: "warm",
        boxProvider: "ascii",
        modelProvider: "anthropic",
        modelId: "claude-test",
        sampleCount: 2,
      })],
    });
    expect(JSON.stringify(report)).not.toMatch(
      /orgId|companionId|actorId|transcript|url|token|payload|invocation|eventId/i,
    );
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
