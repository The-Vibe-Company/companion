# Companions Runtime v2 operations

This runbook covers the production Runtime v2 boundary: migration and cutover, permanent legacy
purge, kill switch, incident response, and rollback. The state
machine and protocol contract remain authoritative in `docs/companions-runtime.md`; Railway-specific
configuration lives in `deploy/railway/README.md`.

Routine-isolation rollout, parallel-lane incident recovery, and the owner-approved one-time
re-enable procedure live in the
[routine isolation runbook](./routine-isolation-cutover.md#parallel-lane-cancellation-incident-and-one-time-repair).

## Safety rules

- `apps/runtime` is the only long-lived process with the Box key or permission to claim Runtime v2
  work. API and worker must not receive either capability.
- Run schema changes as the migration owner in an ephemeral release job. Never inject that owner
  credential into a long-lived process. Run API, worker, and runtime through three distinct `LOGIN
  NOSUPERUSER NOBYPASSRLS NOINHERIT` roles.
- Invoke migrations explicitly with the release image's `node dist/migrate.js` (or
  `pnpm --filter @companion/api migrate` in a source checkout). API `start` runs only
  `node dist/index.js`; it is never a migration hook.
- Keep the runtime desktop endpoint private even though requests are HMAC authenticated. Never
  persist or log its returned signed URL.
- Never replay a dispatch once the prompt may have been written. Protocol 5 marks it interrupted,
  terminates the exact Pi invocation through internal recovery, records `auto_abandoned`, and
  releases the lane automatically.
- Never use Full Box restart as automatic repair. Never delete a Box unless an explicit user delete
  or the audited legacy-purge procedure owns it.
- Do not put provider payloads, tokens, signed URLs, raw Pi lines, auth files, or decrypted material
  in a command transcript, incident ticket, log search, or database error field.

Record the environment, release commit, operator/change id, database backup id, gate epoch, and
purge report checksum for every production change. Do not record secret values.

## Release and migration

1. Confirm API `/health` and runtime `/healthz` are green on the current release. Resolve any open
   P0/P1 runtime incident before continuing.
2. Back up PostgreSQL and object storage. A database rollback does not roll back external Boxes, so
   record the Box environment/account separately.
3. Verify the API, worker, and runtime connection URLs identify different restricted roles. Verify
   the runtime role has narrow function execution only and no direct table privilege.
4. Deploy the one-shot release job with the owner URL and pass the exact API, worker, and runtime
   role names to the grants script. For an upgrade from the historical union credential, first make
   that role `NOLOGIN`, drain every `pg_stat_activity` session, remove its role memberships, and pass
   its exact name as `DATABASE_RETIRED_RUNTIME_ROLE`; `DATABASE_RUNTIME_ROLE` is rejected. The runner
   commits the compatible schema through additive desktop-replay repair 0093, validates/revokes
   grants, and only then applies destructive cutover 0094 on the same connection, followed by every
   later migration in the full journal. A failure after the first
   pass is a one-way disabled checkpoint, not permission to restart an old executor. Start the
   matching application processes only after the release deployment exits zero and is marked
   `Completed`. The API service must not receive the owner URL or role-name variables, and invoking
   its `start` command never retries or completes a failed migration.
5. Deploy API, worker, runtime, and web from the same commit. Keep `drainingSeconds` at least 30 and
   the runtime drain timeout below its fixed 30-second lease.
6. Check API `/health`, runtime `/healthz`, login, Skills browser smoke, and public package download.

For ordinary compatible Runtime v2 releases, use rolling deployment. One runtime replica receiving
SIGTERM stops new claims, reaches bounded safe checkpoints, and releases or loses its leases; another
replica must take over within 45 seconds. Do not clear lease rows or edit epochs manually.

### Verify queued routine cleanup (migration 0145)

Migration 0145 preserves routine turn/message history while settling stale executable work. After
the release job commits, record the migration output and run these read-only checks as the migration
owner:

```sql
select count(*) as stale_queued_routine_turns
from public.companion_turns
where status = 'queued'
  and (routine_snapshot_id is not null or routine_name is not null)
  and created_at < now() - interval '10 minutes';

select status::text, last_error_code, last_error_action::text, count(*)
from public.companion_turns
where last_error_code in ('routine_disabled', 'routine_deleted', 'routine_queue_expired')
group by status, last_error_code, last_error_action
order by last_error_code, status;

select tgname
from pg_catalog.pg_trigger
where tgrelid = 'public.companion_routines'::regclass
  and tgname in (
    'companion_routines_cancel_queued_turns_on_disable',
    'companion_routines_cancel_queued_turns_on_delete'
  )
  and not tgisinternal;
```

The first query must return zero: the migration backfill covers queued routine-origin rows older
than the ten-minute missed-fire grace, including rows whose definition was already deleted. The
second query should show only terminal `cancelled` rows with action `none`; these are skipped runs,
not genuine routine failures, and must not produce failure-streak increments or notifications.
The trigger query must return both rows. A runtime claim sweep repeats bounded cleanup under the
current enabled gate epoch, so a stale/disabled executor cannot mutate queue state. Do not manually
delete or requeue these turns; if the count rises, inspect runtime sweep freshness and gate state:

```sql
select enabled, gate_epoch, updated_at
from public.companion_runtime_gate_status();
```

Also verify that no skipped source retains an executable cold-start derivative:

```sql
select count(*) as executable_starts_with_settled_sources
from public.companion_operations operation
join public.companion_turns source_turn
  on source_turn.org_id = operation.org_id
 and source_turn.companion_id = operation.companion_id
 and source_turn.id = operation.source_turn_id
where operation.kind = 'start'
  and operation.trigger = 'turn'
  and operation.status in ('pending', 'running')
  and source_turn.status <> 'queued';
```

This must return zero after at least one current runtime claim sweep. An active executor is denied
further Box contact immediately; an already-dead executor is reconciled after its lease expires.
Do not clear the lease or operation manually.

Migration 0110 is deliberately migration-first during that rolling deploy. As soon as it commits,
the pre-0110 four-argument runtime claimer receives no new work; already-held leases remain valid.
Deploy the matching runtime immediately after the release job. If an old replica loses a lease after
staging without the new expiry ledger, the five-argument claimer rewinds that operation/settings
checkpoint and restages before Pi is recycled. Do not re-enable the legacy claimer or manually mark
material current to speed the rollout.

## Legacy purge

The purge is mandatory for an installation with pre-v2 Companions. It deletes legacy Companions,
transcripts, runtime state, and Boxes; there is no history migration. Provider connections, member
MCP accounts, Skills, secrets, users, organizations, billing, and audit history must survive.

### Prepare

1. Take a fresh PostgreSQL backup.
2. Set `COMPANION_COMPANIONS_ENABLED=false` on web, API, worker, and runtime, then deploy. The purge rejects
   every value other than explicit `false` and takes the migration advisory lock.
3. Wait for the runtime to stop claims and for active work to become interrupted. Keep public
   Companion traffic quiesced until cutover completes.
4. Run the command as an ephemeral private execution of the **runtime image**, never in the API
   image. Supply only for that execution:
   - `DATABASE_MIGRATION_URL`, using the migration owner;
   - `COMPANION_BOX_API_KEY` and, if needed, `COMPANION_BOX_API_BASE`;
   - `COMPANION_COMPANIONS_ENABLED=false`;
   - optional bounded delete polling values.

Do not add the migration-owner URL to the long-lived runtime service. Do not run a deployment
migration concurrently with the purge.

### Inventory and delete

Save both non-destructive outputs before approving deletion:

```bash
node dist/companionPurge.js report
node dist/companionPurge.js purge --dry-run
```

Review every database `box_id`, every provider Box matching an exact supported legacy name, and
every excluded near-match. Generation-qualified Runtime v2 names must not be targets. If the report
cannot list provider state completely, stop.

After independent review, run the explicit destructive mode:

```bash
node dist/companionPurge.js purge --confirm-delete-all-companions
```

The command must persist delete intent, send permanent-delete confirmation, save the provider
operation id, and wait for the asynchronous result. A delete `404` means already absent. A blocked
operation, poll `404`, malformed result, timeout, or any other provider error blocks cutover and
leaves PostgreSQL ownership intact. Correct the cause and rerun; saved operations are resumed rather
than submitted twice.

Only after every provider target is `completed` or `absent` may the finalizer delete legacy database
rows. Save the final report and its checksum. It must show:

- zero legacy Companion, pool, share, member-state, transcript, watermark, and lease rows;
- zero unresolved purge-ledger operation;
- zero exact-name legacy Box still owned by the provider;
- the retained operation ids for audit;
- the command's preserved-data declaration, plus an independent before/after count confirming
  provider connections and MCP accounts still present.

Do not deploy final legacy-removal migrations when any item remains.

## Runtime v2 cutover

1. Complete and archive the legacy purge report while the feature flag and database gate are off.
2. Deploy the asynchronous API/web, dedicated runtime, separated role grants, and Runtime v2 schema
   from one compatible stack. No legacy executor may be restarted against v2 rows.
3. Configure on web, API, worker, and runtime. The worker reads the flag only to decide whether
   Companion routines may enqueue turns, and still holds no Box credential:

   ```dotenv
   COMPANION_COMPANIONS_ENABLED=true
   COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=example.com
   ```

4. Give API only its private runtime URL and the desktop HMAC. Give runtime its dedicated DB URL,
   Box/Pi configuration, the same HMAC, envelope master key, public API origin, and read-only Skill
   archive access. Confirm API and worker environments contain no Box key.
5. Deploy runtime first, then API, worker, and web, with Companion traffic still quiesced. Require runtime
   `/healthz` to report PostgreSQL, claim loop, and sweep freshness healthy.
6. As the migration owner, read the compare-and-set epoch:

   ```sql
   select enabled, gate_epoch, updated_at
   from public.companion_runtime_gate_status();
   ```

7. If it is disabled and the observation is still current, enable it with a traceable change id:

   ```sql
   select enabled, gate_epoch, updated_at
   from public.companion_runtime_enable(<observed_gate_epoch>, 'cutover-<change-id>');
   ```

   A stale-epoch failure is protective. Re-read state and investigate who changed it; do not retry
   with a guessed epoch. Runtime deliberately cannot enable this gate itself.
8. Restore traffic. Execute the acceptance smoke: cold send to durable reply, desktop authorization,
   stop, send-as-wake, second reply, and permanent delete. Confirm Viewer and cross-tenant reads made
   no Box call.

The guarded final legacy-removal migration in this release may be deployed only when there is no
open P0/P1 runtime issue and the purge report is empty. An installation missing either prerequisite
must remain on its disabled purge-capable release; there is no compatibility mode in the final
runtime.

Immediately before that final migration, disable the database gate again with its observed epoch,
set the three feature-flag consumers false, and wait until every lease is neutral. Migration 0094
rejects an enabled gate or active claim even when the earlier purge evidence is complete. Re-run the
saved purge report. If a historical union database role exists, make it `NOLOGIN`, wait until
`pg_stat_activity` has no session for it, remove its memberships, and configure
`DATABASE_RETIRED_RUNTIME_ROLE`; the grants preflight removes its current and default ACLs before
0094. Deploy the final migration through the one-shot release job, require `Completed`, and only then
deploy all four processes from that same commit before following the explicit enable procedure
above. These prerequisites do not authorize migrating while Runtime v2 is still claiming work.

## Kill switch

Use the kill switch for provider instability, unsafe duplicate execution, credential exposure,
broken fencing, corrupt projection, or any incident where continued claims may cause harm.

### Immediate fence

1. As the migration owner, read `companion_runtime_gate_status()` and call:

   ```sql
   select enabled, gate_epoch, updated_at
   from public.companion_runtime_disable(<observed_gate_epoch>, 'incident-<id>');
   ```

   This increments the epoch, invalidates leases, interrupts active attempts/operations, and fences
   later checkpoints. A provider request already on the wire may still have succeeded externally.
2. Set `COMPANION_COMPANIONS_ENABLED=false` on runtime, API, and web and deploy runtime first. This
   prevents new claims and then removes new Companion intent/navigation at ingress.
3. Verify the gate is disabled, all leases are fenced, and no turn/operation remains in an active
   state. Queued durable work may remain; do not delete it to make a dashboard look clear.
4. Preserve expurgated metrics and identifiers. Never capture raw provider/Pi payloads.

The ordinary flag-off path performs a bounded drain before interruption. Use the direct database
fence when waiting for a rolling deployment is unsafe.

### Re-enable

Re-enable only after the cause is corrected, an empty-claim dry observation is healthy, and an
Owner/Editor communication plan exists for interrupted turns. Deploy all three flag consumers with
the flag on, verify `/healthz`, then have the migration owner call `companion_runtime_enable` with
the newly observed epoch. Protocol 5 backfills interrupted turns into automatic recovery; enabling
the gate never replays them.

## Incident response

### Runtime `/healthz` is 503

Inspect only its structured checks:

- `database=false`: verify the private database path and restricted runtime login. Do not substitute
  the API or owner URL.
- `claim_loop=false`: stop new claims, preserve the first stable error code, and roll one replica.
  If another replica cannot take over within 45 seconds, engage the kill switch.
- `sweep_fresh=false`: look for event-loop starvation or a stuck sweep. A process that still accepts
  TCP traffic is not healthy; roll it or disable claims.

Do not make the health endpoint public and do not weaken it to satisfy Railway readiness.

### Turn is interrupted or Pi is silent

The ten-minute inactivity deadline and two-hour absolute deadline must settle visibly. If prompt
write/ACK outcome is ambiguous, warn that earlier external effects may have succeeded and verify the
internal `restart_pi` recovery is `pending` or `running`. It must never replay the prompt. Cleanup
retries automatically with a backoff capped at five minutes, preserves the original error, and ends
the occurrence as `auto_abandoned`; never manually mark it queued or create a replacement attempt.
Recovery re-observes the known Box before Pi cleanup. A provider result of `absent` or `archived`
is valid negative proof for both main and isolated-routine lanes: the projected Box state must be
updated, no Pi command is sent, and the next ordinary send—not recovery—owns any archived-Box resume.
If recovery age keeps growing, inspect aggregate `runtime.recovery.metrics`, the exact lane lease,
and the expurgated operation code. A routine recovery must not prevent a new main-chat claim.

While a turn is waiting in `needs_input`, its inactivity deadline is intentionally cleared. An
`ask_user` decision returns control to Pi after ten minutes; asynchronous `companion-control`
approvals never hold the attempt open. A newer member message
cancels the wait sooner, without becoming an implicit approval, and remains queued for its own turn.
That queued follow-up must have neither a Start operation nor a cold-start deadline until it reaches
the head of the queue. If an older deployment shows
`turn_stalled` for the pending decision followed by `cold_start_deadline_exceeded` for a never-
attempted message on an idle warm Box, deploy migration 0129 before retrying; do not restart or
replace that healthy Box.

### MCP OAuth refresh failed

`mcp_oauth_refresh_failed` with action `retry` means the loopback gateway could no longer obtain a
usable selected MCP access token. Token lifetime alone is never an error: one-second, short-lived,
and non-expiring access tokens are all accepted while they remain positive and renewable. Check only
the safe OAuth code; never capture the provider response. Diagnose by cause:

- for GitHub deployment-secret drift, verify `api` and `runtime` both reference the same shared
  `COMPANION_MCP_GITHUB_CLIENT_ID` and `COMPANION_MCP_GITHUB_CLIENT_SECRET`; the API-side value is the
  reference after a successful initial exchange, and runtime must be redeployed after correction;
- if the GitHub client id changed, restore the OAuth App that issued the stored grant or reconnect
  the GitHub account in Plugins — a different client id cannot refresh that grant;
- if GitHub configuration is absent, restore both shared variables before retrying;
- for Gmail deployment-secret drift, verify `api` and `runtime` both reference the same shared
  `COMPANION_MCP_GMAIL_CLIENT_ID` and `COMPANION_MCP_GMAIL_CLIENT_SECRET`; a changed client id cannot
  refresh an existing grant, so restore the issuing client or reconnect the labeled Gmail account;
- for GitHub, Gmail, Linear, Notion, or another revoked/expired user grant, reconnect that account in
  Plugins; repeated messages cannot repair a revoked grant;
- for Slack app-secret drift, verify API has the original
  `COMPANION_MCP_SLACK_CLIENT_ID` and `COMPANION_MCP_SLACK_CLIENT_SECRET`; runtime must not receive
  either value. Restore the app that issued the grant or reconnect the Slack account;
- reconnect in Plugins only when the refresh token is absent, expired, revoked, or bound to a client
  configuration that can no longer refresh it. Do not reconnect merely because the access token is
  shorter than two hours and five minutes.

After repair, send a new message. Do not inject a refresh token, `GITHUB_TOKEN`, or `GH_TOKEN` into
Box, restart the Box, or replay an ambiguously failed MCP/Git operation.

### Gmail OAuth setup

Gmail's hosted MCP server is a Google Developer Preview service. In a Google Cloud project, enable
`gmail.googleapis.com` and `gmailmcp.googleapis.com`, configure the consent screen with
`https://www.googleapis.com/auth/gmail.readonly` and
`https://www.googleapis.com/auth/gmail.compose`, and create a Web application OAuth client with
`${COMPANION_WEB_URL}/v1/companion-plugins/oauth/callback` as an exact redirect URI. Set that
client's id and secret as `COMPANION_MCP_GMAIL_CLIENT_ID` and
`COMPANION_MCP_GMAIL_CLIENT_SECRET` for both API and runtime. Keep these values separate from
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, which are login credentials and must not inherit
restricted mailbox consent. External Google apps must complete the applicable OAuth verification
and restricted-scope security assessment before production use.

### Contextual transcription is temporarily unavailable

Native dictation uploads one bounded recording after Stop; the API adds bounded recent dialogue and
makes one stateless provider request. Search only the expurgated API event; never capture the request,
response, key, conversation context, or audio:

```bash
python3 .claude/skills/debug-companions-prod/scripts/railway_logs.py \
  --service api --since 30m \
  --grep 'api.companion_transcription.provider_failure' --raw
```

- `transport`: Railway could not complete the provider request within its deadline; retry once
  after checking provider status and network reachability.
- `4xx`: inspect only the numeric status. Rotate or correct the API-only
  `COMPANION_GEMINI_TRANSCRIPTION_API_KEY`, its Gemini API restriction, project access, billing, and
  `gemini-3.7-flash` availability. A repeated `400` after a key rotation can also indicate that the
  provider rejected the multimodal request shape; compare it with current audio-input documentation
  without recording the response. Never move the key to web,
  runtime, worker, or a client.
- `5xx`: treat repeated failures as a Google incident; record timestamps and counts, never payloads.
- `invalid_response`: Google returned success without one bounded final transcript; preserve the
  safe event and escalate without copying the response body.

After changing the key, redeploy API and submit a new recording. Never replay an audio request
automatically because the earlier provider call may have completed.

### A turn's attachments failed

Attachment codes are deliberately distinct, because they mean different things about what happened:

- `model_image_input_unsupported` (action `switch_model`): the turn carried an image and Pi reported
  a text-only model. Nothing reached the Box. Change the Companion's model and retry; do not attempt
  to convert or strip the image on the member's behalf.
- `attachment_staging_failed` (action `retry`): object storage or the Box file API refused the
  staging writes until the bounded retries were exhausted. No prompt was dispatched, so this is a
  proven negative — the queue is released and a retry rewrites the identical paths. Check object
  storage reachability from the runtime before advising a retry loop.
- `outbox_harvest_failed`: the turn itself succeeded and its reply is durable; only some of the
  images Pi left behind could be read back. It is a runtime process log (`event`,
  `companion_id`, `attempt_id`, `recovered`), not a persisted attempt error -- a succeeded attempt
  carries no error -- so search the runtime logs rather than the turn row. Never reclassify this as a
  failed turn. Look for a Box command-transport problem or an outbox file rewritten while being read.

A member reporting a missing image on a succeeded turn is the third case, not the first two. The
outbox is emptied before every dispatch, so an image that never appeared was never harvested rather
than attributed to a later turn.

### Box lifecycle/provider outage

The runtime retries only idempotent lifecycle and broker-observation calls on network, 429, and 5xx
failures. Observation-only broker state and journal reads also retry a transient provider-state 409;
prompt and decision writes do not. For create, it discovers the generation-qualified name before
retrying and selects one canonical Box. Do not manually delete suspected duplicates until their
generation and ownership are proven. A permanent delete failure keeps the operation and ownership
rows; never finalize them by hand.

### Desktop failures

Desktop is not a wake path. Verify private DNS, runtime port, clock skew, and that API/runtime share
the current HMAC. Rotate the HMAC on both services together. Never paste a minted URL into logs or
tickets, and never grant Viewer a fallback direct Box path.

### Suspected secret exposure

Fence claims first. Rotate the Box key on runtime only, the desktop HMAC on API and runtime, and the
affected provider/MCP or envelope credentials according to their own procedures. Search logs only
for stable identifiers and error codes; do not broaden collection to raw bodies.

## Rollback

After Runtime v2 data exists, rollback means **kill switch plus roll-forward-compatible v2 code**:

1. Fence the database gate and set the three flag consumers false.
2. Snapshot PostgreSQL and inventory external Box operations before changing code.
3. Deploy the last known-good build only if it understands the current Runtime v2 schema and fencing
   protocol. Never deploy a legacy API/worker executor and never replay interrupted attempts.
4. Repair forward, run simulator/PostgreSQL acceptance, deploy with claims still off, then follow the
   explicit re-enable procedure.

A database restore is disaster recovery, not an application rollback. It can make PostgreSQL older
than external Box side effects. If restoration is unavoidable, leave claims off, inventory every
generation-qualified Box and delete operation, reconcile ownership manually, and obtain incident
approval before enabling. Re-enabling the feature flag alone never enables the database gate.
