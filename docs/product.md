# Companion product

## Product definition

Companion is a multi-tenant Skills Hub organized as **Organization → User**, with optional
hosted Companions. Skills are the durable capability layer. A Companion is one named, asynchronous
teammate that applies selected Skills and member-connected MCP plugins inside one persistent Box
through Pi.

Members use the web or CLI for Skills Hub workflows. External coding agents use delegated Agent
Auth to consume the same skill APIs. Hosted Companions use a separate authenticated chat and runtime
boundary; Agent Auth never grants Box lifecycle access.

Each member may store one IANA timezone in their personal profile. It is shared across their
workspaces and first-party web, iOS, and macOS clients, not inferred from a per-message client header. The
clients offer their browser or device timezone as the initial choice. When it is unset, runtime uses
UTC until the member saves an override.

## Users and authorization

- **Organization Owner** manages organization identity, membership, billing, GitHub, provider
  connections, and policy.
- **Organization Admin** manages the same workspace settings allowed by RBAC.
- **Developer** creates, organizes, publishes, installs, comments on, and uses skills.
- **External coding agent** is a delegated Skills Hub client with only approved capabilities for one
  organization. Companion does not launch it.
- **Companion Owner** owns one hosted Companion, manages its sharing/provider, and alone may
  permanently delete it.
- **Companion Editor** may send messages, answer decisions, change allowed settings, and use explicit
  runtime actions.
- **Companion Viewer** reads the PostgreSQL projection only. Viewer access never contacts or wakes
  Box and exposes no mutation controls.

The Companion Owner is immutable. Sharing is workspace-wide Editor or Viewer access; it does not
change Skills Hub ownership and does not grant access to another member's personal Skills or plugin
credentials.

## Libraries and ownership

- `org`: flat organization-wide library. Every member can read and manage its skills.
- `personal`: private **My Skills** library. Only `creator_id` can read or manage the skill; admins
  have no override.
- A slug is unique across both scopes in an organization.
- **Share** is the sole, owner-only, one-way `personal → org` transition.
- **Installed** is a view: a member's personal skills plus org skills with a `skill_installs` row.

Organization labels form a shared tree. Personal labels form a private per-member tree. Labels are
slash-separated, multi-assigned, and may exist without skills.

## Core journeys

1. Create or upload a package; validate archive safety, `SKILL.md`, manifest, dependencies, secrets,
   and database declarations.
2. Publish an immutable version and review its files, history, dependency graph, comments, and
   activity.
3. Share a personal skill to the organization with its required private dependency closure.
4. Install or update a skill into supported external coding tools and report the installed version.
5. Publish one pinned organization version as a checksum-addressed public release.
6. Mirror organization skills to GitHub deterministically.
7. Let an approved external coding agent read/write skills, use Skill Databases, or retrieve bound
   secrets through constrained grants.
8. When Companions are enabled, create a named Companion with one connected provider/model, selected
   Skills, and selected member MCP accounts; send work and leave while it continues.
9. Return to a durable thread that truthfully shows queued, active, input-needed, completed, failed,
   interrupted, automatically abandoned, or cancelled work. An ambiguous occurrence is never
   replayed: Companion cleans up its exact Pi invocation and releases the queue automatically.
   Native iOS restores the latest roster and bounded transcript tail locally so returning to the
   product stays immediate and readable offline while fresh authority and projection deltas arrive.
10. See and create routine schedules, open each run's private transcript from its compact chat
    marker, and distinguish terminal relay, notify, no-output, and error outcomes on web and native
    Apple clients. Time references render in the member's stored timezone.
11. Let a Companion manage its own allowed configuration through `companion-control`, approve
    sensitive changes asynchronously, and delegate one bounded text task to an approved peer with
    the result visible in both durable threads.

## Hosted Companion boundary

`COMPANION_COMPANIONS_ENABLED` plus the existing exact email-domain allowlist gates the entire
surface. Disabled means routes, navigation, and new runtime claims fail closed.

Each Companion has exactly one thread, one Box, and one Pi daemon. The API persists messages, turns,
decisions, settings, and lifecycle operations and returns `202`; it never contacts Box or Pi. A
dedicated runtime service serializes work per Companion execution lane, revalidates current authority and selected
resources, and owns every provider side effect.

Sending is the only normal wake path. There is no Wake button and no keystroke prewarm. Pi must be
idle before main dispatch, only one attempt may be active per lane, and queued turns preserve lane
order. One isolated routine attempt may run alongside one ordinary main attempt. An attempt
without a provable Pi acknowledgement becomes `interrupted` and is never replayed. Protocol 7 uses
resource-independent cleanup to terminate only its exact Pi invocation, marks that occurrence
`auto_abandoned`, and continues the lane; cleanup retries with bounded backoff without blocking an
independently warm lane. It never stages resources, restarts Pi, or resumes/restarts the Box. Full
Box restart is always an explicit, confirmed Editor/Owner action.

Provider connections and member MCP accounts are envelope-encrypted and survive the one-time legacy
Companion purge. Old Companions, Boxes, transcripts, runtime rows, pools, and leases do not migrate.

The product-owned plugin catalog includes Slack as a per-member labeled Bot User OAuth account. A
Companion may send bounded messages to a known Slack conversation or thread through its selected
account; the OAuth app secret stays on API and the bot token stays behind the loopback MCP broker.
Slack Events API receive is delivered separately through the ordinary trigger model.

Gmail is a product-owned, member-level plugin backed by Google's remote Gmail MCP server. A labeled
account grants only search/read and draft creation; the member reviews and sends every draft in
Gmail. Companion does not expose send, label mutation, deletion, or new-email triggers in v1.
Email content is external untrusted data and never becomes runtime instruction.

Sentry is a product-owned, member-level plugin backed by Sentry's official hosted MCP remote. A
labeled account can inspect the issues, events, traces, releases, and debugging context authorized
in Sentry. The OAuth approval remains the authority for any optional triage or project-management
tools, and runtime treats all captured request data, breadcrumbs, tags, and user values as external
untrusted data.

## Explicit exclusions

Historical Projects and generic skill runs remain removed. This release adds no Group/Room model,
autonomous multi-Bot orchestration, proactive jobs, Companion voice conversation/runtime audio, file library, file versioning,
artifact surface outside the thread, harness selection, Box-provider marketplace, container catalog,
deployment management, or generic AI application builder. Scheduled Companion routines are in
scope: Owner/Editor-gated cron prompts that enqueue ordinary turns. Webhook-fired Companion
triggers are in scope: Owner/Editor-gated named rules that Companion registers end-to-end with held
provider credentials, then validates in isolated runs before notifying or relaying. Directed,
grant-gated text delegations between existing Companions are also in scope as the bounded
collaboration primitive beneath any future group experience. Chat files are
in scope and bounded: images and documents sent with a message, and
images Pi hands back from a turn. The iOS and macOS apps are complete Companion clients over the
same API, not reduced product surfaces: Skills, Plugins, MCP connections, files, routines,
triggers, sharing, settings, and the remaining browser workflows migrate milestone by milestone.
Native iOS dictation is an input method exception: compressed microphone audio is transiently sent
through the API and transcribed with a bounded window of recent user/assistant messages as context.
It becomes editable composer text before an ordinary message is sent, creates no audio turn, and
does not change Runtime v2. Neither audio nor the provider response is persisted. A deployment-owned
API key enables it for every workspace; without that key, the API reports the capability unavailable
and native clients hide the microphone.
