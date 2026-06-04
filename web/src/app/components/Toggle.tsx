/**
 * Toggle — an accessible on/off switch backed by a real checkbox input.
 *
 * Using a visually-hidden native checkbox (peer) keeps keyboard toggling (space)
 * and screen-reader semantics correct for free, while the styled track/thumb is
 * purely presentational. The label is always associated to the control.
 */

import type { ReactNode } from "react";
import { useId } from "react";

export interface ToggleProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
  className = "",
}: ToggleProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`flex items-start gap-3 ${className}`}>
      <span className="relative inline-flex shrink-0 pt-0.5">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={
            "h-5 w-9 rounded-full border border-line bg-surface-raised transition-colors " +
            "peer-checked:border-accent peer-checked:bg-accent " +
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent " +
            "peer-disabled:opacity-50"
          }
        />
        <span
          aria-hidden="true"
          className={
            "pointer-events-none absolute left-0.5 top-[3px] size-4 rounded-full bg-fg shadow-sm transition-transform " +
            "peer-checked:translate-x-4"
          }
        />
      </span>
      <span className="flex flex-col">
        <label htmlFor={id} className="text-sm text-fg select-none">
          {label}
        </label>
        {hint && (
          <span id={hintId} className="text-xs text-faint">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}
