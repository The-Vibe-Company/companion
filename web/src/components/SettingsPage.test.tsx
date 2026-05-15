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
    channel?: "stable" | "prerelease";
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
  verifyProvider: vi.fn(),
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
    verifyProvider: (...args: unknown[]) => mockApi.verifyProvider(...args),
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
    claudeCodeOAuthTokenConfigured: false,
    claudeApiKeyConfigured: false,
    claudeAuthMethod: "local",
    claudeBaseUrl: "",
    claudeDeviceAuthConfigured: true,
    openaiApiKeyConfigured: false,
    codexAuthMethod: "local",
    openaiBaseUrl: "",
    codexDeviceAuthConfigured: true,
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
    claudeCodeOAuthTokenConfigured: false,
    claudeApiKeyConfigured: false,
    claudeAuthMethod: "local",
    claudeBaseUrl: "",
    claudeDeviceAuthConfigured: true,
    openaiApiKeyConfigured: false,
    codexAuthMethod: "local",
    openaiBaseUrl: "",
    codexDeviceAuthConfigured: true,
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
  mockApi.verifyProvider.mockResolvedValue({ valid: true });
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

  it("shows the automation helper copy under the API key input", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("Session naming and validation features are disabled until this key is configured.")).toBeInTheDocument();
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

  it("shows telemetry as disabled in privacy settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText("External telemetry")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("Telemetry is not included in this build.")).toBeInTheDocument();
    expect(screen.getByText("External telemetry").closest("div")).toHaveAttribute("aria-disabled", "true");
    expect(mockTelemetry.setTelemetryPreferenceEnabled).not.toHaveBeenCalled();
  });

  it("navigates to environments page from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Open Environments" }));
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

  it("labels the current update version as a local build when no release source is loaded", async () => {
    mockState = createMockState({
      updateInfo: {
        currentVersion: "0.95.0",
        latestVersion: null,
        updateAvailable: false,
        isServiceMode: false,
        updateInProgress: false,
        lastChecked: 0,
        channel: "stable",
      },
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText("Local build version: v0.95.0")).toBeInTheDocument();
    expect(screen.getByText("Release source not configured.")).toBeInTheDocument();
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

    for (const label of ["Access", "Device Login", "Agent Auth", "Automation AI", "Safety", "Runtime", "Privacy"]) {
      expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThanOrEqual(1);
    }
  });

  // The active settings category should be exposed semantically so the visual
  // menu highlight is also clear to assistive technology.
  it("marks the active settings category in navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    for (const button of screen.getAllByRole("button", { name: "General" })) {
      expect(button).toHaveAttribute("aria-current", "page");
    }

    fireEvent.click(screen.getAllByRole("button", { name: "Access" })[0]);

    for (const button of screen.getAllByRole("button", { name: "Access" })) {
      expect(button).toHaveAttribute("aria-current", "page");
    }
    for (const button of screen.getAllByRole("button", { name: "General" })) {
      expect(button).not.toHaveAttribute("aria-current");
    }
  });

  it("opens the Agent Auth section from the settings section query", async () => {
    window.location.hash = "#/settings?section=providers";

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    for (const button of screen.getAllByRole("button", { name: "Agent Auth" })) {
      expect(button).toHaveAttribute("aria-current", "page");
    }
    for (const button of screen.getAllByRole("button", { name: "General" })) {
      expect(button).not.toHaveAttribute("aria-current");
    }
  });

  // Verify section headings have correct IDs for anchor-based scrolling
  it("renders section headings with anchor IDs", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(document.getElementById("general")).toBeInTheDocument();
    expect(document.getElementById("webhooks")).toBeInTheDocument();
    expect(document.getElementById("authentication")).toBeInTheDocument();
    expect(document.getElementById("providers")).toBeInTheDocument();
    expect(document.getElementById("anthropic")).toBeInTheDocument();
    expect(document.getElementById("ai-validation")).toBeInTheDocument();
    expect(document.getElementById("environments")).toBeInTheDocument();
    expect(document.getElementById("updates")).toBeInTheDocument();
    expect(document.getElementById("telemetry")).toBeInTheDocument();
  });

  // Top-level settings section headings should stand apart from individual
  // field labels such as "Update Channel" so the page scans as grouped settings.
  it("renders top-level settings headings with stronger visual hierarchy", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByRole("heading", { name: "Updates" })).toHaveClass("text-lg");
    expect(screen.getByText("Update Channel")).toHaveClass("text-sm");
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

  // The Device Login navigation item appears in the sidebar.
  it("includes Device Login in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const authButtons = screen.getAllByRole("button", { name: "Device Login" });
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
      screen.getByText("Configure the Automation AI key above to enable AI validation."),
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

  // The Safety category appears in the sidebar navigation.
  it("includes Safety in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const aiValButtons = screen.getAllByRole("button", { name: "Safety" });
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

  // The Access category should appear in the sidebar navigation so users
  // can quickly jump to the webhook configuration section.
  it("includes Access in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Each category appears in both desktop sidebar and mobile nav (jsdom renders both)
    const webhookButtons = screen.getAllByRole("button", { name: "Access" });
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

    // The "Save Public URL" button is present but disabled until the value changes.
    expect(screen.getByRole("button", { name: "Save Public URL" })).toBeDisabled();
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

  // The Public URL save button should only be enabled when the value changes.
  // Clearing an existing value is a real change because it restores fallback URL behavior.
  it("allows clearing an existing public URL but disables unchanged values", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      publicUrl: "https://my-companion.example.com",
    });
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Using: https://my-companion.example.com");

    const saveButton = screen.getByRole("button", { name: "Save Public URL" });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Public URL"), { target: { value: "" } });
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ publicUrl: "" });
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
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "oauth",
      claudeBaseUrl: "https://claude-proxy.example.com",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "local",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Using Claude OAuth token");
    expect(screen.getByText("Using local Codex login")).toBeInTheDocument();
    expect(screen.queryByLabelText("Claude-compatible Base URL")).not.toBeInTheDocument();
  });

  // Verifies that the Claude Code token input shows masked dots when configured,
  // and clears on focus to allow entering a replacement token.
  it("shows masked dots in Claude Code token field when configured", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "oauth",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: false,
      openaiApiKeyConfigured: false,
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Using Claude OAuth token");

    const input = screen.getByLabelText("Claude Code OAuth Token") as HTMLInputElement;
    expect(input.value).toBe("••••••••••••••••");

    fireEvent.focus(input);
    expect(input.value).toBe("");
  });

  it("hides Claude Base URL unless Claude API key auth is selected", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "oauth",
      claudeBaseUrl: "https://claude-proxy.example.com",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "local",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Using Claude OAuth token");
    expect(screen.queryByLabelText("Claude-compatible Base URL")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "apiKey" } });
    expect(screen.getByLabelText("Claude-compatible Base URL")).toBeInTheDocument();
  });

  it("does not require saving when the current Claude auth method is already local", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "local",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "local",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Using local Claude login");

    fireEvent.click(screen.getByRole("button", { name: "Test Claude Auth" }));
    expect(await screen.findByText("Claude auth test passed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Using Claude Local Login" })).toBeDisabled();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it("uses auth method dropdowns and explains verify-before-save credential priority", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "oauth",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "local",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Using Claude OAuth token");

    expect(screen.getByLabelText("Claude auth method")).toHaveValue("oauth");
    expect(document.body.textContent).toContain("The dropdown opens on the currently saved method.");
    expect(document.body.textContent).toContain(
      "OAuth token and API key modes inject the saved credential for new sessions even if local Claude CLI login is also available. Session environment profiles and host process env vars can still override both.",
    );

    fireEvent.change(screen.getByLabelText("Claude auth method"), { target: { value: "local" } });

    expect(screen.getByLabelText("Claude auth method")).toHaveValue("local");
    expect(screen.getByRole("button", { name: "Save Claude Auth" })).toBeDisabled();
  });

  it("requires saving when switching Codex from API key auth back to local login", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "local",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: true,
      codexAuthMethod: "apiKey",
      openaiBaseUrl: "https://openai-proxy.example.com/v1",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "local",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: true,
      codexAuthMethod: "local",
      openaiBaseUrl: "https://openai-proxy.example.com/v1",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Using Codex API key");

    fireEvent.change(screen.getByLabelText("Codex auth method"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Test Codex Auth" }));
    expect(await screen.findByText("Codex auth test passed.")).toBeInTheDocument();

    const saveBtn = screen.getByRole("button", { name: "Save Codex Auth" });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ codexAuthMethod: "local" });
    });
  });

  // Verifies that provider settings are saved independently and only after a
  // successful provider test for the values currently in that provider card.
  it("requires a successful provider test before saving Codex auth", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "local",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: false,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "apiKey",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "local",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: false,
      openaiApiKeyConfigured: true,
      codexAuthMethod: "apiKey",
      openaiBaseUrl: "https://openai-proxy.example.com/v1",
      codexDeviceAuthConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("No available Codex auth");

    const openaiInput = screen.getByLabelText("OpenAI API Key") as HTMLInputElement;
    fireEvent.change(openaiInput, { target: { value: "sk-test-key" } });
    fireEvent.change(screen.getByLabelText("OpenAI-compatible Base URL"), {
      target: { value: " https://openai-proxy.example.com/v1/// " },
    });

    const saveBtn = screen.getByRole("button", { name: "Save Codex Auth" });
    expect(saveBtn).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Test Codex Auth" }));
    expect(await screen.findByText("Codex auth test passed.")).toBeInTheDocument();
    expect(saveBtn).not.toBeDisabled();

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        codexAuthMethod: "apiKey",
        openaiApiKey: "sk-test-key",
        openaiBaseUrl: "https://openai-proxy.example.com/v1///",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Codex auth saved.")).toBeInTheDocument();
      expect(openaiInput.value).toBe("••••••••••••••••");
      expect(screen.getByDisplayValue("https://openai-proxy.example.com/v1")).toBeInTheDocument();
    });
  });

  // Verifies each provider has its own save action instead of one global save
  // that mixes Claude Code and Codex credentials together.
  it("renders separate disabled save actions for Claude Code and Codex auth", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "oauth",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: false,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "apiKey",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findAllByText(/No available/);

    expect(screen.getByRole("button", { name: "Save Claude Auth" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Codex Auth" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save Provider Settings" })).not.toBeInTheDocument();
  });

  // Verifies the provider test button sends the typed token and Base URL to
  // the backend so users can validate third-party endpoints before saving.
  it("tests provider auth with typed token and base URL", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "local",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "apiKey",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("No available Codex auth");

    fireEvent.change(screen.getByLabelText("Codex auth method"), {
      target: { value: "apiKey" },
    });
    fireEvent.change(await screen.findByLabelText("OpenAI API Key"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI-compatible Base URL"), {
      target: { value: "https://openai-proxy.example.com/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test Codex Auth" }));

    await waitFor(() => {
      expect(mockApi.verifyProvider).toHaveBeenCalledWith({
        provider: "codex",
        authMethod: "apiKey",
        token: "sk-test-key",
        baseUrl: "https://openai-proxy.example.com/v1",
      });
    });
    expect(await screen.findByText("Codex auth test passed.")).toBeInTheDocument();
  });

  it("tests and saves Claude API key auth separately from Claude OAuth", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "apiKey",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "local",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      claudeApiKeyConfigured: true,
      claudeAuthMethod: "apiKey",
      claudeBaseUrl: "https://claude-proxy.example.com",
      claudeDeviceAuthConfigured: true,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "local",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("No available Claude auth");

    fireEvent.change(screen.getByLabelText("Claude API Key"), {
      target: { value: "sk-ant-session-key" },
    });
    fireEvent.change(screen.getByLabelText("Claude-compatible Base URL"), {
      target: { value: "https://claude-proxy.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test Claude Auth" }));

    await waitFor(() => {
      expect(mockApi.verifyProvider).toHaveBeenCalledWith({
        provider: "claude",
        authMethod: "apiKey",
        token: "sk-ant-session-key",
        baseUrl: "https://claude-proxy.example.com",
      });
    });

    const saveBtn = screen.getByRole("button", { name: "Save Claude Auth" });
    await waitFor(() => {
      expect(saveBtn).not.toBeDisabled();
    });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        claudeAuthMethod: "apiKey",
        claudeApiKey: "sk-ant-session-key",
        claudeBaseUrl: "https://claude-proxy.example.com",
      });
    });
  });

  // Verifies that the Providers section passes accessibility checks
  it("passes axe accessibility checks for the Providers section", async () => {
    const { axe } = await import("vitest-axe");

    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      claudeApiKeyConfigured: false,
      claudeAuthMethod: "local",
      claudeBaseUrl: "",
      claudeDeviceAuthConfigured: false,
      openaiApiKeyConfigured: false,
      codexAuthMethod: "local",
      openaiBaseUrl: "",
      codexDeviceAuthConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findAllByText(/No available/);

    const providersSection = document.getElementById("providers");
    expect(providersSection).toBeInTheDocument();

    const results = await axe(providersSection!);
    expect(results).toHaveNoViolations();
  });
});
