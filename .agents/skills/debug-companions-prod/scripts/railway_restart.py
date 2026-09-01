#!/usr/bin/env python3
"""Restart one Railway service deployment. The only mutating script in this skill.

Double-gated: it refuses unless BOTH the explicit
``--i-know-this-restarts-prod`` flag is passed AND ``DEBUG_PROD_ALLOW_RESTART=1``
is set in the process environment or optional credential file. It never targets
the ``release`` service.

The ``deploymentRestart`` GraphQL mutation shape is UNVERIFIED — see
references/railway-api.md.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prodlib  # noqa: E402
import railway_logs  # noqa: E402
import railway_status  # noqa: E402

RESTARTABLE_SERVICES = ("api", "worker", "runtime", "web")

# UNVERIFIED schema: needs one live probe with a real token. See
# references/railway-api.md.
RESTART_MUTATION = """
mutation CompanionDebugRestart($deploymentId: String!) {
  deploymentRestart(id: $deploymentId)
}
"""

PRECONDITIONS = """\
Runbook preconditions before restarting a production service
(docs/runbooks/companions-runtime.md):

- A runtime replica receiving SIGTERM stops new claims, reaches bounded safe
  checkpoints, and releases or loses its leases; another replica must take
  over within 45 seconds. If that cannot happen, use the kill switch instead.
- Never restart to "clear" an interrupted or ambiguous turn. Ambiguous work
  is released by protocol 7 cleanup of its exact Pi invocation; a service
  restart does not replace that proof and must not replay the prompt.
- Never clear lease rows or edit epochs manually around a restart.
- A restart is not the kill switch. For provider instability, unsafe duplicate
  execution, credential exposure, or broken fencing, fence the database gate
  first (human + migration owner action; this skill only reads gate status).
- Record the environment, release commit, and operator/change id for every
  production change.
"""


def check_restart_allowed(
    service: str,
    flag_given: bool,
    allow_restart_env: str,
) -> tuple[bool, str]:
    """Pure double-gate decision. Returns (allowed, reason_when_refused)."""
    if service == "release":
        return False, (
            "refusing to touch the release service: it is a one-shot migration "
            "job and restarting it could re-run owner-level migrations"
        )
    if service not in RESTARTABLE_SERVICES:
        return False, f"unknown service {service!r}"
    if not flag_given:
        return False, (
            "missing --i-know-this-restarts-prod. This command restarts a "
            "production service; pass the flag only after reading the printed "
            "runbook preconditions"
        )
    if allow_restart_env != "1":
        return False, (
            "DEBUG_PROD_ALLOW_RESTART is not 1 in the process environment or "
            "~/.companion-prod.env. This "
            "second gate exists so a copy-pasted command cannot restart prod; "
            "set it deliberately, run the restart, then unset it"
        )
    return True, ""


def run(args: argparse.Namespace, env: dict, http=prodlib.http_json) -> int:
    allowed, reason = check_restart_allowed(
        args.service,
        args.i_know_this_restarts_prod,
        env.get("DEBUG_PROD_ALLOW_RESTART", ""),
    )
    prodlib.print_redacted(PRECONDITIONS)
    if not allowed:
        prodlib.print_redacted(f"refused: {reason}")
        return 2

    deployment_id = railway_logs.resolve_latest_deployment(env, args.service, http=http)
    prodlib.print_redacted(
        f"Restarting {args.service} deployment {deployment_id} in environment "
        f"{env.get('RAILWAY_ENVIRONMENT_ID', '')} ...",
    )
    data = railway_status.railway_graphql(
        env, RESTART_MUTATION, {"deploymentId": deployment_id}, http=http,
    )
    prodlib.print_redacted(f"deploymentRestart accepted: {data.get('deploymentRestart')}")
    prodlib.print_redacted(
        "Follow up: railway_status.py until the deployment is SUCCESS, then "
        "db_query.py health, then unset DEBUG_PROD_ALLOW_RESTART.",
    )
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Restart one Railway service (double-gated; never targets release)",
    )
    parser.add_argument("--service", required=True, choices=RESTARTABLE_SERVICES + ("release",))
    parser.add_argument(
        "--i-know-this-restarts-prod",
        action="store_true",
        help="explicit acknowledgement that this restarts a production service",
    )
    args = parser.parse_args()
    env = prodlib.load_env()
    try:
        raise SystemExit(run(args, env))
    except prodlib.ProdToolError as error:
        prodlib.fail(str(error), code=1)


if __name__ == "__main__":
    main()
