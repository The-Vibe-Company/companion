#!/usr/bin/env bash

# Shared launcher-only environment handling. This file defines functions and is
# safe to source from lightweight checks without starting any services.

companion_load_repo_env() {
  local repo_root="$1"
  local line key value

  if [ "${COMPANION_DEV_SKIP_ENV_FILE:-0}" = "1" ] || [ ! -f "$repo_root/.env" ]; then
    return
  fi

  # Match the established Conductor dotenv behavior: existing process values
  # win, empty assignments are ignored, and simple matching quotes are removed.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    [ -n "$value" ] || continue
    if [ -z "${!key:-}" ]; then
      case "$value" in
        \"*\") value="${value%\"}"; value="${value#\"}" ;;
        \'*\') value="${value%\'}"; value="${value#\'}" ;;
      esac
      export "$key=$value"
    fi
  done < "$repo_root/.env"
}
