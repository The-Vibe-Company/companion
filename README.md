# Companion

> Launch secure fleets of task-optimized AI agents with tools, memory, and private access.

[![CI](https://github.com/The-Vibe-Company/companion/actions/workflows/ci.yml/badge.svg)](https://github.com/The-Vibe-Company/companion/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/The-Vibe-Company/companion)](https://github.com/The-Vibe-Company/companion/releases)
[![License](https://img.shields.io/github/license/The-Vibe-Company/companion)](LICENSE)

![Companion product overview](docs/assets/companion-product.png)

Companion helps you go from "I need several specialized agents" to a running fleet you can actually use: each agent gets its own role, tools, memory, runtime, and private access.

- Run a personal fleet for research, writing, coding, ops, and analysis.
- Deploy a client-ready fleet with isolated environments and controlled access.
- Give agents durable Granite memory, then share selected memory between agents.
- Expose dashboards, APIs, and Open WebUI through Tailscale instead of the public internet.

The goal is simple: tomorrow, launching a fleet of useful agents should feel like copying a workspace, editing a few names and secrets, previewing the plan, then deploying.

## What You Can Launch

| Output | What it means in practice |
| --- | --- |
| Personal agent fleet | A set of named agents for your own workflows: research, content, coding, data, operations |
| Client fleet | A repeatable workspace you can adapt and deploy for a client without rebuilding the ops stack |
| Specialized agents | Each agent can have its own identity, model, dashboard, API server, tools, and vaults |
| Shared memory layer | Granite vaults give agents durable memory and can be shared between selected agents |
| Private access | Agents run in isolated environments and are reachable through Tailscale VPN |
| Shared chat surface | Open WebUI can connect to the enabled Hermes API servers in the fleet |
| Operational view | Outputs, drift reports, graph data, and a local dashboard show what is running |

## Example Fleets

| Fleet | Agents you might run |
| --- | --- |
| Solo operator | Research agent, writing agent, coding agent, ops agent, analyst agent |
| Client deployment | Support agent, knowledge-base agent, reporting agent, workflow automation agent |
| Internal team | Engineering agent, sales enablement agent, finance analyst, customer insight agent |

Each fleet is meant to be reproducible: keep the workspace, change the names, providers, secrets, identities, and vault links, then deploy another fleet with the same operating model.

## Quickstart

Install the CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Vibe-Company/companion/main/install.sh | sh
```

The installer writes `companion` to `~/.local/bin` by default. Make sure that directory is on your `PATH`.

Create a demo workspace:

```bash
companion init --workspace ./companion-demo
```

Check the files Companion generated:

```bash
companion validate --workspace ./companion-demo
```

Preview the fleet plan:

```bash
companion plan --workspace ./companion-demo
```

That is the loop: edit TOML, validate, plan, apply when the plan is right.

## Deploy For Real

You can validate the workspace shape before deploying, but live provider-backed operations need credentials for the providers you configure.

Create `.env` next to `companion.toml`:

```env
FLY_API_TOKEN=
TS_AUTHKEY=
TAILSCALE_API_KEY=
OPENROUTER_API_KEY=
API_SERVER_KEY=
WEBUI_SECRET_KEY=
```

Then apply the plan:

```bash
cd companion-demo
$EDITOR .env
companion apply --workspace .
```

Secrets are read from `.env` and then from your shell environment. Shell values win. Companion prints secret names only, never secret values.

Provider-backed commands may read live Fly, Tailscale, or OpenRouter state. `apply` mutates live resources. Keep one workspace, one `.env`, and one `.companion/state.sqlite` as the operating home for a fleet unless you are deliberately migrating.

## What Companion Manages

| Need | Companion gives you |
| --- | --- |
| Persistent agents | One Fly app, volume, secrets bundle, config render, and rollout per agent |
| Task specialization | Agent-level identity, model, runtime, dashboard, API server, and vault settings |
| Private networking | Tailscale hostnames and device drift checks |
| Model routing | OpenRouter provider refs and optional model catalog validation |
| Memory | Default Granite vaults and cross-agent vault connections |
| Tools | Workspace-defined runtime wiring for Hermes, Granite MCP, Open WebUI, and provider integrations |
| Chat | Shared Open WebUI backed by enabled Hermes API servers |
| Client deployments | Copyable workspaces that can be adapted per client, team, or fleet |
| Local visibility | Outputs, drift reports, graph data, and a small dashboard |
| Safer ops | Deterministic resource addresses, generated artifacts, SQLite evidence, explicit destroy |

## How It Works

Companion treats a folder as the source of truth:

```text
companion.toml
providers.toml
defaults.toml
webui.toml
dashboard.toml
agents/
  example-agent.toml
vaults/
  shared.toml
identities/
  example-agent/SOUL.md
.env
.companion/
  state.sqlite
  generated/
```

The TOML files describe desired state: providers, defaults, agents, identities, tools, Granite vaults, secure networking, and Open WebUI. Companion compiles that state into typed resources, compares it with observed provider state, writes generated Fly TOML under `.companion/generated/`, applies changes idempotently, and records evidence in `.companion/state.sqlite`.

![Companion technical architecture](docs/assets/companion-architecture.png)

## Workspace Files

The repository root is not a live workspace. Keep real fleet configuration, provider orgs/tailnets, app names, identities, vault links, and `.env` files under `.local/` or outside the repository. Public examples should stay anonymized.

Validate from a workspace:

```bash
companion validate --workspace .
```

`companion.toml` is the index:

```toml
workspace = "example-companion"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
```

`providers.toml` names the provider accounts and the environment variables that hold credentials:

```toml
[fly.default]
org = "example-org"
region = "cdg"
token_env = "FLY_API_TOKEN"

[tailscale.default]
tailnet = "example.ts.net"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
```

One agent is one small file:

```toml
[agent]
id = "example-agent"
runtime = "fly.default"
network = "tailscale.default"
model_provider = "openrouter.default"
lifecycle = "present"
protect = true
fly_app = "example-companion-agent"
tailscale_hostname = "example-agent"
identity = "identities/example-agent/SOUL.md"

[default_vault]
enabled = true
name = "Example Agent"
mcp_role = "write"
```

Use `lifecycle = "absent"` to request deletion. Removing TOML alone does not silently destroy protected remote data.

Ready-to-copy examples live in `examples/minimal` and `examples/webui`.

## Common Workflows

| Workflow | Command |
| --- | --- |
| Validate local workspace files | `companion validate --workspace .` |
| Validate provider access and OpenRouter models | `companion validate --providers --workspace .` |
| Preview every resource | `companion plan --workspace .` |
| Preview one agent or resource | `companion plan example-agent --workspace .` |
| Apply the current plan | `companion apply --workspace .` |
| Apply one agent | `companion apply example-agent --workspace .` |
| Print fleet outputs | `companion output --workspace .` |
| Read one output | `companion output open_webui_url --raw --workspace .` |
| Run the status dashboard | `companion dashboard --addr 127.0.0.1:8787 --workspace .` |

Plan output is resource-oriented:

```text
+ create fly_app.agent.example-agent example-companion-agent
= no-op fly_volume.agent_data.example-agent vol_xxx
~ update fly_secrets.agent.example-agent API_SERVER_KEY,OPENROUTER_API_KEY
! drift tailscale_device.agent.example-agent missing example-agent
- delete fly_app.agent.old example-companion-old
```

Dashboard routes:

| Route | Purpose |
| --- | --- |
| `/` | Live fleet status page (auto-refreshing) |
| `/api/status` | Status snapshot JSON |
| `/healthz` | Liveness probe |
| `/agents` | Agent table |
| `/agents/<id>` | Agent detail |
| `/graph` | Vault connection graph |
| `/graph?format=json` | Graph JSON |
| `/drift` | Drift report |

## Deploy Safely

Stable resource addresses make plans readable and repeatable:

```text
fly_app.agent.<id>
fly_volume.agent_data.<id>
fly_secrets.agent.<id>
fly_config.agent.<id>
rollout.agent.<id>
tailscale_device.agent.<id>
granite_vault.default.<id>
openwebui_config.main
fly_app.openwebui.main
fly_volume.openwebui_data.main
fly_secrets.openwebui.main
rollout.openwebui.main
dashboard_config.main
fly_app.dashboard.main
fly_secrets.dashboard.main
rollout.dashboard.main
```

State is evidence, not desired config:

```bash
companion state list --workspace .
companion state show fly_app.agent.example-agent --workspace .
companion state rm fly_app.agent.example-agent --workspace .
```

Import existing resources before managing them:

```bash
companion import fly_app.agent.example-agent example-companion-agent --workspace .
companion import fly_volume.agent_data.example-agent vol_xxx --attrs app=example-companion-agent --workspace .
```

Destroy is explicit:

```bash
companion destroy fly_app.agent.example-agent --confirm example-agent --workspace .
```

Persistent data requires backup intent:

```bash
companion destroy fly_volume.agent_data.example-agent --confirm example-agent --destroy-data --backup-first --workspace .
```

Missing desired resources become orphans until you import, remove state, set `lifecycle = "absent"`, or run an explicit destroy.

## Granite, Identity, And WebUI

Hermes uses `SOUL.md` as the identity layer. Companion keeps the source file in the workspace and installs it during rollout.

```bash
companion identity init example-agent --name "Example Agent" --workspace .
companion identity render example-agent --workspace .
```

Use `companion_soul` for fleet-wide identity rules that must be appended to every agent `SOUL.md`, for example a shared Granite memory policy:

```toml
[defaults.companion_soul]
path = "identities/companion-soul.md"
```

Agents can opt out without changing their own identity file:

```toml
[companion_soul]
enabled = false
```

Every agent can have a default Granite vault:

```toml
[default_vault]
enabled = true
name = "Example Agent"
mcp_enabled = true
mcp_role = "write"
sync_serve = true
write_serve = true
```

Agents can also connect to other Granite vaults with `vault_connections`. Use `mode = "write"` for HTTP MCP write access and `mode = "sync"` for Granite sync remotes.

```toml
[[vault_connections]]
name = "shared-vault"
mode = "sync"
role = "write"
host = "shared-vault"
token_secret_name = "GRANITE_SHARED_VAULT_WRITE_TOKEN"
mcp_name = "granite_shared_vault"
```

Deploy the shared Open WebUI through the same resource engine:

```bash
companion apply openwebui --workspace .
```

If an agent does not set `api_server.open_webui_url` or `api_server.open_webui_host`, Companion resolves the current Tailscale DNS name and injects it into `OPENAI_API_BASE_URLS`.

## Status Dashboard

`companion dashboard` serves a live status view of the whole fleet — one page that shows every agent and the Open WebUI, with health, Tailscale presence, Fly machine state, model, and a drift summary. The UI is embedded in the binary (`go:embed`), so there is no separate build step. Run it locally against a workspace:

```bash
companion dashboard --addr 127.0.0.1:8787 --workspace .
```

`serve` is kept as an alias. The page polls `/api/status` (JSON) on an interval; `/healthz` is a liveness probe.

You can also deploy it on its own dedicated instance, reachable only over Tailscale, by enabling `[dashboard]` in the workspace:

```toml
[dashboard]
enabled = true
fly_app = "example-companion-dashboard"
tailscale_hostname = "companion-dashboard"
port = 9300
refresh_interval = 30
memory = "256mb"   # smallest Fly machine; the dashboard is stateless
cpus = 1
tailscale_serve = true
```

`companion apply` then deploys the dashboard as a tiny, stateless Fly app (smallest machine, no volume, no public Fly HTTP service) that holds read-only Fly/Tailscale tokens as Fly secrets and polls the fleet on a timer. The set of services and URLs it polls is a non-secret topology manifest (`.companion/generated/fleet.json`) that apply keeps in sync: `dashboard_config.main` carries the topology fingerprint, so adding or changing an agent and re-applying redeploys the dashboard with the refreshed targets — no manual rebuild. This mirrors how `openwebui_config.main` keeps Open WebUI's backend URLs current.

The deployed image is built from `Dockerfile.dashboard` (the `companion` binary + Tailscale + `fleet.json`). To run it on your own server instead, `git clone` the repo and `go build ./cmd/companion`, then run `companion dashboard --manifest <fleet.json>` with `FLY_API_TOKEN`/`TAILSCALE_API_KEY` in the environment.

## Control Plane

The control plane is the mutable, Tailscale-only Companion admin app. It runs `companion console` on Fly, mounts a persistent `/workspace` volume, and uses the same workspace/state engine as the local CLI. Bootstrap a new control-plane workspace locally:

```bash
companion init --control-plane --workspace ./my-fleet \
  --control-plane-app my-companion-control \
  --control-plane-hostname companion-control \
  --tailnet example.ts.net
```

The generated TOML stores only secret names such as `FLY_API_TOKEN`, `TAILSCALE_API_KEY`, `TS_AUTHKEY`, and `OPENROUTER_API_KEY`; set the corresponding values in your shell or `.env` before deploying. Use `--no-deploy` to write and register the workspace without creating Fly resources.

The local CLI tracks multiple workspaces in `~/.companion/workspaces.json`:

```bash
companion workspace list
companion workspace use my-fleet
companion control-plane status
companion control-plane upgrade
companion control-plane export --output ./control-plane-workspace.tgz
```

`control-plane upgrade` redeploys the same Fly app from the current checkout while preserving the Fly volume, secrets, and SQLite state.

## Development

```bash
go test ./...
sh -n install.sh
bash -n install.sh bin/start-on-fly bin/run-hermes-process bin/start-open-webui-on-fly bin/start-dashboard-on-fly bin/start-control-plane-on-fly bin/build-console-ui
go run ./cmd/companion validate --workspace examples/minimal
go run ./cmd/companion plan --workspace examples/minimal
```

Provider e2e tests use local `httptest.Server` mocks for Fly, Tailscale, and OpenRouter, plus a fake rollout runner. Do not hit live provider resources from tests unless a future live suite is explicitly gated.

Developer install from source:

```bash
go install github.com/The-Vibe-Company/companion/cmd/companion@main
```

Release Please manages version PRs, changelog updates, tags, and GitHub Releases. Release assets contain a single `companion` binary for Linux and macOS.

## License

Companion is released under the [MIT License](LICENSE).

## Legacy Note

The previous Companion web UI codebase is archived at `archived/legacy-companion/`. Companion is now the Go control plane described above.
