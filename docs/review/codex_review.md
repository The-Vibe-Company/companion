# Codex Deep Review

Review scope: `feat/merge-yajin-local`, focused on the merge from the locally maintained Companion at `/home/ubuntu/my_workspace/tool/my_companion`. Telegram support was intentionally excluded and was treated as a non-goal.

Review method: module-by-module source review, targeted diff/history checks, local static checks, and verification of the fixes that landed after the previous review. This document intentionally records findings only; no business code was changed.

## Executive Summary

The branch is substantially healthier than the previous review state. The concrete sensitive-write symlink bypasses that were called out earlier have been fixed, `~/.agenthangar` was removed from the sensitive-write allowlist, the stale managed-auth `/ws/cli/*` bypass is gone, heartbeat `mcp_get_status` no longer fills the server replay queue for dead sessions, and the Telegram implementation remains excluded.

The remaining issues are less about one obvious broken merge and more about architectural hardening:

- filesystem authorization is inconsistent between the general fs routes, Claude config routes, and sensitive-write route
- sensitive-write is improved, but its validation/write sequence is still not atomic under a hostile concurrent workspace
- session relaunch state has an edge case after intentional kills
- a duplicate, non-runtime session creation service is drifting away from the orchestrator path
- AskUserQuestion can submit incomplete multi-question answers
- `deadcode:check` currently fails on unused code/imports

## Security And Filesystem

### Medium: sensitive-write is fixed for known symlink cases, but not atomic against TOCTOU

Files:

- `web/server/routes.ts:821`
- `web/server/routes.ts:851`
- `web/server/routes.ts:874`
- `web/server/routes.ts:901`
- `web/server/routes.test.ts:920`

Status: previous concrete findings fixed; one hardening gap remains.

The recent fixes are meaningful:

- allowed roots are now only `session.cwd` and `~/.claude`; broad `~/.agenthangar` write access was removed
- existing-target leaf symlinks are rejected by realpath-prefix validation
- dangling leaf symlinks are rejected by `lstatSync(filePath)`
- intermediate symlink directories that escape the sandbox are rejected
- regression tests cover these cases, including the dangling symlink case at `web/server/routes.test.ts:1017`

The remaining issue is that validation and writing are still separate filesystem operations. The route validates the real path and leaf state, then later calls:

```ts
mkdirSync(dirname(filePath), { recursive: true });
writeFileSync(filePath, content, "utf8");
```

Between `lstatSync(filePath)` and `writeFileSync(filePath)`, another local process can replace the leaf with a symlink. Between parent validation and `mkdirSync(..., { recursive: true })`, a newly-created parent component can also change. This is a time-of-check/time-of-use gap. It is not easily triggerable by ordinary UI use, but this route exists specifically to bypass Claude Code's own sensitive-file guard, so it should be treated as a security boundary.

Recommendation:

- open the target with a no-follow strategy where supported, for example `openSync` with `O_NOFOLLOW`
- validate the real parent immediately before open
- avoid `mkdir -p` across unchecked multi-component paths, or create and validate each parent component inside the allowed real root
- add a best-effort race regression or a focused unit around the final write primitive, even if full TOCTOU exploitation is not deterministic in CI

### Medium: Claude config fs routes bypass the path guard used by the rest of fs-routes

Files:

- `web/server/routes/fs-routes.ts:61`
- `web/server/routes/fs-routes.ts:294`
- `web/server/routes/fs-routes.ts:370`
- `web/server/routes/fs-routes.ts:419`
- `web/server/routes/fs-routes.ts:580`

The generic fs endpoints use `guardPath()` with allowed bases of `homedir()` and `process.cwd()` by default. However, several related endpoints accept caller-provided `cwd` or `path` and do not apply the same guard:

- `GET /fs/changed-files` resolves arbitrary `cwd` and runs fixed git commands there
- `GET /fs/claude-md` resolves arbitrary `cwd` and reads `CLAUDE.md` / `.claude/CLAUDE.md`
- `GET /fs/claude-config` resolves arbitrary `cwd` and reads project Claude config files plus user Claude files
- `PUT /fs/claude-md` allows writing any path ending in `/CLAUDE.md` or `/.claude/CLAUDE.md`

The commands are not shell-injectable in the obvious branch-name sense, and the server is normally local/token-protected. Still, this creates a policy mismatch: `/fs/read?path=/etc/passwd` is blocked, while `/fs/claude-md?cwd=/some/outside/repo` or `PUT /fs/claude-md` can operate outside the same allowed-base contract if the process has permissions.

Recommendation:

- use one shared path policy for all fs routes
- apply `guardPath` or a stronger realpath-based variant to `cwd` before git/config discovery
- restrict `PUT /fs/claude-md` to discovered project/user Claude files, or require the target to be under an allowed real root
- add tests for outside-base `cwd`, outside-base `CLAUDE.md` writes, and symlink escapes

### Low/Medium: generic fs guard is string-prefix based and follows symlinks afterward

Files:

- `web/server/routes/fs-routes.ts:9`
- `web/server/routes/fs-routes.ts:152`
- `web/server/routes/fs-routes.ts:172`
- `web/server/routes/fs-routes.test.ts:99`

`guardPath()` uses `resolve(raw)` and a string prefix check. That catches `../` traversal, and tests cover normal outside-base reads/writes. But the route then calls `stat()` and `readFile()`, both of which follow symlinks. A symlink inside an allowed base that points outside the allowed base can therefore make `/fs/read` or `/fs/raw` read outside the intended sandbox.

For a local project browser this may be acceptable if the intended policy is "anything reachable from home/project." If the policy is truly "only real paths under these bases," this needs the same realpath discipline as sensitive-write.

Recommendation:

- decide the intended product policy explicitly
- if real-root containment is required, replace string-prefix checks with realpath checks and add symlink tests

## Auth And Exposure

### Fixed: managed-auth no longer bypasses obsolete `/ws/cli/*`

Files:

- `web/server/middleware/managed-auth.ts:10`
- `web/server/middleware/managed-auth.ts:27`
- `web/server/middleware/managed-auth.test.ts:105`

The previous stale unauthenticated `/ws/cli/*` exemption is fixed. Managed auth now bypasses only `/health`, and the regression test asserts `/ws/cli/abc-123` is not bypassed.

This is the right architecture after the stdio migration: the browser/terminal/noVNC WebSockets remain server-owned surfaces, while Claude no longer connects back to `/ws/cli/:id`.

## Session Lifecycle And Backend Bridge

### Medium: explicit relaunch does not clear prior intentional-kill state

Files:

- `web/server/session-orchestrator.ts:133`
- `web/server/session-orchestrator.ts:242`
- `web/server/session-orchestrator.ts:264`
- `web/server/session-orchestrator.ts:700`
- `web/server/session-orchestrator.ts:826`

`intentionalKills` is used to prevent proactive keepalive from relaunching sessions that were deliberately stopped, such as idle-kill, hang-detected, archive/delete, or permanent spawn-abort cases. Auto-relaunch clears this marker after a successful relaunch at `web/server/session-orchestrator.ts:910`.

The explicit user relaunch path does not clear it:

```ts
async relaunchSession(sessionId: string) {
  ...
  this.clearAutoRelaunchCount(sessionId);
  ...
  return this.launcher.relaunch(sessionId);
}
```

In the default `AGENTHANGAR_LAZY_SPAWN_ONLY` mode, this is mostly hidden because proactive relaunch is disabled. But if `AGENTHANGAR_LAZY_SPAWN_ONLY=0`, a session that was idle-killed or hang-killed, then manually relaunched, can still be remembered as intentional. A later real crash may be ignored by proactive keepalive because the old kill intent was not cleared.

Recommendation:

- clear `intentionalKills` on successful explicit relaunch
- add a regression test: mark a session intentional, call explicit relaunch with success, emit a later exit, and verify proactive relaunch is eligible again when lazy mode is off

### Fixed: backend heartbeat no longer queues forever when no backend is connected

Files:

- `web/server/ws-bridge.ts:1104`
- `web/server/ws-bridge.test.ts:1905`

The bridge now drops `mcp_get_status` when `session.backendAdapter?.isConnected()` is false. That is the right layer: heartbeat/status probes have no replay value, while real user messages still keep their reconnect semantics.

### Low: frontend outgoing queue has no cap

File:

- `web/src/ws.ts:404`

The server-side pending message queue has caps and now drops dead-session heartbeats, but the frontend `pendingOutgoingBySession` queue is unbounded. This is lower risk because it is in-memory and mostly user/action driven, but a disconnected session with repeated sends can grow without limit.

Recommendation:

- mirror the server queue policy with a small cap and a visible "not connected" failure for non-idempotent sends

## Session Creation Architecture

### Medium: there are two session creation implementations, and one is not on the runtime path

Files:

- `web/server/session-orchestrator.ts:310`
- `web/server/session-creation-service.ts:70`
- `web/server/session-creation-service.test.ts:149`

Runtime session creation goes through `SessionOrchestrator.doCreateSession()`. `executeSessionCreation()` in `session-creation-service.ts` is only imported by its own tests, not by production code.

The duplicate implementation is already divergent. For example, the orchestrator injects global provider tokens from settings:

- `CLAUDE_CODE_OAUTH_TOKEN` for Claude
- `OPENAI_API_KEY` for Codex

The standalone service does not do that. It also has its own copies of env, sandbox, Linear, worktree, and container setup logic.

Impact:

- tests for `session-creation-service.ts` can pass while the actual runtime creation path breaks
- future maintainers may patch one path and leave the other stale
- migration work from local Companion becomes harder to reason about because there is no single source of truth for session creation

Recommendation:

- either delete the unused service and move useful tests to the orchestrator, or make the orchestrator delegate to the service
- keep exactly one implementation for env merge, auth preflight, container setup, worktree setup, and backend launch

## Frontend Permission And UX Logic

### Medium: AskUserQuestion can submit incomplete multi-question answers

Files:

- `web/src/components/AskUserQuestionDisplay.tsx:87`
- `web/src/components/AskUserQuestionDisplay.tsx:203`
- `web/src/components/PermissionBanner.tsx:102`
- `web/src/components/AskUserQuestionToolBlock.tsx:71`

For multi-question AskUserQuestion input, the submit button appears as soon as at least one answer exists:

```tsx
questions.length > 1 && Object.keys(selections).length > 0
```

`handleSubmitAll()` then sends the partial `selections` object. That means a two-question prompt can be submitted after answering only the first question. The downstream permission path and regular tool-use path both forward that partial answer set.

Impact:

- the model may receive incomplete human input while the UI implies "Submit answers"
- permission-gated AskUserQuestion can resolve too early
- tests cover full multi-answer flow, but not the incomplete-submit case

Recommendation:

- require `Object.keys(selections).length === questions.length` before enabling submit, unless partial answers are an intentional feature
- if partial answers are intentional, label the action accordingly and include missing-answer handling in the formatted response
- add tests for incomplete multi-question state

### Low: sensitive file approval copy/comment still mentions `~/.agenthangar`

File:

- `web/src/components/SensitiveFileWriteApproval.tsx:25`

The backend no longer allows sensitive-write into `~/.agenthangar`, but the component comment still says the server sandboxes to `session.cwd + ~/.claude/* + ~/.agenthangar/*`. This is not visible UI text, but it is stale maintainer guidance in a security-sensitive component.

## Documentation And Migration Cleanliness

### Fixed: top-level architecture docs mostly reflect stdio

Files:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`

The top-level docs now describe the current model: browser WebSocket to Companion, and Companion stdio NDJSON to Claude/Codex child processes. This resolves the major stale-architecture issue from the prior review.

### Low: some historical or stale transport references remain

Files:

- `docs/guides/sessions-and-permissions.mdx:28`
- `web/CODEX_MAPPING.md:18`
- `web/server/cli-launcher.ts:1261`
- `web/scripts/spike-stdio-protocol.ts:3`

Some remaining references are valid historical notes or migration-spike comments. Others are live-doc confusing, especially `docs/guides/sessions-and-permissions.mdx`, which still says the server spawns Claude with `--sdk-url`.

Recommendation:

- keep historical notes only where they explain a migration decision
- update live documentation and live-path comments to say stdio/backend adapter/child process instead of CLI WebSocket

## Telegram Exclusion

Status: clean.

I did not find the local Telegram implementation in this branch:

- no `web/server/tg-bot`
- no `grammy` imports
- no Telegram config store or setup CLI
- no Telegram command handlers

Remaining `tg-1`-style strings are Playground/mock tool group IDs, not Telegram support.

## Code Quality And Test Health

### Medium/Low: `deadcode:check` currently fails

Command:

```bash
cd web && bun run deadcode:check
```

Current failures are unused fields/imports/parameters, including:

- `web/server/cli-launcher.ts:332` unused `port`
- `web/src/analytics.ts` unused noop parameters
- `web/src/components/Composer.tsx` unused `sessionMessages`
- `web/src/components/PermissionBanner.tsx` unused `ComponentProps`, `Markdown`, `remarkGfm`

These are not runtime blockers, but this repository exposes the check as a script and it is useful for merge hygiene. The unused imports in `PermissionBanner` also suggest remnants from an earlier Markdown-rendering implementation.

### Low: duplicate-code check passes threshold but shows real consolidation targets

Command:

```bash
cd web && bun run dry:check
```

The check exits successfully under the configured threshold, but reports duplicated hot spots in:

- session/agent execution flows such as `agent-executor.ts` and `cron-scheduler.ts`
- Linear route blocks
- frontend editor/composer/sidebar components

This is not a must-fix before merge, but the duplicate session creation service should be treated more seriously than normal UI repetition because it duplicates runtime architecture.

## Validation

Run during this review:

- `cd web && bun run typecheck` passed
- `cd web && bun run test` passed: 197 test files, 5098 tests
- `cd web && bun run deadcode:check` failed on unused code/imports listed above
- `cd web && bun run dry:check` passed threshold

## Recommended Fix Order

1. Harden fs route policy: align Claude config routes and generic fs routes around a shared realpath-based boundary.
2. Make sensitive-write atomic enough for a hostile workspace, or document the remaining TOCTOU risk as accepted.
3. Clear `intentionalKills` after successful explicit relaunch and test lazy-off behavior.
4. Remove or unify the unused session creation service.
5. Fix AskUserQuestion incomplete multi-submit behavior.
6. Clean dead code and remaining stale transport comments.
