// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendSetAiValidation = vi.fn();

vi.mock("../ws.js", () => ({
  sendSetAiValidation: (...args: unknown[]) => mockSendSetAiValidation(...args),
}));

interface MockSessionState {
  aiValidationEnabled?: boolean | null;
  aiValidationAutoApprove?: boolean | null;
  aiValidationAutoDeny?: boolean | null;
}

let mockSession: MockSessionState | undefined;
const mockSetSessionAiValidation = vi.fn();

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        sessions: new Map(mockSession ? [["test-session", mockSession]] : []),
      }),
    {
      getState: () => ({
        setSessionAiValidation: mockSetSessionAiValidation,
      }),
    },
  ),
}));

import { AiValidationToggle } from "./AiValidationToggle.js";

beforeEach(() => {
  mockSession = {
    aiValidationEnabled: false,
    aiValidationAutoApprove: true,
    aiValidationAutoDeny: false,
  };
  mockSendSetAiValidation.mockClear();
  mockSetSessionAiValidation.mockClear();
});

describe("AiValidationToggle", () => {
  it("renders shield icon button", () => {
    render(<AiValidationToggle sessionId="test-session" />);
    expect(screen.getByRole("button", { name: /toggle ai validation/i })).toBeInTheDocument();
  });

  it("shows 'Off' title when disabled", () => {
    render(<AiValidationToggle sessionId="test-session" />);
    const btn = screen.getByRole("button", { name: /toggle ai validation/i });
    expect(btn).toHaveAttribute("title", "AI Validation: Off");
  });

  it("shows 'On' title when enabled", () => {
    mockSession = { aiValidationEnabled: true, aiValidationAutoApprove: true, aiValidationAutoDeny: true };
    render(<AiValidationToggle sessionId="test-session" />);
    const btn = screen.getByRole("button", { name: /toggle ai validation/i });
    expect(btn).toHaveAttribute("title", "AI Validation: On");
  });

  it("opens dropdown on click", () => {
    render(<AiValidationToggle sessionId="test-session" />);
    const btn = screen.getByRole("button", { name: /toggle ai validation/i });
    fireEvent.click(btn);
    expect(screen.getByText("AI Validation for this session")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("does not show sub-toggles when validation is disabled", () => {
    render(<AiValidationToggle sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /toggle ai validation/i }));
    // Should show Enabled toggle but not auto-approve/auto-deny
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.queryByText("Auto-approve safe")).not.toBeInTheDocument();
    expect(screen.queryByText("Auto-deny dangerous")).not.toBeInTheDocument();
  });

  it("shows sub-toggles when validation is enabled", () => {
    mockSession = { aiValidationEnabled: true, aiValidationAutoApprove: true, aiValidationAutoDeny: true };
    render(<AiValidationToggle sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /toggle ai validation/i }));
    expect(screen.getByText("Auto-approve safe")).toBeInTheDocument();
    expect(screen.getByText("Auto-deny dangerous")).toBeInTheDocument();
  });

  it("clicking Enabled toggle sends WebSocket message and updates store", () => {
    render(<AiValidationToggle sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /toggle ai validation/i }));
    fireEvent.click(screen.getByRole("button", { name: /toggle ai validation$/i }));

    // Should optimistically update store
    expect(mockSetSessionAiValidation).toHaveBeenCalledWith("test-session", { aiValidationEnabled: true });
    // Should send WebSocket message
    expect(mockSendSetAiValidation).toHaveBeenCalledWith("test-session", { aiValidationEnabled: true });
  });

  it("clicking auto-approve toggle sends correct message", () => {
    mockSession = { aiValidationEnabled: true, aiValidationAutoApprove: true, aiValidationAutoDeny: true };
    render(<AiValidationToggle sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /toggle ai validation/i }));
    fireEvent.click(screen.getByRole("button", { name: /toggle auto-approve/i }));

    expect(mockSetSessionAiValidation).toHaveBeenCalledWith("test-session", { aiValidationAutoApprove: false });
    expect(mockSendSetAiValidation).toHaveBeenCalledWith("test-session", { aiValidationAutoApprove: false });
  });

  it("clicking auto-deny toggle sends correct message", () => {
    mockSession = { aiValidationEnabled: true, aiValidationAutoApprove: true, aiValidationAutoDeny: true };
    render(<AiValidationToggle sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /toggle ai validation/i }));
    fireEvent.click(screen.getByRole("button", { name: /toggle auto-deny/i }));

    expect(mockSetSessionAiValidation).toHaveBeenCalledWith("test-session", { aiValidationAutoDeny: false });
    expect(mockSendSetAiValidation).toHaveBeenCalledWith("test-session", { aiValidationAutoDeny: false });
  });

  it("passes accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AiValidationToggle sessionId="test-session" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan with dropdown open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<AiValidationToggle sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /toggle ai validation/i }));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
