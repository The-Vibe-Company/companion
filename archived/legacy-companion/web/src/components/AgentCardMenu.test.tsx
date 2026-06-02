// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentInfo } from "../api.js";

import { AgentCardMenu } from "./AgentCardMenu.js";

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

function makeProps(overrides: Partial<Parameters<typeof AgentCardMenu>[0]> = {}) {
  return {
    agent: makeAgent(),
    copiedWebhook: null as string | null,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
    onExport: vi.fn(),
    onCopyWebhook: vi.fn(),
    onRegenerateSecret: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentCardMenu", () => {
  // Test 1: Menu dropdown is hidden by default until the trigger is clicked
  it("menu dropdown is hidden by default", () => {
    render(<AgentCardMenu {...makeProps()} />);
    // The menu role="menu" should not be in the DOM
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Test 2: Clicking the three-dot trigger button opens the dropdown menu
  it("clicking trigger opens the dropdown menu", () => {
    render(<AgentCardMenu {...makeProps()} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // Test 3: Clicking outside the menu closes it
  it("clicking outside closes the menu", () => {
    render(<AgentCardMenu {...makeProps()} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Simulate a click outside the menu
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Test 4: Pressing Escape closes the menu
  it("pressing Escape closes the menu", () => {
    render(<AgentCardMenu {...makeProps()} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Test 5: Clicking Edit menu item calls onEdit and closes menu
  it("clicking Edit calls onEdit and closes menu", () => {
    const props = makeProps();
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByText("Edit"));

    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Test 6: Clicking Export JSON calls onExport and closes menu
  it("clicking Export JSON calls onExport and closes menu", () => {
    const props = makeProps();
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByText("Export JSON"));

    expect(props.onExport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Test 7: Clicking Disable calls onToggle when agent is enabled
  it("shows 'Disable' when agent is enabled and calls onToggle", () => {
    const props = makeProps({ agent: makeAgent({ enabled: true }) });
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByText("Disable"));

    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  // Test 8: Shows 'Enable' when agent is disabled
  it("shows 'Enable' when agent is disabled", () => {
    const props = makeProps({ agent: makeAgent({ enabled: false }) });
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));

    expect(screen.getByText("Enable")).toBeInTheDocument();
    expect(screen.queryByText("Disable")).not.toBeInTheDocument();
  });

  // Test 9: Clicking Delete calls onDelete and has red text styling
  it("clicking Delete calls onDelete", () => {
    const props = makeProps();
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));

    const deleteBtn = screen.getByText("Delete");
    // Delete button should have error/red text styling
    expect(deleteBtn.closest("button")?.className).toContain("cc-error");
    fireEvent.click(deleteBtn);

    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  // Test 10: Webhook menu items are hidden when webhook is not enabled
  it("hides webhook items when webhook is not enabled", () => {
    const props = makeProps({
      agent: makeAgent({
        triggers: { webhook: { enabled: false, secret: "" } },
      }),
    });
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));

    expect(screen.queryByText("Copy Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Regenerate Secret")).not.toBeInTheDocument();
  });

  // Test 11: Webhook items are shown when webhook is enabled
  it("shows webhook items when webhook is enabled", () => {
    const props = makeProps({
      agent: makeAgent({
        triggers: { webhook: { enabled: true, secret: "abc" } },
      }),
    });
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));

    expect(screen.getByText("Copy Webhook URL")).toBeInTheDocument();
    expect(screen.getByText("Regenerate Secret")).toBeInTheDocument();
  });

  // Test 12: Clicking Copy Webhook URL calls onCopyWebhook
  it("clicking Copy Webhook URL calls onCopyWebhook", () => {
    const props = makeProps({
      agent: makeAgent({
        triggers: { webhook: { enabled: true, secret: "abc" } },
      }),
    });
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByText("Copy Webhook URL"));

    expect(props.onCopyWebhook).toHaveBeenCalledTimes(1);
  });

  // Test 13: Shows "Copied!" text when copiedWebhook matches agent id
  it("shows 'Copied!' when copiedWebhook matches agent id", () => {
    const agent = makeAgent({
      id: "copied-agent",
      triggers: { webhook: { enabled: true, secret: "abc" } },
    });
    const props = makeProps({ agent, copiedWebhook: "copied-agent" });
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));

    expect(screen.getByText("Copied!")).toBeInTheDocument();
    expect(screen.queryByText("Copy Webhook URL")).not.toBeInTheDocument();
  });

  // Test 14: Clicking Regenerate Secret calls onRegenerateSecret
  it("clicking Regenerate Secret calls onRegenerateSecret", () => {
    const props = makeProps({
      agent: makeAgent({
        triggers: { webhook: { enabled: true, secret: "abc" } },
      }),
    });
    render(<AgentCardMenu {...props} />);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByText("Regenerate Secret"));

    expect(props.onRegenerateSecret).toHaveBeenCalledTimes(1);
  });

  // Test 15: Trigger button has correct ARIA attributes
  it("trigger button has correct ARIA attributes", () => {
    render(<AgentCardMenu {...makeProps()} />);
    const trigger = screen.getByLabelText("More actions");

    expect(trigger).toHaveAttribute("aria-haspopup", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  // Test 16: Menu items have role="menuitem"
  it("all menu items have role='menuitem'", () => {
    render(<AgentCardMenu {...makeProps()} />);
    fireEvent.click(screen.getByLabelText("More actions"));

    const menuItems = screen.getAllByRole("menuitem");
    // Should have: Edit, Export JSON, Disable, Delete (no webhook items)
    expect(menuItems.length).toBe(4);
  });

  // Test 17: Accessibility scan — passes axe checks with menu open
  it("passes axe accessibility checks with menu open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AgentCardMenu {...makeProps()} />);
    fireEvent.click(screen.getByLabelText("More actions"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Test 18: Accessibility scan — passes axe checks with menu closed
  it("passes axe accessibility checks with menu closed", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AgentCardMenu {...makeProps()} />);

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
