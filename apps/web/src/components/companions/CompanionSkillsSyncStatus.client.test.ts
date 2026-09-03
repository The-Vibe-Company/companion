/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Existing DOM test fixture predates the incremental anti-slop gate. */

// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Companion } from "@companion/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionSkillsSyncStatus } from "./CompanionSkillsSyncStatus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function companion(overrides: {
  selected?: string[];
  state?: Companion["runtime"]["state"];
  revision?: number;
  applied?: number;
  appliedAt?: string | null;
  error?: string | null;
} = {}): Companion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Luna",
    persona: null,
    model_id: "claude-opus-4-8",
    selected_skill_ids: overrides.selected ?? ["33333333-3333-4333-8333-333333333333"],
    can_write_skills: false,
    selected_mcp_account_ids: [],
    owner_id: "user-1",
    access: "owner",
    pinned: false,
    hidden: false,
    unread: false,
    last_message: null,
    runtime: {
      generation: 1,
      state: overrides.state ?? "stopped",
      daemon_state: "stopped",
      replying: false,
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
      desktop_available: false,
      last_error: null,
      skills_revision: overrides.revision ?? 2,
      skills_applied_revision: overrides.applied ?? 2,
      skills_applied_at: overrides.appliedAt === undefined
        ? "2026-08-15T09:00:00.000Z"
        : overrides.appliedAt,
      skills_last_error: overrides.error ?? null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
      lifecycle_intent: "prepare",
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  };
}

const roots: Root[] = [];

function render(value: Companion) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(React.createElement(CompanionSkillsSyncStatus, { companion: value }));
  });
  return container;
}

describe("CompanionSkillsSyncStatus", () => {
  afterEach(() => {
    while (roots.length) {
      const root = roots.pop();
      act(() => root?.unmount());
    }
    document.body.replaceChildren();
  });

  it("reads up to date with the applied time once the revisions meet", () => {
    const markup = render(companion());
    expect(markup.textContent).toContain("Up to date on the Box");
    expect(markup.querySelector(".cds-status--ok")).not.toBeNull();
  });

  it("explains a pending publication as applying on the next Pi shutdown", () => {
    const markup = render(companion({ revision: 3, applied: 2, state: "stopped" }));
    expect(markup.textContent).toContain("applies on next Pi stop or restart");
    expect(markup.querySelector(".cds-status--unknown")).not.toBeNull();
  });

  it("does not claim that a simple running wake is applying the publication", () => {
    const markup = render(companion({ revision: 3, applied: 2, state: "running" }));
    expect(markup.textContent).toContain("applies on next Pi stop or restart");
  });

  it("surfaces a recorded restage failure with its retry path", () => {
    const markup = render(companion({ revision: 3, applied: 2, error: "Box exec timed out" }));
    expect(markup.textContent).toContain("Box sync failed: Box exec timed out");
    expect(markup.textContent).toContain("retries on next Pi stop or restart");
  });

  it("stays silent for a Companion that never staged and selects nothing", () => {
    const markup = render(companion({ revision: 1, applied: 0, selected: [], appliedAt: null }));
    expect(markup.textContent).toBe("");
  });
});
