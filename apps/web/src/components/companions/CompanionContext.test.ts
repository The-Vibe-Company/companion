import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Companion, CompanionRoutine, CompanionTrigger } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { CompanionContext, type CompanionContextSkill } from "./CompanionContext";

/**
 * Product promise:
 * A member opening Companion details on a phone can identify every attached Skill, routine, and
 * trigger without entering an editor. Names, descriptions or schedules, providers, and text status
 * remain visible, while a Skill links to the existing Skills workspace.
 *
 * Regression caught:
 * The old compact panel rendered Skills as slug-only chips and hid routine and trigger status inside
 * mutation controls, so a read-only glance could not answer what was connected or active.
 *
 * Why this test is component-level:
 * The API shapes already contain the facts. This boundary proves the read view turns those facts into
 * links and visible labels without adding another endpoint.
 *
 * Failure proof:
 * Removing a description, status badge, provider label, or Skill href fails the assertions below.
 */

const companionId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";

const companion: Companion = {
  id: companionId,
  name: "Luna",
  persona: "Content marketing assistant",
  model_id: "claude-opus-4-8",
  selected_skill_ids: [skillId],
  can_write_skills: true,
  selected_mcp_account_ids: [],
  owner_id: "user-1",
  access: "owner",
  pinned: false,
  hidden: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 1,
    state: "stopped",
    daemon_state: "stopped",
    replying: false,
    box_id: null,
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 14,
    desktop_available: false,
    last_error: null,
    skills_revision: 2,
    skills_applied_revision: 2,
    skills_applied_at: "2026-08-26T09:00:00.000Z",
    skills_last_error: null,
    last_observed_at: "2026-08-26T09:00:00.000Z",
    last_started_at: null,
    last_stopped_at: "2026-08-26T09:00:00.000Z",
    lifecycle_intent: "prepare",
  },
  created_at: "2026-08-20T09:00:00.000Z",
  updated_at: "2026-08-26T09:00:00.000Z",
};

const skill: CompanionContextSkill = {
  id: skillId,
  slug: "launch-brief",
  description: "Turns product notes into a concise launch brief.",
  scope: "personal",
};

const routine: CompanionRoutine = {
  id: "33333333-3333-4333-8333-333333333333",
  companion_id: companionId,
  name: "Weekday brief",
  prompt: "Prepare the daily launch brief.",
  cron: "0 9 * * 1-5",
  timezone: "America/New_York",
  enabled: true,
  next_fire_at: "2026-08-27T13:00:00.000Z",
  last_fired_at: null,
  last_error_code: null,
  last_error_message: null,
  last_error_at: null,
  consecutive_failures: 0,
  created_at: "2026-08-20T09:00:00.000Z",
  updated_at: "2026-08-26T09:00:00.000Z",
};

const trigger: CompanionTrigger = {
  id: "44444444-4444-4444-8444-444444444444",
  companion_id: companionId,
  name: "Repository push",
  prompt: "Summarize the pushed changes.",
  mode: "notify",
  provider: "github",
  provider_account_id: null,
  target: { repo: "acme/companion", events: ["push"] },
  registration_status: "registered",
  remote_hook_account_id: null,
  remote_hook_id: null,
  last_registration_error: null,
  enabled: false,
  webhook_url: "https://example.test/v1/hooks/triggers/id/secret",
  last_fired_at: null,
  last_error_code: null,
  last_error_message: null,
  last_error_at: null,
  consecutive_failures: 0,
  created_at: "2026-08-20T09:00:00.000Z",
  updated_at: "2026-08-26T09:00:00.000Z",
};

function renderDetails({
  who = companion,
  skills = [skill],
  routines = [routine],
  triggers = [trigger],
}: {
  who?: Companion;
  skills?: CompanionContextSkill[];
  routines?: CompanionRoutine[];
  triggers?: CompanionTrigger[];
} = {}): string {
  return renderToStaticMarkup(React.createElement(CompanionContext, {
    companion: who,
    desktop: null,
    joining: false,
    error: null,
    openingDesktop: false,
    skills,
    orgId: "org-1",
    routines,
    onRoutinesChange: () => undefined,
    onOpenRoutineHistory: () => undefined,
    triggers,
    triggerAccounts: [{
      id: "account-1",
      provider: "github",
      label: "Acme GitHub",
      credential_source: "mcp_oauth",
      mcp_account_id: "44444444-4444-4444-8444-444444444444",
      status: "connected",
      dependent_trigger_count: 1,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    }],
    onTriggersChange: () => undefined,
    onJoin: () => undefined,
    onDesktop: () => undefined,
    onSettings: () => undefined,
    onClose: () => undefined,
  }));
}

describe("CompanionContext connected resources", () => {
  it("shows the details and status of each connected resource", () => {
    const markup = renderDetails();

    expect(markup).toContain("Companion details");
    expect(markup).toContain('href="/skills?skill=launch-brief"');
    expect(markup).toContain("launch-brief");
    expect(markup).toContain("Turns product notes into a concise launch brief.");
    expect(markup).toContain("Enabled");
    expect(markup).toContain("Weekday brief");
    expect(markup).toContain("0 9 * * 1-5");
    expect(markup).toContain("America/New_York");
    expect(markup).toContain("Active");
    expect(markup).toContain("Repository push");
    expect(markup).toContain("GitHub");
    expect(markup).toContain("Registered");
    expect(markup).toContain("Notify me");
    expect(markup).toContain("Disabled");
  });

  it("explains what will appear in every empty section", () => {
    const markup = renderDetails({
      who: { ...companion, selected_skill_ids: [] },
      skills: [],
      routines: [],
      triggers: [],
    });

    expect(markup).toContain("No Skills attached.");
    expect(markup).toContain("No routines connected.");
    expect(markup).toContain("No triggers connected.");
  });
});
