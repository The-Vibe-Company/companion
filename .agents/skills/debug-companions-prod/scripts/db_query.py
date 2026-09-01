#!/usr/bin/env python3
"""Named read-only PostgreSQL queries against the production Companion database.

Safety model:

- every invocation is wrapped in ``BEGIN TRANSACTION READ ONLY; ...; ROLLBACK;``;
- there is NO free-SQL mode — only the named queries below exist;
- ids and windows are passed as psql ``-v`` variables and interpolated with
  ``:'name'`` quoting (never Python string interpolation into SQL);
- the connection URL is handed to psql via the environment (libpq expands a
  conninfo-shaped ``PGDATABASE``), never via argv.

Every table and column below is verified against packages/db/src/schema.ts.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prodlib  # noqa: E402

# Each named query: description, ordered psql -v parameters, and its SELECT
# statements. Statements must be plain SELECTs (they get json_agg-wrapped for
# --json) and reference parameters only through :'name'.
QUERIES: dict[str, dict] = {
    "gate": {
        "description": "Runtime v2 database gate status (enabled, gate_epoch, updated_at).",
        "params": (),
        "statements": [
            "select * from public.companion_runtime_gate_status()",
        ],
    },
    "health": {
        "description": (
            "Turn counts by status, oldest queued turn per companion, active "
            "attempts, instances with stale heartbeats, and expired-but-claimed leases."
        ),
        "params": ("limit",),
        "statements": [
            (
                "select status, count(*) as turns\n"
                "from public.companion_turns\n"
                "group by status order by status"
            ),
            (
                "select companion_id, count(*) as queued_turns,\n"
                "       min(created_at) as oldest_queued_at,\n"
                "       date_trunc('second', now() - min(created_at)) as oldest_queued_age\n"
                "from public.companion_turns\n"
                "where status = 'queued'\n"
                "group by companion_id\n"
                "order by oldest_queued_at asc\n"
                "limit :'limit'::int"
            ),
            (
                "select companion_id, turn_id, id as attempt_id, status, checkpoint,\n"
                "       dispatch_state, pi_invocation_id, last_activity_at, started_at\n"
                "from public.companion_turn_attempts\n"
                "where status in ('starting','dispatching','running','needs_input')\n"
                "order by started_at asc\n"
                "limit :'limit'::int"
            ),
            (
                "select companion_id, box_id, generation, box_state, pi_state,\n"
                "       retirement_state, last_heartbeat_at, last_observed_at, health_due_at\n"
                "from public.companion_runtime_instances\n"
                "where box_state not in ('absent','archived')\n"
                "  and (last_heartbeat_at is null\n"
                "       or last_heartbeat_at < now() - interval '5 minutes')\n"
                "order by last_heartbeat_at asc nulls first\n"
                "limit :'limit'::int"
            ),
            (
                "select companion_id, executor_id, work_kind, work_id, claim_epoch, expires_at\n"
                "from public.companion_runtime_leases\n"
                "where claim_token is not null and expires_at < now()\n"
                "order by expires_at asc\n"
                "limit :'limit'::int"
            ),
        ],
    },
    "stuck": {
        "description": (
            "Companions whose queue head is interrupted/needs_input while queued "
            "turns older than 10 minutes wait behind it. Interrupted heads should "
            "have protocol-7 automatic cleanup; needs_input still awaits a member."
        ),
        "params": ("limit",),
        "statements": [
            (
                "with heads as (\n"
                "  select distinct on (t.companion_id)\n"
                "    t.companion_id, t.id as head_turn_id, t.status as head_status,\n"
                "    t.queue_sequence, t.last_error_code, t.last_error_action,\n"
                "    t.state_changed_at\n"
                "  from public.companion_turns t\n"
                "  where t.status in ('interrupted','needs_input')\n"
                "  order by t.companion_id, t.queue_sequence asc\n"
                ")\n"
                "select c.name as companion_name, h.companion_id, h.head_turn_id,\n"
                "       h.head_status, h.last_error_code, h.last_error_action,\n"
                "       h.state_changed_at, recovery.id as recovery_operation_id,\n"
                "       recovery.execution_lane as recovery_lane,\n"
                "       recovery.status as recovery_status, recovery.checkpoint,\n"
                "       recovery.attempt_count, recovery.available_at,\n"
                "       date_trunc('second', now() - recovery.created_at) as recovery_age,\n"
                "       lease.executor_id as recovery_executor_id,\n"
                "       lease.claim_epoch as recovery_claim_epoch,\n"
                "       lease.expires_at as recovery_lease_expires_at, q.queued_turns,\n"
                "       date_trunc('second', q.oldest_queued_age) as oldest_queued_age\n"
                "from heads h\n"
                "join public.companions c on c.id = h.companion_id\n"
                "left join lateral (\n"
                "  select o.id,\n"
                "         coalesce(to_jsonb(o)->>'execution_lane',\n"
                "           case when source_turn.routine_snapshot_id is not null\n"
                "                then 'routine' else 'main' end) as execution_lane,\n"
                "         o.status, o.checkpoint,\n"
                "         o.attempt_count, o.available_at, o.created_at\n"
                "  from public.companion_operations o\n"
                "  left join public.companion_turns source_turn\n"
                "    on source_turn.org_id = o.org_id\n"
                "   and source_turn.companion_id = o.companion_id\n"
                "   and source_turn.id = o.source_turn_id\n"
                "  where o.companion_id = h.companion_id\n"
                "    and o.source_turn_id = h.head_turn_id\n"
                "    and o.kind = 'restart_pi' and o.trigger = 'recovery'\n"
                "  order by o.created_at desc\n"
                "  limit 1\n"
                ") recovery on true\n"
                "left join public.companion_runtime_leases lease\n"
                "  on lease.companion_id = h.companion_id\n"
                " and lease.lane = recovery.execution_lane\n"
                " and lease.work_kind = 'operation'\n"
                " and lease.work_id = recovery.id\n"
                "cross join lateral (\n"
                "  select count(*) as queued_turns,\n"
                "         now() - min(t2.created_at) as oldest_queued_age\n"
                "  from public.companion_turns t2\n"
                "  where t2.companion_id = h.companion_id and t2.status = 'queued'\n"
                ") q\n"
                "where q.queued_turns > 0\n"
                "  and q.oldest_queued_age > interval '10 minutes'\n"
                "order by q.oldest_queued_age desc\n"
                "limit :'limit'::int"
            ),
        ],
    },
    "interrupted": {
        "description": "Recent failed/interrupted turns with their expurgated error triplet.",
        "params": ("since_seconds", "limit"),
        "statements": [
            (
                "select t.settled_at, c.name as companion_name, t.companion_id,\n"
                "       t.id as turn_id, t.status, t.last_error_code,\n"
                "       t.last_error_message, t.last_error_action\n"
                "from public.companion_turns t\n"
                "join public.companions c on c.id = t.companion_id\n"
                "where t.status in ('failed','interrupted')\n"
                "  and t.settled_at >= now() - make_interval(secs => :'since_seconds'::int)\n"
                "order by t.settled_at desc\n"
                "limit :'limit'::int"
            ),
        ],
    },
    "turn": {
        "description": "One turn row plus every attempt ordered by attempt number.",
        "params": ("turn_id",),
        "statements": [
            (
                "select id, companion_id, client_message_id, queue_sequence, status,\n"
                "       client_surface, cold_start_deadline_at, inactivity_deadline_at,\n"
                "       absolute_deadline_at, state_changed_at, settled_at,\n"
                "       cancel_requested_at, routine_name, trigger_name,\n"
                "       last_error_code, last_error_message, last_error_action, created_at\n"
                "from public.companion_turns\n"
                "where id = :'turn_id'::uuid"
            ),
            (
                "select attempt_number, id as attempt_id, status, checkpoint,\n"
                "       checkpoint_sequence, dispatch_state, dispatch_count, command_id,\n"
                "       dispatch_started_at, dispatch_accepted_at, pi_invocation_id,\n"
                "       event_cursor, last_activity_at, started_at, settled_at,\n"
                "       unknown_event_count, malformed_event_count, oversized_event_count,\n"
                "       last_error_code, last_error_message, last_error_action\n"
                "from public.companion_turn_attempts\n"
                "where turn_id = :'turn_id'::uuid\n"
                "order by attempt_number asc"
            ),
        ],
    },
    "ops": {
        "description": "Recent lifecycle operations for one companion.",
        "params": ("companion_id", "limit"),
        "statements": [
            (
                "select o.queue_sequence, o.id as operation_id, o.kind, o.trigger,\n"
                "       coalesce(to_jsonb(o)->>'execution_lane',\n"
                "         case when source_turn.routine_snapshot_id is not null\n"
                "              then 'routine' else 'main' end) as execution_lane,\n"
                "       o.source_turn_id, o.status, o.checkpoint,\n"
                "       o.checkpoint_sequence, o.attempt_count, o.available_at,\n"
                "       o.started_at, o.settled_at,\n"
                "       date_trunc('second', now() - o.created_at) as operation_age,\n"
                "       lease.executor_id, lease.claim_epoch,\n"
                "       lease.expires_at as lease_expires_at,\n"
                "       o.last_error_code, o.last_error_message, o.last_error_action\n"
                "from public.companion_operations o\n"
                "left join public.companion_turns source_turn\n"
                "  on source_turn.org_id = o.org_id\n"
                " and source_turn.companion_id = o.companion_id\n"
                " and source_turn.id = o.source_turn_id\n"
                "left join public.companion_runtime_leases lease\n"
                "  on lease.companion_id = o.companion_id\n"
                " and lease.lane = coalesce(to_jsonb(o)->>'execution_lane',\n"
                "   case when source_turn.routine_snapshot_id is not null\n"
                "        then 'routine' else 'main' end)\n"
                " and lease.work_kind = 'operation' and lease.work_id = o.id\n"
                "where o.companion_id = :'companion_id'::uuid\n"
                "order by o.queue_sequence desc\n"
                "limit :'limit'::int"
            ),
        ],
    },
    "instance": {
        "description": "Runtime instance projection for one companion (box, Pi, checkpoints).",
        "params": ("companion_id",),
        "statements": [
            (
                "select companion_id, generation, box_id, box_state, pi_state,\n"
                "       pi_invocation_id, disk_layout_version, desired_settings_revision,\n"
                "       applied_settings_revision, applied_skills_revision,\n"
                "       settings_checkpoint, settings_checkpoint_sequence,\n"
                "       settings_attempt_count, settings_available_at, health_checkpoint,\n"
                "       health_due_at, last_heartbeat_at, box_observed_at, pi_observed_at,\n"
                "       last_observed_at, retirement_state, material_expires_at,\n"
                "       skills_update_error_code, last_error_code, last_error_message,\n"
                "       last_error_action\n"
                "from public.companion_runtime_instances\n"
                "where companion_id = :'companion_id'::uuid"
            ),
        ],
    },
    "decisions": {
        "description": (
            "Recent decision deliveries (ask_user / proposals) for one companion, "
            "with status, delivery state, and expiry. Response text is deliberately "
            "not selected."
        ),
        "params": ("companion_id", "since_seconds", "limit"),
        "statements": [
            (
                "select created_at, id as delivery_id, turn_id, attempt_id, request_kind,\n"
                "       decision_status, delivery_state, delivery_checkpoint,\n"
                "       delivery_attempt_count, expires_at, responded_at, delivered_at,\n"
                "       last_error_code, last_error_message, last_error_action\n"
                "from public.companion_decision_deliveries\n"
                "where companion_id = :'companion_id'::uuid\n"
                "  and created_at >= now() - make_interval(secs => :'since_seconds'::int)\n"
                "order by created_at desc\n"
                "limit :'limit'::int"
            ),
        ],
    },
}

PARAM_SOURCES = {
    "companion_id": "companion",
    "turn_id": "turn",
    "since_seconds": "since",
    "limit": "limit",
}


def collect_params(name: str, args: argparse.Namespace) -> dict[str, str]:
    """Validate CLI arguments into psql variable values. Raises ProdToolError."""
    values: dict[str, str] = {}
    for param in QUERIES[name]["params"]:
        if param == "companion_id":
            if not args.companion:
                raise prodlib.ProdToolError(f"query {name} requires --companion <uuid>")
            if not prodlib.UUID_RE.match(args.companion):
                raise prodlib.ProdToolError("--companion must be a uuid")
            values[param] = args.companion.lower()
        elif param == "turn_id":
            if not args.turn:
                raise prodlib.ProdToolError(f"query {name} requires --turn <uuid>")
            if not prodlib.UUID_RE.match(args.turn):
                raise prodlib.ProdToolError("--turn must be a uuid")
            values[param] = args.turn.lower()
        elif param == "since_seconds":
            values[param] = str(prodlib.parse_since(args.since))
        elif param == "limit":
            if args.limit < 1 or args.limit > 10000:
                raise prodlib.ProdToolError("--limit must be between 1 and 10000")
            values[param] = str(args.limit)
        else:  # pragma: no cover - guarded by QUERIES literal
            raise prodlib.ProdToolError(f"unknown parameter {param}")
    return values


def wrap_read_only(statements: list[str], as_json: bool) -> str:
    """Wrap the named query's statements in an explicit read-only transaction."""
    rendered = []
    for statement in statements:
        body = statement.strip().rstrip(";")
        if as_json:
            rendered.append(
                "select coalesce(json_agg(row_to_json(q)), '[]'::json)\n"
                f"from (\n{body}\n) q;"
            )
        else:
            rendered.append(body + ";")
    return "BEGIN TRANSACTION READ ONLY;\n" + "\n".join(rendered) + "\nROLLBACK;\n"


def build_invocation(
    name: str,
    params: dict[str, str],
    as_json: bool,
) -> tuple[list[str], str]:
    """Return (argv, stdin_sql). The database URL is NOT part of argv."""
    if name not in QUERIES:
        raise prodlib.ProdToolError(
            f"unknown query {name!r}; available: {', '.join(sorted(QUERIES))}",
        )
    argv = ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-P", "pager=off"]
    if as_json:
        argv += ["-t", "-A"]
    for key, value in params.items():
        argv += ["-v", f"{key}={value}"]
    sql = wrap_read_only(QUERIES[name]["statements"], as_json)
    return argv, sql



def _libpq_env_from_url(url: str) -> dict:
    """Split a postgres:// URL into libpq PG* env vars (password out of argv)."""
    import urllib.parse as _u

    parsed = _u.urlparse(url)
    if parsed.scheme not in ("postgres", "postgresql"):
        raise prodlib.ProdToolError(
            "PROD_DATABASE_READ_URL must be a postgres:// connection URL"
        )
    out = {}
    if parsed.hostname:
        out["PGHOST"] = parsed.hostname
    if parsed.port:
        out["PGPORT"] = str(parsed.port)
    if parsed.username:
        out["PGUSER"] = _u.unquote(parsed.username)
    if parsed.password:
        out["PGPASSWORD"] = _u.unquote(parsed.password)
    dbname = parsed.path.lstrip("/")
    if dbname:
        out["PGDATABASE"] = _u.unquote(dbname)
    query = _u.parse_qs(parsed.query)
    sslmode = query.get("sslmode", [None])[0]
    if sslmode:
        out["PGSSLMODE"] = sslmode
    return out

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run one named read-only query against the production database",
        epilog="Named queries: " + "; ".join(
            f"{name}: {spec['description']}" for name, spec in sorted(QUERIES.items())
        ),
    )
    parser.add_argument("name", choices=sorted(QUERIES), help="named query to run")
    parser.add_argument("--companion", help="companion uuid")
    parser.add_argument("--turn", help="turn uuid")
    parser.add_argument("--since", default="24h", help="lookback window, e.g. 30m, 24h, 7d")
    parser.add_argument("--limit", type=int, default=50, help="row limit where applicable")
    parser.add_argument("--json", action="store_true", help="emit json_agg arrays per statement")
    args = parser.parse_args()

    env = prodlib.load_env()
    url = prodlib.require(env, "PROD_DATABASE_READ_URL")
    try:
        params = collect_params(args.name, args)
        argv, sql = build_invocation(args.name, params, args.json)
    except prodlib.ProdToolError as error:
        prodlib.fail(str(error))
        return

    # Parse the connection URL into individual libpq environment variables.
    # PGDATABASE is a literal database name (libpq does NOT expand a URI there),
    # so a full URL must be split; the password travels via PGPASSWORD in the
    # child environment, never in argv or a process listing.
    child_env = {
        **os.environ,
        **_libpq_env_from_url(url),
        "PGCONNECT_TIMEOUT": "10",
        "PGAPPNAME": "debug-companions-prod",
    }
    try:
        completed = subprocess.run(
            argv,
            input=sql,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except FileNotFoundError:
        prodlib.fail("psql is not installed or not on PATH")
        return
    except subprocess.TimeoutExpired:
        prodlib.fail("psql timed out after 120 seconds", code=1)
        return

    if completed.stdout:
        print(prodlib.redact(completed.stdout), end="")
    if completed.stderr:
        print(prodlib.redact(completed.stderr), end="", file=sys.stderr)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
