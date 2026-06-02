// @vitest-environment jsdom
/**
 * Tests for the OnboardingModal component.
 *
 * This modal appears on first launch when onboardingCompleted is false.
 * It guides users through configuring Claude Code (OAuth token) and Codex (OpenAI API key).
 *
 * Key behaviors tested:
 * - Welcome step renders with provider options
 * - Claude setup step shows command and token input
 * - Codex setup step shows API key input
 * - Saving tokens calls the API correctly
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
    getSettings: vi.fn().mockResolvedValue({ codexDeviceAuthConfigured: false }),
  },
}));

import { OnboardingModal } from "./OnboardingModal.js";
import { api } from "../api.js";

const mockUpdateSettings = vi.mocked(api.updateSettings);
const mockGetSettings = vi.mocked(api.getSettings);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSettings.mockResolvedValue({} as ReturnType<typeof api.updateSettings> extends Promise<infer T> ? T : never);
  mockGetSettings.mockResolvedValue({ codexDeviceAuthConfigured: false } as ReturnType<typeof api.getSettings> extends Promise<infer T> ? T : never);
});

describe("OnboardingModal", () => {
  it("renders the welcome step with provider options", () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    expect(screen.getByText("Welcome to The Companion")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("navigates to Claude setup when Claude Code is clicked", () => {
    render(<OnboardingModal onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Claude Code"));
    expect(screen.getByText("Set up Claude Code")).toBeInTheDocument();
    expect(screen.getByText("claude setup-token")).toBeInTheDocument();
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

    // Enter token
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "test-oauth-token" } });

    // Save
    fireEvent.click(screen.getByText("Save & Continue"));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ claudeCodeOAuthToken: "test-oauth-token" });
    });

    // Should navigate to Codex step
    await waitFor(() => {
      expect(screen.getByText("Set up Codex")).toBeInTheDocument();
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

    // Expand API key accordion
    fireEvent.click(screen.getByText("Or use an API key instead"));

    // Enter API key
    const input = screen.getByLabelText("OpenAI API Key");
    fireEvent.change(input, { target: { value: "sk-test-key" } });

    // Save — button shows "Save & Finish" when API key is entered
    fireEvent.click(screen.getByText("Save & Finish"));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ openaiApiKey: "sk-test-key" });
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
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "token" } });
    fireEvent.click(screen.getByText("Save & Continue"));

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
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "bad-token" } });
    fireEvent.click(screen.getByText("Save & Continue"));

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

    // Expand API key accordion, enter key and save
    fireEvent.click(screen.getByText("Or use an API key instead"));
    const input = screen.getByLabelText("OpenAI API Key");
    fireEvent.change(input, { target: { value: "bad-key" } });
    fireEvent.click(screen.getByText("Save & Finish"));

    await waitFor(() => {
      expect(screen.getByText("API key invalid")).toBeInTheDocument();
    });
  });

  // Verifies "I've logged in" button checks device auth via getSettings
  it("checks Codex device auth when 'I've logged in' is clicked", async () => {
    mockGetSettings.mockResolvedValueOnce({ codexDeviceAuthConfigured: true } as ReturnType<typeof api.getSettings> extends Promise<infer T> ? T : never);

    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Codex setup
    fireEvent.click(screen.getByText("Codex"));

    // Click "I've logged in" — should check device auth
    fireEvent.click(screen.getByText("I've logged in"));

    await waitFor(() => {
      expect(mockGetSettings).toHaveBeenCalled();
    });
    // Device auth found — should complete onboarding
    await waitFor(() => {
      expect(screen.getByText("You're all set!")).toBeInTheDocument();
    });
  });

  // Verifies error when device auth not found
  it("shows error when Codex device auth is not configured", async () => {
    mockGetSettings.mockResolvedValueOnce({ codexDeviceAuthConfigured: false } as ReturnType<typeof api.getSettings> extends Promise<infer T> ? T : never);

    render(<OnboardingModal onComplete={vi.fn()} />);

    // Go to Codex setup
    fireEvent.click(screen.getByText("Codex"));

    // Click "I've logged in" — no auth found
    fireEvent.click(screen.getByText("I've logged in"));

    await waitFor(() => {
      expect(screen.getByText(/No Codex auth found/)).toBeInTheDocument();
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
    const input = screen.getByLabelText("OAuth Token");
    fireEvent.change(input, { target: { value: "bad-token" } });
    fireEvent.click(screen.getByText("Save & Continue"));

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
