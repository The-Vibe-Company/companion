#!/usr/bin/env bash
# =============================================================================
# scripts/dev-conductor.sh — Conductor dev launcher for Companion, WITHOUT
# Docker. Runs Postgres + MinIO + Mailpit as native per-workspace services and
# launches API, worker, runtime, and web via concurrently. Local workspaces derive every
# port from the Conductor port range (CONDUCTOR_PORT + offset); isolated cloud
# workspaces use the fixed fallback range starting at 3000. All state lives in
# .conductor-pg/ and is torn down by `archive`.
#
# Modeled on ~/Dev/monkapps/scripts/dev-conductor.sh.
#
# Usage:
#   bash scripts/dev-conductor.sh                 # run the full stack
#   bash scripts/dev-conductor.sh archive         # stop services + rm .conductor-pg/
#   bash scripts/dev-conductor.sh --reset-db      # purge .conductor-pg/ then run
#   bash scripts/dev-conductor.sh --base 13000    # override CONDUCTOR_PORT
#
# Port allocation (BASE = CONDUCTOR_PORT locally, fixed fallback 3000 in cloud):
#   +0  web (Next.js)            ← Conductor's "Run" opens this
#   +1  api (Hono)
#   +2  Postgres (native cluster)
#   +3  MinIO S3 API
#   +4  MinIO console
#   +5  Mailpit SMTP
#   +6  Mailpit web UI
#   +7  Companion runtime (private)
#   +8  Box/Pi simulator or opt-in Linux Box Lab
#   +9  reserved
# =============================================================================

set -euo pipefail

# Conductor is a GUI application on macOS and its Run processes can inherit
# launchd's low soft limit (often 256). Next.js/Watchpack needs substantially
# more descriptors to watch this monorepo reliably.
if [ "${CONDUCTOR_IS_LOCAL:-0}" = "1" ]; then
  ulimit -S -n 65536
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/dev-environment.sh"

# Load the repo-root .env (if present) so GitHub, storage, email and skill-secret settings reach the
# child processes without depending on the launcher's environment. Per-process
# wrappers remove credentials outside each process's trust boundary. Dotenv semantics: never overrides variables
# already in the environment, and skips empty assignments (a copied .env.example full of empty
# values must not nuke exported shell vars).
companion_load_repo_env "$REPO_ROOT"

# ascii.dev calls this credential BOX_API_KEY in its own tooling. Accept that
# spelling only at the local launcher boundary, normalize it to Companion's
# runtime-only name, then remove the broad alias before any child is spawned.
# The canonical name wins when both are present.
companion_normalize_box_api_key
cd "$REPO_ROOT"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/dev-runtime-mode.sh"

# ---------------------------------------------------------------------------
# Colours & logging
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'
  CYAN=$'\033[36m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; DIM=''; RESET=''
fi

step() { printf '\n%s%s==> %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"; }
info() { printf '  %s%s%s\n' "$CYAN" "$1" "$RESET"; }
ok()   { printf '  %s[OK]%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s[WARN]%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
die()  { printf '  %s[ERROR]%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
COMMAND="run"
RESET_DB=false
BASE_OVERRIDE=""

usage() {
  cat <<EOF
${BOLD}dev-conductor.sh${RESET} — Companion Conductor dev stack, native (no Docker).

Usage: bash scripts/dev-conductor.sh [command] [options]

Commands:
  run               Start Postgres/MinIO/Mailpit + API + worker + runtime + web (default)
  archive           Stop native services and remove .conductor-pg/

Options:
  --reset-db        Purge .conductor-pg/ and re-init before running
  --base N          Override CONDUCTOR_PORT (e.g. --base 13000)
  -h, --help        Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    run|archive)  COMMAND="$1";       shift ;;
    --reset-db)   RESET_DB=true;       shift ;;
    --base)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then
        die "--base requires a numeric value (e.g. --base 13000)"
      fi
      BASE_OVERRIDE="$2"; shift 2 ;;
    --base=*)
      BASE_OVERRIDE="${1#--base=}"
      if [ -z "$BASE_OVERRIDE" ]; then
        die "--base= requires a numeric value (e.g. --base=13000)"
      fi
      shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "Unknown argument: $1 (--help for usage)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve environment, BASE port + derive the workspace port range
# ---------------------------------------------------------------------------
CONDUCTOR_IS_CLOUD=false
if [ "${CONDUCTOR_IS_LOCAL:-}" = "0" ]; then
  CONDUCTOR_IS_CLOUD=true
fi

if [ "$CONDUCTOR_IS_CLOUD" = true ]; then
  LSOF_INSTALL_HINT="sudo dnf install -y lsof"
  POSTGRES_INSTALL_HINT="sudo dnf install -y postgresql17 postgresql17-server"
  MINIO_MISSING_MESSAGE="minio not installed in this cloud setup — S3 storage disabled (skill uploads/downloads will fail)"
  MAILPIT_MISSING_MESSAGE="mailpit not installed in this cloud setup — email falls back to console log (EMAIL_PROVIDER=log)"
  MINIO_DISABLED_MESSAGE="disabled in this cloud setup — S3 uploads unavailable"
  MAILPIT_DISABLED_MESSAGE="console log (Mailpit not installed in this cloud setup)"
else
  LSOF_INSTALL_HINT="brew install lsof"
  POSTGRES_INSTALL_HINT="brew install postgresql@17"
  MINIO_MISSING_MESSAGE="minio not installed — S3 storage disabled (skill uploads/downloads will fail). brew install minio"
  MAILPIT_MISSING_MESSAGE="mailpit not installed — email falls back to console log (EMAIL_PROVIDER=log). brew install mailpit"
  MINIO_DISABLED_MESSAGE="disabled (brew install minio) — S3 uploads unavailable"
  MAILPIT_DISABLED_MESSAGE="console log (brew install mailpit for a mailbox)"
fi

if [ -n "$BASE_OVERRIDE" ]; then
  BASE="$BASE_OVERRIDE"
elif [ -n "${CONDUCTOR_PORT:-}" ]; then
  BASE="$CONDUCTOR_PORT"
else
  if [ "$CONDUCTOR_IS_CLOUD" = false ]; then
    warn "CONDUCTOR_PORT absent — fallback BASE=3000 (workspace not isolated by port)"
  fi
  BASE=3000
fi

case "$BASE" in
  ''|*[!0-9]*) die "BASE port must be numeric, got: '$BASE'" ;;
esac
# We use a 10-port window [BASE..BASE+9].
#   BASE >= 1024  : avoid privileged ports (need root)
#   BASE+9 <= 65535 : stay within the valid TCP range
if [ "$BASE" -lt 1024 ]; then
  die "BASE port invalid: $BASE — use BASE >= 1024 (ports < 1024 need root)"
fi
if [ $((BASE + 9)) -gt 65535 ]; then
  die "BASE port invalid: $BASE — BASE+9 exceeds 65535. Use BASE <= 65526"
fi

WEB_PORT=$((BASE + 0))
API_PORT=$((BASE + 1))
PG_PORT=$((BASE + 2))
MINIO_API_PORT=$((BASE + 3))
MINIO_CONSOLE_PORT=$((BASE + 4))
MAILPIT_SMTP_PORT=$((BASE + 5))
MAILPIT_UI_PORT=$((BASE + 6))
RUNTIME_PORT=$((BASE + 7))
BOX_SIM_PORT=$((BASE + 8))

# Only the web process is reachable through Conductor's cloud port forward.
# API, runtime, Postgres, MinIO, Mailpit, and the simulator stay bound to loopback.
WEB_BIND_HOST="127.0.0.1"
if [ "$CONDUCTOR_IS_CLOUD" = true ]; then
  WEB_BIND_HOST="0.0.0.0"
fi

# ---------------------------------------------------------------------------
# Workspace identity (cookie prefix isolation) — mirrors the old
# sanitize_project_name so auth cookies stay namespaced per workspace.
# ---------------------------------------------------------------------------
workspace_slug() {
  local raw="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$REPO_ROOT")}"
  local cleaned
  cleaned="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
  [ -z "$cleaned" ] && cleaned="workspace"
  printf '%s' "$cleaned" | grep -Eq '^[a-z0-9]' || cleaned="w-${cleaned}"
  printf 'companion-%s' "$cleaned"
}
PROJECT="$(workspace_slug)"

# ---------------------------------------------------------------------------
# Paths (all workspace state under .conductor-pg/)
# ---------------------------------------------------------------------------
STATE_DIR="$REPO_ROOT/.conductor-pg"
RUN_LOCK="$STATE_DIR/run.lock"
SECRETS_KEY_FILE="$STATE_DIR/secrets-master-key"
RUNTIME_HMAC_KEY_FILE="$STATE_DIR/runtime-desktop-hmac-key"
PG_DATA="$STATE_DIR/postgres/data"
# Socket lives in a short /tmp path, NOT under the (long) workspace dir: the
# Unix-domain socket path has a hard 103-byte limit and Conductor workspace
# paths blow past it. Clients connect over TCP (127.0.0.1) anyway; the socket
# filename embeds the port so workspaces never collide.
PG_SOCK="/tmp/companion-pg-${PG_PORT}"
PG_LOG="$STATE_DIR/postgres/postgres.log"
MINIO_DATA="$STATE_DIR/minio/data"
MINIO_LOG="$STATE_DIR/minio/minio.log"
MINIO_PID="$STATE_DIR/minio/minio.pid"
MAILPIT_LOG="$STATE_DIR/mailpit/mailpit.log"
MAILPIT_PID="$STATE_DIR/mailpit/mailpit.pid"

# ---------------------------------------------------------------------------
# Derived runtime config
# ---------------------------------------------------------------------------
PG_OWNER_USER="companion_owner"
PG_OWNER_PASS="companion-owner"
PG_API_USER="companion_api"
PG_API_PASS="companion-api"
PG_WORKER_USER="companion_worker"
PG_WORKER_PASS="companion-worker"
PG_RUNTIME_USER="companion_runtime_v2"
PG_RUNTIME_PASS="companion-runtime-v2"
PG_RETIRED_RUNTIME_ROLE=""
PG_DB="companion"
DATABASE_API_URL="postgres://${PG_API_USER}:${PG_API_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"
DATABASE_WORKER_URL="postgres://${PG_WORKER_USER}:${PG_WORKER_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"
DATABASE_COMPANION_RUNTIME_URL="postgres://${PG_RUNTIME_USER}:${PG_RUNTIME_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"
DATABASE_MIGRATION_URL="postgres://${PG_OWNER_USER}:${PG_OWNER_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"

WEB_URL="http://127.0.0.1:${WEB_PORT}"
API_URL="http://127.0.0.1:${API_PORT}"
RUNTIME_URL="http://127.0.0.1:${RUNTIME_PORT}"

S3_ACCESS_KEY_ID="companion"
S3_SECRET_ACCESS_KEY="companion-secret"
S3_BUCKET="skill-archives"
S3_ENDPOINT="http://127.0.0.1:${MINIO_API_PORT}"
SKILL_DATABASES_ENABLED="${COMPANION_SKILL_DATABASES_ENABLED:-true}"

# Detected at runtime
PG_BIN=""
HAS_MINIO=false
HAS_MAILPIT=false
RUN_LOCK_HELD=false
PG_OWNED=false
MINIO_OWNED=false
MAILPIT_OWNED=false

# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------
detect_pg_bin() {
  local c
  for c in \
    /opt/homebrew/opt/postgresql@17/bin \
    /opt/homebrew/opt/postgresql@16/bin \
    /usr/local/opt/postgresql@17/bin \
    /usr/local/opt/postgresql@16/bin; do
    if [ -x "$c/pg_ctl" ] && [ -x "$c/initdb" ] && [ -x "$c/psql" ]; then
      printf '%s' "$c"; return 0
    fi
  done
  if command -v pg_ctl >/dev/null 2>&1 && command -v initdb >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"; return 0
  fi
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1${2:+ ($2)}"
}

is_port_open() {
  # lsof catches IPv4 + IPv6 listeners; /dev/tcp misses ::1-only binds.
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

launcher_pid_running() {
  local pid="$1" cwd command
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cwd" in
    "$REPO_ROOT"|"$REPO_ROOT"/*) ;;
    *) return 1 ;;
  esac
  case "$command" in
    *dev-conductor.sh*) return 0 ;;
    *) return 1 ;;
  esac
}

acquire_run_lock() {
  local owner_pid="" attempts=0
  mkdir -p "$STATE_DIR"

  while ! ln -s "$$" "$RUN_LOCK" 2>/dev/null; do
    owner_pid="$(readlink "$RUN_LOCK" 2>/dev/null || true)"
    if launcher_pid_running "$owner_pid"; then
      die "Companion dev is already starting or running for this workspace (launcher PID $owner_pid). Stop the existing Conductor run before starting it again."
    fi

    attempts=$((attempts + 1))
    [ "$attempts" -le 3 ] \
      || die "Could not acquire workspace launcher lock: $RUN_LOCK"
    warn "Removing stale workspace launcher lock${owner_pid:+ (PID $owner_pid)}"
    if [ -L "$RUN_LOCK" ] || [ -f "$RUN_LOCK" ]; then
      rm -f "$RUN_LOCK"
    elif [ -d "$RUN_LOCK" ]; then
      rmdir "$RUN_LOCK" 2>/dev/null \
        || die "Launcher lock path is a non-empty directory: $RUN_LOCK"
    fi
  done

  RUN_LOCK_HELD=true
}

release_run_lock() {
  [ "$RUN_LOCK_HELD" = true ] || return 0
  if [ "$(readlink "$RUN_LOCK" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$RUN_LOCK"
  fi
  RUN_LOCK_HELD=false
}

# A PID is "ours" when it's plausibly a leftover from this same workspace's
# dev-conductor.sh — either its working directory is inside this repo, or (for
# processes whose cwd lsof can't resolve at all, e.g. reparented orphans left
# behind when a prior run was torn down without running our EXIT trap) its own
# command line fingerprints it as one of our services. We only ever kill our
# own stale processes; an unrelated process on a derived port is a hard error
# so a port collision never silently takes out someone else's work.
pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

pid_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

pid_comm() {
  ps -p "$1" -o comm= 2>/dev/null || true
}

is_repo_pid() {
  local pid="$1" label="$2" cwd cmd
  cwd="$(pid_cwd "$pid")"
  case "$cwd" in
    "$REPO_ROOT"|"$REPO_ROOT"/*) return 0 ;;
  esac
  # A resolved-but-mismatched cwd is a real signal the process belongs
  # elsewhere — only fall back to command-line fingerprinting when lsof
  # couldn't resolve a cwd at all.
  [ -n "$cwd" ] && return 1

  cmd="$(pid_command "$pid")"
  [ -n "$cmd" ] || return 1
  case "$label" in
    postgres|minio-api|minio-console)
      case "$cmd" in *"$STATE_DIR"*) return 0 ;; esac
      ;;
    mailpit-smtp|mailpit-ui)
      [ "$(pid_comm "$pid")" = "mailpit" ] && return 0
      ;;
    api|runtime|web|box-sim|box-lab)
      case "$cmd" in *"$REPO_ROOT"*|*"@companion/$label"*) return 0 ;; esac
      ;;
  esac
  return 1
}

free_port() {
  local port="$1" label="$2" pids pid repo_pids="" foreign_pids="" waited=0
  local -a repo_pid_array
  is_port_open "$port" || return 0
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    warn "$label port $port in use but PID not found"; return 0
  fi

  for pid in $pids; do
    if is_repo_pid "$pid" "$label"; then
      repo_pids="${repo_pids:+$repo_pids }$pid"
    else
      foreign_pids="${foreign_pids:+$foreign_pids }$pid"
    fi
  done

  if [ -n "$foreign_pids" ]; then
    die "$label port $port is held by an unrelated process (PID ${foreign_pids}). Stop it or run with a different CONDUCTOR_PORT/--base."
  fi

  warn "$label port $port busy (our PID ${repo_pids}) — terminating stale process"
  read -r -a repo_pid_array <<< "$repo_pids"
  kill "${repo_pid_array[@]}" 2>/dev/null || true
  while [ "$waited" -lt 3 ] && is_port_open "$port"; do sleep 1; waited=$((waited + 1)); done
  if is_port_open "$port"; then
    kill -9 "${repo_pid_array[@]}" 2>/dev/null || true
    sleep 1
  fi
  is_port_open "$port" && die "Port $port still busy after stopping our process. Manual kill: lsof -ti :$port | xargs kill -9"
  ok "$label port $port freed"
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
ensure_secrets_master_key() {
  # An explicit key is authoritative (for example when reopening an existing encrypted database).
  # Only generate/read the workspace-local key when the caller did not provide one.
  if [ -n "${COMPANION_SECRETS_MASTER_KEY:-}" ]; then
    export COMPANION_SECRETS_MASTER_KEY
    return
  fi
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if [ ! -s "$SECRETS_KEY_FILE" ]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" >"$SECRETS_KEY_FILE"
  fi
  chmod 600 "$SECRETS_KEY_FILE"
  COMPANION_SECRETS_MASTER_KEY="$(cat "$SECRETS_KEY_FILE")"
  export COMPANION_SECRETS_MASTER_KEY
}

ensure_runtime_hmac_key() {
  if [ -n "${COMPANION_RUNTIME_DESKTOP_HMAC_SECRET:-}" ]; then
    export COMPANION_RUNTIME_DESKTOP_HMAC_SECRET
    return
  fi
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if [ ! -s "$RUNTIME_HMAC_KEY_FILE" ]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" >"$RUNTIME_HMAC_KEY_FILE"
  fi
  chmod 600 "$RUNTIME_HMAC_KEY_FILE"
  COMPANION_RUNTIME_DESKTOP_HMAC_SECRET="$(cat "$RUNTIME_HMAC_KEY_FILE")"
  export COMPANION_RUNTIME_DESKTOP_HMAC_SECRET
}

check_prerequisites() {
  step "Checking prerequisites"
  local dev_box_mode
  if ! dev_box_mode="$(companion_dev_box_mode)"; then
    die "Invalid COMPANION_DEV_BOX_MODE='${COMPANION_DEV_BOX_MODE:-}'. Expected auto, sim, live, or lab."
  fi
  if [ "$dev_box_mode" = "live" ] && [ -z "${COMPANION_BOX_API_KEY:-}" ]; then
    die "COMPANION_DEV_BOX_MODE=live requires COMPANION_BOX_API_KEY."
  fi
  if [ "$dev_box_mode" = "lab" ] && [ "$CONDUCTOR_IS_CLOUD" = true ]; then
    die "COMPANION_DEV_BOX_MODE=lab is local-only. Run pnpm box:lab:smoke from a local workspace."
  fi
  require_command node "install Node.js >= 20"
  require_command pnpm "corepack enable && corepack prepare pnpm@9 --activate"
  require_command lsof "$LSOF_INSTALL_HINT"
  ok "node $(node -v)"
  ok "pnpm $(pnpm --version)"

  # Cloud-to-Mac workspace sync (and ordinary branch updates) can introduce a
  # new pnpm workspace package after Conductor's one-time setup script ran.
  # Refresh the workspace links on every Run so imports do not fail merely
  # because node_modules predates the current checkout. With an unchanged
  # lockfile this is a fast, resolution-free operation.
  info "Synchronising workspace dependencies"
  pnpm install --frozen-lockfile --prefer-offline \
    || die "Workspace dependency sync failed. Check that pnpm-lock.yaml matches the workspace manifests."
  ok "Workspace dependencies ready"

  if [ "$dev_box_mode" = "lab" ]; then
    BOX_LAB_WORKSPACE_ID="${BOX_LAB_WORKSPACE_ID:-${CONDUCTOR_WORKSPACE_ID:-$PROJECT}}" \
      bash scripts/dev-process.sh box-lab pnpm box:lab:doctor \
      || die "Box Lab prerequisites are unavailable. See the doctor output above; host virtualization dependencies are never installed automatically."
    ok "Box/Pi Linux Lab prerequisites"
  fi

  PG_BIN="$(detect_pg_bin || true)"
  [ -n "$PG_BIN" ] || die "Postgres binaries not found. Install: $POSTGRES_INSTALL_HINT"
  ok "postgres $("$PG_BIN/postgres" --version | awk '{print $3}') (${PG_BIN})"

  if command -v minio >/dev/null 2>&1; then
    HAS_MINIO=true
    ok "minio"
  else
    warn "$MINIO_MISSING_MESSAGE"
  fi

  if command -v mailpit >/dev/null 2>&1; then
    HAS_MAILPIT=true
    ok "mailpit"
  else
    warn "$MAILPIT_MISSING_MESSAGE"
  fi
}

# ---------------------------------------------------------------------------
# Postgres lifecycle (native per-workspace cluster, idempotent)
# ---------------------------------------------------------------------------
postgres_running() {
  [ -f "$PG_DATA/postmaster.pid" ] && "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1
}

start_postgres() {
  step "Starting Postgres (native workspace cluster)"

  if [ "$RESET_DB" = true ] && [ -d "$STATE_DIR/postgres" ]; then
    if postgres_running; then
      "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null 2>&1 || true
    fi
    info "Purging $STATE_DIR/postgres"
    rm -rf "$STATE_DIR/postgres"
  fi

  mkdir -p "$PG_SOCK" "$(dirname "$PG_LOG")"

  if [ ! -s "$PG_DATA/PG_VERSION" ]; then
    info "initdb → $PG_DATA"
    "$PG_BIN/initdb" -D "$PG_DATA" \
      --username=postgres \
      --auth-local=trust --auth-host=trust \
      --encoding=UTF8 --locale=C >/dev/null
    ok "Cluster initialised"
  fi

  if postgres_running; then
    if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -U postgres >/dev/null 2>&1; then
      ok "Postgres already running on 127.0.0.1:$PG_PORT"
    else
      warn "Cluster running but not on 127.0.0.1:$PG_PORT — restarting"
      "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null 2>&1 || true
    fi
  fi

  if ! postgres_running; then
    free_port "$PG_PORT" "postgres"
    info "pg_ctl start → port $PG_PORT"
    "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" \
      -o "-p $PG_PORT -k $PG_SOCK -h 127.0.0.1" -w start >/dev/null \
      || die "Postgres failed to start. See $PG_LOG"
    ok "Postgres started on 127.0.0.1:$PG_PORT"
  fi

  local waited=0
  while [ "$waited" -lt 15 ]; do
    "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -U postgres >/dev/null 2>&1 && break
    sleep 1; waited=$((waited + 1))
  done
  "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -U postgres >/dev/null 2>&1 \
    || die "Postgres not ready on 127.0.0.1:$PG_PORT after 15s. See $PG_LOG"
  PG_OWNED=true

  # Idempotent: ensures role+db exist on every run (self-heals a cluster that
  # was initialised but never bootstrapped).
  bootstrap_database
}

bootstrap_database() {
  step "Ensuring migration-owner + separate NOBYPASSRLS API/worker/runtime roles"
  local PSQL=("$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
  "${PSQL[@]}" -c "DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_OWNER_USER') THEN
      CREATE ROLE $PG_OWNER_USER LOGIN PASSWORD '$PG_OWNER_PASS' NOSUPERUSER BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_API_USER') THEN
      CREATE ROLE $PG_API_USER LOGIN PASSWORD '$PG_API_PASS' NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_WORKER_USER') THEN
      CREATE ROLE $PG_WORKER_USER LOGIN PASSWORD '$PG_WORKER_PASS' NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_RUNTIME_USER') THEN
      CREATE ROLE $PG_RUNTIME_USER LOGIN PASSWORD '$PG_RUNTIME_PASS' NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
  END \$\$;" >/dev/null
  "${PSQL[@]}" -c "ALTER ROLE $PG_OWNER_USER NOSUPERUSER BYPASSRLS;" >/dev/null
  "${PSQL[@]}" -c "ALTER ROLE $PG_API_USER NOSUPERUSER NOBYPASSRLS NOINHERIT;" >/dev/null
  "${PSQL[@]}" -c "ALTER ROLE $PG_WORKER_USER NOSUPERUSER NOBYPASSRLS NOINHERIT;" >/dev/null
  "${PSQL[@]}" -c "ALTER ROLE $PG_RUNTIME_USER NOSUPERUSER NOBYPASSRLS NOINHERIT;" >/dev/null
  "${PSQL[@]}" -c "CREATE DATABASE $PG_DB OWNER $PG_OWNER_USER;" 2>/dev/null || true
  "${PSQL[@]}" -c "ALTER DATABASE $PG_DB OWNER TO $PG_OWNER_USER;" >/dev/null
  # Preserve Skills Hub data in pre-split local clusters: the former application owner may still
  # own tables even though it must never execute hosted runtime work. Transfer ownership, then disable its
  # login. No grants or compatibility executor are restored.
  if "${PSQL[@]}" -tAc "select 1 from pg_roles where rolname = 'companion'" | grep -qx 1; then
    "${PSQL[@]}" -d "$PG_DB" -c "REASSIGN OWNED BY companion TO $PG_OWNER_USER;" >/dev/null
    "${PSQL[@]}" -c "ALTER ROLE companion NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;" >/dev/null
    PG_RETIRED_RUNTIME_ROLE="companion"
  fi
  ok "Owner '$PG_OWNER_USER' + API '$PG_API_USER' + worker '$PG_WORKER_USER' + runtime '$PG_RUNTIME_USER' + database '$PG_DB' ready"
}

# ---------------------------------------------------------------------------
# MinIO lifecycle (native, optional)
# ---------------------------------------------------------------------------
minio_running() {
  [ -f "$MINIO_PID" ] && kill -0 "$(cat "$MINIO_PID" 2>/dev/null)" 2>/dev/null
}

start_minio() {
  [ "$HAS_MINIO" = true ] || return 0
  step "Starting MinIO (native, optional)"
  mkdir -p "$MINIO_DATA" "$(dirname "$MINIO_LOG")"

  if minio_running && is_port_open "$MINIO_API_PORT"; then
    MINIO_OWNED=true
    ok "MinIO already running on :$MINIO_API_PORT (PID $(cat "$MINIO_PID"))"
  else
    if minio_running; then
      warn "MinIO process alive but not bound to :$MINIO_API_PORT — restarting"
      kill "$(cat "$MINIO_PID")" 2>/dev/null || true
      rm -f "$MINIO_PID"
    fi
    free_port "$MINIO_API_PORT" "minio-api"
    free_port "$MINIO_CONSOLE_PORT" "minio-console"
    MINIO_ROOT_USER="$S3_ACCESS_KEY_ID" MINIO_ROOT_PASSWORD="$S3_SECRET_ACCESS_KEY" \
      minio server "$MINIO_DATA" \
        --address "127.0.0.1:${MINIO_API_PORT}" \
        --console-address "127.0.0.1:${MINIO_CONSOLE_PORT}" \
        >"$MINIO_LOG" 2>&1 &
    echo $! >"$MINIO_PID"
    MINIO_OWNED=true
    ok "MinIO started (PID $(cat "$MINIO_PID"))"
  fi

  local waited=0
  while [ "$waited" -lt 15 ] && ! is_port_open "$MINIO_API_PORT"; do sleep 1; waited=$((waited + 1)); done
  if ! is_port_open "$MINIO_API_PORT"; then
    warn "MinIO did not open 127.0.0.1:$MINIO_API_PORT — see $MINIO_LOG (continuing, S3 degraded)"
    return 0
  fi

  # Create the skill-archives bucket via the repo's own AWS SDK (no `mc` CLI,
  # which collides with midnight-commander).
  if S3_ENDPOINT="$S3_ENDPOINT" S3_REGION=us-east-1 \
     S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
     S3_BUCKET_SKILL_ARCHIVES="$S3_BUCKET" S3_FORCE_PATH_STYLE=true \
     node "$REPO_ROOT/scripts/ensure-skill-bucket.mjs" >>"$MINIO_LOG" 2>&1; then
    ok "Bucket '$S3_BUCKET' ready"
  else
    warn "Could not create bucket '$S3_BUCKET' — see $MINIO_LOG (uploads may fail)"
  fi
}

# ---------------------------------------------------------------------------
# Mailpit lifecycle (native, optional)
# ---------------------------------------------------------------------------
mailpit_running() {
  [ -f "$MAILPIT_PID" ] && kill -0 "$(cat "$MAILPIT_PID" 2>/dev/null)" 2>/dev/null
}

start_mailpit() {
  [ "$HAS_MAILPIT" = true ] || return 0
  step "Starting Mailpit (native, optional)"
  mkdir -p "$(dirname "$MAILPIT_LOG")"
  if mailpit_running && is_port_open "$MAILPIT_SMTP_PORT"; then
    MAILPIT_OWNED=true
    ok "Mailpit already running on :$MAILPIT_SMTP_PORT (PID $(cat "$MAILPIT_PID"))"
    return 0
  fi
  if mailpit_running; then
    warn "Mailpit process alive but not bound to :$MAILPIT_SMTP_PORT — restarting"
    kill "$(cat "$MAILPIT_PID")" 2>/dev/null || true
    rm -f "$MAILPIT_PID"
  fi
  free_port "$MAILPIT_SMTP_PORT" "mailpit-smtp"
  free_port "$MAILPIT_UI_PORT" "mailpit-ui"
  mailpit \
    --smtp "127.0.0.1:${MAILPIT_SMTP_PORT}" \
    --listen "127.0.0.1:${MAILPIT_UI_PORT}" \
    >"$MAILPIT_LOG" 2>&1 &
  echo $! >"$MAILPIT_PID"
  MAILPIT_OWNED=true
  ok "Mailpit started (PID $(cat "$MAILPIT_PID"))"
}

# ---------------------------------------------------------------------------
# Cleanup trap — stop native services when concurrently exits.
# ---------------------------------------------------------------------------
stop_owned_services() {
  if [ "$MAILPIT_OWNED" = true ] && mailpit_running; then
    kill "$(cat "$MAILPIT_PID")" 2>/dev/null || true
    rm -f "$MAILPIT_PID"
  fi
  if [ "$MINIO_OWNED" = true ] && minio_running; then
    kill "$(cat "$MINIO_PID")" 2>/dev/null || true
    rm -f "$MINIO_PID"
  fi
  if [ "$PG_OWNED" = true ] && [ -n "$PG_BIN" ] && postgres_running; then
    "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null 2>&1 || true
  fi
  if [ "$PG_OWNED" = true ]; then
    rm -rf "$PG_SOCK"
  fi
}

stop_services() {
  if mailpit_running; then kill "$(cat "$MAILPIT_PID")" 2>/dev/null || true; rm -f "$MAILPIT_PID"; fi
  if minio_running;   then kill "$(cat "$MINIO_PID")"   2>/dev/null || true; rm -f "$MINIO_PID";   fi
  if [ -n "$PG_BIN" ] && postgres_running; then
    "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null 2>&1 || true
  fi
  rm -rf "$PG_SOCK"
}

cleanup() {
  trap - HUP INT TERM EXIT
  printf '\n%s%sShutting down…%s\n' "$BOLD" "$YELLOW" "$RESET"
  stop_owned_services
  release_run_lock
  ok "Native services stopped"
}

# ---------------------------------------------------------------------------
# Migrations + seed
# ---------------------------------------------------------------------------
migrate_and_seed() {
  step "Applying migrations + seeding test user"
  local migration_env=(
    DATABASE_MIGRATION_URL="$DATABASE_MIGRATION_URL"
    DATABASE_API_ROLE="$PG_API_USER"
    DATABASE_WORKER_ROLE="$PG_WORKER_USER"
    DATABASE_COMPANION_RUNTIME_ROLE="$PG_RUNTIME_USER"
  )
  if [ -n "$PG_RETIRED_RUNTIME_ROLE" ]; then
    migration_env+=(DATABASE_RETIRED_RUNTIME_ROLE="$PG_RETIRED_RUNTIME_ROLE")
  fi
  env "${migration_env[@]}" bash scripts/dev-process.sh migration pnpm db:migrate \
    || die "Migrations failed"
  local OWNER_PSQL=("$PG_BIN/psql" "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1)
  ok "Migrations applied"

  # Runtime deliberately cannot re-enable its own shared gate. Development is
  # an explicit local cutover controlled by the migration owner.
  if [ "${COMPANION_COMPANIONS_ENABLED:-}" = "true" ] \
    && [ -n "${COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS//[[:space:],]/}" ] \
    && "${OWNER_PSQL[@]}" -tAc \
      "select 1 where to_regprocedure('public.companion_runtime_enable(bigint,text)') is not null" \
      | grep -qx 1; then
    local gate_epoch
    gate_epoch="$("${OWNER_PSQL[@]}" -tAc \
      "select gate_epoch from public.companion_runtime_control where id = 'runtime-v3'")"
    case "$gate_epoch" in
      ''|*[!0-9]*) die "Runtime v3 gate returned an invalid epoch: '$gate_epoch'" ;;
    esac
    "${OWNER_PSQL[@]}" -c \
      "select * from public.companion_runtime_enable(${gate_epoch}::bigint, 'dev-conductor');" \
      >/dev/null || die "Could not enable the local Runtime v3 gate"
    ok "Runtime v3 gate enabled for local development"
  fi

  local seed_env=(
    DATABASE_URL="$DATABASE_API_URL"
    BETTER_AUTH_URL="$API_URL"
    COMPANION_API_URL="$API_URL"
    COMPANION_SKILL_DATABASES_ENABLED="$SKILL_DATABASES_ENABLED"
  )
  if [ "$HAS_MINIO" = true ]; then
    seed_env+=(
      S3_ENDPOINT="$S3_ENDPOINT"
      S3_REGION=us-east-1
      S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
      S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
      S3_BUCKET_SKILL_ARCHIVES="$S3_BUCKET"
      S3_FORCE_PATH_STYLE=true
    )
  fi

  if env "${seed_env[@]}" bash scripts/dev-process.sh api-seed \
    pnpm --filter @companion/api seed:test-user; then
    ok "Seed complete — login: ${COMPANION_SEED_EMAIL:-admin@thevibecompany.co} / adminadmin"
  else
    warn "Seed failed (database still usable)"
  fi
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
print_header() {
  printf '\n  %s%sCompanion — Conductor dev (native, no Docker)%s\n' "$BOLD" "$CYAN" "$RESET"
  printf '  %sWorkspace%s  %s\n' "$DIM" "$RESET" "${CONDUCTOR_WORKSPACE_NAME:-(hors-conductor)}"
  printf '  %sBase port%s  %s (range %s-%s)\n' "$DIM" "$RESET" "$BASE" "$BASE" "$((BASE + 9))"
  if [ "$CONDUCTOR_IS_CLOUD" = true ]; then
    printf '  %sWeb%s        %s (internal)\n' "$DIM" "$RESET" "$WEB_URL"
    printf '  %sWeb bind%s   %s:%s (Conductor cloud preview)\n' "$DIM" "$RESET" "$WEB_BIND_HOST" "$WEB_PORT"
  else
    printf '  %sWeb%s        %s\n' "$DIM" "$RESET" "$WEB_URL"
  fi
  printf '  %sAPI%s        %s\n' "$DIM" "$RESET" "$API_URL"
  printf '  %sRuntime%s    %s/healthz (private)\n' "$DIM" "$RESET" "$RUNTIME_URL"
  local dev_box_mode
  dev_box_mode="$(companion_dev_box_mode 2>/dev/null || printf 'invalid')"
  case "$dev_box_mode" in
    live) printf '  %sBox/Pi%s     configured provider\n' "$DIM" "$RESET" ;;
    sim) printf '  %sBox/Pi%s     deterministic simulator (no provider credential)\n' "$DIM" "$RESET" ;;
    lab) printf '  %sBox/Pi%s     real Pi in a local x86_64 Linux VM\n' "$DIM" "$RESET" ;;
    disabled) printf '  %sBox/Pi%s     not configured (simulator disabled)\n' "$DIM" "$RESET" ;;
    *) printf '  %sBox/Pi%s     invalid development mode\n' "$DIM" "$RESET" ;;
  esac
  printf '  %sPostgres%s   127.0.0.1:%s\n' "$DIM" "$RESET" "$PG_PORT"
  if [ "$HAS_MINIO" = true ]; then
    printf '  %sMinIO%s      %s (console http://127.0.0.1:%s)\n' "$DIM" "$RESET" "$S3_ENDPOINT" "$MINIO_CONSOLE_PORT"
  else
    printf '  %sMinIO%s      %s\n' "$DIM" "$RESET" "$MINIO_DISABLED_MESSAGE"
  fi
  if [ "$HAS_MAILPIT" = true ]; then
    printf '  %sMailpit%s    http://127.0.0.1:%s (smtp %s)\n' "$DIM" "$RESET" "$MAILPIT_UI_PORT" "$MAILPIT_SMTP_PORT"
  else
    printf '  %sEmail%s      %s\n' "$DIM" "$RESET" "$MAILPIT_DISABLED_MESSAGE"
  fi
  printf '  %sCtrl+C%s     stop everything (apps + native services)\n\n' "$DIM" "$RESET"
}

# ---------------------------------------------------------------------------
# Launch apps via concurrently (inline env, no .env mutation)
# ---------------------------------------------------------------------------
launch_apps() {
  step "Launching API + worker + runtime + web via concurrently"

  # Storage is shared by API uploads, worker cleanup, and runtime skill staging; email remains API-only.
  local shared_storage_env="" api_email_env box_lab_workspace_id
  box_lab_workspace_id="${BOX_LAB_WORKSPACE_ID:-${CONDUCTOR_WORKSPACE_ID:-$PROJECT}}"
  if [ "$HAS_MINIO" = true ]; then
    shared_storage_env="S3_ENDPOINT=\"$S3_ENDPOINT\" S3_REGION=us-east-1 S3_ACCESS_KEY_ID=\"$S3_ACCESS_KEY_ID\" S3_SECRET_ACCESS_KEY=\"$S3_SECRET_ACCESS_KEY\" S3_BUCKET_SKILL_ARCHIVES=\"$S3_BUCKET\" S3_FORCE_PATH_STYLE=true"
  fi
  if [ "$HAS_MAILPIT" = true ]; then
    api_email_env="EMAIL_PROVIDER=mailpit EMAIL_FROM=\"Companion <noreply@companion.local>\" MAILPIT_SMTP_HOST=127.0.0.1 MAILPIT_SMTP_PORT=$MAILPIT_SMTP_PORT"
  else
    api_email_env="EMAIL_PROVIDER=log"
  fi

  # Master/HMAC/Box secrets remain inherited rather than interpolated into the
  # command line. dev-process.sh strips them from every process that does not own them.
  local api_cmd="COMPANION_API_HOST=127.0.0.1 COMPANION_API_PORT=$API_PORT DATABASE_URL=\"$DATABASE_API_URL\" COMPANION_RUNTIME_PRIVATE_URL=\"$RUNTIME_URL\" BETTER_AUTH_URL=\"$API_URL\" BETTER_AUTH_COOKIE_PREFIX=\"$PROJECT\" COMPANION_WEB_URL=\"$WEB_URL\" COMPANION_API_URL=\"$API_URL\" NEXT_PUBLIC_COMPANION_API_URL=\"$API_URL\" COMPANION_SKILL_DATABASES_ENABLED=\"$SKILL_DATABASES_ENABLED\" $shared_storage_env $api_email_env bash scripts/dev-process.sh api pnpm --filter @companion/api dev"
  local worker_cmd="DATABASE_WORKER_URL=\"$DATABASE_WORKER_URL\" COMPANION_WEB_URL=\"$WEB_URL\" $shared_storage_env bash scripts/dev-worker.sh pnpm --filter @companion/worker dev"
  local runtime_cmd="DATABASE_COMPANION_RUNTIME_URL=\"$DATABASE_COMPANION_RUNTIME_URL\" COMPANION_RUNTIME_HOST=127.0.0.1 COMPANION_RUNTIME_PORT=$RUNTIME_PORT COMPANION_BOX_SIM_PORT=$BOX_SIM_PORT BOX_LAB_PORT=$BOX_SIM_PORT COMPANION_API_URL=\"$API_URL\" $shared_storage_env bash scripts/dev-runtime.sh pnpm --filter @companion/runtime dev"
  local web_cmd="COMPANION_API_URL=\"$API_URL\" NEXT_PUBLIC_COMPANION_API_URL=\"$API_URL\" bash scripts/dev-process.sh web pnpm --filter @companion/web dev --hostname $WEB_BIND_HOST --port $WEB_PORT"

  free_port "$API_PORT" "api"
  free_port "$RUNTIME_PORT" "runtime"
  free_port "$WEB_PORT" "web"
  if companion_dev_uses_box_simulator; then
    free_port "$BOX_SIM_PORT" "box-sim"
  elif companion_dev_uses_box_lab; then
    free_port "$BOX_SIM_PORT" "box-lab"
  fi

  # No `exec`: keep this bash alive so the EXIT trap stops native services
  # after concurrently returns (Ctrl+C → SIGINT → concurrently kills the apps
  # → bash exits → trap → pg_ctl stop / kill minio,mailpit).
  # Keep the caller-controlled workspace identity out of concurrently's shell command strings.
  # Child role wrappers retain it only for the Lab and remove it before Runtime starts.
  BOX_LAB_WORKSPACE_ID="$box_lab_workspace_id" pnpm exec concurrently \
    --names api,worker,runtime,web \
    --prefix-colors blue,magenta,cyan,green \
    --prefix "[{name}]" \
    --kill-others-on-fail \
    --restart-tries 0 \
    "$api_cmd" "$worker_cmd" "$runtime_cmd" "$web_cmd"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_run() {
  # Acquire ownership before installing cleanup traps. A duplicate invocation
  # must never tear down the services owned by the already-running launcher.
  require_command lsof "$LSOF_INSTALL_HINT"
  acquire_run_lock
  trap cleanup EXIT
  # Conductor stops run scripts with SIGHUP before its final SIGKILL. Exiting
  # here routes every supported stop signal through the EXIT cleanup.
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  check_prerequisites
  ensure_secrets_master_key
  ensure_runtime_hmac_key
  start_postgres
  start_minio
  start_mailpit
  migrate_and_seed
  print_header
  launch_apps
}

cmd_archive() {
  step "Archiving workspace — stopping native services + removing workspace state"
  PG_BIN="$(detect_pg_bin || true)"
  stop_services
  if [ "$CONDUCTOR_IS_CLOUD" = false ]; then
    BOX_LAB_WORKSPACE_ID="${BOX_LAB_WORKSPACE_ID:-${CONDUCTOR_WORKSPACE_ID:-$PROJECT}}" \
      bash scripts/dev-process.sh box-lab pnpm box:lab:reset \
      || die "Could not remove the Box Lab resources owned by this workspace."
  fi
  rm -rf "$STATE_DIR"
  ok "Removed $STATE_DIR"
}

main() {
  case "$COMMAND" in
    run)     cmd_run ;;
    archive) cmd_archive ;;
    *)       usage; exit 64 ;;
  esac
}

# Allow the lightweight network-resolution checks to source this file without
# starting native services. Normal direct execution remains unchanged.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main
fi
