import { bumpCompanionSkillAvailableRevision } from "@companion/core";
import type { ActorContext } from "@companion/core/services";
import { withTenantContext } from "@companion/db";

/**
 * Record a newer selected Skill version without making the next wake wait for it. Runtime v3
 * applies it only after a desired-state invalidation; this API path never contacts Box.
 */
export async function syncPublishedSkillToOnlineCompanions(input: {
  orgId: string;
  skillId: string;
  actor: ActorContext;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  // The kill switch blocks claims, not desired-state invalidations. Persist this revision even
  // while runtime execution is disabled so re-enable cannot treat a stale Box as current.
  await withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    (database) => bumpCompanionSkillAvailableRevision({
      orgId: input.orgId,
      skillId: input.skillId,
      database,
    }),
  );
}
