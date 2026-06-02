import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "./store.js";
import { connectSession } from "./ws.js";
import { api } from "./api.js";
import { capturePageView } from "./analytics.js";
import { parseHash, navigateToSession } from "./utils/routing.js";
import { LoginPage } from "./components/LoginPage.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { TopBar } from "./components/TopBar.js";
import { HomePage } from "./components/HomePage.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { DiffPanel } from "./components/DiffPanel.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { SessionLaunchOverlay } from "./components/SessionLaunchOverlay.js";
import { UpdateOverlay } from "./components/UpdateOverlay.js";
import { DockerUpdateDialog } from "./components/DockerUpdateDialog.js";
import { OnboardingModal } from "./components/OnboardingModal.js";

// Lazy-loaded route-level pages (not needed for initial render)
const Playground = lazy(() => import("./components/Playground.js").then((m) => ({ default: m.Playground })));
const SettingsPage = lazy(() => import("./components/SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const IntegrationsPage = lazy(() => import("./components/IntegrationsPage.js").then((m) => ({ default: m.IntegrationsPage })));
const LinearSettingsPage = lazy(() => import("./components/LinearSettingsPage.js").then((m) => ({ default: m.LinearSettingsPage })));
const LinearOAuthSettingsPage = lazy(() => import("./components/LinearOAuthSettingsPage.js").then((m) => ({ default: m.LinearOAuthSettingsPage })));
const TailscalePage = lazy(() => import("./components/TailscalePage.js").then((m) => ({ default: m.TailscalePage })));
const PromptsPage = lazy(() => import("./components/PromptsPage.js").then((m) => ({ default: m.PromptsPage })));
const EnvManager = lazy(() => import("./components/EnvManager.js").then((m) => ({ default: m.EnvManager })));
const SandboxManager = lazy(() => import("./components/SandboxManager.js").then((m) => ({ default: m.SandboxManager })));
const CronManager = lazy(() => import("./components/CronManager.js").then((m) => ({ default: m.CronManager })));
const AgentsPage = lazy(() => import("./components/AgentsPage.js").then((m) => ({ default: m.AgentsPage })));
const RunsPage = lazy(() => import("./components/RunsPage.js").then((m) => ({ default: m.RunsPage })));


function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-sm text-cc-muted">Loading...</div>
    </div>
  );
}

function useHash() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); },
    () => window.location.hash,
  );
}

export default function App() {
  const isAuthenticated = useStore((s) => s.isAuthenticated);
  const darkMode = useStore((s) => s.darkMode);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const homeResetKey = useStore((s) => s.homeResetKey);
  const activeTab = useStore((s) => s.activeTab);
  const sessionCreating = useStore((s) => s.sessionCreating);
  const sessionCreatingBackend = useStore((s) => s.sessionCreatingBackend);
  const creationProgress = useStore((s) => s.creationProgress);
  const creationError = useStore((s) => s.creationError);
  const updateOverlayActive = useStore((s) => s.updateOverlayActive);
  const hash = useHash();
  const route = useMemo(() => parseHash(hash), [hash]);
  const isSettingsPage = route.page === "settings";
  const isPromptsPage = route.page === "prompts";
  const isIntegrationsPage = route.page === "integrations";
  const isLinearIntegrationPage = route.page === "integration-linear";
  const isLinearOAuthIntegrationPage = route.page === "integration-linear-oauth";
  const isTailscaleIntegrationPage = route.page === "integration-tailscale";
  const isEnvironmentsPage = route.page === "environments";
  const isSandboxesPage = route.page === "sandboxes";
  const isScheduledPage = route.page === "scheduled";
  const isAgentsPage = route.page === "agents" || route.page === "agent-detail";
  const isRunsPage = route.page === "runs";
  const isSessionView = route.page === "session" || route.page === "home";

  useEffect(() => {
    capturePageView(hash || "#/");
  }, [hash]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  // Capture the localStorage-restored session ID during render (before any effects run)
  // so the mount logic can use it even if the hash-sync branch would clear it.
  const restoredIdRef = useRef(useStore.getState().currentSessionId);

  // Sync hash → store. On mount, restore a localStorage session into the URL first.
  useEffect(() => {
    // On first mount with no session hash, restore from localStorage
    if (restoredIdRef.current !== null && route.page === "home") {
      navigateToSession(restoredIdRef.current, true);
      restoredIdRef.current = null;
      return; // navigateToSession triggers hashchange → this effect re-runs with the session route
    }
    restoredIdRef.current = null;

    if (route.page === "session") {
      const store = useStore.getState();
      if (store.currentSessionId !== route.sessionId) {
        store.setCurrentSession(route.sessionId);
      }
      connectSession(route.sessionId);
    } else if (route.page === "home") {
      const store = useStore.getState();
      if (store.currentSessionId !== null) {
        store.setCurrentSession(null);
      }
    }
    // For other pages (settings, etc.), preserve currentSessionId
  }, [route]);

  // Keep git changed-files count in sync for the badge regardless of which tab is active.
  // DiffPanel does the same when mounted; this covers the case where the diff tab is closed.
  const changedFilesTick = useStore((s) => currentSessionId ? s.changedFilesTick.get(currentSessionId) ?? 0 : 0);
  const diffBase = useStore((s) => s.diffBase);
  const setGitChangedFilesCount = useStore((s) => s.setGitChangedFilesCount);
  const sessionCwd = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sessions.get(currentSessionId)?.cwd
      || s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd
      || null;
  });
  useEffect(() => {
    if (!currentSessionId || !sessionCwd) return;
    let cancelled = false;
    api.getChangedFiles(sessionCwd, diffBase).then(({ files }) => {
      if (cancelled) return;
      const prefix = `${sessionCwd}/`;
      const count = files.filter((f) => f.path === sessionCwd || f.path.startsWith(prefix)).length;
      setGitChangedFilesCount(currentSessionId, count);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentSessionId, sessionCwd, diffBase, changedFilesTick, setGitChangedFilesCount]);

  // Poll for updates
  useEffect(() => {
    const check = () => {
      api.checkForUpdate().then((info) => {
        useStore.getState().setUpdateInfo(info);
      }).catch(() => {});
    };
    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Load publicUrl from settings + check onboarding status.
  // Re-runs when isAuthenticated flips to true (e.g. after login) so that
  // users who authenticate first still see the onboarding wizard.
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (!isAuthenticated) return;
    api.getSettings().then((s) => {
      if (s.publicUrl) useStore.getState().setPublicUrl(s.publicUrl);
      if (!s.onboardingCompleted) {
        setShowOnboarding(true);
      }
    }).catch(() => {});
  }, [isAuthenticated]);

  // Show Docker image update dialog if an app update just completed
  useEffect(() => {
    if (localStorage.getItem("companion_docker_prompt_pending") === "1") {
      localStorage.removeItem("companion_docker_prompt_pending");
      useStore.getState().setDockerUpdateDialogOpen(true);
    }
  }, []);

  // Auth gate: show login page when not authenticated
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  if (route.page === "playground") {
    return <Suspense fallback={<LazyFallback />}><Playground /></Suspense>;
  }

  return (
    <div className="fixed inset-0 flex font-sans-ui bg-cc-bg text-cc-fg antialiased pt-safe overflow-hidden overscroll-none">
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30 md:hidden"
          onClick={() => useStore.getState().setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — overlay on mobile, inline on desktop */}
      <div
        className={`
          fixed inset-y-0 left-0 md:relative md:inset-auto z-40 md:z-auto
          h-full shrink-0 transition-all duration-200 pt-safe md:pt-0
          ${sidebarOpen ? "w-full md:w-[260px] translate-x-0" : "w-0 -translate-x-full md:w-0 md:-translate-x-full"}
          overflow-hidden
        `}
      >
        <Sidebar />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <UpdateBanner />
        <div className="flex-1 overflow-hidden relative">
          {isSettingsPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><SettingsPage embedded /></Suspense>
            </div>
          )}

          {isPromptsPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><PromptsPage embedded /></Suspense>
            </div>
          )}

          {isIntegrationsPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><IntegrationsPage embedded /></Suspense>
            </div>
          )}

          {isLinearIntegrationPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><LinearSettingsPage embedded /></Suspense>
            </div>
          )}

          {isLinearOAuthIntegrationPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><LinearOAuthSettingsPage embedded /></Suspense>
            </div>
          )}

          {isTailscaleIntegrationPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><TailscalePage embedded /></Suspense>
            </div>
          )}

          {isEnvironmentsPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><EnvManager embedded /></Suspense>
            </div>
          )}


          {isSandboxesPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><SandboxManager embedded /></Suspense>
            </div>
          )}

          {isScheduledPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><CronManager embedded /></Suspense>
            </div>
          )}

          {isAgentsPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><AgentsPage route={route} /></Suspense>
            </div>
          )}

          {isRunsPage && (
            <div className="absolute inset-0">
              <Suspense fallback={<LazyFallback />}><RunsPage /></Suspense>
            </div>
          )}

          {isSessionView && (
            <>
              <div className="absolute inset-0">
                {currentSessionId ? (
                  activeTab === "diff"
                    ? <DiffPanel sessionId={currentSessionId} />
                    : <ChatView sessionId={currentSessionId} />
                ) : (
                  <HomePage key={homeResetKey} />
                )}
              </div>

              {/* Session launch overlay — shown during creation */}
              {sessionCreating && creationProgress && creationProgress.length > 0 && (
                <SessionLaunchOverlay
                  steps={creationProgress}
                  error={creationError}
                  backend={sessionCreatingBackend ?? undefined}
                  onCancel={() => useStore.getState().clearCreation()}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Task panel — overlay on mobile, inline on desktop */}
      {currentSessionId && isSessionView && (
        <>
          {!taskPanelOpen && (
            <button
              type="button"
              onClick={() => useStore.getState().setTaskPanelOpen(true)}
              className="hidden lg:flex fixed right-0 top-1/2 -translate-y-1/2 z-30 items-center gap-1 rounded-l-lg border border-r-0 border-cc-border bg-cc-card/95 backdrop-blur px-2 py-2 text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              title="Open context panel"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path d="M3 2.5A1.5 1.5 0 014.5 1h7A1.5 1.5 0 0113 2.5v11a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 13.5v-11zm2 .5v10h6V3H5z" />
              </svg>
              <span className="[writing-mode:vertical-rl] rotate-180 tracking-wide">Context</span>
            </button>
          )}

          {/* Mobile overlay backdrop */}
          {taskPanelOpen && (
            <div
              className="fixed inset-0 bg-black/30 z-30 lg:hidden"
              onClick={() => useStore.getState().setTaskPanelOpen(false)}
            />
          )}

          <div
            className={`
              fixed inset-y-0 right-0 lg:relative lg:inset-auto z-40 lg:z-auto
              h-full shrink-0 transition-all duration-200 pt-safe lg:pt-0
              ${taskPanelOpen ? "w-full lg:w-[320px] translate-x-0" : "w-0 translate-x-full lg:w-0 lg:translate-x-full"}
              overflow-hidden
            `}
          >
            <TaskPanel sessionId={currentSessionId} />
          </div>
        </>
      )}
      <UpdateOverlay active={updateOverlayActive} />
      <DockerUpdateDialog />
      {showOnboarding && <OnboardingModal onComplete={() => setShowOnboarding(false)} />}
    </div>
  );
}
