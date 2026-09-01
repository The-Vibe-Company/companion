# Railway GraphQL API notes

Endpoint used by `railway_status.py`, `railway_logs.py`, and
`railway_restart.py`:

```
POST https://backboard.railway.com/graphql/v2
Content-Type: application/json
```

## Authentication — two header styles

Railway accepts different headers depending on the token kind. The scripts try
(1) first and automatically fall back to (2) on a 401/403 or a
"Not Authorized" GraphQL error:

1. **Personal or team token**

   ```
   Authorization: Bearer <RAILWAY_API_TOKEN>
   ```

2. **Project access token** (scoped to one project + environment)

   ```
   Project-Access-Token: <RAILWAY_API_TOKEN>
   ```

Both use the same `RAILWAY_API_TOKEN` value from the process environment or the
optional `~/.companion-prod.env` fallback. A project token is the
least-privilege choice for this skill.

## UNVERIFIED schema — needs one live probe

The exact query/mutation shapes below follow Railway's public API v2
documentation but have **not been probed with a real token from this skill
yet**. Field names (`deployments(first:, input: { environmentId })`, `meta`,
`deploymentLogs`, `deploymentRestart`) may differ from the live schema. The
scripts fail closed with an actionable error naming the mismatched path
instead of guessing.

To verify once, with a real token:

```bash
python3 scripts/railway_status.py --json
```

If it fails with a schema-mismatch or GraphQL error, run an introspection
probe (redact the output before sharing):

```bash
# Careful: do NOT paste the token into a transcript. The scripts build the
# header in-process; if you must probe manually, use an env var reference.
python3 - <<'EOF'
import json, sys
sys.path.insert(0, ".claude/skills/debug-companions-prod/scripts")
import prodlib, railway_status
env = prodlib.load_env()
query = '{"query": "query { project(id: \"...\") { __typename } }"}'
EOF
```

then adjust `STATUS_QUERY` / `LOGS_QUERY` / `RESTART_MUTATION` in the scripts
and update this file. Known likely variance points:

- `deployments` filtering may take `input: DeploymentListInput` or flat
  arguments (`environmentId:`) depending on schema version.
- `meta` may be a JSON scalar (object) or a JSON string; `commit_from_meta`
  handles both and searches nested objects for
  `commitHash`/`commitSha`/`commit`.
- `deploymentLogs` may cap `limit` server-side and may name the entries
  `timestamp`/`severity`/`message` differently.
- `deploymentRestart` may return a boolean or an object.

## Queries used

Status (per service, latest 5 deployments in the environment):

```graphql
query CompanionDebugStatus($projectId: String!, $environmentId: String!, $first: Int!) {
  project(id: $projectId) {
    name
    services {
      edges {
        node {
          id
          name
          deployments(first: $first, input: { environmentId: $environmentId }) {
            edges { node { id status createdAt meta } }
          }
        }
      }
    }
  }
}
```

Logs (one deployment):

```graphql
query CompanionDebugLogs($deploymentId: String!, $limit: Int!) {
  deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
    timestamp
    severity
    message
    attributes { key value }
  }
}
```

Restart (mutating — double-gated in `railway_restart.py`; never `release`):

```graphql
mutation CompanionDebugRestart($deploymentId: String!) {
  deploymentRestart(id: $deploymentId)
}
```

## Service topology reminder

From `deploy/railway/README.md`: `web` and `api` are public; `worker` and
`runtime` are private with no inbound route; `release` is a one-shot
owner-migration job and must never be restarted (the restart script refuses
it). Runtime `/healthz` is private — do not try to reach it over the public
internet; use logs and `db_query.py health` instead.

## Live verification (2026-08-25, project companion-v2, production)

Verified against the real backboard v2 API with a Railway CLI session token:

- **Auth**: `Authorization: Bearer <token>` works. A **non-default `User-Agent`
  header is REQUIRED** — the default Python-urllib UA gets a bare `403` from
  Railway's edge (Cloudflare). `prodlib.http_json` now always sends one.
- **`Service.deployments` takes NO `input` argument** (the earlier
  `input: { environmentId }` was rejected: *"Unknown argument input"*). The
  project has a single `production` environment, so `deployments(first: N)` is
  used without an environment filter. STATUS_QUERY updated accordingly — VERIFIED.
- **`deploymentLogs(deploymentId, limit) { timestamp severity message attributes { key value } }`**
  — VERIFIED.
- **`deploymentRestart`** (the mutation in railway_restart.py) remains
  UNVERIFIED by design — it is a production mutation and is not probed casually.

## Structured runtime logs live in `attributes`, not `message` (2026-08-31)

The runtime emits JSON logs, and Railway **splits them into `attributes` and
leaves `message` empty**. Selecting only `message` therefore yields entries that
are all blank — and the earlier tool reported `-- 2001 matching lines` of
nothing, which reads exactly like "the runtime logged nothing". During the
2026-08-31 wedged-lane incident this hid 163 `runtime.work.fence_lost` records
that named the root cause outright.

`railway_logs.py` now selects `attributes` and rebuilds the record via
`record_from_attributes()` when `message` is not itself JSON. If every matched entry
still renders empty it prints a loud stderr warning (in **both** default and `--json`
mode) rather than a page of blank lines. It warns instead of exiting because a genuinely
idle service also returns empty messages — that is not an error, but it must never be
misread as "no matching logs". Each attribute `value` is JSON-encoded, so nested objects
such as `thrown` must be `json.loads`-ed.

Do not read an empty result as "no such logs" without checking `attributes`.
