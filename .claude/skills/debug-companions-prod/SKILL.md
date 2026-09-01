---
name: debug-companions-prod
description: "Read-only production debugging for the Companions runtime on
  Railway and box.ascii.dev. Use when production box launches fail, a chat dies
  or stalls while waiting for input, turns sit queued or
  interrupted, a Companion appears to reply forever, /healthz is unhealthy, or
  an operator needs Railway deployment status, redacted runtime logs, provider
  Box inventory, or named read-only PostgreSQL runtime queries. Every script
  redacts credentials; the only mutation is a double-gated service restart."
metadata: {}
allowed-tools: Bash Read Grep Glob
---

# Debug Companions production

Operator-machine skill for diagnosing the production Companions Runtime v2
stack: four Railway services (`web`, `api`, `worker`, `runtime`), PostgreSQL,
and box.ascii.dev Boxes running Pi. Everything here is read-only except
`railway_restart.py`, which is double-gated and never touches `release`.

Authoritative references: `docs/runbooks/companions-runtime.md` (operations),
`docs/companions-runtime.md` (state machine), `deploy/railway/README.md`
(credential boundary).

## Hard safety rules

From the runbook — these are not negotiable:

1. Never paste tokens, signed URLs, provider payloads, raw Pi lines, auth
   files, or decrypted material into a transcript, ticket, or log search.
   Every script pipes output through `redact()`; do not bypass the scripts to
   run raw curl/psql with credentials in argv.
2. Never delete or archive a Box. Full Box restart is an explicit user action
   only; automatic repair may recycle Pi but never a healthy Box. This skill
   ships no Box mutation code at all.
3. Never manually mark an ambiguous or interrupted attempt `queued`, clear
   lease rows, or edit epochs. Protocol 7 resolves an ambiguous dispatch with
   cleanup of its exact Pi invocation, records `auto_abandoned`, and releases
   the lane without replay. Retry is compatibility-only and may only observe
   or re-enqueue that cleanup; it never creates an attempt.
4. The kill switch (`companion_runtime_disable`) is a human, migration-owner
   action. This skill only *reads* gate status via `db_query.py gate`; it must
   never call enable/disable.
5. Queued durable work is not garbage. Do not delete rows to make a dashboard
   look clear.
6. `PROD_DATABASE_READ_URL` must reference a read-only login. The scripts
   still wrap every query in `BEGIN TRANSACTION READ ONLY; ... ROLLBACK;` as
   defense in depth, and have no free-SQL mode.

## Prerequisites

- `psql` on PATH (PostgreSQL 17 client).
- `~/.companion-prod.env`, mode exactly `0600` (scripts refuse otherwise):

  ```dotenv
  RAILWAY_API_TOKEN=...            # Railway token (bearer or project token)
  RAILWAY_PROJECT_ID=...
  RAILWAY_ENVIRONMENT_ID=...
  COMPANION_BOX_API_KEY=...        # box.ascii.dev key — runtime-only elsewhere
  COMPANION_BOX_API_BASE=https://ascii.dev/api/box/v1   # optional, this default
  PROD_DATABASE_READ_URL=postgres://...                 # READ-ONLY role
  DEBUG_PROD_ALLOW_RESTART=0       # set to 1 only while deliberately restarting
  ```

  ```bash
  chmod 600 ~/.companion-prod.env
  ```

Values are read only from this file, passed to subprocesses via the
environment, and never printed or placed in argv.

## First five minutes

Run from the repository root:

```bash
python3 .claude/skills/debug-companions-prod/scripts/railway_status.py
python3 .claude/skills/debug-companions-prod/scripts/db_query.py gate
python3 .claude/skills/debug-companions-prod/scripts/db_query.py health
python3 .claude/skills/debug-companions-prod/scripts/railway_logs.py \
  --service runtime --since 30m --grep '"level":"error"|persisted|denial' --raw
```

Interpretation order:

1. `railway_status` — are all four services on the same commit and SUCCESS?
   A commit mismatch during an incident usually means a half-finished deploy.
2. `gate` — `enabled=false` means claims are fenced (kill switch or cutover in
   progress); nothing will run until a human re-enables with the observed
   epoch. Do not "fix" this from the skill.
3. `health` — queued backlog per companion, active attempts, stale instance
   heartbeats, expired-but-claimed leases.
4. Runtime error logs — collect stable `code` values, then follow the symptom
   playbooks below and `references/triage-playbook.md`.

## Symptom playbooks

### Box launches are failing

```bash
python3 scripts/db_query.py interrupted --since 6h
python3 scripts/db_query.py ops --companion <uuid>
python3 scripts/db_query.py instance --companion <uuid>
python3 scripts/box_list.py --companion <uuid>
python3 scripts/railway_logs.py --service runtime --companion <uuid> --since 6h
```

- A `runtime.work.start_requeued` / `cold_start_deadline_exceeded` log around
  `creating_box`/`waiting_ready`/`installing_layout` means one protocol-7 cold
  path cycle exceeded three minutes. The same operation must be pending with
  bounded backoff, `started_at` and its transient error cleared, while its
  source turn remains queued with no attempt. A terminal source turn carrying
  this code is pre-protocol-7 behavior.
- A `cold_start_deadline_exceeded` operation whose `started_at` is already later
  than the turn deadline, with no attempt and an existing warm idle Box, is the
  pre-0129 queued-follow-up bug: the send was misclassified while Pi was busy.
  It is not evidence of a Box cold start.
- `box_create_ambiguous`: create may have committed provider-side. Run
  `box_list.py --companion` — two Boxes with the same generation is the
  evidence. Do NOT delete either; the runtime discovers the
  generation-qualified name and selects one canonical Box (runbook: Box
  lifecycle/provider outage).
- `box_rate_limited` (429) or `box_provider_unavailable`/`box_network_error`:
  provider incident; count occurrences over the window before escalating to
  ascii.dev.

### Chat dies or stalls while waiting for input

Three distinct signatures can produce "my chat died while I was away". Identify
which one you have before touching anything:

```bash
python3 scripts/db_query.py turn --turn <uuid>
python3 scripts/db_query.py decisions --companion <uuid> --since 24h
python3 scripts/railway_logs.py --service runtime --turn <uuid> --since 24h
```

1. **Decision expiry (ask_user timeout, 10 minutes).** `decisions` shows a
   `question`/`confirmation` row with `decision_status=expired` and an
   `expires_at` roughly ten minutes after creation; `cancelled` before that can
   mean a newer member message returned control to Pi. Neither state grants
   approval. On releases before migration 0129, a
   decision can instead be followed by `turn_stalled` after ten minutes because
   the inactivity clock was not actually paused.
2. **`pi_event_stream_interrupted`.** The attempt's error triplet names this
   code: the broker's event stream from Pi broke mid-turn. Look at the
   attempt's `unknown_event_count`/`malformed_event_count` and runtime logs
   around `last_activity_at`. This is transport loss, not member behavior;
   frequent occurrences are the provider-polling failure mode the direct
   transport work targets.
3. **`turn_stalled` (10-minute inactivity).** Terminal status `interrupted`
   with code `turn_stalled`: Pi acknowledged the attempt but produced no
   correlated activity for ten minutes. Distinguish from case 1 by the
   absence of a pending/expired decision row; distinguish from case 2 by the
   error code. Check whether Pi is wedged (`instance` shows `pi_state`) and
   follow the automatic-cleanup operation through `cleanup_complete`.

The decision expiry and the ten-minute running stall are different clocks.
After migration 0129, `needs_input` pauses inactivity; before it, trust the row
timestamps and error code over the expected state-machine semantics.

### Sends are accepted but nothing ever replies, while routines still run

This is a **wedged scheduling lane**, not a Box problem. Since migration 0139 a
Companion has two independent lanes, `main` and `routine`, each with its own
lease row and its own single active-attempt slot
(`companion_turn_attempts_one_active_lane_uq`). A `main` attempt that never
settles holds that slot forever, so every member message queues behind it while
routines keep completing normally — which is exactly what the member reports.

```bash
python3 scripts/db_query.py leases --companion <uuid>
python3 scripts/railway_logs.py --service runtime --companion <uuid> --since 2h
```

`leases` is the discriminating query. Read the two rows together:

- **`main` claimed, `claim_epoch` climbing, attempt `active_for` far larger than
  the lease TTL** — the executor is re-claiming the same work every lease period
  and making no progress. Look for `runtime.work.fence_lost` in the logs.
- **`main` free while an attempt is still active** — the work is orphaned; no
  lease will expire, so nothing recovers it.

Note that `db_query.py stuck` historically only matched an `interrupted`/
`needs_input` head. It now also reports an *active* head that has not changed
state for ten minutes; a head wedged in `starting` used to be invisible.

When the loop is on an attempt, `material` narrows which precondition actually fails:

```bash
python3 scripts/db_query.py material --companion <uuid>
```

`store.getMaterial` CROSS JOINs the material, turn-context, and routine-material
functions, so any one returning no row makes the combined lookup null.
`material` selects each precondition as a boolean — actor match, claim epoch,
prompt entry, and routine shape — so a false column names the missing input.

`LeaseSession.fencedLookup` now re-authorizes a null result before classifying
it. A real lost fence is abandoned without settlement, an authorization denial
fails closed with its stable code, and missing material under a live lease
becomes bounded `work_material_unavailable` work rather than an endless reclaim
loop. Protocol 7 recovery never requests message material. For a looping
`restart_pi` recovery, inspect its `started_at`, `attempt_count`, checkpoint,
exact lane lease, and `runtime.recovery.stalled`; do not repair actor resources
or mutate the turn merely to make cleanup run.

### Turn interrupted or Pi silent

```bash
python3 scripts/db_query.py stuck
python3 scripts/db_query.py turn --turn <uuid>
```

- `dispatch_state=ambiguous` / `prompt_dispatch_ambiguous`: the prompt may
  have reached Pi, so it is deliberately never replayed. Protocol 7 enqueues
  resource-free cleanup of only the exact invocation, then records
  `auto_abandoned` and resumes the next FIFO message. Warn that earlier
  external effects may have succeeded.
- An interrupted queue head with queued turns behind it (`stuck`) should own
  one `restart_pi` operation with `trigger=recovery`. Inspect its lane,
  checkpoint, age, `attempt_count`, and live lease. `cleanup_complete` is the
  current terminal proof; `pi_ready` is accepted only for legacy recovery.
- A recovery older than 15 minutes or with a climbing attempt count is a
  stalled automatic cleanup. Correlate `runtime.recovery.stalled` with its
  expurgated error and exact Box/Pi evidence; do not manufacture resolution.
- `turn_deadline_exceeded`: two-hour absolute deadline; look at attempt
  history for what consumed it.
- The compatibility Retry route never replays the prompt or creates an
  attempt; it only observes or re-enqueues the existing cleanup.

### `/healthz` unhealthy (503)

Runtime healthz is private; diagnose via logs and the database, not curl:

```bash
python3 scripts/railway_logs.py --service runtime --since 15m --raw
python3 scripts/db_query.py health
```

- `database=false`: private database path or restricted runtime login broken.
  Never substitute the API or owner URL.
- `claim_loop=false`: preserve the first stable error code from logs, then
  roll one replica (`railway_restart.py`, double-gated). If another replica
  cannot take over within 45 seconds, the kill switch is a human decision.
- `sweep_fresh=false`: event-loop starvation or stuck sweep. A process still
  accepting TCP is not healthy; roll it.

## Error-code map

Stable codes from `packages/companion-runtime/src/errors.ts` and the runtime
adapters (persisted triplet: code, expurgated ≤500-char message, action):

| Code | Meaning | Typical action |
| --- | --- | --- |
| `cold_start_deadline_exceeded` | One pre-dispatch Start cycle reached three minutes | inspect Start checkpoint/backoff; protocol 7 requeues the same Start and keeps the message queued |
| `turn_stalled` | 10 min with no correlated Pi activity | inspect exact automatic cleanup |
| `turn_deadline_exceeded` | 2 h absolute deadline reached | inspect exact automatic cleanup |
| `box_create_ambiguous` | Box create may have committed; not replayed | inspect `box_list --companion`; never delete manually |
| `prompt_dispatch_ambiguous` | prompt may have reached Pi; not replayed | automatic exact-invocation cleanup; inspect recovery |
| `decision_delivery_ambiguous` | decision response may have reached Pi | same automatic-cleanup rule |
| `pi_event_stream_interrupted` | broker event stream from Pi broke | inspect recovery; count occurrences (transport health) |
| `pi_not_idle` / `pi_busy` | Pi had queued messages at dispatch time | inspect settlement and recovery |
| `pi_invocation_changed` | Pi restarted under the attempt | inspect exact-invocation proof |
| `pi_process_exited` | Pi process died mid-attempt | inspect recovery + instance `pi_state` |
| `box_rate_limited` | provider 429 | wait/backoff; escalate volume |
| `box_provider_unavailable` / `box_network_error` | provider unreachable/5xx | provider incident path |
| `box_unavailable` / `box_not_found` | Box missing or not usable | inspect `instance` + `box_list` |
| `provider_unavailable` / `provider_access_revoked` | model provider connection broken/revoked | reconnect provider in Plugins |
| `mcp_access_revoked` | selected MCP account no longer authorized | reconnect account |
| `model_image_input_unsupported` | image sent to a text-only model | switch model; nothing reached the Box |
| `attachment_staging_failed` | staging writes refused before dispatch (proven negative) | check object storage; a later Send may retry ordinary work |
| `actor_not_authorized` / `companion_access_revoked` / `actor_access_revoked` | authority revoked before Box contact (fail closed) | none — expected security behavior |
| `settings_changed` / `settings_changed_since_claim` | settings raced the claim | let normal prerequisite work reconcile settings |
| `invalid_model_selection` | selected model no longer valid | switch model |
| `runtime_shutting_down` | replica drained mid-work | should be reclaimed; investigate if it settled a turn |
| `runtime_execution_failed` / `runtime_failure` | generic fallback — the log line's `thrown` block has the real name | search runtime logs for the same ts |

`fence_lost` / `LeaseFenceLostError` is likewise a process-log outcome, never a
persisted triplet. Once per attempt it is ordinary lease handoff. If it repeats
at the lease TTL on one `workId`, compare authorization and material evidence:
current runtimes distinguish a true lost fence, a stable denial, and
`work_material_unavailable`; mixed-release logs may still contain the legacy
collapsed symptom.

`outbox_harvest_failed` is a process-log event, not a persisted attempt error:
the turn succeeded and only reply images were partially recovered — search
logs, never reclassify the turn.

## Escalation

- Provider-side (create failures, 429 storms, Boxes stuck `provisioning`,
  resume instability): collect Box ids, timestamps, and counts (redacted
  output only) and escalate to ascii.dev.
- Kill-switch-worthy (unsafe duplicate execution, credential exposure, broken
  fencing, corrupt projection): stop; page the on-call owner. The fence is
  `companion_runtime_disable(<observed_epoch>, 'incident-<id>')` run by the
  migration owner — not by this skill.
- Suspected secret exposure: fence first, then rotate per runbook (Box key on
  runtime only, desktop HMAC on api+runtime together). Search logs only for
  stable identifiers and codes.
- Record environment, release commit, and operator/change id for every
  production change. Never record secret values.

`references/triage-playbook.md` has the full symptom → evidence → cause →
runbook-section map; `references/railway-api.md` documents the (UNVERIFIED)
GraphQL surface; `references/redaction.md` is the redaction contract.
