// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PermissionRequest } from "../../server/session-types.js";
import type { PermissionUpdate } from "../../server/session-types.js";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock react-markdown to avoid ESM/jsdom issues
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

const mockRemovePermission = vi.fn();
const mockSendToSession = vi.fn();

vi.mock("../store.js", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ removePermission: mockRemovePermission }),
}));

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

import { PermissionBanner } from "./PermissionBanner.js";

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    input: { command: "ls -la" },
    tool_use_id: "tu-1",
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Label rendering ────────────────────────────────────────────────────────

describe("PermissionBanner label rendering", () => {
  it("renders 'Permission Request' label for standard tools", () => {
    render(
      <PermissionBanner permission={makePermission()} sessionId="s1" />,
    );
    expect(screen.getByText("Permission Request")).toBeTruthy();
  });

  it("renders 'Question' label for AskUserQuestion tool", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "AskUserQuestion",
          input: { question: "What do you want?" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("Question")).toBeTruthy();
    // Should NOT show "Permission Request"
    expect(screen.queryByText("Permission Request")).toBeNull();
  });

  it("renders enriched permission metadata when present", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Bash",
          display_name: "Shell command",
          title: "Needs broader access",
          decision_reason: "This command writes outside the current workspace.",
        })}
        sessionId="s1"
      />,
    );

    expect(screen.getByText("Shell command")).toBeTruthy();
    expect(screen.getByText("Needs broader access")).toBeTruthy();
    expect(
      screen.getByText("This command writes outside the current workspace."),
    ).toBeTruthy();
  });

  it("falls back to tool_name when enriched permission metadata is absent", () => {
    render(
      <PermissionBanner
        permission={makePermission({ tool_name: "Read" })}
        sessionId="s1"
      />,
    );

    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("Needs broader access")).toBeNull();
    expect(
      screen.queryByText("This command writes outside the current workspace."),
    ).toBeNull();
  });
});

// ─── BashDisplay ─────────────────────────────────────────────────────────────

describe("BashDisplay", () => {
  it("renders the command with $ prefix", () => {
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Bash",
          input: { command: "echo hello", description: "Print hello" },
        })}
        sessionId="s1"
      />,
    );
    // The $ prefix is in a span inside a pre, so check the pre's text content
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain("$ echo hello");
    expect(screen.getByText("Print hello")).toBeTruthy();
  });
});

// ─── EditDisplay ─────────────────────────────────────────────────────────────

describe("EditDisplay", () => {
  it("renders diff view with old/new strings via DiffViewer", () => {
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Edit",
          input: {
            file_path: "/src/main.ts",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
          },
        })}
        sessionId="s1"
      />,
    );
    // DiffViewer renders file header (basename extracted)
    expect(screen.getByText("main.ts")).toBeTruthy();
    // DiffViewer renders del/add lines
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
  });
});

// ─── WriteDisplay ────────────────────────────────────────────────────────────

describe("WriteDisplay", () => {
  it("renders file path and content as new-file diff via DiffViewer", () => {
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Write",
          input: {
            file_path: "/src/output.ts",
            content: "export default 42;",
          },
        })}
        sessionId="s1"
      />,
    );
    // DiffViewer renders file header (basename extracted)
    expect(screen.getByText("output.ts")).toBeTruthy();
    // Write renders as all-add diff lines
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeNull();
  });

  it("renders long content as diff lines without manual truncation", () => {
    const longContent = "x".repeat(600);
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Write",
          input: {
            file_path: "/src/big.ts",
            content: longContent,
          },
        })}
        sessionId="s1"
      />,
    );
    // DiffViewer renders the content as add lines
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    expect(screen.getByText("big.ts")).toBeTruthy();
  });
});

// ─── ReadDisplay ─────────────────────────────────────────────────────────────

describe("ReadDisplay", () => {
  it("renders file path", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Read",
          input: { file_path: "/etc/config.json" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("/etc/config.json")).toBeTruthy();
  });
});

// ─── GlobDisplay ─────────────────────────────────────────────────────────────

describe("GlobDisplay", () => {
  it("renders pattern and optional path", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Glob",
          input: { pattern: "**/*.ts", path: "/src" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("**/*.ts")).toBeTruthy();
    expect(screen.getByText("/src")).toBeTruthy();
  });

  it("renders pattern without path", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Glob",
          input: { pattern: "*.json" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("*.json")).toBeTruthy();
  });
});

// ─── GrepDisplay ─────────────────────────────────────────────────────────────

describe("GrepDisplay", () => {
  it("renders pattern, path, and glob", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Grep",
          input: { pattern: "TODO", path: "/src", glob: "*.ts" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("TODO")).toBeTruthy();
    expect(screen.getByText("/src")).toBeTruthy();
    expect(screen.getByText("*.ts")).toBeTruthy();
  });
});

// ─── GenericDisplay ──────────────────────────────────────────────────────────

describe("GenericDisplay", () => {
  it("renders key-value pairs for unknown tools", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "SomeUnknownTool",
          input: { foo: "bar", count: 42 },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("foo:")).toBeTruthy();
    expect(screen.getByText("bar")).toBeTruthy();
    expect(screen.getByText("count:")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("renders description when no entries", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "SomeUnknownTool",
          input: {},
          description: "A custom tool description",
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("A custom tool description")).toBeTruthy();
  });
});

// ─── Allow / Deny buttons ────────────────────────────────────────────────────

describe("Allow and Deny buttons", () => {
  it("Allow button calls sendToSession with correct permission_response", () => {
    const perm = makePermission({ request_id: "req-42" });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    fireEvent.click(screen.getByText("Allow"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-42",
      behavior: "allow",
      updated_input: undefined,
    });
    expect(mockRemovePermission).toHaveBeenCalledWith("s1", "req-42");
  });

  it("Deny button calls sendToSession with deny behavior", () => {
    const perm = makePermission({ request_id: "req-43" });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    fireEvent.click(screen.getByText("Deny"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-43",
      behavior: "deny",
      message: "Denied by user",
    });
    expect(mockRemovePermission).toHaveBeenCalledWith("s1", "req-43");
  });
});

// ─── Permission suggestion buttons ──────────────────────────────────────────

describe("Permission suggestion buttons", () => {
  it("renders addRules suggestion with correct label", () => {
    const suggestion: PermissionUpdate = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "allow ls" }],
      behavior: "allow",
      destination: "session",
    };
    const perm = makePermission({ permission_suggestions: [suggestion] });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText('Allow "allow ls" for session')).toBeTruthy();
  });

  it("renders setMode suggestion with correct label", () => {
    const suggestion: PermissionUpdate = {
      type: "setMode",
      mode: "bypassPermissions",
      destination: "session",
    };
    const perm = makePermission({ permission_suggestions: [suggestion] });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText('Set mode to "bypassPermissions"')).toBeTruthy();
  });

  it("renders addDirectories suggestion with correct label", () => {
    const suggestion: PermissionUpdate = {
      type: "addDirectories",
      directories: ["/home/user/project"],
      destination: "userSettings",
    };
    const perm = makePermission({ permission_suggestions: [suggestion] });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("Trust /home/user/project always")).toBeTruthy();
  });

  it("clicking a suggestion calls sendToSession with updated_permissions", () => {
    const suggestion: PermissionUpdate = {
      type: "addRules",
      rules: [{ toolName: "Bash" }],
      behavior: "allow",
      destination: "session",
    };
    const perm = makePermission({
      request_id: "req-50",
      permission_suggestions: [suggestion],
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    fireEvent.click(screen.getByText("Allow Bash for session"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-50",
      behavior: "allow",
      updated_input: undefined,
      updated_permissions: [suggestion],
    });
  });
});

// ─── AskUserQuestionDisplay ──────────────────────────────────────────────────

describe("AskUserQuestionDisplay", () => {
  it("renders options and handles selection", () => {
    const perm = makePermission({
      request_id: "req-ask-1",
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Pick one",
            question: "Which color?",
            options: [
              { label: "Red", description: "A warm color" },
              { label: "Blue", description: "A cool color" },
            ],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("Pick one")).toBeTruthy();
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByText("Red")).toBeTruthy();
    expect(screen.getByText("Blue")).toBeTruthy();
    expect(screen.getByText("A warm color")).toBeTruthy();
    expect(screen.getByText("A cool color")).toBeTruthy();

    // Clicking an option with a single question auto-submits
    fireEvent.click(screen.getByText("Red"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "permission_response",
      request_id: "req-ask-1",
      behavior: "allow",
    }));
    // The updated_input spreads permission.input and adds { answers: { "0": "Red" } }
    const call = mockSendToSession.mock.calls[0][1];
    expect(call.updated_input.answers).toEqual({ "0": "Red" });
  });

  it("renders fallback for simple question string", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: { question: "Are you sure?" },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("Are you sure?")).toBeTruthy();
  });

  it("does not show Allow/Deny buttons for AskUserQuestion", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: { question: "Yes or no?" },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.queryByText("Allow")).toBeNull();
    expect(screen.queryByText("Deny")).toBeNull();
  });

  it("removes Other send button and includes typed Other answer in submit", () => {
    const perm = makePermission({
      request_id: "req-ask-2",
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Q1",
            question: "Pick one",
            options: [{ label: "A", description: "Option A" }],
          },
          {
            header: "Q2",
            question: "Add context",
            options: [{ label: "B", description: "Option B" }],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    const otherButtons = screen.getAllByText("Other...");
    fireEvent.click(otherButtons[1]);
    const input = screen.getByPlaceholderText("Type your answer...");
    fireEvent.change(input, { target: { value: "Custom response" } });

    expect(screen.queryByText("Send")).toBeNull();
    fireEvent.click(screen.getByText("Submit answers"));

    const payload = mockSendToSession.mock.calls[0][1];
    expect(payload.updated_input.answers).toEqual({ "1": "Custom response" });
  });

  it("shows Enter hint for single-question custom Other input", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Q",
            question: "Choose",
            options: [{ label: "X", description: "Option X" }],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    fireEvent.click(screen.getByText("Other..."));
    expect(screen.getByText("Press Enter to submit")).toBeTruthy();
  });

  it("clears custom Other answer when toggled off before submit", () => {
    const perm = makePermission({
      request_id: "req-ask-3",
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Q1",
            question: "Primary",
            options: [{ label: "Keep", description: "Use default" }],
          },
          {
            header: "Q2",
            question: "Details",
            options: [{ label: "Preset", description: "Use preset value" }],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    const otherButtons = screen.getAllByText("Other...");
    fireEvent.click(otherButtons[1]);
    const input = screen.getByPlaceholderText("Type your answer...");
    fireEvent.change(input, { target: { value: "Stale answer" } });
    fireEvent.click(otherButtons[1]); // toggle off

    fireEvent.click(screen.getByText("Keep"));
    fireEvent.click(screen.getByText("Submit answers"));

    const payload = mockSendToSession.mock.calls[0][1];
    expect(payload.updated_input.answers).toEqual({ "0": "Keep" });
  });
});

// ─── AI Validation Badge ─────────────────────────────────────────────────────

describe("AI validation badge", () => {
  it("renders 'AI analysis:' label for genuine analysis verdicts", () => {
    // When AI analysis returns a genuine uncertain verdict (not a service failure),
    // the badge should show "AI analysis:" to indicate a real analysis was performed.
    const perm = makePermission({
      ai_validation: { verdict: "uncertain", reason: "Complex bash pipeline", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("AI analysis:")).toBeTruthy();
    expect(screen.getByText("Complex bash pipeline")).toBeTruthy();
  });

  it("renders 'AI analysis unavailable' label for service failures (invalid key)", () => {
    // When AI analysis failed due to a service error (like invalid API key),
    // the badge should clarify that analysis was unavailable and this is manual review.
    const perm = makePermission({
      ai_validation: { verdict: "uncertain", reason: "Invalid Anthropic API key: invalid x-api-key", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText(/AI analysis unavailable/)).toBeTruthy();
    expect(screen.getByText(/Invalid Anthropic API key/)).toBeTruthy();
  });

  it("renders 'AI analysis unavailable' label for permission failures (403)", () => {
    // 403 permission errors should also be identified as service failures.
    const perm = makePermission({
      ai_validation: { verdict: "uncertain", reason: "Anthropic API key lacks permission", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText(/AI analysis unavailable/)).toBeTruthy();
    expect(screen.getByText(/lacks permission/)).toBeTruthy();
  });

  it("renders 'AI analysis unavailable' label for timeout failures", () => {
    // Timeout errors should also be identified as service failures.
    const perm = makePermission({
      ai_validation: { verdict: "uncertain", reason: "AI evaluation timed out", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText(/AI analysis unavailable/)).toBeTruthy();
    expect(screen.getByText("AI evaluation timed out")).toBeTruthy();
  });

  it("renders 'AI analysis unavailable' label for unreachable service", () => {
    // Network errors should be identified as service failures.
    const perm = makePermission({
      ai_validation: { verdict: "uncertain", reason: "AI service unreachable: ECONNREFUSED", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText(/AI analysis unavailable/)).toBeTruthy();
  });

  it("renders 'AI analysis:' for safe verdict", () => {
    // Safe verdicts should show the normal "AI analysis:" label.
    const perm = makePermission({
      ai_validation: { verdict: "safe", reason: "Standard dev command", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("AI analysis:")).toBeTruthy();
    expect(screen.getByText("Standard dev command")).toBeTruthy();
  });

  it("renders 'AI analysis:' for dangerous verdict", () => {
    // Dangerous verdicts should show the normal "AI analysis:" label.
    const perm = makePermission({
      ai_validation: { verdict: "dangerous", reason: "Recursive file deletion", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("AI analysis:")).toBeTruthy();
    expect(screen.getByText("Recursive file deletion")).toBeTruthy();
  });

  it("does not render AI validation badge for AskUserQuestion", () => {
    // AskUserQuestion tools should never show AI validation badge.
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: { question: "Pick one" },
      ai_validation: { verdict: "safe", reason: "test", ruleBasedOnly: false },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.queryByText("AI analysis:")).toBeNull();
  });

  it("does not render AI validation badge when ai_validation is absent", () => {
    // Permissions without AI validation should not show any badge.
    const perm = makePermission();
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.queryByText("AI analysis:")).toBeNull();
    expect(screen.queryByText(/AI analysis unavailable/)).toBeNull();
  });
});

// ─── ExitPlanModeDisplay ─────────────────────────────────────────────────────

describe("ExitPlanModeDisplay", () => {
  it("renders plan markdown and allowed prompts", () => {
    const perm = makePermission({
      tool_name: "ExitPlanMode",
      input: {
        plan: "## Step 1\nDo something",
        allowedPrompts: [
          { tool: "Bash", prompt: "Run tests" },
          { tool: "Edit", prompt: "Fix typo" },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    // Plan header
    expect(screen.getByText("Plan")).toBeTruthy();
    // Markdown content rendered via mock
    expect(screen.getByTestId("markdown")).toBeTruthy();
    expect(screen.getByTestId("markdown").textContent).toBe("## Step 1\nDo something");

    // Allowed prompts
    expect(screen.getByText("Requested permissions")).toBeTruthy();
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("Run tests")).toBeTruthy();
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Fix typo")).toBeTruthy();
  });

  it("renders fallback when no plan or prompts", () => {
    const perm = makePermission({
      tool_name: "ExitPlanMode",
      input: {},
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("Plan approval requested")).toBeTruthy();
  });
});
