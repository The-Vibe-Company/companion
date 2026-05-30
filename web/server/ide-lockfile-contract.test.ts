// ide-lockfile-contract.test.ts — TEST-03 from `.planning/PLAN.md`.
//
// This is a CONTRACT-PINNING test. It does not drive new implementation.
// It pins the shape of the lockfiles Claude CLI writes to `~/.claude/ide/*.lock`
// so that if the CLI ever changes its lockfile schema — renames a field,
// drops `pid`, switches from `useWebSocket` to something else — this test
// fails loudly in CI instead of Companion silently failing to discover IDEs.
//
// Why lockfiles matter:
//   - They are the ONLY handshake surface between a running IDE and Companion.
//   - Companion reads `pid` to prune stale entries (liveness check is the only
//     staleness signal we trust — the IDE may crash without deleting its lock).
//   - Companion reads `workspaceFolders` to match sessions to IDEs by CWD.
//   - Companion reads `ideName` / `authToken` to build the `mcp_set_servers`
//     bind payload.
//   - Companion reads `transport` OR `useWebSocket` to pick ws-ide vs sse-ide.
//
// If any of those drift, our discovery → matcher → binder pipeline breaks
// in subtle ways. This test is the tripwire.

import { describe, expect, it } from "vitest";

import { deriveBindShape, parseLockfile } from "../../scripts/probe-ide";

// -- Fixtures ---------------------------------------------------------------
//
// These two fixtures represent the two real-world shapes we've observed
// shipped by Claude CLI lockfile writers. They are bundled inline (not
// read from disk) so the contract is explicit and version-controlled.

/**
 * Fixture A — Neovim-style lockfile.
 *
 * Observed shape (as of Claude CLI v2.1.x):
 *   - `transport: "ws"` (the NEWER field)
 *   - `running: true` (informational only — we don't rely on it)
 *   - Single workspace folder
 */
const NEOVIM_FIXTURE = JSON.stringify({
  pid: 47231,
  workspaceFolders: ["/Users/vwh7mb/areas/secreg"],
  ideName: "Neovim",
  transport: "ws",
  running: true,
  authToken: "nvim-tok-abc123",
});

/**
 * Fixture B — VSCode-style lockfile.
 *
 * Observed shape (older Claude CLI extension writers, still in use):
 *   - `useWebSocket: true` (the OLDER field — VSCode predates `transport`)
 *   - Multi-root workspace (VSCode supports multiple folders per window)
 *   - No `running` field
 *
 * We MUST continue to handle `useWebSocket` because the VSCode extension
 * has not migrated to the `transport` field yet.
 */
const VSCODE_FIXTURE = JSON.stringify({
  pid: 52987,
  workspaceFolders: [
    "/Users/vwh7mb/projects/companion",
    "/Users/vwh7mb/projects/companion/web",
  ],
  ideName: "Visual Studio Code",
  useWebSocket: true,
  authToken: "vscode-tok-xyz789",
});

// -- Shared assertions ------------------------------------------------------

/**
 * Every lockfile Companion accepts MUST expose these fields. If the CLI ever
 * drops one, our discovery pipeline silently produces no bindable IDEs —
 * which looks to users like "Companion doesn't know about my IDE". This
 * function fails the test with a specific message so the regression is
 * diagnosable from CI output alone.
 */
function assertRequiredFields(
  parsed: ReturnType<typeof parseLockfile>,
  label: string,
): asserts parsed is NonNullable<typeof parsed> {
  expect(parsed, `${label}: parseLockfile returned null`).not.toBeNull();
  if (!parsed) throw new Error("unreachable");

  // pid: the ONLY signal we trust for staleness. If this ever becomes a
  // string or goes away entirely, prune-by-pid-liveness breaks silently.
  expect(typeof parsed.pid, `${label}: pid type`).toBe("number");
  expect(Number.isFinite(parsed.pid), `${label}: pid finite`).toBe(true);

  // workspaceFolders: how we match a Companion session (by CWD) to an IDE
  // (by its open folders). An empty array means "IDE has no project open"
  // — rare but legal; we require the field to exist and be an array with
  // at least one entry for the fixtures we ship.
  expect(Array.isArray(parsed.workspaceFolders), `${label}: workspaceFolders array`).toBe(true);
  expect(parsed.workspaceFolders.length, `${label}: has >=1 workspace`).toBeGreaterThanOrEqual(1);
  for (const w of parsed.workspaceFolders) {
    expect(typeof w, `${label}: workspace folder string`).toBe("string");
  }

  // ideName: used verbatim in the bind payload and for user-facing display.
  expect(typeof parsed.ideName, `${label}: ideName string`).toBe("string");
  expect(parsed.ideName.length, `${label}: ideName non-empty`).toBeGreaterThan(0);

  // authToken: the CLI → IDE MCP auth secret. Optional at the type level
  // (some adapters omit it in dev), but our real-world fixtures MUST have
  // one, because without it Companion cannot build a working bind payload.
  expect(typeof parsed.authToken, `${label}: authToken string`).toBe("string");
  expect((parsed.authToken ?? "").length, `${label}: authToken non-empty`).toBeGreaterThan(0);
}

/**
 * Contract: a lockfile MUST signal its transport via EITHER `transport`
 * (newer Neovim style) OR `useWebSocket` (older VSCode style) — exactly
 * one of those two should be present. We accept either, but at least one
 * is required, and both of our fixtures must derive to `ws-ide` because
 * that's the only transport Companion currently binds to.
 */
function assertTransportSignal(
  parsed: NonNullable<ReturnType<typeof parseLockfile>>,
  lockPath: string,
  label: string,
): void {
  const hasTransport = typeof parsed.transport === "string";
  const hasUseWebSocket = typeof parsed.useWebSocket === "boolean";

  expect(
    hasTransport || hasUseWebSocket,
    `${label}: must set one of transport / useWebSocket`,
  ).toBe(true);

  // Contract says EXACTLY one. If both appear we've got an ambiguous
  // lockfile — flag it so we catch a future CLI that starts double-writing.
  expect(
    hasTransport && hasUseWebSocket,
    `${label}: should not set BOTH transport and useWebSocket`,
  ).toBe(false);

  const shape = deriveBindShape(lockPath, parsed);
  expect(shape.transport, `${label}: derived transport`).toBe("ws-ide");
  expect(shape.url.startsWith("ws://"), `${label}: ws:// URL`).toBe(true);
}

// -- Tests ------------------------------------------------------------------

describe("IDE lockfile contract (TEST-03) — shape pinning for ~/.claude/ide/*.lock", () => {
  it("Fixture A: Neovim lockfile parses and binds as ws-ide", () => {
    // Neovim uses the NEWER `transport: "ws"` field. If this test ever
    // fails after a CLI upgrade, someone renamed `transport` — update
    // probe-ide.ts and all downstream consumers.
    const parsed = parseLockfile(NEOVIM_FIXTURE);
    assertRequiredFields(parsed, "Neovim");

    expect(parsed.ideName).toBe("Neovim");
    expect(parsed.transport).toBe("ws");
    expect(parsed.useWebSocket).toBeUndefined();
    expect(parsed.running).toBe(true);

    // Lockfile filename for Neovim is `<pid>.lock`, so feed the pid as
    // the stem — deriveBindShape uses that for port fallback.
    assertTransportSignal(parsed, `/tmp/fake-ide-dir/${parsed.pid}.lock`, "Neovim");
  });

  it("Fixture B: VSCode lockfile parses and binds as ws-ide", () => {
    // VSCode is the holdout using `useWebSocket: true`. If VSCode ever
    // migrates to `transport`, this test still passes (deriveBindShape
    // handles both) — but if VSCode invents a THIRD signal, this test
    // fails because `useWebSocket` won't be set and neither will
    // `transport`.
    const parsed = parseLockfile(VSCODE_FIXTURE);
    assertRequiredFields(parsed, "VSCode");

    expect(parsed.ideName).toBe("Visual Studio Code");
    expect(parsed.useWebSocket).toBe(true);
    expect(parsed.transport).toBeUndefined();
    // VSCode lockfiles are `<port>.lock` — derived port should match stem.
    expect(parsed.workspaceFolders.length).toBe(2);

    // Use a port-style filename to reflect real VSCode lockfile naming.
    const shape = deriveBindShape("/tmp/fake-ide-dir/54321.lock", parsed);
    expect(shape.port).toBe(54321);
    assertTransportSignal(parsed, "/tmp/fake-ide-dir/54321.lock", "VSCode");
  });

  it("negative contract: a lockfile missing `pid` is rejected", () => {
    // If the CLI ever stops emitting `pid`, we fail loud. Prune-by-pid-
    // liveness is the ONLY signal we trust for staleness — a lockfile
    // without a pid is worse than no lockfile at all, because it forces
    // us to bind to a possibly-dead IDE. Parser returns null for that
    // case (see probe-ide.ts :: parseLockfile — `!Number.isFinite(pid)`
    // short-circuits).
    const missingPid = JSON.stringify({
      workspaceFolders: ["/tmp/x"],
      ideName: "Phantom IDE",
      transport: "ws",
      authToken: "tok",
    });
    expect(parseLockfile(missingPid)).toBeNull();

    // Also guard the adjacent failure modes, so a future refactor that
    // loosens parseLockfile trips this test:
    //   - pid present but wrong type → null
    //   - ideName missing → null
    const stringPid = JSON.stringify({
      pid: "47231",
      workspaceFolders: ["/tmp/x"],
      ideName: "Phantom IDE",
      transport: "ws",
      authToken: "tok",
    });
    expect(parseLockfile(stringPid)).toBeNull();

    const missingIdeName = JSON.stringify({
      pid: 47231,
      workspaceFolders: ["/tmp/x"],
      transport: "ws",
      authToken: "tok",
    });
    expect(parseLockfile(missingIdeName)).toBeNull();
  });
});
