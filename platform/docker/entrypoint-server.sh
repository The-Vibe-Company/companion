#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-3456}"
RUN_AS_USER="${AGENTHANGAR_RUN_AS_USER:-agenthangar}"
PATH="/root/.nvm/default-bin:/root/.bun/bin:${PATH}"
export PATH

echo "[entrypoint] AgentHangar bootstrap on port ${PORT}"

prepare_runtime_dirs() {
  mkdir -p /data /data/agenthangar /data/sessions
}

build_command() {
  if command -v agenthangar >/dev/null 2>&1; then
    echo "agenthangar serve --port ${PORT}"
    return 0
  fi

  if [ -f /tmp/agenthangar-src/web/bin/cli.ts ]; then
    echo "[entrypoint] 'agenthangar' not found on PATH, falling back to local CLI source" >&2
    echo "bun /tmp/agenthangar-src/web/bin/cli.ts serve --port ${PORT}"
    return 0
  fi

  echo "[entrypoint] ERROR: no runnable AgentHangar CLI found" >&2
  return 1
}

prepare_runtime_dirs
CMD="$(build_command)"

echo "[entrypoint] Starting AgentHangar server in foreground (root runtime)"
exec bash -lc "$CMD"
