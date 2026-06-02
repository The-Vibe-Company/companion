// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AiValidationBadge } from "./AiValidationBadge.js";
import type { PermissionRequest } from "../types.js";

function mockEntry(overrides: Partial<{
  request: Partial<PermissionRequest>;
  behavior: "allow" | "deny";
  reason: string;
}> = {}) {
  return {
    request: {
      request_id: "test-id",
      tool_name: "Read",
      input: { file_path: "/src/index.ts" },
      tool_use_id: "tu-1",
      timestamp: Date.now(),
      ...overrides.request,
    } as PermissionRequest,
    behavior: overrides.behavior ?? "allow",
    reason: overrides.reason ?? "Read is a read-only tool",
    timestamp: Date.now(),
  };
}

describe("AiValidationBadge", () => {
  it("renders auto-approved badge", () => {
    render(<AiValidationBadge entry={mockEntry({ behavior: "allow", reason: "Read is a read-only tool" })} />);
    expect(screen.getByText(/auto-approved/)).toBeInTheDocument();
    expect(screen.getByText(/Read is a read-only tool/)).toBeInTheDocument();
  });

  it("renders auto-denied badge", () => {
    render(<AiValidationBadge entry={mockEntry({
      behavior: "deny",
      reason: "Recursive delete",
      request: { tool_name: "Bash", input: { command: "rm -rf /" } },
    })} />);
    expect(screen.getByText(/auto-denied/)).toBeInTheDocument();
    expect(screen.getByText(/Recursive delete/)).toBeInTheDocument();
  });

  it("shows Bash command in tool description", () => {
    render(<AiValidationBadge entry={mockEntry({
      request: { tool_name: "Bash", input: { command: "ls -la" } },
    })} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });

  it("shows file path for Read tool", () => {
    render(<AiValidationBadge entry={mockEntry({
      request: { tool_name: "Read", input: { file_path: "/src/app.tsx" } },
    })} />);
    expect(screen.getByText("Read /src/app.tsx")).toBeInTheDocument();
  });

  it("truncates long Bash commands", () => {
    const longCmd = "echo " + "a".repeat(100);
    render(<AiValidationBadge entry={mockEntry({
      request: { tool_name: "Bash", input: { command: longCmd } },
    })} />);
    // Should be truncated to 60 chars + ...
    const truncated = longCmd.slice(0, 60) + "...";
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });

  it("passes accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AiValidationBadge entry={mockEntry()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders dismiss button when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    render(<AiValidationBadge entry={mockEntry()} onDismiss={onDismiss} />);
    const btn = screen.getByRole("button", { name: /dismiss/i });
    expect(btn).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(<AiValidationBadge entry={mockEntry()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not render dismiss button when onDismiss is omitted", () => {
    // Verifies the dismiss button is optional and not shown by default
    render(<AiValidationBadge entry={mockEntry()} />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it("passes accessibility scan with dismiss button", async () => {
    // Ensures the dismiss button meets accessibility standards (has aria-label, etc.)
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <AiValidationBadge entry={mockEntry()} onDismiss={() => {}} />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
