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

Ready-to-copy examples live in `examples/minimal` and `examples/webui`.

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
org = "personal"
region = "cdg"
token_env = "FLY_API_TOKEN"
# mode = "cli" is the default. In CLI mode, either fly auth login or FLY_API_TOKEN works.
# Use mode = "api" for API-backed tests or future live API runs; then FLY_API_TOKEN is required.
# api_base_url = "http://127.0.0.1:3001/fly/v1"

[tailscale.tvc]
tailnet = "tail5f910b.ts.net"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"
# mode = "cli" is the default. In CLI mode, TAILSCALE_API_KEY is only needed for API-only actions such as cleanup.
# api_base_url = "http://127.0.0.1:3001/tailscale"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
# api_base_url can override base_url for local mocks.
```

Secrets are read from `.env` and then from the shell environment. Shell values win. Companion prints secret names only, never secret values.

```bash
cp .env.example .env
$EDITOR .env
```

By default, `--env-file .env` is resolved relative to `--workspace`. For live operations, keep the `.env` next to the `companion.toml` that owns the state, or pass one explicit absolute path:

```bash
companion plan --workspace . --env-file /path/to/live/.env
```

Do not alternate between multiple workspace/state/env directories for the same fleet unless you are deliberately migrating state.

### Provider Architecture

Companion resolves provider refs like `fly.default`, `tailscale.tvc`, and `openrouter.default` into typed clients:

- Fly provider: apps, volumes, secrets, and machines read/create/update/delete.
- Tailscale provider: device list/delete, with auth-key hooks reserved for later.
- OpenRouter provider: model catalog validation through `/models`.
- Rollout provider: deploy action only, currently `fly deploy` through an injectable runner.

`rollout.*` intentionally stays separate from CRUD. Building images, pushing them, and updating Fly Machines atomically is not the same operation as creating an app or extending a volume. Until Companion owns that full image/machine lifecycle, rollout remains an action resource backed by `fly deploy`.

Provider-backed model validation is opt-in:

```bash
companion validate --providers --workspace .
```

This checks provider access first, then verifies configured OpenRouter models. In the default Fly CLI mode, an existing `fly auth login` session is enough; `FLY_API_TOKEN` becomes mandatory only when the Fly provider uses `mode = "api"`.

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
mcp_role = "write"
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

### How This Is Like Terraform

The workspace files are desired state. The SQLite state maps resource addresses to remote IDs and observed facts. Providers refresh/read remote objects. `plan` compares desired, observed, and state. `apply` calls CRUD operations or action runners. `import` binds existing remote resources to state without creating config.

The main difference is scope: Companion is purpose-built for Hermes fleets, Granite vaults, Tailscale DNS, Fly apps, and Open WebUI backends instead of being a general infrastructure language.

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

Provider e2e tests run as part of `go test ./...`. They use local `httptest.Server` mocks for Fly, Tailscale, and OpenRouter, plus a fake rollout runner. No real credentials or external APIs are required.

The mock provider path is configured with `mode = "api"` and `api_base_url` in a temporary workspace:

```toml
[fly.default]
mode = "api"
api_base_url = "http://127.0.0.1:3001/fly/v1"
token_env = "FLY_API_TOKEN"

[tailscale.tvc]
mode = "api"
api_base_url = "http://127.0.0.1:3001/tailscale"
tailnet = "tail5f910b.ts.net"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
api_base_url = "http://127.0.0.1:3001/openrouter/api/v1"
api_key_env = "OPENROUTER_API_KEY"
```

Live provider tests are intentionally not enabled in CI. If they are added later, they should be gated behind an explicit environment variable such as `COMPANION_LIVE_PROVIDER_TESTS=1`.

Release Please manages version PRs, changelog updates, tags, and GitHub Releases. Release assets contain a single `companion` binary for Linux and macOS.

## Legacy Note

The previous Companion web UI codebase is archived at `archived/legacy-companion/`.
