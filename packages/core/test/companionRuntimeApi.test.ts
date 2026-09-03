/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- Existing API fixtures predate the incremental anti-slop gate. */

import { describe, expect, it } from "vitest";

import type { Companion } from "@companion/contracts";
import {
  projectCompanionRuntime,
  type CompanionRuntimeApiProjection,
} from "../src/companionRuntimeApi";

const companion: Companion = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Research",
  persona: null,
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- icon catalogs use geometric domain terms
  icon: { shape: 1, mouth: 1, accessory: 1, color: 2 },
  model_id: "model-1",
  selected_skill_ids: [],
  can_write_skills: true,
  selected_mcp_account_ids: [],
  owner_id: "owner-1",
  access: "owner",
  pinned: false,
  hidden: false,
  muted: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 1,
    state: "not_created",
    daemon_state: "unknown",
    replying: false,
    box_id: null,
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 0,
    desktop_available: false,
    last_error: null,
    skills_revision: 3,
    skills_applied_revision: 0,
    skills_applied_at: null,
    skills_last_error: null,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
    lifecycle_intent: "prepare",
  },
  created_at: "2026-08-16T00:00:00.000Z",
  updated_at: "2026-08-16T00:00:00.000Z",
};

function runtime(
  patch: Partial<CompanionRuntimeApiProjection> = {},
): CompanionRuntimeApiProjection {
  return {
    access_role: "owner",
    generation: 1,
    selected_skill_ids: [],
    selected_mcp_account_ids: [],
    box_id: null,
    box_state: "absent",
    pi_state: "absent",
    pi_invocation_id: null,
    disk_layout_version: 0,
    desired_settings_revision: 1,
    applied_settings_revision: 0,
    applied_skills_revision: 0,
    skills_available_revision: 3,
    skills_update_error_message: null,
    retirement_state: "active",
    last_error_code: null,
    last_error_message: null,
    last_error_action: null,
    active_turn: null,
    queued_count: 0,
    interrupted_turn: null,
    lifecycle_intent: "prepare",
    is_replying: false,
    last_observed_at: null,
    ...patch,
  };
}

describe("Runtime v3 Companion projection", () => {
  it("projects the durable lifecycle intent without consulting Box", () => {
    const projected = projectCompanionRuntime(companion, runtime({
      lifecycle_intent: "recycle_pi",
    }));

    expect(projected.runtime).toMatchObject({
      state: "not_created",
      daemon_state: "stopped",
      box_id: null,
      desktop_available: false,
      lifecycle_intent: "recycle_pi",
    });
  });

  it("projects the ACKed replying fact and defaults it to false", () => {
    const replying = projectCompanionRuntime(companion, runtime({
      box_id: "bx_23456789",
      box_state: "running",
      pi_state: "running",
      is_replying: true,
    }));
    expect(replying.runtime.replying).toBe(true);

    const idle = projectCompanionRuntime(companion, runtime({ is_replying: false }));
    expect(idle.runtime.replying).toBe(false);
  });

  it("projects a ready Box and idle Pi as online with its applied skill revision", () => {
    const projected = projectCompanionRuntime(companion, runtime({
      generation: "9",
      selected_skill_ids: ["44444444-4444-4444-8444-444444444444"],
      selected_mcp_account_ids: ["55555555-5555-4555-8555-555555555555"],
      box_id: "bx_23456789",
      box_state: "ready",
      pi_state: "idle",
      disk_layout_version: 14,
      applied_skills_revision: 3,
      last_observed_at: "2026-08-16T00:02:00+00:00",
    }));

    expect(projected.runtime).toMatchObject({
      generation: 9,
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      disk_layout_version: 14,
      desktop_available: true,
      skills_applied_revision: 3,
      skills_applied_at: null,
    });
    expect(projected.selected_skill_ids).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(projected.selected_mcp_account_ids).toEqual([
      "55555555-5555-4555-8555-555555555555",
    ]);
  });

  it("preserves the deployable-stage Skill sync error and its Viewer redaction", () => {
    const owner = projectCompanionRuntime({
      ...companion,
      runtime: { ...companion.runtime, skills_last_error: "Box exec timed out" },
    }, runtime());
    const viewer = projectCompanionRuntime({
      ...companion,
      access: "viewer",
      // The second PostgreSQL read may observe an Editor -> Viewer downgrade after the first
      // projection returned operator detail, so the v3 projection must redact again.
      runtime: { ...companion.runtime, skills_last_error: "Box exec timed out" },
    }, runtime({ access_role: "viewer" }));

    expect(owner.runtime.skills_last_error).toBe("Box exec timed out");
    expect(viewer.runtime.skills_last_error).toBe("Skill sync failed.");
  });

  it("rejects a non-positive runtime generation at the projection boundary", () => {
    expect(() => projectCompanionRuntime(companion, runtime({ generation: 0 })))
      .toThrow("Companion runtime generation is invalid");
  });

  it("never exposes Box identity or operator error detail to a Viewer", () => {
    const projected = projectCompanionRuntime(
      { ...companion, access: "viewer" },
      runtime({
        access_role: "viewer",
        box_id: "bx_23456789",
        box_state: "error",
        pi_state: "error",
        last_error_code: "provider_unavailable",
        last_error_message: "private operator detail",
        last_error_action: "retry",
      }),
    );

    expect(projected.runtime.box_id).toBeNull();
    expect(projected.runtime.desktop_available).toBe(false);
    expect(projected.runtime.last_error).toBe("Companion runtime needs attention.");
  });

  it("distinguishes an archived Box from one never created", () => {
    const projected = projectCompanionRuntime(companion, runtime({
      box_id: "bx_23456789",
      box_state: "archived",
      pi_state: "stopped",
      lifecycle_intent: "archive",
    }));

    expect(projected.runtime.state).toBe("stopped");
  });

  it("normalizes an archived Box to the stopped client projection", () => {
    const projected = projectCompanionRuntime(companion, runtime({
      box_id: "bx_23456789",
      box_state: "archived",
      pi_state: "stopped",
    }));

    expect(projected.runtime.state).toBe("stopped");
    expect(projected.runtime.daemon_state).toBe("stopped");
    expect(projected.runtime.replying).toBe(false);
  });

  it("projects the instance failure without exposing its detail to Viewers", () => {
    const failure = {
      box_state: "error" as const,
      pi_state: "error" as const,
      last_error_code: "pi_crash_loop",
      last_error_message: "Pi could not stay running.",
      last_error_action: "retry",
    };
    const owner = projectCompanionRuntime(companion, runtime(failure));
    const viewer = projectCompanionRuntime(
      { ...companion, access: "viewer" },
      runtime({ access_role: "viewer", ...failure }),
    );

    expect(owner.runtime).toMatchObject({ state: "error", last_error: "Pi could not stay running." });
    expect(viewer.runtime).toMatchObject({
      state: "error",
      last_error: "Companion runtime needs attention.",
    });
  });

  it("keeps a healthy observed runtime online without synthesizing lifecycle history", () => {
    const projected = projectCompanionRuntime(companion, runtime({
      box_id: "bx_23456789",
      box_state: "idle",
      pi_state: "idle",
      pi_invocation_id: "pi-healthy",
      last_error_code: null,
      last_error_message: null,
    }));

    expect(projected.runtime).toMatchObject({
      state: "running",
      daemon_state: "running",
      last_error: null,
    });
  });

  it("projects the current instance error", () => {
    const projected = projectCompanionRuntime(companion, runtime({
      box_id: "bx_23456789",
      box_state: "ready",
      pi_state: "error",
      last_error_code: "pi_crash_loop",
      last_error_message: "Pi could not stay running.",
    }));

    expect(projected.runtime).toMatchObject({
      state: "error",
      last_error: "Pi could not stay running.",
    });
  });
});
