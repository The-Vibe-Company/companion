# Web and API contract

The browser uses same-origin JSON routes and Better Auth cookies. Authenticated product data is
always scoped to the session's personal owner ID. Responses carry `Cache-Control: no-store`.
A `401` returns the interface to sign-in; validation, conflict, and inactive-product errors remain
visible rather than being converted into success states.

## Authentication and configuration

- `POST /api/auth/sign-in/magic-link` with `{ email, callbackURL: "/" }` sends a ten-minute link.
- `POST /api/auth/sign-out` ends the current session.
- `GET /api/me` returns `{ user: { id, email, name } }`.
- `GET /api/config` returns `{ models: [{ id, name }], localAvailable, boxAvailable, model }`.
- The localhost sign-in screen links to Mailpit at web port `+6`; hosted builds do not expose it.

## Companions, chat, questions, and files

- `GET|POST /api/companions` lists or creates owned Companions. Creation accepts
  `{ name, instructions, provider, avatar }`.
- `GET|PATCH /api/companions/:id` reads detail or updates `{ name, instructions, avatar, modelId }`.
  Avatar is `{ shape: 0..7, color: 0..10, face: 0..4 }`.
- Detail includes `messages`, `runs`, unresolved `questions`, private message `files`, lifecycle
  fields, and `previewText` only for an active main response. The UI suppresses a preview once an
  assistant message with the same `runId` exists.
- Companion status includes `archived`; the UI labels it “Sleeping” because its persistent disk is
  retained and a later work request can resume it.
- `POST /api/companions/:id/messages` accepts
  `{ clientMessageId, content, attachmentCount }` and returns `202 { runId }`.
- `POST /api/companions/:id/cancel` cancels the current main task. A task-specific cancellation is
  `POST /api/companions/:id/runs/:runId/cancel`.
- `POST /api/companions/:id/questions/:questionId/answer` accepts `{ answer }`.
- Each file is uploaded after admission to `POST /api/companions/:id/runs/:runId/files` as multipart
  `file`, stable UUID `clientFileId`, and zero-based `position`. Authenticated file URLs proxy bytes;
  the browser never receives an object key or signed storage URL.

## Connections

- `GET /api/plugins` returns `{ catalog, accounts }`.
- `POST /api/plugins/connect` accepts `{ serverId, label }` and returns `{ url }` for OAuth.
  An anonymous App returns `{ account }` with status `201` on creation or `200` for the existing connection.
- `GET /api/plugins/callback` completes a session-bound OAuth flow.
- `POST /api/plugins/custom` accepts an HTTPS MCP definition; the server also supports bounded
  stdio definitions for control/API callers.
- `DELETE /api/plugins/:accountId` disconnects an owned account.
- `GET /api/companions/:id/plugins` returns selected accounts;
  `PUT|DELETE /api/companions/:id/plugins/:accountId` grants or removes machine access.

## Routines

- `GET|POST /api/companions/:id/routines` lists or creates a routine.
- `GET /api/companions/:id/routines/:routineId/history` returns runs and missed windows;
  `PATCH|DELETE /api/companions/:id/routines/:routineId` changes or removes it.
- `POST /api/companions/:id/routines/:routineId/test` accepts a retry-stable
  `{ clientMessageId }`, enqueues the routine prompt, and returns `202 { runId }`.
- Rows use `{ id, name, prompt, cron, timezone, enabled, nextFireAt, createdAt, updatedAt }`.
  The web form currently offers three friendly presets; the backend and control MCP accept valid
  five-field cron plus an IANA timezone.

## Triggers and public webhooks

- Authenticated CRUD is `GET|POST /api/companions/:id/triggers` and
  `PATCH|DELETE /api/companions/:id/triggers/:triggerId`.
- `POST .../:triggerId/test` evaluates without enqueueing; `POST .../:triggerId/register` retries
  managed provider registration; `GET .../:triggerId/deliveries` returns recent decisions.
- Definitions include `name`, `prompt`, `source`, `mode`, optional `filter`, declared
  `filterRequests`, `problemPath`, provider account and target, and `enabled`. Public projections
  include registration state and URL but never a secret. Generic creation returns its secret once.
- `POST /api/webhooks/:triggerId` is public and authenticates its own raw body using the generic,
  GitHub, or Sentry signature contract. It persists receipt and returns `202`; the worker performs
  filtering, provider reads, grouping, and background admission later.

## Templates, delegation, and lifecycle

- `GET|POST /api/templates` lists or creates declarative specialist profiles;
  `PATCH /api/templates/:id` requires `expectedRevision`.
- Creation with `draft: true` opens conversational specialist configuration. `GET|POST|PATCH
  /api/templates/:id/draft` reads, opens or updates the draft; edits require `expectedGeneration`.
  `POST .../draft/test` accepts a representative prompt, and `POST .../draft/publish` requires
  explicit `contentReviewed`. Both use durable command IDs and expose persisted operation states.
  The configuration chat is unavailable while capture or testing holds the draft. Test assessment
  is separate from execution success; testing is strongly suggested but optional for publication.
- Team connection slots use `GET|PATCH /api/companions/:id/specialists/:templateId/connections`.
  Defaults belong to the specialist; overrides select compatible accounts already granted to the
  parent. Delivered specialists show missing requirements until the recipient reconnects them.
- `GET /api/companions/:id/specialist-improvements` returns persisted proposals. Preparing one
  through `/api/specialist-improvements/:id/apply` queues reconstruction and opens configuration;
  it does not represent a completed update. Reject is a separate idempotent action.
- `GET|PATCH /api/account/specialist-limits` exposes effective limits, waiting requests and the
  personal active ceiling. `/api/account/specialist-requests/:id/cancel` persists cancellation;
  capacity is released only after the corresponding machine is confirmed stopped when necessary.
- `GET /api/templates/:id/revisions` returns immutable revisions.
  `POST /api/templates/:id/rollback` accepts `{ targetRevision, expectedRevision }` and appends the
  restored profile, snapshot reference, and portable-skill bundle as a new revision. The Team sheet
  exposes a compact earlier-version selector and surfaces optimistic-concurrency conflicts.
- `GET /api/companions/:id/templates` lists permissions;
  `PUT /api/companions/:id/templates/:templateId` sets `{ maxChildren }`.
- `GET|POST /api/companions/:id/replicas` lists active children or launches one with
  `{ clientCommandId, templateId, prompt }`.
- Lifecycle commands also accept native operation aliases under `/api/companions/:id/` for
  `prepare`, `spawn`, `adopt-template`, `template-permission`, `desktop-takeover`, and
  `desktop-release`. Command IDs remain stable across retries.
- `POST /api/companions/:id/desktop` returns `{ url }` when ready or `202 { preparing: true }`.
  `POST .../desktop/takeover|release` persists human-control intent. The browser polls detail and
  claims control only when `desktopPausedAt` confirms the runtime boundary.

## Billing and client delivery

- `GET /api/billing` returns `{ configured, mode, plan, active, status, currentPeriodEnd,
  cancelAtPeriodEnd, portalAvailable, usage }`. Test activation is labeled separately from a live
  subscription.
- `POST /api/billing/checkout` and `POST /api/billing/portal` return a hosted `{ url }` when the
  configured Stripe state permits them.
- `POST /api/stripe/webhook` is public and verifies the signature over the untouched body before
  applying a deduplicated event.
- `GET|POST /api/deliveries` lists sent/received invitations or creates one from
  `{ clientDeliveryId, companionId, clientEmail, templateIds, maintenanceRequested, includeSkills }`.
  `includeSkills` defaults to true; listings expose `skillsStatus` and `skillsError`, and activation
  remains unavailable until every requested portable bundle is ready. The web shows “Preparing
  skills…”, the persisted error, or “Ready for client”; it never infers that mail was sent. The web
  retains `clientDeliveryId` across an unchanged retry; the server persists its request fingerprint,
  returns the original invitation for an identical retry, and rejects changed details.
- `POST /api/deliveries/:id/accept` accepts `{ grantMaintenance }` from the matching verified email.
  `DELETE /api/deliveries/:id` revokes a pending invitation;
  `DELETE /api/deliveries/:id/maintenance` revokes accepted maintenance consent.

## Granted maintenance

- `GET /api/maintenance` lists only Companions covered by the caller's explicit, non-revoked grant.
- `GET|PATCH /api/maintenance/companions/:id` returns bounded runtime status and changes the client's
  name, instructions, avatar, or model through the client's ownership scope.
- `POST .../:id/prepare` requests preparation; `POST .../:id/tasks` accepts retry-stable
  `{ clientMessageId, prompt }`; `GET .../:id/actions` returns the audit history.
- These routes never expose the client's chat, files, connections, credentials, or desktop.

## Current web boundary

The web app exposes Companion creation/chat, activity, identity/model, routine test/history,
selected tools, provider-specific triggers with filters/test/delivery inspection/recovery,
specialist profiles/launch, client delivery, granted maintenance, global connections,
billing/account, template history/rollback, and desktop control in compact sheets. Template
adoption and permanent delegation remain API/control-MCP capabilities without complete web flows.
Portable-skill transfer is wired into delivery and lifecycle preparation; the UI reports its
persisted readiness without simulating progress. See [v0.md](v0.md).
