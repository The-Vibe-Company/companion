// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { UpdateInfo } from "../api.js";

const mockSetUpdateInfo = vi.fn();
const mockDismissUpdate = vi.fn();
const mockTriggerUpdate = vi.fn();

let storeState: Record<string, unknown> = {};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeState),
}));

vi.mock("../api.js", () => ({
  api: {
    triggerUpdate: () => mockTriggerUpdate(),
  },
}));

import { UpdateBanner } from "./UpdateBanner.js";

function makeUpdateInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    currentVersion: "0.22.1",
    latestVersion: "0.23.0",
    updateAvailable: true,
    isServiceMode: false,
    updateInProgress: false,
    lastChecked: Date.now(),
    channel: "stable",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeState = {
    updateInfo: null,
    updateDismissedVersion: null,
    dismissUpdate: mockDismissUpdate,
  };
});

// ─── Visibility ────────────────────────────────────────────────────────────

describe("UpdateBanner visibility", () => {
  it("renders nothing when updateInfo is null", () => {
    storeState.updateInfo = null;
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when updateAvailable is false", () => {
    storeState.updateInfo = makeUpdateInfo({ updateAvailable: false });
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when latestVersion is null", () => {
    storeState.updateInfo = makeUpdateInfo({ latestVersion: null });
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the version is dismissed", () => {
    storeState.updateInfo = makeUpdateInfo();
    storeState.updateDismissedVersion = "0.23.0";
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders banner when update is available and not dismissed", () => {
    storeState.updateInfo = makeUpdateInfo();
    render(<UpdateBanner />);
    expect(screen.getByText("v0.23.0")).toBeTruthy();
    expect(screen.getByText(/v0\.22\.1/)).toBeTruthy();
  });

  it("reappears when a newer version supersedes the dismissed one", () => {
    storeState.updateInfo = makeUpdateInfo({ latestVersion: "0.24.0" });
    storeState.updateDismissedVersion = "0.23.0";
    render(<UpdateBanner />);
    expect(screen.getByText("v0.24.0")).toBeTruthy();
  });
});

// ─── Service mode ──────────────────────────────────────────────────────────

describe("UpdateBanner service mode", () => {
  it("shows Update & Restart button in service mode", () => {
    storeState.updateInfo = makeUpdateInfo({ isServiceMode: true });
    render(<UpdateBanner />);
    expect(screen.getByText("Update & Restart")).toBeTruthy();
  });

  it("shows install hint in foreground mode", () => {
    storeState.updateInfo = makeUpdateInfo({ isServiceMode: false });
    render(<UpdateBanner />);
    expect(screen.getByText("the-companion install")).toBeTruthy();
  });

  it("shows Updating... when update is in progress", () => {
    storeState.updateInfo = makeUpdateInfo({
      isServiceMode: true,
      updateInProgress: true,
    });
    render(<UpdateBanner />);
    expect(screen.getByText("Updating...")).toBeTruthy();
  });
});

// ─── Interactions ──────────────────────────────────────────────────────────

describe("UpdateBanner interactions", () => {
  it("calls triggerUpdate when Update & Restart is clicked", () => {
    mockTriggerUpdate.mockResolvedValue({ ok: true });
    storeState.updateInfo = makeUpdateInfo({ isServiceMode: true });
    render(<UpdateBanner />);

    fireEvent.click(screen.getByText("Update & Restart"));
    expect(mockTriggerUpdate).toHaveBeenCalledOnce();
  });

  it("calls dismissUpdate with the latest version when dismiss is clicked", () => {
    storeState.updateInfo = makeUpdateInfo();
    render(<UpdateBanner />);

    const dismissBtn = screen.getByTitle("Dismiss");
    fireEvent.click(dismissBtn);
    expect(mockDismissUpdate).toHaveBeenCalledWith("0.23.0");
  });
});
