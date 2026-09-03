/**
 * Product promise:
 * PostgreSQL enforces organization isolation for the three non-bypass process roles. The API owns
 * authenticated control-plane access, the worker owns only background Skills Hub capabilities,
 * and Runtime v2 state is reachable only through the dedicated runtime functions.
 *
 * Regression caught:
 * dropping FORCE RLS, restoring the retired union executor, or granting a process direct access to
 * private runtime tables would let one tenant or process cross its durable boundary.
 *
 * Why integrated:
 * table owners and mocked query builders cannot prove PostgreSQL policies, role attributes, or
 * SECURITY DEFINER grants.
 *
 * Failure proof:
 * removing an organization predicate exposes the outsider fixture; widening a process grant flips
 * one of the exact capability assertions below.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";
import {
  createIntegrationFixture,
  integrationSql,
  seedSkill,
  type IntegrationFixture,
} from "./testDatabase";

interface DefaultAclEntry {
  schemaName: string | null;
  objectType: "TABLES" | "SEQUENCES" | "FUNCTIONS" | "TYPES" | "SCHEMAS";
  grantee: string;
  privilegeType: string;
  isGrantable: boolean;
}

const defaultAclObjectTypes = new Set<DefaultAclEntry["objectType"]>([
  "TABLES",
  "SEQUENCES",
  "FUNCTIONS",
  "TYPES",
  "SCHEMAS",
]);
const defaultAclPrivileges = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
  "USAGE",
  "EXECUTE",
  "CREATE",
]);

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function defaultAclPrefix(entry: Pick<DefaultAclEntry, "schemaName">): string {
  return `alter default privileges${entry.schemaName === null
    ? ""
    : ` in schema ${quotedIdentifier(entry.schemaName)}`}`;
}

function defaultAclGrantee(grantee: string): string {
  return grantee === "PUBLIC" ? "PUBLIC" : quotedIdentifier(grantee);
}

async function readMigrationOwnerDefaultAcl(): Promise<DefaultAclEntry[]> {
  return await integrationSql<DefaultAclEntry[]>`
    select namespace.nspname as "schemaName",
      case defaults.defaclobjtype
        when 'r' then 'TABLES'
        when 'S' then 'SEQUENCES'
        when 'f' then 'FUNCTIONS'
        when 'T' then 'TYPES'
        when 'n' then 'SCHEMAS'
      end as "objectType",
      case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
        as grantee,
      acl.privilege_type as "privilegeType",
      acl.is_grantable as "isGrantable"
    from pg_catalog.pg_default_acl defaults
    left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
    where defaults.defaclrole = (
      select role.oid from pg_catalog.pg_roles role where role.rolname = current_user
    )
      and (defaults.defaclnamespace = 0 or namespace.nspname = 'public')
    order by 1 nulls first, 2, 3, 4, 5
  `;
}

async function restoreMigrationOwnerDefaultAcl(snapshot: DefaultAclEntry[]): Promise<void> {
  const current = await readMigrationOwnerDefaultAcl();
  const resetTargets = new Map<string, Pick<DefaultAclEntry, "schemaName" | "objectType" | "grantee">>();
  for (const entry of [...current, ...snapshot]) {
    if (!defaultAclObjectTypes.has(entry.objectType)) {
      throw new Error(`unsupported default ACL object type: ${entry.objectType}`);
    }
    resetTargets.set(
      JSON.stringify([entry.schemaName, entry.objectType, entry.grantee]),
      entry,
    );
  }
  for (const entry of resetTargets.values()) {
    await integrationSql.unsafe(
      `${defaultAclPrefix(entry)} revoke all privileges on ${entry.objectType} from ${defaultAclGrantee(entry.grantee)}`,
    );
  }
  for (const entry of snapshot) {
    if (!defaultAclPrivileges.has(entry.privilegeType)) {
      throw new Error(`unsupported default ACL privilege: ${entry.privilegeType}`);
    }
    await integrationSql.unsafe(
      `${defaultAclPrefix(entry)} grant ${entry.privilegeType} on ${entry.objectType} to ${defaultAclGrantee(entry.grantee)}${entry.isGrantable ? " with grant option" : ""}`,
    );
  }
  expect(await readMigrationOwnerDefaultAcl()).toEqual(snapshot);
}

describe("Skills Hub PostgreSQL isolation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const apiRole = `companion_api_${suffix}`;
  const workerRole = `companion_worker_${suffix}`;
  const runtimeRole = `companion_runtime_${suffix}`;
  const processRoles = [apiRole, workerRole, runtimeRole];
  let fixture: IntegrationFixture;
  let defaultAclSnapshot: DefaultAclEntry[] = [];
  let defaultAclCaptured = false;
  let processRolesCreated = false;
  let grants = "";
  let personalSlug: string;
  let orgSlug: string;
  let otherOrgSlug: string;
  const ownerTokenPrefix = `cmp_owner_${suffix}`;
  const outsiderTokenPrefix = `cmp_out_${suffix}`;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    personalSlug = `private-${fixture.suffix}`;
    orgSlug = `org-${fixture.suffix}`;
    otherOrgSlug = `other-${fixture.suffix}`;
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: personalSlug, scope: "personal" });
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: orgSlug, scope: "org" });
    await seedSkill({ orgId: fixture.orgB, creator: fixture.outsider, slug: otherOrgSlug, scope: "org" });
    await integrationSql`
      insert into api_tokens (
        org_id, user_id, name, token_prefix, token_hash, scopes, source_type, expires_at
      ) values
        (
          ${fixture.orgA}, ${fixture.owner.id}, 'Owner fixture', ${ownerTokenPrefix},
          ${`hash-owner-${suffix}`}, '["skills:read"]'::jsonb, 'human',
          clock_timestamp() + interval '1 day'
        ),
        (
          ${fixture.orgB}, ${fixture.outsider.id}, 'Outsider fixture', ${outsiderTokenPrefix},
          ${`hash-outsider-${suffix}`}, '["skills:read"]'::jsonb, 'human',
          clock_timestamp() + interval '1 day'
        )
    `;

    await integrationSql.unsafe(`create role ${apiRole} login nosuperuser nobypassrls noinherit`);
    await integrationSql.unsafe(`create role ${workerRole} login nosuperuser nobypassrls noinherit`);
    await integrationSql.unsafe(`create role ${runtimeRole} login nosuperuser nobypassrls noinherit`);
    processRolesCreated = true;
    defaultAclSnapshot = await readMigrationOwnerDefaultAcl();
    defaultAclCaptured = true;
    grants = extractRuntimeRoleGrantBlock(
      await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
    );
    await integrationSql.begin(async (tx) => {
      await tx`select set_config('companion.api_role', ${apiRole}, true)`;
      await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
      await tx`select set_config('companion.companion_runtime_role', ${runtimeRole}, true)`;
      await tx.unsafe(grants);
    });
  });

  afterAll(async () => {
    await fixture?.cleanup();
    if (defaultAclCaptured) await restoreMigrationOwnerDefaultAcl(defaultAclSnapshot);
    if (processRolesCreated) {
      for (const role of processRoles) await integrationSql.unsafe(`drop owned by ${role}`);
      for (const role of processRoles) await integrationSql.unsafe(`drop role ${role}`);
    }
  });

  async function asApi<T>(input: {
    orgId: string;
    userId: string;
    action: (tx: postgres.TransactionSql) => PromiseLike<T>;
  }): Promise<T> {
    const wrapped = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${input.orgId}, true),
               set_config('app.user_id', ${input.userId}, true)
      `;
      return { value: await input.action(tx) };
    });
    return wrapped.value;
  }

  async function visibleSlugs(orgId: string, userId: string): Promise<string[]> {
    return asApi({
      orgId,
      userId,
      action: async (tx) => {
        const rows = await tx<Array<{ slug: string }>>`select slug from skills order by slug`;
        return rows.map((row) => row.slug);
      },
    });
  }

  it("shows only the selected tenant's Skills rows", async () => {
    expect(await visibleSlugs(fixture.orgA, fixture.owner.id)).toEqual([orgSlug, personalSlug].sort());
    expect(await visibleSlugs(fixture.orgB, fixture.outsider.id)).toEqual([otherOrgSlug]);
  });

  it("keeps authenticated token rows scoped to both tenant and actor", async () => {
    const ownerTokens = await asApi({
      orgId: fixture.orgA,
      userId: fixture.owner.id,
      action: (tx) => tx<Array<{ token_prefix: string }>>`
        select token_prefix from api_tokens order by token_prefix
      `,
    });
    expect(ownerTokens).toEqual([{ token_prefix: ownerTokenPrefix }]);

    const sameTenantPeerTokens = await asApi({
      orgId: fixture.orgA,
      userId: fixture.developer.id,
      action: (tx) => tx<Array<{ token_prefix: string }>>`select token_prefix from api_tokens`,
    });
    expect(sameTenantPeerTokens).toEqual([]);

    const outsiderTokens = await asApi({
      orgId: fixture.orgB,
      userId: fixture.outsider.id,
      action: (tx) => tx<Array<{ token_prefix: string }>>`select token_prefix from api_tokens`,
    });
    expect(outsiderTokens).toEqual([{ token_prefix: outsiderTokenPrefix }]);
  });

  it("keeps API, worker, and runtime grants on exact process boundaries", async () => {
    const [capabilities] = await integrationSql<Array<{
      apiFunctionByApi: boolean;
      apiFunctionByWorker: boolean;
      apiFunctionByRuntime: boolean;
      workerFunctionByApi: boolean;
      workerFunctionByWorker: boolean;
      workerFunctionByRuntime: boolean;
      runtimeFunctionByApi: boolean;
      runtimeFunctionByWorker: boolean;
      runtimeFunctionByRuntime: boolean;
      runtimeV3FunctionByRuntime: boolean;
      privateTableByApi: boolean;
      privateTableByWorker: boolean;
      privateTableByRuntime: boolean;
      authTableByApi: boolean;
      authTableByWorker: boolean;
      authTableByRuntime: boolean;
    }>>`
      select
        has_function_privilege(${apiRole}, 'public.companion_list_user_orgs(text)', 'EXECUTE') as "apiFunctionByApi",
        has_function_privilege(${workerRole}, 'public.companion_list_user_orgs(text)', 'EXECUTE') as "apiFunctionByWorker",
        has_function_privilege(${runtimeRole}, 'public.companion_list_user_orgs(text)', 'EXECUTE') as "apiFunctionByRuntime",
        has_function_privilege(${apiRole}, 'public.companion_claim_github_sync_destinations(text,integer,integer)', 'EXECUTE') as "workerFunctionByApi",
        has_function_privilege(${workerRole}, 'public.companion_claim_github_sync_destinations(text,integer,integer)', 'EXECUTE') as "workerFunctionByWorker",
        has_function_privilege(${runtimeRole}, 'public.companion_claim_github_sync_destinations(text,integer,integer)', 'EXECUTE') as "workerFunctionByRuntime",
        has_function_privilege(${apiRole}, 'public.companion_runtime_claim_work(text,integer,integer,bigint)', 'EXECUTE') as "runtimeFunctionByApi",
        has_function_privilege(${workerRole}, 'public.companion_runtime_claim_work(text,integer,integer,bigint)', 'EXECUTE') as "runtimeFunctionByWorker",
        has_function_privilege(${runtimeRole}, 'public.companion_runtime_claim_work(text,integer,integer,bigint)', 'EXECUTE') as "runtimeFunctionByRuntime",
        has_function_privilege(${runtimeRole}, 'public.companion_v3_runtime_claim_v4(text,public.companion_v3_lane,integer,integer)', 'EXECUTE') as "runtimeV3FunctionByRuntime",
        has_table_privilege(${apiRole}, 'public.companion_turns', 'SELECT') as "privateTableByApi",
        has_table_privilege(${workerRole}, 'public.companion_turns', 'SELECT') as "privateTableByWorker",
        has_table_privilege(${runtimeRole}, 'public.companion_turns', 'SELECT') as "privateTableByRuntime",
        has_table_privilege(${apiRole}, 'public.user', 'SELECT') as "authTableByApi",
        has_table_privilege(${workerRole}, 'public.user', 'SELECT') as "authTableByWorker",
        has_table_privilege(${runtimeRole}, 'public.user', 'SELECT') as "authTableByRuntime"
    `;

    expect(capabilities).toEqual({
      apiFunctionByApi: true,
      apiFunctionByWorker: false,
      apiFunctionByRuntime: false,
      workerFunctionByApi: false,
      workerFunctionByWorker: true,
      workerFunctionByRuntime: false,
      runtimeFunctionByApi: false,
      runtimeFunctionByWorker: false,
      runtimeFunctionByRuntime: false,
      runtimeV3FunctionByRuntime: true,
      privateTableByApi: false,
      privateTableByWorker: false,
      privateTableByRuntime: false,
      authTableByApi: true,
      authTableByWorker: false,
      authTableByRuntime: false,
    });
  });

  it("lets admins manage provider ciphertext while tenant members see only selected metadata", async () => {
    await asApi({
      orgId: fixture.orgA,
      userId: fixture.admin.id,
      action: async (tx) => {
        await tx`
          insert into companion_provider_connections (
            org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
            wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
          ) values (
            ${fixture.orgA}, 'anthropic', 'api_key', 'ciphertext', 'iv', 'tag',
            'dek', 'wrap-iv', 'wrap-tag', 'key-id', ${fixture.admin.id}
          )
        `;
      },
    });

    const developerVisible = await asApi({
      orgId: fixture.orgA,
      userId: fixture.developer.id,
      action: (tx) => tx<Array<{ provider_id: string; auth_method: string }>>`
        select provider_id, auth_method from companion_provider_connections
      `,
    });
    expect(developerVisible).toEqual([{ provider_id: "anthropic", auth_method: "api_key" }]);

    await expect(asApi({
      orgId: fixture.orgA,
      userId: fixture.developer.id,
      action: async (tx) => {
        await tx`
          insert into companion_provider_connections (
            org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
            wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
          ) values (
            ${fixture.orgA}, 'zai', 'api_key', 'ciphertext', 'iv', 'tag',
            'dek', 'wrap-iv', 'wrap-tag', 'key-id', ${fixture.developer.id}
          )
        `;
      },
    })).rejects.toThrow();

    const outsiderVisible = await asApi({
      orgId: fixture.orgB,
      userId: fixture.outsider.id,
      action: (tx) => tx<Array<{ provider_id: string }>>`
        select provider_id from companion_provider_connections
      `,
    });
    expect(outsiderVisible).toEqual([]);
  });

  it("keeps retired per-member Companion grants absent", async () => {
    const [row] = await integrationSql<Array<{ exists: boolean }>>`
      select to_regclass('public.companion_member_access') is not null as exists
    `;
    expect(row).toEqual({ exists: false });
  });
});
