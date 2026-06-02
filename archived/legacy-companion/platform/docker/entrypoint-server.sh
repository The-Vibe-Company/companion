#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-3456}"
RUN_AS_USER="${COMPANION_RUN_AS_USER:-companion}"
PATH="/root/.nvm/default-bin:/root/.bun/bin:${PATH}"
export PATH

echo "[entrypoint] Companion bootstrap on port ${PORT}"

prepare_runtime_dirs() {
  mkdir -p /data /data/companion /data/sessions
}

build_command() {
  if command -v the-companion >/dev/null 2>&1; then
    echo "the-companion serve --port ${PORT}"
    return 0
  fi

  if [ -f /tmp/the-companion-src/web/bin/cli.ts ]; then
    echo "[entrypoint] 'the-companion' not found on PATH, falling back to local CLI source" >&2
    echo "bun /tmp/the-companion-src/web/bin/cli.ts serve --port ${PORT}"
    return 0
  fi

  echo "[entrypoint] ERROR: no runnable Companion CLI found" >&2
  return 1
}

prepare_runtime_dirs
CMD="$(build_command)"

echo "[entrypoint] Starting Companion server in foreground (root runtime)"
exec bash -lc "$CMD"
