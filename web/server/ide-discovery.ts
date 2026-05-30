// ide-discovery.ts — Watches ~/.claude/ide/ for IDE lockfiles.
//
// Responsibilities (DISC-01, DISC-02, DISC-03):
//   - Initial scan + `fs.watch` for add/modify/delete of `*.lock` files.
//   - Parse each lockfile, prune those with a non-alive PID.
//   - Emit typed events on `companionBus`: ide:added, ide:changed, ide:removed.
//   - Low-frequency rescan (10s) catches PID-death that fs.watch never notifies
//     us about.
//   - Tolerate a missing ideDir (the Claude CLI creates it lazily).
//   - Tolerate malformed lockfile JSON (skip silently; watcher stays alive).
//
// `authToken` is kept in memory only; never persisted. Callers that need
// it (ws-bridge bind path) snapshot it out of `listAvailableIdes()` at
// bind time.
//
// This module is a singleton — `startIdeDiscovery()` enforces one active
// watcher at a time. `resetIdeDiscoveryForTests()` clears internal state
// for test isolation.

import {
  readdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { companionBus } from "./event-bus.js";
import { parseLockfile, isPidAlive } from "../../scripts/probe-ide.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface DiscoveredIde {
  port: number;
  ideName: string;
  workspaceFolders: string[];
  transport: "ws-ide" | "sse-ide";
  lockfilePath: string;
  lockfileMtime: number;
  /** Runtime-only; never persisted. */
  authToken?: string;
}

export interface StartIdeDiscoveryOptions {
  /** Override the directory to watch. Defaults to `~/.claude/ide`. */
  ideDir?: string;
}

// ─── Internal state ─────────────────────────────────────────────────────────

let currentWatcher: FSWatcher | null = null;
let currentRescanTimer: ReturnType<typeof setInterval> | null = null;
let currentIdeDir: string | null = null;
let stopped = false;
/**
 * Monotonic generation counter bumped at the start of every scan. Each scan
 * captures its generation at entry; after each `await` and before any mutation
 * of `known` or emit, it checks whether it is still the latest. A scan whose
 * generation is stale (a newer scan has started or completed) aborts without
 * mutating state — this prevents a retry-delayed scan from evicting lockfiles
 * that a fresher scan already added. Codex adversarial review, issue #4.
 */
let scanGeneration = 0;
/** Map keyed by lockfile path. */
const known = new Map<string, DiscoveredIde>();
/** Count of malformed/skipped lockfile reads — diagnostic only. */
let skippedCount = 0;

/**
 * Consecutive `readdirSync` failures for the current ideDir (DISC-06 /
 * FIX 2). A single transient failure (EBUSY, momentary EACCES) preserves
 * `known`; after `READDIR_FAILURE_THRESHOLD` consecutive failures we
 * assume the directory is persistently unreachable and evict stale
 * entries via `reconcileKnown(new Map())`. Resets to 0 on any successful
 * readdirSync.
 */
let readdirFailureStreak = 0;
const READDIR_FAILURE_THRESHOLD = 3;

/**
 * Per-path counter of consecutive `transient` reads while the path is in
 * `known`. Bounds the carry-forward introduced by FIX 1 (DISC-05) so an
 * IDE that silently rewrote its lockfile with new credentials (authToken,
 * port) cannot have stale credentials served forever if every subsequent
 * read transiently fails.
 *
 * Semantics:
 *   - Incremented on each `transient` read for a path that is currently in
 *     `known`. When the count reaches `MAX_CONSECUTIVE_TRANSIENT_READS`, the
 *     path is NOT carried forward; reconcile will emit `ide:removed` as if
 *     the file had gone missing.
 *   - Cleared on any `ok` read OR on a `missing` classification for the
 *     same path.
 *   - Cleared when reconcile evicts the path.
 */
const transientCounts = new Map<string, number>();
const MAX_CONSECUTIVE_TRANSIENT_READS = 5;

/** Rescan period for dead-PID pruning. */
const RESCAN_INTERVAL_MS = 10_000;
/** How long to retry a partial file read (fs.watch may fire mid-write). */
const READ_RETRY_BACKOFF_MS = [10, 30, 80];

/**
 * Test-only hook that, when installed, replaces the per-attempt retry sleep
 * inside `readLockfileWithRetry`. The hook receives the attempt index (0-based)
 * and the currently-scheduled wait duration, and must return a Promise that
 * resolves when the caller should re-attempt. Lets tests deterministically
 * pause a scan mid-retry and interleave other scans with no wall-clock
 * dependence (Issue #4 stale-scan race regression test). Null = real
 * setTimeout sleep.
 */
let __retrySleepHookForTests:
  | ((attempt: number, waitMs: number) => Promise<void>)
  | null = null;

/**
 * Outcome of attempting to read + parse a lockfile (DISC-05 / FIX 1).
 *
 * - `ok`: read + parse succeeded. Use the payload as the source of truth.
 * - `missing`: the file is gone (statSync threw ENOENT). The caller
 *   should let reconcileKnown emit `ide:removed` for any prior entry.
 * - `transient`: the file EXISTS on disk but we couldn't read or parse it
 *   (EBUSY from a concurrent writer, partial write that never resolved
 *   within the retry budget). Callers must NOT evict a previously-known
 *   entry for this path — carry it forward and let the next clean scan
 *   refresh it. Evicting on transient failure caused spurious ide:removed
 *   events → auto-unbind churn (see Round-4 PR #652 review).
 */
type ReadResult =
  | { kind: "ok"; parsed: NonNullable<ReturnType<typeof parseLockfile>>; mtime: number }
  | { kind: "missing" }
  | { kind: "transient" };

// ─── Utilities ──────────────────────────────────────────────────────────────

function derivePortAndTransport(
  lockfilePath: string,
  parsed: NonNullable<ReturnType<typeof parseLockfile>>,
): { port: number; transport: "ws-ide" | "sse-ide" } {
  // Codex round-7 P2: prefer the JSON-embedded `port` over the filename stem
  // (matches scripts/probe-ide.ts deriveBindShape). Neovim's claudecode.nvim
  // names lockfiles by PID (`<pid>.lock`), so the stem is the PID — not the
  // port. Without this preference, discovery surfaced PIDs as bind ports and
  // any subsequent bind produced an unreachable URL. JSON-port wins when
  // present and in valid TCP range; otherwise fall back to the stem (which
  // is correct for VS Code-style `<port>.lock` lockfiles).
  const stem = basename(lockfilePath).replace(/\.lock$/, "");
  const stemPort = Number(stem);
  const jsonPortRaw = (parsed.raw as Record<string, unknown>).port;
  const jsonPort = typeof jsonPortRaw === "number" ? jsonPortRaw : NaN;

  let port: number;
  if (Number.isInteger(jsonPort) && jsonPort > 0 && jsonPort < 65536) {
    port = jsonPort;
  } else if (Number.isFinite(jsonPort)) {
    // JSON had an explicit `port` but it is invalid (0, negative, > 65535).
    // Surface the invalid value so toDiscovered's range gate rejects it
    // rather than masking with a possibly-bogus stem fallback.
    port = jsonPort;
  } else {
    port = stemPort;
  }

  let transport: "ws-ide" | "sse-ide";
  if (parsed.useWebSocket === true || parsed.transport === "ws") {
    transport = "ws-ide";
  } else {
    transport = "sse-ide";
  }

  return { port, transport };
}

/**
 * Read + parse a lockfile with small retry backoff. fs.watch often fires
 * while the IDE is still writing the file; a naive read can see truncated
 * JSON and report "malformed" even though the file is healthy. We retry
 * 2–3 times on parse failure to smooth over that race.
 *
 * Returns null if the file is missing or genuinely malformed after retries.
 *
 * Async so the backoff yields to the Node event loop (timers, microtasks,
 * incoming WS frames all stay responsive). The previous sync busy-wait
 * blocked the loop for up to 120ms — see issue #4.
 */
async function readLockfileWithRetry(
  lockfilePath: string,
): Promise<ReadResult> {
  for (let attempt = 0; attempt <= READ_RETRY_BACKOFF_MS.length; attempt++) {
    let raw: string;
    let mtime: number;
    try {
      const st = statSync(lockfilePath);
      if (!st.isFile()) return { kind: "missing" };
      mtime = st.mtimeMs;
    } catch (err) {
      // ENOENT = genuinely gone; any other code = transient.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return { kind: "missing" };
      // statSync failed for another reason (EACCES, EBUSY): treat as
      // transient so callers carry forward any prior known entry.
      return { kind: "transient" };
    }
    try {
      raw = readFileSync(lockfilePath, "utf8");
    } catch (err) {
      // Vanished between stat and read → missing.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return { kind: "missing" };
      // Locked / busy / permission denied → transient. File still exists
      // on disk but we can't read it right now; preserve any prior entry.
      return { kind: "transient" };
    }
    const parsed = parseLockfile(raw);
    if (parsed) return { kind: "ok", parsed, mtime };
    // Parse failed — might be partial write. Retry via async sleep so the
    // event loop stays responsive.
    if (attempt < READ_RETRY_BACKOFF_MS.length) {
      const waitMs = READ_RETRY_BACKOFF_MS[attempt]!;
      if (__retrySleepHookForTests) {
        await __retrySleepHookForTests(attempt, waitMs);
      } else {
        await new Promise<void>((r) => setTimeout(r, waitMs));
      }
      continue;
    }
    // Parse failed every retry AND the file is still on disk — treat as
    // transient (likely corrupted mid-write or truly malformed). Preserve
    // prior entries rather than evicting on what might be a brief glitch.
    return { kind: "transient" };
  }
  return { kind: "transient" };
}

function toDiscovered(
  lockfilePath: string,
  parsed: NonNullable<ReturnType<typeof parseLockfile>>,
  mtime: number,
): DiscoveredIde | null {
  const { port, transport } = derivePortAndTransport(lockfilePath, parsed);
  // Codex round-7 P2: range-validate the final port (matches probe-ide.ts
  // isValidBindShape). Previously any finite number passed — out-of-range
  // ports (PID-shaped stems > 65535, JSON port 0, negatives) would reach
  // bindIde and produce invalid `ws://127.0.0.1:<bogus>` URLs.
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  return {
    port,
    ideName: parsed.ideName,
    workspaceFolders: parsed.workspaceFolders,
    transport,
    lockfilePath,
    lockfileMtime: mtime,
    authToken: parsed.authToken,
  };
}

function shallowArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Scanning ───────────────────────────────────────────────────────────────

/**
 * Scan the ideDir; add/update/remove entries in `known` and emit events
 * for every change. Tolerates a missing directory.
 *
 * Async because readLockfileWithRetry yields to the event loop during
 * partial-write backoff (issue #4). Callers that cannot await (fs.watch
 * listener, setInterval rescan timer) fire-and-forget — the function is
 * idempotent and logs/tolerates internal errors.
 *
 * Concurrency model (codex adversarial review, issue #4):
 * - Every scan captures its own `gen` at entry. A newer scan bumps
 *   `scanGeneration`, staling every scan that's still in progress.
 * - Builds a LOCAL snapshot (`nextKnown`) during the pass; only mutates
 *   the shared `known` map at the end, AFTER rechecking generation.
 * - Also rechecks `stopped` before mutations so an in-flight scan whose
 *   watcher was cancelled (resetIdeDiscoveryForTests, stop()) does not
 *   leak events or re-populate state post-reset.
 */
async function scanDir(dir: string): Promise<void> {
  const gen = ++scanGeneration;

  let entries: string[];
  try {
    entries = readdirSync(dir);
    readdirFailureStreak = 0;
  } catch {
    // Missing dir or permission error. A single glitch should not evict
    // entries (DISC-06a), but a persistently unreachable dir should be
    // cleared so we don't keep reporting stale IDEs forever.
    readdirFailureStreak++;
    if (
      readdirFailureStreak >= READDIR_FAILURE_THRESHOLD &&
      known.size > 0 &&
      !stopped &&
      gen === scanGeneration
    ) {
      reconcileKnown(new Map(), gen);
    }
    return;
  }

  // Build a local snapshot of everything this scan observes. We only
  // reconcile against the shared `known` map at the end, after confirming
  // this scan is still the latest.
  const nextKnown = new Map<string, DiscoveredIde>();
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    const read = await readLockfileWithRetry(path);
    // Post-await checkpoint: a newer scan or a stop() may have landed
    // while we were in the retry backoff. Bail before any mutation.
    if (stopped || gen !== scanGeneration) return;
    if (read.kind === "missing") {
      // File truly gone between readdir and read. Let reconcile drop it.
      // Also reset any pending transient streak — the file is just gone,
      // not brittle.
      transientCounts.delete(path);
      continue;
    }
    if (read.kind === "transient") {
      skippedCount++;
      // FIX 1 (DISC-05): the file still exists on disk but we couldn't
      // read/parse it. If we already have a healthy snapshot for this
      // path, carry it forward so reconcile does NOT emit `ide:removed`
      // for a live IDE. New (never-known) paths stay skipped — we can't
      // fabricate a DiscoveredIde without valid content.
      //
      // DISC-05e/f: bound the carry-forward. After
      // MAX_CONSECUTIVE_TRANSIENT_READS consecutive transient reads for
      // the same known path, give up and let reconcile evict it — the
      // file may have been rewritten with new credentials that we can
      // never recover, and serving stale credentials forever is worse
      // than a clean re-add on recovery.
      const prior = known.get(path);
      if (prior) {
        const nextCount = (transientCounts.get(path) ?? 0) + 1;
        transientCounts.set(path, nextCount);
        if (nextCount < MAX_CONSECUTIVE_TRANSIENT_READS) {
          nextKnown.set(path, prior);
        }
        // else: skip carry-forward. reconcile will emit ide:removed.
      }
      continue;
    }
    // Codex adversarial review (DISC-05g): a clean read is what resets the
    // transient streak, regardless of downstream validation. Previously this
    // delete sat AFTER the isPidAlive() and toDiscovered() checks, so a file
    // that read cleanly but failed either downstream gate would skip the
    // reset — a non-increment bug (counter neither resets nor increments).
    // Reconcile's own removal branch masks the observable effect in the
    // common case (path was in known → removed + counter cleared), but
    // moving the delete here makes the semantics explicit and defends
    // against future refactors that might change the reconcile branch's
    // cleanup behavior.
    transientCounts.delete(path);
    if (!isPidAlive(read.parsed.pid)) continue;
    const next = toDiscovered(path, read.parsed, read.mtime);
    if (!next) {
      skippedCount++;
      continue;
    }
    nextKnown.set(path, next);
  }

  // Final generation / stopped guard before touching shared state.
  if (stopped || gen !== scanGeneration) return;
  reconcileKnown(nextKnown, gen);
}

/**
 * Reconcile the shared `known` map with a scan's local snapshot. Emits
 * ide:added / ide:changed / ide:removed as deltas. Runs synchronously —
 * the caller is responsible for the generation/stopped guards.
 *
 * `gen` is the scan generation that produced `nextKnown`. It is forwarded
 * into each emitted bus event so downstream consumers (ws-bridge fan-out)
 * can stamp their browser-facing broadcasts with a monotonic counter,
 * allowing the client to deduplicate by generation instead of time.
 */
function reconcileKnown(
  nextKnown: Map<string, DiscoveredIde>,
  gen: number,
): void {
  for (const [path, next] of nextKnown) {
    const prev = known.get(path);
    if (!prev) {
      known.set(path, next);
      companionBus.emit("ide:added", {
        port: next.port,
        ideName: next.ideName,
        workspaceFolders: next.workspaceFolders,
        lockfilePath: next.lockfilePath,
        generation: gen,
      });
    } else {
      const changed =
        prev.ideName !== next.ideName ||
        prev.port !== next.port ||
        prev.transport !== next.transport ||
        !shallowArrayEqual(prev.workspaceFolders, next.workspaceFolders);
      known.set(path, next);
      if (changed) {
        companionBus.emit("ide:changed", {
          port: next.port,
          ideName: next.ideName,
          workspaceFolders: next.workspaceFolders,
          lockfilePath: next.lockfilePath,
          generation: gen,
        });
      }
    }
  }
  // Evict anything no longer present (or whose pid went dead).
  for (const [path, entry] of known) {
    if (!nextKnown.has(path)) {
      known.delete(path);
      // Fully drop tracking state — if the path ever comes back we want a
      // clean slate (re-add path, fresh transient counter).
      transientCounts.delete(path);
      companionBus.emit("ide:removed", {
        port: entry.port,
        lockfilePath: entry.lockfilePath,
        generation: gen,
      });
    }
  }
}

/**
 * Synchronous initial scan — used only by startIdeDiscovery to guarantee
 * that lockfiles present on disk before startup are observable via
 * listAvailableIdes() the moment startIdeDiscovery() returns.
 *
 * Rationale: the async scanDir path uses setTimeout-based backoff for
 * partial writes, which defers state population by one or more ticks.
 * REST callers that hit /api/ide/available immediately after server
 * startup would otherwise see an empty list. We accept a one-shot
 * synchronous readFileSync here because it runs exactly once at startup
 * and sees only complete files (partial writes are an fs.watch concern,
 * not a startup one).
 *
 * No retry — a malformed file at startup is either truly malformed or
 * mid-write from a concurrent IDE startup. The fs.watch listener will
 * re-scan on any subsequent modification, so nothing is permanently lost.
 */
function scanDirSync(dir: string): void {
  const gen = ++scanGeneration;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const nextKnown = new Map<string, DiscoveredIde>();
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    let raw: string;
    let mtime: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseLockfile(raw);
    if (!parsed) {
      skippedCount++;
      continue;
    }
    if (!isPidAlive(parsed.pid)) continue;
    const next = toDiscovered(path, parsed, mtime);
    if (!next) {
      skippedCount++;
      continue;
    }
    nextKnown.set(path, next);
  }
  if (stopped || gen !== scanGeneration) return;
  reconcileKnown(nextKnown, gen);
}

/**
 * Handle a single fs.watch event. Path may be relative to `dir` or, on
 * some platforms, absent — in that case we fall back to a full scan.
 *
 * scanDir is async; we fire-and-forget. The watcher callback must not
 * block, and errors inside scanDir are already swallowed internally.
 */
function handleWatchEvent(dir: string, filename: string | null): void {
  if (!filename) {
    void scanDir(dir);
    return;
  }
  if (!filename.endsWith(".lock")) return;
  void scanDir(dir); // simplest correct path — always reconcile the whole dir.
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start watching `ideDir` (default `~/.claude/ide`). Returns a `stop()`
 * function that closes the watcher + cancels the rescan timer.
 *
 * Safe to call when the directory does not exist — treated as empty.
 * Calling while already started is tolerated: the prior watcher is
 * stopped first.
 */
export function startIdeDiscovery(
  options: StartIdeDiscoveryOptions = {},
): () => void {
  // If already running, tear down first so callers get a clean restart.
  if (currentWatcher || currentRescanTimer) {
    stopCurrent();
  }

  const ideDir = options.ideDir ?? join(homedir(), ".claude", "ide");
  currentIdeDir = ideDir;
  stopped = false;
  // Cubic P2 (DISC-06d): defensive zeroing. `readdirFailureStreak` is
  // module-level state; even though stopCurrent() already clears it, a
  // caller might invoke startIdeDiscovery() without a matching prior
  // stop() (first-ever start, or after an abnormal tear-down that
  // bypassed stopCurrent). Reset here so the new session always starts
  // with a clean streak and cannot inherit a carry-over that pushes it
  // across the eviction threshold too early.
  readdirFailureStreak = 0;

  // Initial scan — synchronous so listAvailableIdes() reflects pre-existing
  // lockfiles the moment startIdeDiscovery returns. See scanDirSync for the
  // rationale (GET /api/ide/available must not race against startup).
  scanDirSync(ideDir);

  // fs.watch on a missing dir throws — try, tolerate ENOENT.
  try {
    currentWatcher = watch(
      ideDir,
      { persistent: false },
      (_eventType, filename) => {
        if (stopped) return;
        handleWatchEvent(ideDir, typeof filename === "string" ? filename : null);
      },
    );
    currentWatcher.on("error", () => {
      // Swallow — watcher errors must not crash the server.
    });
    // Codex round-2 issue #3: catch-up scan. Between scanDirSync() and the
    // watch() call above there is a brief window where an IDE could finish
    // writing its lockfile. fs.watch only reports events that happen AFTER
    // it attaches, so such a file would be invisible until the next 10s
    // periodic rescan. Schedule an immediate async scanDir() — the existing
    // generation counter guarantees correctness if a watch-triggered scan
    // races with it.
    void scanDir(ideDir);
  } catch {
    currentWatcher = null;
    // Directory likely doesn't exist. Rescan timer below will pick up
    // lockfiles if someone later creates the dir.
  }

  currentRescanTimer = setInterval(() => {
    if (stopped || currentIdeDir === null) return;
    void scanDir(currentIdeDir);
  }, RESCAN_INTERVAL_MS);
  // Do not keep the Node event loop alive for this timer.
  (currentRescanTimer as { unref?: () => void }).unref?.();

  return stopCurrent;
}

function stopCurrent(): void {
  stopped = true;
  // Bump generation so any in-flight scanDir that is currently awaiting
  // readLockfileWithRetry will see a stale generation on resume and bail
  // before touching `known` or emitting events.
  scanGeneration++;
  if (currentWatcher) {
    try {
      currentWatcher.close();
    } catch {
      // ignore
    }
    currentWatcher = null;
  }
  if (currentRescanTimer) {
    clearInterval(currentRescanTimer);
    currentRescanTimer = null;
  }
  currentIdeDir = null;
  // Codex round-2 issue #2: clear `known` here. A subsequent
  // startIdeDiscovery() may point at a missing or permission-denied
  // directory, in which case scanDirSync returns early without reconciling.
  // Without this clear, listAvailableIdes() would keep returning stale
  // entries from the previous dir forever.
  known.clear();
  transientCounts.clear();
  // Cubic P2 (DISC-06d): readdir failure streak is module-level state
  // that must not leak across stop/start cycles. If a session accumulated
  // failures under the eviction threshold and is then stopped, the next
  // startIdeDiscovery() would otherwise inherit the non-zero streak and
  // evict IDEs too early on the first failure in the new session.
  readdirFailureStreak = 0;
}

/**
 * Snapshot of currently-known IDEs.
 *
 * Returns a fresh outer array AND fresh per-entry clones so that callers
 * cannot mutate the module's internal `known` Map by writing through the
 * returned records (cubic round-5 P2 FIX 2 / SNAPSHOT-01). `DiscoveredIde`
 * is a flat record whose only nested mutable field is `workspaceFolders`
 * (string[]); spreading the record and copying that array is sufficient —
 * cheaper than `structuredClone` and covers every field.
 */
export function listAvailableIdes(): DiscoveredIde[] {
  return Array.from(known.values()).map((ide) => ({
    ...ide,
    workspaceFolders: [...ide.workspaceFolders],
  }));
}

/**
 * Gate for test-only exports. Vitest sets NODE_ENV=test via vitest.config.ts
 * and exposes `process.env.VITEST`. We accept either so ad-hoc `bun test`
 * or a future test runner still works without silently enabling the hooks
 * in production. Throws a descriptive error when called outside a test
 * runtime so a misrouted production import fails loudly instead of
 * wedging internal scan state.
 */
function assertTestOnly(fn: string): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error(`${fn} is test-only`);
  }
}

/** Test-only — wipe internal state between tests. */
export function resetIdeDiscoveryForTests(): void {
  assertTestOnly("resetIdeDiscoveryForTests");
  stopCurrent();
  known.clear();
  transientCounts.clear();
  skippedCount = 0;
  readdirFailureStreak = 0;
  // Bump generation so any async scan still in-flight from a previous test
  // will see a stale generation on its post-await recheck and bail out.
  scanGeneration++;
}

/** Diagnostic accessor (not part of the public contract). */
export function _getSkippedCountForTests(): number {
  assertTestOnly("_getSkippedCountForTests");
  return skippedCount;
}

/**
 * Test-only: reset the DISC-06 readdir failure streak counter without
 * clearing `known`. Lets DISC-06 tests stage failure sequences without
 * tearing down the seeded IDE state.
 */
export function _resetReaddirFailureStreakForTests(): void {
  assertTestOnly("_resetReaddirFailureStreakForTests");
  readdirFailureStreak = 0;
}

/**
 * Test-only: inspect the DISC-06 readdir failure streak counter. Used by
 * DISC-06d to assert the streak is reset across stop/start cycles and does
 * not leak stale failure history into a fresh session.
 */
export function _getReaddirFailureStreakForTests(): number {
  assertTestOnly("_getReaddirFailureStreakForTests");
  return readdirFailureStreak;
}

/**
 * Test-only: reset the per-path consecutive-transient-read counters
 * (DISC-05e/f) without clearing `known`. Lets tests stage a clean streak
 * starting at 0 on top of seeded IDE state.
 */
export function _resetTransientCountsForTests(): void {
  assertTestOnly("_resetTransientCountsForTests");
  transientCounts.clear();
}

/**
 * Test-only: inspect the per-path transient-read counter. Used by
 * DISC-05g/DISC-05h to assert the counter is cleared on clean reads and
 * on missing-file reconciliation, regardless of downstream validation
 * outcome.
 */
export function _getTransientCountForTests(path: string): number | undefined {
  assertTestOnly("_getTransientCountForTests");
  return transientCounts.get(path);
}

/**
 * Test-only: manually set the transient counter for a path. Lets tests
 * stage a non-zero counter for paths that are NOT in `known`, isolating
 * the scanDir missing-branch counter cleanup from reconcile's eviction
 * cleanup (DISC-05h regression guard).
 */
export function _setTransientCountForTests(path: string, count: number): void {
  assertTestOnly("_setTransientCountForTests");
  transientCounts.set(path, count);
}

/**
 * Test-only: invoke scanDir deterministically. Production callers use
 * fs.watch / setInterval fan-out; tests need a direct await point so
 * they can stage mocked readdirSync / readFileSync behavior per scan.
 */
export async function _scanDirForTests(dir: string): Promise<void> {
  assertTestOnly("_scanDirForTests");
  await scanDir(dir);
}

/**
 * Test-only: install / clear the retry-sleep hook used inside
 * `readLockfileWithRetry`. Pass `null` to restore real setTimeout-based
 * backoff. Tests use this to hold a scan at its retry checkpoint while
 * interleaving a second scan deterministically (no wall-clock fudging
 * of 2ms sleeps or real fs.watch timing). Always clear in afterEach.
 */
export function _setReadRetrySleepHookForTests(
  hook: ((attempt: number, waitMs: number) => Promise<void>) | null,
): void {
  assertTestOnly("_setReadRetrySleepHookForTests");
  __retrySleepHookForTests = hook;
}

/**
 * Test-only: clear the `stopped` flag so `_scanDirForTests` can run
 * without `startIdeDiscovery`. `resetIdeDiscoveryForTests()` leaves
 * `stopped = true` to kill in-flight scans; tests that want to drive
 * scans directly via `_scanDirForTests` must call this first.
 */
export function _clearStoppedForTests(): void {
  assertTestOnly("_clearStoppedForTests");
  stopped = false;
}
