# Issue tracker: Linear

Issues and specs for this repo live in **Linear**, not GitHub Issues. Skills such as
`to-tickets`, `triage`, `to-spec`, and `wayfinder` read from and write to Linear through the
**GraphQL HTTP API**. Do not use a Linear MCP connector for these skills.

## Access

- Endpoint: `https://api.linear.app/graphql`
- Auth: personal API key from the `LINEAR_API_KEY` environment variable, sent raw in the
  `Authorization` header (no `Bearer` prefix).
- The key is The Vibe Company's Linear key, held as a Companion secret. If the variable is not
  already exported, source the Companion projection before calling the API:
  `set -a; . ~/.companion/secrets/<workspace-id>/_manual/linear/.env; set +a`
  (the projection is written by `sync_secrets.py manual linear <secret-id> LINEAR_API_KEY --confirm`
  from the `companion` skill; never print or copy its contents).
- If `LINEAR_API_KEY` is missing or the request returns `401`, **stop** and tell the user the
  exact setup requirement. Never draft or "remember" issues instead of filing them.

Helper used throughout this file (`lq` = "linear query"):

```bash
lq() { local vars="${2:-"{}"}"; curl -sS https://api.linear.app/graphql \
  -H "Content-Type: application/json" -H "Authorization: $LINEAR_API_KEY" \
  --data "$(jq -cn --arg q "$1" --argjson v "$vars" '{query:$q, variables:$v}')"; }
```

## Scope: team and project

**Confirmed team key:** _not yet confirmed_ · **Confirmed project:** _none_

The Companion team and project have not been pinned yet. On the **first Linear write in a
session**, discover the candidates and confirm the target with the user before creating anything:

```bash
lq 'query { teams { nodes { id key name } } }' | jq '.data.teams.nodes'
lq 'query { projects(first: 50) { nodes { id name state teams { nodes { key } } } } }' | jq '.data.projects.nodes'
```

Once the user confirms, replace the line above with the real key and project name so later
sessions skip the discovery step. Reads may proceed without confirmation when the user has named
the team or issue identifier explicitly.

## Conventions

Issue identifiers look like `TEAM-123`. `issue(id:)` accepts either the identifier or the UUID.

- **Create an issue**:
  `lq 'mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { id identifier url } } }' '{"i":{"teamId":"<team-uuid>","title":"...","description":"...","labelIds":["..."]}}'`.
  Build the description in a shell variable or file and pass it through `jq --rawfile` for
  multi-line markdown. Add `"projectId"` when a project is confirmed.
- **Read an issue**:
  `lq 'query($id: String!) { issue(id: $id) { identifier title description url state { name type } labels { nodes { name } } assignee { name } comments { nodes { body user { name } createdAt } } } }' '{"id":"TEAM-123"}'`
- **List issues**: filter by team, open state, and label. Open means state type not in
  `completed`/`canceled`.
  `lq 'query($f: IssueFilter) { issues(filter: $f, first: 100) { nodes { identifier title description url labels { nodes { name } } state { name type } assignee { name } } } }' '{"f":{"team":{"key":{"eq":"<KEY>"}},"state":{"type":{"nin":["completed","canceled"]}},"labels":{"name":{"eq":"needs-triage"}}}}'`
- **Comment on an issue**:
  `lq 'mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }' '{"i":{"issueId":"<issue-uuid>","body":"..."}}'`
- **Apply / remove labels**: `issueUpdate` takes the **full** `labelIds` set and replaces it. Read
  the current labels first, then send the adjusted list:
  `lq 'mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }' '{"id":"<issue-uuid>","i":{"labelIds":["..."]}}'`.
  Resolve label names to ids with
  `lq 'query { issueLabels(first: 250) { nodes { id name team { key } } } }'`. Create a missing
  label with `issueLabelCreate(input: {name, teamId})` (omit `teamId` for a workspace label).
- **Close**: comment first, then move to the team's `completed` state. Find it with
  `lq 'query($k: String!) { team(id: $k) { states { nodes { id name type } } } }' '{"k":"<KEY>"}'`
  and set `stateId` via `issueUpdate`. Use the `canceled` state for `wontfix`.
- **Assign to me**: `viewer { id }` gives the current user's id; set `assigneeId` via `issueUpdate`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external GitHub PRs as
feature requests; `/triage` reads this flag.)_

Pull requests still live on GitHub (`The-Vibe-Company/companion`). When set to `yes`, external PRs
run through the same triage labels using `gh pr view`, `gh pr list --json ... authorAssociation`,
`gh pr comment`, `gh pr edit --add-label`, and `gh pr close`, keeping only `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR`, or `NONE` authors. Link the resulting Linear issue from the PR and vice
versa; a bare `#42` in this repo always means a GitHub PR, never a Linear issue.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the confirmed team (and project, if any).

## When a skill says "fetch the relevant ticket"

Run the **Read an issue** query with the `TEAM-123` identifier, including comments.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: one issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a Linear **sub-issue** of the map, created with `"parentId": "<map-uuid>"`
  in `IssueCreateInput`. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
  Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: Linear's native **issue relations**. Add an edge with
  `issueRelationCreate(input: {issueId: "<blocker-uuid>", relatedIssueId: "<child-uuid>", type: blocks})`.
  A child is unblocked when every issue in its `inverseRelations(filter: {type: {eq: "blocks"}})`
  is in a `completed` or `canceled` state.
- **Frontier query**: list the map's open children
  (`issue(id: "<map>") { children { nodes { ... inverseRelations { nodes { type issue { state { type } } } } assignee { id } } } }`),
  drop any with an open blocker or an assignee; first in map order (`sortOrder`) wins.
- **Claim**: set `assigneeId` to `viewer.id`, the session's first write.
- **Resolve**: comment the answer, move the child to `completed`, then append a context pointer
  (gist + link) to the map's Decisions-so-far.
