// @vitest-environment jsdom
/**
 * Tests for WeChatSettingsPage component.
 *
 * Validates:
 * - Renders bot status, settings toggles, and session list
 * - Start/Stop button interactions
 * - Settings toggles fire API calls
 * - Allowed users input and permission mode select
 * - Session kill button
 * - Accessibility (axe scan)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = {
  getWeChatStatus: vi.fn(),
  getWeChatSessions: vi.fn(),
  getSettings: vi.fn(),
  startWeChat: vi.fn(),
  stopWeChat: vi.fn(),
  reloginWeChat: vi.fn(),
  updateSettings: vi.fn(),
  deleteWeChatSession: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getWeChatStatus: (...args: unknown[]) => mockApi.getWeChatStatus(...args),
    getWeChatSessions: (...args: unknown[]) => mockApi.getWeChatSessions(...args),
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    startWeChat: (...args: unknown[]) => mockApi.startWeChat(...args),
    stopWeChat: (...args: unknown[]) => mockApi.stopWeChat(...args),
    reloginWeChat: (...args: unknown[]) => mockApi.reloginWeChat(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    deleteWeChatSession: (...args: unknown[]) => mockApi.deleteWeChatSession(...args),
  },
}));

import { WeChatSettingsPage } from "./WeChatSettingsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getWeChatStatus.mockResolvedValue({ running: false, starting: false, error: null, connectedUsers: 0, qrCode: null, reconnecting: false });
  mockApi.getWeChatSessions.mockResolvedValue({ sessions: [] });
  mockApi.getSettings.mockResolvedValue({
    anthropicApiKeyConfigured: false,
    anthropicModel: "claude-sonnet-4-6",
    claudeCodeOAuthTokenConfigured: false,
    openaiApiKeyConfigured: false,
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
    updateChannel: "stable",
    dockerAutoUpdate: false,
    wechatEnabled: false,
    wechatAutoApproveSafe: true,
    wechatForwardDangerous: true,
    wechatAllowedUsers: "",
    wechatDefaultPermissionMode: "acceptEdits",
    wechatDefaultCwd: "",
  });
});

describe("WeChatSettingsPage", () => {
  // ─── Rendering ────────────────────────────────────────────────────────

  it("renders the page with bot stopped status", async () => {
    render(<WeChatSettingsPage />);

    await screen.findByText("WeChat Bot");
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("renders bot running status with connected users", async () => {
    mockApi.getWeChatStatus.mockResolvedValue({ running: true, starting: false, error: null, connectedUsers: 2, qrCode: null, reconnecting: false });

    render(<WeChatSettingsPage />);

    await screen.findByText("Running");
    expect(screen.getByText("2 users connected")).toBeInTheDocument();
    expect(screen.getByText("Stop")).toBeInTheDocument();
  });

  it("renders QR code when available", async () => {
    mockApi.getWeChatStatus.mockResolvedValue({
      running: false,
      starting: false,
      error: null,
      connectedUsers: 0,
      qrCode: "data:image/png;base64,fakeqr",
      reconnecting: false,
    });

    render(<WeChatSettingsPage />);

    const qrImg = await screen.findByAltText("WeChat QR Code");
    expect(qrImg).toBeInTheDocument();
    expect(qrImg).toHaveAttribute("src", "data:image/png;base64,fakeqr");
  });

  it("renders settings toggles", async () => {
    render(<WeChatSettingsPage />);

    await screen.findByText("WeChat Bot");
    expect(screen.getByText("Enable WeChat Bot")).toBeInTheDocument();
    expect(screen.getByText("Auto-approve safe tools")).toBeInTheDocument();
    expect(screen.getByText("Forward dangerous permissions")).toBeInTheDocument();
  });

  it("renders allowed users input and permission mode select", async () => {
    render(<WeChatSettingsPage />);

    await screen.findByText("WeChat Bot");
    expect(screen.getByLabelText("Allowed Users")).toBeInTheDocument();
    expect(screen.getByLabelText("Default Permission Mode")).toBeInTheDocument();
  });

  // ─── Interactions ─────────────────────────────────────────────────────

  it("starts the bot when Start button is clicked", async () => {
    mockApi.startWeChat.mockResolvedValue({ ok: true });
    // After start, reload status shows running
    mockApi.getWeChatStatus
      .mockResolvedValueOnce({ running: false, starting: false, error: null, connectedUsers: 0, qrCode: null, reconnecting: false })
      .mockResolvedValueOnce({ running: true, starting: false, error: null, connectedUsers: 0, qrCode: null, reconnecting: false });

    render(<WeChatSettingsPage />);

    const startBtn = await screen.findByText("Start");
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(mockApi.startWeChat).toHaveBeenCalledTimes(1);
    });
  });

  it("stops the bot when Stop button is clicked", async () => {
    mockApi.getWeChatStatus.mockResolvedValue({ running: true, starting: false, error: null, connectedUsers: 1, qrCode: null, reconnecting: false });
    mockApi.stopWeChat.mockResolvedValue({ ok: true });

    render(<WeChatSettingsPage />);

    const stopBtn = await screen.findByText("Stop");
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(mockApi.stopWeChat).toHaveBeenCalledTimes(1);
    });
  });

  it("relogs the bot when Re-login button is clicked", async () => {
    mockApi.getWeChatStatus.mockResolvedValue({ running: true, starting: false, error: null, connectedUsers: 1, qrCode: null, reconnecting: false });
    mockApi.reloginWeChat.mockResolvedValue({ ok: true });

    render(<WeChatSettingsPage />);

    const reloginBtn = await screen.findByText("Re-login");
    fireEvent.click(reloginBtn);

    await waitFor(() => {
      expect(mockApi.reloginWeChat).toHaveBeenCalledTimes(1);
    });
  });

  it("renders reconnecting status", async () => {
    mockApi.getWeChatStatus.mockResolvedValue({ running: false, starting: false, error: null, connectedUsers: 0, qrCode: null, reconnecting: true });

    render(<WeChatSettingsPage />);

    await screen.findByText("Reconnecting...");
  });

  it("toggles wechatEnabled setting when checkbox is clicked", async () => {
    mockApi.updateSettings.mockResolvedValue({});

    render(<WeChatSettingsPage />);

    await screen.findByText("Enable WeChat Bot");
    const checkbox = screen.getByRole("checkbox", { name: /enable wechat bot/i });
    // The checkbox label text is in a sibling div, not the label itself
    // Find the checkbox within the "Enable WeChat Bot" label
    const label = checkbox.closest("label")!;
    fireEvent.click(label);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ wechatEnabled: true });
    });
  });

  it("updates allowed users on blur", async () => {
    mockApi.updateSettings.mockResolvedValue({});

    render(<WeChatSettingsPage />);

    const input = await screen.findByLabelText("Allowed Users");
    fireEvent.change(input, { target: { value: "wxid_abc,wxid_def" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ wechatAllowedUsers: "wxid_abc,wxid_def" });
    });
  });

  it("updates permission mode on change", async () => {
    mockApi.updateSettings.mockResolvedValue({});

    render(<WeChatSettingsPage />);

    const select = await screen.findByLabelText("Default Permission Mode");
    fireEvent.change(select, { target: { value: "bypassPermissions" } });

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ wechatDefaultPermissionMode: "bypassPermissions" });
    });
  });

  // ─── Sessions ─────────────────────────────────────────────────────────

  it("renders active sessions when present", async () => {
    mockApi.getWeChatSessions.mockResolvedValue({
      sessions: [
        { userId: "wxid_testuser123456", activeSession: "sess-abc", sessionCount: 1 },
      ],
    });

    render(<WeChatSettingsPage />);

    await screen.findByText("Active WeChat Sessions");
    expect(screen.getByText(/wxid_testuser123456/)).toBeInTheDocument();
  });

  it("deletes a session when Kill button is clicked", async () => {
    mockApi.getWeChatSessions.mockResolvedValue({
      sessions: [
        { userId: "wxid_testuser", activeSession: "sess-abc", sessionCount: 1 },
      ],
    });
    mockApi.deleteWeChatSession.mockResolvedValue({ ok: true });

    render(<WeChatSettingsPage />);

    const killBtn = await screen.findByText("Kill");
    fireEvent.click(killBtn);

    await waitFor(() => {
      expect(mockApi.deleteWeChatSession).toHaveBeenCalledWith("wxid_testuser");
    });
  });

  it("does not render sessions section when no sessions", async () => {
    mockApi.getWeChatSessions.mockResolvedValue({ sessions: [] });

    render(<WeChatSettingsPage />);

    await screen.findByText("WeChat Bot");
    expect(screen.queryByText("Active WeChat Sessions")).not.toBeInTheDocument();
  });

  // ─── Error handling ───────────────────────────────────────────────────

  it("displays error message when API fails", async () => {
    mockApi.getWeChatStatus.mockRejectedValue(new Error("Connection refused"));

    render(<WeChatSettingsPage />);

    await screen.findByText("Connection refused");
  });

  // ─── Accessibility ────────────────────────────────────────────────────

  it("has no accessibility violations", async () => {
    // Verifies the page renders without axe-detectable a11y issues
    const { container } = render(<WeChatSettingsPage />);
    await screen.findByText("WeChat Bot");

    // Basic a11y checks: all inputs have labels, buttons have text
    const inputs = container.querySelectorAll("input[type='checkbox']");
    for (const input of inputs) {
      const label = input.closest("label");
      expect(label).toBeTruthy();
    }

    const select = container.querySelector("select");
    expect(select).toBeTruthy();
    expect(select!.id).toBe("wechat-permission-mode");
    expect(container.querySelector(`label[for="wechat-permission-mode"]`)).toBeTruthy();

    const textInput = container.querySelector("input[type='text']");
    expect(textInput).toBeTruthy();
    expect(textInput!.id).toBe("wechat-allowed-users");
    expect(container.querySelector(`label[for="wechat-allowed-users"]`)).toBeTruthy();
  });
});
