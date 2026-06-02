import { useState } from "react";
import { createPortal } from "react-dom";

export type LinearTransitionChoice = "none" | "backlog" | "configured";

interface ArchiveLinearModalProps {
  issueIdentifier: string;
  issueStateName: string;
  isContainerized: boolean;
  archiveTransitionConfigured: boolean;
  archiveTransitionStateName?: string;
  hasBacklogState: boolean;
  onConfirm: (choice: LinearTransitionChoice, force?: boolean) => void;
  onCancel: () => void;
}

export function ArchiveLinearModal({
  issueIdentifier,
  issueStateName,
  isContainerized,
  archiveTransitionConfigured,
  archiveTransitionStateName,
  hasBacklogState,
  onConfirm,
  onCancel,
}: ArchiveLinearModalProps) {
  const [choice, setChoice] = useState<LinearTransitionChoice>("none");

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-label="Archive session"
        className="mx-4 w-full max-w-sm bg-cc-card border border-cc-border rounded-xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-cc-fg">Archive session</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
            </svg>
          </button>
        </div>

        {/* Container warning */}
        {isContainerized && (
          <div className="mb-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-start gap-2">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5">
                <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
              </svg>
              <p className="text-[11px] text-cc-fg leading-snug">
                Archiving will <strong>remove the container</strong> and any uncommitted changes.
              </p>
            </div>
          </div>
        )}

        {/* Linear issue info */}
        <p className="text-xs text-cc-muted mb-3">
          This session is linked to <strong className="text-cc-fg">{issueIdentifier}</strong>{" "}
          <span className="text-cc-muted">({issueStateName})</span>.
          What should happen to the issue?
        </p>

        {/* Radio group */}
        <fieldset className="space-y-2 mb-4">
          <legend className="sr-only">Linear issue transition choice</legend>

          <label className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-cc-border hover:bg-cc-hover/50 transition-colors cursor-pointer">
            <input
              type="radio"
              name="archive-linear-choice"
              value="none"
              checked={choice === "none"}
              onChange={() => setChoice("none")}
              className="accent-cc-primary"
            />
            <span className="text-xs text-cc-fg">Keep current status</span>
          </label>

          <label
            className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-cc-border transition-colors ${
              hasBacklogState
                ? "hover:bg-cc-hover/50 cursor-pointer"
                : "opacity-50 cursor-not-allowed"
            }`}
          >
            <input
              type="radio"
              name="archive-linear-choice"
              value="backlog"
              checked={choice === "backlog"}
              onChange={() => setChoice("backlog")}
              disabled={!hasBacklogState}
              className="accent-cc-primary"
            />
            <span className="text-xs text-cc-fg">Move to Backlog</span>
          </label>

          {archiveTransitionConfigured && archiveTransitionStateName && (
            <label className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-cc-border hover:bg-cc-hover/50 transition-colors cursor-pointer">
              <input
                type="radio"
                name="archive-linear-choice"
                value="configured"
                checked={choice === "configured"}
                onChange={() => setChoice("configured")}
                className="accent-cc-primary"
              />
              <span className="text-xs text-cc-fg">
                Move to {archiveTransitionStateName}
              </span>
            </label>
          )}
        </fieldset>

        {/* Footer */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(choice, isContainerized || undefined)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
          >
            Archive
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
