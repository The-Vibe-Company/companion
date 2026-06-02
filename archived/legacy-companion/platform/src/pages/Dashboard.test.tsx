// @vitest-environment jsdom
/**
 * Tests for the Dashboard page component.
 *
 * Validates rendering of loading, error, empty, and populated states.
 * Also verifies that the polling hook activates for transitional instances.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

// Mock auth-client used by DashboardSidebar
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { name: "Test User", email: "test@example.com" } },
    }),
    signOut: vi.fn(),
  },
}));

// Mock API module
const mockListInstances = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    listInstances: (...args: unknown[]) => mockListInstances(...args),
    stopInstance: vi.fn(() => Promise.resolve()),
    startInstance: vi.fn(() => Promise.resolve()),
    deleteInstance: vi.fn(() => Promise.resolve()),
  },
}));

import { Dashboard } from "./Dashboard";

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Render tests ──────────────────────────────────────────────────────

  it("renders loading state initially", () => {
    // Never-resolving promise keeps loading state active
    mockListInstances.mockReturnValue(new Promise(() => {}));
    render(<Dashboard />);
    // The Loader2 spinner should be rendered (it is an SVG with animate-spin)
    expect(document.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders instance cards after loading", async () => {
    mockListInstances.mockResolvedValue({
      instances: [
        { id: "i-1", hostname: "app-one.example.com", machineStatus: "started", region: "iad" },
        { id: "i-2", hostname: "app-two.example.com", machineStatus: "stopped", region: "cdg" },
      ],
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("app-one.example.com")).toBeTruthy();
      expect(screen.getByText("app-two.example.com")).toBeTruthy();
    });
  });

  it("renders empty state when no instances", async () => {
    mockListInstances.mockResolvedValue({ instances: [] });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("No instances yet")).toBeTruthy();
    });
  });

  it("renders error state on API failure", async () => {
    mockListInstances.mockRejectedValue(new Error("Network error"));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load instances")).toBeTruthy();
    });
  });

  // ── Polling test ──────────────────────────────────────────────────────
  // Uses a short real-world wait to verify polling fires rather than
  // fighting fake-timer/promise interactions.

  it("polls when transitional instances exist", async () => {
    // Always return transitional instances so polling stays active
    mockListInstances.mockResolvedValue({
      instances: [{ id: "i-1", hostname: "app.example.com", machineStatus: "provisioning", region: "iad" }],
    });

    render(<Dashboard />);

    // Wait for initial load
    await waitFor(() => {
      expect(mockListInstances).toHaveBeenCalledTimes(1);
    });

    // The hook uses a 4s default interval. We can test with a shorter
    // interval by overriding, but Dashboard hardcodes the default.
    // Instead, just wait for the poll cycle (real timer).
    await waitFor(
      () => {
        expect(mockListInstances.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 6000 },
    );
  }, 10000);

  // ── Accessibility ─────────────────────────────────────────────────────

  it("has no accessibility violations", async () => {
    mockListInstances.mockResolvedValue({
      instances: [
        { id: "i-1", hostname: "app.example.com", machineStatus: "started", region: "iad", ownerType: "shared" },
      ],
    });

    const { container } = render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("app.example.com")).toBeTruthy();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 10000);
});
