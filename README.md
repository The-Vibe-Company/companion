# Companion

Companion is a Go control plane for deploying and operating persistent Hermes agents.

It turns a `companion.toml` fleet file into Fly.io apps, Tailscale identities, Granite vaults, Hermes `SOUL.md` identities, Open WebUI backends, observed state, drift reports, and Terraform-style outputs.

## What Companion Manages

- Hermes agents deployed on Fly.io.
- Stable Tailscale hostnames for each agent.
- Per-agent default Granite vaults.
- Cross-agent Granite vault connections in write or sync mode.
- Hermes identity files through `SOUL.md`.
- A shared Open WebUI frontend generated from the enabled Hermes API servers.
- Local observed state in SQLite.
- Plan/apply/status/drift workflows for the fleet.

`companion.toml` is the desired source of truth. `.companion/state.sqlite` stores observed facts only. Generated Fly TOML lives under `.companion/generated/`.

## Install

Install the CLI from the latest GitHub Release:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Vibe-Company/companion/main/install.sh | sh
```

The installer downloads the right binary for macOS or Linux and installs it to `~/.local/bin/companion` by default.

If the repository is private, pass a GitHub token with repository read access:

```bash
curl -fsSL \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://raw.githubusercontent.com/The-Vibe-Company/companion/main/install.sh \
  | GITHUB_TOKEN="$GITHUB_TOKEN" sh
```

Install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Vibe-Company/companion/main/install.sh | COMPANION_VERSION=v0.1.0 sh
```

Install somewhere else:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Vibe-Company/companion/main/install.sh | BINDIR=/usr/local/bin sh
```

Then run:

```bash
companion version
companion validate --config companion.toml
```

Runtime requirements for real deploys:

- `flyctl`
- `tailscale`

Developer fallback from source:

```bash
go install github.com/The-Vibe-Company/companion/cmd/companion@main
```

If the repository is private on your machine, make Go use GitHub authentication for this repo:

```bash
GOPRIVATE=github.com/The-Vibe-Company/companion go install github.com/The-Vibe-Company/companion/cmd/companion@main
```

Run from the repository root:

```bash
go run ./cmd/companion validate --config companion.toml
```

For real deploys, create a local secret file:

```bash
cp .env.example .env
$EDITOR .env
```

Secrets are read from `.env` by default. Exported shell variables override `.env`. CLI output prints secret names only, never secret values.

## Fleet Config

A minimal agent:

```toml
[[agents]]
id = "victor"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"

[agents.default_vault]
name = "Victor"
```

Useful defaults live under `[defaults]`, `[defaults.model]`, `[defaults.api_server]`, and `[defaults.default_vault]`.

## Deploy an Agent

Preview the desired changes:

```bash
go run ./cmd/companion plan victor --config companion.toml
```

Apply one agent:

```bash
go run ./cmd/companion apply victor --config companion.toml
```

Apply all agents:

```bash
go run ./cmd/companion apply --config companion.toml
```

If Fly already has the required secrets and you do not want to keep local secret values:

```bash
go run ./cmd/companion apply victor --config companion.toml --reuse-existing-secrets
```

## Hermes Identity

Hermes uses `SOUL.md` as the primary identity layer. Companion keeps identity files locally and installs them into `$HERMES_HOME/SOUL.md` during deploy.

Create a starter identity:

```bash
go run ./cmd/companion identity init victor --name Victor --config companion.toml
```

Render what will be installed:

```bash
go run ./cmd/companion identity render victor --config companion.toml
```

Config shape:

```toml
[agents.identity]
enabled = true
path = "identities/victor/SOUL.md"
overwrite = true
```

Set `overwrite = false` if the running agent may keep a manually edited remote `SOUL.md`.

## Granite Vaults

Each agent can have a default Granite vault:

```toml
[agents.default_vault]
enabled = true
name = "Victor"
mcp_enabled = true
mcp_role = "write"
sync_serve = true
write_serve = true
```

An agent can also connect to another agent's vault:

```toml
[[agents.vault_connections]]
name = "companion-test"
mode = "sync"
role = "write"
host = "companion-test"
token_secret_name = "GRANITE_COMPANION_TEST_WRITE_TOKEN"
mcp_name = "granite_companion_test"
```

Use `mode = "write"` for HTTP MCP write access. Use `mode = "sync"` for Granite sync remotes.

## Open WebUI

Companion generates Open WebUI backend config from enabled Hermes API servers.

Deploy the shared WebUI:

```bash
go run ./cmd/companion apply-webui --config companion.toml
```

Print its URL and configured backends:

```bash
go run ./cmd/companion output open_webui_url --raw --config companion.toml
go run ./cmd/companion output open_webui_backends --format json --config companion.toml
```

If an agent does not set `api_server.open_webui_url` or `api_server.open_webui_host`, Companion resolves the current Tailscale DNS name and injects it into `OPENAI_API_BASE_URLS`.

## Outputs

Companion exposes Terraform-style outputs:

```bash
go run ./cmd/companion output --config companion.toml
go run ./cmd/companion output agents.victor.dashboard_url --raw --config companion.toml
go run ./cmd/companion output --format json --config companion.toml
```

Outputs include agent app names, Tailscale hosts, API URLs, dashboard URLs, Open WebUI URL, and Open WebUI backend definitions.

## Status, Drift, and Graph

```bash
go run ./cmd/companion status --config companion.toml
go run ./cmd/companion drift --config companion.toml
go run ./cmd/companion graph --format text --config companion.toml
go run ./cmd/companion graph --format json --config companion.toml
```

`status` checks Hermes health. `drift` compares desired config to observed Fly and Tailscale state. `graph` renders agent-to-vault relationships.

## Local Dashboard

Companion ships a small server-rendered dashboard:

```bash
go run ./cmd/companion serve --addr 127.0.0.1:8787 --config companion.toml
```

Routes:

- `/` fleet overview
- `/agents` agent table
- `/agents/<id>` agent detail
- `/graph` vault connection graph
- `/graph?format=json` graph JSON
- `/drift` drift report

## State Import

Import existing provider resources into local observed state without changing desired config:

```bash
go run ./cmd/companion import fly_app.companion-test tvc-companion-test --config companion.toml
go run ./cmd/companion import fly_volume.companion-test-data vol_xxx --attrs app=tvc-companion-test
go run ./cmd/companion import tailscale_device.companion-test companion-test-2
go run ./cmd/companion state list
```

Import addresses use `provider_kind.desired-id`. Re-importing the same address updates the external id instead of creating a duplicate state entry.

## Vault Backups

Back up and restore default Granite vaults from the running Fly machine:

```bash
go run ./cmd/companion vault backup companion-test --config companion.toml
go run ./cmd/companion vault restore companion-test .companion/backups/companion-test-granite-YYYYMMDDTHHMMSSZ.tgz --config companion.toml --yes
```

Restore moves the previous remote vault aside before extraction.

## Tailscale Cleanup

Dry-run cleanup of old duplicate Tailscale devices:

```bash
go run ./cmd/companion tailscale cleanup --config companion.toml
```

Apply cleanup with the Tailscale API:

```bash
go run ./cmd/companion tailscale cleanup --config companion.toml --apply
```

`TAILSCALE_API_KEY` must be present in `.env` or the shell environment for deletion.

## Development

```bash
go test ./...
bash -n bin/start-on-fly bin/run-hermes-process bin/start-open-webui-on-fly
go run ./cmd/companion validate --config companion.toml
go run ./cmd/companion plan --config companion.toml
```

Tests cover config normalization, identity handling, Fly TOML rendering, Open WebUI backend generation, provider parsing, state persistence, Tailscale cleanup, outputs, and vault backup/restore command behavior.

## Releases

Release Please manages version PRs, changelog updates, tags, and GitHub Releases from conventional commits.

When a Release Please PR is merged, the release workflow builds and uploads:

- `companion_linux_amd64.tar.gz`
- `companion_linux_arm64.tar.gz`
- `companion_darwin_amd64.tar.gz`
- `companion_darwin_arm64.tar.gz`

Each archive contains a single `companion` binary. The top-level `install.sh` script downloads these assets from the latest release.

## Legacy Note

The previous Companion web UI codebase is archived at `archived/legacy-companion/`. It is kept as a historical snapshot while the root of this repository moves to the Hermes fleet control plane.
