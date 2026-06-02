---
title: CLI & API Reference
description: Complete reference for CLI commands, environment variables, and REST API endpoints
---

# CLI & API Reference

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

### Options

| Option | Description | Default |
|---|---|---|
| `--port <n>` | Override the server port | `3456` |

### Examples

```bash
# Custom port
the-companion --port 8080

# Custom auth token
COMPANION_AUTH_TOKEN="my-token" the-companion

# Install and run as service
the-companion install && the-companion start && the-companion status

# View logs
the-companion logs
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `COMPANION_AUTH_TOKEN` | Auth token (overrides `~/.companion/auth.json`) | Auto-generated |
| `COMPANION_RECORD` | Set to `0` or `false` to disable protocol recording | `true` |
| `COMPANION_RECORDINGS_DIR` | Override recordings directory | `~/.companion/recordings/` |
| `COMPANION_RECORDINGS_MAX_LINES` | Max total lines before recording rotation | `1,000,000` |
| `COMPANION_INIT_SCRIPT_TIMEOUT` | Init script timeout in seconds | `120` |

## REST API

All endpoints require `Authorization: Bearer YOUR_TOKEN` header.

### Sessions

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/sessions` | List all sessions |
| `POST` | `/api/sessions` | Create a new session |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Archive a session |

### Prompts

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/prompts` | List all prompts (`?cwd=` and `?scope=` filters) |
| `GET` | `/api/prompts/:id` | Get a single prompt |
| `POST` | `/api/prompts` | Create a prompt |
| `PUT` | `/api/prompts/:id` | Update a prompt |
| `DELETE` | `/api/prompts/:id` | Delete a prompt |

### Agents

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/agents` | List all agents |
| `GET` | `/api/agents/:slug` | Get agent details |
| `POST` | `/api/agents` | Create an agent |
| `PUT` | `/api/agents/:slug` | Update an agent |
| `DELETE` | `/api/agents/:slug` | Delete an agent |
| `GET` | `/api/agents/:slug/export` | Export agent as JSON |
| `POST` | `/api/agents/import` | Import an agent from JSON |
| `GET` | `/api/agents/:slug/executions` | Get execution history |
| `POST` | `/api/agents/:slug/webhook/:secret` | Trigger agent via webhook |

### Environments

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/envs` | List all profiles |
| `GET` | `/api/envs/:slug` | Get a single profile |
| `POST` | `/api/envs` | Create a profile |
| `PUT` | `/api/envs/:slug` | Update a profile |
| `DELETE` | `/api/envs/:slug` | Delete a profile |

### Git

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/git/repo-info?path=` | Check if a path is a git repo |
| `GET` | `/git/branches?repoRoot=` | List all branches with metadata |
| `POST` | `/git/fetch` | Run `git fetch --prune` |
| `GET` | `/git/worktrees?repoRoot=` | List all worktrees |
| `POST` | `/git/worktree` | Create or reuse a worktree |
| `DELETE` | `/git/worktree` | Remove a worktree |
| `POST` | `/git/pull` | Run `git pull` |

### Recordings

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/recordings` | List all recording files |
| `GET` | `/api/sessions/:id/recording/status` | Check if a session is recording |
| `POST` | `/api/sessions/:id/recording/start` | Start recording for a session |
| `POST` | `/api/sessions/:id/recording/stop` | Stop recording for a session |
