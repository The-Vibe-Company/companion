/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Existing test harness predates the incremental anti-slop gate. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  bumpCompanionSkillAvailableRevision: vi.fn(async () => 2),
}));

const database = { tenant: true };
const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (
    _context: { orgId: string; userId: string },
    fn: (database: unknown) => Promise<unknown>,
  ) => fn(database)),
}));

vi.mock("@companion/core", () => coreMocks);
vi.mock("@companion/db", () => dbMocks);

import { syncPublishedSkillToOnlineCompanions } from "./companionSkillSync";

const actor = { id: "user-1", email: "owner@example.test", name: "Owner" };
const orgId = "00000000-0000-4000-8000-000000000001";
const skillId = "33333333-3333-4333-8333-333333333333";

describe("syncPublishedSkillToOnlineCompanions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only bumps the durable desired revision inside tenant context", async () => {
    await syncPublishedSkillToOnlineCompanions({
      orgId,
      skillId,
      actor,
      env: {
        COMPANION_COMPANIONS_ENABLED: "true",
        COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
      },
    });

    expect(dbMocks.withTenantContext).toHaveBeenCalledWith(
      { orgId, userId: actor.id },
      expect.any(Function),
    );
    expect(coreMocks.bumpCompanionSkillAvailableRevision).toHaveBeenCalledWith({
      orgId,
      skillId,
      database,
    });
  });

  it("persists the desired revision when Companions are disabled", async () => {
    await syncPublishedSkillToOnlineCompanions({
      orgId,
      skillId,
      actor,
      env: { COMPANION_COMPANIONS_ENABLED: "false" },
    });

    expect(dbMocks.withTenantContext).toHaveBeenCalledOnce();
    expect(coreMocks.bumpCompanionSkillAvailableRevision).toHaveBeenCalledWith({
      orgId,
      skillId,
      database,
    });
  });

  it("only uses the durable revision path even when a Box credential exists in the environment", async () => {
    await expect(syncPublishedSkillToOnlineCompanions({
      orgId,
      skillId,
      actor,
      env: {
        COMPANION_COMPANIONS_ENABLED: "true",
        COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
        COMPANION_BOX_API_KEY: "must-not-be-read",
      },
    })).resolves.toBeUndefined();

    expect(coreMocks.bumpCompanionSkillAvailableRevision).toHaveBeenCalledOnce();
  });
});
