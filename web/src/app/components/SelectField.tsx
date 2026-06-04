/**
 * SelectField — a labelled native <select>.
 *
 * Native select keeps keyboard and screen-reader behavior correct for free.
 * Options are passed as `{ value, label }`; the label defaults to the value.
 */

import type { ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";

export interface SelectOption {
  value: string;
  label?: string;
}

export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: ReactNode;
  options: SelectOption[];
  hint?: ReactNode;
  error?: string | null;
}

export function SelectField({
  label,
  options,
  hint,
  error,
  className = "",
  required,
  ...rest
}: SelectFieldProps) {
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
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "h-9 rounded-md border bg-canvas px-3 text-sm text-fg " +
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
          (error ? "border-danger" : "border-line")
        }
        {...rest}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label ?? opt.value}
          </option>
        ))}
      </select>
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
