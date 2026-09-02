/**
 * Product promise: Runtime v3 keeps FIFO, lane independence, and executor fencing as PostgreSQL
 * facts while callers use the closed TypeScript progression interface. The v2 executor and direct
 * process-role table access cannot claim or mutate these dormant rows.
 *
 * Why integrated: FORCE RLS, split grants, SKIP LOCKED, and monotonic takeover epochs only exist in
 * a real migrated PostgreSQL database. An in-memory adapter cannot prove them.
 */
import { randomUUID } from "node:crypto";
import {
  createRuntimeV3Progression,
  type RuntimeV3ProgressionPersistence,
} from "@companion/companion-runtime/v3/internal";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeV3PostgresPersistence } from "../../src/runtimeV3ProgressionStore";

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

describe("dormant Runtime v3 progression facts", () => {
  beforeAll(async () => {
    const [apiRows, workerRows, runtimeRows] = await Promise.all([
      apiSql<Array<{ currentUser: string }>>`select current_user as "currentUser"`,
      workerSql<Array<{ currentUser: string }>>`select current_user as "currentUser"`,
      runtimeSql<Array<{ currentUser: string }>>`select current_user as "currentUser"`,
    ]);
    apiRole = apiRows[0]!.currentUser;
    workerRole = workerRows[0]!.currentUser;
    runtimeRole = runtimeRows[0]!.currentUser;
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
    }>>`
      select command_id as "commandId", lane::text, turn_id as "turnId",
        claim_token as token, claim_epoch::text as epoch
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
    await runtimeSql`select public.companion_v3_runtime_complete(
      ${ids.org}::uuid, ${ids.companion}::uuid, 'main', ${mainClaim[0]!.turnId}::uuid,
      ${mainClaim[0]!.token}::uuid, ${mainClaim[0]!.epoch}::bigint,
      'succeeded', null, null, 3
    )`;
    const nextMain = await runtimeSql<Array<{ commandId: string }>>`
      select command_id as "commandId"
      from public.companion_v3_runtime_claim('runtime-a', 'main', 30, 3)`;
    expect(nextMain).toEqual([{ commandId: mainTwo }]);
  });

  it("increments lane fences monotonically and rejects stale completion", async () => {
    await admitMain(randomUUID());
    const first = await runtimeSql<Array<{ token: string; epoch: string; turnId: string }>>`
      select claim_token as token, claim_epoch::text as epoch, turn_id as "turnId"
      from public.companion_v3_runtime_claim('runtime-c', 'main', 1, 3)`;
    await ownerSql`select pg_sleep(1.1)`;
    const second = await runtimeSql<Array<{ token: string; epoch: string; turnId: string }>>`
      select claim_token as token, claim_epoch::text as epoch, turn_id as "turnId"
      from public.companion_v3_runtime_claim('runtime-d', 'main', 30, 3)`;

    expect(BigInt(second[0]!.epoch)).toBeGreaterThan(BigInt(first[0]!.epoch));
    const stale = await runtimeSql<Array<{ completed: boolean }>>`
      select public.companion_v3_runtime_complete(
        ${ids.org}::uuid, ${ids.companion}::uuid, 'main', ${first[0]!.turnId}::uuid,
        ${first[0]!.token}::uuid, ${first[0]!.epoch}::bigint, 'release', null, null, 3
      ) as completed`;
    expect(stale[0]!.completed).toBe(false);
  });

  it("drives PostgreSQL claims through the closed progression interface", async () => {
    await admitMain(randomUUID());
    const persistence: RuntimeV3ProgressionPersistence = createRuntimeV3PostgresPersistence(runtimeSql);
    const progression = createRuntimeV3Progression({
      persistence,
      advance: async () => ({ kind: "succeeded" }),
    });

    await expect(progression.converge({ executorId: "runtime-progression" }))
      .resolves.toEqual({ progressed: 1, exhausted: false });
  });

  it("progresses an available background lane without waiting for main", async () => {
    const main = randomUUID();
    const background = randomUUID();
    await admitMain(main);
    await workerSql`select * from public.companion_v3_worker_admit_turn(
      ${ids.org}::uuid, ${ids.companion}::uuid, ${background}::uuid,
      ${`msg:${background}`}, ${ids.owner}
    )`;
    let releaseMain!: () => void;
    const mainWait = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    const progression = createRuntimeV3Progression({
      persistence: createRuntimeV3PostgresPersistence(runtimeSql),
      advance: async (claim) => {
        if (claim.turn.lane === "main") await mainWait;
        return { kind: "succeeded" };
      },
    });

    const convergence = progression.converge({ executorId: "runtime-independent-lanes" });
    await vi.waitFor(async () => {
      const rows = await ownerSql<Array<{ state: string }>>`
        select state::text from public.companion_v3_turns
        where companion_id = ${ids.companion}::uuid and command_id = ${background}::uuid`;
      expect(rows).toEqual([{ state: "succeeded" }]);
    });
    releaseMain();
    await expect(convergence).resolves.toEqual({ progressed: 2, exhausted: false });
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

  it("keeps dormant work non-activatable while the existing runtime gate is disabled", async () => {
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
