import { useState } from "react";
import { api } from "../../api.js";

interface WizardStepInstallProps {
  onNext: () => void;
  onBack: () => void;
  oauthConnected: boolean;
  oauthError: string;
  stagingId: string | null;
  /** Called before redirecting to Linear so the parent can persist state */
  onBeforeRedirect: () => void;
}

export function WizardStepInstall({ onNext, onBack, oauthConnected, oauthError, stagingId, onBeforeRedirect }: WizardStepInstallProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(oauthError);

  async function handleInstall() {
    setLoading(true);
    setError("");
    try {
      onBeforeRedirect();
      const result = await api.getLinearOAuthAuthorizeUrl("/#/agents", stagingId || undefined);
      window.open(result.url, "_self");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  if (oauthConnected) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-cc-fg">Install to Workspace</h2>
          <p className="mt-1 text-sm text-cc-muted">
            Connect your Linear OAuth app to your workspace.
          </p>
        </div>

        <div className="flex items-center gap-3 p-4 rounded-lg border border-cc-success/30 bg-cc-success/5">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-cc-success/20 flex items-center justify-center">
            <svg className="w-4 h-4 text-cc-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-cc-fg">Connected to Linear</p>
            <p className="text-xs text-cc-muted">Your agent app is installed and ready to receive mentions.</p>
          </div>
        </div>

        <div className="flex justify-between">
          <button
            onClick={onBack}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            Back
          </button>
          <button
            onClick={onNext}
            className="px-4 py-2.5 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-cc-fg">Install to Workspace</h2>
        <p className="mt-1 text-sm text-cc-muted">
          Click the button below to authorize the app with your Linear workspace. You'll be redirected to Linear
          and brought back here after authorization.
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      <div className="flex items-center justify-center p-8">
        <button
          onClick={handleInstall}
          disabled={loading}
          className={`px-6 py-3 rounded-lg text-sm font-medium transition-colors ${
            loading
              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
              : "bg-violet-600 hover:bg-violet-700 text-white cursor-pointer"
          }`}
        >
          {loading ? "Redirecting..." : "Install to Workspace"}
        </button>
      </div>

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2.5 rounded-lg text-sm font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Back
        </button>
      </div>
    </div>
  );
}
