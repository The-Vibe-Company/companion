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

## Voice Input (Speech-to-Text)

The chat input bar includes a 🎤 microphone button for offline speech-to-text powered by [Transformers.js v3](https://huggingface.co/docs/transformers.js) (via Transformers.js ONNX/WASM). No server, no Python, no native binaries — everything runs in the browser.

- **First use**: the model is downloaded from HuggingFace (~40 MB for the default) and cached in IndexedDB. Subsequent uses are fully offline.
- **Push-to-talk**: click the mic to start recording, click again to transcribe. Transcribed text is appended to the input field.

### Model configuration

Override the default model via the `VITE_STT_MODEL` environment variable:

| Model | Size | Speed (CPU/WASM) | Accuracy |
|---|---|---|---|
| `onnx-community/whisper-tiny` *(default)* | ~38 MB | Fast (~3–5s) | Good — multilingual |
| `onnx-community/whisper-tiny.en` | ~38 MB | Fast (~3–5s) | Good — English only |
| `onnx-community/whisper-base` | ~74 MB | Medium (~8s) | Better — multilingual |
| `onnx-community/whisper-base.en` | ~74 MB | Medium (~8s) | Better — English only |
| `onnx-community/whisper-small` | ~240 MB | Slow (~20s+) | Best — multilingual |

```bash
# Example: use base model
VITE_STT_MODEL=onnx-community/whisper-base.en bun run dev
```

> **Note:** The server sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers to enable `SharedArrayBuffer` for WASM threading. If these headers conflict with other resources in your deployment, you can remove them — Transformers.js will fall back to single-threaded WASM (slower but functional).

## Docs
- Protocol reverse engineering: [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md)
- Contributor and architecture guide: [`CLAUDE.md`](CLAUDE.md)

## License
MIT
