// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import "vitest-axe/extend-expect";

const mockApi = {
  getTailscaleStatus: vi.fn(),
  startTailscaleFunnel: vi.fn(),
  stopTailscaleFunnel: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getTailscaleStatus: (...args: unknown[]) => mockApi.getTailscaleStatus(...args),
    startTailscaleFunnel: (...args: unknown[]) => mockApi.startTailscaleFunnel(...args),
    stopTailscaleFunnel: (...args: unknown[]) => mockApi.stopTailscaleFunnel(...args),
  },
}));

// Shared mock store state so tests can configure publicUrl and assert setPublicUrl calls
const mockSetPublicUrl = vi.fn();
let mockPublicUrl = "";

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        currentSessionId: null,
        publicUrl: mockPublicUrl,
        setPublicUrl: mockSetPublicUrl,
      }),
    {
      getState: () => ({
        currentSessionId: null,
        publicUrl: mockPublicUrl,
        setPublicUrl: mockSetPublicUrl,
      }),
    },
  ),
}));

vi.mock("../utils/routing.js", () => ({
  navigateHome: vi.fn(),
  navigateToSession: vi.fn(),
}));

import { TailscalePage } from "./TailscalePage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPublicUrl = "";
});

describe("TailscalePage", () => {
  // Renders the page and displays basic structure
  it("renders the page header and hero section", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    expect(await screen.findByText("Tailscale Settings")).toBeInTheDocument();
    expect(screen.getByText("HTTPS access in one click")).toBeInTheDocument();
    expect(screen.getByText("Tailscale Funnel")).toBeInTheDocument();
  });

  // Shows "not installed" message when Tailscale binary is not found
  it("displays not-installed state correctly", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: false,
      binaryPath: null,
      connected: false,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    expect(await screen.findByText(/not installed on this machine/i)).toBeInTheDocument();
    expect(screen.getByText("Install Tailscale")).toBeInTheDocument();
    // Status badge
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  // Shows "not connected" state with instructions
  it("displays not-connected state with tailscale up instruction", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: false,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    expect(await screen.findByText(/not connected to a tailnet/i)).toBeInTheDocument();
    expect(screen.getByText("tailscale up")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  // Shows "Enable" button when connected but funnel is off
  it("shows Enable button when connected and funnel is off", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    const enableBtn = await screen.findByRole("button", { name: /enable https/i });
    expect(enableBtn).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  // Shows active funnel URL and Disable button
  it("shows funnel URL and Disable button when funnel is active", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
    });

    render(<TailscalePage embedded />);

    expect(await screen.findByText("https://my-machine.ts.net")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable funnel/i })).toBeInTheDocument();
    expect(screen.getByText("Funnel active")).toBeInTheDocument();
  });

  // Clicking Enable calls the start API
  it("calls startTailscaleFunnel when Enable is clicked", async () => {
    const user = userEvent.setup();

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    mockApi.startTailscaleFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
    });

    render(<TailscalePage embedded />);

    const enableBtn = await screen.findByRole("button", { name: /enable https/i });
    await user.click(enableBtn);

    await waitFor(() => {
      expect(mockApi.startTailscaleFunnel).toHaveBeenCalledTimes(1);
    });

    // After success, should show the URL
    expect(await screen.findByText("https://my-machine.ts.net")).toBeInTheDocument();
  });

  // Clicking Disable calls the stop API
  it("calls stopTailscaleFunnel when Disable is clicked", async () => {
    const user = userEvent.setup();

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
    });

    mockApi.stopTailscaleFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    const disableBtn = await screen.findByRole("button", { name: /disable funnel/i });
    await user.click(disableBtn);

    await waitFor(() => {
      expect(mockApi.stopTailscaleFunnel).toHaveBeenCalledTimes(1);
    });
  });

  // Shows error message from the API
  it("displays error message when present in status", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: "Something went wrong",
    });

    render(<TailscalePage embedded />);

    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
  });

  // Renders the how-it-works cards
  it("renders the three-step how-it-works cards", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: false,
      binaryPath: null,
      connected: false,
      dnsName: null,
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    expect(await screen.findByText("1. Install")).toBeInTheDocument();
    expect(screen.getByText("2. Enable")).toBeInTheDocument();
    expect(screen.getByText("3. Done")).toBeInTheDocument();
  });

  // Accessibility: no axe violations
  it("has no accessibility violations", async () => {
    const { axe } = await import("vitest-axe");

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
    });

    const { container } = render(<TailscalePage embedded />);

    // Wait for async data to load
    await screen.findByText("https://my-machine.ts.net");

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Handles API fetch failure gracefully
  it("handles fetch failure gracefully", async () => {
    mockApi.getTailscaleStatus.mockRejectedValue(new Error("Network error"));

    render(<TailscalePage embedded />);

    // Should show a fallback message rather than crashing
    expect(await screen.findByText("Could not check Tailscale status.")).toBeInTheDocument();
  });

  // Error recovery: re-fetches status after Enable fails, shows error overlay
  it("re-fetches status and shows error when Enable fails", async () => {
    const user = userEvent.setup();

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    // startTailscaleFunnel rejects (e.g. 503 thrown as Error)
    mockApi.startTailscaleFunnel.mockRejectedValue(new Error("Permission denied"));

    render(<TailscalePage embedded />);

    const enableBtn = await screen.findByRole("button", { name: /enable https/i });
    await user.click(enableBtn);

    // Error message should appear
    expect(await screen.findByText(/Permission denied/)).toBeInTheDocument();

    // getTailscaleStatus called twice: once on mount, once on error recovery
    await waitFor(() => {
      expect(mockApi.getTailscaleStatus).toHaveBeenCalledTimes(2);
    });
  });

  // Error recovery: re-fetches status after Disable fails
  it("re-fetches status and shows error when Disable fails", async () => {
    const user = userEvent.setup();

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
    });

    mockApi.stopTailscaleFunnel.mockRejectedValue(new Error("Stop failed"));

    render(<TailscalePage embedded />);

    const disableBtn = await screen.findByRole("button", { name: /disable funnel/i });
    await user.click(disableBtn);

    expect(await screen.findByText(/Stop failed/)).toBeInTheDocument();
  });

  // Regression: onDisableFunnel does NOT clear publicUrl if user manually set a different URL
  it("does not clear publicUrl when store URL differs from funnel URL", async () => {
    const user = userEvent.setup();

    // Store has a manually-set URL that differs from the funnel
    mockPublicUrl = "https://custom-domain.example.com";

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
    });

    mockApi.stopTailscaleFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    const disableBtn = await screen.findByRole("button", { name: /disable funnel/i });
    await user.click(disableBtn);

    await waitFor(() => {
      expect(mockApi.stopTailscaleFunnel).toHaveBeenCalledTimes(1);
    });

    // setPublicUrl should NOT have been called because store URL doesn't match funnel URL
    expect(mockSetPublicUrl).not.toHaveBeenCalled();
  });

  // Proactive operator mode warning renders before Enable button
  it("shows proactive operator mode warning when needsOperatorMode is true", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
      needsOperatorMode: true,
    });

    render(<TailscalePage embedded />);

    // Should show proactive warning and the command
    expect(await screen.findByText(/Setup needed: Tailscale operator mode/)).toBeInTheDocument();
    expect(screen.getByText("sudo tailscale set --operator=$USER")).toBeInTheDocument();

    // Enable button should still be clickable
    expect(screen.getByRole("button", { name: /enable https/i })).toBeEnabled();
  });

  // Structured permission error panel with Retry button
  it("shows structured permission error panel with Retry on enable failure", async () => {
    const user = userEvent.setup();

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    // startTailscaleFunnel returns operator mode error (200 with error in body)
    mockApi.startTailscaleFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: "Tailscale requires operator mode on Linux to manage Funnel.",
      needsOperatorMode: true,
    });

    render(<TailscalePage embedded />);

    const enableBtn = await screen.findByRole("button", { name: /enable https/i });
    await user.click(enableBtn);

    // Should show structured amber panel, not generic red error
    expect(await screen.findByText("Operator mode required")).toBeInTheDocument();
    expect(screen.getByText("sudo tailscale set --operator=$USER")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  // Retry button calls startTailscaleFunnel again
  it("Retry button calls startTailscaleFunnel again", async () => {
    const user = userEvent.setup();

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    // First call: permission error; second call: success
    mockApi.startTailscaleFunnel
      .mockResolvedValueOnce({
        installed: true, binaryPath: "/usr/bin/tailscale", connected: true,
        dnsName: "my-machine.ts.net", funnelActive: false, funnelUrl: null,
        error: "Tailscale requires operator mode on Linux to manage Funnel.",
        needsOperatorMode: true,
      })
      .mockResolvedValueOnce({
        installed: true, binaryPath: "/usr/bin/tailscale", connected: true,
        dnsName: "my-machine.ts.net", funnelActive: true,
        funnelUrl: "https://my-machine.ts.net", error: null,
      });

    render(<TailscalePage embedded />);

    // Click Enable → permission error
    const enableBtn = await screen.findByRole("button", { name: /enable https/i });
    await user.click(enableBtn);

    // Click Retry
    const retryBtn = await screen.findByRole("button", { name: /retry/i });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(mockApi.startTailscaleFunnel).toHaveBeenCalledTimes(2);
    });
  });

  // publicUrl is not set in store when warning is present
  it("does not set publicUrl when DNS warning is present", async () => {
    const user = userEvent.setup();

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    mockApi.startTailscaleFunnel.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
      warning: "DNS for this hostname is not resolving publicly.",
    });

    render(<TailscalePage embedded />);

    const enableBtn = await screen.findByRole("button", { name: /enable https/i });
    await user.click(enableBtn);

    await waitFor(() => {
      expect(mockApi.startTailscaleFunnel).toHaveBeenCalledTimes(1);
    });

    // publicUrl should NOT be set when there's a DNS warning
    expect(mockSetPublicUrl).not.toHaveBeenCalled();
  });

  // DNS warning shows when funnel is active but hostname doesn't resolve
  it("shows DNS warning panel when status has a warning", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: true,
      funnelUrl: "https://my-machine.ts.net",
      error: null,
      warning: "DNS for this hostname is not resolving publicly.",
    });

    render(<TailscalePage embedded />);

    expect(await screen.findByText("URL may not be publicly accessible")).toBeInTheDocument();
    expect(screen.getByText(/DNS for this hostname is not resolving/)).toBeInTheDocument();
    expect(screen.getByText("Open Tailscale admin console")).toBeInTheDocument();
  });

  // Generic error still works for non-permission errors
  it("shows generic red error for non-permission errors", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: "Funnel started but could not determine URL",
    });

    render(<TailscalePage embedded />);

    const errorEl = await screen.findByText("Funnel started but could not determine URL");
    // Should be in the generic red error box (not the amber panel)
    expect(errorEl.closest("div")).toHaveClass("bg-cc-error/10");
  });

  // Accessibility: no violations on operator mode warning state
  it("has no accessibility violations with operator mode warning", async () => {
    const { axe } = await import("vitest-axe");

    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: "Tailscale requires operator mode on Linux to manage Funnel.",
      needsOperatorMode: true,
    });

    const { container } = render(<TailscalePage embedded />);

    await screen.findByText("Operator mode required");

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Navigation: Integrations button navigates back to integrations hub
  it("Integrations button navigates to integrations page", async () => {
    mockApi.getTailscaleStatus.mockResolvedValue({
      installed: true,
      binaryPath: "/usr/bin/tailscale",
      connected: true,
      dnsName: "my-machine.ts.net",
      funnelActive: false,
      funnelUrl: null,
      error: null,
    });

    render(<TailscalePage embedded />);

    await screen.findByText("Tailscale Settings");

    const integrationsBtn = screen.getByRole("button", { name: "Integrations" });
    integrationsBtn.click();

    await waitFor(() => {
      expect(window.location.hash).toBe("#/integrations");
    });
  });
});
