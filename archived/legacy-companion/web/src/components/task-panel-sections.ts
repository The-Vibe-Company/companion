/**
 * Section registry for the modular TaskPanel (right sidebar).
 *
 * Each section is identified by a stable `id` used for localStorage persistence.
 * The `backends` field controls which session types see the section.
 */

export interface TaskPanelSectionDef {
  /** Stable key used in persistence and configuration */
  id: string;
  /** Human-readable label shown in the configuration UI */
  label: string;
  /** Short description for the config UI */
  description: string;
  /** Which backends this section is relevant for. null = all */
  backends: ("claude" | "codex")[] | null;
}

export interface TaskPanelConfig {
  /** Ordered array of section IDs representing display order */
  order: string[];
  /** Map of section ID → enabled/disabled */
  enabled: Record<string, boolean>;
}

/** Canonical list of all sections in their default order. */
export const SECTION_DEFINITIONS: TaskPanelSectionDef[] = [
  {
    id: "usage-limits",
    label: "Usage Limits",
    description: "API usage and rate limit meters",
    backends: null,
  },
  {
    id: "git-branch",
    label: "Git Branch",
    description: "Current branch, ahead/behind, and line changes",
    backends: null,
  },
  {
    id: "github-pr",
    label: "GitHub PR",
    description: "Pull request status, CI checks, and reviews",
    backends: null,
  },
  {
    id: "linear-issue",
    label: "Linear Issue",
    description: "Linked Linear ticket and comments",
    backends: null,
  },
  {
    id: "mcp-servers",
    label: "MCP Servers",
    description: "Model Context Protocol server connections",
    backends: null,
  },
  {
    id: "tasks",
    label: "Tasks",
    description: "Agent task list and progress",
    backends: ["claude"],
  },
];

export const DEFAULT_SECTION_ORDER: string[] = SECTION_DEFINITIONS.map((s) => s.id);

const STORAGE_KEY = "cc-task-panel-config";

export function getDefaultConfig(): TaskPanelConfig {
  return {
    order: [...DEFAULT_SECTION_ORDER],
    enabled: Object.fromEntries(SECTION_DEFINITIONS.map((s) => [s.id, true])),
  };
}

/**
 * Load panel config from localStorage with forward-compat merge logic:
 * - New sections added since the config was saved get appended with enabled=true
 * - Removed sections are filtered out
 */
export function getInitialTaskPanelConfig(): TaskPanelConfig {
  if (typeof window === "undefined") return getDefaultConfig();
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as TaskPanelConfig;
      // Add any new sections not yet in the saved order
      const knownIds = new Set(parsed.order);
      for (const def of SECTION_DEFINITIONS) {
        if (!knownIds.has(def.id)) {
          parsed.order.push(def.id);
          parsed.enabled[def.id] = true;
        }
      }
      // Remove sections that no longer exist in the registry
      const validIds = new Set(SECTION_DEFINITIONS.map((d) => d.id));
      parsed.order = parsed.order.filter((id) => validIds.has(id));
      return parsed;
    }
  } catch {
    // corrupted — fall through to defaults
  }
  return getDefaultConfig();
}

export function persistTaskPanelConfig(config: TaskPanelConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // storage full or unavailable — ignore
  }
}
