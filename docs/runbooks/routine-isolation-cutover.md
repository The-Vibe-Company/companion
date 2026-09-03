# Historical Runtime v2 routine-isolation cutover

This archived runbook records the migration 0138 cutover to run-scoped Pi execution for scheduled
Companion routines. It is retained only for migration replay and historical incident evidence; it
does not authorize activation, rollback, direct production database writes, or Box deletion/restart
for the v3-only runtime. Current operations live in
[the Runtime v3 runbook](./companions-runtime.md).

## Current contract and deploy gates

There is no routine-isolation rollout environment variable in the merged implementation. The
temporary `COMPANION_ROUTINE_ISOLATION_ENABLED` variable existed during development of #466, but
`refactor(runtime): make routine isolation unconditional` removed its config and application
plumbing before #466 merged. Setting it on a current runtime has no effect.

The current runtime always passes `true` to `companion_runtime_prepare_routine_run` from
`CompanionRuntimeStore.prepareRoutineRun`. Migration
`0137_companion_routine_isolation.sql` preserves an already-pinned isolated run and pins a new
routine run to isolation when that argument is true. The worker does not choose the execution
mode; it only persists the routine-origin turn.

Migration `0139_companion_routine_parallel_scheduling.sql` adds independently fenced `main` and
`routine` leases and claim protocol 4. One ordinary main attempt and one isolated routine attempt
may then run concurrently. Protocol-3 runtimes may finish an existing fenced claim after the
migration, but cannot claim new work; deploy protocol-4 runtime immediately after the release
migration. There is no separate parallelism flag.

The actual product gate remains:

```dotenv
COMPANION_COMPANIONS_ENABLED=true
COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=the-real-production-allowlist
```

Set both consistently on web, API, worker, and runtime. An absent, blank, or non-true
`COMPANION_COMPANIONS_ENABLED` value disables Companions. An empty allowlist also disables them.
The worker then stops claiming routine work, and the runtime stops claiming Companion work. These
variables are a product kill switch, not an isolation/legacy selector.

### Version and flag matrix

| Runtime binary | Database | Isolation variable | Result |
| --- | --- | --- | --- |
| Current parallel runtime | Includes migrations 0137 and 0139 | Any value or absent | Variable is ignored. New routine runs are isolated and use the routine lease while the main lease remains available. |
| Protocol-3 runtime | Includes migration 0139 | Any value or absent | Existing claims remain fenced, but new claims are rejected until protocol-4 runtime is deployed. |
| Intermediate, unmerged #466 build | Includes migration 0137 | Absent or `false` | New, unpinned runs use the legacy ordinary-turn path. An already-isolated run remains isolated because the SQL checks its durable pin before the flag argument. |
| Intermediate, unmerged #466 build | Includes migration 0137 | `true` | New runs are pinned to isolation. The variable was read by runtime only, not worker. |
| Pre-#466 runtime | Includes migration 0137 | Any value | The old runtime ignores the variable and never calls the preparation function, so it executes the legacy path. The migration is additive for that binary. |
| Current runtime | Missing migration 0137 | Any value | Runtime readiness fails on the missing required function/grants and must not claim work. Run the release service; there is no supported legacy fallback. |

On the intermediate build only, the exact variable was
`COMPANION_ROUTINE_ISOLATION_ENABLED=true` on the runtime service. Its parser treated absent or
blank as false, accepted `true`/`1` and `false`/`0`, and rejected other values. Do not use that
variable to operate current production. Deploy one immutable current SHA instead.

The legacy path shares the persistent main Pi session, transcript, context, and main scheduling
lane. It therefore neither provides the required privacy nor runs concurrently with a main-Pi turn.
Current isolated runs use their own broker, Pi process, and routine lease; the Box is bounded to the
main daemon plus one routine process. Same-lane work remains serial.

The distinct error `The routine Pi session changed while the run was active` is emitted only by
the isolated consumer. Seeing it while an intermediate runtime's isolation variable is off means
the run was already durably pinned to isolation, or the deployed runtime is the current
unconditional implementation. It is not evidence that a new legacy fire interrupted an active
main-Pi turn.

## Known prepare recovery failure

The run-scoped prepare script reads the routine PID file and only emits
`routine-pi-session-already-running <invocation>` after proving that:

- the PID is alive;
- `/proc/<pid>/environ` contains the exact run root as `COMPANION_PI_ROOT`;
- the process command line names the expected routine broker script; and
- the invocation file contains a valid invocation for that run.

This is process ownership validation, not a shared main-daemon lock. The invocation includes a
fresh UUID and the routine root includes the run ID, so separate runs do not collide.

The Box command transport can nevertheless return `success: false`, exit 1 when the detached
broker intentionally remains alive after the shell exits. Before the recovery fix,
`AsciiBoxCompanionRuntime.startRoutineSession` checked that envelope before parsing the
already-running marker. A retry or executor takeover therefore terminated the valid session and
persisted `box_provider_error`, even though prepare had recovered the exact session it needed.

The fix treats the ownership-proven marker as authoritative before the transport envelope, just
as launch readiness already does. Its regression test simulates exit 1 plus the marker and proves
that start returns the existing invocation without restaging or terminating it. Routine attempt
settlement still terminates and removes the run root; executor takeover may safely adopt the
existing broker before settlement.

PR #472 does not contain this fix. It makes routine context multiline-safe and uses the durable
turn ID as the isolated run ID; it does not change `packages/box-runtime`, prepare recovery, or
teardown.

## Parallel-lane cancellation incident and one-time repair

The first protocol-4 release made PostgreSQL lane-aware but left two process-level serial guards in
place. `RuntimeScheduler` keyed active work by Companion id, so one replica released the second
lane's valid claim. Routine startup also ran the main-broker idle repair; if a main turn was active,
that repair recycled the main Pi even though the routine had its own process and socket. The active
observer then reported an invocation change. Depending on the exact pre-accept checkpoint, routine
startup could also leave a `routine_session_cancelled` terminal error.

Migration `0144_companion_routine_lane_failure_accounting.sql` is the rollout and data-repair
boundary for this incident. Deploy its release migration and the matching runtime SHA together:

1. Keep the Companions feature gate enabled unless active ambiguity requires containment; no new
   parallelism flag exists.
2. Run the normal one-shot release migration as the migration owner. The migration installs
   terminal run-outcome accounting and re-enables only a disabled routine whose old five-failure
   marker is backed by five latest run outcomes carrying exact scheduler-cascade codes. The repaired
   row is due once immediately; the worker computes its next cron instant through the ordinary
   fenced fire path. Historical outcomes must also match the live definition-generation timestamp;
   deleting and recreating a routine with the same UUID never transfers failure state.
3. Deploy `apps/runtime` at the same SHA. Verify one main message during an active routine and one
   routine fire during an active main turn. Both attempts must keep their original invocation ids
   and settle independently.
4. Use the named read-only routine diagnostic to confirm `enabled`, `consecutive_failures`, the next
   fire, and recent run outcomes. Do not infer an abnormal cancellation from a Box-side
   `.cancelled` tombstone alone: exact routine termination writes that marker for normal cleanup too.
5. If a historical run is still `interrupted`, verify protocol 7 created its lane-local
   `restart_pi` recovery. It terminates only the exact run-scoped invocation, never replays the
   prompt, and never restarts or deletes the Box; the original error remains after
   `auto_abandoned` releases the lane.

After this migration, successful enqueue no longer clears the streak. A succeeded run clears it;
only a terminal `failed` run increments it. `interrupted`, `cancelled`, and
`routine_session_cancelled` do not count. Five genuine failures still disable the routine and clear
`next_fire_at`.

## Ordered Railway cutover

1. Record the exact target Git SHA and confirm that it includes migrations 0137 and 0139, the final #466
   isolation implementation, #472, and the already-running prepare recovery. Do not deploy a
   moving branch independently to each service.
2. Disable the target routine in the product so its cron cannot enqueue more validation turns.
   For a full runtime cutover, set `COMPANION_COMPANIONS_ENABLED=false` on web, API, worker, and
   runtime, deploy all four, and wait for active work to reach its safe interrupted checkpoint.
3. Take the normal production backup. Deploy the Railway `release` service at the exact target
   SHA. Require a `Completed` result before deploying application services; this applies migrations
   0137 and 0139 and their role grants. Protocol-3 runtimes may finish current claims after this
   point but do not claim more work.
4. Confirm the default branch has not advanced past the recorded SHA. Configure
   `COMPANION_COMPANIONS_ENABLED=true` and the same non-empty
   `COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS` on web, API, worker, and runtime. Do not add
   `COMPANION_ROUTINE_ISOLATION_ENABLED`.
5. Deploy runtime first at the recorded SHA, then API, worker, and web/iOS-facing API at that same
   SHA. Verify each deployment's release ID and health check. The runtime must report its required
   SQL functions and grants ready before the worker is allowed to create new fires.
6. If the Runtime v2 database gate was disabled for the cutover, the migration owner—not the
   runtime role—must re-enable it with the observed epoch using the compare-and-swap procedure in
   the Runtime v2 runbook.
7. Clean the old validation turns using the procedure below. Re-enable the routine only after the
   queue is clear and all services report the same release.

The Companions feature flag and Runtime v2 database gate are the rollback and containment gates for
this scheduling change. Do not add or operate a routine-parallelism flag.

The redacted diagnostic helpers may be used to confirm Railway deployment status, Runtime health,
the database gate, and routine projections:

```bash
python3 .claude/skills/debug-companions-prod/scripts/railway_status.py
python3 .claude/skills/debug-companions-prod/scripts/db_query.py health
python3 .claude/skills/debug-companions-prod/scripts/db_query.py gate
python3 .claude/skills/debug-companions-prod/scripts/db_query.py routines --companion <companion-uuid>
```

Use only the named read-only helpers. Do not run an ad hoc production query.

## End-to-end validation

Create or re-enable one five-minute routine with a prompt that ends by calling `surface_to_main`
with this accepted payload:

```json
{"mode":"notify","message":"Hello World"}
```

After one fire, verify:

- the run reaches `succeeded`, with outcome `surfaced` and surface mode `notify`;
- `main_entry_event_id` is present and `relay_turn_id` is absent;
- iOS Routine History shows **Completed** and **Notified in main chat**;
- the private routine transcript contains the isolated task and tool call; and
- the main thread gains one ordinary assistant entry containing `Hello World` at its next durable
  ordinal, and the notification is emitted. Notify does not wake or dispatch the main Pi.

Then validate scheduling concurrency with a routine that remains active long enough to observe:

- while the isolated run is `running`, send an ordinary message and require the main Pi to accept
  and answer it before the routine settles;
- repeat while the routine is `needs_input`; the main message must still run and must not answer or
  supersede the routine decision;
- while an ordinary main turn is `running`, fire the routine and require both attempts to remain
  active under different lease lanes;
- take over one lane in a controlled test environment and confirm the other lane's token, renewal,
  and process are unchanged; and
- observe automatic cleanup of the exact routine invocation and confirm the active main turn remains
  authorized; then validate exact main-invocation cleanup while a routine is active. Neither path
  exposes Retry/Cancel or replays the interrupted occurrence.

A `relay` return enters the ordinary main queue. It may wait behind another main turn, but it does
not wait merely for routine settlement. Routine context and any parent-memory snapshot remain
read-only; the isolated run has only run-local writable memory.

To validate silent completion separately, use a routine prompt that finishes without calling
`surface_to_main`. Expect `succeeded` with outcome `no_output`, no surface mode, no main entry, and
no relay turn. iOS shows **Completed silently**. The private run transcript remains available,
while the main thread gains nothing. `no_output` is a settlement outcome, not a
`surface_to_main` payload mode.

Do not accept `failed`, `interrupted`, a duplicate main entry, or a main-Pi dispatch for the notify
case. Keep the routine disabled while investigating any of those results.

## Clean queued validation turns

1. Disable the `Hello World` routine first to stop new cron fires.
2. If a turn is interrupted, verify its automatic cleanup is `pending`, `running`, or `completed`
   and that it exposes no Retry/Cancel action. Wait for `cleanup_complete` and
   `resolution = auto_abandoned` before treating its routine lane as released; do not replay or
   rewrite the turn.
3. Expand the queued-messages card and use **Remove from queue** for each queued `Hello World`
   message. Preserve unrelated owner messages.
4. If the client action is unavailable, an authorized Owner/Editor may call
   `POST /v1/companions/<companion-id>/turns/<turn-id>/cancel` with `{}` once per exact queued turn.
   Cancellation is durable and idempotent. Do not edit leases, attempts, or lifecycle operations
   routine rows directly.
5. Confirm the ordered queue is clear before re-enabling the routine.

## Rollback and containment

If isolated routine execution fails after cutover:

1. Disable the affected routine immediately. If failures are systemic, set
   `COMPANION_COMPANIONS_ENABLED=false` consistently on worker and runtime—preferably all four
   product services—and deploy so new work stops and active work reaches the safe interrupted
   checkpoint.
2. Cancel only affected queued turns through the product/API procedure above. Interrupted
   occurrences remain durable terminal history; their exact automatic cleanup may temporarily own
   the routine claim until `cleanup_complete`, then releases it without replay.
3. Preserve migrations 0137 and 0139 and every durable `routine_isolated` pin. Do not down-migrate, force a
   run onto the legacy main Pi, delete the Box, or use a full Box restart as automatic repair.
4. Roll forward to a compatible fixed Runtime v2 SHA. Re-run release first if that SHA contains a
   migration, deploy runtime before the producers, verify health and grants, then restore the
   master feature gate and database gate using their documented procedures.

Setting the historical isolation variable to false is not a supported rollback: current code
ignores it, and the legacy shared-main-Pi behavior violates the routine isolation contract.
