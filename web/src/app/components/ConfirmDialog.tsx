/**
 * ConfirmDialog — an accessible confirmation modal built on the native
 * <dialog> element, which gives us focus trapping, Escape-to-close, and the
 * backdrop for free. Used to gate destructive/irreversible actions (delete an
 * agent, apply a plan).
 *
 * The dialog is rendered only when `open` so its mount/unmount drives the modal
 * lifecycle; the confirm button can show a pending state while the action runs.
 */

import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { Button, type ButtonVariant } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** Body content explaining the consequence of confirming. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Visual tone of the confirm button (danger for destructive actions). */
  confirmVariant?: ButtonVariant;
  /** Shows a spinner on confirm and blocks re-clicks while the action runs. */
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "primary",
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  // Open/close the native dialog in step with the `open` prop. showModal()
  // provides the focus trap + inert background; close() restores focus.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={children ? descId : undefined}
      // Native <dialog> handles Escape via the "cancel" event.
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onCancel();
      }}
      // Clicking the ::backdrop reports the dialog itself as the target.
      onClick={(e) => {
        if (e.target === ref.current && !pending) onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-md border border-line bg-surface p-0 text-fg shadow-xl backdrop:bg-black/50"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {children != null && (
          <div id={descId} className="mt-2 text-sm text-muted">
            {children}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
