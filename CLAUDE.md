# Contributor guidance

Companion is a self-hostable, multi-tenant **Skills Hub at its core**, with an optional
Companions control plane. When Companions are enabled, each Companion is one named teammate with
one persistent box.ascii.dev Box, one Pi daemon, and one durable chat thread. Read
`docs/vision.md`, `docs/product.md`, `docs/design.md`, `docs/PRD.md`, `docs/testing.md`, root
`DESIGN.md`, and `docs/companions-runtime.md` before non-trivial Companion or runtime changes.

The project is built for **ZERO USER FRICTION**: Companion does everything end-to-end on the
user's behalf. Users never paste URLs, never configure webhooks manually, and never touch provider
consoles for work Companion can do with credentials it already holds.

## Domain vocabulary

- Tenant hierarchy: **Organization → User**; organization roles: **Owner, Admin, Developer**.
- Skills use `scope: personal | org`. Personal skills are creator-only with no admin override.
  Organization skills are manageable by every member.
- Share is the sole owner-only, one-way `personal → org` transition.
- Organization and personal label trees organize skills without changing access.
- External coding agents are delegated Skills Hub clients. They are not hosted Companions and
  Companion never launches them through Agent Auth.
- A hosted Companion has an immutable Companion **Owner** and optional workspace-wide **Editor** or
  **Viewer** access. Owner/Editor may send and operate it; Viewer reads control-plane projections
  only and never contacts Box.
- A **turn** is the durable result of one accepted `client_message_id`; a **turn attempt** is one
  explicit dispatch try; an **operation** is durable lifecycle intent such as start, stop, restart,
  settings apply, or delete.

Do not introduce generic Projects or skill runs, multi-Bot orchestration, agent-to-agent handoffs,
voice, another agent harness, another Box provider, or a deployment platform. Scheduled Companion
routines are in scope: they enqueue ordinary turns as the immutable Companion Owner and never
contact Box or Pi from the worker. Webhook-fired Companion triggers are in scope: the API webhook
route only persists an ordinary turn as the immutable Companion Owner and never contacts Box or
Pi. Chat files are in scope and bounded: a member may attach images
and documents to a message, and Pi may hand back images it leaves in its outbox. Nothing else is
an artifact — there is no file library, no versioning, and no artifact surface outside the thread
the file was sent in. Pi remains the only harness and box.ascii.dev the only runtime provider. Keep
the existing Companions feature flag and email-domain allowlist; do not add flags that can enable an
excluded product surface.

## Architecture anchors

- `packages/db/src/schema.ts`: tenant and runtime data source of truth.
- `packages/core/src/authz.ts`: membership, RBAC, personal-skill privacy, and Companion ACLs.
- `packages/core/src/services.ts`: shared skill domain services.
- `packages/skills`: package parsing, validation, versioning.
- `packages/skilldb`: hosted declared SQLite state.
- `packages/box-runtime`: ascii.dev transport, Box disk layout, and the Pi broker integration.
- `packages/box-lab`: local developer-only Box API test double backed by isolated real Linux; it is
  neither a product runtime provider nor a replacement for `packages/box-sim`.
- `packages/companion-runtime`: Runtime v2 state machine and durable execution engine.
- `apps/runtime`: the only process allowed to claim runtime work or contact Box/Pi.
- `packages/db/runtime-role-grants.sql`: split API, worker, and runtime grants.
- `apps/worker/src/supervisors.ts`: GitHub, billing, Skill Database cleanup, and Companion routines.
  Routine fire is API-level turn persistence; the worker never contacts Box or Pi.
- `apps/api/src/agentAuthRoutes.ts`: skill-facing delegated client approval.

## Invariants

- TypeScript, pnpm workspaces, Turborepo, Drizzle, and tRPC plus REST. Authentication uses Better
  Auth; object storage is S3-compatible.
- `packages/core` has no Next.js dependency. Shared contracts belong in `packages/contracts`.
- Every tenant row/query is scoped by `org_id`; RLS is defense in depth.
- Secrets are envelope-encrypted, write-only, referenced by id, and never logged or returned as
  plaintext.
- The project is built for zero user friction: Companion completes provider-trigger registration
  end to end. Users never paste callback URLs or configure remote webhooks manually; triggers reuse
  the same consented, encrypted credentials as the matching MCP plugin.
- The control plane never executes skill package scripts. Archives and transfer tickets remain
  fail-closed.
- Public releases pin an exact immutable version and checksum.
- Desired GitHub mirrors and Skill Database cleanup are idempotent.
- Frontend work follows root `DESIGN.md`.
- Every Companion plugin in `COMPANION_PLUGIN_CATALOG` must ship with its provider mark (logo):
  add the SVG path to `MARK_PATHS` in `apps/web/src/components/companions/PluginMark.tsx` and its
  tile colors in `companions.css`. The provider union type makes a missing mark a build failure.
- The API authorizes and persists runtime intent, then returns. It never calls Box or Pi and never
  owns a runtime lease.
- `apps/runtime` is the sole lifecycle owner. The API and worker have no Box credential; runtime
  receives the Box key and only narrow `SECURITY DEFINER` claim/renew/checkpoint/settle access.
- One `(companion_id, client_message_id)` creates exactly one turn. Only one attempt may be active
  per Companion; later turns remain ordered in PostgreSQL.
- An ambiguous dispatch is never replayed automatically. It becomes `interrupted`; protocol 5
  enqueues one internal `restart_pi` recovery, terminates the exact Pi invocation, records
  `resolution = auto_abandoned`, and releases that lane. Recovery retries with bounded backoff and
  never requires an Owner/Editor action.
- Full Box restart is an explicit user action only. Automatic repair may recycle Pi but never
  restart, replace, archive, or delete a healthy Box as healing.
- Runtime errors persist only a stable code, an expurgated message of at most 500 characters, and an
  allowed action. Never persist provider payloads, tokens, signed URLs, or raw Pi lines.

## Conductor

Use `.conductor/settings.toml`. Setup installs PostgreSQL 17 plus `lsof` with `dnf` in cloud
workspaces, or PostgreSQL 17 plus optional MinIO/Mailpit with Homebrew locally, then runs
`corepack enable && pnpm install`. Run executes `bash scripts/dev-conductor.sh`; archive executes
`bash scripts/dev-conductor.sh archive`.

The native Conductor stack starts per-workspace PostgreSQL plus optional MinIO and Mailpit under
`.conductor-pg/`, then API, worker, runtime, and web in one process group. Ports derive from
`CONDUCTOR_PORT`: web `+0`, API `+1`, PostgreSQL `+2`, MinIO API `+3`, console `+4`, SMTP `+5`,
Mailpit UI `+6`, and private runtime `+7`; `+8` is shared, mutually exclusively, by the
deterministic Box/Pi simulator and Box Lab.
Cloud workspaces use base `3000`. Internal services, including runtime, bind loopback; cloud web
alone binds `0.0.0.0`. Cookies and the runtime desktop HMAC key are workspace-specific. Missing
MinIO disables uploads; missing Mailpit falls back to logged email. The launcher gives the Box key
and runtime database URL only to `apps/runtime` without changing the published web/API port contract.

Port `+8` is shared, mutually exclusively, by the simulator and Box Lab. `auto` remains the default:
it uses a configured live Box key or otherwise the simulator; explicit `sim`, `live`, and `lab`
modes are available. The local-only Conductor run `Dev (real Pi VM, slow)` selects `lab`: one
Lima/QEMU `x86_64` Linux VM per Box, with real systemd and Pi. Setup never installs Lima or QEMU
automatically; run `pnpm box:lab:doctor` for prerequisites. Conductor archive asks Box Lab to
remove only resources owned by the exact workspace. Box Lab is intentionally absent from CI because
its full real-Linux acceptance is slow; run it locally as the final validation after the fast suites.

## Companions Runtime v2 contract

- An Owner/Editor send persists the message, its attachments, and the turn atomically and returns
  `202` in under one second outside load; a send carrying files is bounded by the upload it performs
  first. Sending is the only normal wake action; there is no Wake button and no first-keystroke
  prewarm.
- Turn states are
  `queued → starting → dispatching → running ↔ needs_input → succeeded|failed|interrupted|cancelled`.
  “Companion is replying…” is true only after Pi acknowledges the current attempt and before its
  terminal settlement.
- The runtime re-evaluates membership, Companion ACL, selected Skills, plugins, and provider access
  immediately before Box contact. Revoked authority fails closed.
- Pi must be idle with no queued messages before prompt dispatch. The layout-14 broker correlates
  the single active attempt through `agent_settled`; unknown events are counted and ignored, while
  only supported terminal shapes settle a turn.
- Staged Pi instructions (`composedInstructions()` in `packages/box-runtime`, written to
  `~/.companion/runtime/state/instructions.txt` and passed as `--append-system-prompt`) are how Pi
  learns what this runtime actually provides. A Companion capability is not shipped until that brief
  names it: web, subagents, memory, files/outbox, skills, plugins, the Skills Hub, ask_user,
  propose_config, request_plugin_connection, routines (`propose_routine`), and triggers
  (`propose_trigger`). Interpolate the real
  constants rather than literals. First-party clients share one Companion API and capability
  contract; the iOS app must not request reduced staging through a client-surface discriminator or
  invent mobile-only endpoints. Do not describe a capability the Box does not have. Voice stays in
  the persona line.
- A turn stalls after ten minutes without correlated activity and has a two-hour absolute deadline.
  A timed-out or ambiguous turn becomes visible while automatic recovery resolves its exact Pi
  invocation; it never appears to reply forever and the ambiguous prompt is never replayed.
- The compatibility Retry endpoint observes or re-enqueues the same internal recovery operation; it
  never creates a new attempt. Cancel remains the explicit stop/dequeue path for active or queued
  work.
- Box stays warm for six hours after successful Pi acceptance. Reads, lists, ordinary status, and
  Viewer access are PostgreSQL-only and never wake or observe Box directly.
- Disabling the Companions flag stops new runtime claims. Active work reaches a safe checkpoint and
  becomes interrupted. Re-enabling is the operational rollback; old executors must never process v2
  rows.
- Legacy Companions, transcripts, runtime state, and Boxes are purged fail-closed before v2 cutover;
  they are not migrated. Encrypted provider connections and member MCP accounts survive.

## Tests and completion

- Follow `docs/testing.md`; prefer behavior-level coverage.
- Authorization matrices must cover non-members, cross-tenant access, actor revocation, and
  no-admin-override privacy.
- Runtime work requires deterministic Box/Pi simulation, real PostgreSQL lease/fencing tests, and
  fault injection before and after every external side effect and durable checkpoint. The simulator
  remains the normal fast suite.
- Changes to Pi installation/layout, bundle pins, Box lifecycle adapters, or the Lab itself also run
  `pnpm box:lab:smoke` locally as the final validation after the fast suites. Box Lab is intentionally
  slow and not part of CI. It must execute the runtime-generated script inside Lima `x86_64` or a
  local OCI systemd container; never run `systemctl`, `loginctl`, `journalctl`, or destructive
  lifecycle commands against the developer host.
- Use `pnpm e2e:box-runtime-change` only as the credentialed live provider canary. It checks
  ascii.dev-specific drift; it is not the development feedback loop for Pi installation.
- Frontend changes require `APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` plus manual
  `agent-browser` checks for changed paths.
- Changes under `packages/companion-skill/skill/` require a version bump, top changelog entry, and
  `pnpm --filter @companion/companion-skill update:integrity`.
- Run `pnpm verify:change`; exit 2 means printed follow-up gates are still required.
- Every required CI test must protect an identifiable product promise at the lowest layer that
  proves it. Apple Quality is capped at five minutes; its iOS path runs only `CompanionKit`
  behavior tests plus a generic iOS Simulator build, while the conditional skill path retains the
  Darwin-only private-transport guard. Never boot a simulator or run XCUITests in that gate. Keep
  UI validation local and manual unless the repository owner explicitly approves a separate CI job.
- Never install or invoke `xcodebuildmcp` in CI. Apple CI uses native `swift test` and `xcodebuild`;
  reserve XcodeBuildMCP for local interactive agent work.
- Before adding a GitHub Actions workflow, CI job, required check, or trigger, obtain explicit
  approval from the repository owner.
- Architecture/data/auth/API/runtime changes must keep `docs/design.md`,
  `docs/companions-runtime.md`, and the bundled Companion skill aligned. A new Companion capability
  also updates `composedInstructions()` so Pi is told it exists.
- PR titles use Commitizen style, for example
  `feat(runtime): add the dedicated Companion runtime service`.
