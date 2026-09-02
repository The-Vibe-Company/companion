# Companion architecture — Skills Hub and optional Companions

This document describes the as-built Runtime v2 architecture. Companion is always a Skills Hub.
Behind the existing Companions feature gate, it also hosts named, persistent Box/Pi teammates
through a dedicated runtime service. The runtime is intentionally narrower than a generic agent
platform: one Companion is one Box, one Pi daemon, and one durable thread. The guarded final cutover
removed the legacy executor surface; it must not be reintroduced.

## System shape

```text
apps/web       Next.js Skills workspace, Companion threads, and settings
apps/api       REST/tRPC authorization and transactional intent persistence
apps/worker    GitHub sync, billing, object cleanup, Companion routines, and APNs delivery
apps/runtime   sole Box/Pi executor; durable claims, health, and lifecycle
cli            REST client for Skills Hub workflows

packages/contracts         shared Zod/API contracts
packages/db                Drizzle schema, forward migrations, RLS, role grants
packages/core              tenant/authz and domain services; no Next.js dependency
packages/skills            package parsing, validation, versioning
packages/skilldb           hosted SQLite execution for declared Skill Databases
packages/storage           archives, releases, images, logos, database objects
packages/github            GitHub App and deterministic repository writer
packages/box-runtime       ascii.dev adapter, layout-14 Pi broker, and default Pi package pins
packages/box-lab           local developer-only real-Linux acceptance behind the Box API contract
packages/companion-runtime runtime state machine and operation execution
packages/companion-skill   bundled delegated Skills Hub workflow
```

The API never contacts Box or Pi. It authorizes, persists a message/turn, decision, settings change,
or lifecycle operation, and responds. `apps/runtime` is the only process with the Box service key
and the only owner of runtime leases or external lifecycle side effects. The worker remains limited
to billing, GitHub, Skill Database cleanup, Companion routines, and APNs delivery.

## Tenancy and authorization

Every tenant-owned row carries `org_id`; `packages/db/src/schema.ts` is the data source of truth.
Every service decision combines exact-organization membership, org-role capability, and resource
ownership/ACL. Forced RLS is defense in depth, not a substitute for service authorization.

The global `profiles` row carries the member's optional IANA timezone because it is personal data
shared across organizations and Companions. `GET /v1/auth/whoami` exposes it and `PUT /v1/users/me`
updates it for web and both native Apple clients. It is never supplied as a client-surface or message header.

Organization skills are member-wide. Personal skills, personal labels, personal Skill Database
realms, and member MCP accounts are creator-only with no Owner/Admin override. Cross-tenant access
fails closed.

A Companion has one immutable Owner and optional workspace-wide Editor or Viewer access. Owner and
Editor may send and operate it; only Owner manages sharing and permanent deletion. Viewer reads
PostgreSQL projections only. Authorization and current resource access are re-evaluated by runtime
immediately before Box contact, so membership or ACL revocation cannot be hidden in a queued turn.

## Skills Hub

Packages are validated without executing scripts. Publication writes immutable version/file
metadata, dependency edges, secret slots, database declarations, and an audit event. Share performs
the only personal-to-org transition and includes required private dependencies after an explicit
plan. Install records are per member and do not copy skill rows.

Public release promotion pins one exact organization skill version and checksum. Upload/download
transfer tickets are short-lived, purpose-specific, non-replayable where required, and revalidated
at redemption. GitHub sync writes deterministic, digest-verifiable repository state.

Skills may declare bounded SQLite tables. Core validates additive schema evolution and access,
`packages/skilldb` executes parameterized statements, and object storage persists realms with
conditional generation checks. The worker cleans queued database objects only.

## Secrets and delegated Agent Auth

Secret plaintext is accepted only on write or rotation, envelope-encrypted, and never returned by
ordinary CRUD. Skill bindings refer to stable slots. External clients retrieve authorized values
only through preflight and short-lived, non-replayable grants. Logs and audit metadata remain
value-free.

Agent Auth connects external coding agents to the Skills Hub. Tenant capabilities are limited to
skill, Skill Database, and skill-secret operations constrained to one exact workspace;
`public-skills:install` remains instance-wide. Agent Auth never grants Companion chat, provider,
desktop, or lifecycle access.

An Agent Auth child PAT snapshots only active exact-workspace grants, caps expiry at seven days and
the earliest source expiry, and stores value-free provenance. Callers cannot choose scopes or
organizations, PATs cannot mint child PATs, and a target-bound token requires the matching declared
target. Possession remains bearer authority until expiry or revocation.

## Companion roster organization

`companion_sections` stores owner-scoped, org-scoped roster groups with a unique normalized name
and explicit position. `companions.section_id` is nullable: null is the built-in Unassigned group.
Only the immutable Companion Owner may create, rename, reorder, delete, or assign their sections;
workspace Admin has no override. Deleting a section atomically clears its members' `section_id` and
never deletes a Companion or changes a runtime revision. Read projections expose a section to the
owner and to members who can already read at least one Companion in it.

The existing member-private roster state also carries `muted`. Muting deletes that member's queued
APNs deliveries for the Companion and prevents future enqueue until unmuted. It does not alter
unread state, thread contents, another member's preference, or Box/Pi state. Both section and mute
writes remain behind actor-scoped `SECURITY DEFINER` capabilities; Agent Auth has no access.

## Runtime v2 write model

Runtime state is explicit and durable:

- `companion_runtime_instances` owns generation, canonical Box id, observed Box/Pi state, layout,
  invocation id, and applied configuration revision.
- `companion_turns` owns `client_message_id`, initiating actor/surface, queue state, inactivity and
  absolute deadlines, and one stable expurgated error.
- `companion_turn_attempts` owns execution lane (`main` or `routine`), historical retry identity, Pi
  invocation, dispatch/acknowledgement, correlated event cursor, and outcome.
- `companion_operations` owns start, stop, Pi restart, Box restart, settings apply, and delete intent
  plus checkpoints. Multiple operations may wait; one may run per Companion.
- `companion_runtime_leases` owns independent `main` and `routine` claim tokens, globally increasing
  attempt epochs, executor ids, and expiries used to fence every checkpoint and settlement.
- `companion_images` owns provider-wide content-addressed image intent, published build status,
  bounded retry state, and the epoch-fenced single-builder lease used only by `apps/runtime`.
- `companion_message_attachments` owns the files one transcript entry carries: `user_upload` for what
  a member sent, `pi_output` for an image Pi handed back, plus the content-addressed storage key,
  resolved content type, size, digest, sanitized filename, and position. Deleting a row journals its
  storage key into the durable object-deletion outbox in the same transaction, so an object cannot
  outlive the entry, the Companion, or the tenant.
- A scheduled routine fire continues to use its routine-origin `companion_turns.id` as the durable
  run id. `companion_routine_run_entries` is the private, no-wake transcript projection for that
  run; read APIs page it by ordinal under entry-count and byte ceilings. `companion_routine_returns`
  is its at-most-one terminal bridge to the main thread. The return row stores only mode and durable
  references; surfaced content exists once, on its ordinary main-thread entry.

All rows are org-scoped and force-RLS-enabled. API, worker, and runtime use distinct
`NOSUPERUSER NOBYPASSRLS NOINHERIT` roles. Runtime claims, renewals, checkpoints, and settlements use
narrow worker-style `SECURITY DEFINER` functions; it receives no general auth or tenant-data grant.
The API keeps RLS-scoped `SELECT` on `companions`, workspace access, member state, threads, and
transcript projections, but their `INSERT`, `UPDATE`, and `DELETE` paths exist only behind the
tenant- and actor-scoped `companion_api_*` capability functions. The worker has no hosted Companion
table access, including provider-connection or member-MCP metadata; it receives only narrow routine
and notification claim/settlement functions.

Companion terminal transitions and new pending decisions fan out durable APNs deliveries inside the
same PostgreSQL transaction. Only active iOS installations belonging to the turn's durable author
are selected, unless that author has muted this Companion. The API registers or removes the current member's installation but never contacts
Apple; runtime only settles turns and never formats or sends a push. The worker revalidates current
membership and Companion access while claiming, leases each delivery, and sends it over persistent
HTTP/2 with an Apple ES256 provider token. Deliveries expire after 24 hours. Success deletes the
row, revoked tokens disable the installation, and transient Apple responses clear the lease with
bounded backoff. The payload contains only a bounded expurgated preview and the versioned
organization/Companion/event navigation tuple. Reply claims additionally project the current
cosmetic icon indexes and Companion name through a versioned worker-only function. The APNs reply
sets `mutable-content`; the native extension renders that closed catalog locally for the system
communication avatar, with no control-plane avatar endpoint or network fetch.

One `(companion_id, client_message_id)` produces exactly one turn. The transaction that stores the
user message also stores that turn. A duplicate POST resolves to the same row. An ambiguous
occurrence is never dispatched again. `retry_id` remains only as historical data on attempts made
before protocol 6.

Turn states are:

```text
queued → starting → dispatching → running ↔ needs_input
                                      └→ succeeded | failed | interrupted | cancelled
```

Only one attempt is active per execution lane. One ordinary main attempt and one isolated routine
attempt may run concurrently; later turns remain ordered within their lane. An interrupted turn
creates one idempotent lane-local `restart_pi + trigger=recovery` cleanup. Its narrow authorization
does not load the old actor, provider/model, Skill, MCP, token, or message material. Runtime first
re-observes the known Box; an absent or provider-archived Box proves the exact invocation no longer
exists, while a live Box requires exact invocation termination. Main cleanup compares the captured
systemd `InvocationID`; routine cleanup uses its run-scoped invocation. A newer invocation is never
stopped. Runtime checkpoints `cleanup_complete`, marks the occurrence `auto_abandoned`, and releases
the lane without staging or replaying its prompt. Cleanup retries with a maximum five-minute backoff
and a fresh fixed ten-minute budget per claim cycle. Backoff still fences a new Start on that lane;
if rolling deployment exposes already-active same-lane work, Runtime reclaims it before cleanup.
Settings revisions accepted during a turn apply after
the routine lane is quiescent and before the next main turn. On a warm Box, configuration is published as
applied only after runtime stages the exact snapshot, restarts Pi, and observes a different idle Pi
invocation; takeover repeats those idempotent steps if their final observation was lost.

Queued routine-origin turns are settled as skipped when their exact routine generation is disabled
or deleted, including the automatic disable after five genuine failures. The database trigger does
this in the same transaction as the routine mutation, preserving the turn/message/history rows and
recording only a bounded expurgated reason with action `none`; these cancellations are neither
retryable failures nor notification events. A ten-minute `SKIP LOCKED` runtime sweep settles stale
queued routine turns before claiming work, and migration 0145 backfills all already-stale routine
rows—including turns whose definition no longer exists. It checks the live Runtime gate epoch so
stale or disabled executors cannot perform cleanup. A claimed cold-start derivative loses live
authorization as soon as its source is skipped; after that main lease is free or expired, bounded
claim-time reconciliation terminalizes the orphan before choosing later work. Ordinary main turns
remain independent of routine attempts.

A blocking `ask_user` decision moves the turn to `needs_input` and clears the
inactivity deadline. An answer resumes Pi; after ten minutes, absence returns a cancelled response
so Pi chooses a safe fallback without inferring approval. A newer member message cancels the wait
sooner, remains an ordinary queued turn, and never supplies an implicit answer. That queued turn has
no attempt or cold-start deadline while its Start prerequisite is waiting. Runtime starts the fixed
three-minute cold-start window only when it first claims that Start, and a takeover preserves it. If
that cycle times out before any prompt can be dispatched, PostgreSQL re-enqueues the same Start with
bounded backoff and a fresh cycle budget while the accepted message remains `queued`.

That decision is gated by shared lifecycle availability. While an isolated routine owns its lane,
material preparation may be revisited but must not stamp a main turn's cold-start deadline or create
its Start derivative. The three-minute budget begins only after the routine lane is quiescent and
main Start can enter scheduling; an acknowledged prompt is thereafter governed only by attempt
deadlines.

The stateless loopback `companion-control` MCP is staged on every ordinary main attempt. Direct
configuration mutations persist desired state and report `apply_pending`; sensitive mutations
persist an asynchronous control request and return immediately. Approval applies once in the API
and may enqueue an ordinary FIFO continuation. Routine and trigger turns never receive this MCP.
Directed peer grants allow bounded text delegations without introducing a Group or Room aggregate.

### Runtime v3 warm-text progression seam

Migration 0159 is the expand half of the Runtime v3 wide refactor. It adds separate
`companion_v3_instances`, `companion_v3_turns`, and retained per-lane lease facts beside Runtime v2.
A v3 Turn owns its command identity, lane, Pi-admission facts, activity cursor, and outcome; there
is deliberately no v3 attempt table or derived Start operation. PostgreSQL owns idempotent
admission, independent `main`/`background` FIFO, and monotonic fence epochs. TypeScript exposes one
deep progression interface—admit, record desired lifecycle, and converge—and keeps claim and
completion choreography in its internal adapter.

Migration 0161 introduced attachment-free warm dispatch. Migration 0163 makes public creation
atomically add the v3 aggregate and thread, so creation returns before Box/Pi work and an immediate
text send is accepted as a queued v3 Turn. `apps/runtime` claims preparation independently, uses the
provider's 24-hour `Idempotency-Key`, checkpoints the canonical Box id before any later lifecycle
work, then records Box-ready, layout, and Pi-ready clocks before warm dispatch. Preparation failure
only records an expurgated, bounded retry on the instance; it creates neither an attempt nor a
derived Start/Wake operation and leaves the head Turn queued.
The API atomically persists the user entry and Turn and returns without Box credentials; the runtime
composition claims only the v3 `main` lane, reauthorizes the actor, dispatches through the existing
Pi transport, records positive admission before `replying`, and projects one assistant result into
the durable thread before ACK and terminal settlement. Legacy aggregates without a v3 projection,
files, routines, and background work remain on their prior paths in this stack. Protocol-3 claims
still fail closed under the shared runtime gate and carry its epoch, so stale executors cannot
project or settle. There is still no v3 attempt table or derived Start operation.

Migration 0162 keeps release measurement on that same Turn instead of adding an observability
attempt model. Acceptance, first/latest claim, Box ready, staging complete, Pi ready, prompt/steer
admission, first correlated activity, and settlement are durable timestamps. Stable dimensions are
limited to `main|background`, `warm|creation|archived_wake`, Box provider, model provider, and model
id. The runtime-only measurement function omits organization, Companion, actor, command, transcript,
URL, credential, provider payload, and Pi-event identities.
`pnpm --filter @companion/runtime acceptance-report [hours]`
reproduces P50/P95 create, preparation, send-to-ACK, wake-to-ACK, and terminalization distributions
plus oldest queue age, stalls, and takeovers. It exits 2 when an ACK is not fully correlated, making
the acceptance-to-ACK chain a release measurement rather than an internal safety timer.

Migration 0160 adds the separate one-shot Runtime v2 purge needed before a later v3 cutover. Its
operator module is dormant: no service composition root calls it. `report` and `purge --dry-run`
only read PostgreSQL, Box/named-snapshot inventory, and the `companion-attachments/` object prefix;
neither mode writes its ledger or loads the secrets master key. Confirmed mode additionally requires
the environment flag and PostgreSQL runtime gate off, neutral v2/v3 leases, the migration advisory
lock, and the exact confirmation phrase before any external effect.

The FK-free purge ledger stores only resource kind/key, bounded evidence, provider operation
identity, terminal state, and expurgated failure text. Remote trigger registrations,
attachment/output objects, named v2 snapshots, build Boxes, duplicate Boxes, and every generation
Box are removed before the final SQL transaction. `404` is successful absence; another failure
leaves all Companion ownership rows intact. A retry skips terminal targets and resumes any recorded
Box operation. `requesting` targets are never blindly replayed: current storage/Box/snapshot
inventory and authenticated provider-specific trigger lookup first prove whether the resource is
present or absent. For Box DELETE, a durable operation id is always polled. Without one, fresh
authenticated absence means the `202` admission was acquired (or the Box was already absent), so
the ledger closes without replay; fresh visibility means the documented immediate-removal boundary
was not crossed and permits a new attempt. Unknown reads fail closed. Known-negative Box failures
return to `discovered` with a bounded backoff. The owner-only runtime enable function takes the same
advisory lock, so it cannot reactivate claims during provider cleanup.

The finalizer deletes the Companion aggregate and all v2 runtime children. It locks preserved
tables and takes the before/after baseline only around that final transaction; normal Skills Hub
activity during provider cleanup therefore does not break resume. The fingerprint covers every
non-Companion table plus reusable encrypted provider, MCP, and
trigger-provider connection tables. Any change to organizations, users, memberships, Skills,
secrets, Skill Databases, billing, audit history, or those connections aborts the transaction.
Completed ledger evidence is immutable. THE-511 builds and verifies this path only; it neither runs
a production purge.

## Dedicated runtime execution

`apps/runtime` sweeps every two seconds, claims with a 30-second lease, renews every ten seconds,
and defaults to eight concurrent executions. PostgreSQL serializes each lane; the process scheduler
tracks exact claims, so one Companion may occupy a main and a routine slot at the same time. Routine
startup observes only its run-scoped broker and never idles or recycles the main Pi. A completed
execution interrupts only the scheduler's backoff sleep so a start can hand its newly idle Pi
directly to the queued turn. `/healthz` fails when PostgreSQL, the claim loop, or the
latest sweep is unhealthy.

Protocol 7 is the claim boundary for cleanup isolation and queue repair. Protocol-6 executors may
finish an already-held lease but receive no new work. Migration 0157 rearms stale or missing cleanup
rows without racing a live lease and removes cold deadlines created before an unclaimed Start.

Main-lane precedence is permanent delete, explicit stop/restart, main decision response, active main
attempt, configuration apply, next main turn, then health observation. The routine lane independently
orders its decision response, active attempt, and next routine turn. Main lifecycle work waits for a
quiescent routine lane without preempting its renewal; permanent delete is the exception: its claim
fences and settles an active/interrupted routine lane, then runtime terminates that exact run-scoped
Pi invocation before contacting the provider. Automatic routine cleanup addresses only that run;
its backoff never delays an independently warm main message.
Lifecycle and broker-observation calls that are known idempotent retry network, `429`, and `5xx`
failures up to five times with jittered 1/2/5/10/30-second backoff. Observation-only broker state
and journal reads also retry `409` while the provider is temporarily transitioning the Box. Every
attempt revalidates the lease before Box contact. Prompt and decision writes never use this path.
When the direct hosted-agent endpoint fails, runtime stays on the safe exec fallback and re-probes
only through broker state with bounded exponential backoff. Reading the same durable endpoint on a
later claim preserves that suspect state; only a newer staging observation or a successful probe
clears it.
Epoch predicates prevent an expired executor from committing after a
replacement claims the work, but database fencing never pretends to fence a provider side effect.

Box identity uses the generation-qualified name `Companion <id> g<generation>`. Known ids are read
and resumed directly; global discovery is reserved for absence, `404`, and ambiguous-create
reconciliation. Before create,
runtime searches every Box-list page for that exact name and adopts one canonical Box. Because the
public create request cannot set a name, Runtime v3 supplies a durable provider `Idempotency-Key`,
checkpoints the acknowledged Box id, then applies the name and
six-hour TTL through an idempotent PATCH. An ambiguous create is interrupted and never replayed.
After naming, runtime lists again and permanently deletes duplicates. Permanent deletion is provider
operation tracking, not stop/archive.

Once Box accepts permanent deletion, runtime never sends that `DELETE` again. Each claim performs
one `GET /deletion-operations/{id}` after reauthorization. `completed` or provider `404` proves
absence and permits atomic removal of the Companion aggregate; `pending`, `processing`, `blocked`,
or an explicitly retryable GET failure atomically returns the same operation to `pending`, releases
its lease, and schedules another claim after 5, 15, 30, then at most 60 seconds based on the durable
attempt count. Invalid responses and non-retryable errors retain the normal expurgated terminal
failure. The protocol-versioned claim entrypoint prevents an older runtime from claiming these rows
during a rolling deploy.

Every prompt write carries the attempt's durable `command_id`. The on-Box broker fsyncs its positive
Pi acknowledgement before answering and serves that exact result through `dispatch_status`. If the
direct HTTP response is lost, runtime spends at most 30 seconds resolving the same command id and
may repeat only that idempotent broker command; an executor takeover performs the same lookup. This
command is durably bound to the Pi invocation observed idle at its write intent, and takeover
refuses a changed instance before network I/O while the broker refuses a stale invocation before
any Pi call. This is resolution of a proven broker fact, not replay of an
ambiguous external effect. If no matching
ledger fact can be recovered, the attempt becomes `interrupted`, no exec fallback or new prompt is
sent, and one cleanup-only internal recovery terminates the exact invocation without loading
message resources or staging Pi. The UI warns that an earlier
external effect may have succeeded; after cleanup, `auto_abandoned` releases later work without
replay.

Immediately before dispatch, runtime adds one fixed-format metadata block to the newest user
message: the attempt's durable `started_at` rendered with an offset plus the initiating member's
IANA timezone pinned on that attempt's first authorized material read. The staged system prompt and prior transcript stay a stable cache prefix; the
changing time therefore lives only in the per-turn suffix. Takeover reconstructs the same bytes
from durable data. Exact seconds are retained because rounding provides no additional prefix-cache
reuse at that position, and an unset profile deterministically falls back to UTC.

Disabling the existing Companions flag blocks new claims. Active work reaches a safe checkpoint and
becomes interrupted. This kill switch is the operational rollback after v2 data exists; a legacy
executor must never process v2 rows.

A normal runtime process shutdown is a replica handoff, not that kill switch. It stops new claims
and local lease renewal without settling active work; the next replica takes over after lease expiry.

## Box and Pi boundary

box.ascii.dev is the only runtime provider and Pi the only agent harness. Runtime creates/resumes the
Box, installs the controlled disk layout, injects authorized resources, and owns stop/restart/delete.
Pi sessions and work files stay on snapshotted Box disk. PostgreSQL stores the durable transcript and
execution projection needed for no-wake reads.

`packages/box-lab` is a test-only implementation of the Box API boundary, not a second product
provider. The same `AsciiBoxMaintenanceClient` and `AsciiBoxCompanionRuntime` send the actual
runtime-generated layout script to isolated Linux: Lima/QEMU `x86_64` for the local VM profile and
an OCI systemd container for local Linux. Linux developers may select Lima explicitly when the host
supports it. The ordinary simulator remains the fast default. Box Lab is intentionally slow,
local-only, and run last after the fast suites; it is not part of CI. Box Lab alone may run the real
service-manager commands, and only inside its guest/container; the host service manager is never
part of a test. A small live canary remains responsible for drift unique to ascii.dev.

Layout 14 installs a small Node broker under systemd between runtime commands and Pi:

- an owner-only Unix socket (`0600`) carries correlated `get_state`, `prompt`, and decision commands;
- a segmented, monotonic event journal survives consumer restart and advances only through explicit
  acknowledgement;
- the broker binds the sole active attempt to events through `agent_settled` and records Pi process
  exit separately;
- malformed or oversized lines advance without persisting their raw content;
- unknown event types are counted and ignored rather than treated as user-fatal errors.

The routine-isolation cutover extends this broker layout without adding a second harness or runtime
owner. A routine-origin turn is serialized by the Companion's `routine` PostgreSQL lease while the
`main` lease may concurrently run an ordinary turn. Runtime launches the same Pi binary with the
same staged tools, skills, plugins, model, and provider material under a run-scoped session directory
and broker socket. The Box runs at most the main daemon plus one routine Pi. PostgreSQL, rather than
the ephemeral Box session directory, is the durable routine-history authority.

The routine table is also the cleanup boundary: disabling or deleting a definition atomically
cancels its queued turns for that generation, and the claim wrapper expires queued routine turns
after ten minutes. Cleanup is bounded and gate-fenced; it retains durable history for skipped runs
and reconciles any already-claimed cold-start derivative only after its main lease is free or
expired, so an orphan cannot retain lifecycle priority or the one-running-operation slot.

Shared Box mutation remains single-owner: settings and lifecycle work other than permanent delete
wait for the routine lane to be quiescent. An interrupted routine is immediately terminal in the
user history, while its automatic cleanup retains only the routine lane until exact
`cleanup_complete` proof. It never blocks independently warm main chat, but shared lifecycle waits
for that cleanup. An explicit Full Box restart or permanent delete may preempt and settle an active
routine occurrence. Runtime terminates its exact run-scoped Pi invocation before the provider
lifecycle call. Routine context is
pinned and read-only; run-local memory cannot write parent memory. A
`relay` return enters the ordinary main queue and does not inherit routine-lane ordering.

The runtime instance and the run-scoped broker intentionally have different Pi invocation
identities. A routine attempt pins its broker identity with the dispatch write intent and uses that
attempt-bound value for event reads, projection, terminal acknowledgement, and cancellation. The
main-instance identity remains reserved for ordinary Companion broker operations.

That run-scoped Pi receives one routine-only terminal tool. Its first accepted call is the run's
return value and immediately shuts down that Pi process. `notify` commits one visible Companion
entry to the main thread and no turn; `relay` commits the same kind of visible entry and an
idempotent ordinary turn that feeds that entry to the main Pi. Neither mode copies the payload into
the private run transcript. A normal settlement without a terminal call is successful
`no_output`. This bridge is atomic and replay-safe: a unique return row makes the first accepted
call win, and no post-return Pi event can create another main-thread effect.

The rollout is deliberately additive: the run/return schema and first-party history readers landed
before the execution switch. New routine runs now always pin their context and execute through the
isolated path; the existing Companions flag remains the operational kill switch. The additive read model
projects a succeeded ordinary-turn reply as a virtual `notify`: its existing final assistant entry
is referenced as the main-thread payload and omitted from the compatibility history transcript, so
it is neither mislabeled `no_output` nor duplicated. Client-only filtering is not an acceptable
final architecture because it would make privacy, unread state, notifications, and future clients
depend on duplicating the same hiding rule.

The isolated routine Pi receives a pinned, content-addressed main-conversation background made from
the latest accepted main-Pi compaction summary plus a deterministic recent transcript tail. This is
runtime-only material, never a public API resource. Its source, 4,000-token budget, refresh rules,
and takeover contract are specified in [Routine Pi context substrate](routine-pi-context-substrate.md).

It also receives a private Box-side snapshot of the parent Companion's regular `MEMORY.md` and
daily-log files through its run-scoped `PI_MEMORY_DIR`. The snapshot has no linked path back to
`~/.companion/runtime/memory`; routine writes remain disposable, while the main Pi stays the only
durable memory writer. qmd also receives a run-local collection config, SQLite index, and explicit
named-index wrapper, keeping memory search on the snapshot rather than the main daemon's collection
or a project-local qmd config. Takeover keeps the already-prepared run root, and later parent-memory
changes appear only in a later routine run.

Staging writes a composed operating brief to `~/.companion/runtime/state/instructions.txt` and Pi
receives it as `--append-system-prompt`. The brief describes the runtime contract Pi is held to —
the thread, the durable disk, turn bounds, tools, routines, triggers, and the ask/propose surface —
including that ordinary assistant text is immediately visible and is reserved for the user-facing
answer rather than tool selection, internal planning, progress narration, or self-talk. Structured
reasoning remains a separate collapsible thread part. Delivery is intentionally concise: an update
is one short sentence, an acknowledgement can be one word, and neither carries process narration,
apology, a `btw` prefix, or filler. These are delivery semantics, not a prescribed voice. The runtime
does not project an assistant `message_end` that contains a Pi tool call; the later no-tool assistant
message is the visible answer, while tool and decision cards keep their own durable projections.
The owner's persona remains one operator-authored line rather than a system prompt, and it is
appended last so it has the final word on voice.

Before `prompt`, runtime requires a correlated `get_state` response showing idle Pi and no queued
messages. It omits Pi `streamingBehavior`, so a race is refused rather than hidden as a follow-up.
Only explicitly supported terminal event shapes settle a turn.

Runtime projects an event batch and its monotonic cursor atomically. Supported settlement and
process-exit events also persist their terminal checkpoint in that transaction; broker
acknowledgement happens only after commit. A takeover first acknowledges any already-durable
terminal cursor, then settles from the checkpoint, which makes replay safe across the projection,
acknowledgement, and settlement crash boundaries.

Pi catalog normalization preserves the model `input` capabilities. Image work sent to a text-only
model fails explicitly with a stable capability error. Capability data comes from Pi's catalog or a
bounded bundled fallback, plus bounded curated supplements for released models Pi has not published
yet. When a selected supplement is also absent from the pinned Pi release, material staging writes
an exact `~/.companion/pi/models.json` custom-model snapshot with its provider transport and input
capabilities. Other selections stage an empty provider map, clearing any obsolete override. The
override is removed when the pinned Pi catalog publishes the model, so Pi's native same-id metadata
wins; there is no global learned capability table.

## Resources and credentials

First-party Companion starts resolve the actor's currently accessible selected Skills and member MCP
accounts through the same API contract. Runtime revalidates every id before staging. Empty selection
means no library Skills or member MCP pins; the bundled Companion skill remains the Skills Hub
bridge. The iOS app authenticates email credentials directly or completes Google OAuth in the
member's default browser, then keeps the same secure Better Auth cookie contract; new Google accounts may join a
domain-matched organization or create a minimal workspace before entering the product. The iOS app
does not introduce a client identifier as a product-capability or authorization boundary. Companion
ownership is not a resource-access fallback: an Editor cannot stage an
Owner's personal Skill or MCP account, and an Owner cannot stage an Editor's. A cross-actor decision
is deliverable only when both actors can access the attempt's resources.

Native iOS treats authorized PostgreSQL projections as a local-first read model. A protected,
backup-excluded SQLite database is scoped by organization plus member and stores the latest roster
projection and a bounded transcript tail per Companion. Cached projections may render offline but
never authorize a mutation: cached thread capabilities are forced read-only until a fresh response.
`GET /v1/companions/sync`, `GET /v1/companions/:id/thread-window`, and
`GET /v1/companions/:id/thread-delta` accept opaque, versioned, scope-bound cursors. Opening a thread
returns at most the newest 50 entries and 1 MiB; older pages use the same bounds and do not advance
the unread watermark. A per-thread monotonic projection sequence lets each delta query only the at
most 200 changed entries after its cursor, including deletion tombstones, and `has_more` makes new
clients drain a burst immediately. The web mounts at most three pages. The API never contacts Box
or Pi. One legacy digest comparison upgrades an old cursor to sequence v2; malformed and cross-scope
cursors fail closed.
Thread entry identity is `event_id`: if an authorized historical projection contains tied ordinals,
the delta preserves every distinct event and orders the tie by event id instead of rejecting the
refresh. Native iOS also retries a server `400` cursor rejection once without the cursor.
Foreground activation and APNs `content-available` invalidation reuse these same endpoints rather
than introducing a mobile-only capability contract.

Provider connections and member MCP accounts are workspace/member-scoped, envelope-encrypted, and
write-only. Runtime decrypts only the selected values after authorization. Durable Box config uses
references where possible. Static connector values use the owner-only runtime channel. OAuth refresh
tokens never leave the control plane; OAuth access tokens reach only a loopback gateway's memory and
the one outbound request it is forwarding. They never appear in user-facing responses, logs, audit
metadata, projections, or durable Box files. The provider auth file remains on Box disk only where
Pi itself must refresh the model provider connection.

Native iOS also opens curated plugin authorization in the member's default browser. The existing
callback URI, signed state, and PKCE exchange remain unchanged. The authenticated start response
provides the exact callback origin and signed state; a narrowly scoped Universal Link returns that
callback to the app only when both match the pending flow. The client holds the short-lived callback
cookie and binding only in memory, does not follow the callback's final redirect, and validates the
original 303 Location against that same origin, `/companions`, and exactly one OAuth result marker.
Production uses the committed `thecompanion.sh` AASA/entitlement; a custom HTTPS origin is accepted
only when the authenticated start response supplies it, while local HTTP loopback cannot deliver an
Apple Universal Link and the production-signed app makes no general self-hosted-domain claim.

PostgreSQL distinguishes the latest available selected-Skills revision from the minimum revision
required before dispatch. A publication advances only the available revision, so waking a Box
reuses its installed immutable version snapshot. Explicit selection and invalidation changes remain
blocking. User Stop, Restart Pi, Full Box restart, and settings apply stop Pi before atomically
replacing the tree. A failed publication update preserves the old tree and does not block lifecycle.

Every Companion may also call the Skills Hub API itself, with the same scopes: skills read/write,
secret reads, and Skill Database read/write. Access is unconditional, so no surface asks anyone to
choose it, neither creation nor settings carries a grant field, and Pi cannot propose one. Staging
mints a short-lived `source_type = 'companion'` token acting as the settings actor, injects it as
`COMPANION_DELEGATION_TOKEN` through the transient runtime channel, and rotates it on every stage.
Each request re-checks that the Companion still exists for that member, so deleting the Companion or
removing the member refuses it immediately; `/v1/companions*` remains cookie-only.

An attempt pins the exact provider and MCP credential revisions before prompt dispatch. A takeover
that observes a later generation interrupts an already-accepted attempt instead of interpreting
unprojected events with a different connection. A terminal projection already committed is read
through a separate fenced metadata-only function, then ACKed and settled without credential
material. For each selected OAuth account, staging writes only its account id, stable credential
generation, and pinned HTTPS MCP URL. It mints a six-hour `cmp_mcp_*` capability bound to that
Companion, actor, and exact account refs. The Pi broker starts an ephemeral loopback-only HTTP
gateway before Pi and points `pi-mcp-adapter` at that gateway.

Before forwarding a request, the gateway asks `POST /v1/runtime/mcp-access-token` for a usable
access token, caches it in memory only until an adaptive margin proportional to its lifetime, and
coalesces concurrent renewals. The endpoint accepts only `cmp_mcp_*`, revalidates the active
Companion, membership, account owner, current plugin selection, and stable credential generation,
and answers `private, no-store`. Sessions, ordinary PATs, Agent Auth, other Companions, and
unselected accounts cannot use it. An explicit upstream `401` before any MCP response byte forces
one refresh and one retry. Timeouts, disconnects, redirects, and other ambiguous outcomes are never
replayed.

Slack follows the same selected-account boundary without pretending Slack's user-token MCP endpoint
is a Bot User integration. API owns the fixed Slack OAuth v2 authorize and token endpoints. For a
selected Slack account, the loopback gateway terminates a small stateless MCP surface and maps only
`slack_chat_post_message` to `https://slack.com/api/chat.postMessage`; it accepts bounded
conversation IDs, text, and optional thread fields, disables unfurling, expurgates provider errors,
and never automatically replays an ambiguous send. The deployment's Slack client secret is
API-only. Receiving Slack events requires the separate signed webhook/trigger design and is not
enabled by this send surface.

Gmail uses a deployment-owned Google web OAuth client distinct from Better Auth sign-in and pins
Google's Developer Preview remote at `https://gmailmcp.googleapis.com/mcp/v1`. The account requests
`gmail.readonly` and `gmail.compose`, but the loopback gateway exposes only `search_threads`,
`get_message`, `get_thread`, `list_drafts`, `list_labels`, and `create_draft`. It filters
`tools/list` and rejects every other `tools/call` before token vending or upstream contact, so
Google adding a send or mailbox-mutation tool cannot silently expand Companion authority.

Sentry pins the official hosted remote at `https://mcp.sentry.dev/mcp` and uses its dynamic OAuth
client registration. The member completes Sentry's own capability approval; Companion stores only
the resulting encrypted labeled account and stages it through the same loopback token gateway as
the other OAuth MCP remotes. Issue payloads, event context, breadcrumbs, tags, and request/user
values are external untrusted data. The staged `plugin-sentry` skill tells Pi to investigate with
the narrowest available organization/project scope and to make triage or project changes only on
an explicit request.

Git uses a credential helper and `gh` uses an audited wrapper; each command asks the same loopback
gateway, so neither `GITHUB_TOKEN` nor `GH_TOKEN` is persisted in the Box environment or on disk.
OAuth refresh updates the encrypted envelope with a credential-version CAS while keeping the
connection generation stable. When Google's token endpoint positively confirms a Gmail
`invalid_grant`, API deletes that exact stored connection before returning the expurgated refresh
failure; ambiguous or transient refresh failures retain it. Deleting and reconnecting the plugin
creates a new account identity and generation.

Staging records the earliest bounded expiry across the Skills Hub token and MCP broker capability,
not OAuth access tokens. That expiry becomes active only after a different idle Pi invocation is
observed. A warm non-native send
dispatches directly only while the snapshot is bound to the current Pi invocation and has more than
two hours and five minutes remaining. Eligibility is checked both at enqueue and again under the
runtime lease immediately before claim; otherwise the ordinary `start` operation restages and
recycles Pi without a Full Box restart. Changing the observed invocation or minting a replacement
Hub token invalidates the old proof before another turn can use it.
Migration 0110 versions the Runtime claim entrypoint. Replicas from before 0110 retain their
current lease but the legacy four-argument claim returns no new work after the migration commits.
Migration 0120 advances the six-argument material protocol to version 2, so protocol-1 replicas
also stop claiming during the OAuth-gateway rollout. The current claimer repairs an expired legacy lease by rewinding any
post-staging operation or settings checkpoint that has no staged-expiry ledger, then restages under
the new fence. This prevents a rolling deploy from either publishing an unproven snapshot or
repeating proof-less start operations.
Migration 0138 advances that material protocol to version 3 before routine dispatch begins. A
routine attempt now persists a versioned invocation reservation before Box start; protocol-2
replicas receive no new claims and therefore cannot resume that write intent with the former
generate-on-start behavior. Existing leases may still finish through the unchanged fenced APIs.
Projection
redaction uses every string leaf of the validated plaintext material in memory plus generic
credential patterns. Tool projections retain an opaque hashed call id and disclose a redacted,
bounded title plus arguments, progress, or result excerpt behind the existing detail control. Pi's
canonical `args`/`result` events and serialized OpenAI-compatible function-call envelopes cross the
same projection boundary; the adapter never chooses the persistence policy. Once a call id has
established a card, later projections cannot replace its kind or name. A delegated `subagent`
run keeps its specialized child-agent name, task, and latest-progress presentation. Generic
scrubbing removes complete Authorization and Cookie header values
before narrower token/assignment matchers run. Redacted or oversized decision identifiers are
rejected fail-closed.

Persisted runtime failures contain a stable code, an expurgated message no longer than 500
characters, and an allowed next action. Provider response bodies, raw Pi lines, tokens, auth files,
signed URL queries, and multiline diagnostics never enter the database or user response.

## API and web contract

The feature gate requires both `COMPANION_COMPANIONS_ENABLED=true` and the existing non-empty exact
email-domain allowlist. Without both, routes and navigation are absent and runtime claims are off.

`POST /v1/companions/:id/messages` persists message plus turn and returns `202` without Box contact.
It also accepts multipart: up to five files of at most 10 MB each are stored under their content
address before the same transaction persists their rows, so an accepted turn always names files that
already exist. `GET /v1/companions/:id/attachments/:attachmentId` serves those bytes, re-authorizing
on every request and contacting only PostgreSQL and object storage. Thread reads add the active turn,
queued count, interruption state, and each entry's attachment metadata — never a storage key or URL. Existing lifecycle paths
persist operations and return `202`; decision answers are durable and runtime-delivered. Config
proposals (`kind: config` plus a bounded `proposal` object) dispatch to
`companion_api_answer_config_decision` after the route validates `model_id` against the provider
catalog. The web thread shows a dedicated config card that names the Companion as proposer, lists
diffs from already-loaded skill/plugin/model names, and keeps the card pending when apply fails.
`POST /v1/companions/:id/turns/:turnId/retry` remains wire-compatible for old clients: it only
observes or re-enqueues the exact automatic cleanup and never creates another turn attempt.
`POST /v1/companions/:id/turns/:turnId/cancel` remains the explicit stop/dequeue path for active or
queued work and returns the stable state without mutation for terminal interruptions.

Native iOS composer dictation uses
`POST /v1/companions/:id/transcriptions`. The route requires current Owner/Editor access before
reading the body, accepts exactly one sniffed `audio/mp4` file up to 8 MB, and uses the API-only
`COMPANION_GEMINI_TRANSCRIPTION_API_KEY`. The API reads at most 12 recent durable user/assistant
entries within a 24,000-character budget, serializes them as explicitly untrusted reference data,
and sends that reference plus the audio in one user request to the fixed `gemini-3.7-flash` model.
Transcript entries are never projected as provider dialogue roles, so instruction-shaped text in
history cannot acquire instruction authority. The prompt requires verbatim original-language transcription and
allows history only to resolve names, references, terminology, punctuation, and language; it must
not answer, continue, summarize, or implicitly translate the conversation. Low thinking and a
bounded text output keep the request focused.

The iOS client records 16 kHz mono AAC locally and uploads only after Stop. The deployment-owned key
enables the capability for every workspace; thread reads expose only a boolean availability bit so
clients omit the control when the key is absent. The API returns only the final transcript and never
stores, logs, or projects the audio, bounded context copy, provider request, or raw response. Failed
provider calls emit only the structured process event
`api.companion_transcription.provider_failure`, a safe category (`transport`, `4xx`, `5xx`, or
`invalid_response`), and the numeric HTTP status when Google returned one. The event never carries
the key, request URL, response body, thrown provider diagnostic, member identity, Companion identity,
conversation text, or audio. This shared, capability-named endpoint is not a client-surface
discriminator; another first-party client could adopt the same contract later.

The API temporarily retains `POST /v1/companions/:id/transcription-sessions` with its constrained
legacy response so already-installed native builds remain functional while the new API is deployed
before the new client. The current client does not call that endpoint and receives no provider token.
Remove the compatibility route only after the legacy native build is outside the support window.

`POST /v1/hooks/triggers/:triggerId/:secret` fires a webhook-fired Companion trigger — the
event-driven sibling of a routine. Like the Stripe webhook it is registered before session
middleware, gated on the feature flag, and capped at 1 MB; the URL secret is compared with
`timingSafeEqual`, and there is deliberately no per-provider HMAC because the sources are services
the user controls. First-party creation registers supported remote webhooks with a member-scoped
trigger-provider connection that is available to every Companion without an attachment step. OAuth
connections reuse the existing encrypted MCP credential in place; manual URL copying is only the
fallback for sources with no registration API. Pi trigger proposals carry no provider-account id:
approval resolves the approving member's sole eligible connection, tolerates unavailable ids only
for legacy pending proposals, and refuses to choose when several accounts are eligible.
The route persists an isolated validation run as the immutable Companion Owner through
`companion_api_fire_trigger` and never contacts Box or Pi. Runtime evaluates the bounded untrusted
payload against the trigger prompt in a disposable Pi session with only `surface_to_main` enabled;
MCP, provider-tool credentials, skills, and project context are absent. It then either stays silent, surfaces a notify entry, or surfaces a
relay entry plus an ordinary main-Pi turn. A delivery id derived from
provider headers, or from the body hash, collapses redeliveries to one turn; disabled, throttled,
and pileup fires are skipped without enqueuing.

The web retains polling: three seconds while activity is present, slower when settled. There is no
SSE or Box push agent. “Companion is replying…” derives only from an acknowledged, non-terminal
attempt; the companion read model carries the same ACK-gated fact as `runtime.replying`, so roster
surfaces animate a working Companion without a thread read. Viewer/list/thread/status reads remain
PostgreSQL-only.

Personal settings on web and the native Apple clients offer a searchable IANA timezone picker initialized from
the browser or device zone when no value has been saved. The same stored value drives routine
creation and all routine-next-fire and trigger-last-fire presentation. Routine rows retain and show
their own cron timezone as server truth while absolute activity instants are formatted for the
member; triggers remain event-driven and have no schedule timezone.

The web and native Apple routine rows expose run history, and a routine-origin thread marker carrying
`run_id` is a compact button rather than a message bubble. Both clients use only the bounded
routine-history APIs, list newest runs first, distinguish notify, relay, silent, pending, and error
outcomes, and page the private transcript forward by ordinal. A deleted routine remains directly
readable from its marker because the run id and identity snapshot are durable. An interrupted run
shows passive terminal history, exposes no replay/cancel control, and does not block main chat.
Viewer sees the same expurgated read-only status.
Web presents a
responsive right-side drawer that traps focus, uses a scrim and Esc dismissal, and takes the full
chat stage on a phone; iOS uses native navigation from Connected Resources and a modal navigation
stack from the marker. Neither client contacts or wakes Box.

Each Companion carries a cosmetic blob icon — four smallint indexes (`icon_shape`, `icon_mouth`,
`icon_accessory`, `icon_color`) into fixed client-side catalogs rendered as inline SVG. Create and
update accept them; the update path treats them as cosmetic only, so an icon save never bumps a
settings revision or contacts Box. The web animates the icon from the same durable signal as
“Companion is replying…”, never from lifecycle guesses.

Desktop minting remains an Owner/Editor action that cannot wake Box. The API authorizes the member,
then calls a private runtime endpoint with a short-lived HMAC request. Runtime revalidates the
Companion and returns the fresh provider URL only after the current actor owns every selected
personal resource and applied settings/Skills revisions satisfy required state. A publication-only
Skills update may remain pending. This gate
keeps a warm Box unavailable during a cross-actor restage. Each authenticated request id is
atomically consumed through a narrow `SECURITY DEFINER` function and retained in PostgreSQL until
its signature window expires, so replicas and restarted processes share one replay boundary;
neither process persists or logs the URL.

The native macOS client in `apps/macos` reuses `CompanionKit` and the same complete `/v1` contract.
Its roster and chat use a macOS `NavigationSplitView`, platform toolbars, menus, hover/focus states,
and keyboard commands rather than scaling the iOS navigation stack. Computer use opens the same
fresh Lux desktop handoff in a dedicated `WKWebView` window; the secret-bearing URL remains
memory-only, each reconnect remints it, and Viewer or asleep-Box states expose no desktop control.

Sending is the sole normal wake path. There is no Wake button or first-keystroke prewarm. Successful
Pi acceptance refreshes Box TTL to six hours. Ambiguous-turn cleanup only terminates the captured Pi
invocation; it never resumes or restarts the Box and never stages or starts Pi. Full Box
restart requires explicit confirmation; it re-observes the known Box and, if already archived,
skips impossible Pi stop commands before resuming it. Permanent delete is cleanup rather than healing.
Before a new prompt write intent, a stale active-attempt binding or unacknowledged broker tail causes
one Pi-only recycle and a fresh idle proof; failure to obtain that proof remains an actionable
`restart_pi` error and no prompt is dispatched.

## Legacy purge and rollout

Runtime v2 does not backfill legacy ordinals, transcripts, Companions, or Boxes. Before cutover, an
operator runs a one-shot command in report, dry-run, then
`purge --confirm-delete-all-companions` mode with the feature flag disabled and an advisory lock.

The purge inventories DB `box_id` ownership and exact legacy naming formats, prints the targets,
requests permanent Box deletion, records the provider operation id, and waits for completion. A
provider `404` means already deleted; every other error blocks cutover. Only after external deletion
is confirmed may PostgreSQL remove legacy Companions, pools, shares, member state, threads,
transcripts, and leases. Provider connections, MCP accounts, Skills, secrets, organizations, users,
billing, and audit rows survive.

The stacked rollout temporarily retained old runtime columns without backfilling them. The final
migration removes those columns together with every old executor, watermark, pool, reconciler,
mutating purge function, and legacy grant. The release process admits that migration only after
confirming there is no open P0/P1 runtime issue and the purge report is empty. The provider-operation
ledger remains owner-readable cutover evidence.

The feature flag remained disabled between purge and the asynchronous API/web cutover. Once v2 rows
exist, rollback uses the kill switch rather than a legacy binary; no legacy executor may process
them.

## Explicit exclusions

No generic Projects or skill runs, multi-Bot coordination, group Bot chat, handoffs, proactive jobs,
Companion voice conversation or runtime audio, file library, file versioning, artifact surface outside a thread, second harness, second Box
provider, Box pool, generic provider marketplace, container catalog, deployment manager, or AI app
builder. Native client dictation that transiently converts microphone audio into editable composer
text is not a voice turn and never reaches Box or Pi. Bounded chat files, scheduled Companion
routines, and webhook-fired Companion triggers are in scope.
No SSE, Box-to-control-plane push agent, detached API executor, automatic Full Box recovery,
automatic ambiguous-prompt replay, or global learned model-capability table.

## Deployment

Self-hosted deployments run PostgreSQL, S3-compatible storage, email, API, worker, runtime, and web.
Only runtime receives `COMPANION_BOX_API_KEY`; its desktop endpoint binds a private network. API,
worker, and runtime use separate database credentials and least-privilege grants. Conductor and CI
must start the same four-process topology with the deterministic Box/Pi simulator by default.
Conductor additionally exposes an opt-in local Box Lab run; simulator and Lab share workspace port
offset `+8` and are mutually exclusive. Box Lab runs the same generated Pi installation inside a
local Lima VM or contained OCI systemd guest rather than contacting ascii.dev or the host service
manager. It is a deliberately slow final local validation and does not run in CI. This test
infrastructure changes neither the production provider nor the Companion capability contract.
The as-built operational sequence, including the owner-only gate transition and rollback boundary,
is documented in `docs/runbooks/companions-runtime.md`.
