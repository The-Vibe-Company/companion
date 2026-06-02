// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  getInitialTaskPanelConfig,
  getDefaultConfig,
  SECTION_DEFINITIONS,
  DEFAULT_SECTION_ORDER,
} from "./task-panel-sections.js";

const STORAGE_KEY = "cc-task-panel-config";

beforeEach(() => {
  localStorage.clear();
});

describe("getDefaultConfig", () => {
  it("returns all sections enabled in default order", () => {
    const config = getDefaultConfig();
    expect(config.order).toEqual(DEFAULT_SECTION_ORDER);
    for (const def of SECTION_DEFINITIONS) {
      expect(config.enabled[def.id]).toBe(true);
    }
  });
});

describe("getInitialTaskPanelConfig", () => {
  it("returns defaults when localStorage is empty", () => {
    const config = getInitialTaskPanelConfig();
    expect(config).toEqual(getDefaultConfig());
  });

  it("restores a valid saved config from localStorage", () => {
    // Save a config with a custom order and one section disabled
    const saved = {
      order: ["tasks", "git-branch", "usage-limits", "github-pr", "linear-issue", "mcp-servers"],
      enabled: {
        "usage-limits": true,
        "git-branch": true,
        "github-pr": false,
        "linear-issue": true,
        "mcp-servers": true,
        "tasks": true,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const config = getInitialTaskPanelConfig();
    // Order should be preserved as-is since all IDs are still valid
    expect(config.order).toEqual(saved.order);
    // Disabled state should be preserved
    expect(config.enabled["github-pr"]).toBe(false);
    expect(config.enabled["tasks"]).toBe(true);
  });

  it("appends new sections that were added since the config was saved", () => {
    // Simulate a config saved before "tasks" and "mcp-servers" were added
    const saved = {
      order: ["usage-limits", "git-branch", "github-pr", "linear-issue"],
      enabled: {
        "usage-limits": true,
        "git-branch": false,
        "github-pr": true,
        "linear-issue": true,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const config = getInitialTaskPanelConfig();
    // The two missing sections should be appended at the end
    expect(config.order).toEqual([
      "usage-limits", "git-branch", "github-pr", "linear-issue",
      "mcp-servers", "tasks",
    ]);
    // New sections should be enabled by default
    expect(config.enabled["mcp-servers"]).toBe(true);
    expect(config.enabled["tasks"]).toBe(true);
    // Existing disabled state should be preserved
    expect(config.enabled["git-branch"]).toBe(false);
  });

  it("filters out removed sections that no longer exist in SECTION_DEFINITIONS", () => {
    // Simulate a saved config that includes a section ID that no longer exists
    const saved = {
      order: ["usage-limits", "old-removed-section", "git-branch", "github-pr", "linear-issue", "mcp-servers", "tasks"],
      enabled: {
        "usage-limits": true,
        "old-removed-section": true,
        "git-branch": true,
        "github-pr": true,
        "linear-issue": true,
        "mcp-servers": true,
        "tasks": true,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const config = getInitialTaskPanelConfig();
    // "old-removed-section" should be filtered out
    expect(config.order).not.toContain("old-removed-section");
    // All valid sections should remain in their saved order
    expect(config.order).toEqual([
      "usage-limits", "git-branch", "github-pr", "linear-issue", "mcp-servers", "tasks",
    ]);
  });

  it("handles both additions and removals simultaneously", () => {
    // Config has a removed section and is missing a new section
    const saved = {
      order: ["usage-limits", "deprecated-widget", "git-branch"],
      enabled: {
        "usage-limits": true,
        "deprecated-widget": true,
        "git-branch": true,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const config = getInitialTaskPanelConfig();
    // "deprecated-widget" filtered out, missing sections appended
    expect(config.order).not.toContain("deprecated-widget");
    expect(config.order[0]).toBe("usage-limits");
    expect(config.order[1]).toBe("git-branch");
    // The missing sections should be appended in their definition order
    expect(config.order).toContain("github-pr");
    expect(config.order).toContain("linear-issue");
    expect(config.order).toContain("mcp-servers");
    expect(config.order).toContain("tasks");
    expect(config.order.length).toBe(6);
  });

  it("returns defaults when localStorage contains corrupted JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not valid json {{{");

    const config = getInitialTaskPanelConfig();
    // Should gracefully fall back to defaults
    expect(config).toEqual(getDefaultConfig());
  });

  it("returns defaults when localStorage contains null-ish value", () => {
    // getItem returns null when key doesn't exist — already covered by "empty" test
    // But let's also test a stored empty string edge case
    localStorage.setItem(STORAGE_KEY, "");

    const config = getInitialTaskPanelConfig();
    expect(config).toEqual(getDefaultConfig());
  });
});
