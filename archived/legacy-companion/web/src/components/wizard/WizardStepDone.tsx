import { useState } from "react";

interface WizardStepDoneProps {
  agentName: string;
  onFinish: () => void;
  /** Create another agent reusing the same OAuth app credentials */
  onAddAnotherSameApp?: () => void;
  /** Create another agent with a different OAuth app (full wizard) */
  onAddAnotherNewApp?: () => void;
}

export function WizardStepDone({ agentName, onFinish, onAddAnotherSameApp, onAddAnotherNewApp }: WizardStepDoneProps) {
  const [showAddChoice, setShowAddChoice] = useState(false);

  return (
    <div className="space-y-8">
      {/* Success header — restrained celebration */}
      <div className="pt-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-5 h-5 rounded-full bg-cc-success/15 flex items-center justify-center">
            <svg className="w-3 h-3 text-cc-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-[11px] uppercase tracking-widest text-cc-success font-medium">Complete</p>
        </div>
        <h2 className="text-xl font-semibold text-cc-fg tracking-tight leading-tight">
          {agentName} is live
        </h2>
        <p className="mt-2 text-sm text-cc-muted leading-relaxed max-w-md">
          Your agent is connected and listening for @mentions in Linear.
        </p>
      </div>

      {/* Status items — minimal, no card wrapping */}
      <div className="space-y-3">
        {[
          { label: "OAuth app connected", detail: "Your Linear workspace is linked" },
          { label: `Agent "${agentName}" created`, detail: "Linear trigger enabled with full auto permissions" },
          { label: "Ready for @mentions", detail: "Mention the agent in any issue to trigger a session" },
        ].map((item) => (
          <div key={item.label} className="flex items-start gap-3">
            <div className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-cc-success/12 flex items-center justify-center">
              <svg className="w-2.5 h-2.5 text-cc-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-[13px] font-medium text-cc-fg">{item.label}</p>
              <p className="text-xs text-cc-muted mt-0.5">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Next steps — light separator, not a card */}
      <div className="border-t border-cc-border/50 pt-5">
        <p className="text-[11px] uppercase tracking-widest text-cc-muted font-medium mb-3">Next steps</p>
        <ul className="space-y-2 text-xs text-cc-muted leading-relaxed">
          <li>@mention <strong className="text-cc-fg">{agentName}</strong> in any Linear issue to test it</li>
          <li>
            Fine-tune in the{" "}
            <a href="#/agents" className="text-cc-primary hover:underline">Agents page</a>
          </li>
          <li>
            Manage credentials in{" "}
            <a href="#/integrations/linear-oauth" className="text-cc-primary hover:underline">OAuth Settings</a>
          </li>
        </ul>
      </div>

      {/* Add another — progressive disclosure */}
      {showAddChoice && (onAddAnotherSameApp || onAddAnotherNewApp) && (
        <div className="border-t border-cc-border/50 pt-5 space-y-3">
          <p className="text-[13px] font-medium text-cc-fg">Create another agent</p>
          <p className="text-xs text-cc-muted">
            Reuse the same OAuth connection or set up a new one?
          </p>
          <div className="flex gap-2 pt-1">
            {onAddAnotherSameApp && (
              <button
                onClick={onAddAnotherSameApp}
                className="flex-1 px-3 py-2.5 rounded-lg text-xs font-medium border border-cc-border text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Same OAuth app
              </button>
            )}
            {onAddAnotherNewApp && (
              <button
                onClick={onAddAnotherNewApp}
                className="flex-1 px-3 py-2.5 rounded-lg text-xs font-medium border border-cc-border text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Different OAuth app
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-between pt-1">
        {(onAddAnotherSameApp || onAddAnotherNewApp) && !showAddChoice && (
          <button
            onClick={() => setShowAddChoice(true)}
            className="text-xs font-medium text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            + Create Another Agent
          </button>
        )}
        <button
          onClick={onFinish}
          className="px-5 py-2.5 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer ml-auto"
        >
          Go to Agents
        </button>
      </div>
    </div>
  );
}
