/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Predates the incremental anti-slop gate; file reawakened by an unrelated budget/reliability edit, existing debt not rewritten here. */
import { describe, expect, it, vi } from "vitest";

import type { RuntimeServiceConfig } from "./config";
import {
  RUNTIME_DB_STATEMENT_TIMEOUT_MS,
  runtimeDatabasePoolOptions,
  verifyRuntimeDatabaseRole,
} from "./database";

const validProfile = {
  currentRole: "companion_runtime_v2",
  canLogin: true,
  isSuperuser: false,
  bypassesRls: false,
  inheritsPrivileges: false,
  hasMemberships: false,
  hasDatabaseCreatePrivilege: false,
  hasPublicSchemaCreatePrivilege: false,
  ownsDatabaseOrSchema: false,
  ownsRelations: false,
  ownsFunctionsOrTypes: false,
  protectedRelationCount: 18,
  hasPublicRelationPrivileges: false,
  requiredFunctionsReady: true,
  ownsRequiredFunctions: false,
  hasUnexpectedDefinerGrant: false,
};

describe("runtime database pool options", () => {
  const configWithConcurrency = (concurrency: number): RuntimeServiceConfig =>
    ({ concurrency } as unknown as RuntimeServiceConfig);

  it("sizes the pool for concurrency * 2 + 4", () => {
    expect(runtimeDatabasePoolOptions(configWithConcurrency(1)).max).toBe(6);
    expect(runtimeDatabasePoolOptions(configWithConcurrency(4)).max).toBe(12);
    expect(runtimeDatabasePoolOptions(configWithConcurrency(8)).max).toBe(20);
  });

  it("bounds statements and tags the connection", () => {
    const options = runtimeDatabasePoolOptions(configWithConcurrency(4));
    expect(options.connection?.statement_timeout).toBe(RUNTIME_DB_STATEMENT_TIMEOUT_MS);
    expect(RUNTIME_DB_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(options.connection?.application_name).toBe("companion-runtime");
  });

  it("keeps the existing idle and connect timeouts", () => {
    const options = runtimeDatabasePoolOptions(configWithConcurrency(4));
    expect(options.idle_timeout).toBe(30);
    expect(options.connect_timeout).toBe(10);
    expect(options.prepare).toBe(false);
  });
});

describe("runtime database role verification", () => {
  it("accepts only an isolated login with the exact narrow executor surface", async () => {
    let query = "";
    const unsafe = vi.fn(async (value: string) => {
      query = value;
      return [validProfile];
    });
    await expect(verifyRuntimeDatabaseRole(
      // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
      { unsafe } as never,
      "companion_runtime_v2",
    )).resolves.toBeUndefined();
    expect(unsafe).toHaveBeenCalledOnce();
    expect(query).toContain("pg_catalog.pg_auth_members");
    expect(query).toContain("has_database_privilege");
    expect(query).toContain("has_schema_privilege");
    expect(query).toContain("has_table_privilege");
    expect(query).toContain("companion_runtime_claim_work");
    expect(query).toContain("companion_runtime_renew_and_authorize");
    expect(query).toContain("companion_runtime_get_routine_material");
    expect(query).toContain("companion_routine_context_substrates");
    expect(query).toContain("companion_v3_runtime_claim");
    expect(query).toContain("companion_v3_runtime_complete");
    expect(query).toContain("companion_v3_lane_leases");
  });

  it.each([
    ["a different login", { currentRole: "companion_api" }, "login_mismatch"],
    ["a superuser", { isSuperuser: true }, "unsafe_role_attributes"],
    ["a BYPASSRLS role", { bypassesRls: true }, "unsafe_role_attributes"],
    ["an inheriting role", { inheritsPrivileges: true }, "unsafe_role_attributes"],
    ["a role membership", { hasMemberships: true }, "role_membership"],
    ["database CREATE", { hasDatabaseCreatePrivilege: true }, "create_privilege"],
    ["public schema CREATE", { hasPublicSchemaCreatePrivilege: true }, "create_privilege"],
    ["database or schema ownership", { ownsDatabaseOrSchema: true }, "object_ownership"],
    ["relation ownership", { ownsRelations: true }, "object_ownership"],
    ["function or type ownership", { ownsFunctionsOrTypes: true }, "object_ownership"],
    ["a partial protected schema", { protectedRelationCount: 9 }, "release_schema_incomplete"],
    ["a missing required function grant", { requiredFunctionsReady: false }, "release_schema_incomplete"],
    ["direct public relation access", { hasPublicRelationPrivileges: true }, "relation_privilege"],
    ["required function ownership", { ownsRequiredFunctions: true }, "required_function_ownership"],
    ["an extra definer grant", { hasUnexpectedDefinerGrant: true }, "unexpected_function_grant"],
  ])("rejects %s with a safe reason", async (_label, override, failure) => {
    // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => [{ ...validProfile, ...override }]),
    } as never, "companion_runtime_v2")).rejects.toMatchObject({
      name: "RuntimeDatabaseRoleError",
      failure,
      stableCode: `runtime_database_role_${failure}`,
    });
  });

  it("fails closed for a missing profile", async () => {
    // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => []),
    } as never, "companion_runtime_v2")).rejects.toMatchObject({ failure: "profile_unavailable" });
  });

  it("fails closed for a partial profile", async () => {
    const { hasMemberships: _missing, ...partial } = validProfile;
    // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => [partial]),
    } as never, "companion_runtime_v2")).rejects.toMatchObject({
      failure: "role_membership",
    });
  });

  it("does not include connection or role values in a mismatch error", async () => {
    const secretRole = "role-that-should-not-be-echoed";
    let message = "";
    try {
      // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
      await verifyRuntimeDatabaseRole({
        unsafe: vi.fn(async () => [{ ...validProfile, currentRole: "other" }]),
      } as never, secretRole);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretRole);
  });
});
