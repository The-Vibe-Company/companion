// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock window.location.reload — capture original for restoration
const originalLocation = window.location;
const mockReload = vi.fn();

import { UpdateOverlay, PlaygroundUpdateOverlay } from "./UpdateOverlay.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Apply location mock before each test so reload is intercepted
  Object.defineProperty(window, "location", {
    value: { ...originalLocation, reload: mockReload },
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  // Restore original location to avoid leaking state to other test files
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
  });
});

// ─── UpdateOverlay ──────────────────────────────────────────────────────────

describe("UpdateOverlay", () => {
  it("renders nothing when not active", () => {
    const { container } = render(<UpdateOverlay active={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the installing phase initially when active", () => {
    render(<UpdateOverlay active={true} />);
    expect(screen.getByText("Installing update...")).toBeTruthy();
    expect(screen.getByText("This page will refresh automatically")).toBeTruthy();
  });

  it("transitions to restarting phase after 3 seconds", () => {
    render(<UpdateOverlay active={true} />);
    expect(screen.getByText("Installing update...")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText("Restarting server...")).toBeTruthy();
  });

  it("transitions to waiting phase after 5 seconds", () => {
    // Fetch rejects (server not ready yet)
    mockFetch.mockRejectedValue(new Error("connection refused"));

    render(<UpdateOverlay active={true} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByText("Waiting for server...")).toBeTruthy();
  });

  it("transitions to ready and reloads when server responds", async () => {
    // First poll fails, second succeeds
    mockFetch
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ currentVersion: "0.24.0" }),
      });

    render(<UpdateOverlay active={true} />);

    // Advance to start polling (5s)
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Let the first rejected fetch settle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Advance past retry interval (1.5s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    // Let the successful fetch settle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText("Update complete!")).toBeTruthy();
    expect(screen.getByText("Reloading...")).toBeTruthy();

    // Advance past reload delay (800ms)
    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(mockReload).toHaveBeenCalled();
  });

  it("shows progress dots during non-ready phases", () => {
    const { container } = render(<UpdateOverlay active={true} />);
    // There should be 3 progress dots
    const dots = container.querySelectorAll('[data-testid="progress-dot"]');
    expect(dots.length).toBe(3);
  });

  it("hides progress dots in the ready phase", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ currentVersion: "0.24.0" }),
    });

    const { container } = render(<UpdateOverlay active={true} />);

    // Advance to polling and let it succeed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    const dots = container.querySelectorAll('[data-testid="progress-dot"]');
    expect(dots.length).toBe(0);
  });
});

// ─── PlaygroundUpdateOverlay ────────────────────────────────────────────────

describe("PlaygroundUpdateOverlay", () => {
  it("renders the installing phase", () => {
    render(<PlaygroundUpdateOverlay phase="installing" />);
    expect(screen.getByText("Installing update...")).toBeTruthy();
  });

  it("renders the restarting phase", () => {
    render(<PlaygroundUpdateOverlay phase="restarting" />);
    expect(screen.getByText("Restarting server...")).toBeTruthy();
  });

  it("renders the waiting phase", () => {
    render(<PlaygroundUpdateOverlay phase="waiting" />);
    expect(screen.getByText("Waiting for server...")).toBeTruthy();
  });

  it("renders the ready phase with success styling", () => {
    render(<PlaygroundUpdateOverlay phase="ready" />);
    expect(screen.getByText("Update complete!")).toBeTruthy();
    expect(screen.getByText("Reloading...")).toBeTruthy();
  });

  it("uses absolute positioning (not fixed) for contained preview", () => {
    const { container } = render(<PlaygroundUpdateOverlay phase="installing" />);
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.className).toContain("absolute");
    expect(overlay.className).not.toContain("fixed");
  });
});
