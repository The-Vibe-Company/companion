import { useState, useRef, useEffect } from "react";
import type { AgentInfo } from "../api.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AgentCardMenuProps {
  agent: AgentInfo;
  copiedWebhook: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onExport: () => void;
  onCopyWebhook: () => void;
  onRegenerateSecret: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AgentCardMenu({
  agent,
  copiedWebhook,
  onEdit,
  onDelete,
  onToggle,
  onExport,
  onCopyWebhook,
  onRegenerateSecret,
}: AgentCardMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click-outside
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const webhookEnabled = agent.triggers?.webhook?.enabled;

  function handleAction(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="relative" ref={menuRef}>
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        title="More actions"
        aria-label="More actions"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-48 bg-cc-card border border-cc-border rounded-xl shadow-lg z-20 py-1 origin-top-right"
          style={{ animation: "menu-appear 120ms ease-out" }}
          role="menu"
        >
          {/* Edit */}
          <button
            onClick={() => handleAction(onEdit)}
            className="w-full px-3 py-2 text-xs text-left text-cc-fg hover:bg-cc-hover transition-colors flex items-center gap-2.5 cursor-pointer"
            role="menuitem"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
              <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61z" />
            </svg>
            Edit
          </button>

          {/* Export */}
          <button
            onClick={() => handleAction(onExport)}
            className="w-full px-3 py-2 text-xs text-left text-cc-fg hover:bg-cc-hover transition-colors flex items-center gap-2.5 cursor-pointer"
            role="menuitem"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
              <path d="M3.5 13a.5.5 0 01-.5-.5V11h1v1h8v-1h1v1.5a.5.5 0 01-.5.5h-9zM8 2a.5.5 0 01.5.5v6.793l2.146-2.147a.5.5 0 01.708.708l-3 3a.5.5 0 01-.708 0l-3-3a.5.5 0 01.708-.708L7.5 9.293V2.5A.5.5 0 018 2z" />
            </svg>
            Export JSON
          </button>

          {/* Webhook section */}
          {webhookEnabled && (
            <>
              <div className="my-1 border-t border-cc-border/40" role="separator" />
              <button
                onClick={() => handleAction(onCopyWebhook)}
                className="w-full px-3 py-2 text-xs text-left text-cc-fg hover:bg-cc-hover transition-colors flex items-center gap-2.5 cursor-pointer"
                role="menuitem"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
                  <path d="M4.715 6.542L3.343 7.914a3 3 0 104.243 4.243l1.828-1.829A3 3 0 008.586 5.5L8 6.086a1 1 0 00-.154.199 2 2 0 01.861 3.337L6.88 11.45a2 2 0 11-2.83-2.83l.793-.792a4.018 4.018 0 01-.128-1.287z" />
                  <path d="M11.285 9.458l1.372-1.372a3 3 0 10-4.243-4.243L6.586 5.671A3 3 0 007.414 10.5l.586-.586a1 1 0 00.154-.199 2 2 0 01-.861-3.337L9.12 4.55a2 2 0 112.83 2.83l-.793.792c.112.42.155.855.128 1.287z" />
                </svg>
                {copiedWebhook === agent.id ? "Copied!" : "Copy Webhook URL"}
              </button>
              <button
                onClick={() => handleAction(onRegenerateSecret)}
                className="w-full px-3 py-2 text-xs text-left text-cc-fg hover:bg-cc-hover transition-colors flex items-center gap-2.5 cursor-pointer"
                role="menuitem"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
                  <path d="M11.534 7h3.932a.25.25 0 01.192.41l-1.966 2.36a.25.25 0 01-.384 0l-1.966-2.36a.25.25 0 01.192-.41zm-7 2H.602a.25.25 0 01-.192-.41l1.966-2.36a.25.25 0 01.384 0l1.966 2.36a.25.25 0 01-.192.41z" />
                  <path d="M8 3a5 5 0 014.546 2.914.5.5 0 00.908-.418A6 6 0 002 8c0 .088.002.176.006.264l-.058-.024a.5.5 0 00-.394.908l2 1a.5.5 0 00.668-.17L5.59 7.864a.5.5 0 00-.274-.846l-.09-.016A4 4 0 018 3zm.002 10a4 4 0 002.49-4.002l.09.016a.5.5 0 00.274.846l-1.367 2.114a.5.5 0 01-.668.17l-2-1a.5.5 0 01.394-.908l.058.024A5.972 5.972 0 008.002 13a5 5 0 01-4.546-2.914.5.5 0 00-.908.418A6 6 0 008.002 13z" />
                </svg>
                Regenerate Secret
              </button>
            </>
          )}

          {/* Toggle */}
          <div className="my-1 border-t border-cc-border/40" role="separator" />
          <button
            onClick={() => handleAction(onToggle)}
            className="w-full px-3 py-2 text-xs text-left text-cc-fg hover:bg-cc-hover transition-colors flex items-center gap-2.5 cursor-pointer"
            role="menuitem"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
              {agent.enabled ? (
                <path d="M5 3a5 5 0 000 10h6a5 5 0 000-10H5zm6 3a2 2 0 110 4 2 2 0 010-4z" />
              ) : (
                <path d="M11 3a5 5 0 010 10H5A5 5 0 015 3h6zM5 6a2 2 0 100 4 2 2 0 000-4z" />
              )}
            </svg>
            {agent.enabled ? "Disable" : "Enable"}
          </button>

          {/* Delete */}
          <div className="my-1 border-t border-cc-border/40" role="separator" />
          <button
            onClick={() => handleAction(onDelete)}
            className="w-full px-3 py-2 text-xs text-left text-cc-error hover:bg-cc-error/10 transition-colors flex items-center gap-2.5 cursor-pointer"
            role="menuitem"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M5.5 5.5a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm-7-3A1.5 1.5 0 015 1h6a1.5 1.5 0 011.5 1.5H14a.5.5 0 010 1h-.554L12.2 14.118A1.5 1.5 0 0110.706 15H5.294a1.5 1.5 0 01-1.494-.882L2.554 3.5H2a.5.5 0 010-1h1.5z" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
