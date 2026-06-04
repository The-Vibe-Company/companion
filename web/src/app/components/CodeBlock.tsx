/**
 * CodeBlock — a monospace, scrollable block for preformatted output (plan text,
 * log lines, soul previews). Preserves whitespace and offers an optional
 * accessible label. It is read-only display, never an editor.
 */

import type { ReactNode } from "react";

export interface CodeBlockProps {
  /** Raw text to render. Newlines are preserved. */
  children: ReactNode;
  /** Accessible label for the scroll region (announced as a group). */
  ariaLabel?: string;
  /** Caps the height and enables vertical scroll. Defaults to true. */
  scroll?: boolean;
  className?: string;
}

export function CodeBlock({
  children,
  ariaLabel,
  scroll = true,
  className = "",
}: CodeBlockProps) {
  return (
    <pre
      // A labelled, focusable group lets keyboard users scroll long output.
      aria-label={ariaLabel}
      role={ariaLabel ? "group" : undefined}
      tabIndex={scroll ? 0 : undefined}
      className={
        "overflow-x-auto rounded-md border border-line bg-canvas p-3 " +
        "font-mono text-xs leading-relaxed whitespace-pre text-muted " +
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
        (scroll ? "max-h-80 overflow-y-auto " : "") +
        className
      }
    >
      {children}
    </pre>
  );
}
