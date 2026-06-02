import { useEffect, useRef, useState } from "react";
import { api, type ImagePullState } from "../api.js";
import { useStore } from "../store.js";

type DialogPhase = "prompt" | "pulling" | "done" | "error";

/**
 * DockerUpdateDialog — shown after an app update completes to ask the user
 * whether they also want to re-pull the sandbox Docker image.
 * Includes a toggle to persist the "always update" preference (dockerAutoUpdate).
 */
export function DockerUpdateDialog() {
  const open = useStore((s) => s.dockerUpdateDialogOpen);
  const setOpen = useStore((s) => s.setDockerUpdateDialogOpen);
  const [phase, setPhase] = useState<DialogPhase>("prompt");
  const [alwaysUpdate, setAlwaysUpdate] = useState(false);
  const [pullState, setPullState] = useState<ImagePullState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load the current dockerAutoUpdate setting on open.
  // If the user has opted into auto-updates, skip the prompt and start pulling immediately.
  useEffect(() => {
    if (!open) return;
    api.getSettings()
      .then((s) => {
        setAlwaysUpdate(s.dockerAutoUpdate);
        if (s.dockerAutoUpdate) {
          triggerPull();
        }
      })
      .catch(() => {});
  }, [open]);

  // Poll image status while pulling (every 2s)
  useEffect(() => {
    if (phase !== "pulling") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    pollRef.current = setInterval(() => {
      api.getImageStatus("the-companion:latest")
        .then((state) => {
          setPullState(state);
          if (state.status === "ready") {
            setPhase("done");
          } else if (state.status === "error") {
            setPhase("error");
          }
        })
        .catch(() => {});
    }, 2000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [phase]);

  if (!open) return null;

  function triggerPull() {
    setPhase("pulling");
    api.pullImage("the-companion:latest")
      .then((res) => {
        if (res.state) setPullState(res.state);
      })
      .catch(() => {
        // Only transition to error if polling hasn't already moved us past "pulling"
        setPhase((current) => (current === "pulling" ? "error" : current));
      });
  }

  function handleUpdate() {
    triggerPull();
  }

  function handleSkip() {
    resetAndClose();
  }

  function handleDone() {
    resetAndClose();
  }

  function resetAndClose() {
    setPhase("prompt");
    setPullState(null);
    setOpen(false);
  }

  async function handleToggle() {
    const next = !alwaysUpdate;
    setAlwaysUpdate(next);
    try {
      await api.updateSettings({ dockerAutoUpdate: next });
    } catch {
      setAlwaysUpdate(!next);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 animate-fade-in"
      data-testid="docker-update-dialog"
    >
      <div className="bg-cc-bg rounded-xl shadow-xl border border-cc-border w-full max-w-md mx-4 overflow-hidden">
        {phase === "prompt" && (
          <div className="p-6">
            <h2 className="text-base font-semibold text-cc-fg mb-2">
              Update Sandbox Image?
            </h2>
            <p className="text-sm text-cc-muted mb-5">
              A new version of The Companion was installed. Would you like to also
              update the sandbox Docker image?
            </p>

            {/* Always-update toggle */}
            <button
              type="button"
              onClick={handleToggle}
              className="w-full flex items-center justify-between px-3 py-3 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer mb-5"
            >
              <span>Always update Docker image automatically</span>
              <span
                role="switch"
                aria-checked={alwaysUpdate}
                aria-label="Always update Docker image automatically"
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
                  alwaysUpdate ? "bg-cc-primary" : "bg-cc-border"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                    alwaysUpdate ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </span>
            </button>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSkip}
                className="px-4 py-2 min-h-[40px] rounded-lg text-sm font-medium bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={handleUpdate}
                className="px-4 py-2 min-h-[40px] rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
              >
                Update
              </button>
            </div>
          </div>
        )}

        {phase === "pulling" && (
          <div className="p-6">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 animate-spin text-cc-primary" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="31.4 31.4" strokeLinecap="round" />
              </svg>
              <h2 className="text-base font-semibold text-cc-fg">
                Updating Sandbox Image...
              </h2>
            </div>
            <p className="text-sm text-cc-muted mb-3">
              Pulling the-companion:latest
            </p>
            {pullState?.progress && pullState.progress.length > 0 && (
              <pre
                className="px-3 py-2 text-[10px] font-mono-code bg-cc-code-bg rounded-lg text-cc-muted max-h-[160px] overflow-auto whitespace-pre-wrap"
                data-testid="pull-progress"
              >
                {pullState.progress.slice(-20).join("\n")}
              </pre>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="p-6">
            <div className="flex items-center gap-2 mb-2">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success">
                <path fillRule="evenodd" d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm3.78-9.72a.75.75 0 0 0-1.06-1.06L7 8.94 5.28 7.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.06 0l4.25-4.25z" />
              </svg>
              <h2 className="text-base font-semibold text-cc-success">
                Sandbox Image Updated
              </h2>
            </div>
            <p className="text-sm text-cc-muted mb-5">
              The Docker image has been updated successfully.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleDone}
                className="px-4 py-2 min-h-[40px] rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="p-6">
            <div className="flex items-center gap-2 mb-2">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-error">
                <path fillRule="evenodd" d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zM5.22 5.22a.75.75 0 0 1 1.06 0L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 1 1-1.06 1.06L8 9.06l-1.72 1.72a.75.75 0 0 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 0-1.06z" />
              </svg>
              <h2 className="text-base font-semibold text-cc-error">
                Image Update Failed
              </h2>
            </div>
            <p className="text-sm text-cc-muted mb-2">
              Failed to update the Docker image.
              {pullState?.error && (
                <span className="block mt-1 text-xs text-cc-error">{pullState.error}</span>
              )}
            </p>
            {pullState?.progress && pullState.progress.length > 0 && (
              <pre
                className="px-3 py-2 text-[10px] font-mono-code bg-cc-code-bg rounded-lg text-cc-muted max-h-[120px] overflow-auto whitespace-pre-wrap mb-4"
                data-testid="pull-progress"
              >
                {pullState.progress.slice(-20).join("\n")}
              </pre>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={resetAndClose}
                className="px-4 py-2 min-h-[40px] rounded-lg text-sm font-medium bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleUpdate}
                className="px-4 py-2 min-h-[40px] rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Static preview of the DockerUpdateDialog for the Playground page.
 */
export function PlaygroundDockerUpdateDialog({ phase }: { phase: DialogPhase }) {
  return (
    <div className="relative bg-black/50 rounded-lg overflow-hidden h-[300px] flex items-center justify-center">
      <div className="bg-cc-bg rounded-xl shadow-xl border border-cc-border w-full max-w-sm mx-4 overflow-hidden">
        {phase === "prompt" && (
          <div className="p-5">
            <h2 className="text-sm font-semibold text-cc-fg mb-1.5">Update Sandbox Image?</h2>
            <p className="text-xs text-cc-muted mb-4">
              A new version of The Companion was installed. Would you like to also update the sandbox Docker image?
            </p>
            <div className="flex items-center justify-between px-2 py-2 rounded-lg bg-cc-hover text-xs text-cc-fg mb-4">
              <span>Always update automatically</span>
              <span className="relative inline-flex h-4 w-7 rounded-full bg-cc-border">
                <span className="inline-block h-3 w-3 rounded-full bg-white shadow translate-x-0 mt-0.5 ml-0.5" />
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <span className="px-3 py-1.5 rounded-lg text-xs bg-cc-hover text-cc-fg">Skip</span>
              <span className="px-3 py-1.5 rounded-lg text-xs bg-cc-primary text-white">Update</span>
            </div>
          </div>
        )}
        {phase === "pulling" && (
          <div className="p-5">
            <div className="flex items-center gap-1.5 mb-2">
              <svg className="w-3.5 h-3.5 animate-spin text-cc-primary" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="31.4 31.4" strokeLinecap="round" />
              </svg>
              <h2 className="text-sm font-semibold text-cc-fg">Updating Sandbox Image...</h2>
            </div>
            <pre className="px-2 py-1.5 text-[9px] font-mono-code bg-cc-code-bg rounded text-cc-muted max-h-[80px] overflow-auto whitespace-pre-wrap">
              {"Pulling the-companion:latest...\nLayer 1/5: abc123 downloading\nLayer 2/5: def456 complete"}
            </pre>
          </div>
        )}
        {phase === "done" && (
          <div className="p-5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success">
                <path fillRule="evenodd" d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm3.78-9.72a.75.75 0 0 0-1.06-1.06L7 8.94 5.28 7.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.06 0l4.25-4.25z" />
              </svg>
              <h2 className="text-sm font-semibold text-cc-success">Sandbox Image Updated</h2>
            </div>
            <p className="text-xs text-cc-muted mb-4">The Docker image has been updated successfully.</p>
            <div className="flex justify-end">
              <span className="px-3 py-1.5 rounded-lg text-xs bg-cc-primary text-white">Done</span>
            </div>
          </div>
        )}
        {phase === "error" && (
          <div className="p-5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error">
                <path fillRule="evenodd" d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zM5.22 5.22a.75.75 0 0 1 1.06 0L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 1 1-1.06 1.06L8 9.06l-1.72 1.72a.75.75 0 0 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 0-1.06z" />
              </svg>
              <h2 className="text-sm font-semibold text-cc-error">Image Update Failed</h2>
            </div>
            <p className="text-xs text-cc-muted mb-4">Failed to update the Docker image.</p>
            <div className="flex justify-end gap-2">
              <span className="px-3 py-1.5 rounded-lg text-xs bg-cc-hover text-cc-fg">Close</span>
              <span className="px-3 py-1.5 rounded-lg text-xs bg-cc-primary text-white">Retry</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
