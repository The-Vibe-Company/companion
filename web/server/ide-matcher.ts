import path from "node:path";

/**
 * A single IDE lockfile candidate considered by the matcher.
 *
 * Populated by `ide-discovery` from `~/.claude/ide/*.lock` contents plus a
 * `fs.stat` on the lockfile itself (for `lockfileMtime`).
 */
export interface IdeCandidate {
  /** TCP port the IDE's MCP endpoint listens on. */
  port: number;
  /** Human-readable IDE name (e.g. "Neovim", "Visual Studio Code"). */
  ideName: string;
  /** Workspace folders the IDE has open; may be multi-root. */
  workspaceFolders: string[];
  /** MCP transport advertised by the lockfile. */
  transport: "ws-ide" | "sse-ide";
  /** Absolute path to the lockfile (used for diagnostics / dedup). */
  lockfilePath: string;
  /** Epoch ms; caller supplies from fs.stat. Used as tiebreak. */
  lockfileMtime: number;
}

/**
 * Returns true iff `child` is equal to `parent` or sits inside it on a path
 * segment boundary. Uses path.relative so partial-folder-name false matches
 * (e.g. "/a/rep" vs "/a/repo/x") are correctly rejected: the relative path
 * from "/a/rep" to "/a/repo/x" is "../repo/x", which begins with the
 * ".." segment proper (".." followed by the path separator).
 *
 * DEFECT-GUARD: we must NOT reject on `rel.startsWith("..")` alone, because a
 * legitimate descendant whose basename starts with ".." (e.g. "..cache") also
 * yields a rel that starts with ".." — but it is a single SEGMENT, not the
 * parent-directory token. Check for ".." strictly: equal to ".." or followed
 * by the platform path separator.
 */
function isPathPrefix(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const rel = path.relative(p, c);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(".." + path.sep)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * For a given candidate, return the length (in characters, using the resolved
 * absolute form) of the LONGEST of its `workspaceFolders` that is a path-prefix
 * of `cwd`. Zero means no folder matched.
 *
 * We use character length of the resolved path rather than segment count
 * because it is stable, cheap, and correctly orders nested folders.
 */
function longestMatchLength(cwd: string, workspaceFolders: string[]): number {
  const resolvedCwd = path.resolve(cwd);
  let best = 0;
  for (const folder of workspaceFolders) {
    if (!folder) continue;
    const resolved = path.resolve(folder);
    if (isPathPrefix(resolved, resolvedCwd)) {
      if (resolved.length > best) best = resolved.length;
    }
  }
  return best;
}

/**
 * Rank IDE candidates by match quality against `cwd`. See module docstring in
 * ide-matcher.test.ts for the rules.
 *
 * Stable, pure, does no I/O.
 */
export function matchIdesForCwd(cwd: string, candidates: IdeCandidate[]): IdeCandidate[] {
  type Scored = { candidate: IdeCandidate; matchLen: number };
  const scored: Scored[] = candidates.map((candidate) => ({
    candidate,
    matchLen: longestMatchLength(cwd, candidate.workspaceFolders),
  }));

  scored.sort((a, b) => {
    // Matched > unmatched.
    const aMatched = a.matchLen > 0 ? 1 : 0;
    const bMatched = b.matchLen > 0 ? 1 : 0;
    if (aMatched !== bMatched) return bMatched - aMatched;

    // Among matched: longer prefix first.
    if (a.matchLen !== b.matchLen) return b.matchLen - a.matchLen;

    // Tiebreak (applies to both matched-equal-length and unmatched-unmatched):
    // newer mtime first.
    return b.candidate.lockfileMtime - a.candidate.lockfileMtime;
  });

  return scored.map((s) => s.candidate);
}
