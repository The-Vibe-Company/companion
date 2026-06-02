import { useEffect, useState } from "react";
import { api, type LinearOAuthConnectionSummary } from "../../api.js";

interface WizardStepSelectConnectionProps {
  onNext: (connectionId: string) => void;
  onBack: () => void;
  /** Pre-selected connection ID (e.g. from "Create Another with Same App") */
  selectedConnectionId?: string | null;
}

/**
 * Wizard step that replaces the old Credentials + Install steps.
 * Shows a dropdown of existing OAuth connections and a link to create one.
 */
export function WizardStepSelectConnection({
  onNext,
  onBack,
  selectedConnectionId,
}: WizardStepSelectConnectionProps) {
  const [connections, setConnections] = useState<LinearOAuthConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>(selectedConnectionId || "");
  const [error, setError] = useState("");

  useEffect(() => {
    api.listLinearOAuthConnections()
      .then((result) => {
        setConnections(result.connections);
        setError(""); // Clear any previous error on successful fetch
        // Auto-select if only one connection or if a pre-selected ID is valid
        if (selectedConnectionId) {
          const exists = result.connections.some(c => c.id === selectedConnectionId);
          if (exists) setSelected(selectedConnectionId);
        } else if (result.connections.length === 1) {
          setSelected(result.connections[0].id);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [selectedConnectionId]);

  const selectedConn = connections.find(c => c.id === selected);
  const canProceed = !!selected && selectedConn?.status === "connected";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-cc-fg">Select OAuth Connection</h2>
        <p className="mt-1 text-sm text-cc-muted">
          Choose which Linear OAuth app this agent should use for @mention triggers.
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-cc-muted">Loading connections...</p>
      ) : connections.length === 0 ? (
        <div className="rounded-lg border border-cc-border bg-cc-bg p-5 text-center space-y-3">
          <p className="text-sm text-cc-muted">No OAuth connections found.</p>
          <p className="text-xs text-cc-muted">
            Create an OAuth app connection first, then come back to set up the agent.
          </p>
          <a
            href="#/integrations/linear-oauth"
            className="inline-flex px-4 py-2.5 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors"
          >
            Go to OAuth Settings
          </a>
        </div>
      ) : (
        <div className="space-y-3">
          {connections.map((conn) => {
            const isSelected = selected === conn.id;
            const isConnected = conn.status === "connected";
            return (
              <button
                key={conn.id}
                type="button"
                onClick={() => setSelected(conn.id)}
                className={`w-full text-left p-4 rounded-lg border transition-colors cursor-pointer ${
                  isSelected
                    ? "border-cc-primary bg-cc-primary/5"
                    : "border-cc-border hover:border-cc-border hover:bg-cc-hover/50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      isSelected ? "border-cc-primary" : "border-cc-border"
                    }`}>
                      {isSelected && (
                        <div className="w-2 h-2 rounded-full bg-cc-primary" />
                      )}
                    </div>
                    <span className="text-sm font-medium text-cc-fg truncate">{conn.name}</span>
                  </div>
                  <span
                    className={`px-2 py-0.5 text-[10px] rounded-full border flex-shrink-0 ${
                      isConnected
                        ? "bg-cc-success/10 text-cc-success border-cc-success/20"
                        : "bg-cc-hover text-cc-muted border-cc-border"
                    }`}
                  >
                    {isConnected ? "Connected" : "Not installed"}
                  </span>
                </div>
                {!isConnected && isSelected && (
                  <p className="mt-2 ml-6 text-xs text-cc-warning">
                    This connection needs to be installed to a workspace first.{" "}
                    <a
                      href="#/integrations/linear-oauth"
                      className="text-cc-primary underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Install now
                    </a>
                  </p>
                )}
              </button>
            );
          })}

          <a
            href="#/integrations/linear-oauth"
            className="block text-center text-xs text-cc-primary hover:underline py-2"
          >
            + Create a new OAuth connection
          </a>
        </div>
      )}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2.5 rounded-lg text-sm font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Back
        </button>
        <button
          onClick={() => canProceed && onNext(selected)}
          disabled={!canProceed}
          className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            canProceed
              ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              : "bg-cc-hover text-cc-muted cursor-not-allowed"
          }`}
        >
          Next
        </button>
      </div>
    </div>
  );
}
