/**
 * ErrorBanner — a dismissible, assertive error region.
 *
 * Accepts either an Error or a string. Uses `role="alert"` so screen readers
 * announce failures (failed loads, rejected mutations) immediately. An optional
 * retry action is rendered inline for recoverable errors.
 */

import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ErrorBannerProps {
  /** The error to display. A ConsoleError's message is shown verbatim. */
  error: unknown;
  /** Optional prefix, e.g. "Could not load agents". */
  title?: ReactNode;
  /** Optional retry handler; renders a "Retry" button when provided. */
  onRetry?: () => void;
  className?: string;
}

function messageOf(error: unknown): string {
  if (error == null) return "An unknown error occurred.";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ErrorBanner({
  error,
  title,
  onRetry,
  className = "",
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 ${className}`}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-danger/20 text-xs font-bold text-danger"
      >
        !
      </span>
      <div className="min-w-0 flex-1">
        {title != null && (
          <p className="text-sm font-medium text-fg">{title}</p>
        )}
        <p className="text-xs break-words text-danger">{messageOf(error)}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
