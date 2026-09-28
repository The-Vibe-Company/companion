# companions.build

Persistent AI companions with their own computer. Each personal account owns an isolated set of
Companions, conversations, connections, automations, templates, files, and billing records. Pi is
the agent harness, Bun packages the Linux runtime, PostgreSQL is the durable control plane, and the
web client uses React, shadcn/ui, and AI Elements.

The repository currently implements the local product path and the hosted integration boundaries.
It is not evidence that the hosted service, provider OAuth applications, Stripe prices, or cold
Box performance are production ready. See [the V0 status and gaps](docs/v0.md).

This product lives in `The-Vibe-Company/companion`. The former Skills Hub is maintained in
[Skillpack](https://github.com/The-Vibe-Company/skillpack). See the
[repository migration notes](docs/repository-migration.md) for history and deployment boundaries.

## Run locally

For the agent development loop and the Herdr service control panel, start with
[the worktree workflow](docs/dev-workflow.md): `./dev setup --portless`, then `./dev workspace`.
The panel starts, stops and restarts components and exposes service URLs and validation results.

Prerequisites are Python 3, Docker, and Git. The launcher downloads checksum-verified Bun 1.4.2
inside the checkout and starts isolated PostgreSQL, MinIO, Mailpit, API, worker, executor, and web
processes.

```sh
git clone https://github.com/The-Vibe-Company/companion.git
cd companion
python3 scripts/dev.py
```

Open the printed web address, enter an email, then use the link in the printed Mailpit address.
Local mode uses a deterministic Pi test model by default. Create a Companion and send `write-note`
to exercise a real Pi tool call inside its Linux container. `slow-write` exercises cancellation;
`crash-after-effect` exercises recovery without repeating the tool effect.

Each checkout derives its own ports, database, object bucket, mail inbox, and labeled containers.
Set `CONDUCTOR_PORT` to choose an explicit web port; API is `+1`, PostgreSQL `+2`, MinIO `+3`,
Mailpit SMTP `+5`, and Mailpit web `+6`. Ctrl-C stops resources owned by that checkout while
retaining its local data.

For real model responses, create an uncommitted `.env`:

```dotenv
AGENT_TEST_MODE=0
MODEL_PROVIDER=google
MODEL_ID=gemini-2.5-flash
GEMINI_API_KEY=your-key
```

Google, Anthropic, OpenAI, OpenRouter, and Z.AI Coding Plan are supported. The UI projects the
configured model catalog and stores a validated model choice per Companion. Restart the launcher
after changing configuration.

The local launcher applies the complete PostgreSQL schema before it starts any service. A hosted
release must use the same order: run `bun run migrate` as its release command, then start API,
executor, and worker with `COMPANIONS_SCHEMA_PREPARED=1`. Each service verifies the stored schema
fingerprint before becoming ready. A service launched on its own without that flag still performs
the idempotent, advisory-locked migration and skips DDL when the current fingerprint is present.

## Run the production container

The root image builds the Vite client and frozen Linux agent with Bun 1.4.2. It defaults to the
`api` role on `0.0.0.0:$PORT` and serves the client from the same origin. Run `migrate` once for a
release, then launch `api`, `executor`, and `worker` as separate services from the same image:

```sh
docker build -t companions.build .
docker run --rm --env-file .env.production companions.build migrate
docker run --env-file .env.production --env-file .env.api -p 3000:3000 companions.build api
docker run --env-file .env.production --env-file .env.executor companions.build executor
docker run --env-file .env.production --env-file .env.worker companions.build worker
```

The ignored `.env.production` file holds shared configuration and must provide `DATABASE_URL`, the public HTTPS `APP_URL`, `BETTER_AUTH_SECRET`, and
a 64-character hexadecimal `COMPANIONS_ENCRYPTION_KEY`. Configure SMTP or Resend (`EMAIL_PROVIDER=resend`, `EMAIL_FROM`, `RESEND_API_KEY`) for magic-link login and S3
for chat files. Box, model-provider, OAuth, and Stripe credentials are required only for the product
surfaces enabled in that deployment; absence remains visible as unavailable and is not simulated.
See [production apps and triggers](docs/plugins-production.md) for Composio, the trigger webhook,
GitHub git access and acceptance checks.
Only the API role needs an exposed port; it also receives signed Composio trigger webhooks.
API, executor, and worker services do not need a Docker socket.
`LOCAL_RUNTIME=0` is the image default; a hosted executor uses Box rather than attempting to launch
local agent containers.

For an invitation-only beta, set `PRIVATE_BETA_EMAILS` to an exact comma-separated list of emails
on API, executor, and worker. Those users sign in with a verified magic link and can work without
Stripe activation. Other users cannot sign in or use existing sessions; runtime work rechecks the
owner's current verified email. Beta usage is recorded but excluded from Stripe delivery, including
after beta ends. An explicitly empty list closes access; removing the variable restores normal
subscription requirements. Redeploy all three roles when changing the list. Keep `BILLING_TEST_MODE`
disabled in production.

On Railway, connect the API, worker, and executor services to this GitHub repository's `main`
branch with the root `Dockerfile`. Each role keeps its own start command:
`/app/scripts/container-entrypoint.sh api`, `worker`, or `executor`. The API uses
`/app/scripts/container-entrypoint.sh migrate` as its pre-deploy command and `/health` as its
readiness check. Pushes to `main` deploy all three application services; PostgreSQL and MinIO
retain their independent images and persistent volumes. The executor automatically publishes
and verifies a base named snapshot from the bundled agent distribution, recreates it if missing,
and removes unreferenced older managed images after replacement. `BOX_TEMPLATE` is only needed
when opting out with `BOX_MANAGED_TEMPLATE=0`. See [the image lifecycle](docs/dev-workflow.md#backend-managed-base-named-snapshot).
No GitHub Actions workflow is required.
The routine publication-mode release requires a coordinated rollout instead of independent
automatic deployments: pause those deployments before merging, stop the old API, worker and
executor, then migrate and start all roles from the updated image, with the API last.
Follow the mandatory [routine publication rollout and rollback procedure](docs/dev-workflow.md#routine-publication-mode-rollout)
before enabling admissions again; an old executor does not enforce the new publication modes.
Set `APP_URL` and `BETTER_AUTH_URL` consistently to the public HTTPS domain on all three roles;
map the Railway custom domain to the actual service port, rather than assuming the Docker default.

Keep service-specific credentials in the corresponding ignored `.env.api`, `.env.executor`, and
`.env.worker` files. Put the selected model-provider key in `.env.api` only. In production, model requests use
`${APP_URL}/api/model-gateway` (or an explicit HTTPS `MODEL_GATEWAY_URL` ending in
`/api/model-gateway`). The executor gives each admitted run a signed, expiring credential; Box
receives no platform model key. The gateway checks the current run, owner and selected model before
forwarding each request. Provider-reported usage is recorded independently of the agent transcript.
Development without `MODEL_GATEWAY_URL` retains the direct-provider path for owned local canaries.

Run the isolated image acceptance (it creates and removes its own PostgreSQL container and network):

```sh
python3 scripts/bun.py scripts/test-production-container.ts
```

## Run on Box

Prepare the frozen runtime once, then create Box-backed Companions from it:

```sh
# Set BOX_API_KEY in .env first. Never commit credentials.
python3 scripts/bun.py scripts/prepare-box-template.ts companions-agent-v1-your-release
# Add BOX_TEMPLATE=companions-agent-v1-your-release to .env, then restart scripts/dev.py.
```

The executor creates or resumes the same Box and owns every Pi run. It
stages the selected model, plugins, files, trigger context, and control MCP, and persists intent
before each external effect. Opening the desktop wakes the Box when necessary. Human takeover is
shown as complete only after the runtime confirms desktop control; headless work and chat continue. The authorized API route
retrieves the provider desktop URL after readiness; it never dispatches a Pi run.

Choose a new immutable name for each release. Publication pins an archive, verifies every installed
distribution file, and repeats the comparison on an independent Box restored from the named
snapshot. A provider `ready` response alone never completes publication. Interrupted attempts retain
their creation identities and reconcile an accepted capture without resubmitting it.

The V12 live canary covers first turn, new file creation after archive/resume, key-free model access,
provider usage accounting, native control MCP skill installation and next-turn discovery. Browser
acceptance opens the real desktop and uses mouse/keyboard under confirmed human control. The
single cold-preparation sample was 10.5 seconds; wake preparation took 16.4 seconds. The initial
viewer provision exceeded the 60-second canary deadline and later recovered without manual repair.
These measurements do not establish the desired few-second startup guarantee. See
[the V12 measurement](docs/measurements/box-gateway-v12-2026-09-07.json) and
[the completion audit](docs/completion-audit.md).

## Product surfaces

- Better Auth email magic links with PostgreSQL sessions and owner-scoped data.
- Durable main chat with native Pi steering, cancellation, questions, Markdown, and private files.
- Background routines, signed webhooks, code filters, provider reads, grouping, shared durable
  memory, explicit publish-to-chat, and task history.
- OAuth and custom MCP connections selected independently for each Companion.
- The `companion-control` MCP for identity, models, routines, triggers, tasks, delegation,
  templates, lifecycle operations, plugins, and delivery preparation.
- Permanent Companions, temporary specialist replicas, immutable template revisions and rollback,
  Box snapshot adoption, and retained results.
- Stripe Checkout/portal/webhooks, a deduplicated usage ledger, and independent client delivery
  with an explicit, revocable, audited maintenance surface.
- Portable local-skill export, validation, private object-storage transfer, and import are wired
  into delivery and template preparation, with deterministic coverage and a real-Box canary.

## Verify

```sh
# Fresh PostgreSQL and MinIO, server behavior, compiled Pi/Linux product path, web tests and build
python3 scripts/verify.py

# Wider packaging matrix: tools, MCP transports, skills, images, steering, sessions, and faults
python3 experiments/pi-bun/verify.py
python3 experiments/pi-bun/verify.py --scenario 'crash after'

# Credentialed canaries; these may create billable provider resources
AGENT_TEST_MODE=0 python3 scripts/bun.py scripts/live-model-canary.ts
python3 scripts/bun.py scripts/live-box-canary.ts
python3 scripts/bun.py scripts/live-box-canary.ts --wake-only
python3 scripts/bun.py scripts/live-desktop-canary.ts
```

To check chat concurrency on an existing owned Box, run the manual routine canary with an
explicit private journal (one process per journal):

```sh
CANARY_STATE_FILE=.local/box-canary.json \
ROUTINE_CHAT_CANARY_STATE_FILE=.local/routine-chat-canary.json \
python3 scripts/bun.py scripts/live-routine-chat-canary.ts
```

It uses the authenticated local API session and configured Box credential. It creates a disabled
routine, invokes only its `/test` endpoint, verifies that `CHAT_OK` settles while a foreground
30-second background command is still running, checks the final file/result, and removes its
unchanged disabled routine. This is a paid live model test of manual routine/chat concurrency;
it does not test clock scheduling. Restart with the same journal to reconcile the same request
IDs. An unresolved create response is never resubmitted; an unresolved test response retains the
disabled definition until a rerun resolves it. The journal records timings and proofs without
credentials or provider payloads; existing workspace probe files are retained.

To exercise the server's actual routine clock, use a separate journal:

```sh
CANARY_STATE_FILE=.local/box-canary.json \
ROUTINE_CLOCK_CANARY_STATE_FILE=.local/routine-clock-canary.json \
python3 scripts/bun.py scripts/live-routine-clock-canary.ts
```

This API-only paid model canary creates an enabled UTC schedule at least 90 seconds ahead.
Minute, hour, day and month are fixed, limiting an abandoned definition to at most annual
recurrence. It never calls `/test` or changes the scheduler clock. The journal pins the target and
creation intent; lost responses reconcile by exact fixture identity without another create.
Once API history shows the single expected occurrence, the script disables the unchanged
fixture immediately, verifies its result, and deletes it. Rerun the same journal after interruption
to reconcile or clean up; use one process per journal. User-edited definitions are left untouched.

Read [the testing guide](docs/testing.md) before interpreting a passing suite. Deterministic tests
prove product behavior at controlled boundaries; they do not prove model quality, live OAuth,
Stripe pricing, provider reliability, or hosted latency.

## Documentation

- [Current implementation, architecture, and gaps](docs/v0.md)
- [Approved product decisions](docs/companions-build.md)
- [Web/API contract](docs/UI_CONTRACT.md)
- [Testing and evidence](docs/testing.md)
- [Billing and client delivery](docs/billing-delivery.md)
- [Lifecycle, templates, and replicas](docs/lifecycle.md)
- [Triggers](docs/triggers.md)
- [Files](docs/files.md)
- [Pi/Bun feasibility](docs/research/pi-bun-feasibility-2026-09-06.md)

The project is MIT licensed. Never commit `.env`, provider keys, authentication links, local state,
or verification artifacts.
