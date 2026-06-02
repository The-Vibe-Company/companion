<p align="center">
  <img src="screenshot.png" alt="The Companion" width="100%" />
</p>

<h1 align="center">The Companion</h1>
<p align="center"><strong>Web UI for Claude Code and Codex sessions.</strong></p>
<p align="center">Run multiple agents, inspect every tool call, and gate risky actions with explicit approvals.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/v/the-companion.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/dm/the-companion.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

## Quick start

**Requirements:** [Bun](https://bun.sh) + [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) CLI.

### Try it instantly

```bash
bunx the-companion
```

Open [http://localhost:3456](http://localhost:3456).

### Install globally

```bash
bun install -g the-companion

# Register as a background service (launchd on macOS, systemd on Linux)
the-companion install

# Start the service
the-companion start
```

Open [http://localhost:3456](http://localhost:3456). The server runs in the background and survives reboots.

## CLI commands

| Command | Description |
|---|---|
| `the-companion` | Start server in foreground (default) |
| `the-companion serve` | Start server in foreground (explicit) |
| `the-companion install` | Register as a background service (launchd/systemd) |
| `the-companion start` | Start the background service |
| `the-companion stop` | Stop the background service |
| `the-companion restart` | Restart the background service |
| `the-companion uninstall` | Remove the background service |
| `the-companion status` | Show service status |
| `the-companion logs` | Tail service log files |

**Options:** `--port <n>` overrides the default port (3456).

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
  <-> ws://localhost:3456/ws/browser/:session
Companion server (Bun + Hono)
  <-> ws://localhost:3456/ws/cli/:session
Claude Code / Codex CLI
```

The bridge uses the CLI `--sdk-url` websocket path and NDJSON events.

## Authentication

The server auto-generates an auth token on first start, stored at `~/.companion/auth.json`. You can also manage tokens manually:

```bash
# Show the current token (or auto-generate one)
cd web && bun run generate-token

# Force-regenerate a new token
cd web && bun run generate-token --force
```

Or set a token via environment variable (takes priority over the file):

```bash
COMPANION_AUTH_TOKEN="my-secret-token" bunx the-companion
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
| Docker image (moving) | `preview-main` | `docker.io/stangirard/the-companion:preview-main` |
| Docker image (immutable) | `preview-<sha>` | `docker.io/stangirard/the-companion:preview-abc1234...` |
| npm package | `next` | `bunx the-companion@next` |

Preview builds use a patch-core bump (e.g. `0.68.1-preview.*` when stable is `0.68.0`) so the in-app update checker can detect them as semver-ahead of the current stable release. They are **not** production-stable — use `latest` / semver tags for stable releases.

### Tracking prerelease updates in-app

In **Settings > Updates**, switch the update channel to **Prerelease** to receive preview builds. The default channel is **Stable** (semver releases only). Switching channels takes effect immediately on the next update check.

## Docs
- **Full documentation**: [`docs/`](docs/) (Mintlify — run `cd docs && mint dev` to preview locally)
- Protocol reverse engineering: [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md)
- Contributor and architecture guide: [`CLAUDE.md`](CLAUDE.md)

## License
MIT
