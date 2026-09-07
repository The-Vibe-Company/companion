/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Hosted Companion removal preserves the existing Skills Hub implementation; these patterns predate this change. */
import { describe, expect, it } from "vitest";
import type { OrgRole } from "@companion/contracts";
import {
  canAccessSkill,
  canAccessSkillDatabaseRealm,
  canManageOrg,
  canAccessSecret,
  canManageSecret,
  canManagePersonalSkill,
  canManagePublicSkill,
  canPerform,
  canTouchOwner,
  isLastOwner,
  isOrgAdmin,
  type Actor,
  type SkillAction,
  type SkillScopeRef,
} from "../src/index";

const actor = (orgRole: OrgRole): Actor => ({ orgRole });

/**
 * Skills are FLAT: there is no owner or visibility axis. The capability gate (`canPerform`) permits
 * EVERY skill action for ANY member, regardless of org role. The "can the actor SEE / TOUCH it?"
 * half is the membership gate (`assertMember` / RLS), exercised in the service-layer suites — a role
 * in org A never authorizes org B because the role passed here is always the actor's role in THAT org.
 * Only org governance (member/role management) keeps a role-sensitive capability gate.
 */

const SKILL_ACTIONS: SkillAction[] = [
  "skill.read",
  "skill.create",
  "skill.update",
  "skill.delete",
  "skill.publish",
];
const ROLES: OrgRole[] = ["owner", "admin", "developer"];

describe("canPerform — flat skill capability gate (every member ⇒ every action)", () => {
  const cases: Array<[OrgRole, SkillAction]> = ROLES.flatMap((role) =>
    SKILL_ACTIONS.map((action) => [role, action] as [OrgRole, SkillAction]),
  );
  it.each(cases)("org=%s action=%s -> allowed", (role, action) => {
    expect(canPerform(actor(role), action)).toBe(true);
  });

  it("the lowest role (developer) may read / create / update / delete / publish any skill", () => {
    for (const action of SKILL_ACTIONS) {
      expect(canPerform(actor("developer"), action)).toBe(true);
    }
  });
});

describe("canAccessSkill — personal-skill privacy (owner-only, NO admin override)", () => {
  const orgSkill: SkillScopeRef = { scope: "org", creatorId: "u-creator" };
  const personalSkill: SkillScopeRef = { scope: "personal", creatorId: "u-owner" };

  it("org skill is visible to any actor (creator or not)", () => {
    expect(canAccessSkill("u-owner", orgSkill)).toBe(true);
    expect(canAccessSkill("u-creator", orgSkill)).toBe(true);
    expect(canAccessSkill("u-stranger", orgSkill)).toBe(true);
  });

  it("personal skill is visible ONLY to its creator", () => {
    expect(canAccessSkill("u-owner", personalSkill)).toBe(true);
    expect(canAccessSkill("u-someone-else", personalSkill)).toBe(false);
  });

  it("an admin/owner who is NOT the creator still cannot see a personal skill", () => {
    // The load-bearing privacy assertion: scope wins, org role is irrelevant. "Only you see this library."
    expect(canAccessSkill("u-admin", personalSkill)).toBe(false);
  });
});

describe("canManagePersonalSkill — owner-only mutate (Share / personal-folder assign)", () => {
  it("only the creator of a personal skill may", () => {
    expect(canManagePersonalSkill("u-owner", { scope: "personal", creatorId: "u-owner" })).toBe(true);
    expect(canManagePersonalSkill("u-other", { scope: "personal", creatorId: "u-owner" })).toBe(false);
  });

  it("org skills are not managed through the personal gate", () => {
    expect(canManagePersonalSkill("u-creator", { scope: "org", creatorId: "u-creator" })).toBe(false);
  });
});

describe("canManagePublicSkill — exhaustive member × role × creator × scope matrix", () => {
  const cases = ([false, true] as const).flatMap((member) =>
    ROLES.flatMap((role) =>
      ([false, true] as const).flatMap((creator) =>
        (["org", "personal"] as const).map((scope) => ({ member, role, creator, scope })),
      ),
    ),
  );

  it.each(cases)(
    "member=$member role=$role creator=$creator scope=$scope",
    ({ member, role, creator, scope }) => {
      const actorId = "u-actor";
      const capability = canManagePublicSkill(
        { id: actorId, orgRole: role },
        { scope, creatorId: creator ? actorId : "u-creator" },
      );
      // The pure capability intentionally assumes membership; combine the tenant gate here so the
      // table proves a role in another org can never authorize the mutation.
      const allowed = member && capability;
      expect(allowed).toBe(member && scope === "org" && (creator || role === "owner" || role === "admin"));
    },
  );
});

describe("isOrgAdmin / canManageOrg (org governance survives the flattening)", () => {
  const cases: Array<[OrgRole, boolean]> = [
    ["owner", true],
    ["admin", true],
    ["developer", false],
  ];
  it.each(cases)("%s -> %s", (role, expected) => {
    expect(isOrgAdmin(role)).toBe(expected);
    expect(canManageOrg(role)).toBe(expected);
  });

  it("org rename / re-slug (updateOrg) is gated by canManageOrg (admin or owner only)", () => {
    expect(canManageOrg("owner")).toBe(true);
    expect(canManageOrg("admin")).toBe(true);
    expect(canManageOrg("developer")).toBe(false);
  });
});

describe("secret ACL — audience plus owner, never org role", () => {
  const base = { ownerId: "u-owner", disabledAt: null, deletedAt: null };
  it.each(ROLES)("%s has no implicit access to another member's personal secret", (_role) => {
    expect(canAccessSecret("u-admin", { ...base, audience: "personal" })).toBe(false);
    expect(canManageSecret("u-admin", base)).toBe(false);
  });
  it("allows explicit recipients and every current org member for organization secrets", () => {
    expect(canAccessSecret("u-recipient", { ...base, audience: "restricted", recipientIds: ["u-recipient"] })).toBe(true);
    expect(canAccessSecret("u-other", { ...base, audience: "restricted", recipientIds: ["u-recipient"] })).toBe(false);
    expect(canAccessSecret("u-other", { ...base, audience: "organization" })).toBe(true);
  });
  it("denies disabled and deleted secrets, including to their owner", () => {
    expect(canAccessSecret("u-owner", { ...base, audience: "personal", disabledAt: new Date() })).toBe(false);
    expect(canAccessSecret("u-owner", { ...base, audience: "personal", deletedAt: new Date() })).toBe(false);
  });

  const matrix = ROLES.flatMap((role) =>
    [false, true].flatMap((member) =>
      [false, true].flatMap((owner) =>
        (["personal", "restricted", "organization"] as const).map((audience) => ({ role, member, owner, audience })),
      ),
    ),
  );
  it.each(matrix)("membership=$member role=$role owner=$owner audience=$audience", ({ member, owner, audience }) => {
    const actorId = owner ? "u-owner" : "u-actor";
    const allowed = member && canAccessSecret(actorId, {
      ...base,
      audience,
      recipientIds: audience === "restricted" ? ["u-actor"] : [],
    });
    const expected = member && (owner || audience === "organization" || audience === "restricted");
    expect(allowed).toBe(expected);
    expect(member && canManageSecret(actorId, base)).toBe(member && owner);
  });
});

describe("skill database realm ACL — personal files have no admin override", () => {
  it("allows organization, owner, or an explicit grantee and denies an ungranted admin", () => {
    expect(canAccessSkillDatabaseRealm("u-admin", { audience: "organization", ownerId: null })).toBe(true);
    expect(canAccessSkillDatabaseRealm("u-owner", { audience: "personal", ownerId: "u-owner" })).toBe(true);
    expect(canAccessSkillDatabaseRealm("u-member", {
      audience: "personal",
      ownerId: "u-owner",
      sharedWithActor: true,
    })).toBe(true);
    expect(canAccessSkillDatabaseRealm("u-admin", { audience: "personal", ownerId: "u-owner" })).toBe(false);
  });
});

describe("canTouchOwner (grant / modify / remove the org owner role)", () => {
  it("only an owner may", () => {
    expect(canTouchOwner("owner")).toBe(true);
    expect(canTouchOwner("admin")).toBe(false);
    expect(canTouchOwner("developer")).toBe(false);
  });
});

describe("isLastOwner (an org must always keep at least one owner)", () => {
  it("blocks demoting / removing the sole owner", () => {
    expect(isLastOwner(1, true)).toBe(true);
    expect(isLastOwner(2, true)).toBe(false);
    expect(isLastOwner(1, false)).toBe(false);
  });
});
