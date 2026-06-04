# CLAUDE.md

This file provides Claude Code guidance for this repository. The full agent instructions live in `AGENTS.md`; follow them as the source of truth.

## Current Direction

Companion is a Go control plane for easily managing fleets of persistent Hermes agents and the tools around them. It is not the old browser UI for Claude Code/Codex.

The product vision is to make agent fleet deployment repeatable: define task-optimized agents, give them durable Granite memory, share selected vaults between agents, run each agent in a secure isolated environment, and control access through Tailscale VPN. The same workflow should support a personal fleet, a client deployment, or a workspace someone else can use to launch their own fleet without bespoke operations work.

Work at the root should focus on the Companion CLI, TOML workspace model, resource planning/apply engine, Fly/Tailscale/OpenRouter providers, Granite vault and tool wiring, Open WebUI deployment, local dashboard, secure access, isolated runtimes, and SQLite evidence state.

The repository root is not a live Companion workspace. Real fleet workspaces, identities, vault links, provider orgs/tailnets, app names, and `.env` files must stay under `.local/` or outside the repository. Never commit personal fleet configuration; public examples must remain anonymized.

The old web UI lives in `archived/legacy-companion/`. Treat it as historical unless the user explicitly asks to modify it.

## First Checks

Use these commands for normal validation:

```bash
go test ./...
sh -n install.sh
bash -n install.sh bin/start-on-fly bin/run-hermes-process bin/start-open-webui-on-fly bin/start-dashboard-on-fly
go run ./cmd/companion validate --workspace examples/minimal
go run ./cmd/companion plan --workspace examples/minimal
```

For dashboard work, use:

```bash
go run ./cmd/companion dashboard --addr 127.0.0.1:8787 --workspace examples/minimal
```

The `dashboard` command (alias: `serve`) live-polls the fleet and serves a status UI embedded via `go:embed`. Enabling `[dashboard]` in a workspace deploys it as its own tiny, stateless Fly app behind Tailscale; `apply` keeps its `fleet.json` topology in sync via `dashboard_config.main`.

## Testing Standard

Follow `AGENTS.md` as the source of truth. Every change should add or update tests that prove Companion's observable behavior: config contracts, workspace loading, planning/idempotence, resource/state evidence, provider parsing, render output, CLI UX, dashboard API, and secret redaction.

Do not add weak tests. Avoid tests that only check `err == nil`, duplicate implementation logic, mock the code being tested, or snapshot output that is not a real public/generated contract.

Use hermetic patterns: table-driven cases, `t.TempDir()` for files and state, `httptest` for external HTTP, `execx.FakeRunner` for CLI integrations, local provider mocks for e2e flows, and `t.Helper()` for fixtures. Never call live Fly, Tailscale, or OpenRouter unless the user explicitly requested a live operation.

When touching a subsystem, cover its product invariants: config defaults/validation, resource graph stability, explicit destroy semantics, protected resources, deterministic generated TOML/scripts, provider auth/error parsing, SQLite persistence/migration behavior, CLI output without secrets, and dashboard `/api/status` links/health/support grouping.

Expected CI gates are `go test ./...`, `go test -race ./...`, shell syntax checks, installable CLI verification, public workspace validation, Docker builds, and a global coverage floor. Coverage is only a regression guard; meaningful assertions remain required.

## Claude-Specific Notes

- Prefer the repository's Go/TOML patterns over the archived TypeScript web UI patterns.
- Do not run live provider mutations unless the user explicitly asks for them.
- Keep secrets private: print names only, never values.
- Keep real workspace config private under `.local/` or outside the repo.
- Use `[defaults.companion_soul]` for fleet-wide Hermes `SOUL.md` additions such as Granite memory rules; it is appended after each agent identity and can be disabled per agent with `[companion_soul] enabled = false`.
- Preserve idempotency and explicit destroy semantics.
- Run `gofmt` on touched Go files and add focused Go tests for behavior changes.
- Use commitzen for commits and PR titles, for example `fix(state): preserve imported resource attrs`.
