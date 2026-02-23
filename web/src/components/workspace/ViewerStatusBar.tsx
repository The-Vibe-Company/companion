/**
 * ViewerStatusBar -- bottom status bar for the fullscreen workspace document viewer.
 *
 * Shows word count (with CJK-aware counting), line count, and encoded file size.
 * All stats are memoised so they only recompute when `content` changes.
 */
import { useMemo } from "react";

export interface ViewerStatusBarProps {
  content: string | null;
  filePath: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** CJK Unified Ideographs + Extension A + Compatibility Ideographs */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/** Format byte count as human-readable B / KB / MB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Count "words" in text with CJK awareness. */
function countWords(text: string): number {
  // Count CJK characters (each is one "word")
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remove CJK chars, then split remaining by whitespace
  const withoutCjk = text.replace(CJK_RE, "");
  const latinWords = withoutCjk.split(/\s+/).filter((w) => w.length > 0);

  return latinWords.length + cjkCount;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerStatusBar({ content, filePath }: ViewerStatusBarProps) {
  const stats = useMemo(() => {
    if (!content || !filePath) return null;

    const words = countWords(content);
    const lines = content.split("\n").length;
    const sizeBytes = new TextEncoder().encode(content).length;

    return { words, lines, sizeBytes };
  }, [content, filePath]);

  return (
    <div className="h-7 flex items-center px-3 border-t border-cc-border bg-cc-card text-[11px] text-cc-muted">
      {stats && (
        <div className="flex items-center gap-4">
          <span>Words: {stats.words.toLocaleString()}</span>
          <span className="text-cc-border">|</span>
          <span>Lines: {stats.lines.toLocaleString()}</span>
          <span className="text-cc-border">|</span>
          <span>Size: {formatBytes(stats.sizeBytes)}</span>
        </div>
      )}
    </div>
  );
}
