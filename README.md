# Companion

Companion is a Go control plane for a fleet of persistent Hermes agents.

It works from a folder workspace: short TOML files describe providers, defaults, agents, identities, Granite vault links, and the shared Open WebUI. Companion compiles that desired state into typed resources, compares it with observed Fly/Tailscale state, writes local Fly TOML artifacts, applies changes idempotently, and records evidence in SQLite.

## Install

Install the CLI from the latest GitHub Release:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Vibe-Company/companion/main/install.sh | sh
```

The installer downloads the right binary for macOS or Linux and installs it to `~/.local/bin/companion` by default.

Install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Vibe-Company/companion/main/install.sh | COMPANION_VERSION=v0.1.0 sh
```

Developer install from source:

```bash
go install github.com/The-Vibe-Company/companion/cmd/companion@main
```

## Workspace

A Companion workspace is a directory:

```text
companion.toml
providers.toml
defaults.toml
webui.toml
agents/
  victor.toml
  writer.toml
vaults/
  shared.toml
identities/
  victor/SOUL.md
.env
.companion/
  state.sqlite
  generated/
```

Create one:

```bash
companion init --workspace ./companion
```

Validate from the workspace:

```bash
companion validate --workspace .
```

`companion.toml` is only the index:

```toml
workspace = "tvc-companion"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
```

## Providers

Providers define where resources live and which environment variables hold credentials:

```toml
[fly.default]
org = "the-vibe-company"
region = "cdg"
token_env = "FLY_API_TOKEN"

[tailscale.tvc]
tailnet = "tail5f910b.ts.net"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
```

Secrets are read from `.env` and then from the shell environment. Shell values win. Companion prints secret names only, never secret values.

```bash
cp .env.example .env
$EDITOR .env
```

## Agents

One agent is one small file:

```toml
[agent]
id = "victor"
runtime = "fly.default"
network = "tailscale.tvc"
model_provider = "openrouter.default"
lifecycle = "present"
protect = true
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"
identity = "identities/victor/SOUL.md"

[default_vault]
enabled = true
name = "Victor"
role = "write"
```

Use `lifecycle = "absent"` to request deletion. Protected data resources still require explicit destroy flags.

## Plan And Apply

Preview everything:

```bash
companion plan --workspace .
```

Preview one resource or agent family:

```bash
companion plan fly_app.agent.victor --workspace .
companion plan victor --workspace .
```

Apply:

```bash
companion apply --workspace .
companion apply victor --workspace .
```

Plan output is resource-oriented:

```text
+ create fly_app.agent.writer tvc-companion-writer
= no-op fly_volume.agent_data.victor vol_xxx
~ update fly_secrets.agent.victor API_SERVER_KEY,OPENROUTER_API_KEY
! drift tailscale_device.agent.writer missing writer
- delete fly_app.agent.old tvc-companion-old
```

Generated Fly TOML is written under `.companion/generated/`.

## Resource Model

V1 resources include:

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

Managed resources can be created, updated, and explicitly destroyed. Observed resources are read for drift. Derived resources are computed locally. Action resources run idempotent rollouts.

State is stored in `.companion/state.sqlite`. It is evidence, not desired config.

```bash
companion state list --workspace .
companion state show fly_app.agent.victor --workspace .
companion state rm fly_app.agent.victor --workspace .
```

## Import And Destroy

Import an existing resource into observed state:

```bash
companion import fly_app.agent.victor tvc-companion-victor --workspace .
companion import fly_volume.agent_data.victor vol_xxx --attrs app=tvc-companion-victor --workspace .
```

Destroy is explicit:

```bash
companion destroy fly_app.agent.victor --confirm victor --workspace .
```

Persistent data requires both data flags:

```bash
companion destroy fly_volume.agent_data.victor --confirm victor --destroy-data --backup-first --workspace .
```

Removing a file does not delete the remote resource. Missing desired resources become orphans until you import, remove state, set `lifecycle = "absent"`, or run an explicit destroy.

## Hermes Identity

Hermes uses `SOUL.md` as the identity layer. Companion keeps the source file in the workspace and installs it during rollout.

Create a starter identity:

```bash
companion identity init victor --name Victor --workspace .
```

Render the identity that will be deployed:

```bash
companion identity render victor --workspace .
```

## Granite Vaults

Every agent can have a default Granite vault:

```toml
[default_vault]
enabled = true
name = "Victor"
mcp_enabled = true
mcp_role = "write"
sync_serve = true
write_serve = true
```

An agent can connect to another agent vault:

```toml
[[vault_connections]]
name = "companion-test"
mode = "sync"
role = "write"
host = "companion-test"
token_secret_name = "GRANITE_COMPANION_TEST_WRITE_TOKEN"
mcp_name = "granite_companion_test"
```

Use `mode = "write"` for HTTP MCP write access. Use `mode = "sync"` for Granite sync remotes.

## Open WebUI

The shared WebUI is derived from enabled Hermes API servers and deployed through the same resource engine:

```bash
companion apply openwebui --workspace .
```

If an agent does not set `api_server.open_webui_url` or `api_server.open_webui_host`, Companion resolves the current Tailscale DNS name and injects it into `OPENAI_API_BASE_URLS`.

## Outputs

Print all outputs:

```bash
companion output --workspace .
```

Read one value:

```bash
companion output open_webui_url --raw --workspace .
companion output agents.victor.dashboard_url --raw --workspace .
companion output open_webui_backends --format json --workspace .
```

Outputs include app names, Tailscale hostnames, API URLs, dashboard URLs, Open WebUI URL, and backend definitions.

## Dashboard

Run the local dashboard:

```bash
companion serve --addr 127.0.0.1:8787 --workspace .
```

Routes:

- `/` fleet overview
- `/agents` agent table
- `/agents/<id>` agent detail
- `/graph` vault connection graph
- `/graph?format=json` graph JSON
- `/drift` drift report

## Development

```bash
go test ./...
sh -n install.sh
bash -n install.sh bin/start-on-fly bin/run-hermes-process bin/start-open-webui-on-fly
go run ./cmd/companion validate --workspace .
go run ./cmd/companion plan --workspace .
```

Release Please manages version PRs, changelog updates, tags, and GitHub Releases. Release assets contain a single `companion` binary for Linux and macOS.

## Legacy Note

The previous Companion web UI codebase is archived at `archived/legacy-companion/`.
