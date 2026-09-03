/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This legacy module-isolation harness predates the incremental gate; THE-528 changes only its required Runtime v3 projection fixture. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompanionWriteSkillsForbiddenError } from "@companion/core";

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (
    _ctx: { orgId: string; userId: string },
    fn: (database: unknown) => Promise<unknown>,
  ) => fn({ tenant: true })),
}));

const coreMocks = vi.hoisted(() => ({
  assertCompanionTokenAuthorized: vi.fn(async () => undefined),
}));

vi.mock("@companion/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/db")>()),
  withTenantContext: dbMocks.withTenantContext,
}));

vi.mock("@companion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/core")>()),
  assertCompanionTokenAuthorized: coreMocks.assertCompanionTokenAuthorized,
}));

// The gate never touches Better Auth, so replace `@companion/auth` outright instead of spreading the
// original: importing it would pull better-auth and its Drizzle adapter into this file for nothing.
vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: vi.fn() }, $Infer: {} },
  authenticateAgentRequest: vi.fn(),
}));

// Load the module graph under test at collection time. `./context` reaches @companion/core and
// @companion/db, and a cold `await import("./context")` inside a test body spent more than the 5s
// default timeout on Node 20 CI runners (THE-363). Static imports run after the hoisted vi.mock
// calls above, so the mocks still apply — keep these imports static.
import { requireCompanionTokenStillAuthorized } from "./context";
import { companionSchema, createCompanionInputSchema } from "@companion/contracts";

function companionContext(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    tokenSourceType: "companion",
    tokenCompanionId: "11111111-1111-4111-8111-111111111111",
    tokenOrgId: "00000000-0000-4000-8000-000000000001",
    tokenActor: { id: "user-1", email: "owner@example.test", name: "Owner" },
    ...overrides,
  };
  return {
    get: (key: string) => (key in values ? values[key] : null),
  } as never;
}

describe("Companion-minted token gate", () => {
  beforeEach(() => {
    dbMocks.withTenantContext.mockClear();
    coreMocks.assertCompanionTokenAuthorized.mockReset();
    coreMocks.assertCompanionTokenAuthorized.mockResolvedValue(undefined);
  });

  it("skips the gate for non-companion tokens", async () => {
    await requireCompanionTokenStillAuthorized(companionContext({ tokenSourceType: "pat" }));
    expect(dbMocks.withTenantContext).not.toHaveBeenCalled();
  }, 15_000);

  it("re-checks the Companion inside the token owner's tenant context", async () => {
    await requireCompanionTokenStillAuthorized(companionContext());
    expect(dbMocks.withTenantContext).toHaveBeenCalledWith(
      { orgId: "00000000-0000-4000-8000-000000000001", userId: "user-1" },
      expect.any(Function),
    );
    expect(coreMocks.assertCompanionTokenAuthorized).toHaveBeenCalledWith({
      orgId: "00000000-0000-4000-8000-000000000001",
      companionId: "11111111-1111-4111-8111-111111111111",
      database: { tenant: true },
    });
  });

  it("rejects a token whose Companion the acting member can no longer see", async () => {
    coreMocks.assertCompanionTokenAuthorized.mockRejectedValue(
      new CompanionWriteSkillsForbiddenError(),
    );
    await expect(requireCompanionTokenStillAuthorized(companionContext()))
      .rejects.toBeInstanceOf(CompanionWriteSkillsForbiddenError);
  });

  it("fails closed when companion provenance is missing an actor for the RLS re-check", async () => {
    await expect(requireCompanionTokenStillAuthorized(companionContext({ tokenActor: null })))
      .rejects.toBeInstanceOf(CompanionWriteSkillsForbiddenError);
    expect(dbMocks.withTenantContext).not.toHaveBeenCalled();
  });
});

describe("Companion skill allow-list contracts", () => {
  it("accepts an empty selection and refuses a write-on-behalf choice", () => {
    expect(createCompanionInputSchema.parse({
      name: "Luna",
      provider_id: "anthropic",
      model_id: "claude-opus-4-8",
      selected_skill_ids: [],
    })).toMatchObject({
      selected_skill_ids: [],
    });
    // Skills Hub access is unconditional: creation cannot ask for less or more.
    expect(() => createCompanionInputSchema.parse({
      name: "Luna",
      provider_id: "anthropic",
      can_write_skills: false,
    })).toThrow();
    expect(companionSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Luna",
      persona: null,
      model_id: "claude-opus-4-8",
      selected_skill_ids: [],
      can_write_skills: true,
      selected_mcp_account_ids: [],
      owner_id: "user-1",
      access: "owner",
      pinned: false,
      hidden: false,
      unread: false,
      runtime: {
        generation: 1,
        state: "not_created",
        daemon_state: "unknown",
        box_id: null,
        provider_ids: ["anthropic"],
        provider_credential_generation: null,
        disk_layout_version: 1,
        desktop_available: false,
        last_error: null,
        skills_revision: 1,
        skills_applied_revision: 1,
        skills_applied_at: null,
        skills_last_error: null,
        last_observed_at: null,
        last_started_at: null,
        last_stopped_at: null,
        lifecycle_intent: "prepare",
      },
      created_at: "2026-08-14T12:00:00.000Z",
      updated_at: "2026-08-14T12:00:00.000Z",
    }).can_write_skills).toBe(true);
  });
});
