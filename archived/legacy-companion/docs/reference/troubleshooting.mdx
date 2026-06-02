---
title: Troubleshooting
description: Solutions to common problems and debugging with protocol recordings
---

# Troubleshooting

## CLI not found

**Symptom**: Error when creating a session — `claude` or `codex` command not found.

**Fix**: Install the CLI globally and ensure it's on your `PATH`:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code
which claude

# Codex
npm install -g @openai/codex
which codex
```

## Port already in use

**Symptom**: Server fails to start with "address already in use" on port 3456.

**Fix**: Find what's using the port or choose another:

```bash
lsof -i :3456
the-companion --port 8080
```

## Authentication errors

**Symptom**: Browser shows auth error or can't connect.

**Fix**: Regenerate the token:

```bash
cd web && bun run generate-token --force
```

Or set explicitly:

```bash
COMPANION_AUTH_TOKEN="my-token" the-companion
```

## CLI disconnects immediately

**Symptom**: Session is created but the CLI exits right away.

**Causes**:
- CLI not authenticated (missing API key or subscription)
- Working directory doesn't exist
- Incompatible CLI version

Check server logs: `the-companion logs`

## Docker not detected

**Symptom**: Environments page shows amber "No Docker" badge. Docker sessions fail to create.

**Fix**:
- Ensure Docker is installed and the daemon is running: `docker ps`
- On Linux, make sure your user is in the `docker` group: `sudo usermod -aG docker $USER`
- On macOS, ensure Docker Desktop is running

## Docker image pull fails

**Symptom**: Image pull shows error state in the Environments Docker tab.

**Fix**:
- Check your internet connection
- Verify the image name is correct
- Try pulling manually: `docker pull the-companion:latest`
- Check Docker Hub rate limits if pulling many images

## Worktree conflicts

**Symptom**: Error creating a worktree for a branch.

**Causes**:
- The branch is already checked out in the main working tree (git doesn't allow a branch in two worktrees)
- The worktree path already exists on disk

**Fix**: The Companion handles this automatically by creating a unique branch name (e.g., `main-wt-5391`). If you see persistent errors, check `~/.companion/worktrees.json` and remove stale entries.

## Linear connection fails

**Symptom**: "Verify" button shows an error in Linear Settings.

**Fix**:
- Ensure your API key starts with `lin_api_`
- Check that the key hasn't been revoked in [Linear Settings > API](https://linear.app/settings/api)
- Try generating a new API key

## Session not recovering after restart

**Symptom**: Sessions appear after restart but the agent doesn't resume.

**Fix**:
- Check that the CLI is still installed and on `PATH`
- Verify your authentication is still valid
- Check that the working directory still exists
- View server logs for relaunch errors: `the-companion logs`

## Browser WebSocket not connecting

**Symptom**: UI loads but shows disconnected state.

**Fix**:
- Check the server is running
- Refresh the page
- Check for proxy or firewall blocking WebSocket connections
- Verify the auth token matches (check browser console for 401 errors)

## Server logs

When running as a background service:

```bash
the-companion logs
```

When running in foreground, logs print to stdout. Check the session files directly at `$TMPDIR/vibe-sessions/` for raw state inspection.

## Debugging with protocol recordings

The Companion automatically records all WebSocket messages to JSONL files. Use recordings to debug issues, understand agent behavior, or build test fixtures.

### Where recordings are stored

- **Directory**: `~/.companion/recordings/`
- **Override**: Set `COMPANION_RECORDINGS_DIR` env var
- **File naming**: `{sessionId}_{backendType}_{ISO-timestamp}_{randomSuffix}.jsonl`

### Recording format

Each file is JSONL (one JSON object per line). The first line is a header with session metadata. Subsequent lines are message entries:

```json
{"ts": 1771153996875, "dir": "in", "raw": "{\"type\":\"system\",...}", "ch": "cli"}
```

| Field | Description |
|---|---|
| `ts` | Timestamp (milliseconds since epoch) |
| `dir` | `"in"` (received by server) or `"out"` (sent by server) |
| `ch` | `"cli"` (agent process) or `"browser"` (frontend) |
| `raw` | The exact original message — never re-serialized |

### Inspecting recordings

```bash
# View the first 20 messages
head -20 ~/.companion/recordings/SESSION_*.jsonl

# Filter for CLI messages only
grep '"ch":"cli"' ~/.companion/recordings/SESSION_*.jsonl

# Find permission requests
grep 'can_use_tool' ~/.companion/recordings/SESSION_*.jsonl

# Pretty-print a single entry
sed -n '5p' ~/.companion/recordings/SESSION_*.jsonl | python3 -m json.tool
```

### Enable and disable

Recording is enabled by default. Disable it with:

```bash
COMPANION_RECORD=0 the-companion
```

### Per-session control

Use the REST API to start/stop recording for individual sessions:

```bash
# Check recording status
curl http://localhost:3456/api/sessions/SESSION_ID/recording/status \
  -H "Authorization: Bearer YOUR_TOKEN"

# Stop recording
curl -X POST http://localhost:3456/api/sessions/SESSION_ID/recording/stop \
  -H "Authorization: Bearer YOUR_TOKEN"

# Start recording
curl -X POST http://localhost:3456/api/sessions/SESSION_ID/recording/start \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Rotation

Automatic cleanup triggers when total lines across all recordings exceed 1,000,000 (configurable with `COMPANION_RECORDINGS_MAX_LINES`).
