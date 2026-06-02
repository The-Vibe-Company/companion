import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { getTelemetryPreferenceEnabled, setTelemetryPreferenceEnabled } from "../analytics.js";
import { navigateToSession, navigateHome } from "../utils/routing.js";

interface SettingsPageProps {
  embedded?: boolean;
}

const CATEGORIES = [
  { id: "general", label: "General" },
  { id: "webhooks", label: "Webhooks" },
  { id: "authentication", label: "Authentication" },
  { id: "notifications", label: "Notifications" },
  { id: "providers", label: "Providers" },
  { id: "anthropic", label: "Anthropic" },
  { id: "ai-validation", label: "AI Validation" },
  { id: "updates", label: "Updates" },
  { id: "telemetry", label: "Telemetry" },
  { id: "environments", label: "Environments" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

export function SettingsPage({ embedded = false }: SettingsPageProps) {
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("claude-sonnet-4-6");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const diffBase = useStore((s) => s.diffBase);
  const setDiffBase = useStore((s) => s.setDiffBase);
  const notificationSound = useStore((s) => s.notificationSound);
  const toggleNotificationSound = useStore((s) => s.toggleNotificationSound);
  const notificationDesktop = useStore((s) => s.notificationDesktop);
  const setNotificationDesktop = useStore((s) => s.setNotificationDesktop);
  const updateInfo = useStore((s) => s.updateInfo);
  const setUpdateInfo = useStore((s) => s.setUpdateInfo);
  const setUpdateOverlayActive = useStore((s) => s.setUpdateOverlayActive);
  const notificationApiAvailable = typeof Notification !== "undefined";
  const [updateChannel, setUpdateChannel] = useState<"stable" | "prerelease">("stable");
  const [dockerAutoUpdate, setDockerAutoUpdate] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [telemetryEnabled, setTelemetryEnabled] = useState(getTelemetryPreferenceEnabled());
  const [aiValidationEnabled, setAiValidationEnabled] = useState(false);
  const [aiValidationAutoApprove, setAiValidationAutoApprove] = useState(true);
  const [aiValidationAutoDeny, setAiValidationAutoDeny] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [activeSection, setActiveSection] = useState<CategoryId>("general");
  const [apiKeyFocused, setApiKeyFocused] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; error?: string } | null>(null);

  // Provider tokens state
  const [claudeCodeToken, setClaudeCodeToken] = useState("");
  const [claudeCodeTokenConfigured, setClaudeCodeTokenConfigured] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiApiKeyConfigured, setOpenaiApiKeyConfigured] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [claudeTokenFocused, setClaudeTokenFocused] = useState(false);
  const [openaiKeyFocused, setOpenaiKeyFocused] = useState(false);

  // Auth section state
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [qrCodes, setQrCodes] = useState<{ label: string; url: string; qrDataUrl: string }[] | null>(null);
  const [selectedQrIndex, setSelectedQrIndex] = useState(0);
  const [qrLoading, setQrLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // IntersectionObserver to track which section is in view
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the topmost visible section
        let topEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
              topEntry = entry;
            }
          }
        }
        if (topEntry?.target?.id) {
          setActiveSection(topEntry.target.id as CategoryId);
        }
      },
      {
        root: container,
        rootMargin: "-10% 0px -70% 0px",
        threshold: 0,
      },
    );

    for (const cat of CATEGORIES) {
      const el = sectionRefs.current[cat.id];
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [loading]); // re-attach after loading completes and sections render

  const scrollToSection = useCallback((id: CategoryId) => {
    setActiveSection(id);
    const el = sectionRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setConfigured(s.anthropicApiKeyConfigured);
        setClaudeCodeTokenConfigured(s.claudeCodeOAuthTokenConfigured);
        setOpenaiApiKeyConfigured(s.openaiApiKeyConfigured);
        setAnthropicModel(s.anthropicModel || "claude-sonnet-4-6");
        if (typeof s.aiValidationEnabled === "boolean") setAiValidationEnabled(s.aiValidationEnabled);
        if (typeof s.aiValidationAutoApprove === "boolean") setAiValidationAutoApprove(s.aiValidationAutoApprove);
        if (typeof s.aiValidationAutoDeny === "boolean") setAiValidationAutoDeny(s.aiValidationAutoDeny);
        if (s.updateChannel === "stable" || s.updateChannel === "prerelease") setUpdateChannel(s.updateChannel);
        if (typeof s.dockerAutoUpdate === "boolean") setDockerAutoUpdate(s.dockerAutoUpdate);
        if (typeof s.publicUrl === "string") {
          setPublicUrl(s.publicUrl);
          useStore.getState().setPublicUrl(s.publicUrl);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));

    // Fetch auth token in parallel (non-blocking)
    api.getAuthToken().then((res) => setAuthToken(res.token)).catch(() => {});
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const nextKey = anthropicApiKey.trim();
      const payload: { anthropicApiKey?: string; anthropicModel: string } = {
        anthropicModel: anthropicModel.trim() || "claude-sonnet-4-6",
      };
      if (nextKey) {
        payload.anthropicApiKey = nextKey;
      }

      const res = await api.updateSettings(payload);
      setConfigured(res.anthropicApiKeyConfigured);
      setAnthropicApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleAiValidation(field: "aiValidationEnabled" | "aiValidationAutoApprove" | "aiValidationAutoDeny") {
    const current = field === "aiValidationEnabled" ? aiValidationEnabled
      : field === "aiValidationAutoApprove" ? aiValidationAutoApprove
      : aiValidationAutoDeny;
    const newValue = !current;
    // Optimistic UI update
    if (field === "aiValidationEnabled") setAiValidationEnabled(newValue);
    else if (field === "aiValidationAutoApprove") setAiValidationAutoApprove(newValue);
    else setAiValidationAutoDeny(newValue);

    try {
      await api.updateSettings({ [field]: newValue });
    } catch {
      // Revert on failure
      if (field === "aiValidationEnabled") setAiValidationEnabled(current);
      else if (field === "aiValidationAutoApprove") setAiValidationAutoApprove(current);
      else setAiValidationAutoDeny(current);
    }
  }

  async function onCheckUpdates() {
    setCheckingUpdates(true);
    setUpdateStatus("");
    setUpdateError("");
    try {
      const info = await api.forceCheckForUpdate();
      setUpdateInfo(info);
      if (info.updateAvailable && info.latestVersion) {
        setUpdateStatus(`Update v${info.latestVersion} is available.`);
      } else {
        setUpdateStatus("You are up to date.");
      }
    } catch (err: unknown) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function onTriggerUpdate() {
    setUpdatingApp(true);
    setUpdateStatus("");
    setUpdateError("");
    try {
      // Flag so the Docker image update dialog appears after restart
      localStorage.setItem("companion_docker_prompt_pending", "1");
      const res = await api.triggerUpdate();
      setUpdateStatus(res.message);
      setUpdateOverlayActive(true);
    } catch (err: unknown) {
      localStorage.removeItem("companion_docker_prompt_pending");
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdatingApp(false);
    }
  }

  const setSectionRef = useCallback((id: string) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  }, []);

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased flex flex-col`}>
      {/* Header */}
      <div className="shrink-0 max-w-5xl w-full mx-auto px-4 sm:px-8 pt-6 sm:pt-10">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Configure API access, notifications, appearance, and workspace defaults.
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateHome();
                }
              }}
              className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
        </div>
      </div>

      {/* Mobile horizontal nav */}
      <div className="sm:hidden shrink-0 border-b border-cc-border">
        <nav
          className="flex gap-1 px-4 py-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Settings categories"
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => scrollToSection(cat.id)}
              className={`shrink-0 px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                activeSection === cat.id
                  ? "text-cc-primary bg-cc-primary/8"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Body: desktop sidebar + content */}
      <div className="flex-1 min-h-0 flex max-w-5xl w-full mx-auto">
        {/* Desktop sidebar nav */}
        <nav
          className="hidden sm:flex flex-col gap-0.5 w-44 shrink-0 pt-2 pr-6 pl-8 sticky top-0 self-start"
          aria-label="Settings categories"
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => scrollToSection(cat.id)}
              className={`text-left px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                activeSection === cat.id
                  ? "text-cc-primary bg-cc-primary/8"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </nav>

        {/* Scrollable content */}
        <div ref={contentRef} className="flex-1 min-w-0 overflow-y-auto px-4 sm:px-8 sm:pl-0 pb-safe">
          <div className="space-y-10 py-4 sm:py-2">
            {/* General */}
            <section id="general" ref={setSectionRef("general")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">General</h2>
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={toggleDarkMode}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Theme</span>
                  <span className="text-xs text-cc-muted">{darkMode ? "Dark" : "Light"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDiffBase(diffBase === "last-commit" ? "default-branch" : "last-commit")}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Diff compare against</span>
                  <span className="text-xs text-cc-muted">
                    {diffBase === "last-commit" ? "Last commit (HEAD)" : "Default branch"}
                  </span>
                </button>
                <p className="text-xs text-cc-muted px-1">
                  Last commit shows only uncommitted changes. Default branch shows all changes since diverging from main.
                </p>
              </div>
            </section>

            {/* Webhooks */}
            <section id="webhooks" ref={setSectionRef("webhooks")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Webhooks</h2>
              <div className="space-y-4">
                <p className="text-xs text-cc-muted">
                  The public URL is used for webhook URLs that external services (Linear, GitHub) send events to.
                  Set this to the externally-reachable address of your Companion instance.
                </p>
                <p className="text-xs text-cc-muted">
                  Tip:{" "}
                  <a
                    href="#/integrations/tailscale"
                    className="text-cc-primary hover:underline"
                  >
                    Use the Tailscale integration
                  </a>{" "}
                  to get an HTTPS URL automatically.
                </p>
                <div>
                  <label className="block text-xs font-medium text-cc-fg mb-1.5" htmlFor="public-url">
                    Public URL
                  </label>
                  <input
                    id="public-url"
                    type="url"
                    aria-label="Public URL"
                    value={publicUrl}
                    onChange={(e) => setPublicUrl(e.target.value)}
                    placeholder="https://your-domain.example.com"
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary font-mono-code"
                  />
                  <p className="mt-1.5 text-[10px] text-cc-muted">
                    {publicUrl
                      ? `Using: ${publicUrl}`
                      : `Fallback: ${typeof window !== "undefined" ? window.location.origin : "http://localhost:3456"}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    setSaving(true);
                    setError("");
                    try {
                      const res = await api.updateSettings({ publicUrl: publicUrl.trim() });
                      setPublicUrl(res.publicUrl);
                      useStore.getState().setPublicUrl(res.publicUrl);
                      setSaved(true);
                      setTimeout(() => setSaved(false), 1800);
                    } catch (err: unknown) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                  className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
                >
                  {saving ? "Saving..." : saved ? "Saved!" : "Save Public URL"}
                </button>
              </div>
            </section>

            {/* Authentication */}
            <section id="authentication" ref={setSectionRef("authentication")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Authentication</h2>
              <div className="space-y-4">
                <p className="text-xs text-cc-muted">
                  Use the auth token or QR code to connect additional devices (e.g. mobile over Tailscale).
                </p>

                {/* Token display */}
                <div>
                  <label className="block text-sm font-medium mb-1.5">Auth Token</label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg font-mono-code select-all break-all flex items-center">
                      {authToken
                        ? tokenRevealed
                          ? authToken
                          : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                        : <span className="text-cc-muted">Loading...</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => setTokenRevealed((v) => !v)}
                      className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
                      title={tokenRevealed ? "Hide token" : "Show token"}
                    >
                      {tokenRevealed ? "Hide" : "Show"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (authToken) {
                          navigator.clipboard.writeText(authToken).then(() => {
                            setTokenCopied(true);
                            setTimeout(() => setTokenCopied(false), 1500);
                          });
                        }
                      }}
                      disabled={!authToken}
                      className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Copy token to clipboard"
                    >
                      {tokenCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>

                {/* QR code with address tabs */}
                <div>
                  <label className="block text-sm font-medium mb-1.5">Mobile Login QR</label>
                  {qrCodes && qrCodes.length > 0 ? (
                    <div className="space-y-3">
                      {/* Address tabs — pick which network to use */}
                      {qrCodes.length > 1 && (
                        <div className="flex gap-1">
                          {qrCodes.map((qr, i) => (
                            <button
                              key={qr.label}
                              type="button"
                              onClick={() => setSelectedQrIndex(i)}
                              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                                i === selectedQrIndex
                                  ? "bg-cc-primary text-white"
                                  : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                              }`}
                            >
                              {qr.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="inline-block rounded-lg bg-white p-2">
                        <img
                          src={qrCodes[selectedQrIndex].qrDataUrl}
                          alt={`QR code for ${qrCodes[selectedQrIndex].label} login`}
                          className="w-48 h-48"
                        />
                      </div>
                      <div className="px-3 py-2 rounded-lg bg-cc-bg text-sm font-mono-code text-cc-fg break-all select-all">
                        {qrCodes[selectedQrIndex].url}
                      </div>
                      <p className="text-xs text-cc-muted">
                        Scan with your phone&apos;s camera app — it will open the URL and auto-authenticate.
                      </p>
                    </div>
                  ) : qrCodes && qrCodes.length === 0 ? (
                    <p className="text-xs text-cc-muted">
                      No remote addresses detected (LAN or Tailscale). Connect to a network to generate a QR code.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={async () => {
                        setQrLoading(true);
                        try {
                          const data = await api.getAuthQr();
                          setQrCodes(data.qrCodes);
                        } catch {
                          // QR generation failed silently — user can retry
                        } finally {
                          setQrLoading(false);
                        }
                      }}
                      disabled={qrLoading}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                        qrLoading
                          ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                          : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                      }`}
                    >
                      {qrLoading ? "Generating..." : "Show QR Code"}
                    </button>
                  )}
                </div>

                {/* Regenerate token */}
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm("Regenerate auth token? All existing sessions on other devices will be signed out.")) return;
                      setRegenerating(true);
                      try {
                        const res = await api.regenerateAuthToken();
                        setAuthToken(res.token);
                        setTokenRevealed(true);
                        setQrCodes(null); // invalidate old QR
                      } catch {
                        // Regeneration failed
                      } finally {
                        setRegenerating(false);
                      }
                    }}
                    disabled={regenerating}
                    className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                      regenerating
                        ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                        : "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                    }`}
                  >
                    {regenerating ? "Regenerating..." : "Regenerate Token"}
                  </button>
                  <p className="mt-1.5 text-xs text-cc-muted">
                    Creates a new token. All other signed-in devices will need to re-authenticate.
                  </p>
                </div>
              </div>
            </section>

            {/* Notifications */}
            <section id="notifications" ref={setSectionRef("notifications")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Notifications</h2>
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={toggleNotificationSound}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Sound</span>
                  <span className="text-xs text-cc-muted">{notificationSound ? "On" : "Off"}</span>
                </button>
                {notificationApiAvailable && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!notificationDesktop) {
                        if (Notification.permission !== "granted") {
                          const result = await Notification.requestPermission();
                          if (result !== "granted") return;
                        }
                        setNotificationDesktop(true);
                      } else {
                        setNotificationDesktop(false);
                      }
                    }}
                    className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                  >
                    <span>Desktop Alerts</span>
                    <span className="text-xs text-cc-muted">{notificationDesktop ? "On" : "Off"}</span>
                  </button>
                )}
              </div>
            </section>

            {/* Providers */}
            <section id="providers" ref={setSectionRef("providers")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Providers</h2>
              <div className="space-y-6">
                <p className="text-xs text-cc-muted">
                  Configure authentication tokens for Claude Code and Codex. These are injected into sessions automatically.
                </p>

                {/* Claude Code OAuth Token */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium" htmlFor="claude-code-token">
                    Claude Code OAuth Token
                  </label>
                  <p className="text-xs text-cc-muted">
                    Run <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">claude setup-token</code> in your terminal, then paste the token here.
                  </p>
                  <input
                    id="claude-code-token"
                    type="password"
                    value={claudeCodeTokenConfigured && !claudeTokenFocused && !claudeCodeToken ? "••••••••••••••••" : claudeCodeToken}
                    onChange={(e) => setClaudeCodeToken(e.target.value)}
                    onFocus={() => setClaudeTokenFocused(true)}
                    onBlur={() => setClaudeTokenFocused(false)}
                    placeholder={claudeCodeTokenConfigured ? "Enter a new token to replace" : "Paste token from claude setup-token"}
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                  />
                  <p className="text-xs text-cc-muted">
                    {claudeCodeTokenConfigured ? "Claude Code token configured" : "Claude Code token not configured"}
                  </p>
                </div>

                {/* OpenAI API Key (Codex) */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium" htmlFor="openai-api-key">
                    OpenAI API Key (Codex)
                  </label>
                  <p className="text-xs text-cc-muted">
                    Used to authenticate Codex sessions. You can also use <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">codex --login</code> for device-based auth.
                  </p>
                  <input
                    id="openai-api-key"
                    type="password"
                    value={openaiApiKeyConfigured && !openaiKeyFocused && !openaiApiKey ? "••••••••••••••••" : openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                    onFocus={() => setOpenaiKeyFocused(true)}
                    onBlur={() => setOpenaiKeyFocused(false)}
                    placeholder={openaiApiKeyConfigured ? "Enter a new key to replace" : "sk-..."}
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                  />
                  <p className="text-xs text-cc-muted">
                    {openaiApiKeyConfigured ? "OpenAI key configured" : "OpenAI key not configured"}
                  </p>
                </div>

                {providerError && (
                  <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                    {providerError}
                  </div>
                )}

                {providerSaved && (
                  <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
                    Provider settings saved.
                  </div>
                )}

                <button
                  type="button"
                  disabled={providerSaving || (!claudeCodeToken.trim() && !openaiApiKey.trim())}
                  onClick={async () => {
                    setProviderSaving(true);
                    setProviderError("");
                    setProviderSaved(false);
                    try {
                      const payload: { claudeCodeOAuthToken?: string; openaiApiKey?: string } = {};
                      if (claudeCodeToken.trim()) payload.claudeCodeOAuthToken = claudeCodeToken.trim();
                      if (openaiApiKey.trim()) payload.openaiApiKey = openaiApiKey.trim();
                      const res = await api.updateSettings(payload);
                      setClaudeCodeTokenConfigured(res.claudeCodeOAuthTokenConfigured);
                      setOpenaiApiKeyConfigured(res.openaiApiKeyConfigured);
                      setClaudeCodeToken("");
                      setOpenaiApiKey("");
                      setProviderSaved(true);
                      setTimeout(() => setProviderSaved(false), 1800);
                    } catch (err: unknown) {
                      setProviderError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setProviderSaving(false);
                    }
                  }}
                  className={`px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                    providerSaving || (!claudeCodeToken.trim() && !openaiApiKey.trim())
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                  }`}
                >
                  {providerSaving ? "Saving..." : "Save Provider Settings"}
                </button>
              </div>
            </section>

            {/* Anthropic */}
            <section id="anthropic" ref={setSectionRef("anthropic")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Anthropic</h2>
              <form onSubmit={onSave} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5" htmlFor="anthropic-key">
                    Anthropic API Key
                  </label>
                  <input
                    id="anthropic-key"
                    type="password"
                    value={configured && !apiKeyFocused && !anthropicApiKey ? "••••••••••••••••" : anthropicApiKey}
                    onChange={(e) => { setAnthropicApiKey(e.target.value); setVerifyResult(null); }}
                    onFocus={() => setApiKeyFocused(true)}
                    onBlur={() => setApiKeyFocused(false)}
                    placeholder={configured ? "Enter a new key to replace" : "sk-ant-api03-..."}
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                  />
                  <p className="mt-1.5 text-xs text-cc-muted">
                    Auto-renaming is disabled until this key is configured.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5" htmlFor="anthropic-model">
                    Anthropic Model
                  </label>
                  <input
                    id="anthropic-model"
                    type="text"
                    value={anthropicModel}
                    onChange={(e) => setAnthropicModel(e.target.value)}
                    placeholder="claude-sonnet-4-6"
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                    {error}
                  </div>
                )}

                {saved && (
                  <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
                    Settings saved.
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-xs text-cc-muted">
                    {loading ? "Loading..." : configured ? "Anthropic key configured" : "Anthropic key not configured"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={verifying || !anthropicApiKey.trim()}
                      onClick={async () => {
                        setVerifying(true);
                        setVerifyResult(null);
                        try {
                          const result = await api.verifyAnthropicKey(anthropicApiKey.trim());
                          setVerifyResult(result);
                          setTimeout(() => setVerifyResult(null), 5000);
                        } catch (err: unknown) {
                          setVerifyResult({ valid: false, error: err instanceof Error ? err.message : String(err) });
                          setTimeout(() => setVerifyResult(null), 5000);
                        } finally {
                          setVerifying(false);
                        }
                      }}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                        verifying || !anthropicApiKey.trim()
                          ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                          : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                      }`}
                    >
                      {verifying ? "Verifying..." : "Verify"}
                    </button>
                    <button
                      type="submit"
                      disabled={saving || loading}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                        saving || loading
                          ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                          : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                      }`}
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>

                {verifyResult && (
                  <div className={`px-3 py-2 rounded-lg text-xs ${
                    verifyResult.valid
                      ? "bg-cc-success/10 border border-cc-success/20 text-cc-success"
                      : "bg-cc-error/10 border border-cc-error/20 text-cc-error"
                  }`}>
                    {verifyResult.valid ? "API key is valid." : `Invalid API key${verifyResult.error ? `: ${verifyResult.error}` : "."}`}
                  </div>
                )}
              </form>
            </section>

            {/* AI Validation */}
            <section id="ai-validation" ref={setSectionRef("ai-validation")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">AI Validation</h2>
              <div className="space-y-3">
                <p className="text-xs text-cc-muted leading-relaxed">
                  When enabled, an AI model evaluates tool calls before they execute.
                  Safe operations are auto-approved, dangerous ones are blocked,
                  and uncertain cases are shown to you with a recommendation.
                  Requires an Anthropic API key. These settings serve as defaults
                  for new sessions. Each session can override AI validation
                  independently via the shield icon in the session header.
                </p>

                <button
                  type="button"
                  onClick={() => toggleAiValidation("aiValidationEnabled")}
                  disabled={!configured}
                  className={`w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg transition-colors ${
                    !configured
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed opacity-60"
                      : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                  }`}
                >
                  <span className="text-sm">AI Validation Mode</span>
                  <span className={`text-xs font-medium ${aiValidationEnabled && configured ? "text-cc-success" : "text-cc-muted"}`}>
                    {aiValidationEnabled && configured ? "On" : "Off"}
                  </span>
                </button>
                {!configured && (
                  <p className="text-[11px] text-cc-warning">Configure an Anthropic API key above to enable AI validation.</p>
                )}

                {aiValidationEnabled && configured && (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleAiValidation("aiValidationAutoApprove")}
                      className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
                    >
                      <div>
                        <span className="text-sm">Auto-approve safe tools</span>
                        <p className="text-[11px] text-cc-muted mt-0.5">Automatically allow read-only tools and benign commands</p>
                      </div>
                      <span className={`text-xs font-medium ${aiValidationAutoApprove ? "text-cc-success" : "text-cc-muted"}`}>
                        {aiValidationAutoApprove ? "On" : "Off"}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleAiValidation("aiValidationAutoDeny")}
                      className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
                    >
                      <div>
                        <span className="text-sm">Auto-deny dangerous tools</span>
                        <p className="text-[11px] text-cc-muted mt-0.5">Automatically block destructive commands like rm -rf</p>
                      </div>
                      <span className={`text-xs font-medium ${aiValidationAutoDeny ? "text-cc-success" : "text-cc-muted"}`}>
                        {aiValidationAutoDeny ? "On" : "Off"}
                      </span>
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* Updates */}
            <section id="updates" ref={setSectionRef("updates")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Updates</h2>
              <div className="space-y-3">
                {updateInfo ? (
                  <p className="text-xs text-cc-muted">
                    Current version: v{updateInfo.currentVersion}
                    {updateInfo.latestVersion ? ` • Latest: v${updateInfo.latestVersion}` : ""}
                    {updateInfo.channel === "prerelease" ? " (prerelease)" : ""}
                  </p>
                ) : (
                  <p className="text-xs text-cc-muted">Version information not loaded yet.</p>
                )}

                <div>
                  <span id="update-channel-label" className="block text-sm font-medium mb-1.5">
                    Update Channel
                  </span>
                  <div className="flex gap-1" role="radiogroup" aria-labelledby="update-channel-label">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={updateChannel === "stable"}
                      onClick={async () => {
                        if (updateChannel === "stable") return;
                        setUpdateChannel("stable");
                        try {
                          await api.updateSettings({ updateChannel: "stable" });
                        } catch {
                          setUpdateChannel("prerelease");
                          return;
                        }
                        try {
                          const info = await api.forceCheckForUpdate();
                          setUpdateInfo(info);
                        } catch { /* settings saved; swallow check error */ }
                      }}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                        updateChannel === "stable"
                          ? "bg-cc-primary text-white"
                          : "bg-cc-hover text-cc-muted hover:text-cc-fg hover:bg-cc-active"
                      }`}
                    >
                      Stable
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={updateChannel === "prerelease"}
                      onClick={async () => {
                        if (updateChannel === "prerelease") return;
                        setUpdateChannel("prerelease");
                        try {
                          await api.updateSettings({ updateChannel: "prerelease" });
                        } catch {
                          setUpdateChannel("stable");
                          return;
                        }
                        try {
                          const info = await api.forceCheckForUpdate();
                          setUpdateInfo(info);
                        } catch { /* settings saved; swallow check error */ }
                      }}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                        updateChannel === "prerelease"
                          ? "bg-cc-primary text-white"
                          : "bg-cc-hover text-cc-muted hover:text-cc-fg hover:bg-cc-active"
                      }`}
                    >
                      Prerelease
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-cc-muted">
                    {updateChannel === "prerelease"
                      ? "Tracking prerelease channel. You will receive preview builds from the latest main branch."
                      : "Tracking stable channel. You will only receive versioned releases."}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <span className="block text-sm font-medium">Auto-update Docker image</span>
                    <p className="mt-0.5 text-xs text-cc-muted">
                      Automatically re-pull the sandbox Docker image when updating The Companion
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={dockerAutoUpdate}
                    onClick={async () => {
                      const next = !dockerAutoUpdate;
                      setDockerAutoUpdate(next);
                      try {
                        await api.updateSettings({ dockerAutoUpdate: next });
                      } catch {
                        setDockerAutoUpdate(!next);
                      }
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      dockerAutoUpdate ? "bg-cc-primary" : "bg-cc-hover"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
                        dockerAutoUpdate ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>

                {updateError && (
                  <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                    {updateError}
                  </div>
                )}

                {updateStatus && (
                  <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
                    {updateStatus}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onCheckUpdates}
                    disabled={checkingUpdates}
                    className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                      checkingUpdates
                        ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                        : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                    }`}
                  >
                    {checkingUpdates ? "Checking..." : "Check for updates"}
                  </button>

                  {updateInfo?.isServiceMode ? (
                    <button
                      type="button"
                      onClick={onTriggerUpdate}
                      disabled={updatingApp || updateInfo.updateInProgress || !updateInfo.updateAvailable}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                        updatingApp || updateInfo.updateInProgress || !updateInfo.updateAvailable
                          ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                          : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                      }`}
                    >
                      {updatingApp || updateInfo.updateInProgress ? "Updating..." : "Update & Restart"}
                    </button>
                  ) : (
                    <p className="text-xs text-cc-muted self-center">
                      Install service mode with <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">the-companion install</code> to enable one-click updates.
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* Telemetry */}
            <section id="telemetry" ref={setSectionRef("telemetry")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Telemetry</h2>
              <div className="space-y-3">
                <p className="text-xs text-cc-muted">
                  Anonymous product analytics and crash reports via PostHog to improve reliability.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const next = !telemetryEnabled;
                    setTelemetryPreferenceEnabled(next);
                    setTelemetryEnabled(next);
                  }}
                  className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                >
                  <span>Usage analytics and errors</span>
                  <span className="text-xs text-cc-muted">{telemetryEnabled ? "On" : "Off"}</span>
                </button>
                <p className="text-xs text-cc-muted">
                  Browser Do Not Track is respected automatically.
                </p>
              </div>
            </section>

            {/* Environments */}
            <section id="environments" ref={setSectionRef("environments")}>
              <h2 className="text-sm font-semibold text-cc-fg mb-4">Environments</h2>
              <div className="space-y-3">
                <p className="text-xs text-cc-muted">
                  Manage reusable environment profiles used when creating sessions.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    window.location.hash = "#/environments";
                  }}
                  className="px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
                >
                  Open Environments Page
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
