<p align="center">
  <img src="screenshot.png" alt="AgentHangar" width="100%" />
</p>

<h1 align="center">AgentHangar</h1>
<p align="center"><strong>Web UI for Claude Code and Codex sessions.</strong></p>
<p align="center">Run multiple agents, inspect every tool call, and gate risky actions with explicit approvals.</p>
<p align="center"><em>Maintained fork of The Companion, originally created by The Vibe Company.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/agenthangar"><img src="https://img.shields.io/npm/v/agenthangar.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/agenthangar"><img src="https://img.shields.io/npm/dm/agenthangar.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

## Quick start

**Requirements:** [Bun](https://bun.sh) + [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) CLI.

### Try it instantly

```bash
bunx agenthangar
```

Open [http://localhost:6060](http://localhost:6060).

### Install globally

```bash
bun install -g agenthangar

# Register as a background service (launchd on macOS, systemd on Linux)
agenthangar install

# Start the service
agenthangar start
```

Open [http://localhost:6060](http://localhost:6060). The server runs in the background and survives reboots.

In dev mode, Vite serves the UI on the same port and proxies `/api` + `/ws` to the Hono backend on `6061`.

## CLI commands

| Command | Description |
|---|---|
| `agenthangar` | Start server in foreground (default) |
| `agenthangar serve` | Start server in foreground (explicit) |
| `agenthangar install` | Register as a background service (launchd/systemd) |
| `agenthangar start` | Start the background service |
| `agenthangar stop` | Stop the background service |
| `agenthangar restart` | Restart the background service |
| `agenthangar uninstall` | Remove the background service |
| `agenthangar status` | Show service status |
| `agenthangar logs` | Tail service log files |

**Options:** `--port <n>` overrides the default port (6060).

## Why this is useful
- **Parallel sessions**: work on multiple tasks without juggling terminals.
- **Full visibility**: see streaming output, tool calls, and tool results in one timeline.
- **Permission control**: approve/deny sensitive operations from the UI.
- **Session recovery**: restore work after process/server restarts.
- **Dual-engine support**: designed for both Claude Code and Codex-backed flows.

## Screenshots
| Chat + tool timeline | Permission flow |
|---|---|
| <img src="screenshot.png" alt="Main workspace" width="100%" /> | <img src="web/docs/screenshots/notification-section.png" alt="Permission and notifications" width="100%" /> |

## Architecture (simple)
```text
Browser (React)
  <-> ws://localhost:6060/ws/browser/:session
AgentHangar server (Bun + Hono)
  <-> stdio (NDJSON)
Claude Code / Codex CLI (child process)
```

AgentHangar server spawns each Claude Code / Codex CLI as a child process and exchanges NDJSON over its stdin/stdout — the historical `--sdk-url` WebSocket transport for Claude has been replaced by `--print --input-format stream-json --output-format stream-json`. Browsers still talk to the server over WebSocket on `/ws/browser/:session`.

## Authentication

The server auto-generates an auth token on first start, stored at `~/.agenthangar/auth.json`. You can also manage tokens manually:

```bash
# Show the current token (or auto-generate one)
cd web && bun run generate-token

# Force-regenerate a new token
cd web && bun run generate-token --force
```

Or set a token via environment variable (takes priority over the file):

```bash
AGENTHANGAR_AUTH_TOKEN="my-secret-token" bunx agenthangar
```

## Development
```bash
make dev
```

Manual:
```bash
cd web
bun install
bun run dev
```

Checks:
```bash
cd web
bun run typecheck
bun run test
```

## Preview / Prerelease

Every push to `main` publishes a preview artifact:

| Artifact | Tag / dist-tag | Example |
|---|---|---|
| Docker image (moving) | `preview-main` | `docker.io/blocksec/agenthangar:preview-main` |
| Docker image (immutable) | `preview-<sha>` | `docker.io/blocksec/agenthangar:preview-abc1234...` |
| npm package | `next` | `bunx agenthangar@next` |

Preview builds use a patch-core bump (e.g. `0.68.1-preview.*` when stable is `0.68.0`) so the in-app update checker can detect them as semver-ahead of the current stable release. They are **not** production-stable — use `latest` / semver tags for stable releases.

### Tracking prerelease updates in-app

In **Settings > Updates**, switch the update channel to **Prerelease** to receive preview builds. The default channel is **Stable** (semver releases only). Switching channels takes effect immediately on the next update check.

## Docs
- **Full documentation**: [`docs/`](docs/) (Mintlify — run `cd docs && mint dev` to preview locally)
- Protocol reverse engineering: [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md)
- Contributor and architecture guide: [`CLAUDE.md`](CLAUDE.md)

## License
MIT
