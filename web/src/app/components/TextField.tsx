/**
 * TextField — a labelled text/number input.
 *
 * Always renders a real <label> associated to the control by id, an optional
 * hint, and an optional error message wired via aria-describedby +
 * aria-invalid. This is the single text-input primitive used by AgentForm and
 * the settings views.
 */

import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: ReactNode;
  /** Helper text rendered under the field. */
  hint?: ReactNode;
  /** Error message; sets aria-invalid and is announced to AT. */
  error?: string | null;
  /** Monospace the input value (ids, hostnames, app names). */
  mono?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  mono = false,
  className = "",
  required,
  ...rest
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <span className="flex items-center gap-1">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
        </label>
        {required && (
          <span className="text-danger" aria-hidden="true">
            *
          </span>
        )}
      </span>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "h-9 rounded-md border bg-canvas px-3 text-sm text-fg placeholder:text-faint " +
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
          (error ? "border-danger " : "border-line ") +
          (mono ? "font-mono " : "")
        }
        {...rest}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
