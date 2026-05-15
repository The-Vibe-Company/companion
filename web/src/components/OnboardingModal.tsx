import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";

type Step = "welcome" | "claude" | "codex" | "done";
type ClaudeAuthMethod = "local" | "oauth" | "apiKey";
type CodexAuthMethod = "local" | "apiKey";
type VerifiedAuth = {
  authMethod: ClaudeAuthMethod | CodexAuthMethod;
  token: string;
  baseUrl: string;
};

const STEPS: Step[] = ["welcome", "claude", "codex", "done"];

/** Shared selector for focusable, non-disabled elements (M1 fix) */
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface OnboardingModalProps {
  onComplete: () => void;
}

/** Check if the user prefers reduced motion */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [claudeAuthMethod, setClaudeAuthMethod] = useState<ClaudeAuthMethod>("local");
  const [codexAuthMethod, setCodexAuthMethod] = useState<CodexAuthMethod>("local");
  const [claudeToken, setClaudeToken] = useState("");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [claudeBaseUrl, setClaudeBaseUrl] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState<"claude" | "codex" | null>(null);
  const [error, setError] = useState("");
  const [claudeDetectedAuth, setClaudeDetectedAuth] = useState(false);
  const [claudeConfigured, setClaudeConfigured] = useState(false);
  const [codexConfigured, setCodexConfigured] = useState(false);
  const [verifiedClaudeAuth, setVerifiedClaudeAuth] = useState<VerifiedAuth | null>(null);
  const [verifiedCodexAuth, setVerifiedCodexAuth] = useState<VerifiedAuth | null>(null);
  const [entered, setEntered] = useState(prefersReducedMotion);
  const dialogRef = useRef<HTMLDivElement>(null);
  const authSelectionTouchedRef = useRef(false);

  useEffect(() => {
    if (!entered) {
      requestAnimationFrame(() => setEntered(true));
    }
  }, [entered]);

  // Focus trap: keep Tab cycling within the dialog
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = dialog!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    // Focus the first focusable element on mount
    const firstFocusable = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [step]);

  useEffect(() => {
    api.getSettings()
      .then((settings) => {
        setClaudeDetectedAuth(
          settings.claudeCodeOAuthTokenConfigured || !!settings.claudeApiKeyConfigured || settings.claudeDeviceAuthConfigured,
        );
        if (!authSelectionTouchedRef.current) {
          setClaudeAuthMethod(
            settings.claudeAuthMethod
              ?? (settings.claudeCodeOAuthTokenConfigured ? "oauth" : settings.claudeApiKeyConfigured ? "apiKey" : "local"),
          );
          setCodexAuthMethod(settings.codexAuthMethod ?? (settings.openaiApiKeyConfigured ? "apiKey" : "local"));
          setClaudeBaseUrl(settings.claudeBaseUrl || "");
          setOpenaiBaseUrl(settings.openaiBaseUrl || "");
        }
      })
      .catch(() => {});
  }, []);

  const finishOnboarding = useCallback(async () => {
    try {
      await api.updateSettings({ onboardingCompleted: true });
    } catch {
      // non-fatal
    }
    setStep("done");
  }, []);

  const currentClaudeAuth = useCallback((): VerifiedAuth => ({
    authMethod: claudeAuthMethod,
    token: claudeAuthMethod === "oauth"
      ? claudeToken.trim()
      : claudeAuthMethod === "apiKey"
        ? claudeApiKey.trim()
        : "",
    baseUrl: claudeAuthMethod === "apiKey" ? claudeBaseUrl.trim() : "",
  }), [claudeApiKey, claudeAuthMethod, claudeBaseUrl, claudeToken]);

  const currentCodexAuth = useCallback((): VerifiedAuth => ({
    authMethod: codexAuthMethod,
    token: codexAuthMethod === "apiKey" ? openaiKey.trim() : "",
    baseUrl: codexAuthMethod === "apiKey" ? openaiBaseUrl.trim() : "",
  }), [codexAuthMethod, openaiBaseUrl, openaiKey]);

  const claudeVerified = (() => {
    const current = currentClaudeAuth();
    return verifiedClaudeAuth?.authMethod === current.authMethod
      && verifiedClaudeAuth.token === current.token
      && verifiedClaudeAuth.baseUrl === current.baseUrl;
  })();

  const codexVerified = (() => {
    const current = currentCodexAuth();
    return verifiedCodexAuth?.authMethod === current.authMethod
      && verifiedCodexAuth.token === current.token
      && verifiedCodexAuth.baseUrl === current.baseUrl;
  })();

  const handleVerifyClaude = useCallback(async () => {
    setVerifying("claude");
    setError("");
    try {
      const current = currentClaudeAuth();
      const result = await api.verifyProvider({
        provider: "claude",
        authMethod: current.authMethod,
        token: current.token,
        baseUrl: current.baseUrl,
      });
      if (!result.valid) {
        setVerifiedClaudeAuth(null);
        setError(result.error || "Claude auth verification failed");
        return;
      }
      setVerifiedClaudeAuth(current);
    } catch (e) {
      setVerifiedClaudeAuth(null);
      setError(e instanceof Error ? e.message : "Failed to verify Claude auth");
    } finally {
      setVerifying(null);
    }
  }, [currentClaudeAuth]);

  const handleSaveClaude = useCallback(async () => {
    if (!claudeVerified) return;
    setSaving(true);
    setError("");
    try {
      const current = currentClaudeAuth();
      await api.updateSettings({
        claudeAuthMethod: current.authMethod as ClaudeAuthMethod,
        ...(current.authMethod === "oauth" && current.token ? { claudeCodeOAuthToken: current.token } : {}),
        ...(current.authMethod === "apiKey" && current.token ? { claudeApiKey: current.token } : {}),
        ...(current.authMethod === "apiKey" ? { claudeBaseUrl: current.baseUrl } : {}),
      });
      setClaudeConfigured(true);
      setStep("codex");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Claude auth");
    } finally {
      setSaving(false);
    }
  }, [claudeVerified, currentClaudeAuth]);

  const handleVerifyCodex = useCallback(async () => {
    setVerifying("codex");
    setError("");
    try {
      const current = currentCodexAuth();
      const result = await api.verifyProvider({
        provider: "codex",
        authMethod: current.authMethod,
        token: current.token,
        baseUrl: current.baseUrl,
      });
      if (!result.valid) {
        setVerifiedCodexAuth(null);
        setError(result.error || "Codex auth verification failed");
        return;
      }
      setVerifiedCodexAuth(current);
    } catch (e) {
      setVerifiedCodexAuth(null);
      setError(e instanceof Error ? e.message : "Failed to verify Codex auth");
    } finally {
      setVerifying(null);
    }
  }, [currentCodexAuth]);

  const handleSaveCodex = useCallback(async () => {
    if (!codexVerified) return;
    setSaving(true);
    setError("");
    try {
      const current = currentCodexAuth();
      await api.updateSettings({
        codexAuthMethod: current.authMethod as CodexAuthMethod,
        ...(current.authMethod === "apiKey" && current.token ? { openaiApiKey: current.token } : {}),
        ...(current.authMethod === "apiKey" ? { openaiBaseUrl: current.baseUrl } : {}),
      });
      setCodexConfigured(true);
      await finishOnboarding();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Codex auth");
    } finally {
      setSaving(false);
    }
  }, [codexVerified, currentCodexAuth, finishOnboarding]);

  const changeClaudeAuthMethod = useCallback((value: ClaudeAuthMethod) => {
    authSelectionTouchedRef.current = true;
    setClaudeAuthMethod(value);
    setVerifiedClaudeAuth(null);
  }, []);

  const changeCodexAuthMethod = useCallback((value: CodexAuthMethod) => {
    authSelectionTouchedRef.current = true;
    setCodexAuthMethod(value);
    setVerifiedCodexAuth(null);
  }, []);

  const handleDone = useCallback(() => {
    onComplete();
  }, [onComplete]);

  const handleSkipAll = useCallback(async () => {
    await finishOnboarding();
    onComplete();
  }, [finishOnboarding, onComplete]);

  // Clear shared error state when navigating between steps
  const goToStep = useCallback((s: Step) => {
    setError("");
    setStep(s);
  }, []);

  const stepIndex = STEPS.indexOf(step);
  const skipMotion = prefersReducedMotion();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "linear-gradient(145deg, var(--color-cc-bg) 0%, color-mix(in srgb, var(--color-cc-bg) 94%, var(--color-cc-primary) 6%) 100%)",
        opacity: entered ? 1 : 0,
        transition: skipMotion ? "none" : "opacity 400ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {/* Decorative accent line */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{
          background: "linear-gradient(90deg, transparent 0%, var(--color-cc-primary) 30%, var(--color-cc-primary) 70%, transparent 100%)",
          opacity: 0.6,
        }}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Provider setup"
        className="w-full max-w-[520px] mx-6"
        style={{
          transform: entered ? "translateY(0)" : "translateY(12px)",
          opacity: entered ? 1 : 0,
          transition: skipMotion
            ? "none"
            : "transform 500ms cubic-bezier(0.16, 1, 0.3, 1) 100ms, opacity 400ms cubic-bezier(0.16, 1, 0.3, 1) 100ms",
        }}
      >
        {/* Step indicator */}
        {step !== "done" && (
          <div
            className="flex items-center gap-1.5 mb-6 justify-center"
            role="status"
            aria-label={`Step ${stepIndex + 1} of ${STEPS.length - 1}`}
          >
            {STEPS.slice(0, 3).map((s, i) => (
              <div
                key={s}
                className="h-[3px] rounded-full transition-[transform,background,opacity] duration-300"
                style={{
                  width: 32,
                  transform: i === stepIndex ? "scaleX(1)" : "scaleX(0.375)",
                  transformOrigin: "center",
                  background: i <= stepIndex
                    ? "var(--color-cc-primary)"
                    : "var(--color-cc-border)",
                  opacity: i <= stepIndex ? 1 : 0.5,
                }}
              />
            ))}
          </div>
        )}

        {/* Content card */}
        <div
          className="bg-cc-card border border-cc-border overflow-hidden"
          style={{
            borderRadius: 16,
            boxShadow: "0 1px 3px var(--color-cc-border), 0 8px 32px var(--color-cc-border)",
          }}
        >
          {step === "welcome" && (
            <WelcomeStep
              onSetupClaude={() => goToStep("claude")}
              onSetupCodex={() => goToStep("codex")}
            />
          )}
          {step === "claude" && (
            <ClaudeSetupStep
              token={claudeToken}
              apiKey={claudeApiKey}
              baseUrl={claudeBaseUrl}
              authMethod={claudeAuthMethod}
              detectedAuth={claudeDetectedAuth}
              verified={claudeVerified}
              verifying={verifying === "claude"}
              onAuthMethodChange={changeClaudeAuthMethod}
              onTokenChange={(value) => { setClaudeToken(value); setVerifiedClaudeAuth(null); }}
              onApiKeyChange={(value) => { setClaudeApiKey(value); setVerifiedClaudeAuth(null); }}
              onBaseUrlChange={(value) => { authSelectionTouchedRef.current = true; setClaudeBaseUrl(value); setVerifiedClaudeAuth(null); }}
              onVerify={handleVerifyClaude}
              onSave={handleSaveClaude}
              onSkip={() => goToStep("codex")}
              saving={saving}
              error={error}
            />
          )}
          {step === "codex" && (
            <CodexSetupStep
              apiKey={openaiKey}
              baseUrl={openaiBaseUrl}
              authMethod={codexAuthMethod}
              verified={codexVerified}
              verifying={verifying === "codex"}
              onAuthMethodChange={changeCodexAuthMethod}
              onApiKeyChange={(value) => { setOpenaiKey(value); setVerifiedCodexAuth(null); }}
              onBaseUrlChange={(value) => { authSelectionTouchedRef.current = true; setOpenaiBaseUrl(value); setVerifiedCodexAuth(null); }}
              onVerify={handleVerifyCodex}
              onSave={handleSaveCodex}
              onSkip={() => finishOnboarding()}
              onBack={() => goToStep("claude")}
              saving={saving}
              error={error}
            />
          )}
          {step === "done" && (
            <DoneStep
              claudeConfigured={claudeConfigured}
              codexConfigured={codexConfigured}
              onDone={handleDone}
            />
          )}
        </div>

        {/* Skip link — outside card, feels less important */}
        {step === "welcome" && (
          <button
            onClick={handleSkipAll}
            className="w-full text-center text-xs text-cc-muted hover:text-cc-fg transition-colors mt-4 min-h-[44px] flex items-center justify-center"
          >
            Skip setup — I'll configure this later in Settings
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ── Welcome ──────────────────────────────────────────────────────────────── */

function WelcomeStep({
  onSetupClaude,
  onSetupCodex,
}: {
  onSetupClaude: () => void;
  onSetupCodex: () => void;
}) {
  return (
    <div className="p-7 pb-6">
      {/* Header */}
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.12em] text-cc-muted font-medium mb-2">
          First time setup
        </div>
        <h2 className="text-xl font-semibold text-cc-fg leading-tight">
          Welcome to AgentHangar
        </h2>
        <p className="text-sm text-cc-muted mt-1.5 leading-relaxed">
          Connect your AI providers to start coding. Configure one or both.
        </p>
      </div>

      {/* Provider cards */}
      <div className="space-y-2.5">
        <button
          onClick={onSetupClaude}
          className="provider-card--claude group w-full flex items-center gap-3.5 p-3.5 min-h-[52px] rounded-xl border border-cc-border bg-cc-bg text-left transition-[transform,border-color,box-shadow] duration-150"
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 font-semibold text-sm bg-cc-primary/10 text-cc-primary"
          >
            C
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-cc-fg">Claude Code</div>
            <div className="text-[11px] text-cc-muted leading-snug mt-0.5">Anthropic's coding agent — local CLI, OAuth, or API key</div>
          </div>
          <svg
            className="w-4 h-4 text-cc-muted flex-shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <button
          onClick={onSetupCodex}
          className="provider-card--codex group w-full flex items-center gap-3.5 p-3.5 min-h-[52px] rounded-xl border border-cc-border bg-cc-bg text-left transition-[transform,border-color,box-shadow] duration-150"
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 font-semibold text-sm bg-cc-codex/10 text-cc-codex"
          >
            X
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-cc-fg">Codex</div>
            <div className="text-[11px] text-cc-muted leading-snug mt-0.5">OpenAI's coding agent — local CLI or API key</div>
          </div>
          <svg
            className="w-4 h-4 text-cc-muted flex-shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ── Claude Setup ─────────────────────────────────────────────────────────── */

function ClaudeSetupStep({
  token,
  apiKey,
  baseUrl,
  authMethod,
  detectedAuth,
  verified,
  verifying,
  onAuthMethodChange,
  onTokenChange,
  onApiKeyChange,
  onBaseUrlChange,
  onVerify,
  onSave,
  onSkip,
  saving,
  error,
}: {
  token: string;
  apiKey: string;
  baseUrl: string;
  authMethod: ClaudeAuthMethod;
  detectedAuth: boolean;
  verified: boolean;
  verifying: boolean;
  onAuthMethodChange: (v: ClaudeAuthMethod) => void;
  onTokenChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onVerify: () => void;
  onSave: () => void;
  onSkip: () => void;
  saving: boolean;
  error: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const errorId = "claude-token-error";

  return (
    <div className="p-7 pb-6">
      <div className="mb-5">
        <div className="text-[10px] uppercase tracking-[0.12em] text-cc-muted font-medium mb-2">
          Step 1 of 2
        </div>
        <h2 className="text-xl font-semibold text-cc-fg leading-tight">
          Set up Claude Code
        </h2>
        <p className="text-sm text-cc-muted mt-1.5 leading-relaxed">
          Choose how new Claude Code sessions should authenticate. Verification must pass before this becomes the saved method.
        </p>
      </div>

      <div className="mb-4 grid gap-2">
        <label htmlFor="onboarding-claude-auth-method" className="text-xs text-cc-muted block">
          Claude auth method
        </label>
        <select
          id="onboarding-claude-auth-method"
          value={authMethod}
          onChange={(e) => onAuthMethodChange(e.target.value as ClaudeAuthMethod)}
          className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary focus:border-cc-primary transition-shadow duration-150"
        >
          <option value="local">Local CLI login</option>
          <option value="oauth">OAuth token</option>
          <option value="apiKey">API key</option>
        </select>
        <p className="text-xs text-cc-muted leading-relaxed">
          Local CLI login runs a real <code className="font-mono-code">claude -p hello</code> verification and does not inject credentials. OAuth and API key modes save credentials into AgentHangar for new sessions.
        </p>
      </div>

      {authMethod === "local" && detectedAuth && (
        <div className="mb-4 rounded-lg border border-cc-success/30 bg-cc-success/10 px-3 py-2 text-xs text-cc-success">
          A local Claude Code auth source was detected. Verify will still run the CLI before continuing.
        </div>
      )}

      {authMethod === "oauth" && (
        <div
          className="rounded-lg overflow-hidden mb-4 border border-cc-border"
          style={{ background: "var(--color-cc-code-bg)" }}
        >
          <div
            className="flex items-center justify-between px-3 py-1.5 border-b border-cc-border"
          >
            <div className="flex items-center gap-1.5" aria-hidden="true">
              <div className="w-[7px] h-[7px] rounded-full bg-cc-error opacity-60" />
              <div className="w-[7px] h-[7px] rounded-full bg-cc-warning opacity-60" />
              <div className="w-[7px] h-[7px] rounded-full bg-cc-success opacity-60" />
            </div>
            <CopyButton text="claude setup-token" />
          </div>
          <div className="px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="text-cc-muted text-xs font-mono-code select-none" aria-hidden="true">$</span>
            <code className="text-[13px] font-mono-code text-cc-fg select-all">claude setup-token</code>
            </div>
          </div>
        </div>
      )}

      {authMethod === "oauth" && (
      <div className="mb-4">
        <label htmlFor="claude-token" className="text-xs text-cc-muted block mb-1.5">
          OAuth Token
        </label>
        <input
          ref={inputRef}
          id="claude-token"
          type="password"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="Paste the token from your terminal..."
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted/60 focus:outline-none focus:ring-1 focus:ring-cc-primary focus:border-cc-primary font-mono-code transition-shadow duration-150"
        />
      </div>
      )}

      {authMethod === "apiKey" && (
        <div className="mb-4 grid gap-3">
          <div>
            <label htmlFor="claude-api-key" className="text-xs text-cc-muted block mb-1.5">
              Claude API Key
            </label>
            <input
              id="claude-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="sk-ant-..."
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted/60 focus:outline-none focus:ring-1 focus:ring-cc-primary focus:border-cc-primary font-mono-code transition-shadow duration-150"
            />
          </div>
          <div>
            <label htmlFor="claude-base-url" className="text-xs text-cc-muted block mb-1.5">
              Claude-compatible Base URL
            </label>
            <input
              id="claude-base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder="Default: https://api.anthropic.com"
              className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted/60 focus:outline-none focus:ring-1 focus:ring-cc-primary focus:border-cc-primary transition-shadow duration-150"
            />
          </div>
        </div>
      )}

      {error && (
        <div id={errorId} role="alert" className="flex items-start gap-2 mb-4 text-xs text-cc-error">
          <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2 pt-1">
        <button
          onClick={onVerify}
          disabled={verifying || saving}
          className="w-full px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors disabled:opacity-50"
        >
          {verifying ? "Verifying..." : verified ? "Verified" : "Verify Claude Auth"}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onSkip}
            className="flex-1 px-4 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors"
          >
            Skip
          </button>
          <button
            onClick={onSave}
            disabled={saving || verifying || !verified}
            className="btn-primary-aa flex-1 px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium text-white transition-[background,opacity] duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ boxShadow: saving || !verified ? "none" : "0 1px 3px var(--color-cc-primary-btn)" }}
          >
            {saving ? "Saving..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Codex Setup ──────────────────────────────────────────────────────────── */

function CodexSetupStep({
  apiKey,
  baseUrl,
  authMethod,
  verified,
  verifying,
  onAuthMethodChange,
  onApiKeyChange,
  onBaseUrlChange,
  onVerify,
  onSave,
  onSkip,
  onBack,
  saving,
  error,
}: {
  apiKey: string;
  baseUrl: string;
  authMethod: CodexAuthMethod;
  verified: boolean;
  verifying: boolean;
  onAuthMethodChange: (v: CodexAuthMethod) => void;
  onApiKeyChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onVerify: () => void;
  onSave: () => void;
  onSkip: () => void;
  onBack: () => void;
  saving: boolean;
  error: string;
}) {
  const errorId = "codex-auth-error";

  return (
    <div className="p-7 pb-6">
      <div className="mb-5">
        <div className="text-[10px] uppercase tracking-[0.12em] text-cc-muted font-medium mb-2">
          Step 2 of 2
        </div>
        <h2 className="text-xl font-semibold text-cc-fg leading-tight">
          Set up Codex
        </h2>
        <p className="text-sm text-cc-muted mt-1.5 leading-relaxed">
          Choose how new Codex sessions should authenticate. Verification must pass before this becomes the saved method.
        </p>
      </div>

      <div className="mb-4 grid gap-2">
        <label htmlFor="onboarding-codex-auth-method" className="text-xs text-cc-muted block">
          Codex auth method
        </label>
        <select
          id="onboarding-codex-auth-method"
          value={authMethod}
          onChange={(e) => onAuthMethodChange(e.target.value as CodexAuthMethod)}
          className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-codex focus:border-cc-codex transition-shadow duration-150"
        >
          <option value="local">Local CLI login</option>
          <option value="apiKey">API key</option>
        </select>
        <p className="text-xs text-cc-muted leading-relaxed">
          Local CLI login runs a real <code className="font-mono-code">codex exec hello</code> verification and does not inject credentials. API key mode saves credentials into AgentHangar for new sessions.
        </p>
      </div>

      {authMethod === "local" && (
        <div
        className="rounded-lg overflow-hidden mb-4 border border-cc-border"
        style={{ background: "var(--color-cc-code-bg)" }}
        >
        <div
          className="flex items-center justify-between px-3 py-1.5 border-b border-cc-border"
        >
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <div className="w-[7px] h-[7px] rounded-full bg-cc-error opacity-60" />
            <div className="w-[7px] h-[7px] rounded-full bg-cc-warning opacity-60" />
            <div className="w-[7px] h-[7px] rounded-full bg-cc-success opacity-60" />
          </div>
          <CopyButton text="codex --login" />
        </div>
        <div className="px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-cc-muted text-xs font-mono-code select-none" aria-hidden="true">$</span>
            <code className="text-[13px] font-mono-code text-cc-fg select-all">codex --login</code>
          </div>
        </div>
      </div>
      )}

      {error && (
        <div id={errorId} role="alert" className="flex items-start gap-2 mb-4 text-xs text-cc-error">
          <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      {authMethod === "apiKey" && (
        <div className="mb-4 grid gap-3">
          <div>
            <label htmlFor="openai-key" className="text-xs text-cc-muted block mb-1.5">
              OpenAI API Key
            </label>
            <input
              id="openai-key"
              type="password"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="sk-..."
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted/60 focus:outline-none focus:ring-1 focus:ring-cc-codex focus:border-cc-codex font-mono-code transition-shadow duration-150"
            />
          </div>
          <div>
            <label htmlFor="openai-base-url" className="text-xs text-cc-muted block mb-1.5">
              OpenAI-compatible Base URL
            </label>
            <input
              id="openai-base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder="Default: https://api.openai.com/v1"
              className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted/60 focus:outline-none focus:ring-1 focus:ring-cc-codex focus:border-cc-codex transition-shadow duration-150"
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2 pt-1">
        <button
          onClick={onVerify}
          disabled={verifying || saving}
          className="w-full px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors disabled:opacity-50"
        >
          {verifying ? "Verifying..." : verified ? "Verified" : "Verify Codex Auth"}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="px-3 py-2.5 min-h-[44px] min-w-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg transition-colors flex items-center gap-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <button
            onClick={onSkip}
            className="flex-1 px-4 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors"
          >
            Skip
          </button>
          <button
            onClick={onSave}
            disabled={saving || verifying || !verified}
            className="btn-codex-aa flex-1 px-5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium text-white transition-[background,opacity] duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ boxShadow: saving || !verified ? "none" : "0 1px 3px var(--color-cc-codex-btn)" }}
          >
            {saving ? "Saving..." : "Finish"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Done ─────────────────────────────────────────────────────────────────── */

function DoneStep({
  claudeConfigured,
  codexConfigured,
  onDone,
}: {
  claudeConfigured: boolean;
  codexConfigured: boolean;
  onDone: () => void;
}) {
  const noneConfigured = !claudeConfigured && !codexConfigured;
  const skipMotion = prefersReducedMotion();
  const [visible, setVisible] = useState(skipMotion);

  useEffect(() => {
    if (!visible) {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [visible]);

  return (
    <div
      className="p-7 pb-6 text-center"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: skipMotion
          ? "none"
          : "opacity 400ms cubic-bezier(0.16, 1, 0.3, 1), transform 400ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {/* Success icon */}
      <div
        className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-5"
        style={{
          background: noneConfigured
            ? "var(--color-cc-hover)"
            : "color-mix(in srgb, var(--color-cc-success) 12%, transparent)",
        }}
      >
        {noneConfigured ? (
          <svg className="w-6 h-6 text-cc-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-cc-success" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      <h2 className="text-xl font-semibold text-cc-fg mb-2">
        {noneConfigured ? "Setup Skipped" : "You're all set!"}
      </h2>

      <div className="text-sm text-cc-muted leading-relaxed mb-6">
        {noneConfigured
          ? "You can configure providers anytime in Settings."
          : (
            <>
              {claudeConfigured && <span className="block">Claude Code is ready.</span>}
              {codexConfigured && <span className="block">Codex is ready.</span>}
              <span className="block mt-1 text-xs">You can update these anytime in Settings.</span>
            </>
          )
        }
      </div>

      <button
        onClick={onDone}
        className="btn-primary-aa w-full px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium text-white transition-[background] duration-150"
        style={{ boxShadow: "0 1px 3px var(--color-cc-primary-btn)" }}
      >
        Get Started
      </button>
    </div>
  );
}

/* ── Copy Button ──────────────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="text-[10px] text-cc-muted hover:text-cc-fg transition-colors flex items-center gap-1 min-h-[44px] min-w-[44px] justify-end"
      aria-label="Copy command"
    >
      {copied ? (
        <>
          <svg className="w-3 h-3 text-cc-success" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Copied!
        </>
      ) : (
        <>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}
