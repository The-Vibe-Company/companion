#!/usr/bin/env python3
"""Read-only Railway deployment status for the Companion production project.

Prints one line per service (``service status deployId commit age``) from the
most recent deployments in the configured environment, and warns when the
deployed commits differ across services.

The Railway GraphQL schema used here is UNVERIFIED — it follows the public
backboard v2 API documentation but has not been probed with a live token yet.
On any shape mismatch the script fails loudly with a pointer to
references/railway-api.md instead of guessing.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prodlib  # noqa: E402

RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2"

SERVICES = ("api", "worker", "runtime", "web", "release")

# VERIFIED live 2026-08-25 against project companion-v2 (backboard v2, Bearer
# auth). Service.deployments takes no `input` arg; the project has a single
# `production` environment so no environment filter is needed. See
# references/railway-api.md.
STATUS_QUERY = """
query CompanionDebugStatus($projectId: String!, $first: Int!) {
  project(id: $projectId) {
    name
    services {
      edges {
        node {
          id
          name
          deployments(first: $first) {
            edges {
              node {
                id
                status
                createdAt
                meta
              }
            }
          }
        }
      }
    }
  }
}
"""


def build_graphql_request(env: dict, query: str, variables: dict, auth_style: str = "bearer"):
    """Build (url, headers, body) for one Railway GraphQL call.

    ``auth_style`` is "bearer" (personal/team token) or "project"
    (Project-Access-Token header). Both are documented in
    references/railway-api.md; the caller tries bearer first.
    """
    token = prodlib.require(env, "RAILWAY_API_TOKEN")
    if auth_style == "bearer":
        headers = {"Authorization": f"Bearer {token}"}
    elif auth_style == "project":
        headers = {"Project-Access-Token": token}
    else:
        raise prodlib.ProdToolError(f"unknown auth style {auth_style!r}")
    return RAILWAY_GRAPHQL_URL, headers, {"query": query, "variables": variables}


def _auth_failed(status: int, payload: object) -> bool:
    if status in (401, 403):
        return True
    if isinstance(payload, dict):
        for error in payload.get("errors") or []:
            message = str(error.get("message", "")) if isinstance(error, dict) else str(error)
            if "not authorized" in message.lower() or "unauthorized" in message.lower():
                return True
    return False


def schema_error(context: str) -> prodlib.ProdToolError:
    return prodlib.ProdToolError(
        "Railway GraphQL response did not match the expected shape at "
        f"{context}. The schema used by this skill is UNVERIFIED and needs one "
        "live probe with a real token; see references/railway-api.md for the "
        "probe procedure, then adjust the query in this script.",
    )


def railway_graphql(env: dict, query: str, variables: dict, http=prodlib.http_json) -> dict:
    """POST one GraphQL query, retrying once with the project-token header on auth errors."""
    url, headers, body = build_graphql_request(env, query, variables, "bearer")
    status, payload = http("POST", url, headers=headers, body=body)
    if _auth_failed(status, payload):
        url, headers, body = build_graphql_request(env, query, variables, "project")
        status, payload = http("POST", url, headers=headers, body=body)
    if _auth_failed(status, payload):
        raise prodlib.ProdToolError(
            "Railway rejected both the Authorization: Bearer and Project-Access-Token "
            "auth styles. Check RAILWAY_API_TOKEN in the process environment or "
            "~/.companion-prod.env and see "
            "references/railway-api.md.",
        )
    if status != 200 or not isinstance(payload, dict):
        raise prodlib.ProdToolError(
            f"Railway GraphQL returned status {status}; see references/railway-api.md.",
        )
    if payload.get("errors"):
        messages = "; ".join(
            str(error.get("message", error)) if isinstance(error, dict) else str(error)
            for error in payload["errors"]
        )
        raise prodlib.ProdToolError(
            f"Railway GraphQL errors: {messages}. If this names an unknown field, the "
            "UNVERIFIED schema needs adjusting; see references/railway-api.md.",
        )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise schema_error("data")
    return data


def commit_from_meta(meta: object) -> str:
    if isinstance(meta, str):
        import json as _json

        try:
            meta = _json.loads(meta)
        except ValueError:
            return "-"
    if isinstance(meta, dict):
        for key in ("commitHash", "commitSha", "commit"):
            value = meta.get(key)
            if isinstance(value, str) and value:
                return value[:12]
        for nested in meta.values():
            if isinstance(nested, dict):
                found = commit_from_meta(nested)
                if found != "-":
                    return found
    return "-"


def extract_service_rows(data: dict, now: float) -> list[dict]:
    """Flatten the UNVERIFIED GraphQL response into service rows."""
    project = data.get("project")
    if not isinstance(project, dict):
        raise schema_error("data.project")
    services = project.get("services")
    if not isinstance(services, dict) or not isinstance(services.get("edges"), list):
        raise schema_error("data.project.services.edges")
    rows: list[dict] = []
    for edge in services["edges"]:
        node = edge.get("node") if isinstance(edge, dict) else None
        if not isinstance(node, dict) or not isinstance(node.get("name"), str):
            raise schema_error("services.edges[].node")
        deployments = node.get("deployments")
        deployment_edges = (
            deployments.get("edges") if isinstance(deployments, dict) else None
        )
        if not isinstance(deployment_edges, list):
            raise schema_error(f"service {node['name']} deployments.edges")
        deployment_rows = []
        for deployment_edge in deployment_edges:
            deployment = (
                deployment_edge.get("node") if isinstance(deployment_edge, dict) else None
            )
            if not isinstance(deployment, dict) or not isinstance(deployment.get("id"), str):
                raise schema_error(f"service {node['name']} deployments.edges[].node")
            created_at = str(deployment.get("createdAt", ""))
            deployment_rows.append({
                "id": deployment["id"],
                "status": str(deployment.get("status", "unknown")),
                "createdAt": created_at,
                "commit": commit_from_meta(deployment.get("meta")),
                "age": prodlib.format_age(now - prodlib.parse_iso_timestamp(created_at)),
            })
        rows.append({"service": node["name"], "deployments": deployment_rows})
    return rows


def divergent_commits(rows: list[dict]) -> set[str]:
    """Distinct latest deployed commits across the long-lived services."""
    commits = set()
    for row in rows:
        if row["service"] == "release" or not row["deployments"]:
            continue
        commit = row["deployments"][0]["commit"]
        if commit != "-":
            commits.add(commit)
    return commits


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Show Railway deployment status per Companion service (read-only)",
    )
    parser.add_argument("--service", choices=SERVICES, help="limit output to one service")
    parser.add_argument("--json", action="store_true", help="print structured JSON")
    args = parser.parse_args()

    env = prodlib.load_env()
    variables = {
        "projectId": prodlib.require(env, "RAILWAY_PROJECT_ID"),
        "environmentId": prodlib.require(env, "RAILWAY_ENVIRONMENT_ID"),
        "first": 5,
    }
    import time as _time

    try:
        data = railway_graphql(env, STATUS_QUERY, variables)
        rows = extract_service_rows(data, _time.time())
    except prodlib.ProdToolError as error:
        prodlib.fail(str(error), code=1)
        return

    if args.service:
        rows = [row for row in rows if row["service"] == args.service]
        if not rows:
            prodlib.fail(f"service {args.service} not found in the Railway project", code=1)

    if args.json:
        prodlib.print_json(rows)
        return

    prodlib.print_redacted(f"{'service':<10} {'status':<12} {'deployId':<38} {'commit':<13} age")
    for row in rows:
        if not row["deployments"]:
            prodlib.print_redacted(f"{row['service']:<10} (no deployments in this environment)")
            continue
        latest = row["deployments"][0]
        prodlib.print_redacted(
            f"{row['service']:<10} {latest['status']:<12} {latest['id']:<38} "
            f"{latest['commit']:<13} {latest['age']}",
        )
    commits = divergent_commits(rows)
    if len(commits) > 1:
        prodlib.print_redacted(
            "WARNING: deployed commits differ across services "
            f"({', '.join(sorted(commits))}). Runbook requires deploying api, worker, "
            "runtime, and web from the same commit.",
        )


if __name__ == "__main__":
    main()
