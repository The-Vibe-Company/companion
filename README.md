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
| Run the local dashboard | `companion serve --addr 127.0.0.1:8787 --workspace .` |

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
| `/` | Fleet overview |
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

## Development

```bash
go test ./...
sh -n install.sh
bash -n install.sh bin/start-on-fly bin/run-hermes-process bin/start-open-webui-on-fly
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
