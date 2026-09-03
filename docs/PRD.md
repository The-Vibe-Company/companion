# Companion PRD — Skills Hub and optional Companions

## Goal

Give organizations one secure, self-hostable place to govern reusable AI coding skills and,
optionally, assign work to persistent hosted Companions. Skills remain the product core. The hosted
runtime succeeds when every accepted message reaches a reply, a decision, an explicit error, or an
explicitly recoverable interruption even after the browser, API, or one runtime replica disappears.

## Skills Hub requirements

### Identity and tenancy

- Better Auth, organizations, memberships, Owner/Admin/Developer RBAC, invitations, and
  tenant-scoped queries.
- Billing changes for runtime capacity are outside this program; existing Skills Hub entitlements
  remain unchanged.

### Skill lifecycle

- Personal and organization libraries with workspace-unique slugs.
- Safe ZIP upload, browser authoring, manifest validation, immutable versions, archive/restore,
  rename, and one-way Share.
- Dependencies, labels, comments, Activity, install/update reporting, and local inventory.
- Pinned public releases and safe package downloads for verified sessions, approved Agent Auth
  tickets, and exact `public-skills:install` PATs.
- GitHub App synchronization and REST/CLI workflows.

### Skill capabilities

- Write-only skill secrets with audience/recipient controls, stable bindings, redaction, preflight,
  and one-time redemption grants.
- Declared hosted Skill Databases with organization and personal realms, additive schemas,
  parameterized statements, and explicit personal-realm shares.
- Delegated Agent Auth limited to skills, Skill Databases, public installs, and skill secrets.
  Connected clients are external consumers, never hosted Companions.
- Short-lived child PATs inherit only the server-computed active exact-workspace Agent Auth grant
  snapshot; callers cannot choose broader scopes or organizations.

## Optional Companions requirements

### Product and access

- `COMPANION_COMPANIONS_ENABLED` and the existing exact email-domain allowlist gate every route and
  navigation entry. Disabled blocks new runtime claims.
- A Companion is one immutable Owner, optional workspace-wide Editor/Viewer access, one durable
  thread, one persistent Box, and one Pi daemon.
- Owner and Editor may send, answer `ask_user`, update allowed settings, and request runtime actions.
  Only Owner may share or permanently delete. Viewer reads PostgreSQL-only projections and never
  contacts Box.
- Creation selects one connected Pi provider, one validated model, selected Skills, optional
  write-on-behalf, and selected member MCP accounts. Provider and MCP credentials stay write-only.
- The product-owned plugin catalog includes Slack Bot User OAuth. A selected labeled Slack account
  exposes only a bounded `chat.postMessage` MCP tool for channels, direct messages, and threads;
  receiving Slack events remains a separate trigger increment.
- A member profile carries one optional IANA timezone shared by every workspace and first-party
  client. Web and native iOS detect their local timezone as the initial picker value and persist an
  override through the same profile endpoint; clients do not send a per-message timezone header.

### Durable turns and lifecycle

- `POST /v1/companions/:id/messages` persists the message and turn atomically, idempotent on
  `(companion_id, client_message_id)`, then returns `202` without contacting Box.
- Turn states are
  `queued → starting → dispatching → running ↔ needs_input → succeeded|failed|interrupted|cancelled`.
  One occurrence is active in each `main` or `background` lane; later turns remain FIFO within their lane
  in PostgreSQL.
- An ambiguous occurrence is never replayed. Protocol 7 enqueues resource-independent cleanup of
  only the captured Pi invocation, preserves the original error, and marks the occurrence
  `auto_abandoned` only after durable `cleanup_complete` proof. Cleanup retries automatically with
  bounded backoff; first-party clients expose no Retry/Cancel controls for the interruption. The
  compatibility Retry route only observes or re-enqueues the same cleanup and never creates an
  attempt. Cancel remains the active/queued stop path.
- A dedicated `apps/runtime` service is the only Box/Pi lifecycle owner. Durable operations,
  checkpoints, leases, and attempt epochs let another replica continue after a crash without
  accepting stale settlements.
- Runtime revalidates membership, Companion ACL, selected Skills, plugins, and provider access
  before each Box interaction. A configuration change during a turn applies after settlement and
  before the next turn.
- The curated Gmail plugin uses a labeled member OAuth account to search/read mail and create drafts
  for review. It never sends or mutates the mailbox in v1; runtime enforces that boundary with an
  exact MCP tool allow-list rather than relying on the broader `gmail.compose` scope.
- The curated Sentry plugin uses a labeled member OAuth account and Sentry's official hosted MCP
  remote to inspect issues, events, traces, releases, and debugging context. Captured provider data
  is external untrusted data; any triage or project-management write remains explicit and limited
  to the capabilities the member approved in Sentry's OAuth flow.
- Sending is the only normal wake action. There is no Wake button and no first-keystroke prewarm.
  After Runtime v3 cutover, the persistent Box archives one hour after the latest positively
  admitted member message or due background occurrence. Reads, status polling, Viewer access, and
  composer activity neither wake it nor extend that window; the next admitted occurrence resumes
  the same Box and completes current staging before Pi receives work.
- Pi-only recycle is the automatic repair. Full Box restart and permanent deletion are explicit,
  confirmed user operations; deletion is cleanup, never healing.

### Companion control MCP and collaboration

- Every ordinary main attempt receives a short-lived, attempt-fenced `companion-control` MCP
  capability through the loopback gateway. Pi never receives its bearer token in the environment.
- Identity, short persona, Skills, existing plugin attachments, and deferred Pi recycle are direct.
  Model, OAuth, every routine/trigger mutation, and directed peer access use durable asynchronous
  approval cards. Approval and retries are idempotent.
- OAuth completion attaches the new account to the requesting Companion and queues a FIFO resume.
- A source Owner may approve a persistent directed grant only when they can also operate the target.
  Delegations are text-only, depth four, twenty per root turn, and return as `notify` or `relay` in
  both threads. Groups and Rooms remain out of scope.
- Routine and trigger turns cannot call the control MCP.

### Routines

- A Companion may have at most ten named routines. Each has a full cron expression, an IANA
  timezone, and a prompt of at most 16,384 characters. Names are unique per Companion
  (case-insensitive). Fires must be at least five minutes apart.
- Creation and every mutation are Owner/Editor approved: the context panel writes directly, while Pi
  uses `companion_request_routine_change` and receives an asynchronous decision card. Viewer reads
  the panel and cards but cannot write.
- The worker claims due rows and fires as the immutable Companion Owner. Fire is API-level turn
  enqueue; the worker never contacts Box or Pi. The message id is deterministic
  (`uuidv5(routineId|scheduledFor)`), so at-least-once ticks collapse to one turn.
- A newer due instant supersedes an older still-pending occurrence with an explicit cancelled
  outcome. Runtime failures requeue the same occurrence with bounded jittered exponential backoff;
  they never disable the routine, so external recovery resumes without member action.
- The durable routine-origin turn is the run identity, but runtime executes it in a run-scoped Pi
  session with the current authorized model, Skills, plugins, provider tools, and operating brief.
  Pi works directly in the persistent Box workspace; Companion adds no product snapshot, merge, or
  filesystem lock around workspace files. The main Pi session never receives the routine prompt or
  private transcript.
- The thread projects a compact clickable `Routine: <name>` marker. Owner, Editor, and Viewer can
  page through the run's private transcript from that marker or the routine's connected-resource
  row. Viewer receives the full user-visible history but only the generic runtime-error projection;
  bounded recovery diagnostics remain Owner/Editor-only.
- A routine may finish silently as `no_output` or call one terminal `surface_to_main` return. Both
  `notify` and `relay` write the payload exactly once as a visible Companion entry in main-thread
  history; only `relay` queues a turn for the main Pi to read and answer. The routine Pi terminates
  at the accepted return and cannot continue. Its private history never duplicates the payload.
- The run root isolates only Pi transport state and private history. Routine tools read and write
  the persistent Box workspace directly; no member-facing snapshot or merge surface exists.
- Web and native iOS create new cron schedules in the member's stored timezone and render future
  fire instants in that timezone. Existing routine cron/timezone values remain authoritative on the
  server; viewing them converts their absolute next-fire instant to the current member timezone.

### Triggers

- A Companion may have at most ten named triggers — the event-driven siblings of routines. Each has
  a prompt of at most 16,384 characters and a provider label (`webhook`, `linear`, `github`, `sentry`, or `custom`) that
  hints at the delivery id; it is not an auth scheme.
- Creation and every mutation are Owner/Editor approved: the context panel writes directly, while Pi
  uses `companion_request_trigger_change` and receives an asynchronous decision card. Creation and
  approval register the remote webhook end-to-end with the selected
  member-scoped trigger-provider account. That authority is immediately available to every
  Companion the member can operate and is never attached through `selected_mcp_account_ids`.
  OAuth-backed accounts reuse the existing MCP credential in place. One eligible account is
  selected silently. Pi never invents or sends `provider_account_id`; approval resolves the
  approving member's sole eligible account and fails closed if several exist. The direct trigger
  editor/API requires an explicit account for that ambiguous case. `manual` plus the platform URL is only the exceptional fallback for a
  source without a registration API. Users never paste URLs or secrets in the primary flow.
- `POST /v1/hooks/triggers/:triggerId/:secret` is registered before session middleware, capped at
  1 MB, and compares the server-generated secret with `timingSafeEqual`. There is deliberately no
  per-provider HMAC: sources are services the user controls, and a wrong URL is a 404 or 401.
- Fire is API-level isolated validation-run enqueue as the immutable Companion Owner; the webhook
  route never contacts Box or Pi. Runtime evaluates the untrusted payload in a disposable Pi session
  whose only enabled tool is `surface_to_main`; it receives no MCP gateway, provider-tool credentials,
  skills, or project context. The pinned memory copy remains isolated from main Pi. Runtime then performs
  one configured `notify` (visible entry only), `relay` (visible entry plus main-Pi turn), or silent
  no-op. The message id is deterministic (`uuidv5(triggerId|deliveryId)`), so provider
  redeliveries collapse to one turn. The prompt carries a payload excerpt of at most 4,096
  characters labeled external and untrusted.
- A disabled trigger, a fire within 60 seconds of the last, or an active turn for the same trigger
  is skipped. Five consecutive failures disable the trigger.
- The thread projects a trigger origin on the user entry. The UI hides that prompt and shows
  `Trigger: <name>` above the ordinary reply.
- Web and native iOS render trigger fire activity in the member's stored timezone. Triggers remain
  event-driven and do not acquire a cron schedule.

### Pi protocol and failure semantics

- Layout 14 installs a Node broker between runtime commands and Pi. It uses an owner-only Unix
  socket for correlated commands and a segmented, monotonic, acknowledged event journal.
- Every message is persisted before the broker calls Pi with `streamingBehavior: "steer"`; Pi
  atomically chooses idle prompt or active steer without a runtime `isStreaming` pre-probe. The
  broker associates events with the response root through `agent_settled`, while PostgreSQL keeps
  each admitted Turn and its FIFO identity distinct.
- Unknown Pi events are counted and ignored. Only explicitly supported terminal event shapes settle
  a turn; malformed or oversized lines advance safely without storing their raw content.
- A missing acknowledgement after a possible prompt write becomes `interrupted` and is never
  auto-replayed. Runtime records the exact invocation and retries cleanup until it has durable
  negative or termination proof; it does not load message resources, restage Pi, or restart the
  Box. A proven negative acknowledgement may be retried under the lifecycle retry policy before
  ambiguity is declared.
- Ten minutes without correlated activity stalls a running turn; the inactivity clock pauses while
  a blocking human decision is in `needs_input`. After ten minutes without an answer, or sooner when
  the member sends another message, Pi receives a cancelled response and chooses a safe fallback or
  finishes the old turn. Silence and later messages never approve a proposal. “Companion is
  replying…” is true only after Pi ACK and before terminal settlement.
- Persisted failures contain only a stable code, an expurgated message of at most 500 characters,
  and an allowed action. Provider payloads, tokens, signed URLs, and raw Pi lines are forbidden.
- Model catalog normalization preserves Pi's `input` capability so a text-only model rejects image
  work explicitly before an unbounded turn.
- Chat files remain scoped to their message. Their bytes expire exactly 30 days after upload without
  extending on reads, retries, wake, or restaging; the thread retains explicit expired metadata and a
  later upload is a new attachment.
- Every attempted user turn carries a fixed-format runtime metadata suffix with the durable attempt
  start rendered in the member's IANA timezone. The changing value stays outside the cacheable
  system/history prefix; an unset profile uses UTC.

### Cutover

- A one-shot report/dry-run/confirmed purge runs only with Companions disabled and under an advisory
  lock. It permanently deletes each legacy Box and waits for provider confirmation before deleting
  the row that owns it; `404` means already deleted and every other failure blocks cutover.
- All legacy Companions, Boxes, transcripts, runtime state, pools, shares, member state, and leases
  are removed with no history migration or backfill.
- Encrypted provider connections, member MCP accounts, Skills, secrets, organizations, users,
  billing, and audit history survive.
- Before later Runtime v3 activation, a separate resumable v2 purge inventories and removes remote
  triggers, attachment/output objects, v2 named images/build resources, and every owned Box before
  deleting any Companion ownership row. Report/dry-run are mutation-free; confirmed mode requires
  the flag and database gate off, neutral leases, an advisory lock, and the exact confirmation
  phrase. An immutable expurgated ledger and preservation fingerprint prove reusable encrypted
  connections and all Skills Hub, tenant, billing, and audit data are unchanged.

## Security invariants

- Every tenant row carries `org_id`; personal resources remain creator-only with no admin override.
- API, worker, and runtime use distinct `NOSUPERUSER NOBYPASSRLS NOINHERIT` database roles. Runtime
  receives only narrow `SECURITY DEFINER` claim/renew/checkpoint/settle functions.
- Only `apps/runtime` has the Box service key. API keeps user authorization and hands desktop access
  to runtime through short-lived HMAC-authenticated private requests; neither side persists or logs
  the returned URL.
- The control plane never executes skill package scripts.
- Archive extraction rejects traversal, links, special files, collisions, ZIP64, excessive entries,
  and excessive expanded size.
- Transfer tickets are short-lived, purpose-bound, non-replayable, and revalidated before use.
- Plaintext secrets never appear in API responses, logs, audit metadata, projections, test fixtures,
  or ordinary process output.

## Explicit exclusions

- Generic Projects and skill runs, multi-Bot orchestration, Bot-to-Bot handoffs, group Bot chats,
  proactive jobs, and Companion voice conversation/runtime audio. Native iOS follows the approved
  `docs/ios-design.md` navigation and visual language. Native iOS dictation may transiently convert microphone audio into editable composer
  text without creating a turn, attachment, or Box/Pi capability. It is globally deployment-gated;
  clients omit the microphone when the API reports that its server-side Google key is absent.
- A file library, file versioning, or any artifact surface outside a thread. Chat files themselves
  are in scope: bounded image and document uploads on a message, and bounded images Pi hands back.
- Harnesses other than Pi, runtime providers other than box.ascii.dev, generic provider/model
  marketplaces, Box pools, container catalogs, deployment management, and arbitrary application
  automation platforms.
- SSE, Box-to-control-plane push agents, bearer tokens exposed inside Pi's OS identity, detached API
  executors, global learned capability tables, and automatic replay after ambiguous dispatch.

## Success measures

- Skills Hub publication, install, GitHub sync, and Skill Database reliability remain unchanged.
- Send acknowledgement is under one second outside load; runtime claims work within five seconds.
- Each cold-start cycle finishes or re-enqueues explicitly within three minutes; a provider delay
  before dispatch does not expire the accepted message.
- Runtime images accelerate only an already-ready cold path; missing, pending, stale, failed, or
  unreadable image state immediately cold-installs and repairs outside Turn/lane ownership.
- A stalled attempt settles within ten minutes plus one sweep; absolute deadline settles within two
  hours plus one sweep.
- Runtime takeover completes within 45 seconds after a replica dies.
- Zero cross-tenant/privacy violations, plaintext-secret leaks, silent terminal Pi failures,
  duplicate turns, or automatic replays of ambiguous prompts.

## Acceptance gates

- Unit, real PostgreSQL, simulator fault-injection, and browser suites in `docs/testing.md` pass.
- The full API + worker + runtime + web + Box/Pi simulator topology passes cold send, image,
  decision, stop/wake, takeover, terminal interruption release, and permanent deletion scenarios.
- No P0/P1 runtime incident is open, and the purge report contains no owned legacy resource before
  legacy orchestration removal.
- `pnpm verify:change` and every printed PostgreSQL, container, dependency, and browser gate pass.
