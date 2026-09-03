#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/dev-runtime-mode.sh"

cd "$REPO_ROOT"

log() {
  printf '[dev] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[dev] Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

load_env_file() {
  local file="$1"
  local line key value

  if [ ! -f "$file" ]; then
    return
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*)
        continue
        ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    if [ "$key" = "$line" ] || ! printf '%s' "$key" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
      continue
    fi

    if [ -z "${!key+x}" ]; then
      case "$value" in
        \"*\") value="${value%\"}"; value="${value#\"}" ;;
        \'*\') value="${value%\'}"; value="${value#\'}" ;;
      esac
      export "$key=$value"
    fi
  done < "$file"
}

port_from_url() {
  local url="$1"
  local fallback="$2"
  local without_scheme host_port port

  without_scheme="${url#*://}"
  host_port="${without_scheme%%/*}"
  port="${host_port##*:}"
  if [ "$port" != "$host_port" ] && printf '%s' "$port" | grep -Eq '^[0-9]+$'; then
    printf '%s' "$port"
  else
    printf '%s' "$fallback"
  fi
}

sanitize_project_name() {
  local raw="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$REPO_ROOT")}"
  local cleaned

  cleaned="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
  if [ -z "$cleaned" ]; then
    cleaned="workspace"
  fi
  if ! printf '%s' "$cleaned" | grep -Eq '^[a-z0-9]'; then
    cleaned="w-${cleaned}"
  fi

  printf 'companion-%s' "$cleaned"
}

port_at() {
  local base_port="$1"
  local offset="$2"

  printf '%s' "$((base_port + offset))"
}

configure_conductor_env() {
  local base_port="$CONDUCTOR_PORT"

  if ! printf '%s' "$base_port" | grep -Eq '^[0-9]+$'; then
    printf '[dev] CONDUCTOR_PORT must be numeric, got: %s\n' "$base_port" >&2
    exit 1
  fi

  WEB_PORT="$(port_at "$base_port" 0)"
  API_PORT="$(port_at "$base_port" 1)"
  RUNTIME_PORT="$(port_at "$base_port" 7)"
  BOX_SIM_PORT="$(port_at "$base_port" 8)"

  COMPOSE_PROJECT_NAME="$(sanitize_project_name)"
  export COMPOSE_PROJECT_NAME
  export COMPOSE_BIND_HOST="127.0.0.1"
  export COMPANION_WEB_PORT="$WEB_PORT"
  export COMPANION_WEB_HOST="127.0.0.1"
  export COMPANION_API_PORT="$API_PORT"
  export COMPANION_API_HOST="127.0.0.1"
  export COMPANION_RUNTIME_PORT="$RUNTIME_PORT"
  export COMPANION_RUNTIME_HOST="127.0.0.1"
  export COMPANION_BOX_SIM_PORT="$BOX_SIM_PORT"
  POSTGRES_PORT="$(port_at "$base_port" 2)"
  MINIO_PORT="$(port_at "$base_port" 3)"
  MINIO_CONSOLE_PORT="$(port_at "$base_port" 4)"
  MAILPIT_SMTP_PORT="$(port_at "$base_port" 5)"
  MAILPIT_WEB_PORT="$(port_at "$base_port" 6)"
  export POSTGRES_PORT MINIO_PORT MINIO_CONSOLE_PORT MAILPIT_SMTP_PORT MAILPIT_WEB_PORT

  export DATABASE_MIGRATION_URL="postgres://companion:companion@127.0.0.1:${POSTGRES_PORT}/companion"
  export DATABASE_URL="postgres://companion_api:companion-api@127.0.0.1:${POSTGRES_PORT}/companion"
  export DATABASE_WORKER_URL="postgres://companion_worker:companion-worker@127.0.0.1:${POSTGRES_PORT}/companion"
  export DATABASE_COMPANION_RUNTIME_URL="postgres://companion_runtime_v2:companion-runtime-v2@127.0.0.1:${POSTGRES_PORT}/companion"
  export DATABASE_API_ROLE=companion_api
  export DATABASE_WORKER_ROLE=companion_worker
  export DATABASE_COMPANION_RUNTIME_ROLE=companion_runtime_v2
  USE_LOCAL_RUNTIME_DB_ROLES=1
  export COMPANION_API_URL="http://${COMPANION_API_HOST}:${API_PORT}"
  export COMPANION_WEB_URL="http://${COMPANION_WEB_HOST}:${WEB_PORT}"
  export COMPANION_RUNTIME_PRIVATE_URL="http://${COMPANION_RUNTIME_HOST}:${RUNTIME_PORT}"
  export NEXT_PUBLIC_COMPANION_API_URL="$COMPANION_API_URL"
  export BETTER_AUTH_URL="$COMPANION_API_URL"
  export BETTER_AUTH_COOKIE_PREFIX="$COMPOSE_PROJECT_NAME"

  export S3_ENDPOINT="http://127.0.0.1:${MINIO_PORT}"
  export S3_REGION="${S3_REGION:-us-east-1}"
  export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-companion}"
  export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-companion-secret}"
  export S3_BUCKET_SKILL_ARCHIVES="${S3_BUCKET_SKILL_ARCHIVES:-skill-archives}"
  export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
  # Local demo content includes hosted database declarations. Keep production's default-off flag,
  # but enable the feature for local development unless the developer explicitly opted out.
  export COMPANION_SKILL_DATABASES_ENABLED="${COMPANION_SKILL_DATABASES_ENABLED:-true}"

  export EMAIL_PROVIDER="${EMAIL_PROVIDER:-mailpit}"
  export EMAIL_FROM="${EMAIL_FROM:-Companion <noreply@companion.local>}"
  export MAILPIT_SMTP_HOST="${MAILPIT_SMTP_HOST:-127.0.0.1}"
}

configure_local_env() {
  local database_url_explicit="${DATABASE_URL+x}"
  local database_worker_url_explicit="${DATABASE_WORKER_URL+x}"
  local database_runtime_url_explicit="${DATABASE_COMPANION_RUNTIME_URL+x}"
  local database_migration_url_explicit="${DATABASE_MIGRATION_URL+x}"
  local companion_api_url_explicit="${COMPANION_API_URL+x}"
  local companion_web_url_explicit="${COMPANION_WEB_URL+x}"
  local companion_runtime_url_explicit="${COMPANION_RUNTIME_PRIVATE_URL+x}"
  local next_public_api_url_explicit="${NEXT_PUBLIC_COMPANION_API_URL+x}"
  local better_auth_url_explicit="${BETTER_AUTH_URL+x}"
  local s3_endpoint_explicit="${S3_ENDPOINT+x}"

  if [ -n "${CONDUCTOR_PORT:-}" ]; then
    configure_conductor_env
    return
  fi

  if [ "${COMPANION_DEV_SKIP_ENV_FILE:-0}" != "1" ]; then
    load_env_file "$REPO_ROOT/.env"
  fi

  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-companion-main}"
  export COMPOSE_BIND_HOST="${COMPOSE_BIND_HOST:-127.0.0.1}"

  WEB_PORT="${COMPANION_WEB_PORT:-$(port_from_url "${COMPANION_WEB_URL:-}" 3000)}"
  API_PORT="${COMPANION_API_PORT:-$(port_from_url "${COMPANION_API_URL:-}" 3001)}"
  RUNTIME_PORT="${COMPANION_RUNTIME_PORT:-$(port_from_url "${COMPANION_RUNTIME_PRIVATE_URL:-}" 3007)}"
  BOX_SIM_PORT="${COMPANION_BOX_SIM_PORT:-3008}"
  export COMPANION_WEB_PORT="$WEB_PORT"
  export COMPANION_WEB_HOST="${COMPANION_WEB_HOST:-127.0.0.1}"
  export COMPANION_API_HOST="${COMPANION_API_HOST:-127.0.0.1}"
  export COMPANION_RUNTIME_PORT="$RUNTIME_PORT"
  export COMPANION_RUNTIME_HOST="${COMPANION_RUNTIME_HOST:-127.0.0.1}"
  export COMPANION_BOX_SIM_PORT="$BOX_SIM_PORT"
  export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
  export MINIO_PORT="${MINIO_PORT:-9000}"
  export MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"
  export MAILPIT_SMTP_PORT="${MAILPIT_SMTP_PORT:-1025}"
  export MAILPIT_WEB_PORT="${MAILPIT_WEB_PORT:-8025}"

  if should_use_derived_value "$database_url_explicit" "${DATABASE_URL+x}" "${DATABASE_URL:-}" "postgres://companion_api:companion-api@127.0.0.1:5432/companion" \
    || [ "${DATABASE_URL:-}" = "postgres://companion_runtime:companion-runtime@127.0.0.1:5432/companion" ] \
    || [ "${DATABASE_URL:-}" = "postgres://companion:companion@127.0.0.1:5432/companion" ]; then
    export DATABASE_URL="postgres://companion_api:companion-api@127.0.0.1:${POSTGRES_PORT}/companion"
    if should_use_derived_value "$database_worker_url_explicit" "${DATABASE_WORKER_URL+x}" "${DATABASE_WORKER_URL:-}" "postgres://companion_worker:companion-worker@127.0.0.1:5432/companion" \
      || [ "${DATABASE_WORKER_URL:-}" = "postgres://companion_runtime:companion-runtime@127.0.0.1:5432/companion" ] \
      || [ "${DATABASE_WORKER_URL:-}" = "postgres://companion:companion@127.0.0.1:5432/companion" ]; then
      export DATABASE_WORKER_URL="postgres://companion_worker:companion-worker@127.0.0.1:${POSTGRES_PORT}/companion"
    fi
    if should_use_derived_value "$database_runtime_url_explicit" "${DATABASE_COMPANION_RUNTIME_URL+x}" "${DATABASE_COMPANION_RUNTIME_URL:-}" "postgres://companion_runtime_v2:companion-runtime-v2@127.0.0.1:5432/companion" \
      || [ "${DATABASE_COMPANION_RUNTIME_URL:-}" = "postgres://companion_runtime:companion-runtime@127.0.0.1:5432/companion" ] \
      || [ "${DATABASE_COMPANION_RUNTIME_URL:-}" = "postgres://companion:companion@127.0.0.1:5432/companion" ]; then
      export DATABASE_COMPANION_RUNTIME_URL="postgres://companion_runtime_v2:companion-runtime-v2@127.0.0.1:${POSTGRES_PORT}/companion"
    fi
    export DATABASE_API_ROLE=companion_api
    export DATABASE_WORKER_ROLE=companion_worker
    export DATABASE_COMPANION_RUNTIME_ROLE=companion_runtime_v2
    USE_LOCAL_RUNTIME_DB_ROLES=1
    if should_use_derived_value "$database_migration_url_explicit" "${DATABASE_MIGRATION_URL+x}" "${DATABASE_MIGRATION_URL:-}" "postgres://companion:companion@127.0.0.1:5432/companion"; then
      export DATABASE_MIGRATION_URL="postgres://companion:companion@127.0.0.1:${POSTGRES_PORT}/companion"
    fi
  fi
  export DATABASE_WORKER_URL="${DATABASE_WORKER_URL:-$DATABASE_URL}"
  export COMPANION_API_PORT="$API_PORT"
  if should_use_derived_value "$companion_api_url_explicit" "${COMPANION_API_URL+x}" "${COMPANION_API_URL:-}" "http://127.0.0.1:3001"; then
    export COMPANION_API_URL="http://${COMPANION_API_HOST}:${API_PORT}"
  fi
  if should_use_derived_value "$companion_web_url_explicit" "${COMPANION_WEB_URL+x}" "${COMPANION_WEB_URL:-}" "http://127.0.0.1:3000"; then
    export COMPANION_WEB_URL="http://${COMPANION_WEB_HOST}:${WEB_PORT}"
  fi
  if should_use_derived_value "$companion_runtime_url_explicit" "${COMPANION_RUNTIME_PRIVATE_URL+x}" "${COMPANION_RUNTIME_PRIVATE_URL:-}" "http://127.0.0.1:3007"; then
    export COMPANION_RUNTIME_PRIVATE_URL="http://${COMPANION_RUNTIME_HOST}:${RUNTIME_PORT}"
  fi
  if should_use_derived_value "$next_public_api_url_explicit" "${NEXT_PUBLIC_COMPANION_API_URL+x}" "${NEXT_PUBLIC_COMPANION_API_URL:-}" "http://127.0.0.1:3001"; then
    export NEXT_PUBLIC_COMPANION_API_URL="$COMPANION_API_URL"
  fi
  if should_use_derived_value "$better_auth_url_explicit" "${BETTER_AUTH_URL+x}" "${BETTER_AUTH_URL:-}" "http://127.0.0.1:3001"; then
    export BETTER_AUTH_URL="$COMPANION_API_URL"
  fi
  export BETTER_AUTH_COOKIE_PREFIX="${BETTER_AUTH_COOKIE_PREFIX:-better-auth}"

  if should_use_derived_value "$s3_endpoint_explicit" "${S3_ENDPOINT+x}" "${S3_ENDPOINT:-}" "http://127.0.0.1:9000"; then
    export S3_ENDPOINT="http://127.0.0.1:${MINIO_PORT}"
  fi
  export S3_REGION="${S3_REGION:-us-east-1}"
  export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-companion}"
  export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-companion-secret}"
  export S3_BUCKET_SKILL_ARCHIVES="${S3_BUCKET_SKILL_ARCHIVES:-skill-archives}"
  export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
  # Local demo content includes hosted database declarations. Keep production's default-off flag,
  # but enable the feature for local development unless the developer explicitly opted out.
  export COMPANION_SKILL_DATABASES_ENABLED="${COMPANION_SKILL_DATABASES_ENABLED:-true}"

  export EMAIL_PROVIDER="${EMAIL_PROVIDER:-mailpit}"
  export EMAIL_FROM="${EMAIL_FROM:-Companion <noreply@companion.local>}"
  export MAILPIT_SMTP_HOST="${MAILPIT_SMTP_HOST:-127.0.0.1}"
}

ensure_local_secrets_master_key() {
  local state_dir="$REPO_ROOT/.companion-local"
  local key_file="$state_dir/secrets-master-key"
  if [ -n "${COMPANION_SECRETS_MASTER_KEY:-}" ]; then
    return
  fi
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  if [ ! -s "$key_file" ]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" >"$key_file"
  fi
  chmod 600 "$key_file"
  COMPANION_SECRETS_MASTER_KEY="$(cat "$key_file")"
  export COMPANION_SECRETS_MASTER_KEY
}

ensure_local_runtime_hmac_key() {
  local state_dir="$REPO_ROOT/.companion-local"
  local key_file="$state_dir/runtime-desktop-hmac-key"
  if [ -n "${COMPANION_RUNTIME_DESKTOP_HMAC_SECRET:-}" ]; then
    return
  fi
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  if [ ! -s "$key_file" ]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" >"$key_file"
  fi
  chmod 600 "$key_file"
  COMPANION_RUNTIME_DESKTOP_HMAC_SECRET="$(cat "$key_file")"
  export COMPANION_RUNTIME_DESKTOP_HMAC_SECRET
}

should_use_derived_value() {
  local was_explicit="$1"
  local is_set="$2"
  local current="$3"
  local default_value="$4"

  [ -z "$was_explicit" ] && { [ -z "$is_set" ] || [ "$current" = "$default_value" ]; }
}

ensure_tooling() {
  require_command node
  require_command corepack
  require_command docker

  corepack enable
  require_command pnpm
}

is_repo_pid() {
  local pid="$1"
  local cwd

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  case "$cwd" in
    "$REPO_ROOT"|"$REPO_ROOT"/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

repo_stop_target_for_pid() {
  local pid="$1"
  local pgid
  local current_pgid

  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  current_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "$pgid" ] && [ "$pgid" != "$current_pgid" ] && is_dev_process_group "$pgid"; then
    printf -- '-%s\n' "$pgid"
  else
    printf '%s\n' "$pid"
  fi
}

is_dev_process_group() {
  local pgid="$1"
  local command

  command="$(ps -o command= -p "$pgid" 2>/dev/null || true)"
  case "$command" in
    *"pnpm"*"dev:app"*|*"pnpm"*"dev"*|*"concurrently"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

stop_port_listeners() {
  local port="$1"
  local host="$2"
  local pids
  local repo_pids=""
  local foreign_pids=""
  local -a repo_pid_array

  if ! command -v lsof >/dev/null 2>&1; then
    log "lsof is unavailable; skipping cleanup for port ${port}"
    return
  fi

  pids="$(listener_pids_for_port "$port" "$host")"
  if [ -z "$pids" ]; then
    return
  fi

  for pid in $pids; do
    if is_repo_pid "$pid"; then
      repo_pids="${repo_pids} $(repo_stop_target_for_pid "$pid" | tr '\n' ' ')"
    else
      foreign_pids="${foreign_pids} ${pid}"
    fi
  done

  if [ -n "$foreign_pids" ]; then
    log "Port ${port} is already used by non-repo process(es):${foreign_pids}"
    log "Stop those process(es) or override the corresponding local port."
    exit 1
  fi

  repo_pids="$(printf '%s' "$repo_pids" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')"
  read -r -a repo_pid_array <<< "$repo_pids"
  log "Stopping existing repo process group for port ${port}: ${repo_pids}"
  kill -TERM -- "${repo_pid_array[@]}" 2>/dev/null || true

  for _ in $(seq 1 20); do
    sleep 0.1
    pids="$(listener_pids_for_port "$port" "$host")"
    if [ -z "$pids" ]; then
      return
    fi
  done

  repo_pids=""
  foreign_pids=""
  for pid in $pids; do
    if is_repo_pid "$pid"; then
      repo_pids="${repo_pids} $(repo_stop_target_for_pid "$pid" | tr '\n' ' ')"
    else
      foreign_pids="${foreign_pids} ${pid}"
    fi
  done

  if [ -n "$foreign_pids" ]; then
    log "Port ${port} is still used by non-repo process(es):${foreign_pids}"
    log "Stop those process(es) or override the corresponding local port."
    exit 1
  fi

  repo_pids="$(printf '%s' "$repo_pids" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')"
  read -r -a repo_pid_array <<< "$repo_pids"
  log "Force stopping repo process group still listening on port ${port}: ${repo_pids}"
  kill -KILL -- "${repo_pid_array[@]}" 2>/dev/null || true

  sleep 0.1
  pids="$(listener_pids_for_port "$port" "$host")"
  if [ -n "$pids" ]; then
    log "Port ${port} is still in use after cleanup: ${pids}"
    exit 1
  fi
}

listener_pids_for_port() {
  local port="$1"
  local host="$2"

  if [ "$host" = "127.0.0.1" ] || [ "$host" = "localhost" ]; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null \
      | awk -v port=":${port}" 'NR > 1 { endpoint = $(NF - 1) } endpoint == "*" port || endpoint == "127.0.0.1" port { print $2 }' \
      | sort -u || true
    return
  fi

  if [ "$host" = "0.0.0.0" ] || [ "$host" = "::" ]; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true
    return
  fi

  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null \
    | awk -v port=":${port}" -v host="$host" 'NR > 1 { endpoint = $(NF - 1) } endpoint == "*" port || endpoint == host port { print $2 }' \
    | sort -u || true
}

assert_no_foreign_published_port() {
  local port="$1"
  local project_names
  local foreign_names

  project_names="$(
    docker ps \
      --filter "publish=${port}" \
      --format '{{.Label "com.docker.compose.project"}}' \
      | sort -u || true
  )"
  foreign_names="$(
    docker ps \
      --filter "publish=${port}" \
      --format '{{.Names}} {{.Label "com.docker.compose.project"}}' \
      | awk -v project="$COMPOSE_PROJECT_NAME" '$2 != project { print $1 }' \
      | sort -u \
      | tr '\n' ' ' || true
  )"
  if [ -n "$foreign_names" ]; then
    log "Port ${port} is already published by Docker container(s): ${foreign_names}"
    log "Stop those container(s) or override the corresponding local port."
    exit 1
  fi

  if printf '%s\n' "$project_names" | grep -Fxq "$COMPOSE_PROJECT_NAME"; then
    return
  fi

  assert_no_foreign_tcp_listener "$port"
}

assert_no_foreign_tcp_listener() {
  local port="$1"
  local pids

  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  if [ -n "$pids" ]; then
    log "Port ${port} is already used by process(es): ${pids}"
    log "Stop those process(es) or override the corresponding local port."
    exit 1
  fi
}

assert_infra_ports_available() {
  assert_no_foreign_published_port "$POSTGRES_PORT"
  assert_no_foreign_published_port "$MINIO_PORT"
  assert_no_foreign_published_port "$MINIO_CONSOLE_PORT"
  assert_no_foreign_published_port "$MAILPIT_SMTP_PORT"
  assert_no_foreign_published_port "$MAILPIT_WEB_PORT"
}

print_urls() {
  log "Compose project: ${COMPOSE_PROJECT_NAME}"
  log "Web: ${COMPANION_WEB_URL}"
  log "API: ${COMPANION_API_URL}"
  log "Runtime health (private): ${COMPANION_RUNTIME_PRIVATE_URL}/healthz"
  log "Postgres: 127.0.0.1:${POSTGRES_PORT}"
  log "MinIO console: http://127.0.0.1:${MINIO_CONSOLE_PORT}"
  log "Mailpit: http://127.0.0.1:${MAILPIT_WEB_PORT}"
}

start_infra() {
  if [ -n "${CONDUCTOR_PORT:-}" ]; then
    log "Restarting Conductor Postgres, MinIO, and Mailpit"
    docker compose -p "$COMPOSE_PROJECT_NAME" down --remove-orphans
  else
    log "Starting local Postgres, MinIO, and Mailpit"
    assert_infra_ports_available
  fi

  docker compose -p "$COMPOSE_PROJECT_NAME" up -d --wait postgres minio mailpit
  docker compose -p "$COMPOSE_PROJECT_NAME" up -d minio-init
}

configure_local_runtime_db_roles() {
  [ "${USE_LOCAL_RUNTIME_DB_ROLES:-0}" = "1" ] || return 0
  log "Configuring separate NOBYPASSRLS API, worker, and runtime database roles"
  docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U companion -d companion \
      -v api_role="${DATABASE_API_ROLE:-companion_api}" -v api_password=companion-api \
      -v worker_role="${DATABASE_WORKER_ROLE:-companion_worker}" -v worker_password=companion-worker \
      -v runtime_role="${DATABASE_COMPANION_RUNTIME_ROLE:-companion_runtime_v2}" \
      -v runtime_password=companion-runtime-v2 \
      -f - < "$REPO_ROOT/scripts/disposable-db-roles.sql" >/dev/null

  # Older local installs used one union login for API, worker, and runtime. Stop new connections
  # before the grants preflight, fail if any old process is still attached, then hand the exact
  # role name to the two-phase runner so it can revoke every direct/default ACL atomically.
  if docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
    psql -At -U companion -d companion -c \
      "select 1 from pg_roles where rolname = 'companion_runtime'" | grep -qx 1; then
    docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U companion -d companion -c \
        "ALTER ROLE companion_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;" >/dev/null
    if docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
      psql -At -U companion -d companion -c \
        "select 1 from pg_stat_activity where usename = 'companion_runtime' limit 1" \
        | grep -qx 1; then
      log "Retired local role companion_runtime still has an active session; stop the old API/worker and retry."
      exit 1
    fi
    export DATABASE_RETIRED_RUNTIME_ROLE=companion_runtime
  fi
}

enable_local_runtime_gate() {
  [ "${COMPANION_COMPANIONS_ENABLED:-}" = "true" ] || return 0
  [ -n "${COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS//[[:space:],]/}" ] || return 0
  local gate_epoch
  if ! docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
    psql -At -U companion -d companion -c \
      "select 1 where to_regprocedure('public.companion_runtime_enable(bigint,text)') is not null" \
      | grep -qx 1; then
    return 0
  fi
  gate_epoch="$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
    psql -At -U companion -d companion -c \
      "select gate_epoch from public.companion_runtime_control where id = 'runtime-v3'")"
  case "$gate_epoch" in
    ''|*[!0-9]*)
      log "Runtime v3 gate returned an invalid epoch: '$gate_epoch'"
      exit 1
      ;;
  esac
  docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U companion -d companion -c \
      "select * from public.companion_runtime_enable(${gate_epoch}::bigint, 'dev-stack');" \
    >/dev/null
  log "Runtime v3 gate enabled for local development"
}

run_dev() {
  configure_local_env
  ensure_tooling
  ensure_local_secrets_master_key
  ensure_local_runtime_hmac_key
  print_urls

  stop_port_listeners "$WEB_PORT" "$COMPANION_WEB_HOST"
  stop_port_listeners "$API_PORT" "$COMPANION_API_HOST"
  stop_port_listeners "$RUNTIME_PORT" "$COMPANION_RUNTIME_HOST"
  if companion_dev_uses_box_simulator || companion_dev_uses_box_lab; then
    stop_port_listeners "$BOX_SIM_PORT" "127.0.0.1"
  fi
  start_infra
  configure_local_runtime_db_roles

  log "Applying Drizzle migrations"
  bash scripts/dev-process.sh migration pnpm db:migrate
  enable_local_runtime_gate

  log "Seeding local test user"
  bash scripts/dev-process.sh api-seed pnpm --filter @companion/api seed:test-user
  if [ -n "${COMPANION_SEED_PASSWORD:-}" ]; then
    log "Local test user: ${COMPANION_SEED_EMAIL:-admin@thevibecompany.co} / [COMPANION_SEED_PASSWORD]"
  else
    log "Local development credentials: ${COMPANION_SEED_EMAIL:-admin@thevibecompany.co} / adminadmin"
  fi
  log "Existing local users keep their current password."

  log "Starting API, worker, runtime, and web"
  pnpm run dev:app
}

print_env() {
  configure_local_env
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT_NAME"
  printf 'DATABASE_URL=%s\n' "$DATABASE_URL"
  printf 'DATABASE_WORKER_URL=%s\n' "$DATABASE_WORKER_URL"
  printf 'DATABASE_COMPANION_RUNTIME_URL=%s\n' "${DATABASE_COMPANION_RUNTIME_URL:-}"
  printf 'COMPANION_API_URL=%s\n' "$COMPANION_API_URL"
  printf 'COMPANION_WEB_URL=%s\n' "$COMPANION_WEB_URL"
  printf 'COMPANION_RUNTIME_PRIVATE_URL=%s\n' "$COMPANION_RUNTIME_PRIVATE_URL"
  printf 'NEXT_PUBLIC_COMPANION_API_URL=%s\n' "$NEXT_PUBLIC_COMPANION_API_URL"
  printf 'BETTER_AUTH_URL=%s\n' "$BETTER_AUTH_URL"
  printf 'S3_ENDPOINT=%s\n' "$S3_ENDPOINT"
  printf 'COMPANION_SKILL_DATABASES_ENABLED=%s\n' "$COMPANION_SKILL_DATABASES_ENABLED"
  printf 'POSTGRES_PORT=%s\n' "$POSTGRES_PORT"
  printf 'MINIO_PORT=%s\n' "$MINIO_PORT"
  printf 'MINIO_CONSOLE_PORT=%s\n' "$MINIO_CONSOLE_PORT"
  printf 'MAILPIT_SMTP_PORT=%s\n' "$MAILPIT_SMTP_PORT"
  printf 'MAILPIT_WEB_PORT=%s\n' "$MAILPIT_WEB_PORT"
  printf 'COMPANION_RUNTIME_PORT=%s\n' "$RUNTIME_PORT"
  printf 'COMPANION_BOX_SIM_PORT=%s\n' "$BOX_SIM_PORT"
}

case "${1:-run}" in
  run)
    run_dev
    ;;
  print-env)
    print_env
    ;;
  *)
    printf 'Usage: %s [run|print-env]\n' "$0" >&2
    exit 64
    ;;
esac
