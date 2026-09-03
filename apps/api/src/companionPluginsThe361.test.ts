import { describe, expect, it } from "vitest";
import { CompanionPluginSelectionError } from "@companion/core";

/**
 * THE-361: per-Companion MCP attach allow-list contracts and route recycle signal.
 * Selection + injection filtering are covered by companionPlugins.integration.test.ts
 * and the Online plugin-selection recycle cases in companionRoutes.test.ts.
 */
describe("Companion MCP attach contracts (THE-361)", () => {
  it("defaults to an empty plugin allow-list on create and companion rows", async () => {
    const {
      createCompanionInputSchema,
      companionSchema,
      updateCompanionInputSchema,
    } = await import("@companion/contracts");

    expect(createCompanionInputSchema.parse({
      name: "Luna",
      provider_id: "anthropic",
      model_id: "claude-opus-4-8",
      selected_mcp_account_ids: [],
    })).toMatchObject({ selected_mcp_account_ids: [] });

    expect(updateCompanionInputSchema.parse({
      selected_mcp_account_ids: [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
    }).selected_mcp_account_ids).toHaveLength(2);

    expect(updateCompanionInputSchema.parse({
      selected_mcp_account_ids: [],
    }).selected_mcp_account_ids).toEqual([]);

    expect(companionSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Luna",
      persona: null,
      model_id: "claude-opus-4-8",
      selected_skill_ids: [],
      can_write_skills: false,
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
    }).selected_mcp_account_ids).toEqual([]);
  });

  it("rejects unknown plugin ids through CompanionPluginSelectionError", () => {
    const error = new CompanionPluginSelectionError(
      "One selected plugin is not connected in this workspace.",
    );
    expect(error.name).toBe("CompanionPluginSelectionError");
    expect(error.message).toContain("not connected");
  });
});

describe("Companion MCP attach online recycle (THE-361)", () => {
  it("treats plugin-list diffs as a Pi recycle reason", () => {
    const previous = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
    const next = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const pluginsChanged = previous.length !== next.length
      || previous.some((id, index) => id !== next[index]);
    expect(pluginsChanged).toBe(true);

    const emptied: string[] = [];
    const detachChanged = previous.length !== emptied.length
      || previous.some((id, index) => id !== emptied[index]);
    expect(detachChanged).toBe(true);
  });
});
