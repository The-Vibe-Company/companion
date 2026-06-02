import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as agentStore from "./agent-store.js";
import type { CronJob } from "./cron-types.js";
import { COMPANION_HOME } from "./paths.js";

const CRON_DIR = join(COMPANION_HOME, "cron");
const MIGRATION_FLAG = join(COMPANION_HOME, ".cron-migrated");

/**
 * One-time migration: convert existing cron jobs into agents with schedule triggers.
 * Safe to call multiple times — only runs once (uses a flag file).
 */
export function migrateCronJobsToAgents(): { migrated: number; skipped: number } {
  // Skip if already migrated
  if (existsSync(MIGRATION_FLAG)) {
    return { migrated: 0, skipped: 0 };
  }

  // Skip if no cron directory
  if (!existsSync(CRON_DIR)) {
    // Mark as migrated (nothing to migrate)
    writeFileSync(MIGRATION_FLAG, new Date().toISOString(), "utf-8");
    return { migrated: 0, skipped: 0 };
  }

  const files = readdirSync(CRON_DIR).filter((f) => f.endsWith(".json"));
  let migrated = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(join(CRON_DIR, file), "utf-8");
      const job: CronJob = JSON.parse(raw);

      // Check if an agent with this name already exists
      const existingAgents = agentStore.listAgents();
      const alreadyExists = existingAgents.some(
        (a) => a.name.toLowerCase() === job.name.toLowerCase(),
      );
      if (alreadyExists) {
        console.log(`[cron-migrator] Skipping "${job.name}" — agent with same name already exists`);
        skipped++;
        continue;
      }

      agentStore.createAgent({
        version: 1,
        name: job.name,
        description: `Migrated from scheduled job: ${job.name}`,
        icon: "⏰",
        backendType: job.backendType,
        model: job.model,
        permissionMode: job.permissionMode,
        cwd: job.cwd,
        envSlug: job.envSlug,
        codexInternetAccess: job.codexInternetAccess,
        prompt: job.prompt,
        triggers: {
          schedule: {
            enabled: job.enabled,
            expression: job.schedule,
            recurring: job.recurring,
          },
        },
        enabled: job.enabled,
      });

      migrated++;
      console.log(`[cron-migrator] Migrated cron job "${job.name}" to agent`);
    } catch (err) {
      console.error(`[cron-migrator] Failed to migrate ${file}:`, err);
      skipped++;
    }
  }

  // Mark migration as complete
  writeFileSync(MIGRATION_FLAG, new Date().toISOString(), "utf-8");

  if (migrated > 0 || skipped > 0) {
    console.log(`[cron-migrator] Migration complete: ${migrated} migrated, ${skipped} skipped`);
  }

  return { migrated, skipped };
}
