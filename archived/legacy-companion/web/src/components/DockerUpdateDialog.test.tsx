// @vitest-environment jsdom
/**
 * Tests for DockerUpdateDialog component.
 *
 * Validates:
 * - Render gating: dialog hidden when store flag is false
 * - Prompt phase: shows title, description, toggle, and action buttons
 * - Accessibility: axe scan on the dialog
 * - Skip button: closes the dialog
 * - Update button: transitions to pulling phase and calls pullImage API
 * - Toggle: persists dockerAutoUpdate setting
 * - Done button: closes dialog after successful pull
 * - Error phase: shows error state with retry option
 * - Playground previews: render all four phases
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useStore } from "../store.js";

// Mock the api module
vi.mock("../api.js", () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({ dockerAutoUpdate: false }),
    updateSettings: vi.fn().mockResolvedValue({}),
    pullImage: vi.fn().mockResolvedValue({ ok: true, state: { image: "the-companion:latest", status: "pulling", progress: [] } }),
    getImageStatus: vi.fn().mockResolvedValue({ image: "the-companion:latest", status: "pulling", progress: ["Pulling layer 1..."] }),
  },
}));

import { DockerUpdateDialog, PlaygroundDockerUpdateDialog } from "./DockerUpdateDialog.js";
import { api } from "../api.js";

const mockedApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  pullImage: ReturnType<typeof vi.fn>;
  getImageStatus: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Reset dialog state
  useStore.getState().setDockerUpdateDialogOpen(false);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── DockerUpdateDialog ──────────────────────────────────────────────

describe("DockerUpdateDialog", () => {
  it("renders nothing when dialog is not open", () => {
    // Dialog should not render when store flag is false
    const { container } = render(<DockerUpdateDialog />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the prompt phase when dialog is open", async () => {
    // Opening the dialog should show the prompt asking about Docker update
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    // Wait for settings to load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByTestId("docker-update-dialog")).toBeTruthy();
    expect(screen.getByText("Update Sandbox Image?")).toBeTruthy();
    expect(screen.getByText(/Would you like to also/)).toBeTruthy();
    expect(screen.getByText("Skip")).toBeTruthy();
    expect(screen.getByText("Update")).toBeTruthy();
    expect(screen.getByText("Always update Docker image automatically")).toBeTruthy();
  });

  it("passes axe accessibility scan", async () => {
    // Validates that the dialog has no accessibility violations.
    // axe-core needs real timers to run its analysis.
    vi.useRealTimers();
    const { axe } = await import("vitest-axe");
    useStore.getState().setDockerUpdateDialogOpen(true);

    const { container } = render(<DockerUpdateDialog />);

    // Wait for the settings fetch to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    vi.useFakeTimers();
  }, 15000);

  it("closes the dialog when Skip is clicked", async () => {
    // Skip should close the dialog without triggering any update
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    fireEvent.click(screen.getByText("Skip"));

    expect(useStore.getState().dockerUpdateDialogOpen).toBe(false);
    expect(mockedApi.pullImage).not.toHaveBeenCalled();
  });

  it("triggers image pull when Update is clicked", async () => {
    // Update button should call pullImage and transition to pulling phase
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Update"));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(mockedApi.pullImage).toHaveBeenCalledWith("the-companion:latest");
    expect(screen.getByText("Updating Sandbox Image...")).toBeTruthy();
  });

  it("toggles the always-update setting", async () => {
    // Clicking the toggle should save the dockerAutoUpdate setting
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Always update Docker image automatically"));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(mockedApi.updateSettings).toHaveBeenCalledWith({ dockerAutoUpdate: true });
  });

  it("auto-triggers pull when dockerAutoUpdate is already enabled", async () => {
    // When dockerAutoUpdate is true, the dialog should skip the prompt
    // and go straight to the pulling phase
    mockedApi.getSettings.mockResolvedValue({ dockerAutoUpdate: true });
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Should have started pulling automatically without user interaction
    expect(mockedApi.pullImage).toHaveBeenCalledWith("the-companion:latest");
    expect(screen.getByText("Updating Sandbox Image...")).toBeTruthy();
  });

  it("shows done phase when pull completes successfully", async () => {
    // After a successful pull, dialog should show the success state
    mockedApi.getSettings.mockResolvedValue({ dockerAutoUpdate: false });
    mockedApi.getImageStatus.mockResolvedValue({
      image: "the-companion:latest",
      status: "ready",
      progress: ["Done"],
    });
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Click Update
    await act(async () => {
      fireEvent.click(screen.getByText("Update"));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Advance past poll interval (2s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(screen.getByText("Sandbox Image Updated")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("shows error phase when pull fails", async () => {
    // Error state should be shown with a retry option
    mockedApi.getSettings.mockResolvedValue({ dockerAutoUpdate: false });
    mockedApi.getImageStatus.mockResolvedValue({
      image: "the-companion:latest",
      status: "error",
      progress: ["Layer 1 failed"],
      error: "Network timeout",
    });
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Click Update
    await act(async () => {
      fireEvent.click(screen.getByText("Update"));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Advance past poll interval (2s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(screen.getByText("Image Update Failed")).toBeTruthy();
    expect(screen.getByText("Network timeout")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(screen.getByText("Close")).toBeTruthy();
  });

  it("closes dialog when Done is clicked after successful pull", async () => {
    // Done button in the success state should close the dialog
    mockedApi.getSettings.mockResolvedValue({ dockerAutoUpdate: false });
    mockedApi.getImageStatus.mockResolvedValue({
      image: "the-companion:latest",
      status: "ready",
      progress: [],
    });
    useStore.getState().setDockerUpdateDialogOpen(true);

    render(<DockerUpdateDialog />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Click Update
    await act(async () => {
      fireEvent.click(screen.getByText("Update"));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Advance past poll interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    fireEvent.click(screen.getByText("Done"));

    expect(useStore.getState().dockerUpdateDialogOpen).toBe(false);
  });
});

// ─── PlaygroundDockerUpdateDialog ─────────────────────────────────

describe("PlaygroundDockerUpdateDialog", () => {
  it("renders prompt phase preview", () => {
    render(<PlaygroundDockerUpdateDialog phase="prompt" />);
    expect(screen.getByText("Update Sandbox Image?")).toBeTruthy();
  });

  it("renders pulling phase preview", () => {
    render(<PlaygroundDockerUpdateDialog phase="pulling" />);
    expect(screen.getByText("Updating Sandbox Image...")).toBeTruthy();
  });

  it("renders done phase preview", () => {
    render(<PlaygroundDockerUpdateDialog phase="done" />);
    expect(screen.getByText("Sandbox Image Updated")).toBeTruthy();
  });

  it("renders error phase preview", () => {
    render(<PlaygroundDockerUpdateDialog phase="error" />);
    expect(screen.getByText("Image Update Failed")).toBeTruthy();
  });
});
