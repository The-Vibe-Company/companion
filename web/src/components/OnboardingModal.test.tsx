// @vitest-environment jsdom
/**
 * Tests for the OnboardingModal component.
 *
 * This modal appears on first launch when onboardingCompleted is false.
 * It guides users through configuring Claude Code (OAuth token) and Codex (OpenAI API key).
 *
 * Key behaviors tested:
 * - Welcome step renders with provider options
 * - Claude setup step supports local CLI, OAuth token, and API key auth
 * - Codex setup step supports local CLI and API key auth
 * - Saving provider auth first verifies the selected method
 * - Skip flow marks onboarding as completed
 * - Done step shows correct configured status
 * - Accessibility audit passes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock the api module
vi.mock("../api.js", () => ({
  api: {
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn(),
    verifyProvider: vi.fn().mockResolvedValue({ valid: true }),
  },
}));

import { OnboardingModal } from "./OnboardingModal.js";
import { api } from "../api.js";

const mockUpdateSettings = vi.mocked(api.updateSettings);
const mockGetSettings = vi.mocked(api.getSettings);
const mockVerifyProvider = vi.mocked(api.verifyProvider);

function mockSettings(overrides: Partial<Awaited<ReturnType<typeof api.getSettings>>> = {}) {
  return {
    anthropicApiKeyConfigured: false,
    anthropicModel: "claude-sonnet-4-6",
    claudeCodeOAuthTokenConfigured: false,
    claudeApiKeyConfigured: false,
    claudeAuthMethod: "local" as const,
    claudeBaseUrl: "",
    claudeDeviceAuthConfigured: false,
    openaiApiKeyConfigured: false,
    codexAuthMethod: "local" as const,
    openaiBaseUrl: "",
    codexDeviceAuthConfigured: false,
    onboardingCompleted: false,
    linearApiKeyConfigured: false,
    linearConnectionCount: 0,
    linearAutoTransition: false,
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateName: "",
    linearOAuthConfigured: false,
    linearOAuthCredentialsSaved: false,
    aiValidationEnabled: false,
    aiValidationAutoApprove: true,
    aiValidationAutoDeny: false,
    publicUrl: "",
    updateChannel: "stable" as const,
    dockerAutoUpdate: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSettings.mockResolvedValue({} as ReturnType<typeof api.updateSettings> extends Promise<infer T> ? T : never);
  mockGetSettings.mockResolvedValue(mockSettings());
  mockVerifyProvider.mockResolvedValue({ valid: true });
});

describe("OnboardingModal", () => {
  it("renders the welcome step with provider options", () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    expect(screen.getByText("Welcome to AgentHangar")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("navigates to Claude setup when Claude Code is clicked", () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Claude Code"));
    expect(screen.getByText("Set up Claude Code")).toBeInTheDocument();
    expect(screen.getByLabelText("Claude auth method")).toHaveValue("local");
    expect(screen.getByText(/claude -p hello/)).toBeInTheDocument();
  });

  it("shows detected Claude auth instead of forcing token setup", async () => {
    mockGetSettings.mockResolvedValue(mockSettings({ claudeDeviceAuthConfigured: true }));

    render(<OnboardingModal onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Claude Code"));

    await waitFor(() => {
      expect(screen.getByText(/A local Claude Code auth source was detected/)).toBeInTheDocument();
    });
    expect(screen.queryByText("claude setup-token")).not.toBeInTheDocument();
  });

  it("navigates to Codex setup when Codex is clicked", () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Codex"));
    expect(screen.getByText("Set up Codex")).toBeInTheDocument();
    expect(screen.getByText("codex --login")).toBeInTheDocument();
  });

  it("skips all setup when skip link is clicked", async () => {
    const onComplete = vi.fn();
    render(<OnboardingModal onComplete={onComplete} />);

    fireEvent.click(screen.getByText(/Skip setup/));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
    });
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("saves Claude token and navigates to Codex step", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Claude setup
    fireEvent.click(screen.getByText("Claude Code"));
    expect(screen.getByText("Set up Claude Code")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "oauth" } });

    // Enter token
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "test-oauth-token" } });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.click(screen.getByText("Verify Claude Auth"));

    await waitFor(() => {
      expect(mockVerifyProvider).toHaveBeenCalledWith({
        provider: "claude",
        authMethod: "oauth",
        token: "test-oauth-token",
        baseUrl: "",
      });
    });
    expect(mockUpdateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ claudeAuthMethod: "oauth" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        claudeAuthMethod: "oauth",
        claudeCodeOAuthToken: "test-oauth-token",
      });
    });

    // Should navigate to Codex step
    await waitFor(() => {
      expect(screen.getByText("Set up Codex")).toBeInTheDocument();
    });
  });

  it("verifies and saves Claude API key auth with optional base URL", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);

    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "apiKey" } });
    fireEvent.change(screen.getByLabelText("Claude API Key"), { target: { value: "sk-ant-test" } });
    fireEvent.change(screen.getByLabelText("Claude-compatible Base URL"), {
      target: { value: "https://claude-proxy.example.com" },
    });
    fireEvent.click(screen.getByText("Verify Claude Auth"));

    await waitFor(() => {
      expect(mockVerifyProvider).toHaveBeenCalledWith({
        provider: "claude",
        authMethod: "apiKey",
        token: "sk-ant-test",
        baseUrl: "https://claude-proxy.example.com",
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        claudeAuthMethod: "apiKey",
        claudeApiKey: "sk-ant-test",
        claudeBaseUrl: "https://claude-proxy.example.com",
      });
    });
  });

  it("skips Claude step and goes to Codex", () => {
    render(<OnboardingModal onComplete={vi.fn()} />);

    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.click(screen.getByText("Skip"));

    expect(screen.getByText("Set up Codex")).toBeInTheDocument();
  });

  it("saves Codex API key and completes onboarding", async () => {
    const onComplete = vi.fn();
    render(<OnboardingModal onComplete={onComplete} />);

    // Go directly to Codex setup
    fireEvent.click(screen.getByText("Codex"));
    fireEvent.change(screen.getByLabelText("Codex auth method"), { target: { value: "apiKey" } });

    // Enter API key
    const input = screen.getByLabelText("OpenAI API Key");
    fireEvent.change(input, { target: { value: "sk-test-key" } });

    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    fireEvent.click(screen.getByText("Verify Codex Auth"));

    await waitFor(() => {
      expect(mockVerifyProvider).toHaveBeenCalledWith({
        provider: "codex",
        authMethod: "apiKey",
        token: "sk-test-key",
        baseUrl: "",
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Finish" })).not.toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        codexAuthMethod: "apiKey",
        openaiApiKey: "sk-test-key",
        openaiBaseUrl: "",
      });
    });

    // Should show done step
    await waitFor(() => {
      expect(screen.getByText("Get Started")).toBeInTheDocument();
    });
  });

  it("navigates back from Codex to Claude step", () => {
    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Codex via welcome
    fireEvent.click(screen.getByText("Codex"));
    expect(screen.getByText("Set up Codex")).toBeInTheDocument();

    // Go back
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("Set up Claude Code")).toBeInTheDocument();
  });

  it("shows done step with correct configured status", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Claude, enter token, save
    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "oauth" } });
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "token" } });
    fireEvent.click(screen.getByText("Verify Claude Auth"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("Set up Codex")).toBeInTheDocument();
    });

    // Skip Codex
    fireEvent.click(screen.getByText("Skip"));

    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
      expect(screen.getByText("Claude Code is ready.")).toBeInTheDocument();
    });
  });

  it("shows 'Setup Skipped' when no providers configured", async () => {
    render(<OnboardingModal onComplete={vi.fn()} />);

    // Skip through Claude and Codex
    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Skip"));

    await waitFor(() => {
      expect(screen.getByText("Setup Skipped")).toBeInTheDocument();
    });
  });

  it("shows 'Setup Skipped' when detected local auth is skipped", async () => {
    mockGetSettings.mockResolvedValue(mockSettings({
      claudeDeviceAuthConfigured: true,
      codexDeviceAuthConfigured: true,
    }));

    render(<OnboardingModal onComplete={vi.fn()} />);

    // Local CLI auth may be detected, but skipping means the user did not
    // choose it as the onboarding result.
    fireEvent.click(screen.getByText("Claude Code"));
    await waitFor(() => {
      expect(screen.getByText(/A local Claude Code auth source was detected/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Skip"));

    await waitFor(() => {
      expect(screen.getByText("Setup Skipped")).toBeInTheDocument();
    });
    expect(screen.queryByText("Claude Code is ready.")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex is ready.")).not.toBeInTheDocument();
  });

  it("calls onComplete when Get Started is clicked on done step", async () => {
    const onComplete = vi.fn();
    render(<OnboardingModal onComplete={onComplete} />);

    // Skip everything to get to done
    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.click(screen.getByText("Skip"));
    fireEvent.click(screen.getByText("Skip"));

    await waitFor(() => {
      expect(screen.getByText("Get Started")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Get Started"));
    expect(onComplete).toHaveBeenCalled();
  });

  it("displays error when save fails", async () => {
    mockUpdateSettings.mockRejectedValueOnce(new Error("Network error"));

    render(<OnboardingModal onComplete={vi.fn()} />);

    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "oauth" } });
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "bad-token" } });
    fireEvent.click(screen.getByText("Verify Claude Auth"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  // Verifies the Codex save error branch is exercised
  it("displays error when Codex save fails", async () => {
    mockUpdateSettings.mockRejectedValueOnce(new Error("API key invalid"));

    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Codex setup
    fireEvent.click(screen.getByText("Codex"));
    fireEvent.change(screen.getByLabelText("Codex auth method"), { target: { value: "apiKey" } });
    const input = screen.getByLabelText("OpenAI API Key");
    fireEvent.change(input, { target: { value: "bad-key" } });
    fireEvent.click(screen.getByText("Verify Codex Auth"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => {
      expect(screen.getByText("API key invalid")).toBeInTheDocument();
    });
  });

  // Verifies local Codex auth checks by running the shared provider verifier.
  it("checks Codex local CLI auth when Verify is clicked", async () => {
    mockVerifyProvider.mockResolvedValueOnce({ valid: true });

    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Codex setup
    fireEvent.click(screen.getByText("Codex"));

    fireEvent.click(screen.getByText("Verify Codex Auth"));

    await waitFor(() => {
      expect(mockVerifyProvider).toHaveBeenCalledWith({
        provider: "codex",
        authMethod: "local",
        token: "",
        baseUrl: "",
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ codexAuthMethod: "local" });
    });
    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
    });
  });

  // Verifies error when local CLI verification fails.
  it("shows error when Codex local CLI auth verification fails", async () => {
    mockVerifyProvider.mockResolvedValueOnce({ valid: false, error: "Codex CLI auth check failed" });

    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Codex setup
    fireEvent.click(screen.getByText("Codex"));

    fireEvent.click(screen.getByText("Verify Codex Auth"));

    await waitFor(() => {
      expect(screen.getByText(/Codex CLI auth check failed/)).toBeInTheDocument();
    });
  });

  // Verifies copy button works (exercises CopyButton component, lines 634-636)
  it("renders copy button on Claude setup step", () => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    render(<OnboardingModal onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "oauth" } });

    const copyBtn = screen.getByLabelText("Copy command");
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("claude setup-token");
  });

  // Verifies error is cleared when navigating between steps
  it("clears error when navigating between steps", async () => {
    mockUpdateSettings.mockRejectedValueOnce(new Error("Save failed"));

    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Claude, trigger error
    fireEvent.click(screen.getByText("Claude Code"));
    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "oauth" } });
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "bad-token" } });
    fireEvent.click(screen.getByText("Verify Claude Auth"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("Save failed")).toBeInTheDocument();
    });

    // Navigate to Codex — error should be cleared
    fireEvent.click(screen.getByText("Skip"));
    expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
  });

  it("passes accessibility audit", async () => {
    const { axe } = await import("vitest-axe");
    render(<OnboardingModal onComplete={vi.fn()} />);
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });
});
