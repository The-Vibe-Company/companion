import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { sendSetAiValidation } from "../ws.js";

interface AiValidationToggleProps {
  sessionId: string;
}

/**
 * Per-session AI validation toggle that appears in the TopBar.
 * Shows a shield icon that opens a dropdown with enable/disable
 * and auto-approve/auto-deny sub-toggles.
 */
export function AiValidationToggle({ sessionId }: AiValidationToggleProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const session = useStore((s) => s.sessions.get(sessionId));

  const enabled = session?.aiValidationEnabled ?? false;
  const autoApprove = session?.aiValidationAutoApprove ?? true;
  const autoDeny = session?.aiValidationAutoDeny ?? false;

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function toggle(
    field: "aiValidationEnabled" | "aiValidationAutoApprove" | "aiValidationAutoDeny",
    currentValue: boolean,
  ) {
    const newValue = !currentValue;
    const patch = { [field]: newValue };
    // Optimistic UI update
    useStore.getState().setSessionAiValidation(sessionId, patch);
    // Send to server via WebSocket
    sendSetAiValidation(sessionId, patch);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer ${
          enabled
            ? "text-cc-success hover:bg-cc-hover"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        }`}
        title={enabled ? "AI Validation: On" : "AI Validation: Off"}
        aria-label="Toggle AI validation settings"
        aria-expanded={open}
      >
        {/* Shield icon */}
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-[15px] h-[15px]">
          <path fillRule="evenodd" d="M8 1.246l.542.228c1.926.812 3.732.95 5.408.435l.61-.187v6.528a5.75 5.75 0 01-2.863 4.973L8 15.5l-3.697-2.277A5.75 5.75 0 011.44 8.25V1.722l.61.187c1.676.515 3.482.377 5.408-.435L8 1.246z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-cc-bg border border-cc-border rounded-lg shadow-lg p-2 space-y-1">
          <p className="text-[10px] text-cc-muted px-2 pt-1 pb-1">
            AI Validation for this session
          </p>

          <button
            type="button"
            onClick={() => toggle("aiValidationEnabled", enabled)}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-cc-hover text-cc-fg transition-colors cursor-pointer"
            aria-label="Toggle AI validation"
          >
            <span className="text-xs">Enabled</span>
            <span className={`text-[10px] font-medium ${enabled ? "text-cc-success" : "text-cc-muted"}`}>
              {enabled ? "On" : "Off"}
            </span>
          </button>

          {enabled && (
            <>
              <button
                type="button"
                onClick={() => toggle("aiValidationAutoApprove", autoApprove)}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-cc-hover text-cc-fg transition-colors cursor-pointer"
                aria-label="Toggle auto-approve safe tools"
              >
                <span className="text-xs">Auto-approve safe</span>
                <span className={`text-[10px] font-medium ${autoApprove ? "text-cc-success" : "text-cc-muted"}`}>
                  {autoApprove ? "On" : "Off"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => toggle("aiValidationAutoDeny", autoDeny)}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-cc-hover text-cc-fg transition-colors cursor-pointer"
                aria-label="Toggle auto-deny dangerous tools"
              >
                <span className="text-xs">Auto-deny dangerous</span>
                <span className={`text-[10px] font-medium ${autoDeny ? "text-cc-success" : "text-cc-muted"}`}>
                  {autoDeny ? "On" : "Off"}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
