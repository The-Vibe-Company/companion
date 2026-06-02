import { useState } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { captureException } from "../analytics.js";

export function UpdateBanner() {
  const updateInfo = useStore((s) => s.updateInfo);
  const dismissedVersion = useStore((s) => s.updateDismissedVersion);
  const dismissUpdate = useStore((s) => s.dismissUpdate);
  const [updating, setUpdating] = useState(false);

  if (!updateInfo?.updateAvailable || !updateInfo.latestVersion) return null;
  if (dismissedVersion === updateInfo.latestVersion) return null;

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      // Flag so the Docker image update dialog appears after restart
      localStorage.setItem("companion_docker_prompt_pending", "1");
      await api.triggerUpdate();
      // Show the full-screen updating overlay
      useStore.getState().setUpdateOverlayActive(true);
    } catch (err) {
      localStorage.removeItem("companion_docker_prompt_pending");
      captureException(err);
      setUpdating(false);
    }
  };

  const handleDismiss = () => {
    dismissUpdate(updateInfo.latestVersion!);
  };

  const inProgress = updating || updateInfo.updateInProgress;

  return (
    <div className="px-4 py-1.5 bg-cc-primary/10 border-b border-cc-primary/20 flex items-center justify-center gap-3 animate-[fadeSlideIn_0.2s_ease-out]">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary shrink-0">
        <path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 2a.75.75 0 0 0-.75.75v3.69L5.78 6.15a.75.75 0 0 0-.96 1.15l2.5 2.08a.75.75 0 0 0 1.08-.12l2-2.5a.75.75 0 1 0-1.17-.94L8.75 6.5V3.75A.75.75 0 0 0 8 3z" />
      </svg>

      <span className="text-xs text-cc-fg">
        <span className="font-medium">v{updateInfo.latestVersion}</span> available
        <span className="text-cc-muted ml-1">(current: v{updateInfo.currentVersion})</span>
      </span>

      {updateInfo.isServiceMode ? (
        <button
          onClick={handleUpdate}
          disabled={inProgress}
          className="text-xs font-medium px-2.5 py-0.5 rounded-md bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {inProgress ? "Updating..." : "Update & Restart"}
        </button>
      ) : (
        <span className="text-xs text-cc-muted">
          Run{" "}
          <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">
            the-companion install
          </code>{" "}
          for auto-updates
        </span>
      )}

      <button
        onClick={handleDismiss}
        className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer ml-auto"
        title="Dismiss"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
