# AGENTS.md

This file provides guidance to Claude Code, Codex, and other coding agents when working in this repository.

## Product Direction

Companion is a Go control plane for easily managing fleets of persistent Hermes agents and the tools around them.

The product vision is simple: a user should be able to define task-optimized agents, give them durable memory through Granite, share selected memory between agents, run each agent in a secure isolated environment, and control access through Tailscale VPN. Companion should make it practical to spin up a personal fleet, deploy a fleet for a client, or hand someone a workspace they can use to launch their own agent fleet without bespoke operations work.

Treat the root repository as infrastructure and operations software, not as the old browser UI for Claude Code or Codex. A Companion workspace is a folder of small TOML files that describe desired state for providers, defaults, agents, identities, tools, Granite vaults, secure networking, and Open WebUI. Companion compiles that desired state into typed resources, compares it with observed Fly/Tailscale/OpenRouter state, writes generated Fly TOML, applies changes idempotently, and records evidence in SQLite.

The previous Companion web UI is archived under `archived/legacy-companion/`. Do not extend or revive that code unless the user explicitly asks to work on the archive.

## Architecture Map

- `cmd/companion/` is the CLI entry point.
- `internal/cli/` wires Cobra commands and user-facing command behavior.
- `internal/config/`, `internal/workspace/`, and `internal/envfile/` load and validate workspace TOML and environment files.
- `internal/resource/`, `internal/plan/`, `internal/provider/`, and `internal/state/` own the resource graph, planning, observed state, and local SQLite evidence.
- `internal/fly/`, `internal/tailscale/`, `internal/tailscalectl/`, and `internal/openrouter/` are provider-specific integrations.
- `internal/render/`, `internal/deps/`, `internal/hermes/`, `internal/vaultops/`, `internal/outputs/`, and `internal/web/` handle generated artifacts, Hermes/Open WebUI runtime wiring, vault operations, outputs, and the local dashboard.
- `examples/` contains copyable starter workspaces with anonymized provider, agent, vault, and Open WebUI config.
- Real fleet workspaces, identities, vault links, provider orgs/tailnets, app names, and `.env` files must stay under `.local/` or outside the repository.

## Development Commands

```bash
go test ./...
sh -n install.sh
bash -n install.sh bin/start-on-fly bin/run-hermes-process bin/start-open-webui-on-fly bin/start-dashboard-on-fly
go run ./cmd/companion validate --workspace examples/minimal
go run ./cmd/companion plan --workspace examples/minimal
go run ./cmd/companion dashboard --addr 127.0.0.1:8787 --workspace examples/minimal
```

Provider e2e tests should use local mocks through `mode = "api"` and `api_base_url`. Do not hit live Fly, Tailscale, or OpenRouter resources unless the user explicitly asks for a live operation.

## Engineering Rules

- Keep behavior deterministic and idempotent. Running `plan` or `apply` repeatedly should not create resource churn.
- Treat TOML files as desired state and `.companion/state.sqlite` as evidence, not source of truth.
- Preserve stable resource addresses such as `fly_app.agent.<id>`, `fly_volume.agent_data.<id>`, `tailscale_device.agent.<id>`, and `rollout.agent.<id>`.
- Deletion must stay explicit. Removing desired config should not silently destroy protected remote data.
- Never print, log, commit, or expose secret values. Use environment variable names and secret names only.
- Never commit personal fleet configuration. The public repository should contain only the CLI, documentation, and anonymized examples.
- Prefer typed config/resource APIs over stringly-typed shortcuts.
- Keep generated artifacts under `.companion/generated/`; do not hand-edit generated Fly TOML as source.
- Run `gofmt` on touched Go files.
- Add focused Go tests for changed planning, config, provider, state, render, CLI, or output behavior.

## Testing Standard

Tests in this repository must prove product behavior, not implementation trivia. A good test describes an observable Companion contract: TOML normalization, workspace loading, resource graph shape, idempotent plans, generated Fly TOML, provider API parsing, SQLite evidence, CLI output, dashboard JSON, or secret redaction.

Weak tests are not acceptable. Do not add tests that only check `err == nil`, mirror the implementation, mock the unit under test, assert no meaningful behavior, or use snapshots/golden files without a real output contract.

Use the established hermetic patterns:

- Table-driven tests for config variants, provider responses, URL modes, lifecycle states, and error cases.
- `t.TempDir()` for workspaces, generated files, and SQLite state.
- `httptest` for external HTTP APIs.
- `execx.FakeRunner` for Fly/Tailscale CLI behavior.
- Local provider mocks for e2e-style apply/plan tests.
- `t.Helper()` for fixture builders and assertion helpers.
- Regression tests for fixed bugs, especially idempotency, deletion safety, URL computation, and secret redaction.
- No live Fly, Tailscale, or OpenRouter calls unless the user explicitly requests live operations.

Coverage expectations by area:

- `internal/config`, `internal/workspace`, `internal/envfile`: defaults, validation failures, overrides, path safety, and public example workspaces.
- `internal/resource`, `internal/plan`, `internal/state`: stable graphs, idempotence, drift, explicit deletion, protected resources, and SQLite writes/migrations.
- `internal/render`, `internal/hermes`, `internal/outputs`, `internal/deps`: deterministic generated artifacts, redacted secrets, correct URLs/dependencies, and no invented runtime URLs.
- `internal/fly`, `internal/tailscale`, `internal/openrouter`, `internal/tailscalectl`: API/CLI parsing, auth headers, provider errors, offline/duplicate states, and safe deletion targeting.
- `internal/cli`: temporary-workspace command flows, useful errors, provider-mock apply/plan, and no secret values in stdout/stderr.
- `internal/web`, `internal/status`: `/api/status` contract, health rollups, agent/support separation, embedded assets, and user links kept separate from health probes.

The CI gates are `go test ./...`, `go test -race ./...`, shell syntax checks, installable CLI verification, public workspace validation, Docker builds, and a global coverage floor. Treat coverage as a regression guard, not a substitute for meaningful assertions.

## Workspace Semantics

- Companion workspaces are folders containing `companion.toml`, `providers.toml`, `defaults.toml`, optional `webui.toml`, `agents/*.toml`, `vaults/*.toml`, and identities.
- The repository root is not a live Companion workspace. Use `examples/minimal` and `examples/webui` for public examples, and `.local/` or an external path for real fleets.
- Use `[defaults.companion_soul]` for fleet-wide Hermes identity additions that must be appended to every rendered `SOUL.md`, such as Granite memory discipline. Keep agent-specific `SOUL.md` files focused on the agent identity; do not duplicate the global block into every file. Agents can opt out with `[companion_soul] enabled = false`.

Use `lifecycle = "absent"` for desired deletion. Persistent data requires explicit destroy flags and backup intent.

## Pull Requests

- Commit messages and PR titles must use commitzen format, for example `feat(plan): add openwebui drift output`.
- PR names should be commitzen.
- Explain what changed, why it is needed, and what validation was run.
- If a change affects a visual surface such as the local dashboard, include a screenshot in the PR description.
- Say whether the change was generated by an AI agent and whether a human reviewed it.
