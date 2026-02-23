/**
 * MarkdownViewer — Enhanced Markdown renderer for the fullscreen workspace.
 *
 * Based on the MarkdownPreview in WorkspaceSection.tsx but scaled up for
 * fullscreen readability:
 * - Larger base font size (14px vs 12px)
 * - Centered content with max-width constraints
 * - Heading elements get slugified `id` attributes for anchor linking
 * - Extracts a table-of-contents (TocItem[]) via `onTocExtracted` callback
 * - IntersectionObserver tracks the topmost visible heading and reports it
 *   via `onActiveHeadingChange` for TOC highlight synchronization
 */
import {
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type RefObject,
  type ReactNode,
  type ComponentProps,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TocItem } from "./TableOfContents.js";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface MarkdownViewerProps {
  /** Raw Markdown string to render */
  content: string;
  /** Called after render with the collected heading items for a TOC */
  onTocExtracted: (items: TocItem[]) => void;
  /** Called when the topmost visible heading changes (or null when none) */
  onActiveHeadingChange: (id: string | null) => void;
  /** Ref to the scrollable container wrapping this component (IO root) */
  viewerRef: RefObject<HTMLDivElement | null>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert text into a URL-friendly slug.
 * Lowercase, strip non-word chars (except spaces/hyphens), collapse whitespace
 * to single hyphens, trim leading/trailing hyphens.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Recursively extract plain text from React children.
 * Handles strings, numbers, arrays, and elements with nested children.
 */
function extractText(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (typeof children === "object" && "props" in children) {
    return extractText(
      (children as { props: { children?: ReactNode } }).props.children,
    );
  }
  return "";
}

/**
 * Extract TOC items directly from the raw Markdown string.
 *
 * This is a pure function — no React render side-effects — so it is safe
 * under React StrictMode (which double-invokes render functions).
 * Skips headings inside fenced code blocks.
 */
function extractTocFromMarkdown(content: string): TocItem[] {
  const items: TocItem[] = [];
  const usedSlugs = new Map<string, number>();
  const lines = content.split("\n");
  let inCodeFence = false;

  for (const line of lines) {
    // Track fenced code block boundaries (``` or ~~~)
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!match) continue;

    const level = match[1].length;
    // Strip common inline Markdown formatting for clean display text
    const text = match[2]
      .trim()
      .replace(/\*\*(.+?)\*\*/g, "$1") // bold
      .replace(/\*(.+?)\*/g, "$1") // italic
      .replace(/__(.+?)__/g, "$1") // bold (underscore)
      .replace(/_(.+?)_/g, "$1") // italic (underscore)
      .replace(/`(.+?)`/g, "$1") // inline code
      .replace(/\[(.+?)\]\(.+?\)/g, "$1"); // links

    const base = slugify(text);
    const count = usedSlugs.get(base);
    let id: string;
    if (count === undefined) {
      usedSlugs.set(base, 0);
      id = base;
    } else {
      const next = count + 1;
      usedSlugs.set(base, next);
      id = `${base}-${next}`;
    }

    items.push({ id, text, level });
  }

  return items;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function MarkdownViewer({
  content,
  onTocExtracted,
  onActiveHeadingChange,
  viewerRef,
}: MarkdownViewerProps) {
  // ── TOC extraction (pure, no render side-effects) ─────────────────────────
  // Extract TOC from the raw Markdown string so it is immune to React
  // StrictMode double-invocation of render functions (which was causing
  // each TOC item to appear twice when collected via refs during render).
  const tocItems = useMemo(() => extractTocFromMarkdown(content), [content]);

  useEffect(() => {
    onTocExtracted(tocItems);
  }, [tocItems, onTocExtracted]);

  // Track used slugs per render for heading ID generation.
  // Reset via useMemo so it stays consistent with the content.
  const usedSlugsRef = useRef<Map<string, number>>(new Map());
  usedSlugsRef.current = new Map();

  /**
   * Generate a unique slug for a heading. If the base slug has already been
   * used in this render, append `-1`, `-2`, etc.
   */
  const getUniqueSlug = useCallback((text: string): string => {
    const base = slugify(text);
    const used = usedSlugsRef.current;
    const count = used.get(base);
    if (count === undefined) {
      used.set(base, 0);
      return base;
    }
    const next = count + 1;
    used.set(base, next);
    return `${base}-${next}`;
  }, []);

  /**
   * Factory that creates a heading component for a given level (1-6).
   * Each heading extracts plain text, generates a unique slugified id,
   * and renders with that id for anchor jumping.
   */
  const makeHeading = useCallback(
    (level: number) => {
      const sizeClasses: Record<number, string> = {
        1: "text-2xl font-bold mt-8 mb-4",
        2: "text-xl font-bold mt-6 mb-3",
        3: "text-lg font-semibold mt-5 mb-2",
        4: "text-base font-semibold mt-4 mb-2",
        5: "text-sm font-semibold mt-3 mb-1.5",
        6: "text-sm font-medium mt-3 mb-1.5",
      };

      return function HeadingComponent({
        children,
      }: {
        children?: ReactNode;
      }) {
        const text = extractText(children);
        const id = getUniqueSlug(text);

        const cls = `text-cc-fg scroll-mt-4 ${sizeClasses[level] || sizeClasses[6]}`;
        switch (level) {
          case 1: return <h1 id={id} className={cls}>{children}</h1>;
          case 2: return <h2 id={id} className={cls}>{children}</h2>;
          case 3: return <h3 id={id} className={cls}>{children}</h3>;
          case 4: return <h4 id={id} className={cls}>{children}</h4>;
          case 5: return <h5 id={id} className={cls}>{children}</h5>;
          default: return <h6 id={id} className={cls}>{children}</h6>;
        }
      };
    },
    [getUniqueSlug],
  );

  // ── IntersectionObserver for active heading tracking ──────────────────────

  useEffect(() => {
    const root = viewerRef.current;
    if (!root) return;

    // Find all heading elements with an id inside the root
    const headings = root.querySelectorAll<HTMLElement>(
      "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]",
    );
    if (headings.length === 0) return;

    // Track which headings are currently intersecting
    const visibleIds = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) {
            visibleIds.add(id);
          } else {
            visibleIds.delete(id);
          }
        }

        // Find the topmost visible heading by DOM order
        let topmost: string | null = null;
        for (const h of headings) {
          if (visibleIds.has(h.id)) {
            topmost = h.id;
            break;
          }
        }
        onActiveHeadingChange(topmost);
      },
      {
        root,
        // Trigger when heading enters the top 20% of the viewport
        rootMargin: "0px 0px -80% 0px",
        threshold: 0,
      },
    );

    for (const h of headings) {
      observer.observe(h);
    }

    return () => {
      observer.disconnect();
    };
  }, [content, viewerRef, onActiveHeadingChange]);

  // ── Markdown component overrides ─────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto px-8 py-6">
      <div className="markdown-body text-[14px] text-cc-fg leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            // ── Paragraphs ──
            p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,

            // ── Inline ──
            strong: ({ children }) => (
              <strong className="font-semibold text-cc-fg">{children}</strong>
            ),
            em: ({ children }) => <em className="italic">{children}</em>,

            // ── Headings (with id + TOC collection) ──
            h1: makeHeading(1),
            h2: makeHeading(2),
            h3: makeHeading(3),
            h4: makeHeading(4),
            h5: makeHeading(5),
            h6: makeHeading(6),

            // ── Lists ──
            ul: ({ children }) => (
              <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>
            ),
            li: ({ children }) => <li className="text-cc-fg">{children}</li>,

            // ── Links ──
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cc-primary hover:underline"
              >
                {children}
              </a>
            ),

            // ── Blockquotes ──
            blockquote: ({ children }) => (
              <blockquote className="border-l-3 border-cc-primary/30 pl-4 my-3 text-cc-muted italic">
                {children}
              </blockquote>
            ),

            // ── Horizontal rule ──
            hr: () => <hr className="border-cc-border my-6" />,

            // ── Code (inline + block) ──
            code: (props: ComponentProps<"code">) => {
              const { children, className } = props;
              const match = /language-(\w+)/.exec(className || "");
              const isBlock =
                match ||
                (typeof children === "string" && children.includes("\n"));

              if (isBlock) {
                const lang = match?.[1] || "";
                return (
                  <div className="my-3 rounded-lg overflow-hidden border border-cc-border">
                    {lang && (
                      <div className="px-3 py-1.5 bg-cc-code-bg/80 border-b border-cc-border text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">
                        {lang}
                      </div>
                    )}
                    <pre className="px-3 py-2 bg-cc-code-bg text-cc-code-fg text-[13px] font-mono-code leading-relaxed overflow-x-auto">
                      <code>{children}</code>
                    </pre>
                  </div>
                );
              }
              return (
                <code className="px-1.5 py-0.5 rounded-md bg-cc-fg/[0.06] text-[13px] font-mono-code text-cc-fg/80">
                  {children}
                </code>
              );
            },
            pre: ({ children }) => <>{children}</>,

            // ── Tables ──
            table: ({ children }) => (
              <div className="overflow-x-auto my-3">
                <table className="min-w-full text-[13px] border border-cc-border rounded-lg overflow-hidden">
                  {children}
                </table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-cc-code-bg/50">{children}</thead>
            ),
            th: ({ children }) => (
              <th className="px-3 py-1.5 text-left text-xs font-semibold text-cc-fg border-b border-cc-border">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-1.5 text-[13px] text-cc-fg border-b border-cc-border">
                {children}
              </td>
            ),

            // ── Images ──
            img: ({ src, alt }) => (
              <img
                src={src}
                alt={alt || ""}
                className="max-w-full h-auto rounded my-3"
              />
            ),
          }}
        >
          {content}
        </Markdown>
      </div>
    </div>
  );
}
