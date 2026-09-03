#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/dev-environment.sh"
companion_load_repo_env "$REPO_ROOT"
companion_normalize_box_api_key

command_name="${1:-run}"

die() {
  printf '[ios-live] %s\n' "$1" >&2
  exit 1
}

require_live_prerequisites() {
  [ "$(uname -s)" = "Darwin" ] || die "iOS live development requires macOS"
  [ -n "${COMPANION_BOX_API_KEY:-}" ] \
    || die "BOX_API_KEY or COMPANION_BOX_API_KEY is required for the live Box mode"
  [ -n "${COMPANION_IOS_LOCAL_ZAI_API_KEY:-}" ] \
    || die "COMPANION_IOS_LOCAL_ZAI_API_KEY is required to preconfigure z.ai"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required"
}

wait_for_endpoint() {
  local label="$1"
  local url="$2"
  local attempt
  for attempt in $(seq 1 180); do
    if curl --fail --silent "$url" >/dev/null; then
      printf '[ios-live] %s ready: %s\n' "$label" "$url"
      return
    fi
    sleep 2
  done
  die "$label did not become healthy after ${attempt} attempts"
}

run_client() {
  local base_port="${CONDUCTOR_PORT:-3000}"
  case "$base_port" in ''|*[!0-9]*) die "CONDUCTOR_PORT must be numeric" ;; esac
  if [ "$base_port" -lt 1024 ] || [ "$base_port" -gt 65526 ]; then
    die "CONDUCTOR_PORT must be between 1024 and 65526"
  fi

  wait_for_endpoint "API" "http://127.0.0.1:$((base_port + 1))/health"
  wait_for_endpoint "Runtime" "http://127.0.0.1:$((base_port + 7))/healthz"
  bash scripts/dev-process.sh ios-local node scripts/ios-local-live.mjs bootstrap

  local password_label="adminadmin"
  if [ -n "${COMPANION_SEED_PASSWORD:-}" ]; then
    password_label='[COMPANION_SEED_PASSWORD]'
  fi
  printf '\n[ios-live] Login: %s / %s\n' \
    "${COMPANION_SEED_EMAIL:-admin@thevibecompany.co}" \
    "$password_label"
  printf '[ios-live] Create the Companion in the app; no Companion was seeded for you.\n\n'

  exec bash scripts/dev-process.sh web bash apps/ios/scripts/dev-conductor.sh
}

case "$command_name" in
  run)
    require_live_prerequisites
    export COMPANION_COMPANIONS_ENABLED=true
    export COMPANION_DEV_BOX_MODE=live
    if [ -z "${COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS//[[:space:],]/}" ]; then
      export COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=thevibecompany.co
    fi
    # The launcher has already imported the repo environment. Prevent its two
    # children from parsing the file again; dev-process.sh still applies every
    # application-role allowlist before the long-lived services start.
    export COMPANION_DEV_SKIP_ENV_FILE=1

    pnpm exec concurrently \
      --names stack,ios \
      --prefix-colors cyan,magenta \
      --prefix '[{name}]' \
      --kill-others-on-fail \
      --restart-tries 0 \
      'bash scripts/dev-conductor.sh' \
      'bash scripts/dev-ios-live.sh client'
    ;;
  client)
    run_client
    ;;
  archive)
    shift
    exec bash scripts/dev-process.sh ios-local node scripts/ios-local-live.mjs archive "$@"
    ;;
  -h|--help|help)
    printf '%s\n' \
      'Usage:' \
      '  bash scripts/dev-ios-live.sh' \
      '  bash scripts/dev-ios-live.sh archive --companion <exact-name-or-id>'
    ;;
  *)
    die "unknown command: $command_name"
    ;;
esac
