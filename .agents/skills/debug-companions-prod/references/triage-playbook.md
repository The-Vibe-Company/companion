# Triage playbook: symptom → evidence → cause → runbook section

Authoritative operations text: `docs/runbooks/companions-runtime.md`.
State machine and protocol: `docs/companions-runtime.md`. Use the scripts in
`scripts/` for every evidence step; never raw curl/psql with credentials.

Turn lifecycle for reference:
`queued → starting → dispatching → running ↔ needs_input →
succeeded | failed | interrupted | cancelled`. Only one attempt is active per
Companion lane; later turns in that lane wait in order. An ambiguous dispatch becomes
`interrupted`; protocol 7 automatically cleans up its exact Pi invocation,
records `auto_abandoned`, and releases the lane without replay.

---

## 1. Box launches are failing

| Evidence (script) | What it shows | Cause | Runbook section |
| --- | --- | --- | --- |
| `db_query.py interrupted --since 6h` | many `cold_start_deadline_exceeded` | cold path (Box ready + Pi install) exceeded the 3-minute deadline | Turn is interrupted or Pi is silent |
| `db_query.py ops --companion X` | start operation looping at `creating_box` / `waiting_ready` / `installing_layout`, rising `attempt_count`, error triplet | provider slowness, install failure, or image fallback to full npm install | Box lifecycle/provider outage |
| `db_query.py instance --companion X` | `box_state` stuck `provisioning`/`error`, `disk_layout_version` behind, `skills_update_error_code` | layout install failed on-box | Box lifecycle/provider outage |
| `box_list.py --companion X` | two Boxes sharing one generation | `box_create_ambiguous`: create retried around a provider timeout; one canonical Box must be selected by the runtime | Box lifecycle/provider outage — "Do not manually delete suspected duplicates" |
| `railway_logs.py --service runtime --companion X --event box_` | `box_rate_limited`, `box_network_error`, `box_provider_unavailable` counts | provider incident / 429 storm | Box lifecycle/provider outage + escalation to ascii.dev |

Never: delete a Box, mark an operation completed, or bump checkpoints. A
permanent-delete failure keeps its ledger rows on purpose.

## 2. Chat dies or stalls while waiting for input — three signatures

All three present as "the Companion just stopped answering". They have
different clocks and different owners. Collect all three evidence items before
concluding:

```bash
python3 scripts/db_query.py turn --turn <uuid>
python3 scripts/db_query.py decisions --companion <uuid> --since 24h
python3 scripts/railway_logs.py --service runtime --turn <uuid> --since 24h
```

### 2a. Decision expiry or supersession (ask_user, at most ten minutes)

- **Evidence:** `decision_status=expired` at roughly ten minutes means no answer;
  `cancelled` earlier can mean a newer member message superseded the wait.
- **Cause:** Pi received no explicit approval and regained control fail-closed.
- **Owner:** member/UX, not the runtime. Advise answering pending questions;
  check why the ask was not noticed.
- **Runbook:** Turn is interrupted or Pi is silent (deadlines settle visibly).

### 2b. `pi_event_stream_interrupted`

- **Evidence:** attempt error triplet `pi_event_stream_interrupted`; runtime
  log lines with that code around `last_activity_at`; possibly nonzero
  `unknown_event_count`/`malformed_event_count` on the attempt.
- **Cause:** the broker's event stream from Pi broke mid-turn (transport, Pi
  restart, provider exec-channel loss). This is the dominant transport
  failure the direct-transport work (plan Phase 2) targets — count
  occurrences per day; the count is a baseline metric.
- **Owner:** runtime/transport. Inspect the exact automatic-cleanup operation.
- **Runbook:** Turn is interrupted or Pi is silent.

### 2c. `turn_stalled` (10-minute inactivity)

- **Evidence:** turn `interrupted` with `last_error_code=turn_stalled`; no
  expired decision row (the stall clock pauses during `needs_input`); gap of
  ≥10 min between `last_activity_at` and settlement.
- **Cause:** Pi accepted the prompt then produced no correlated activity —
  wedged Pi, or a single tool call running into the stall window.
- **Owner:** runtime. Exact automatic cleanup releases the lane; recurring
  stalls on the same skill suggest a long-running tool hitting the budget.
- **Runbook:** Turn is interrupted or Pi is silent.

For releases before migration 0129, a pending decision may incorrectly retain
the ten-minute inactivity deadline and end as `turn_stalled`; after 0129,
`needs_input` pauses that clock. Trust timestamps and the persisted error code.

## 3. Turn interrupted / Pi silent / queue blocked

| Evidence | Cause | Runbook section |
| --- | --- | --- |
| `turn` shows `dispatch_state=ambiguous`, code `prompt_dispatch_ambiguous` | prompt may have reached Pi; deliberately not replayed | "Never manually mark an ambiguous attempt queued" |
| `stuck` lists an interrupted head + queued backlog and recovery age >15 min | automatic exact-invocation cleanup is stalled; inspect recovery lane, checkpoint, attempts, lease, and `runtime.recovery.stalled` | Turn is interrupted or Pi is silent |
| `turn` attempts show repeated `pi_invocation_changed` | Pi restarted under attempts (health recycle loop?) | Turn is interrupted or Pi is silent |
| code `turn_deadline_exceeded` | 2-hour absolute deadline | same section |
| code `attachment_staging_failed` (proven negative, nothing dispatched) | object storage or Box file API refused staging writes | A turn's attachments failed |
| code `model_image_input_unsupported` | image to a text-only model; nothing reached the Box | A turn's attachments failed |
| succeeded turn missing a reply image, log event `outbox_harvest_failed` | harvest-only failure; never reclassify the turn | A turn's attachments failed |

## 4. Runtime `/healthz` unhealthy (503)

| Check | Evidence | Action | Runbook section |
| --- | --- | --- | --- |
| `database=false` | runtime logs show connection failures to the private DB path | verify restricted runtime login; never substitute API/owner URL | Runtime /healthz is 503 |
| `claim_loop=false` | first stable error code in runtime logs | preserve the code, roll one replica (double-gated restart); kill switch if takeover >45 s fails | Runtime /healthz is 503 + Kill switch |
| `sweep_fresh=false` | stale sweep timestamps, event-loop starvation symptoms | roll the process; accepting TCP ≠ healthy | Runtime /healthz is 503 |
| gate disabled (`db_query.py gate`) | `enabled=false`, recent `updated_at` | someone fenced claims; investigate the change id — do not re-enable from here | Kill switch → Re-enable |

## 5. MCP / provider connection failures

| Code | Cause | Action | Runbook section |
| --- | --- | --- | --- |
| `mcp_oauth_refresh_failed` (action `retry`) | loopback gateway could not refresh a selected MCP token | diagnose by cause (shared client id drift, revoked grant); reconnect in Plugins only when the grant itself is dead | MCP OAuth refresh failed |
| `provider_unavailable` / `provider_access_revoked` | model provider connection broken or revoked | reconnect provider | Incident response |
| `mcp_access_revoked` / `skill_access_revoked` / `resource_access_revoked` | authority re-check before Box contact failed closed | expected security behavior; fix the selection | Incident response |

Never inject tokens (`GITHUB_TOKEN`, refresh tokens) into a Box and never
replay an ambiguously failed MCP/Git operation.

## 6. When to stop and page a human

- Anything pointing at duplicate execution, credential exposure, broken
  fencing, or corrupt projections → kill-switch territory. The fence
  (`companion_runtime_disable`) is run by the migration owner with the
  observed epoch; this skill only reads `gate`.
- A stale-epoch failure on any gate call is protective — investigate who
  changed it; never retry with a guessed epoch.
- Provider-side instability beyond retries → escalate to ascii.dev with
  redacted counts, Box ids, and timestamps.
