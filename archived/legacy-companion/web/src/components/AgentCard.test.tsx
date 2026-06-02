// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentInfo } from "../api.js";

// Mock LinearLogo since it's an SVG component
vi.mock("./LinearLogo.js", () => ({
  LinearLogo: (props: Record<string, unknown>) => (
    <svg data-testid="linear-logo" {...props} />
  ),
}));

import { AgentCard, humanizeSchedule, getWebhookUrl } from "./AgentCard.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Creates a minimal AgentInfo with sensible defaults, allowing overrides. */
function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    version: 1,
    name: "Test Agent",
    description: "A test agent",
    icon: "",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    cwd: "/workspace",
    prompt: "Do the thing",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    triggers: {
      webhook: { enabled: false, secret: "" },
      schedule: { enabled: false, expression: "0 8 * * *", recurring: true },
    },
    ...overrides,
  };
}

function makeProps(overrides: Partial<Parameters<typeof AgentCard>[0]> = {}) {
  return {
    agent: makeAgent(),
    publicUrl: "",
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
    onRun: vi.fn(),
    onExport: vi.fn(),
    onCopyWebhook: vi.fn(),
    onRegenerateSecret: vi.fn(),
    copiedWebhook: null as string | null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentCard", () => {
  // ── Render Tests ──────────────────────────────────────────────────────────

  // Test 1: Basic rendering with agent name and description
  it("renders agent name and description", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ name: "My Agent", description: "Does things" }),
    })} />);

    expect(screen.getByText("My Agent")).toBeInTheDocument();
    expect(screen.getByText("Does things")).toBeInTheDocument();
  });

  // Test 2: Status dot is green when enabled
  it("shows green status dot when agent is enabled", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ enabled: true }),
    })} />);

    const dot = screen.getByTestId("status-dot");
    expect(dot.className).toContain("bg-cc-success");
    expect(dot).toHaveAttribute("title", "Enabled");
  });

  // Test 3: Status dot is gray when disabled
  it("shows gray status dot when agent is disabled", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ enabled: false }),
    })} />);

    const dot = screen.getByTestId("status-dot");
    expect(dot.className).toContain("bg-cc-muted");
    expect(dot).toHaveAttribute("title", "Disabled");
  });

  // Test 4: Shows Claude backend badge
  it("shows 'Claude' badge for claude backend type", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ backendType: "claude" }),
    })} />);

    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  // Test 5: Shows Codex backend badge
  it("shows 'Codex' badge for codex backend type", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ backendType: "codex" }),
    })} />);

    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  // Test 6: Linear badge present when linear trigger is enabled
  it("shows Linear badge when linear trigger is enabled", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({
        triggers: {
          linear: { enabled: true, oauthClientId: "c1", hasAccessToken: true },
        },
      }),
    })} />);

    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.getByTestId("linear-logo")).toBeInTheDocument();
  });

  // Test 7: Linear badge absent when no linear trigger
  it("does not show Linear badge when linear trigger is not enabled", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({
        triggers: { webhook: { enabled: false, secret: "" } },
      }),
    })} />);

    expect(screen.queryByText("Linear")).not.toBeInTheDocument();
  });

  // Test 8: Description not rendered when empty
  it("does not render description when it is empty", () => {
    const { container } = render(<AgentCard {...makeProps({
      agent: makeAgent({ description: "" }),
    })} />);

    // No <p> with description class should exist
    const descP = container.querySelector("p.text-xs.text-cc-muted.mt-0\\.5");
    expect(descP).toBeNull();
  });

  // ── Action Tests ──────────────────────────────────────────────────────────

  // Test 9: Run button calls onRun
  it("clicking Run button calls onRun", () => {
    const props = makeProps();
    render(<AgentCard {...props} />);
    fireEvent.click(screen.getByText("Run"));
    expect(props.onRun).toHaveBeenCalledTimes(1);
  });

  // Test 10: Overflow menu is present (three-dot button)
  it("overflow menu trigger is present", () => {
    render(<AgentCard {...makeProps()} />);
    expect(screen.getByLabelText("More actions")).toBeInTheDocument();
  });

  // ── Trigger Badges ────────────────────────────────────────────────────────

  // Test 11: Manual trigger badge is always shown
  it("always shows 'Manual' trigger badge", () => {
    render(<AgentCard {...makeProps()} />);
    expect(screen.getByText("Manual")).toBeInTheDocument();
  });

  // Test 12: Webhook trigger badge shown when enabled
  it("shows 'Webhook' trigger badge when webhook is enabled", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({
        triggers: { webhook: { enabled: true, secret: "abc" } },
      }),
    })} />);

    expect(screen.getByText("Webhook")).toBeInTheDocument();
  });

  // Test 13: Schedule trigger badge with humanized text
  it("shows humanized schedule badge when schedule is enabled", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({
        triggers: {
          webhook: { enabled: false, secret: "" },
          schedule: { enabled: true, expression: "0 8 * * *", recurring: true },
        },
      }),
    })} />);

    expect(screen.getByText("Daily at 8:00 AM")).toBeInTheDocument();
  });

  // Test 14: Linear Agent trigger badge when linear is enabled
  it("shows 'Linear Agent' trigger badge when linear is enabled", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({
        triggers: {
          linear: { enabled: true, oauthClientId: "c1", hasAccessToken: true },
        },
      }),
    })} />);

    expect(screen.getByText("Linear Agent")).toBeInTheDocument();
  });

  // ── Stats ─────────────────────────────────────────────────────────────────

  // Test 15: Run count displayed correctly (plural)
  it("shows run count with plural 'runs'", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ totalRuns: 5 }),
    })} />);

    expect(screen.getByText("5 runs")).toBeInTheDocument();
  });

  // Test 16: Run count singular
  it("shows singular 'run' for exactly 1 run", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ totalRuns: 1 }),
    })} />);

    expect(screen.getByText("1 run")).toBeInTheDocument();
  });

  // Test 17: No run count when totalRuns is 0
  it("does not show run count when totalRuns is 0", () => {
    render(<AgentCard {...makeProps({
      agent: makeAgent({ totalRuns: 0 }),
    })} />);

    expect(screen.queryByText(/\d+ runs?/)).not.toBeInTheDocument();
  });

  // ── Disabled state ────────────────────────────────────────────────────────

  // Test 18: Disabled agent card has reduced opacity
  it("disabled agent card has reduced opacity class", () => {
    const { container } = render(<AgentCard {...makeProps({
      agent: makeAgent({ enabled: false }),
    })} />);

    const card = container.firstElementChild;
    expect(card?.className).toContain("opacity-75");
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  // Test 19: Accessibility scan — enabled agent
  it("passes axe accessibility checks for enabled agent", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AgentCard {...makeProps({
      agent: makeAgent({ enabled: true, name: "Accessible Agent" }),
    })} />);

    const results = await axe(container, {
      rules: {
        // Agent card uses h3 directly (heading-order skip)
        "heading-order": { enabled: false },
      },
    });
    expect(results).toHaveNoViolations();
  });

  // Test 20: Accessibility scan — disabled agent
  it("passes axe accessibility checks for disabled agent", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AgentCard {...makeProps({
      agent: makeAgent({ enabled: false, name: "Disabled Agent" }),
    })} />);

    const results = await axe(container, {
      rules: {
        "heading-order": { enabled: false },
      },
    });
    expect(results).toHaveNoViolations();
  });
});

// ─── Helper Function Tests ──────────────────────────────────────────────────

describe("humanizeSchedule", () => {
  it("returns 'One-time' for non-recurring", () => {
    expect(humanizeSchedule("2026-04-01T10:00", false)).toBe("One-time");
  });

  it("returns 'Every minute' for * * * * *", () => {
    expect(humanizeSchedule("* * * * *", true)).toBe("Every minute");
  });

  it("returns 'Every N minutes' for */N pattern", () => {
    expect(humanizeSchedule("*/30 * * * *", true)).toBe("Every 30 minutes");
  });

  it("returns 'Every minute' for */1", () => {
    expect(humanizeSchedule("*/1 * * * *", true)).toBe("Every minute");
  });

  it("returns 'Every hour' for 0 * * * *", () => {
    expect(humanizeSchedule("0 * * * *", true)).toBe("Every hour");
  });

  it("returns 'Every N hours' for 0 */N * * *", () => {
    expect(humanizeSchedule("0 */3 * * *", true)).toBe("Every 3 hours");
  });

  it("returns 'Every hour' for 0 */1 * * *", () => {
    expect(humanizeSchedule("0 */1 * * *", true)).toBe("Every hour");
  });

  it("returns 'Daily at H:MM AM/PM'", () => {
    expect(humanizeSchedule("0 8 * * *", true)).toBe("Daily at 8:00 AM");
    expect(humanizeSchedule("0 14 * * *", true)).toBe("Daily at 2:00 PM");
    expect(humanizeSchedule("0 0 * * *", true)).toBe("Daily at 12:00 AM");
    expect(humanizeSchedule("0 12 * * *", true)).toBe("Daily at 12:00 PM");
  });

  it("returns 'Weekdays at H:MM AM/PM'", () => {
    expect(humanizeSchedule("0 9 * * 1-5", true)).toBe("Weekdays at 9:00 AM");
  });

  it("returns raw expression for unrecognized patterns", () => {
    expect(humanizeSchedule("0 8,12 * * 1,3,5", true)).toBe("0 8,12 * * 1,3,5");
  });

  it("returns raw expression for invalid part count", () => {
    expect(humanizeSchedule("0 8 * *", true)).toBe("0 8 * *");
  });
});

describe("getWebhookUrl", () => {
  it("uses publicUrl when provided", () => {
    const agent = makeAgent({
      id: "wh-agent",
      triggers: { webhook: { enabled: true, secret: "sec123" } },
    });
    const url = getWebhookUrl(agent, "https://example.com");
    expect(url).toBe("https://example.com/api/agents/wh-agent/webhook/sec123");
  });

  it("falls back to window.location.origin when publicUrl is empty", () => {
    const agent = makeAgent({
      id: "wh-agent",
      triggers: { webhook: { enabled: true, secret: "sec123" } },
    });
    const url = getWebhookUrl(agent, "");
    expect(url).toContain("/api/agents/wh-agent/webhook/sec123");
  });

  it("encodes agent id in the URL", () => {
    const agent = makeAgent({
      id: "agent with spaces",
      triggers: { webhook: { enabled: true, secret: "s" } },
    });
    const url = getWebhookUrl(agent, "https://example.com");
    expect(url).toContain("agent%20with%20spaces");
  });
});
