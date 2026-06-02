// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// IntersectionObserver is not available in jsdom — provide a no-op mock
// so the scroll-tracking logic in SettingsPage doesn't crash during tests.
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
}
(globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;

interface MockStoreState {
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  diffBase: string;
  publicUrl: string;
  updateInfo: {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    isServiceMode: boolean;
    updateInProgress: boolean;
    lastChecked: number;
  } | null;
  toggleDarkMode: ReturnType<typeof vi.fn>;
  toggleNotificationSound: ReturnType<typeof vi.fn>;
  setNotificationDesktop: ReturnType<typeof vi.fn>;
  setDiffBase: ReturnType<typeof vi.fn>;
  setPublicUrl: ReturnType<typeof vi.fn>;
  setUpdateInfo: ReturnType<typeof vi.fn>;
  setUpdateOverlayActive: ReturnType<typeof vi.fn>;
  setEditorTabEnabled: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    darkMode: false,
    notificationSound: true,
    notificationDesktop: false,
    diffBase: "last-commit",
    publicUrl: "",
    updateInfo: null,
    toggleDarkMode: vi.fn(),
    toggleNotificationSound: vi.fn(),
    setNotificationDesktop: vi.fn(),
    setDiffBase: vi.fn(),
    setPublicUrl: vi.fn(),
    setUpdateInfo: vi.fn(),
    setUpdateOverlayActive: vi.fn(),
    setEditorTabEnabled: vi.fn(),
    ...overrides,
  };
}

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  forceCheckForUpdate: vi.fn(),
  triggerUpdate: vi.fn(),
  getAuthToken: vi.fn(),
  regenerateAuthToken: vi.fn(),
  getAuthQr: vi.fn(),
  verifyAnthropicKey: vi.fn(),
};

const mockTelemetry = {
  getTelemetryPreferenceEnabled: vi.fn(),
  setTelemetryPreferenceEnabled: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    forceCheckForUpdate: (...args: unknown[]) => mockApi.forceCheckForUpdate(...args),
    triggerUpdate: (...args: unknown[]) => mockApi.triggerUpdate(...args),
    getAuthToken: (...args: unknown[]) => mockApi.getAuthToken(...args),
    regenerateAuthToken: (...args: unknown[]) => mockApi.regenerateAuthToken(...args),
    getAuthQr: (...args: unknown[]) => mockApi.getAuthQr(...args),
    verifyAnthropicKey: (...args: unknown[]) => mockApi.verifyAnthropicKey(...args),
  },
}));

vi.mock("../analytics.js", () => ({
  getTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.getTelemetryPreferenceEnabled(...args),
  setTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.setTelemetryPreferenceEnabled(...args),
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { SettingsPage } from "./SettingsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  window.location.hash = "#/settings";
  mockApi.getSettings.mockResolvedValue({
    anthropicApiKeyConfigured: true,
    anthropicModel: "claude-sonnet-4-6",
    linearApiKeyConfigured: false,
    linearAutoTransition: false,
    linearAutoTransitionStateName: "",
    updateChannel: "stable",
    publicUrl: "",
  });
  mockApi.updateSettings.mockResolvedValue({
    anthropicApiKeyConfigured: true,
    anthropicModel: "claude-sonnet-4-6",
    linearApiKeyConfigured: false,
    linearAutoTransition: false,
    linearAutoTransitionStateName: "",
    updateChannel: "stable",
    publicUrl: "",
  });
  mockApi.forceCheckForUpdate.mockResolvedValue({
    currentVersion: "0.22.1",
    latestVersion: null,
    updateAvailable: false,
    isServiceMode: false,
    updateInProgress: false,
    lastChecked: Date.now(),
    channel: "stable",
  });
  mockApi.triggerUpdate.mockResolvedValue({
    ok: true,
    message: "Update started. Server will restart shortly.",
  });
  mockApi.getAuthToken.mockResolvedValue({ token: "abc123testtoken" });
  mockApi.regenerateAuthToken.mockResolvedValue({ token: "newtoken456" });
  mockApi.getAuthQr.mockResolvedValue({
    qrCodes: [
      { label: "LAN", url: "http://192.168.1.10:3456", qrDataUrl: "data:image/png;base64,LAN_QR" },
      { label: "Tailscale", url: "http://100.118.112.23:3456", qrDataUrl: "data:image/png;base64,TS_QR" },
    ],
  });
  mockTelemetry.getTelemetryPreferenceEnabled.mockReturnValue(true);
});

describe("SettingsPage", () => {
  it("loads settings on mount and shows configured status", async () => {
    render(<SettingsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    await screen.findByText("Anthropic key configured");
    expect(screen.getByDisplayValue("claude-sonnet-4-6")).toBeInTheDocument();
  });

  // When a key is already configured, the input shows masked dots (••••) to
  // visually indicate a key is present. The dots clear on focus so the user
  // can type a replacement key.
  it("shows masked dots in API key field when key is configured", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const input = screen.getByLabelText("Anthropic API Key") as HTMLInputElement;
    expect(input.value).toBe("••••••••••••••••");

    // On focus the dots clear to allow entering a new key
    fireEvent.focus(input);
    expect(input.value).toBe("");
  });

  it("shows not configured status", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: false,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
    });

    render(<SettingsPage />);

    await screen.findByText("Anthropic key not configured");
  });

  it("shows the auto-renaming helper copy under the API key input", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("Auto-renaming is disabled until this key is configured.")).toBeInTheDocument();
  });

  it("saves settings with trimmed values", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic API Key"), {
      target: { value: "  or-key  " },
    });
    fireEvent.change(screen.getByLabelText("Anthropic Model"), {
      target: { value: "  openai/gpt-4o-mini  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        anthropicApiKey: "or-key",
        anthropicModel: "openai/gpt-4o-mini",
      });
    });

    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
  });

  it("falls back model to claude-sonnet-4-6 when blank", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");
    fireEvent.change(screen.getByLabelText("Anthropic Model"), {
      target: { value: "   " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        anthropicModel: "claude-sonnet-4-6",
      });
    });
  });

  it("does not send key when left empty", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic Model"), {
      target: { value: "openai/gpt-4o-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        anthropicModel: "openai/gpt-4o-mini",
      });
    });
  });

  it("shows error if initial load fails", async () => {
    mockApi.getSettings.mockRejectedValueOnce(new Error("load failed"));

    render(<SettingsPage />);

    expect(await screen.findByText("load failed")).toBeInTheDocument();
  });

  it("shows error if save fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("save failed"));

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic API Key"), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("save failed")).toBeInTheDocument();
  });

  it("navigates back when Back button is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.hash).toBe("");
  });

  it("hides Back button in embedded mode", async () => {
    render(<SettingsPage embedded />);
    await screen.findByText("Anthropic key configured");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("shows saving state while request is in flight", async () => {
    let resolveSave: ((value: {
      anthropicApiKeyConfigured: boolean;
      anthropicModel: string;
      linearApiKeyConfigured: boolean;
      linearAutoTransition: boolean;
      linearAutoTransitionStateName: string;
    }) => void) | undefined;
    mockApi.updateSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve as typeof resolveSave;
      }),
    );

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic API Key"), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Both the Anthropic "Save" and Webhooks "Save Public URL" buttons share the
    // `saving` state, so both show "Saving..." while the request is in flight.
    // We check that the submit-type button (Anthropic form) is disabled.
    const savingButtons = screen.getAllByRole("button", { name: "Saving..." });
    expect(savingButtons.length).toBeGreaterThanOrEqual(1);
    const submitSavingBtn = savingButtons.find((b) => b.getAttribute("type") === "submit");
    expect(submitSavingBtn).toBeDefined();
    expect(submitSavingBtn).toBeDisabled();

    resolveSave?.({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
    });

    await screen.findByText("Settings saved.");
  });

  it("toggles sound notifications from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /Sound/i }));
    expect(mockState.toggleNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("toggles theme from settings", async () => {
    mockState = createMockState({ darkMode: true });
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /Theme/i }));
    expect(mockState.toggleDarkMode).toHaveBeenCalledTimes(1);
  });

  it("toggles telemetry preference from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /Usage analytics and errors/i }));
    expect(mockTelemetry.setTelemetryPreferenceEnabled).toHaveBeenCalledWith(false);
  });

  it("navigates to environments page from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Open Environments Page" }));
    expect(window.location.hash).toBe("#/environments");
  });

  it("requests desktop permission before enabling desktop alerts", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");
    fireEvent.click(screen.getByRole("button", { name: /Desktop Alerts/i }));

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(mockState.setNotificationDesktop).toHaveBeenCalledWith(true);
    });
    vi.unstubAllGlobals();
  });

  it("checks for updates from settings and stores update info", async () => {
    mockApi.forceCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.22.1",
      latestVersion: "0.23.0",
      updateAvailable: true,
      isServiceMode: true,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(mockApi.forceCheckForUpdate).toHaveBeenCalledTimes(1);
      expect(mockState.setUpdateInfo).toHaveBeenCalledWith(expect.objectContaining({
        latestVersion: "0.23.0",
        updateAvailable: true,
      }));
    });
    expect(await screen.findByText("Update v0.23.0 is available.")).toBeInTheDocument();
  });

  it("triggers app update from settings when service mode is enabled", async () => {
    mockState = createMockState({
      updateInfo: {
        currentVersion: "0.22.1",
        latestVersion: "0.23.0",
        updateAvailable: true,
        isServiceMode: true,
        updateInProgress: false,
        lastChecked: Date.now(),
      },
    });
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));

    await waitFor(() => {
      expect(mockApi.triggerUpdate).toHaveBeenCalledTimes(1);
    });
    expect(mockState.setUpdateOverlayActive).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Update started. Server will restart shortly.")).toBeInTheDocument();
  });

  // Verify left sidebar nav renders category labels for quick navigation
  it("renders category navigation with all section labels", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Each category appears in both desktop sidebar and mobile nav (jsdom renders both)
    const generalButtons = screen.getAllByRole("button", { name: "General" });
    expect(generalButtons.length).toBeGreaterThanOrEqual(1);

    const notifButtons = screen.getAllByRole("button", { name: "Notifications" });
    expect(notifButtons.length).toBeGreaterThanOrEqual(1);
  });

  // Verify section headings have correct IDs for anchor-based scrolling
  it("renders section headings with anchor IDs", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(document.getElementById("general")).toBeInTheDocument();
    expect(document.getElementById("webhooks")).toBeInTheDocument();
    expect(document.getElementById("authentication")).toBeInTheDocument();
    expect(document.getElementById("notifications")).toBeInTheDocument();
    expect(document.getElementById("anthropic")).toBeInTheDocument();
    expect(document.getElementById("updates")).toBeInTheDocument();
    expect(document.getElementById("telemetry")).toBeInTheDocument();
    expect(document.getElementById("environments")).toBeInTheDocument();
  });

  // ─── Authentication section tests ──────────────────────────────────

  // The auth section fetches the token on mount and displays it masked.
  it("fetches and displays the auth token masked by default", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Token should be fetched
    expect(mockApi.getAuthToken).toHaveBeenCalledTimes(1);

    // Token is masked by default — shows dots, not the actual value
    await waitFor(() => {
      expect(screen.getByText("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022")).toBeInTheDocument();
    });
    expect(screen.queryByText("abc123testtoken")).not.toBeInTheDocument();
  });

  // Clicking "Show" reveals the actual token value.
  it("reveals the token when Show is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    await waitFor(() => {
      expect(screen.getByText("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Show token"));
    expect(screen.getByText("abc123testtoken")).toBeInTheDocument();
  });

  // Clicking "Show QR Code" loads and displays QR with address tabs.
  it("shows QR code with address tabs when button is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Show QR Code" }));

    await waitFor(() => {
      expect(mockApi.getAuthQr).toHaveBeenCalledTimes(1);
    });

    // First address (LAN) QR should be shown by default
    const img = await screen.findByAltText("QR code for LAN login");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/png;base64,LAN_QR");

    // Address tabs should be visible (LAN and Tailscale)
    expect(screen.getByRole("button", { name: "LAN" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tailscale" })).toBeInTheDocument();

    // Clicking Tailscale tab switches the QR code
    fireEvent.click(screen.getByRole("button", { name: "Tailscale" }));
    const tsImg = screen.getByAltText("QR code for Tailscale login");
    expect(tsImg).toHaveAttribute("src", "data:image/png;base64,TS_QR");
    expect(screen.getByText("http://100.118.112.23:3456")).toBeInTheDocument();
  });

  // Regenerating the token calls the API and reveals the new token.
  it("regenerates the token after user confirms", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate Token" }));

    await waitFor(() => {
      expect(mockApi.regenerateAuthToken).toHaveBeenCalledTimes(1);
    });

    // New token is revealed automatically after regeneration
    expect(await screen.findByText("newtoken456")).toBeInTheDocument();

    (window.confirm as ReturnType<typeof vi.spyOn>).mockRestore();
  });

  // Cancelling the confirmation dialog skips regeneration entirely.
  it("does not regenerate when user cancels confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate Token" }));

    expect(mockApi.regenerateAuthToken).not.toHaveBeenCalled();

    (window.confirm as ReturnType<typeof vi.spyOn>).mockRestore();
  });

  // The Authentication navigation item appears in the sidebar.
  it("includes Authentication in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const authButtons = screen.getAllByRole("button", { name: "Authentication" });
    expect(authButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Verify button tests ──────────────────────────────────

  // The Verify button is disabled when the API key input is empty.
  it("disables Verify button when anthropic key input is empty", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    expect(verifyBtn).toBeDisabled();
  });

  // The Verify button is enabled when the user types a new key.
  it("enables Verify button when user types a key", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    expect(verifyBtn).toBeEnabled();
  });

  // Clicking Verify calls verifyAnthropicKey and shows success state.
  it("shows success message when verify succeeds", async () => {
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: true });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    expect(mockApi.verifyAnthropicKey).toHaveBeenCalledWith("sk-ant-test-key");
    await screen.findByText("API key is valid.");
  });

  // Clicking Verify shows error state when verification fails.
  it("shows error message when verify fails", async () => {
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: false, error: "API returned 401" });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-bad-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    expect(mockApi.verifyAnthropicKey).toHaveBeenCalledWith("sk-ant-bad-key");
    await screen.findByText("Invalid API key: API returned 401");
  });

  // Verify result auto-dismisses after 5 seconds.
  it("auto-dismisses verify result after 5 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: true });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    await screen.findByText("API key is valid.");

    // Advance past the 5s auto-dismiss
    act(() => {
      vi.advanceTimersByTime(5100);
    });

    await waitFor(() => {
      expect(screen.queryByText("API key is valid.")).not.toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  // Verify result clears when the key input changes.
  it("clears verify result when key input changes", async () => {
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: true });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    await screen.findByText("API key is valid.");

    // Changing the key should clear the verify result
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key-changed" } });

    await waitFor(() => {
      expect(screen.queryByText("API key is valid.")).not.toBeInTheDocument();
    });
  });

  // ─── AI Validation section tests ──────────────────────────────────

  // The AI Validation section renders with its heading and the toggle button
  // when an Anthropic key is configured (configured === true).
  it("renders AI Validation section with toggle when Anthropic key is configured", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Section heading should be present inside the #ai-validation section
    const section = document.getElementById("ai-validation");
    expect(section).toBeInTheDocument();

    // The main toggle button should be enabled (not disabled) when key is configured
    const toggleBtn = screen.getByRole("button", { name: /AI Validation Mode/i });
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn).not.toBeDisabled();

    // It should show "Off" by default since aiValidationEnabled defaults to false
    expect(toggleBtn).toHaveTextContent("Off");
  });

  // When no Anthropic API key is configured, the AI Validation toggle should
  // be disabled and a warning message should appear.
  it("disables AI Validation toggle when Anthropic key is NOT configured", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: false,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key not configured");

    const toggleBtn = screen.getByRole("button", { name: /AI Validation Mode/i });
    expect(toggleBtn).toBeDisabled();

    // Warning message should be shown
    expect(
      screen.getByText("Configure an Anthropic API key above to enable AI validation."),
    ).toBeInTheDocument();
  });

  // Clicking the AI Validation Mode toggle should call updateSettings with
  // aiValidationEnabled set to the opposite of its current value.
  it("calls updateSettings with aiValidationEnabled when toggle is clicked", async () => {
    mockApi.updateSettings.mockResolvedValue({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /AI Validation Mode/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationEnabled: true });
    });
  });

  // When AI Validation is enabled (and Anthropic key is configured), the
  // auto-approve and auto-deny sub-toggles should appear.
  it("shows auto-approve and auto-deny sub-toggles when AI Validation is enabled", async () => {
    // Return settings with aiValidationEnabled: true so sub-toggles render
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Sub-toggles should be visible
    expect(screen.getByRole("button", { name: /Auto-approve safe tools/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Auto-deny dangerous tools/i })).toBeInTheDocument();
  });

  // Sub-toggles should NOT appear when AI Validation is disabled.
  it("hides auto-approve and auto-deny sub-toggles when AI Validation is disabled", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.queryByRole("button", { name: /Auto-approve safe tools/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Auto-deny dangerous tools/i })).not.toBeInTheDocument();
  });

  // Clicking the auto-approve toggle should call updateSettings with the
  // aiValidationAutoApprove field toggled to the opposite value.
  it("calls updateSettings with aiValidationAutoApprove when auto-approve is toggled", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });
    mockApi.updateSettings.mockResolvedValue({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: true,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Auto-approve is currently "On" (true), clicking should toggle to false
    fireEvent.click(screen.getByRole("button", { name: /Auto-approve safe tools/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationAutoApprove: false });
    });
  });

  // Clicking the auto-deny toggle should call updateSettings with the
  // aiValidationAutoDeny field toggled to the opposite value.
  it("calls updateSettings with aiValidationAutoDeny when auto-deny is toggled", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });
    mockApi.updateSettings.mockResolvedValue({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Auto-deny is currently "On" (true), clicking should toggle to false
    fireEvent.click(screen.getByRole("button", { name: /Auto-deny dangerous tools/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationAutoDeny: false });
    });
  });

  // When the API call in toggleAiValidation fails, the UI should revert
  // the optimistic update back to the original value.
  it("reverts AI Validation toggle on API failure", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("network error"));

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const toggleBtn = screen.getByRole("button", { name: /AI Validation Mode/i });
    // Initially off
    expect(toggleBtn).toHaveTextContent("Off");

    // Click to enable — optimistic update sets it to "On"
    fireEvent.click(toggleBtn);

    // After the API rejects, the toggle should revert back to "Off"
    await waitFor(() => {
      expect(toggleBtn).toHaveTextContent("Off");
    });
  });

  // The AI Validation section includes its anchor ID for sidebar navigation.
  it("renders AI Validation section with anchor ID for navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(document.getElementById("ai-validation")).toBeInTheDocument();
  });

  // The AI Validation category appears in the sidebar navigation.
  it("includes AI Validation in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const aiValButtons = screen.getAllByRole("button", { name: "AI Validation" });
    expect(aiValButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Update Channel section tests ──────────────────────────────────

  // The update channel selector renders with Stable selected by default.
  it("renders update channel selector with Stable selected by default", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText("Stable")).toBeInTheDocument();
    expect(screen.getByText("Prerelease")).toBeInTheDocument();
    expect(screen.getByText(/Tracking stable channel/)).toBeInTheDocument();
  });

  // When settings load with prerelease channel, it shows the prerelease description.
  it("shows prerelease description when channel is prerelease", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "prerelease",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText(/Tracking prerelease channel/)).toBeInTheDocument();
  });

  // Clicking Prerelease calls updateSettings and re-checks for updates.
  it("switches to prerelease channel and re-checks updates", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "prerelease",
    });
    mockApi.forceCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.66.0",
      latestVersion: "0.67.0-preview.1",
      updateAvailable: true,
      isServiceMode: false,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "prerelease",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByText("Prerelease"));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ updateChannel: "prerelease" });
    });
    await waitFor(() => {
      expect(mockApi.forceCheckForUpdate).toHaveBeenCalled();
    });
  });

  // Clicking Stable when already on stable is a no-op (doesn't call updateSettings).
  it("does not call updateSettings when clicking already-selected channel", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByText("Stable"));

    // Should not have called updateSettings since stable is already selected
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  // ─── Docker Auto-Update toggle tests ──────────────────────────────────

  // The Docker auto-update toggle renders in the Updates section and calls
  // updateSettings with dockerAutoUpdate when clicked.
  it("toggles dockerAutoUpdate and calls updateSettings", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Find the toggle by its role=switch and aria-checked attribute
    const toggle = screen.getByRole("switch", { name: "" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Click to enable
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ dockerAutoUpdate: true });
    });
  });

  // When the API call for dockerAutoUpdate fails, the toggle should revert
  // to its previous value (optimistic update rollback).
  it("reverts dockerAutoUpdate toggle on API failure", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
    });
    mockApi.updateSettings.mockRejectedValueOnce(new Error("network error"));

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const toggle = screen.getByRole("switch", { name: "" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Click to enable — optimistic update sets it to true
    fireEvent.click(toggle);

    // After the API rejects, the toggle should revert back to false
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });
  });

  // When settings load with dockerAutoUpdate: true, the toggle should
  // reflect the enabled state.
  it("shows dockerAutoUpdate as enabled when loaded from settings", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      dockerAutoUpdate: true,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const toggle = screen.getByRole("switch", { name: "" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  // ─── Webhooks section tests ──────────────────────────────────

  // The Webhooks category should appear in the sidebar navigation so users
  // can quickly jump to the webhook configuration section.
  it("includes Webhooks in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Each category appears in both desktop sidebar and mobile nav (jsdom renders both)
    const webhookButtons = screen.getAllByRole("button", { name: "Webhooks" });
    expect(webhookButtons.length).toBeGreaterThanOrEqual(1);
  });

  // The Public URL input should render inside the Webhooks section with the
  // correct type ("url") and an accessible label. When no publicUrl is set,
  // the fallback text should show the current window origin.
  it("renders Public URL input in Webhooks section with fallback text", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // The section heading should be present
    expect(document.getElementById("webhooks")).toBeInTheDocument();

    // The input should be accessible via its aria-label
    const urlInput = screen.getByLabelText("Public URL") as HTMLInputElement;
    expect(urlInput).toBeInTheDocument();
    expect(urlInput.type).toBe("url");
    expect(urlInput.id).toBe("public-url");

    // When publicUrl is empty, the fallback text should show window.location.origin
    expect(screen.getByText(`Fallback: ${window.location.origin}`)).toBeInTheDocument();

    // The "Save Public URL" button should be present
    expect(screen.getByRole("button", { name: "Save Public URL" })).toBeInTheDocument();
  });

  // When a publicUrl is set (returned from getSettings), the status text should
  // show "Using: {url}" instead of the fallback origin.
  it("shows 'Using: {url}' status when publicUrl is set", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      publicUrl: "https://my-companion.example.com",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText("Using: https://my-companion.example.com")).toBeInTheDocument();
  });

  // Entering a URL and clicking "Save Public URL" should call api.updateSettings
  // with the trimmed publicUrl value and update the store via setPublicUrl.
  it("saves public URL via api.updateSettings when Save Public URL is clicked", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      publicUrl: "https://my-companion.example.com",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const urlInput = screen.getByLabelText("Public URL");
    fireEvent.change(urlInput, { target: { value: "  https://my-companion.example.com  " } });

    fireEvent.click(screen.getByRole("button", { name: "Save Public URL" }));

    // Should call updateSettings with trimmed publicUrl
    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        publicUrl: "https://my-companion.example.com",
      });
    });

    // After save, the store's setPublicUrl should be called with the returned value
    await waitFor(() => {
      expect(mockState.setPublicUrl).toHaveBeenCalledWith("https://my-companion.example.com");
    });
  });

  // Axe accessibility scan for the Webhooks section to ensure it meets
  // WCAG standards (labels, roles, contrast, etc.).
  it("passes axe accessibility checks for the Webhooks section", async () => {
    const { axe } = await import("vitest-axe");

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const webhooksSection = document.getElementById("webhooks");
    expect(webhooksSection).toBeInTheDocument();

    const results = await axe(webhooksSection!);
    expect(results).toHaveNoViolations();
  });

  // --- Providers section tests ---

  // Verifies the Providers section renders and shows the correct configuration
  // status for Claude Code token and OpenAI API key based on server settings.
  it("renders Providers section with configured status from server", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token configured");
    expect(screen.getByText("OpenAI key not configured")).toBeInTheDocument();
  });

  // Verifies that the Claude Code token input shows masked dots when configured,
  // and clears on focus to allow entering a replacement token.
  it("shows masked dots in Claude Code token field when configured", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token configured");

    const input = screen.getByLabelText("Claude Code OAuth Token") as HTMLInputElement;
    expect(input.value).toBe("••••••••••••••••");

    fireEvent.focus(input);
    expect(input.value).toBe("");
  });

  // Verifies that provider settings are saved correctly via updateSettings API
  // and that the inputs are cleared after successful save.
  it("saves provider settings and clears inputs on success", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    // Wait for initial load to complete
    await screen.findByText("Claude Code token not configured");

    const claudeInput = screen.getByLabelText("Claude Code OAuth Token") as HTMLInputElement;
    const openaiInput = screen.getByLabelText("OpenAI API Key (Codex)") as HTMLInputElement;

    fireEvent.change(claudeInput, { target: { value: "test-oauth-token" } });
    fireEvent.change(openaiInput, { target: { value: "sk-test-key" } });

    const saveBtn = screen.getByRole("button", { name: "Save Provider Settings" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        claudeCodeOAuthToken: "test-oauth-token",
        openaiApiKey: "sk-test-key",
      });
    });

    // Inputs should be cleared after save – button is disabled again,
    // and masked-dot placeholders are restored since both tokens are now configured.
    await waitFor(() => {
      expect(screen.getByText("Provider settings saved.")).toBeInTheDocument();
      expect(saveBtn).toBeDisabled();
      expect(claudeInput.value).toBe("••••••••••••••••");
      expect(openaiInput.value).toBe("••••••••••••••••");
    });
  });

  // Verifies that the save button is disabled when both provider inputs are empty
  it("disables Save Provider Settings button when no inputs have values", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token not configured");

    const saveBtn = screen.getByRole("button", { name: "Save Provider Settings" });
    expect(saveBtn).toBeDisabled();
  });

  // Verifies that the Providers section passes accessibility checks
  it("passes axe accessibility checks for the Providers section", async () => {
    const { axe } = await import("vitest-axe");

    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token not configured");

    const providersSection = document.getElementById("providers");
    expect(providersSection).toBeInTheDocument();

    const results = await axe(providersSection!);
    expect(results).toHaveNoViolations();
  });
});
