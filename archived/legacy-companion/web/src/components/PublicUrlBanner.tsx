import { useState } from "react";

const DISMISS_KEY = "companion_public_url_dismissed";

export function PublicUrlBanner({ publicUrl }: { publicUrl: string }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");

  if (publicUrl || dismissed) return null;

  return (
    <div className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs flex items-start justify-between gap-3" role="alert">
      <div>
        <strong>No public URL configured.</strong>{" "}
        Webhook URLs currently use your browser address, which external services like Linear may not be able to reach.{" "}
        <a href="#/settings" className="underline hover:text-amber-300">Set your public URL in Settings</a>.
      </div>
      <button
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
        className="text-amber-400 hover:text-amber-200 transition-colors cursor-pointer flex-shrink-0"
        aria-label="Dismiss public URL banner"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
        </svg>
      </button>
    </div>
  );
}
