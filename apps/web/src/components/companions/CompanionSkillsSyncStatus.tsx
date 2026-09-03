"use client";

import type { Companion } from "@companion/contracts";
import { StatusDot } from "../cds";
import { relativeTime } from "./status";

/**
 * One line answering "is the saved skill list effective on the Box yet", driven by the
 * desired/applied revision pair the API maintains. Settings never wake a sleeping Box, so a
 * pending selection on an asleep Box is a normal state with its own copy, not an error.
 */
export function CompanionSkillsSyncStatus({ companion }: { companion: Companion }) {
  const runtime = companion.runtime;
  const pending = runtime.skills_applied_revision < runtime.skills_revision;
  // A Companion that has never staged anything and selects nothing has nothing to report.
  if (
    pending
    && runtime.skills_applied_revision === 0
    && companion.selected_skill_ids.length === 0
    && !runtime.skills_last_error
  ) {
    return null;
  }

  let status: "ok" | "warn" | "unknown";
  let label: string;
  if (!pending) {
    status = "ok";
    label = runtime.skills_applied_at
      ? `Up to date on the Box · ${relativeTime(runtime.skills_applied_at)}`
      : "Up to date on the Box";
  } else if (runtime.skills_last_error) {
    status = "warn";
    label = `Box sync failed: ${runtime.skills_last_error} · retries on next Pi stop or restart`;
  } else if (runtime.lifecycle_intent === "recycle_pi" || runtime.state === "provisioning") {
    status = "unknown";
    label = "Applying to the Box...";
  } else {
    status = "unknown";
    label = "Update available · applies on next Pi stop or restart";
  }

  return (
    <p className="companions-skills-picker__sync" role="status" aria-live="polite">
      <StatusDot status={status} label={label} />
    </p>
  );
}
