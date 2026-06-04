/**
 * Button — the single button primitive for the console.
 *
 * Variants: primary (accent), secondary (surface), ghost (bare), danger
 * (destructive). A `loading` flag shows an inline spinner and disables
 * interaction without removing the button from the tab order's intent (it sets
 * `aria-busy`). Focus-visible rings come from the global stylesheet.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When true, shows a spinner and marks the button busy + disabled. */
  loading?: boolean;
  children: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-muted focus-visible:outline-accent",
  secondary:
    "border border-line bg-surface-raised text-fg hover:border-line-strong hover:bg-surface",
  ghost: "text-muted hover:bg-surface-raised hover:text-fg",
  danger: "bg-danger text-white hover:opacity-90 focus-visible:outline-danger",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {loading && <Spinner className="size-4" label="Working" />}
      {children}
    </button>
  );
}
