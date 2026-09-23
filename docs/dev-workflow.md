# Worktree development

Use `./dev --help` from the checkout. This entrypoint resolves its own directory and works
from a subdirectory as well. Python 3.11+, Docker and Git are required. The optional proxy
setup also uses npm; its pinned Node 24 runtime stays inside `tools/dev/node_modules` and
does not replace the machine's Node or the product's pinned Bun.

## Shared agent skills

The repository includes `ship-pr-dev` 1.6.0 for PR delivery, `review-code-dev` 2.1.0
for independent Alibaba OCR delegation review, `capture-learning-tools` for the final
report-only learning pass, and `design-frontend-dev` for optional frontend guidance.
Ship PR depends on Review Code v2 and Capture Learning; Review Code v2 has no skill
dependencies. Frontend coverage belongs inside the same review, not a second gate.
The complete `plan-pr` workflow and its nine-package dependency closure are bundled;
see [the shared workflow guide](../.agents/skills/plan-pr-bundle.md).
Use `plan-pr` for an approved implementation plan, followed by Ship PR for delivery.

The versioned packages in `.agents/skills/` are the shared source for this project.
Codex uses that directory; Claude Code uses the relative links in `.claude/skills/`.
Prefer these packages over global copies. No global skill installation or Companion
account is required. Manifests retain upstream versions and dependency metadata.

Ask the agent to use `ship-pr-dev` to create or update a PR, or `review-code-dev` for
a read-only review. Git, Python 3.11+ (`python3`), and authenticated GitHub CLI (`gh`)
are needed for the full delivery workflow, along with the normal verification prerequisites
below. Agents with no native skill discovery can read the matching `SKILL.md` directly.
Use repository instructions for model preferences and verification commands.

Review Code v2 uses checksum-pinned OCR 1.12.1 for file selection and rule resolution;
the host agent performs the review. The coordinator runs
`python3 .agents/skills/review-code-dev/scripts/ocr.py version` before review.
The first invocation needs network access, Git 2.41+, and macOS Intel/Apple Silicon
or Linux x86_64/ARM64. The wrapper needs Python 3.9+; this repository uses 3.11+.
It caches the verified binary under `~/.local/share/review-code-dev/ocr`, overridable
with `REVIEW_CODE_OCR_HOME`, and sets `OCR_NO_UPDATE=1`. No Node, sudo, PATH edits,
additional LLM endpoint or API key are required. No global npm/Brew installation is
needed. Do not bootstrap during package-only validation or when global writes are
forbidden; use an explicitly authorized cache location for a later live smoke test.
Setup failure blocks review, with no v1 fallback. A passing review requires complete
branch plus intended pending-workspace coverage, including OCR exclusions, and
source freshness after hooks. Critical/high block delivery; remaining medium
findings require explicit human acceptance.

The repository retains `prepare_review_run.py`, `collect_review_context.py` and
`test_collect_review_context.py` as documented compatibility helpers for ignored
worktree artifacts, redacted diagnostics and merge-base behavior. The collector is
not an OCR replacement or authoritative coverage inventory. Obsolete v1 routing,
specialist references, parser and PR-watch files were removed. OCR rule/background
output still needs secret-safe handling before persistence; the wrapper does not
redact it. The complete Apache-2.0 license and attribution ship with Review Code.
The supplied Ship PR source contains no separate license file.

Validate package updates offline with `python3 -B scripts/shared_skills_test.py`.
This runs bundled OCR trust-boundary tests, retained redaction/merge-base tests,
package/dependency checks and artifact preparation tests in disposable Git checkouts
and linked worktrees; it does not install OCR or perform an independent review.

Ship PR verifies, reviews, commits, pushes and waits for CI; merging stays with a human.
Reports under `plans/ship-pr-dev/` and `plans/review-code-dev/` are ignored by Git.
When updating a package, include its references, scripts, evals, manifests and licenses,
exclude caches and private data, and preserve the Python 3 and worktree compatibility
adaptations, diff redaction and merge-base review scope fixes. The Claude links continue
to point to the same shared packages.

## First use

```sh
./dev setup --portless
./dev herdr-install  # once per machine, inside Herdr
./dev workspace
```

The Herdr installer backs up existing configuration, validates the candidate and preserves
unrelated bindings. With the default prefix, press **Ctrl+B, then D** to create or reuse the
control panel beside the agent in the same tab. It supports mouse clicks, Tab/arrows and Enter.
It keeps the user's focus in their current pane. `./dev menu` opens the same panel in the
current terminal. The commands remain usable outside Herdr.

The panel offers Start all, Restart all, Stop all, per-service controls, links, logs,
focused validation, scenarios and browser acceptance. Opening the panel alone does not start
containers. A command runs in the background while the panel continues displaying observed
states. Use `o` for its retained output. The sidebar receives expiring app/test metadata.

## Local stack

```sh
./dev up
./dev status --json
./dev service restart api
./dev service stop worker
./dev service start worker
./dev logs executor
./dev restart
./dev down
```

`up` returns only after API, web, executor and worker startup checks succeed. Repeating it
reuses a ready stack or starts manually stopped components. The supervisor serializes
component commands. Unknown outcomes require inspection, not an automatic retry.
Starting one application component from a stopped stack also prepares shared PostgreSQL,
storage and mail dependencies. Other application processes remain stopped. S3 and the storage
console belong to the same MinIO container; their restart/stop buttons control that container.

Inside a Herdr pane, `up` also asks the Herdr port-forward plugin (`herdr-portfwd`, when it is
installed) to expose the human-facing URLs — dev web, Mailpit and the storage console — but only
when the plugin reports that it runs on the remote side of a Herdr connection. A mirror or local
placement needs nothing because those ports are already on the machine running the browser. The
step is best-effort: it never fails `up`, it skips ports already queued, and it depends on the
plugin's two-machine setup (`herdr-portfwd attach <host>`, with `hosts.toml` on both sides).
Background services are launched with their standard input detached, so `up` never competes with
the developer's terminal for keystrokes.

The CLI starts deterministic local services without inheriting hosted credentials, database
URLs or `.env` values. Billing test access is development-only. The original
`python3 scripts/dev.py` entrypoint remains available for explicitly configured live canaries;
its configuration is separate from the controlled CLI path.

Preparation caches dependencies by lockfile contents and the agent distribution by source
contents. Source changes restart backend processes after stopping admission, applying the
schema and rebuilding the runtime if needed. Existing agent disks and durable request IDs
remain intact; the executor owns recovery. A reload failure remains visible and the watcher
waits for another edit. Manually stopped components remain stopped across source reloads.
Frontend changes use Vite HMR. Changes to launcher scripts require `./dev restart`.

Ports, data, service containers and Linux agent containers belong to the checkout. `down`
stops only owned resources and verifies the container shutdown, retaining disks. It can also
recover owned service processes after a supervisor crash by checking PID start time and
command identity. Stop the test stack after validation, including after failures.

## Portless

`./dev setup --portless` enables pinned Portless. Local HTTP uses one shared loopback proxy
on port 1355, without administrator prompts or changes to `/etc/hosts`. Each worktree has a
distinct hostname. The proxy has separate state under `~/.local/state/companions-portless`.
API, Mailpit, the S3 endpoint and the storage console each get their own named route under the
worktree hostname. Shutdown verifies removal of only that worktree's aliases. If the supervisor
was killed, `./dev down` reconciles its recorded routes; ambiguous ownership remains an explicit
cleanup failure rather than taking another route over.
`./dev up --direct` provides a direct-port fallback.

HTTPS on port 443 is optional: `./dev setup --portless --https` performs Portless's local CA
and privileged-port setup interactively. This can require administrator authentication; run
it once before autonomous starts. All clients need to trust that CA. Configure the shared
proxy consistently across worktrees. Ordinary worktree shutdown preserves the shared proxy.

Read the actual endpoints from `.local/dev-endpoints.json` or `./dev status --json` rather
than reconstructing ports or hostnames. PostgreSQL is a TCP service, not a browser UI; its
credential-free connection address is displayed separately. Workers expose logs, not web links.

## Validation and evidence

```sh
./dev check web
./dev check server --test retirement
./dev check agent
./dev check full
./dev scenario chat-ready
./dev scenario cancel-recovery
./dev browser-test chat-recovery
```

Focused checks prepare their own isolated dependencies. Scenarios and browser acceptance
require a running `./dev up` stack and refuse live-model configurations. Authentication uses
real Better Auth magic links delivered to the local Mailpit. The browser command requires
`agent-browser`, uses its own session, and verifies a message submitted through the UI against
persisted API state after reload. It saves screenshots and accessibility snapshots, and closes
its browser session even on failure. Browser network traces are deliberately excluded because
they contain authentication cookies.

Reports live under `.artifacts/verification`, `.artifacts/dev-scenarios` and
`.artifacts/browser-tests`. Verification records source identity, the reproduction command,
step results, timeout information and cleanup. The panel marks old evidence stale when code
changes. A focused passing result names its profile; it does not replace full validation.
GitHub's Verify workflow runs the full PostgreSQL 18 path and uploads only summary JSON,
excluding local authentication state, database backups and raw logs. Configure Verify as a
required repository check if merges must be blocked on it.

### Conversation message migration

`conversation.sql` replaces the one-message-per-role constraint with a sequence per run and
role, retaining all existing rows at sequence zero. Build the agent distribution first. Stop
the previous executor before applying this migration, then start the updated server/executor:
the old executor's final-message conflict target is incompatible with the new index. Updated
servers accept older agent journals through the legacy final-answer path; existing Boxes need
the updated distribution to capture future intermediate messages.

For rollback, retain the new schema and the compatible executor settlement code. Restoring
the old unique constraint after multi-message runs exist requires a separately reviewed data
migration; do not delete conversation rows to make an old binary start. This change cannot
recover intermediate messages that older runtimes never saved.

### Discussions rollout

Follow [the discussions migration procedure](discussions-migration.md). Stop old API,
worker and executor roles before applying the destructive schema update. Preserve permanent
Companion machines, request journals and Pi transcripts. Reconcile old provider resources
before purging specialist, routine and trigger records. The current product and HTTP contract
are described in [the discussion specification](specs/discussions.md).

### Real model or scripted responses

`./dev restart --live` uses the selected runtime settings described below.
Database and storage remain local; agent computers use Box when its key and template are configured.
The worktree remembers this choice without writing credentials to its options file.
`./dev restart --scripted` restores deterministic test responses. The default for a new
worktree is scripted mode unless the shared `.env` sets `DEV_LIVE_MODEL=1`; `Scripted response.` indicates that mode, not an AI answer.
Existing messages are retained when switching modes. Send a new message to use the real model.

### Shared runtime settings from the main checkout

In live mode, the launcher reads runtime settings from the main checkout’s `.env`
(found through Git’s common directory), then this worktree’s `.env`, then the shell.
It reads them again on each startup; secrets are not copied into worktree options.
Only `MODEL_PROVIDER`, `MODEL_ID`, the selected provider’s API key and endpoint,
`DEV_LIVE_MODEL`, `LOCAL_RUNTIME`, `BOX_API_KEY` and `BOX_TEMPLATE` are inherited. Database, storage, authentication, email and ports
remain local. Scripted mode does not inherit these external credentials.

Use `./dev restart --live --direct` to apply changes. With both Box settings present,
new companions use Box; existing Docker companions retain their provider.
For ZAI Coding Plan, use `MODEL_PROVIDER=zai` and `MODEL_ID=glm-5.3-flash` in the
main `.env`. Pi’s `zai` provider uses `https://api.z.ai/api/coding/paas/v4`.

For Azure Foundry, configure the main checkout’s ignored `.env`:

```dotenv
MODEL_PROVIDER=azure
MODEL_ID=gpt-5.6-luna
AZURE_OPENAI_BASE_URL=https://YOUR-RESOURCE.services.ai.azure.com/api/projects/YOUR-PROJECT/openai/v1
AZURE_OPENAI_API_KEY=<your-key>
DEV_LIVE_MODEL=1
```

`MODEL_ID` is the Azure deployment name. The base URL also accepts a full
`/responses` endpoint. Azure uses the Responses protocol through the same run-scoped
gateway, preserving native streaming, function tools, images, reasoning and token usage.
In production, set the key and endpoint on the API; API, executor and worker use the
same provider and model defaults. The production key remains on the API.
To override reasoning for a specific Azure deployment in hosted sessions, set
`AZURE_OPENAI_REASONING_MODEL=gpt-5.6-luna` and `AZURE_OPENAI_REASONING_EFFORT=xhigh`
on the API. Both values are required. The gateway applies the effort to new provider
requests for that model, including continued conversations; requests already forwarded
keep their original effort. Other providers and model IDs retain their session settings.
Unset both variables to restore session-controlled reasoning. A live Azure probe on
2026-09-10 accepted `xhigh` for Luna and rejected the literal `max` value.

Existing hosted agents use the OpenAI Responses wire format; the gateway selects Azure
from the persisted run provider. Direct development agents use the Azure adapter,
which removes the legacy `api-version` query rejected by Foundry v1 endpoints.
Direct agents using a project endpoint need a freshly built distribution (or an
updated Box template). For existing direct agents, the resource inference endpoint
`https://YOUR-RESOURCE.services.ai.azure.com/openai/v1` also accepts the legacy SDK
query and message format. It uses the same Azure resource and deployment; this
allows local adoption without replacing existing Box images.
The [Microsoft Responses reference](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/responses)
describes this API.

`DEV_LIVE_MODEL=1` makes local startup use the shared model unless the worktree has
an explicit mode saved. `./dev restart --live` overrides a previous scripted choice;
`./dev restart --scripted` remains deterministic. A worktree `.env` model override
still takes precedence over the main checkout and must be removed to follow it.

### Great and Fast in hosted Companion settings

With Azure `gpt-5.6-luna` configured, the model picker calls it **Great** and marks it
as the default. Null model preferences continue to use Great. Set `DEEPSEEK_ENABLED=1`
on API, executor and worker to also offer **Fast** (`deepseek-flash`), and configure
`DEEPSEEK_API_KEY` on the API only. Fast requires the hosted model gateway.
The existing `AZURE_OPENAI_REASONING_*` override applies only to Great.

The companion preference stores the actual model ID. Before dispatch, the executor
persists the actual provider and model on the run; joined steering retains its response
root's selection. Changing settings affects the next response root. The gateway sends
Fast requests to `https://api.deepseek.com/responses` with the API-only credential,
retaining usage attribution and non-replayable request IDs.

Existing compiled agents use distinct built-in OpenAI Responses transport profiles:
`gpt-5.6-luna` for Great and `gpt-5.6-sol` for Fast. The gateway validates that profile against the pinned run, then
substitutes the actual model ID. Pi transcript model metadata therefore names the
transport profile; persisted run and gateway records identify the actual model.
No agent update or machine replacement is required. Distinct profiles let Pi
normalize cross-model history and remove incompatible reasoning signatures while
retaining messages and tool results.
DeepSeek developer messages become system messages because its Responses API treats
`developer` as a user role.

Deploy the API first with Fast disabled: its Railway pre-deploy command applies the
additive provider constraint migration and preserves every existing gateway request
tombstone. Then deploy executor and worker from the same release; they require the
current schema fingerprint at startup. Enable Fast on the API only after all three
services are healthy.
For rollback, disable Fast selection first, finish accepted Fast runs, then remove the
key or revert the application. Keep the expanded provider constraint and histories.

Verified API references on 2026-09-10: [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)
and [model details](https://api-docs.deepseek.com/quick_start/pricing/).

### Herdr worktree `.env` copy

The repository’s shared Git `post-checkout` hook is installed locally from
`scripts/herdr-copy-env.py`. When `HERDR_ENV=1`, it copies the primary checkout’s
`.env` into a newly created worktree if none exists. The copy has mode `0600` and
must be ignored by Git. Existing worktree settings are never overwritten.
The hook is shared by this repository’s worktrees and requires no Herdr restart.
Use `./dev up --live` in a new worktree to activate the external runtime settings
while keeping development infrastructure isolated. Local `.env` copies take
precedence over later changes to the main file.

### Backend-managed base named snapshot

Hosted executors publish the already-built `dist/agent` distribution as a named
snapshot. A changed distribution produces a new image; a missing image triggers
publication again. PostgreSQL records ownership, publication intent and verification
state. One publisher runs at a time, independently of companion execution. Agents
never install dependencies or build the distribution when waking. While a changed
distribution is being published or is quarantined, new companions use the latest
older verified managed image. New pins switch to the current image only after its
independent verification succeeds.

Publication creates a clean Box, installs the bundled archive, captures the image,
and verifies every distribution file on an independent Box. Both owned Boxes are
archived with their disks retained. Companions wait for a verified image before their
own preparation timeout starts. Unknown creation outcomes remain blocked for
reconciliation; they are never automatically replayed.

Only snapshots registered as managed base images are eligible for automatic cleanup.
After switching to a verified replacement, unreferenced older managed snapshots are
removed. A companion already pinned to the fallback keeps that immutable source once
its Box creation starts; pending creations protect their sources.
Unrelated snapshots are never removed to make room: a full account without an eligible
managed image leaves publication visibly pending or blocked until capacity is freed.
Existing Boxes keep their disks when their original base named snapshot is removed.

Hosted mode consumes managed images by default. Publication and cleanup additionally
require `BOX_MANAGED_TEMPLATE_PUBLISH=1` on the production executor. Railway API and
worker services use `BOX_MANAGED_TEMPLATE_PUBLISH=0`. This permission is not baked into
the container: running a production container locally does not grant it by default.
Both local development launchers force `BOX_MANAGED_TEMPLATE=0` and
`BOX_MANAGED_TEMPLATE_PUBLISH=0`, including live mode and inherited shell or `.env`
settings. They consume an existing `BOX_TEMPLATE` and never publish or delete managed
snapshots, even when sharing the production Box account. `BOX_MANAGED_TEMPLATE=0`
also retains the explicit operator-managed `BOX_TEMPLATE` path in hosted mode.
The production container builds its distribution
before deployment; backend publication does not compile source at runtime.

### Box by default; opt-in local testing

New companions use Box by default. Existing local companions remain readable and runnable.
The local runtime picker is available only when local testing is explicitly enabled.

For fast Docker-backed local testing, set `LOCAL_RUNTIME=1` in the worktree `.env`
or shell and restart with `./dev restart`. Remove it or set `LOCAL_RUNTIME=0` to
return to Box. This setting is independent of model selection: `--scripted` controls
the test model, while `--live` uses configured model credentials. Live Box development
requires `BOX_API_KEY` and an existing `BOX_TEMPLATE`. Deterministic verification explicitly
enables the local runtime in its isolated test environment.

### Agent runtime updates

See [Background agent runtime updates](runtime-updates.md) for same-Box update eligibility,
data preservation, recovery, and the coordinated first rollout. Railway deployment and Box
runtime version are distinct; the executor reconciles compatible runtime releases when safe.

### Discussion history and validation

`GET /api/discussions/:id` returns the latest 50 messages in ascending sequence order,
current tasks, questions, central runs and participants. `before` is an exclusive decimal
sequence cursor. The web retains loaded earlier pages while polling persisted current state;
folder membership never imports another discussion's history. Recipient and retry identity
are scoped to the account and discussion. Files from another discussion require an exact
user-provided file ID or download link and the same account owner.

The companion daemon advertises `conversationVersion: 1`. Every discussion has an independent
Pi directory while the companion machine, workspace, apps and durable memory stay shared.
A bounded arrival briefing fits alongside the full Companion configuration; the agent can
retrieve older messages through `discussion_history`. Stop chat and Stop companion target
separate persisted requests. Archiving a discussion does not cancel either.

Use `./dev check server --test discussion` for coordinator, gateway, attachment, cursor and
complete previous-schema migration coverage; `./dev check server --test permanent-companions`
for admission, retirement and cross-discussion control boundaries. `./dev check web` covers
rendering, recipient/retry state, pagination, account flows and desktop controls. Full verification
also exercises compiled Linux Pi histories, shared files and cancellation.
