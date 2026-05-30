// ide-discovery-resilience.test.ts — Round-4 robustness tests for
// transient filesystem failures in the lockfile discovery loop.
//
// These tests cover two failure modes that previously caused spurious
// `ide:removed` events (UI churn / auto-unbind from live IDEs):
//
//   FIX 1 (DISC-05): a lockfile is present on disk but read or parse fails
//     transiently (EBUSY, partial write after all retries). The path must
//     NOT be evicted from `known` — reconcile should carry the previous
//     entry forward and let the next clean scan refresh it.
//
//   FIX 2 (DISC-06): `readdirSync(dir)` fails persistently (permissions
//     revoked, dir removed). After N consecutive failures (threshold = 3)
//     stale entries must be evicted; a single failure must preserve them.
//
// These tests use module re-imports with `vi.doMock` because they need to
// override specific node:fs calls (readFileSync, readdirSync) without
// touching the rest of the filesystem API used by test setup
// (mkdtempSync, writeFileSync, rmSync, etc.).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We must control readFileSync / readdirSync per test. vi.mock needs the
// override functions to be hoisted; we expose setter hooks that tests flip.
// CRITICAL: bare `readdirSync`/`readFileSync` imports from node:fs in this
// file would resolve through the mock (infinite recursion when fallthrough
// tries to call "the real one"). Instead we capture the originals inside
// the mock factory and expose them via module-level hooks.
const readFileSyncImpl = vi.hoisted(() => ({
  current: null as ((path: string, enc?: string) => string) | null,
  real: null as ((path: string, enc?: string) => string) | null,
}));
const readdirSyncImpl = vi.hoisted(() => ({
  current: null as ((path: string) => string[]) | null,
  real: null as ((path: string) => string[]) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  readFileSyncImpl.real = (p: string, enc?: string) =>
    actual.readFileSync(p, enc as BufferEncoding) as string;
  readdirSyncImpl.real = (p: string) => actual.readdirSync(p) as unknown as string[];
  return {
    ...actual,
    readFileSync: (path: string, enc?: string) =>
      readFileSyncImpl.current
        ? readFileSyncImpl.current(path, enc)
        : actual.readFileSync(path, enc as BufferEncoding),
    readdirSync: (path: string) =>
      readdirSyncImpl.current
        ? readdirSyncImpl.current(path)
        : (actual.readdirSync(path) as string[]),
  };
});

/** Build a minimally valid lockfile JSON payload. */
function lockfilePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid,
    ideName: "Neovim",
    workspaceFolders: ["/Users/test/project"],
    authToken: "secret-token",
    transport: "ws",
    ...overrides,
  });
}

describe("ide-discovery resilience (DISC-05 / DISC-06)", () => {
  let tmpDir: string;
  // Re-imported module under test — fresh instance per test via vi.resetModules.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let disco: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bus: any;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ide-resil-"));
    readFileSyncImpl.current = null;
    readdirSyncImpl.current = null;
    vi.resetModules();
    disco = await import("./ide-discovery.js");
    bus = (await import("./event-bus.js")).companionBus;
    disco.resetIdeDiscoveryForTests();
    bus.clear();
  });

  afterEach(() => {
    if (stop) {
      try { stop(); } catch { /* ignore */ }
      stop = null;
    }
    try { disco.resetIdeDiscoveryForTests(); } catch { /* ignore */ }
    try { bus.clear(); } catch { /* ignore */ }
    readFileSyncImpl.current = null;
    readdirSyncImpl.current = null;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── FIX 1: transient read/parse failures must NOT evict known IDEs ──────

  // DISC-05a: a lockfile is listed by readdirSync and statSync confirms it
  // exists, but readFileSync throws EBUSY (transient file-lock from a
  // concurrent writer). Previously `readLockfileWithRetry` returned null
  // and scanDir skipped the entry, which reconcileKnown then evicted from
  // `known` via `ide:removed`. After the fix: the read is classified as
  // "transient" (file present but unreadable) and the previous known entry
  // is carried forward — no spurious removal.
  it("DISC-05a: EBUSY on readFileSync does not evict a previously-known IDE", async () => {
    const lockPath = join(tmpDir, "60001.lock");
    const payload = lockfilePayload({ ideName: "Neovim" });
    writeFileSync(lockPath, payload);

    // First scan reads the file cleanly → entry is in `known`.
    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60001)).toBe(true);

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    // Flip readFileSync to throw EBUSY for THIS lockfile. statSync still
    // succeeds (file is present), so readLockfileWithRetry classifies the
    // outcome as "transient" — scanDir must carry the prior entry forward
    // rather than letting reconcile drop it.
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath) {
        const err = new Error("EBUSY: resource busy or locked");
        (err as NodeJS.ErrnoException).code = "EBUSY";
        throw err;
      }
      return readFileSyncImpl.real!(p, "utf8");
    };

    // Force a deterministic async scan — this is exactly the path that
    // would fire from fs.watch or the 10s rescan timer in production.
    await disco._scanDirForTests(tmpDir);

    expect(
      disco.listAvailableIdes().some((i: { port: number }) => i.port === 60001),
      "DISC-05a: known entry must survive transient EBUSY",
    ).toBe(true);
    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedPorts, "DISC-05a: no ide:removed for transient read failure").not.toContain(60001);

    // Recovery: once the read succeeds again on the next scan, the entry
    // is refreshed cleanly (still there, no spurious removal in between).
    readFileSyncImpl.current = null;
    await disco._scanDirForTests(tmpDir);
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60001)).toBe(true);
  });

  // DISC-05b: the file is present and readable but the contents are
  // malformed (all retries fail to parse). A persistent parse-failure for
  // a PREVIOUSLY-known path should carry the prior entry forward — the
  // content is likely mid-rewrite or corrupted transiently, not the IDE
  // legitimately going away.
  it("DISC-05b: persistent parse-failure does not evict a previously-known IDE", async () => {
    const lockPath = join(tmpDir, "60002.lock");
    const payload = lockfilePayload({ ideName: "VSCode" });
    writeFileSync(lockPath, payload);

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60002)).toBe(true);

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    // Make readFileSync return garbage for this file — parseLockfile fails
    // on every retry. The file still exists (statSync succeeds), so the
    // outcome is "transient" and the prior entry must be preserved.
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath) return "{ garbage";
      return readFileSyncImpl.real!(p, "utf8");
    };
    await disco._scanDirForTests(tmpDir);

    expect(
      disco.listAvailableIdes().some((i: { port: number }) => i.port === 60002),
      "DISC-05b: parse-failure must not evict live entry",
    ).toBe(true);
    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedPorts).not.toContain(60002);
  });

  // DISC-05c: regression guard — when the lockfile is LEGITIMATELY deleted,
  // `statSync` throws ENOENT (file gone). That path must still emit
  // `ide:removed` — the transient-preserve logic must NOT swallow genuine
  // removals.
  it("DISC-05c: genuine lockfile deletion still emits ide:removed", async () => {
    const lockPath = join(tmpDir, "60003.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60003)).toBe(true);

    const removedP = new Promise<{ port: number }>((resolve) => {
      bus.on("ide:removed", (p: { port: number }) => {
        if (p.port === 60003) resolve(p);
      });
    });

    // Remove the file for real. readdirSync won't list it; reconcile will
    // see `nextKnown` missing the path and legitimately evict.
    rmSync(lockPath);
    const payload = await Promise.race([
      removedP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("DISC-05c: ide:removed never fired")), 2000)),
    ]);
    expect((payload as { port: number }).port).toBe(60003);
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60003)).toBe(false);
  });

  // DISC-05d: lockfile present + transient read failure, but NOT previously
  // known. There is nothing to preserve — skip cleanly (no add, no remove,
  // no crash). This proves the carry-forward logic only kicks in when we
  // have a prior entry.
  it("DISC-05d: transient failure for an unknown path is skipped without crashing", async () => {
    const lockPath = join(tmpDir, "60004.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    // Fail the read from the very first attempt — the entry is never known.
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath) {
        const err = new Error("EBUSY");
        (err as NodeJS.ErrnoException).code = "EBUSY";
        throw err;
      }
      return readFileSyncImpl.real!(p, "utf8");
    };

    const addedSpy = vi.fn();
    const removedSpy = vi.fn();
    bus.on("ide:added", addedSpy);
    bus.on("ide:removed", removedSpy);

    // Should not throw.
    expect(() => {
      stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 200));
    expect(addedSpy).not.toHaveBeenCalled();
    expect(removedSpy).not.toHaveBeenCalled();
    expect(disco.listAvailableIdes()).toEqual([]);
  });

  // ─── FIX 2: readdirSync persistent failure evicts stale entries ──────────

  // DISC-06a: a SINGLE readdirSync failure must NOT evict known entries.
  // Transient EACCES or EBUSY should be tolerated gracefully.
  it("DISC-06a: single readdirSync failure preserves known entries", async () => {
    const lockPath = join(tmpDir, "60011.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60011)).toBe(true);

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    // Reset the failure streak (from any prior test module state) then fail
    // readdirSync exactly once.
    disco._resetReaddirFailureStreakForTests?.();
    let failCount = 0;
    readdirSyncImpl.current = (p: string) => {
      if (p === tmpDir) {
        failCount++;
        if (failCount === 1) {
          const err = new Error("EACCES: permission denied");
          (err as NodeJS.ErrnoException).code = "EACCES";
          throw err;
        }
      }
      return readdirSyncImpl.real!(p);
    };

    // Provoke one scan via fs.watch (touch the file).
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));
    await new Promise((r) => setTimeout(r, 250));

    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60011)).toBe(true);
    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedPorts).not.toContain(60011);
  });

  // DISC-06b: after THREE consecutive readdirSync failures, the known map
  // is evicted — all stale entries emit `ide:removed`. This recovers from
  // a dir that was permanently unmounted/deleted/permission-revoked.
  it("DISC-06b: three consecutive readdirSync failures evict all known entries", async () => {
    const lockPath = join(tmpDir, "60012.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60012)).toBe(true);

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    disco._resetReaddirFailureStreakForTests?.();
    // Make readdirSync fail persistently from now on.
    readdirSyncImpl.current = (p: string) => {
      if (p === tmpDir) {
        const err = new Error("EACCES: permission denied");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      }
      return readdirSyncImpl.real!(p);
    };

    // Trigger three async rescans via the test-only direct entry point.
    // Each failing readdir bumps the streak; on the 3rd call we should
    // see the eviction path (reconcileKnown(new Map())).
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);
    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedPorts, "DISC-06b: known entry must be evicted after 3 consecutive readdir failures").toContain(60012);
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60012)).toBe(false);
  });

  // ─── DISC-05e/f: bounded carry-forward on repeated transient reads ──────

  // DISC-05e: brittle-carry-forward guard. Previously, a lockfile whose read
  // classified as "transient" was carried forward from `known` indefinitely.
  // If the IDE silently rewrote the file with new credentials (authToken /
  // port) but every subsequent read hit EBUSY, we would serve stale
  // credentials forever. Fix: after N=5 consecutive transient reads for the
  // same path, give up and let reconcile evict it (emit `ide:removed`).
  //
  // Assertions:
  //   - Scans 1..4 (transient): entry preserved, no `ide:removed`.
  //   - Scan 5 (transient): `ide:removed` fires, entry leaves `known`.
  //   - On a later successful read (clean lockfile): entry re-added.
  it("DISC-05e: 5 consecutive transient reads evict the entry, recovery re-adds it", async () => {
    const lockPath = join(tmpDir, "60005.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60005)).toBe(true);

    const removedSpy = vi.fn();
    const addedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);
    bus.on("ide:added", addedSpy);

    disco._resetTransientCountsForTests?.();

    // Always fail reads for this lockfile. statSync still succeeds (file is
    // present), so each read classifies as "transient".
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath) {
        const err = new Error("EBUSY");
        (err as NodeJS.ErrnoException).code = "EBUSY";
        throw err;
      }
      return readFileSyncImpl.real!(p, "utf8");
    };

    // Scans 1..4 — under threshold. Entry preserved, no eviction.
    for (let i = 0; i < 4; i++) {
      await disco._scanDirForTests(tmpDir);
      expect(
        disco.listAvailableIdes().some((x: { port: number }) => x.port === 60005),
        `DISC-05e: scan ${i + 1} must preserve entry (streak below threshold)`,
      ).toBe(true);
    }
    const removedBefore = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedBefore).not.toContain(60005);

    // Scan 5 — threshold reached. Entry must be evicted.
    await disco._scanDirForTests(tmpDir);
    const removedAfter = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(
      removedAfter,
      "DISC-05e: entry must be evicted after 5 consecutive transient reads",
    ).toContain(60005);
    expect(disco.listAvailableIdes().some((x: { port: number }) => x.port === 60005)).toBe(false);

    // Recovery: a successful read re-adds the entry cleanly.
    readFileSyncImpl.current = null;
    await disco._scanDirForTests(tmpDir);
    expect(
      disco.listAvailableIdes().some((x: { port: number }) => x.port === 60005),
      "DISC-05e: successful read after eviction must re-add entry",
    ).toBe(true);
    const addedPorts = addedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(addedPorts, "DISC-05e: ide:added must fire on recovery").toContain(60005);
  });

  // DISC-05f: counter reset on success. Three transient reads, then a
  // successful read (streak resets), then three more transient reads — total
  // "in-a-row" never reaches the threshold (5). No eviction should occur.
  it("DISC-05f: transient counter resets on a successful read", async () => {
    const lockPath = join(tmpDir, "60006.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60006)).toBe(true);

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    disco._resetTransientCountsForTests?.();

    let failReads = true;
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath && failReads) {
        const err = new Error("EBUSY");
        (err as NodeJS.ErrnoException).code = "EBUSY";
        throw err;
      }
      return readFileSyncImpl.real!(p, "utf8");
    };

    // 3 transient reads — streak=3 (below threshold 5).
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);

    // 1 successful read — streak resets to 0.
    failReads = false;
    await disco._scanDirForTests(tmpDir);

    // 3 more transient reads — streak=3 (still below threshold).
    failReads = true;
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);

    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(
      removedPorts,
      "DISC-05f: counter must reset on success — no eviction when total-in-a-row < threshold",
    ).not.toContain(60006);
    expect(disco.listAvailableIdes().some((x: { port: number }) => x.port === 60006)).toBe(true);
  });

  // ─── DISC-05g/h: transient counter cleared on every ok/missing read ─────

  // DISC-05g: Codex adversarial review — regression guard for the transient
  // counter's cleanup semantics.
  //
  // Previously, `transientCounts.delete(path)` sat AFTER the `isPidAlive()`
  // and `toDiscovered()` checks in scanDir. If a lockfile read cleanly but
  // the PID was dead (or the payload failed `toDiscovered`'s port
  // derivation), scanDir hit `continue` BEFORE the delete ran. The counter
  // was not incremented (the transient branch only runs on non-ok reads)
  // and not reset either — a "stuck at prior value" state.
  //
  // The fix moves `transientCounts.delete(path)` to fire IMMEDIATELY on any
  // `ok` read, before the PID-alive check. A clean file read is itself the
  // signal that resets the streak; downstream validation failures drive
  // reconcile's non-carry-forward path (dead PID => not added to nextKnown
  // => `ide:removed` on reconcile) rather than silently leaving the counter
  // at its prior value.
  //
  // Isolation strategy: use a LIVE PID and valid port so the ok-read adds
  // the entry to `nextKnown` — reconcile then KEEPS it (update, not
  // removal) and does NOT touch the transient counter. This ensures the
  // ONLY code path that can clear the counter is the ok-branch delete
  // inside scanDir (line ~361). If that delete were removed, the counter
  // would remain at 2 after the ok-read and this test would fail.
  //
  // Scenario: stage N transient reads to drive the counter up to N, then
  // on the next scan return a clean payload with a LIVE PID. Expect:
  //   - Entry stays in `known` (reconcile keeps it).
  //   - Counter is cleared (`undefined`) by the ok-branch delete alone.
  it("DISC-05g: ok read with live PID clears the counter (isolated from reconcile)", async () => {
    const lockPath = join(tmpDir, "60007.lock");
    // Seed with THIS process's PID so startIdeDiscovery adds it.
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60007)).toBe(true);

    disco._resetTransientCountsForTests?.();

    // Stage 2 transient reads so the counter sits at 2 BEFORE the ok-read.
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath) {
        const err = new Error("EBUSY");
        (err as NodeJS.ErrnoException).code = "EBUSY";
        throw err;
      }
      return readFileSyncImpl.real!(p, "utf8");
    };
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);
    expect(
      disco._getTransientCountForTests?.(lockPath),
      "DISC-05g precondition: counter must be 2 after staging two transient reads",
    ).toBe(2);

    // Return a clean payload with THIS process's PID (alive) so the entry
    // stays in `nextKnown`. Reconcile will keep it — no eviction, no
    // reconcile-side counter cleanup.
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath) return lockfilePayload({ pid: process.pid, ideName: "Neovim" });
      return readFileSyncImpl.real!(p, "utf8");
    };

    await disco._scanDirForTests(tmpDir);

    // Entry must still be in known (reconcile kept it).
    expect(
      disco.listAvailableIdes().some((i: { port: number }) => i.port === 60007),
      "DISC-05g: entry must remain in known after ok-read with live PID",
    ).toBe(true);
    // Counter must be cleared by the ok-branch delete — reconcile did not
    // evict and therefore did not touch the counter. If the ok-branch
    // delete is removed, this assertion fails (counter stays at 2).
    expect(
      disco._getTransientCountForTests?.(lockPath),
      "DISC-05g: counter must be cleared on ok-read (not masked by reconcile)",
    ).toBeUndefined();
  });

  // DISC-05h: counter must be cleared on `missing` reads inside scanDir's
  // missing branch (line ~320), independently of reconcile's eviction
  // cleanup (line ~424).
  //
  // Isolation strategy: mock `readdirSync` to include a ghost lockfile
  // name ("60009.lock") that does NOT exist on disk. `readLockfileWithRetry`
  // calls `statSync` on the ghost path, gets ENOENT, and returns
  // `{kind: "missing"}`. The ghost path was never in `known`, so reconcile
  // has nothing to evict and does NOT touch the counter — the ONLY code
  // path that can clear it is scanDir's missing-branch delete (line ~320).
  // We seed the counter via `_setTransientCountForTests` before the scan.
  // If the missing-branch delete is removed, this test fails (counter
  // stays at 3).
  //
  // A second part tests the end-to-end behavior: a path that IS in
  // `known` with staged transient reads, then the file vanishes
  // (ide:removed fires, entry is dropped).
  it("DISC-05h: missing read clears counter (isolated from reconcile)", async () => {
    // Part A: counter cleanup isolated from reconcile.
    const lockPath = join(tmpDir, "60008.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60008)).toBe(true);

    // ghostPath does NOT exist on disk — statSync will throw ENOENT,
    // causing readLockfileWithRetry to return {kind: "missing"}.
    const ghostPath = join(tmpDir, "60009.lock");

    // Manually seed a transient counter for ghostPath WITHOUT adding it
    // to `known`. This simulates a counter that was driven up by prior
    // transient reads but the entry was never successfully added.
    disco._setTransientCountForTests?.(ghostPath, 3);
    expect(disco._getTransientCountForTests?.(ghostPath)).toBe(3);

    // Mock readdirSync to include the ghost lockfile name alongside any
    // real files. The ghost file doesn't exist on disk, so statSync
    // inside readLockfileWithRetry will throw ENOENT => {kind: "missing"}.
    readdirSyncImpl.current = (p: string) => {
      const real = readdirSyncImpl.real!(p);
      if (p === tmpDir) return [...real, "60009.lock"];
      return real;
    };

    await disco._scanDirForTests(tmpDir);

    // ghostPath was never in `known`, so reconcile did NOT evict it and
    // did NOT touch its counter. The ONLY code that could have cleared
    // the counter is scanDir's missing-branch delete.
    expect(
      disco._getTransientCountForTests?.(ghostPath),
      "DISC-05h: counter must be cleared by missing-branch delete (not reconcile)",
    ).toBeUndefined();

    // Part B: end-to-end — a path that IS in `known` vanishes.
    readdirSyncImpl.current = null;

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    disco._resetTransientCountsForTests?.();

    // Stage 3 transient reads for the real 60008 entry.
    readFileSyncImpl.current = (p: string) => {
      if (p === lockPath) {
        const err = new Error("EBUSY");
        (err as NodeJS.ErrnoException).code = "EBUSY";
        throw err;
      }
      return readFileSyncImpl.real!(p, "utf8");
    };
    for (let i = 0; i < 3; i++) await disco._scanDirForTests(tmpDir);
    expect(disco._getTransientCountForTests?.(lockPath)).toBe(3);
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60008)).toBe(true);

    // Now the file vanishes.
    readFileSyncImpl.current = null;
    rmSync(lockPath);
    await disco._scanDirForTests(tmpDir);

    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(
      removedPorts,
      "DISC-05h: missing file must emit ide:removed",
    ).toContain(60008);
    expect(
      disco.listAvailableIdes().some((i: { port: number }) => i.port === 60008),
      "DISC-05h: vanished file must be dropped from known",
    ).toBe(false);
    expect(
      disco._getTransientCountForTests?.(lockPath),
      "DISC-05h: counter must be cleared after file vanishes",
    ).toBeUndefined();
  });

  // DISC-06c: streak resets on first successful readdir. Two failures then
  // a success then another single failure must NOT trigger eviction.
  it("DISC-06c: readdir streak resets on first success", async () => {
    const lockPath = join(tmpDir, "60013.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60013)).toBe(true);

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    disco._resetReaddirFailureStreakForTests?.();

    let mode: "fail" | "pass" = "fail";
    readdirSyncImpl.current = (p: string) => {
      if (p === tmpDir && mode === "fail") {
        const err = new Error("EACCES");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      }
      return readdirSyncImpl.real!(p);
    };

    // Use ONLY _scanDirForTests so no extraneous fs.watch callbacks fire
    // with stale mode state. Two failing scans → streak=2.
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);
    // Successful scan — streak resets to 0.
    mode = "pass";
    await disco._scanDirForTests(tmpDir);
    // One more failing scan — streak = 1 (under threshold 3), no eviction.
    mode = "fail";
    await disco._scanDirForTests(tmpDir);

    const removedPorts = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedPorts, "DISC-06c: entry must not be evicted after streak reset").not.toContain(60013);
    // Known snapshot may or may not still have the entry depending on
    // whether the mid-success scan ran through pass-mode (which reads the
    // real lockfile). Either way, no removal event should have fired.
  });

  // DISC-06d: Cubic P2 — `readdirFailureStreak` is module-level state. If
  // `startIdeDiscovery()` is torn down while the streak is non-zero, a
  // subsequent `startIdeDiscovery()` must start with a fresh streak of 0.
  // Otherwise the new session inherits the old streak and can evict IDEs
  // too early (e.g. a single readdir failure in the new session would push
  // a carried-over streak of 2 to 3, crossing the threshold and triggering
  // eviction prematurely).
  //
  // Scenario:
  //   1. Stage 2 consecutive readdirSync failures (streak=2, below
  //      threshold=3, no eviction).
  //   2. Stop the current discovery session (the `stop` function returned
  //      by `startIdeDiscovery`).
  //   3. Start a fresh session.
  //   4. Trigger 1 readdirSync failure.
  //   5. Assert: streak in the new session is 1 (not 3) and no eviction
  //      occurred.
  it("DISC-06d: readdirFailureStreak resets across stop/start cycles", async () => {
    const lockPath = join(tmpDir, "60014.lock");
    writeFileSync(lockPath, lockfilePayload({ ideName: "Neovim" }));

    // Start session #1 — entry is discovered cleanly.
    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60014)).toBe(true);

    const removedSpy = vi.fn();
    bus.on("ide:removed", removedSpy);

    disco._resetReaddirFailureStreakForTests?.();

    // Stage persistent readdirSync failures.
    readdirSyncImpl.current = (p: string) => {
      if (p === tmpDir) {
        const err = new Error("EACCES: permission denied");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      }
      return readdirSyncImpl.real!(p);
    };

    // Two failing scans in session #1 — streak=2, still below threshold=3.
    await disco._scanDirForTests(tmpDir);
    await disco._scanDirForTests(tmpDir);
    expect(
      disco._getReaddirFailureStreakForTests?.(),
      "DISC-06d precondition: streak must be 2 after two failures",
    ).toBe(2);
    // No eviction yet.
    const removedBefore = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(removedBefore).not.toContain(60014);

    // Stop the session. The streak should be zeroed by stopCurrent().
    stop?.();
    stop = null;
    expect(
      disco._getReaddirFailureStreakForTests?.(),
      "DISC-06d: streak must be reset to 0 on stop",
    ).toBe(0);

    // Start a fresh session — entry needs to be re-seeded. Restore
    // readdirSync so the initial sync scan succeeds and re-adds the lockfile.
    readdirSyncImpl.current = null;
    stop = disco.startIdeDiscovery({ ideDir: tmpDir });
    expect(
      disco._getReaddirFailureStreakForTests?.(),
      "DISC-06d: streak must be 0 at the start of a new session",
    ).toBe(0);
    expect(disco.listAvailableIdes().some((i: { port: number }) => i.port === 60014)).toBe(true);

    // Re-install the failing readdirSync mock and trigger exactly ONE
    // failing scan in session #2.
    readdirSyncImpl.current = (p: string) => {
      if (p === tmpDir) {
        const err = new Error("EACCES: permission denied");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      }
      return readdirSyncImpl.real!(p);
    };

    await disco._scanDirForTests(tmpDir);

    // Streak must be 1 (fresh session), NOT 3 (would-be carry-over: 2 + 1).
    expect(
      disco._getReaddirFailureStreakForTests?.(),
      "DISC-06d: new session must see streak=1, not 3, after one failure",
    ).toBe(1);
    const removedAfter = removedSpy.mock.calls.map((c) => (c[0] as { port: number }).port);
    expect(
      removedAfter,
      "DISC-06d: no eviction in new session (streak below threshold)",
    ).not.toContain(60014);
  });

  // ─── SNAPSHOT-01: listAvailableIdes must return a deep-cloned snapshot ─────
  //
  // Cubic round-5 P2 FIX 2. Previously, `listAvailableIdes()` returned a
  // fresh outer array via `Array.from(known.values())` but the entries
  // themselves were shared references into the internal `known` Map. A
  // caller that mutated a returned `DiscoveredIde` (e.g.
  // `result[0].port = 9999`) corrupted the module's internal state,
  // poisoning the next reconcile diff (the prev entry would reflect the
  // caller's mutation, producing false "changed" events or missing
  // removals).
  //
  // The fix returns structurally cloned entries — spread each record and
  // make a fresh copy of the only nested mutable field
  // (`workspaceFolders: string[]`). Flat scalar fields (`port`, `ideName`,
  // `transport`, ...) are safe under spread alone.
  //
  // This test mutates every relevant field on the returned entry then
  // calls `listAvailableIdes()` a second time and asserts the second
  // snapshot matches the originally-observed shape.
  it("SNAPSHOT-01: listAvailableIdes returns immutable snapshots (cubic round-5 P2 FIX 2)", async () => {
    const lockPath = join(tmpDir, "60099.lock");
    const originalWorkspace = ["/Users/test/project"];
    writeFileSync(
      lockPath,
      lockfilePayload({
        ideName: "Neovim",
        workspaceFolders: originalWorkspace,
      }),
    );

    // Seed `known` by driving a scan — after this `listAvailableIdes()`
    // must contain one entry.
    stop = disco.startIdeDiscovery({ ideDir: tmpDir });

    const first = disco.listAvailableIdes() as Array<{
      port: number;
      ideName: string;
      workspaceFolders: string[];
    }>;
    expect(first).toHaveLength(1);
    const originalPort = first[0].port;
    const originalIdeName = first[0].ideName;
    const originalWsLen = first[0].workspaceFolders.length;

    // Mutate the returned entry aggressively — top-level scalars AND the
    // nested array (which is the only non-scalar mutable field on the
    // record). If the implementation returns shared refs, these writes
    // land inside the module's `known` Map and the next call will see
    // them.
    first[0].port = 9999;
    first[0].ideName = "HIJACKED";
    first[0].workspaceFolders.push("/poisoned/path");
    first[0].workspaceFolders[0] = "/mutated";

    const second = disco.listAvailableIdes() as Array<{
      port: number;
      ideName: string;
      workspaceFolders: string[];
    }>;

    expect(second).toHaveLength(1);
    expect(
      second[0].port,
      "SNAPSHOT-01: port must not reflect caller mutation",
    ).toBe(originalPort);
    expect(
      second[0].ideName,
      "SNAPSHOT-01: ideName must not reflect caller mutation",
    ).toBe(originalIdeName);
    expect(
      second[0].workspaceFolders.length,
      "SNAPSHOT-01: workspaceFolders length must not reflect caller push",
    ).toBe(originalWsLen);
    expect(
      second[0].workspaceFolders[0],
      "SNAPSHOT-01: workspaceFolders[0] must not reflect caller mutation",
    ).toBe(originalWorkspace[0]);
    // And a third call still returns a fresh, independent copy.
    const third = disco.listAvailableIdes() as Array<{ workspaceFolders: string[] }>;
    expect(third[0].workspaceFolders).not.toBe(second[0].workspaceFolders);
  });
});
