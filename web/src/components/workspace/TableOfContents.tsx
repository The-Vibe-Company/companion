import { useMemo } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TocItem {
  id: string;
  text: string;
  level: number; // 1-6
}

interface TableOfContentsProps {
  items: TocItem[];
  activeId: string | null;
  onItemClick: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

// ─── Inline SVG icons ───────────────────────────────────────────────────────

/** Right-pointing chevron (collapsed state indicator / expand button) */
function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.47 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 1 1-1.06-1.06L9.19 8 6.47 5.28a.75.75 0 0 1 0-1.06z" />
    </svg>
  );
}

/** Left-pointing chevron (collapse button when expanded) */
function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M9.53 11.78a.75.75 0 0 1-1.06 0L5.22 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 1 1 1.06 1.06L6.81 8l2.72 2.72a.75.75 0 0 1 0 1.06z" />
    </svg>
  );
}

/** List/outline icon shown in collapsed strip */
function ListIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 4h10M3 8h10M3 12h10" strokeLinecap="round" />
    </svg>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TableOfContents({
  items,
  activeId,
  onItemClick,
  collapsed,
  onToggleCollapse,
}: TableOfContentsProps) {
  // Compute the minimum heading level so indentation is normalized
  // (e.g. if the doc starts at h2, that gets 0 indent).
  const minLevel = useMemo(() => {
    if (items.length === 0) return 1;
    return Math.min(...items.map((i) => i.level));
  }, [items]);

  // ── Collapsed strip ──────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <nav
        aria-label="Table of contents"
        className="w-10 flex flex-col items-center py-3 gap-2 border-l border-cc-border bg-cc-bg shrink-0"
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          className="p-1.5 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover/50 transition-colors"
          aria-label="Expand table of contents"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
        <ListIcon className="w-4 h-4 text-cc-muted" />
      </nav>
    );
  }

  // ── Expanded view ────────────────────────────────────────────────────────
  return (
    <nav
      aria-label="Table of contents"
      className="w-[200px] flex flex-col border-l border-cc-border bg-cc-bg shrink-0 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cc-border">
        <span className="text-xs font-medium text-cc-muted uppercase tracking-wide">
          Outline
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="p-1 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover/50 transition-colors"
          aria-label="Collapse table of contents"
        >
          <ChevronRightIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Items list */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {items.length === 0 ? (
          <p className="text-xs text-cc-muted text-center py-6 px-3">
            No headings found
          </p>
        ) : (
          <ul className="flex flex-col">
            {items.map((item) => {
              const isActive = item.id === activeId;
              const indent = (item.level - minLevel) * 12;

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onItemClick(item.id)}
                    className={`w-full text-left text-xs py-1 px-3 truncate transition-colors ${
                      isActive
                        ? "text-cc-primary bg-cc-primary/10 font-medium"
                        : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover/50"
                    }`}
                    style={{ paddingLeft: `${12 + indent}px` }}
                    title={item.text}
                  >
                    {item.text}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
