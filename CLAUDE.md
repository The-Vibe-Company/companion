# CLAUDE.md

This file provides Claude Code guidance for this repository. The full agent instructions live in `AGENTS.md`; follow them as the source of truth.

## Current Direction

Companion is now a Go control plane for persistent Hermes agents. It is not the old browser UI for Claude Code/Codex.

Work at the root should focus on the Companion CLI, TOML workspace model, resource planning/apply engine, Fly/Tailscale/OpenRouter providers, Granite vault wiring, Open WebUI deployment, local dashboard, and SQLite evidence state.

The old web UI lives in `archived/legacy-companion/`. Treat it as historical unless the user explicitly asks to modify it.

## First Checks

Use these commands for normal validation:

```bash
go test ./...
sh -n install.sh
bash -n install.sh bin/start-on-fly bin/run-hermes-process bin/start-open-webui-on-fly
go run ./cmd/companion validate --workspace .
go run ./cmd/companion plan --workspace .
```

For dashboard work, use:

```bash
go run ./cmd/companion serve --addr 127.0.0.1:8787 --workspace .
```

## Claude-Specific Notes

- Prefer the repository's Go/TOML patterns over the archived TypeScript web UI patterns.
- Do not run live provider mutations unless the user explicitly asks for them.
- Keep secrets private: print names only, never values.
- Preserve idempotency and explicit destroy semantics.
- Run `gofmt` on touched Go files and add focused Go tests for behavior changes.
- Use commitzen for commits and PR titles, for example `fix(state): preserve imported resource attrs`.

