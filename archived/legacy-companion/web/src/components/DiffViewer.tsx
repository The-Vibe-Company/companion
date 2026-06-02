import { useMemo } from "react";
import * as Diff from "diff";

export interface DiffViewerProps {
  /** Original text (for computing diff from old/new) */
  oldText?: string;
  /** New text (for computing diff from old/new) */
  newText?: string;
  /** Pre-computed unified diff string (e.g. from git diff) */
  unifiedDiff?: string;
  /** File name/path for the header */
  fileName?: string;
  /** compact = inline in chat (capped height, no line numbers), full = panel (scrollable, line numbers) */
  mode?: "compact" | "full";
}

interface DiffLine {
  type: "add" | "del" | "context" | "hunk";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
  /** Word-level changes for highlighted rendering */
  wordChanges?: { value: string; added?: boolean; removed?: boolean }[];
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

function parsePatchToHunks(oldText: string, newText: string): DiffHunk[] {
  const patch = Diff.structuredPatch("", "", oldText, newText, "", "", { context: 3 });
  return patch.hunks.map((hunk) => {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    const lines: DiffLine[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const raw of hunk.lines) {
      const prefix = raw[0];
      const content = raw.slice(1);
      if (prefix === "-") {
        lines.push({ type: "del", content, oldLineNo: oldLine++ });
      } else if (prefix === "+") {
        lines.push({ type: "add", content, newLineNo: newLine++ });
      } else {
        lines.push({ type: "context", content, oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }

    // Compute word-level diffs for adjacent del/add pairs
    addWordHighlights(lines);

    return { header, lines };
  });
}

function parseUnifiedDiffToHunks(diffStr: string): { fileName: string; hunks: DiffHunk[] }[] {
  const files: { fileName: string; hunks: DiffHunk[] }[] = [];
  const diffLines = diffStr.split("\n");
  let currentFile: { fileName: string; hunks: DiffHunk[] } | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffLines) {
    if (line.startsWith("diff --git") || line.startsWith("diff --cc")) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      if (currentFile) files.push(currentFile);
      currentFile = { fileName: "", hunks: [] };
      currentHunk = null;
      continue;
    }
    if (line.startsWith("--- a/") || line.startsWith("--- /dev/null")) {
      continue;
    }
    if (line.startsWith("+++ b/")) {
      if (currentFile) currentFile.fileName = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("rename from") || line.startsWith("rename to") || line.startsWith("similarity index") || line.startsWith("Binary files")) {
      continue;
    }

    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunkMatch) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk = { header: line, lines: [] };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1), newLineNo: newLine++ });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", content: line.slice(1), oldLineNo: oldLine++ });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    } else if (line === "\\ No newline at end of file") {
      // skip
    }
  }

  if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
  if (currentFile) files.push(currentFile);

  // Add word highlights
  for (const file of files) {
    for (const hunk of file.hunks) {
      addWordHighlights(hunk.lines);
    }
  }

  return files;
}

/** Add word-level diff highlights to adjacent del/add line pairs */
function addWordHighlights(lines: DiffLine[]) {
  let i = 0;
  while (i < lines.length) {
    // Find consecutive del lines
    const delStart = i;
    while (i < lines.length && lines[i].type === "del") i++;
    const delEnd = i;

    // Find consecutive add lines
    const addStart = i;
    while (i < lines.length && lines[i].type === "add") i++;
    const addEnd = i;

    // If we have matching del/add pairs, compute word diff
    const delCount = delEnd - delStart;
    const addCount = addEnd - addStart;
    if (delCount > 0 && addCount > 0) {
      const pairCount = Math.min(delCount, addCount);
      for (let j = 0; j < pairCount; j++) {
        const delLine = lines[delStart + j];
        const addLine = lines[addStart + j];
        const wordDiff = Diff.diffWords(delLine.content, addLine.content);

        delLine.wordChanges = wordDiff
          .filter((part) => !part.added)
          .map((part) => ({ value: part.value, removed: part.removed }));
        addLine.wordChanges = wordDiff
          .filter((part) => !part.removed)
          .map((part) => ({ value: part.value, added: part.added }));
      }
    }

    // If we didn't move forward, advance
    if (i === delStart) i++;
  }
}

function LineContent({ line }: { line: DiffLine }) {
  if (line.wordChanges) {
    return (
      <>
        {line.wordChanges.map((part, i) => {
          if (part.added) {
            return <span key={i} className="diff-word-add">{part.value}</span>;
          }
          if (part.removed) {
            return <span key={i} className="diff-word-del">{part.value}</span>;
          }
          return <span key={i}>{part.value}</span>;
        })}
      </>
    );
  }
  return <>{line.content}</>;
}

function HunkBlock({ hunk, showLineNumbers }: { hunk: DiffHunk; showLineNumbers: boolean }) {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{hunk.header}</div>
      {hunk.lines.map((line, i) => (
        <div key={i} className={`diff-line diff-line-${line.type}`}>
          {showLineNumbers && (
            <>
              <span className="diff-gutter diff-gutter-old">
                {line.oldLineNo ?? ""}
              </span>
              <span className="diff-gutter diff-gutter-new">
                {line.newLineNo ?? ""}
              </span>
            </>
          )}
          <span className="diff-marker">
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          <span className="diff-content">
            <LineContent line={line} />
            {!line.content && "\u00A0"}
          </span>
        </div>
      ))}
    </div>
  );
}

function FileHeader({ fileName }: { fileName: string }) {
  const parts = fileName.split("/");
  const base = parts.pop() || fileName;
  const dir = parts.join("/");
  return (
    <div className="diff-file-header">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary shrink-0">
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <polyline points="9 1 9 5 13 5" />
      </svg>
      {dir && <span className="text-cc-muted">{dir}/</span>}
      <span className="font-semibold text-cc-fg">{base}</span>
    </div>
  );
}

export function DiffViewer({ oldText, newText, unifiedDiff, fileName, mode = "compact" }: DiffViewerProps) {
  const isCompact = mode === "compact";
  const showLineNumbers = !isCompact;

  const data = useMemo(() => {
    // Case 1: unified diff string provided (from git diff)
    if (unifiedDiff) {
      return parseUnifiedDiffToHunks(unifiedDiff);
    }

    // Case 2: compute diff from old/new text
    const old = oldText ?? "";
    const neu = newText ?? "";
    if (!old && !neu) return [];

    const hunks = parsePatchToHunks(old, neu);
    return [{ fileName: fileName || "", hunks }];
  }, [oldText, newText, unifiedDiff, fileName]);

  // Nothing to show
  if (data.length === 0 || data.every((f) => f.hunks.length === 0)) {
    return (
      <div className="diff-viewer diff-empty">
        <span className="text-cc-muted text-xs">No changes</span>
      </div>
    );
  }

  return (
    <div className={`diff-viewer ${isCompact ? "diff-compact" : "diff-full"}`}>
      {data.map((file, fi) => (
        <div key={fi} className="diff-file">
          {(file.fileName || fileName) && (
            <FileHeader fileName={file.fileName || fileName || ""} />
          )}
          {file.hunks.map((hunk, hi) => (
            <HunkBlock key={hi} hunk={hunk} showLineNumbers={showLineNumbers} />
          ))}
        </div>
      ))}
    </div>
  );
}
