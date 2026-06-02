// @vitest-environment jsdom
/**
 * Tests for the root App component.
 *
 * App is the top-level layout that gates on authentication. When
 * `isAuthenticated` is false it renders <LoginPage />. When authenticated
 * it renders the full chrome (Sidebar, TopBar, routed pages).
 *
 * Coverage targets:
 * - Render test and axe accessibility scan
 * - Auth gate: unauthenticated renders LoginPage
 * - Authenticated home: renders Sidebar, TopBar, HomePage
 * - Authenticated session: renders ChatView within session layout
 * - Dark mode class toggling
 * - Playground route renders lazy Playground
 * - Various page routes (settings, environments, etc.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Hoisted mocks (must be before vi.mock calls) ────────────────
const { mockStoreState, mockGetState } = vi.hoisted(() => {
  const mockGetState = vi.fn();
  const mockStoreState: Record<string, unknown> = {
    isAuthenticated: false,
    darkMode: false,
    currentSessionId: null,
    sidebarOpen: false,
    taskPanelOpen: false,
    homeResetKey: 0,
    activeTab: "chat" as string,
    setActiveTab: vi.fn(),
    sessionCreating: false,
    sessionCreatingBackend: null,
    creationProgress: null,
    creationError: null,
    updateOverlayActive: false,
    changedFilesTick: new Map(),
    diffBase: "HEAD",
    setGitChangedFilesCount: vi.fn(),
    sessions: new Map(),
    sdkSessions: [],
    setCurrentSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setTaskPanelOpen: vi.fn(),
    clearCreation: vi.fn(),
    setUpdateInfo: vi.fn(),
    setDockerUpdateDialogOpen: vi.fn(),
  };
  mockGetState.mockReturnValue(mockStoreState);
  return { mockStoreState, mockGetState };
});

// ─── Module mocks ────────────────────────────────────────────────

vi.mock("./store.js", () => {
  const useStore = Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
    { getState: () => mockGetState() },
  );
  return { useStore };
});

vi.mock("./ws.js", () => ({
  connectSession: vi.fn(),
}));

vi.mock("./api.js", () => ({
  api: {
    getChangedFiles: vi.fn().mockResolvedValue({ files: [] }),
    checkForUpdate: vi.fn().mockResolvedValue(null),
    getSettings: vi.fn().mockResolvedValue({ publicUrl: "" }),
  },
}));

vi.mock("./analytics.js", () => ({
  capturePageView: vi.fn(),
}));

vi.mock("./utils/routing.js", () => ({
  parseHash: vi.fn().mockReturnValue({ page: "home" }),
  navigateToSession: vi.fn(),
  navigateHome: vi.fn(),
}));

// ─── Component mocks ─────────────────────────────────────────────
// Mock all child components so we can assert their presence without
// pulling in their full dependency trees.

vi.mock("./components/LoginPage.js", () => ({
  LoginPage: () => <div data-testid="login-page">LoginPage</div>,
}));

vi.mock("./components/Sidebar.js", () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

vi.mock("./components/TopBar.js", () => ({
  TopBar: () => <div data-testid="topbar">TopBar</div>,
}));

vi.mock("./components/HomePage.js", () => ({
  HomePage: () => <div data-testid="home-page">HomePage</div>,
}));

vi.mock("./components/ChatView.js", () => ({
  ChatView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-view">ChatView:{sessionId}</div>
  ),
}));

vi.mock("./components/TaskPanel.js", () => ({
  TaskPanel: () => <div data-testid="task-panel">TaskPanel</div>,
}));

vi.mock("./components/DiffPanel.js", () => ({
  DiffPanel: () => <div data-testid="diff-panel">DiffPanel</div>,
}));

vi.mock("./components/UpdateBanner.js", () => ({
  UpdateBanner: () => <div data-testid="update-banner">UpdateBanner</div>,
}));

vi.mock("./components/SessionLaunchOverlay.js", () => ({
  SessionLaunchOverlay: () => <div data-testid="session-launch-overlay">SessionLaunchOverlay</div>,
}));

vi.mock("./components/UpdateOverlay.js", () => ({
  UpdateOverlay: ({ active }: { active: boolean }) => (
    <div data-testid="update-overlay" data-active={active}>UpdateOverlay</div>
  ),
}));

vi.mock("./components/DockerUpdateDialog.js", () => ({
  DockerUpdateDialog: () => <div data-testid="docker-update-dialog">DockerUpdateDialog</div>,
}));

// Lazy-loaded pages: mock each module so dynamic import() resolves immediately
vi.mock("./components/Playground.js", () => ({
  Playground: () => <div data-testid="playground">Playground</div>,
}));

vi.mock("./components/SettingsPage.js", () => ({
  SettingsPage: () => <div data-testid="settings-page">SettingsPage</div>,
}));

vi.mock("./components/IntegrationsPage.js", () => ({
  IntegrationsPage: () => <div data-testid="integrations-page">IntegrationsPage</div>,
}));

vi.mock("./components/LinearSettingsPage.js", () => ({
  LinearSettingsPage: () => <div data-testid="linear-settings-page">LinearSettingsPage</div>,
}));

vi.mock("./components/PromptsPage.js", () => ({
  PromptsPage: () => <div data-testid="prompts-page">PromptsPage</div>,
}));

vi.mock("./components/EnvManager.js", () => ({
  EnvManager: () => <div data-testid="env-manager">EnvManager</div>,
}));

vi.mock("./components/CronManager.js", () => ({
  CronManager: () => <div data-testid="cron-manager">CronManager</div>,
}));

vi.mock("./components/AgentsPage.js", () => ({
  AgentsPage: () => <div data-testid="agents-page">AgentsPage</div>,
}));

// ─── Import SUT after mocks ─────────────────────────────────────
import App from "./App.js";
import { parseHash } from "./utils/routing.js";

// ─── Helpers ─────────────────────────────────────────────────────

function setStoreValues(overrides: Record<string, unknown>) {
  Object.assign(mockStoreState, overrides);
  mockGetState.mockReturnValue(mockStoreState);
}

// ─── Setup ───────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  // Reset to default unauthenticated state
  Object.assign(mockStoreState, {
    isAuthenticated: false,
    darkMode: false,
    currentSessionId: null,
    sidebarOpen: false,
    taskPanelOpen: false,
    homeResetKey: 0,
    activeTab: "chat",
    setActiveTab: vi.fn(),
    sessionCreating: false,
    sessionCreatingBackend: null,
    creationProgress: null,
    creationError: null,
    updateOverlayActive: false,
    changedFilesTick: new Map(),
    diffBase: "HEAD",
    setGitChangedFilesCount: vi.fn(),
    sessions: new Map(),
    sdkSessions: [],
    setCurrentSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setTaskPanelOpen: vi.fn(),
    clearCreation: vi.fn(),
    setUpdateInfo: vi.fn(),
    setDockerUpdateDialogOpen: vi.fn(),
  });
  mockGetState.mockReturnValue(mockStoreState);
  (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "home" });
  window.location.hash = "";
  localStorage.removeItem("companion_docker_prompt_pending");
});

// ─── Tests ───────────────────────────────────────────────────────

describe("App", () => {
  describe("auth gate", () => {
    it("renders LoginPage when not authenticated", () => {
      // When isAuthenticated is false the auth gate should show LoginPage
      // and nothing from the main layout should be visible.
      render(<App />);

      expect(screen.getByTestId("login-page")).toBeInTheDocument();
      expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("topbar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("home-page")).not.toBeInTheDocument();
    });
  });

  describe("authenticated layout", () => {
    beforeEach(() => {
      setStoreValues({ isAuthenticated: true });
    });

    it("renders Sidebar, TopBar, UpdateBanner, and HomePage when on home route with no session", () => {
      // Authenticated user on the home route (no active session) should see the
      // full chrome: sidebar, topbar, update banner, and the home page content.
      render(<App />);

      expect(screen.queryByTestId("login-page")).not.toBeInTheDocument();
      expect(screen.getByTestId("sidebar")).toBeInTheDocument();
      expect(screen.getByTestId("topbar")).toBeInTheDocument();
      expect(screen.getByTestId("update-banner")).toBeInTheDocument();
      expect(screen.getByTestId("home-page")).toBeInTheDocument();
      expect(screen.getByTestId("update-overlay")).toBeInTheDocument();
    });

    it("renders ChatView when a session is active", () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "session", sessionId: "s1" });
      setStoreValues({ currentSessionId: "s1" });
      render(<App />);

      expect(screen.getByTestId("chat-view")).toBeInTheDocument();
      expect(screen.getByText("ChatView:s1")).toBeInTheDocument();
    });

    it("renders DiffPanel when activeTab is diff", () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "session", sessionId: "s1" });
      setStoreValues({ currentSessionId: "s1", activeTab: "diff" });
      render(<App />);

      expect(screen.getByTestId("diff-panel")).toBeInTheDocument();
    });

    it("renders TaskPanel when session active and taskPanelOpen", () => {
      // When taskPanelOpen is true and we have a session, the task panel should appear.
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "session", sessionId: "s1" });
      setStoreValues({ currentSessionId: "s1", taskPanelOpen: true });
      render(<App />);

      expect(screen.getByTestId("task-panel")).toBeInTheDocument();
    });

    it("renders SessionLaunchOverlay during session creation", () => {
      // While a session is being created, the overlay should appear over the home page.
      setStoreValues({
        sessionCreating: true,
        creationProgress: [{ label: "Starting...", status: "done" }],
        creationError: null,
      });
      render(<App />);

      expect(screen.getByTestId("session-launch-overlay")).toBeInTheDocument();
    });
  });

  describe("route-level pages", () => {
    beforeEach(() => {
      setStoreValues({ isAuthenticated: true });
    });

    it("renders SettingsPage for settings route", async () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "settings" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("settings-page")).toBeInTheDocument();
      });
    });

    it("renders PromptsPage for prompts route", async () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "prompts" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("prompts-page")).toBeInTheDocument();
      });
    });

    it("renders IntegrationsPage for integrations route", async () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "integrations" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("integrations-page")).toBeInTheDocument();
      });
    });

    it("renders LinearSettingsPage for integration-linear route", async () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "integration-linear" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("linear-settings-page")).toBeInTheDocument();
      });
    });

    it("renders EnvManager for environments route", async () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "environments" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("env-manager")).toBeInTheDocument();
      });
    });

    it("renders AgentsPage for agents route", async () => {
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "agents" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("agents-page")).toBeInTheDocument();
      });
    });

    it("renders Playground for playground route", async () => {
      // The playground route skips the normal layout entirely and renders
      // just the Playground component in a Suspense boundary.
      (parseHash as ReturnType<typeof vi.fn>).mockReturnValue({ page: "playground" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("playground")).toBeInTheDocument();
      });
      // Playground route should NOT have sidebar/topbar
      expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("topbar")).not.toBeInTheDocument();
    });
  });

  describe("docker update dialog activation", () => {
    it("opens DockerUpdateDialog and clears localStorage when companion_docker_prompt_pending is set", () => {
      // After an app update, the localStorage flag triggers the Docker update dialog.
      // This useEffect reads the flag, removes it, and opens the dialog via the store.
      localStorage.setItem("companion_docker_prompt_pending", "1");
      setStoreValues({ isAuthenticated: true });
      render(<App />);

      expect(mockStoreState.setDockerUpdateDialogOpen).toHaveBeenCalledWith(true);
      expect(localStorage.getItem("companion_docker_prompt_pending")).toBeNull();
    });

    it("does not open DockerUpdateDialog on normal page load", () => {
      // Without the localStorage flag, the dialog should not be triggered.
      setStoreValues({ isAuthenticated: true });
      render(<App />);

      expect(mockStoreState.setDockerUpdateDialogOpen).not.toHaveBeenCalled();
    });
  });

  describe("dark mode", () => {
    it("toggles dark class on document element based on darkMode state", () => {
      // The App applies/removes the "dark" class on <html> via an effect.
      setStoreValues({ isAuthenticated: false, darkMode: true });
      render(<App />);
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      // Clean up for other tests
      document.documentElement.classList.remove("dark");
    });
  });

  describe("accessibility", () => {
    it("passes axe accessibility checks when unauthenticated (LoginPage)", async () => {
      // The login page rendered by the auth gate should have no a11y violations.
      const { axe } = await import("vitest-axe");
      const { container } = render(<App />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("passes axe accessibility checks when authenticated (home page)", async () => {
      // The full authenticated layout on the home route should pass axe checks.
      const { axe } = await import("vitest-axe");
      setStoreValues({ isAuthenticated: true });
      const { container } = render(<App />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});
