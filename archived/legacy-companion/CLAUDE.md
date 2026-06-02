# CLAUDE.md

This file provides guidance to Claude Code & Codex when working with code in this repository.

## What This Is

The Companion — a web UI for Claude Code & Codex. 
It reverse-engineers the undocumented `--sdk-url` WebSocket protocol in the Claude Code CLI to provide a browser-based interface for running multiple Claude Code sessions with streaming, tool call visibility, and permission control.

## Development Commands

```bash
# Dev server (Hono backend on :3456 + Vite HMR on :5174)
cd web && bun install && bun run dev

# Or from repo root
make dev

# Type checking
cd web && bun run typecheck

# Production build + serve
cd web && bun run build && bun run start

# Auth token management
cd web && bun run generate-token          # show current token
cd web && bun run generate-token --force  # regenerate a new token

# Landing page (thecompanion.sh) — idempotent: starts if down, no-op if up
# IMPORTANT: Always use this script to run the landing page. Never cd into landing/ and run bun/vite manually.
./scripts/landing-start.sh          # start
./scripts/landing-start.sh --stop   # stop
```

## Testing

```bash
# Run tests
cd web && bun run test

# Watch mode
cd web && bun run test:watch
```

- All new backend (`web/server/`) and frontend (`web/src/`) code **must** include tests when possible.
- **Every new or modified frontend component** (`web/src/components/`) **must** have an accompanying `.test.tsx` file with at minimum: a render test, an axe accessibility scan (`toHaveNoViolations()`), and tests for any interactive behavior (clicks, keyboard shortcuts, state changes).
- Tests use Vitest. Server tests live alongside source files (e.g. `routes.test.ts` next to `routes.ts`).
- A husky pre-commit hook runs typecheck and tests automatically before each commit.
- **Never remove or delete existing tests.** If a test is failing, fix the code or the test. If you believe a test should be removed, you must first explain to the user why and get explicit approval before removing it.
- When creating test, make sure to document what the test is validating, and any important context or edge cases in comments within the test code.

## Component Playground

All UI components used in the message/chat flow **must** be represented in the Playground page (`web/src/components/Playground.tsx`, accessible at `#/playground`). When adding or modifying a message-related component (e.g. `MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, streaming indicators, tool groups, subagent groups), update the Playground to include a mock of the new or changed state.

## Architecture

### Data Flow

```
Browser (React) ←→ WebSocket ←→ Hono Server (Bun) ←→ WebSocket (NDJSON) ←→ Claude Code CLI
     :5174              /ws/browser/:id        :3456        /ws/cli/:id         (--sdk-url)
```

1. Browser sends a "create session" REST call to the server
2. Server spawns `claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID` as a subprocess
3. CLI connects back to the server over WebSocket using NDJSON protocol
4. Server bridges messages between CLI WebSocket and browser WebSocket
5. Tool calls arrive as `control_request` (subtype `can_use_tool`) — browser renders approval UI, server relays `control_response` back

### All code lives under `web/`

- **`web/server/`** — Hono + Bun backend (runs on port 3456)
  - `index.ts` — Server bootstrap, Bun.serve with dual WebSocket upgrade (CLI vs browser)
  - `ws-bridge.ts` — Core message router. Maintains per-session state (CLI socket, browser sockets, message history, pending permissions). Parses NDJSON from CLI, translates to typed JSON for browsers.
  - `cli-launcher.ts` — Spawns/kills/relaunches Claude Code CLI processes. Handles `--resume` for session recovery. Persists session state across server restarts.
  - `session-store.ts` — JSON file persistence to `$TMPDIR/vibe-sessions/`. Debounced writes.
  - `session-types.ts` — All TypeScript types for CLI messages (NDJSON), browser messages, session state, permissions.
  - `routes.ts` — REST API: session CRUD, filesystem browsing, environment management.
  - `env-manager.ts` — CRUD for environment profiles stored in `~/.companion/envs/`.

- **`web/src/`** — React 19 frontend
  - `store.ts` — Zustand store. All state keyed by session ID (messages, streaming text, permissions, tasks, connection status).
  - `ws.ts` — Browser WebSocket client. Connects per-session, handles all incoming message types, auto-reconnects. Extracts task items from `TaskCreate`/`TaskUpdate`/`TodoWrite` tool calls.
  - `types.ts` — Re-exports server types + client-only types (`ChatMessage`, `TaskItem`, `SdkSessionInfo`).
  - `api.ts` — REST client for session management.
  - `App.tsx` — Root layout with sidebar, chat view, task panel. Hash routing (`#/playground`).
  - `components/` — UI: `ChatView`, `MessageFeed`, `MessageBubble`, `ToolBlock`, `Composer`, `Sidebar`, `TopBar`, `HomePage`, `TaskPanel`, `PermissionBanner`, `EnvManager`, `Playground`.

- **`web/bin/cli.ts`** — CLI entry point (`bunx the-companion`). Sets `__COMPANION_PACKAGE_ROOT` and imports the server.

### WebSocket Protocol

The CLI uses NDJSON (newline-delimited JSON). Key message types from CLI: `system` (init/status), `assistant`, `result`, `stream_event`, `control_request`, `tool_progress`, `tool_use_summary`, `keep_alive`. Messages to CLI: `user`, `control_response`, `control_request` (for interrupt/set_model/set_permission_mode).

Full protocol documentation is in `WEBSOCKET_PROTOCOL_REVERSED.md`.

### Session Lifecycle

Sessions persist to disk (`$TMPDIR/vibe-sessions/`) and survive server restarts. On restart, live CLI processes are detected by PID and given a grace period to reconnect their WebSocket. If they don't, they're killed and relaunched with `--resume` using the CLI's internal session ID.

### Raw Protocol Recordings

The server automatically records **all raw protocol messages** (both Claude Code NDJSON and Codex JSON-RPC) to JSONL files. This is useful for debugging, understanding the protocol, and building replay-based tests.

- **Location**: `~/.companion/recordings/` (override with `COMPANION_RECORDINGS_DIR`)
- **Format**: JSONL — one JSON object per line. First line is a header with session metadata, subsequent lines are raw message entries.
- **File naming**: `{sessionId}_{backendType}_{ISO-timestamp}_{randomSuffix}.jsonl`
- **Disable**: set `COMPANION_RECORD=0` or `COMPANION_RECORD=false`
- **Rotation**: automatic cleanup when total lines exceed 1M (configurable via `COMPANION_RECORDINGS_MAX_LINES`)

Each entry captures:
```json
{"ts": 1771153996875, "dir": "in", "raw": "{\"type\":\"system\",...}", "ch": "cli"}
```
- `dir`: `"in"` (received by server) or `"out"` (sent by server)
- `ch`: `"cli"` (Claude Code / Codex process) or `"browser"` (frontend WebSocket)
- `raw`: the exact original string — never re-serialized, preserving the true protocol payload

**REST API**:
- `GET /api/recordings` — list all recording files with metadata
- `GET /api/sessions/:id/recording/status` — check if a session is recording + file path
- `POST /api/sessions/:id/recording/start` / `stop` — enable/disable per session

**Code**: `web/server/recorder.ts` (recorder + manager), `web/server/replay.ts` (load & filter utilities).

## Browser Exploration

Always use `agent-browser` CLI command to explore the browser. Never use playwright or other browser automation libraries.

## Pull Requests

When submitting a pull request:
- use commitzen to format the commit message and the PR title
- Add a screenshot of the changes in the PR description if its a visual change
- Explain simply what the PR does and why it's needed
- Tell me if the code was reviewed by a human or simply generated directly by an AI. 

## Linear Issues

When creating or updating Linear issues:
- do not use commitzen-style titles in Linear
- use clear product-style titles that describe user value/outcome

### How To Open A PR With GitHub CLI

Use this flow from the repository root:

```bash
# 1) Create a branch
git checkout -b fix/short-description (commitzen)

# 2) Commit using commitzen format
git add <files>
git commit -m "fix(scope): short summary" (commitzen)

# 3) Push and set upstream
git push -u origin fix/short-description

# 4) Create PR (title should follow commitzen style)
gh pr create --base main --head fix/short-description --title "fix(scope): short summary"
```

For multi-line PR descriptions, prefer a body file to avoid shell quoting issues:

```bash
cat > /tmp/pr_body.md <<'EOF'
## Summary
- what changed

## Why
- why this is needed

## Testing
- what was run

## Review provenance
- Implemented by AI agent / Human
- Human review: yes/no
EOF

gh pr edit --body-file /tmp/pr_body.md
```

## Codex & Claude Code
- All features must be compatible with both Codex and Claude Code. If a feature is only compatible with one, it must be gated behind a clear UI affordance (e.g. "This feature requires Claude Code") and the incompatible option should be hidden or disabled.
- When implementing a new feature, always consider how it will work with both models and test with both if possible. If a feature is only implemented for one model, document that clearly in the code and in the UI.

## Cursor Cloud specific instructions

### Services
- **Hono backend** (port 3457 in dev): `cd web && bun run dev:api` or via `./scripts/dev-start.sh`
- **Vite frontend** (port 5174 in dev): `cd web && bun run dev:vite` or via `./scripts/dev-start.sh`
- Both start together with `cd web && bun run dev` (or `make dev`), but that runs in foreground. Use `./scripts/dev-start.sh` for background mode.

### Caveats
- `./scripts/dev-start.sh` health-checks the backend on `/` which returns 404. If the script times out, the backend is still running — verify with `curl http://localhost:3457/api/sessions`. You can start the servers manually as background processes instead.
- The app requires Claude Code CLI or Codex CLI to create functional sessions. Without them, the UI loads but session creation will fail. The component playground at `#/playground` works without any CLI.
- No external databases or services are needed. Session state persists to `$TMPDIR/vibe-sessions/` as JSON files.
- The pre-commit hook (`.husky/pre-commit`) runs `cd web && bun run typecheck && bun run test -- --coverage`. Run these before committing.
- Two blocked postinstalls (`core-js`, `protobufjs`) are harmless and do not affect functionality.
