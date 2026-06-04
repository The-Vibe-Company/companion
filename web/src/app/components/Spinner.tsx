/**
 * Spinner — an accessible, reduced-motion-aware loading indicator.
 *
 * Renders an SVG ring with `role="status"` and a visually hidden label so
 * screen readers announce the loading state. The CSS `animate-spin` utility is
 * neutralized by the global prefers-reduced-motion rule in index.css.
 */

export interface SpinnerProps {
  /** Accessible label announced to assistive tech. Defaults to "Loading". */
  label?: string;
  /** Tailwind size class for the ring (defaults to a small 1rem ring). */
  className?: string;
}

export function Spinner({ label = "Loading", className = "size-4" }: SpinnerProps) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <svg
        className={`${className} animate-spin text-current`}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          className="opacity-90"
          d="M12 2a10 10 0 0 1 10 10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
