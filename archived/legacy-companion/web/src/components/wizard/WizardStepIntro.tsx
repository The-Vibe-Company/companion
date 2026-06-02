import { useStore } from "../../store.js";

interface WizardStepIntroProps {
  onNext: () => void;
}

export function WizardStepIntro({ onNext }: WizardStepIntroProps) {
  const publicUrl = useStore((s) => s.publicUrl);
  const baseUrl = publicUrl || window.location.origin;
  const hasPublicUrl = !!publicUrl;

  return (
    <div className="space-y-8">
      {/* Title area — asymmetric, editorial feel */}
      <div className="pt-1">
        <p className="text-[11px] uppercase tracking-widest text-cc-primary font-medium mb-2">Linear Agent Setup</p>
        <h2 className="text-xl font-semibold text-cc-fg tracking-tight leading-tight">
          Connect your Linear workspace
        </h2>
        <p className="mt-2 text-sm text-cc-muted leading-relaxed max-w-md">
          This wizard connects the Agent Interaction SDK so your agent can
          respond to @mentions in Linear issues.
        </p>
      </div>

      {/* Prerequisites — clean vertical list without nested cards */}
      <div className="space-y-4">
        {/* Public URL status */}
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${hasPublicUrl ? "bg-cc-success/15 text-cc-success" : "bg-cc-warning/15 text-cc-warning"}`}>
            {hasPublicUrl ? (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <span className="text-[10px] font-bold">!</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[13px] text-cc-fg font-medium">Public URL</p>
            <p className="text-xs text-cc-muted mt-0.5 leading-relaxed">
              {hasPublicUrl
                ? <><code className="px-1 py-0.5 rounded bg-cc-hover text-[10px] font-mono-code">{publicUrl}</code></>
                : <>Not set. Linear needs to reach your instance. Configure in <a href="#/integrations/tailscale" className="text-cc-primary hover:underline">Tailscale</a> or <a href="#/settings" className="text-cc-primary hover:underline">Settings</a>.</>
              }
            </p>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-cc-border/50" />

        {/* Setup instructions */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center bg-cc-hover text-cc-muted">
            <span className="text-[10px] font-semibold">1</span>
          </div>
          <div className="min-w-0">
            <p className="text-[13px] text-cc-fg font-medium">Create a Linear OAuth app</p>
            <p className="text-xs text-cc-muted mt-0.5 leading-relaxed">
              <a href="https://linear.app/settings/api" target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">
                Linear &rarr; Settings &rarr; API &rarr; OAuth Applications
              </a>
            </p>
            <dl className="mt-3 space-y-2.5 text-xs">
              <div>
                <dt className="text-cc-muted">Webhooks</dt>
                <dd className="text-cc-fg mt-0.5">Enable and subscribe to <strong>Agent session events</strong></dd>
              </div>
              <div>
                <dt className="text-cc-muted">Scope</dt>
                <dd className="mt-0.5"><code className="px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg text-[10px] font-mono-code">app:mentionable</code></dd>
              </div>
              <div>
                <dt className="text-cc-muted">Redirect URI</dt>
                <dd className="mt-0.5"><code className="px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg text-[10px] font-mono-code break-all">{`${baseUrl}/api/linear/oauth/callback`}</code></dd>
              </div>
              <div>
                <dt className="text-cc-muted">Webhook URL</dt>
                <dd className="mt-0.5"><code className="px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg text-[10px] font-mono-code break-all">{`${baseUrl}/api/linear/agent-webhook`}</code></dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <button
          onClick={onNext}
          className="px-5 py-2.5 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
        >
          Next
        </button>
      </div>
    </div>
  );
}
