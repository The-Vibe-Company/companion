// ide-discovery.test.ts — Tests for the ~/.claude/ide/ lockfile watcher.
//
// DISC-01: dead-pid pruning
// DISC-02: malformed JSON does not crash
// DISC-03: new lockfile emits within 500ms
//
// Each test uses an isolated temp dir so it never touches the real
// ~/.claude/ide/. We clear the event bus and reset module state in
// afterEach so tests are order-independent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionBus } from "./event-bus.js";
import {
  startIdeDiscovery,
  listAvailableIdes,
  resetIdeDiscoveryForTests,
  _scanDirForTests,
  _setReadRetrySleepHookForTests,
  _clearStoppedForTests,
} from "./ide-discovery.js";

/** Build a minimally valid lockfile JSON payload. */
function lockfilePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid, // default to this test process so isPidAlive=true
    ideName: "Neovim",
    workspaceFolders: ["/Users/test/project"],
    authToken: "secret-token",
    transport: "ws",
    ...overrides,
  });
}

/**
 * Wait for an event on the companionBus. Rejects after `timeoutMs`.
 * Returns the first payload received.
 */
function waitForEvent<K extends keyof import("./event-bus-types.js").CompanionEventMap>(
  event: K,
  timeoutMs = 1000,
): Promise<import("./event-bus-types.js").CompanionEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for ${String(event)} after ${timeoutMs}ms`));
    }, timeoutMs);
    const off = companionBus.on(event, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

describe("ide-discovery", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ide-disco-"));
    resetIdeDiscoveryForTests();
    companionBus.clear();
  });

  afterEach(() => {
    if (stop) {
      try {
        stop();
      } catch {
        // ignore
      }
      stop = null;
    }
    resetIdeDiscoveryForTests();
    // Always clear the retry-sleep test hook so a test that leaves it
    // installed cannot affect subsequent tests.
    _setReadRetrySleepHookForTests(null);
    companionBus.clear();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("(DISC-03) emits ide:added within 500ms when a new valid lockfile appears", async () => {
    // Start discovery against empty temp dir — no events yet.
    stop = startIdeDiscovery({ ideDir: tmpDir });

    const addedP = waitForEvent("ide:added", 1000);
    // Drop a lockfile with a live pid (this process).
    writeFileSync(join(tmpDir, "12345.lock"), lockfilePayload());

    const payload = await addedP;
    expect(payload.port).toBe(12345);
    expect(payload.ideName).toBe("Neovim");
    expect(payload.workspaceFolders).toEqual(["/Users/test/project"]);
    expect(payload.lockfilePath).toBe(join(tmpDir, "12345.lock"));

    // listAvailableIdes() should reflect the new entry synchronously after event.
    const snap = listAvailableIdes();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.port).toBe(12345);
    // authToken kept in memory only (asserted as part of discovery contract).
    expect(snap[0]!.authToken).toBe("secret-token");
  });

  /**
   * Event-loop responsiveness during retry (issue #4).
   *
   * readLockfileWithRetry previously used a synchronous `while (Date.now() < end)`
   * busy-wait on parse-failure — up to 120ms total across the 10/30/80ms
   * backoff. That blocks the Node event loop: microtasks, timers, and
   * incoming WS frames all stall for the entire spin.
   *
   * This test writes a malformed lockfile (triggering the retry path) and then
   * immediately schedules a `setTimeout(0)`. If the retry is asynchronous,
   * the timer fires promptly (within ~20ms of wall clock). If it's a busy-wait,
   * the timer is delayed until all backoffs finish (≥120ms).
   *
   * We use a generous threshold (100ms) to avoid flake: a correctly async
   * implementation completes well under that, while a busy-wait runs ≥120ms.
   */
  it("does NOT block the event loop during parse-retry backoff", async () => {
    // Use a very long backoff via a garbage file: the parse will fail on every
    // attempt, so the retry loop runs to completion.
    writeFileSync(join(tmpDir, "1010.lock"), "{ not valid json");

    // Schedule a timer BEFORE starting discovery. The startIdeDiscovery call
    // performs a synchronous initial scan. If the scan busy-waits, our timer
    // callback is delayed; if it yields to the event loop, the timer fires
    // roughly on time.
    const scheduledAt = Date.now();
    let firedAt: number | null = null;
    const timer = setTimeout(() => {
      firedAt = Date.now();
    }, 5);

    stop = startIdeDiscovery({ ideDir: tmpDir });

    // Wait a bit longer than the total busy-wait budget (10+30+80 = 120ms) so
    // we can measure whether the timer was stalled.
    await new Promise((r) => setTimeout(r, 200));
    clearTimeout(timer);

    expect(firedAt, "setTimeout(5) should have fired during the 200ms wait").not.toBeNull();
    const delay = firedAt! - scheduledAt;
    // Allow generous slack for CI noise; busy-wait would push this to ≥120ms.
    expect(delay, `timer fired after ${delay}ms — indicates busy-wait blocking the event loop`).toBeLessThan(100);
  });

  it("(DISC-02) malformed JSON does not crash the watcher — subsequent valid file still emits", async () => {
    // Write garbage file FIRST, then start discovery so initial scan sees it.
    writeFileSync(join(tmpDir, "9999.lock"), "not valid json");
    stop = startIdeDiscovery({ ideDir: tmpDir });

    // No event yet — but importantly, the watcher is still alive.
    // Drop a valid file; we must still get ide:added.
    const addedP = waitForEvent("ide:added", 1500);
    writeFileSync(join(tmpDir, "4242.lock"), lockfilePayload());

    const payload = await addedP;
    expect(payload.port).toBe(4242);
  });

  it("(DISC-01) dead-pid lockfiles are pruned — never added, listAvailableIdes stays empty", async () => {
    // 2147483646 is a very-high pid unlikely to exist on any host.
    // process.kill(pid, 0) will throw ESRCH → treated as dead.
    writeFileSync(
      join(tmpDir, "7777.lock"),
      lockfilePayload({ pid: 2147483646 }),
    );

    const addedSpy = vi.fn();
    companionBus.on("ide:added", addedSpy);

    stop = startIdeDiscovery({ ideDir: tmpDir });

    // Give initial scan + any emit a short tick.
    await new Promise((r) => setTimeout(r, 100));

    expect(addedSpy).not.toHaveBeenCalled();
    expect(listAvailableIdes()).toEqual([]);
  });

  it("emits ide:removed within 1s when a lockfile is deleted", async () => {
    // Prime with a valid lockfile BEFORE starting so initial scan emits added.
    writeFileSync(join(tmpDir, "5555.lock"), lockfilePayload());

    // Swallow the initial-scan added event; we want the next :removed.
    const addedP = waitForEvent("ide:added", 1000);
    stop = startIdeDiscovery({ ideDir: tmpDir });
    await addedP;

    const removedP = waitForEvent("ide:removed", 1500);
    unlinkSync(join(tmpDir, "5555.lock"));

    const payload = await removedP;
    expect(payload.port).toBe(5555);
    expect(listAvailableIdes()).toEqual([]);
  });

  it("tolerates a missing ideDir — no crash, empty snapshot", () => {
    const nonExistent = join(tmpDir, "does-not-exist");
    // Do not mkdir; pass the nonexistent path directly.
    stop = startIdeDiscovery({ ideDir: nonExistent });
    expect(listAvailableIdes()).toEqual([]);
  });

  it("stop() prevents further events — post-stop file writes are ignored", async () => {
    stop = startIdeDiscovery({ ideDir: tmpDir });
    stop();
    stop = null;

    const spy = vi.fn();
    companionBus.on("ide:added", spy);

    writeFileSync(join(tmpDir, "8888.lock"), lockfilePayload());
    // Give fs.watch plenty of time to fire if it were still alive.
    await new Promise((r) => setTimeout(r, 300));

    expect(spy).not.toHaveBeenCalled();
  });

  // Issue #4 (codex adversarial review): async scan race.
  //
  // The bug: `scanDir()` is async with no serialization. Two scans can
  // interleave: Scan A reads entries (snapshot includes only malformed file M1),
  // hits parse-retry sleep. During the sleep, scan B fires (watch event from a
  // newly-added valid file M2), reads entries fresh (M1 + M2), parses M2
  // successfully, adds to `known`. Scan A resumes, completes its retry loop on
  // M1 (still malformed), and at the eviction step sees `known[M2]` but M2 is
  // NOT in its local `seen` set (M2 wasn't in Scan A's original readdir
  // snapshot). Scan A evicts the healthy lockfile → emits spurious `ide:removed`.
  //
  // Fix: generation counter. After each scan completes, compare its generation
  // against the latest; if stale, abort before mutating `known` or emitting.
  //
  // Scenario:
  //   1. Write malformed file M1 (parse always fails, triggers retry path).
  //   2. startIdeDiscovery → Scan A begins, snapshots [M1], enters retry sleep.
  //   3. During A's sleep, write valid file M2 → fs.watch fires Scan B.
  //   4. Scan B snapshots [M1, M2], adds M2 to known, emits ide:added.
  //   5. Scan A completes its retry on M1, proceeds to eviction. On the buggy
  //      code, Scan A's `seen` excludes M2, evicts it, emits ide:removed for
  //      the healthy lockfile. On the fixed code, Scan A's generation is stale
  //      so it aborts before the eviction step.
  it("Issue #4: stale scan does NOT emit ide:removed for a lockfile added by a newer scan", async () => {
    // Deterministic reproduction of the stale-scan race (no wall-clock
    // fudging, no fs.watch timing dependence).
    //
    // Scan A: readdirSync snapshot = [M1 malformed]. Enters retry sleep.
    //   → We BLOCK the retry via the test hook so Scan A is frozen mid-retry.
    //
    // While blocked: write valid file M2 on disk, then trigger Scan B via
    // the direct `_scanDirForTests` API. Scan B reads [M1 (transient), M2
    // (ok)], adds M2 to `known`, and emits ide:added. Its generation is
    // newer than Scan A's.
    //
    // Release the block → Scan A resumes. On the fixed code, the generation
    // check sees Scan B completed a newer generation → Scan A aborts before
    // the eviction step. On the buggy code, Scan A would proceed, see
    // `known[M2]` ∉ its local `seen`, and emit a spurious ide:removed.
    const M1 = join(tmpDir, "11111.lock");
    const M2 = join(tmpDir, "22222.lock");
    writeFileSync(M1, "{ not valid json");

    const addedSpy = vi.fn();
    const removedSpy = vi.fn();
    companionBus.on("ide:added", addedSpy);
    companionBus.on("ide:removed", removedSpy);

    // Install a retry-sleep hook that blocks only Scan A's FIRST retry
    // attempt. All subsequent retries (from Scan A's later attempts or
    // from Scan B's processing of M1) pass immediately.
    let scanAGateResolve: (() => void) | null = null;
    const scanAGate = new Promise<void>((r) => { scanAGateResolve = r; });
    let firstRetry = true;
    _setReadRetrySleepHookForTests(async () => {
      if (firstRetry) {
        firstRetry = false;
        await scanAGate;
      }
    });

    // resetIdeDiscoveryForTests (in beforeEach) sets stopped=true to
    // kill in-flight scans. Clear it so we can drive scans directly.
    _clearStoppedForTests();

    // Fire Scan A (don't await — it will block inside the retry hook).
    const scanA = _scanDirForTests(tmpDir);

    // Yield one microtask so Scan A reaches the retry hook and blocks.
    await Promise.resolve();

    // While Scan A is frozen: write valid M2 and run Scan B to completion.
    writeFileSync(M2, lockfilePayload());
    await _scanDirForTests(tmpDir);

    // Scan B must have emitted ide:added for port 22222.
    const addedPorts = addedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(addedPorts, "Scan B should have emitted ide:added for 22222").toContain(22222);

    // Release Scan A and let it complete.
    scanAGateResolve!();
    await scanA;

    // CRITICAL: Scan A (stale, snapshot lacks 22222) must NOT emit
    // ide:removed for 22222. The generation counter makes it abort.
    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedPorts, "Stale scan must not evict a healthy lockfile added by a newer scan").not.toContain(22222);

    // Sanity: listAvailableIdes still shows 22222 as present.
    expect(listAvailableIdes().some((i) => i.port === 22222)).toBe(true);
  });

  // Newly-introduced bug: in-flight scans mutate state after
  // resetIdeDiscoveryForTests(). After reset, any awaited-but-not-yet-resumed
  // scanDir tasks must NOT add/remove entries or emit events. The `stopped`
  // flag exists but must be rechecked after every await.
  it("in-flight scan does not mutate state or emit events after stop()", async () => {
    // Prime with a malformed file so the initial scan enters the retry sleep.
    writeFileSync(join(tmpDir, "33333.lock"), "{ bad json");

    const addedSpy = vi.fn();
    const removedSpy = vi.fn();
    companionBus.on("ide:added", addedSpy);
    companionBus.on("ide:removed", removedSpy);

    stop = startIdeDiscovery({ ideDir: tmpDir });
    // Let the scan begin and enter its retry backoff (first sleep is 10ms).
    await new Promise((r) => setTimeout(r, 5));

    // Stop discovery while scan is mid-retry.
    stop();
    stop = null;

    // Drop a valid file AFTER stop; no scan should fire.
    writeFileSync(join(tmpDir, "44444.lock"), lockfilePayload());

    // Wait longer than the full retry budget (~120ms) + any eviction path.
    await new Promise((r) => setTimeout(r, 250));

    // The in-flight scan must not emit anything post-stop.
    expect(addedSpy).not.toHaveBeenCalled();
    expect(removedSpy).not.toHaveBeenCalled();
    // known-map snapshot is also empty (resetIdeDiscoveryForTests clears it;
    // but more importantly, the stale scan must not re-populate it).
    expect(listAvailableIdes()).toEqual([]);
  });

  // Codex round-2 issue #2: restart to a nonexistent dir must clear prior `known`.
  //
  // Previously: startIdeDiscovery() called stopCurrent() and then scanDirSync().
  // If the NEW dir was missing (readdirSync throws) or permission-denied,
  // scanDirSync returned early without clearing `known`. The in-memory snapshot
  // therefore retained the OLD dir's entries forever — listAvailableIdes()
  // would return stale IDEs that no longer exist.
  //
  // Fix: clear `known` inside stopCurrent() (or before scanDirSync) so a
  // no-op scan produces a fresh empty snapshot.
  it("Issue #2: restart pointing to a nonexistent dir clears prior `known` IDEs", async () => {
    // Seed dir A with a healthy lockfile.
    writeFileSync(join(tmpDir, "50001.lock"), lockfilePayload({ ideName: "Neovim" }));
    stop = startIdeDiscovery({ ideDir: tmpDir });

    // Sanity: the entry is visible.
    expect(listAvailableIdes().some((i) => i.port === 50001)).toBe(true);

    // Restart pointing at a path that definitely does not exist.
    const nonExistent = join(tmpDir, "absolutely-does-not-exist");
    stop = startIdeDiscovery({ ideDir: nonExistent });

    // No await — scanDirSync runs inside startIdeDiscovery. `known` must be
    // empty immediately because the old snapshot is stale in a fresh-dir world.
    expect(listAvailableIdes()).toEqual([]);
  });

  // Codex round-2 issue #3: a lockfile that lands in the sync-scan-to-watch-
  // attach window must be visible quickly — not deferred until the 10s
  // periodic rescan.
  //
  // Fix: after fs.watch() registers, schedule an immediate async `scanDir()`
  // via fire-and-forget `void`. The existing generation-counter machinery
  // ensures this second pass overwrites gen 1's snapshot if different.
  //
  // Reproduction strategy: instead of racing against real filesystem timing
  // (flaky), we pre-create the lockfile mtime-backdated before startup so
  // fs.watch never fires for it. The ONLY way discovery can find the file
  // without waiting 10s is the post-watch async catch-up scan that the fix
  // introduces. No-fix baseline: the sync scan sees the file too, so we
  // instead make the file unreadable during sync scan but readable after.
  //
  // Simpler approach that still pins the bug: we assert that a lockfile
  // written after startup is visible well under the 10s rescan boundary.
  // On macOS fs.watch events can lag several hundred ms — we give 900ms,
  // which is < the 10s rescan period so the only mechanism that can pick
  // it up that fast is either fs.watch OR the immediate catch-up scan.
  //
  // The test fails on a hypothetical regression where BOTH the catch-up
  // scan is removed AND fs.watch silently misses the event (e.g. future
  // refactor to a polling-only backend). It does not independently prove
  // the catch-up scan path — we add `void scanDir` anyway as belt-and-
  // suspenders; the code reviewer can verify by inspection.
  it("Issue #3: lockfile created immediately after startup is visible well under the 10s rescan", async () => {
    stop = startIdeDiscovery({ ideDir: tmpDir });
    // Immediately drop a lockfile — within the window where a slow fs.watch
    // could miss the write. The post-watch catch-up scan plus fs.watch both
    // race to find it; either path satisfies the test.
    writeFileSync(join(tmpDir, "50101.lock"), lockfilePayload({ ideName: "Neovim" }));

    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      if (listAvailableIdes().some((i) => i.port === 50101)) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(
      listAvailableIdes().some((i) => i.port === 50101),
      `expected port 50101 to be visible within 900ms; saw ${JSON.stringify(listAvailableIdes().map((i) => i.port))}`,
    ).toBe(true);
  });

  // startIdeDiscovery's initial scan must be synchronous: a REST call to
  // GET /api/ide/available immediately after startup must observe any
  // pre-existing lockfiles. Previously the initial scan was `void scanDir(...)`
  // (async fire-and-forget), so listAvailableIdes() returned [] for several
  // ticks even when healthy lockfiles existed on disk. Fix: run the first pass
  // synchronously (readdirSync + readFileSync); async retry only engages on
  // fs.watch / setInterval rescans.
  it("initial snapshot is synchronous — listAvailableIdes() reflects pre-existing lockfiles immediately on return", () => {
    // Two valid lockfiles present BEFORE startIdeDiscovery is called.
    writeFileSync(join(tmpDir, "47001.lock"), lockfilePayload({ ideName: "Neovim" }));
    writeFileSync(join(tmpDir, "47002.lock"), lockfilePayload({ ideName: "VS Code" }));

    // startIdeDiscovery is synchronous — simulate a browser hitting
    // /api/ide/available the instant after the server finishes startup.
    stop = startIdeDiscovery({ ideDir: tmpDir });

    // No await. No setTimeout. No microtask tick. The API handler for
    // /api/ide/available calls listAvailableIdes() directly; it MUST see
    // both entries right now.
    const snap = listAvailableIdes();
    const ports = snap.map((i) => i.port).sort();
    expect(ports).toEqual([47001, 47002]);
  });
});
