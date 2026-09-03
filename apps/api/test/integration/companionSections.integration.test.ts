import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import {
  assignCompanionSection,
  createCompanionSection,
  createCompanionWithRuntime,
  deleteCompanionSection,
  duplicateCompanionWithRuntime,
  listCompanionSections,
  reorderCompanionSections,
  saveCompanionProvider,
  setCompanionWorkspaceShare,
  updateCompanionMemberState,
} from "@companion/core";
import { schema, withTenantContext, type Db } from "@companion/db";

import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

const databaseFailureNodeSchema = z.object({
  code: z.string().optional(),
  cause: z.unknown().optional(),
}).passthrough();
type DatabaseFailure = Error & { code?: string; cause?: unknown };

function hasDatabaseCode(expected: string): (error: DatabaseFailure) => boolean {
  return (error) => {
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== null && !seen.has(current)) {
      const node = databaseFailureNodeSchema.safeParse(current);
      if (!node.success) break;
      seen.add(current);
      if (node.data.code === expected) return true;
      current = node.data.cause ?? null;
    }
    return false;
  };
}

/**
 * Sections organize an owner's roster without changing access or runtime ownership. These tests
 * cross the real tenant GUC and SECURITY DEFINER boundary so same-org admin override, cross-tenant
 * assignment, delete cascades, and reorder drift all fail visibly.
 */
describe("Companion sections", () => {
  let fixture: IntegrationFixture;
  let companionId: string;
  const masterKey = Buffer.alloc(32, 73);
  const apiDatabaseUrl = process.env.DATABASE_API_URL;
  const apiSql = apiDatabaseUrl ? postgres(apiDatabaseUrl, { max: 2 }) : null;
  const apiDb: Db | null = apiSql ? drizzle(apiSql, { schema }) : null;

  beforeAll(async () => {
    if (!apiSql) throw new Error("Companion section integration requires DATABASE_API_URL");
    const [session] = await apiSql<Array<{ role: string }>>`
      select current_user::text as role
    `;
    if (!session) throw new Error("Companion section integration could not resolve the API role");
    // Migration-protocol tests deliberately rewrite capability ACLs on the shared disposable
    // database. Reapply the production grant hook so this feature's RLS/capability assertions stay
    // order-independent and cover every existing capability used by its response projection.
    const grantsSource = await readFile(fileURLToPath(
      new URL("../../../../packages/db/runtime-role-grants.sql", import.meta.url),
    ), "utf8");
    const beginMarker = "-- companion-runtime-grants-begin";
    const endMarker = "-- companion-runtime-grants-end";
    const begin = grantsSource.indexOf(beginMarker);
    const end = grantsSource.indexOf(endMarker);
    if (begin < 0 || end <= begin) throw new Error("runtime grant hook markers are missing");
    const grantBlock = grantsSource.slice(begin + beginMarker.length, end).trim();
    const workerRole = process.env.DATABASE_WORKER_ROLE ?? "companion_worker";
    const runtimeRole = process.env.DATABASE_COMPANION_RUNTIME_ROLE ?? "companion_runtime_v2";
    const ownerDatabaseUrl = process.env.DATABASE_URL;
    if (!ownerDatabaseUrl) throw new Error("Companion section integration requires DATABASE_URL");
    const grantSql = postgres(ownerDatabaseUrl, { max: 1 });
    try {
      await grantSql`select
        set_config('companion.api_role', ${session.role}, false),
        set_config('companion.worker_role', ${workerRole}, false),
        set_config('companion.companion_runtime_role', ${runtimeRole}, false),
        set_config('companion.retired_runtime_role', '', false)`;
      await grantSql.unsafe(grantBlock);
    } finally {
      await grantSql.end();
    }
  });

  async function asActor<T>(actor: TestActor, action: (database: Db) => Promise<T>): Promise<T> {
    return withTenantContext({ orgId: fixture.orgA, userId: actor.id }, action);
  }

  async function asApiActor<T>(actor: TestActor, action: (database: Db) => Promise<T>): Promise<T> {
    if (!apiDb || !apiSql) throw new Error("Companion section integration requires DATABASE_API_URL");
    return apiDb.transaction(async (transaction) => {
      await transaction.execute(sql`select
        set_config('app.org_id', ${fixture.orgA}, true),
        set_config('app.user_id', ${actor.id}, true)`);
      return action(Object.assign(transaction, { $client: apiSql }));
    });
  }

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "section-provider-secret",
      masterKey,
      database: integrationDb,
    });
    companionId = (await asActor(fixture.developer, (database) => createCompanionWithRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Luna",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }))).id;
    await asActor(fixture.developer, (database) => setCompanionWorkspaceShare({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(
      // The fixture cleanup removes the organization too; this explicit delete keeps runtime
      // cleanup deterministic if an assertion fails between section operations.
      eq(schema.companions.orgId, fixture.orgA),
    );
    await fixture.cleanup();
  });

  afterAll(async () => {
    await apiSql?.end();
    await integrationSql.end();
  });

  it("exposes sections to the API role only through capability functions", async () => {
    const section = await asApiActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "API owned",
      database,
    }));
    expect((await asApiActor(fixture.developer, (database) => listCompanionSections({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database,
    }))).map((value) => value.id)).toContain(section.id);

    expect(await apiDb!.select().from(schema.companionSections)).toEqual([]);
    await expect(apiDb!.insert(schema.companionSections).values({
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "Bypass",
      position: 9,
    })).rejects.toSatisfy(hasDatabaseCode("42501"));
  });

  it("creates, assigns, lists, reorders, duplicates, and deletes without deleting Companions", async () => {
    const work = await asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Work",
      database,
    }));
    const personal = await asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Personal",
      database,
    }));
    const assigned = await asActor(fixture.developer, (database) => assignCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      sectionId: work.id,
      database,
    }));
    expect(assigned.section_id).toBe(work.id);

    const viewerSections = await asActor(fixture.admin, (database) => listCompanionSections({
      actor: fixture.admin,
      orgId: fixture.orgA,
      database,
    }));
    expect(viewerSections.map((section) => section.id)).toEqual([work.id]);

    const reordered = await asActor(fixture.developer, (database) => reorderCompanionSections({
      actor: fixture.developer,
      orgId: fixture.orgA,
      sectionIds: [personal.id, work.id],
      database,
    }));
    expect(reordered.filter((section) => section.owner_id === fixture.developer.id).map((section) => section.id))
      .toEqual([personal.id, work.id]);

    const duplicate = await asActor(fixture.developer, (database) => duplicateCompanionWithRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(duplicate.section_id).toBe(work.id);

    const unassigned = await asActor(fixture.developer, (database) => deleteCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      sectionId: work.id,
      database,
    }));
    expect(unassigned).toBe(2);
    const survivors = await integrationDb.query.companions.findMany({
      where: (row, { inArray }) => inArray(row.id, [companionId, duplicate.id]),
    });
    expect(survivors).toHaveLength(2);
    expect(survivors.every((row) => row.sectionId === null)).toBe(true);
  });

  it("keeps names unique per owner and rejects admin and cross-tenant assignment", async () => {
    const section = await asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Research",
      database,
    }));
    await expect(asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "research",
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("23505"));

    await expect(asActor(fixture.admin, (database) => assignCompanionSection({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      sectionId: section.id,
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("42501"));

    const foreignSection = await withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => createCompanionSection({
        actor: fixture.outsider,
        orgId: fixture.orgB,
        name: "Foreign",
        database,
      }),
    );
    await expect(asActor(fixture.developer, (database) => assignCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      sectionId: foreignSection.id,
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("P0002"));
    await expect(integrationSql`
      update public.companions set section_id = ${foreignSection.id}::uuid
      where id = ${companionId}::uuid
    `).rejects.toSatisfy(hasDatabaseCode("23503"));

    await expect(asActor(fixture.developer, (database) => reorderCompanionSections({
      actor: fixture.developer,
      orgId: fixture.orgA,
      sectionIds: [],
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("22023"));
  });

  it("keeps mute member-private and suppresses future notification deliveries", async () => {
    const deviceToken = "7".repeat(64);
    await integrationSql`
      insert into public.companion_notification_devices(
        org_id, installation_id, user_id, device_token, environment, bundle_id
      ) values (
        ${fixture.orgA}::uuid, gen_random_uuid(), ${fixture.developer.id}, ${deviceToken},
        'sandbox', 'dev.companion.mobile.dev'
      )
    `;
    const before = await integrationSql<{ inserted: number }[]>`
      select public.companion_notification_enqueue(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${fixture.developer.id},
        'before-mute', 'reply', 'Luna replied', 'Before mute'
      )::int as inserted
    `;
    expect(before[0]?.inserted).toBe(1);

    const muted = await asApiActor(fixture.developer, (database) => updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { muted: true },
      database,
    }));
    expect(muted.muted).toBe(true);
    expect(await integrationSql`
      select id from public.companion_notification_deliveries
      where org_id = ${fixture.orgA}::uuid and companion_id = ${companionId}::uuid
    `).toHaveLength(0);

    const after = await integrationSql<{ inserted: number }[]>`
      select public.companion_notification_enqueue(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${fixture.developer.id},
        'after-mute', 'reply', 'Luna replied', 'After mute'
      )::int as inserted
    `;
    expect(after[0]?.inserted).toBe(0);

    const viewer = await asActor(fixture.admin, (database) => updateCompanionMemberState({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      patch: { muted: false },
      database,
    }));
    expect(viewer.muted).toBe(false);
    expect((await asActor(fixture.developer, (database) => updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { muted: true },
      database,
    }))).muted).toBe(true);
  });

  it("serializes notification enqueue with a concurrent mute", async () => {
    const deviceToken = "8".repeat(64);
    await integrationSql`
      insert into public.companion_notification_devices(
        org_id, installation_id, user_id, device_token, environment, bundle_id
      ) values (
        ${fixture.orgA}::uuid, gen_random_uuid(), ${fixture.developer.id}, ${deviceToken},
        'sandbox', 'dev.companion.mobile.dev'
      )
    `;

    await integrationSql.begin(async (mutingTransaction) => {
      await mutingTransaction`select
        set_config('app.org_id', ${fixture.orgA}, true),
        set_config('app.user_id', ${fixture.developer.id}, true)`;
      await mutingTransaction`
        select public.companion_api_update_member_state_v2(
          ${fixture.orgA}::uuid, ${companionId}::uuid, null, null, true, null
        )
      `;

      await expect(integrationSql.begin(async (enqueueTransaction) => {
        await enqueueTransaction`set local lock_timeout = '100ms'`;
        return enqueueTransaction`
          select public.companion_notification_enqueue(
            ${fixture.orgA}::uuid, ${companionId}::uuid, ${fixture.developer.id},
            'concurrent-mute', 'reply', 'Luna replied', 'Concurrent mute'
          )
        `;
      })).rejects.toSatisfy(hasDatabaseCode("55P03"));
    });

    const after = await integrationSql<{ inserted: number }[]>`
      select public.companion_notification_enqueue(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${fixture.developer.id},
        'after-concurrent-mute', 'reply', 'Luna replied', 'After concurrent mute'
      )::int as inserted
    `;
    expect(after[0]?.inserted).toBe(0);
  });
});
