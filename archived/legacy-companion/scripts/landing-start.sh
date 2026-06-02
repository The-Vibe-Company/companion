#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# landing-start.sh — Idempotent landing page bootstrap
#
# Usage: ./scripts/landing-start.sh          Start/verify landing site
#        ./scripts/landing-start.sh --stop   Stop the landing site
#        ./scripts/landing-start.sh --status Check if running
#
# Starts the Vite dev server for landing/ on port 5175.
# Idempotent: safe to run N times. If server is healthy, exits instantly.
# =============================================================================

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LANDING_DIR="$ROOT_DIR/landing"
LANDING_PORT=5175
PID_FILE="$ROOT_DIR/.dev-landing.pid"
LOG_FILE="$ROOT_DIR/.dev-landing.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $*"; }
die()   { echo -e "${RED}[xx]${NC} $*" >&2; exit 1; }
step()  { echo -e "${CYAN}-->>${NC} $*"; }

# --------------- helpers ---------------

is_port_listening() {
  lsof -iTCP:"$1" -sTCP:LISTEN -t &>/dev/null
}

is_http_healthy() {
  local port="$1"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:$port" 2>/dev/null || echo "000")
  [[ "$code" =~ ^[23] ]]
}

get_pid_on_port() {
  lsof -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

kill_by_pid_file() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

kill_on_port() {
  if is_port_listening "$LANDING_PORT"; then
    local pid
    pid=$(get_pid_on_port "$LANDING_PORT")
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
}

clean_stale_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
    fi
  fi
}

wait_for_port() {
  local max_wait=60
  local waited=0

  while [ $waited -lt $max_wait ]; do
    if is_http_healthy "$LANDING_PORT"; then
      return 0
    fi
    if [ -f "$PID_FILE" ] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      die "Landing site crashed. Logs:\n$(tail -20 "$LOG_FILE")"
    fi
    printf "."
    sleep 1
    waited=$((waited + 1))
  done

  die "Timeout waiting for landing site (${max_wait}s). Logs:\n$(tail -20 "$LOG_FILE")"
}

# --------------- commands ---------------

cmd_stop() {
  step "Stopping landing site..."
  kill_by_pid_file
  kill_on_port
  sleep 1
  info "Landing site stopped"
}

cmd_status() {
  if is_port_listening "$LANDING_PORT" && is_http_healthy "$LANDING_PORT"; then
    info "Landing site running on http://localhost:$LANDING_PORT (PID: $(get_pid_on_port "$LANDING_PORT"))"
    return 0
  elif is_port_listening "$LANDING_PORT"; then
    warn "Landing port $LANDING_PORT occupied but not healthy"
    return 1
  else
    warn "Landing site is not running"
    return 1
  fi
}

cmd_start() {
  # --- Fast path: already running and healthy ---
  if is_port_listening "$LANDING_PORT" && is_http_healthy "$LANDING_PORT"; then
    info "Landing site already running on http://localhost:$LANDING_PORT"
    exit 0
  fi

  # --- Check bun ---
  command -v bun &>/dev/null || die "bun not found. Install: https://bun.sh"
  info "bun $(bun --version)"

  # --- Check landing dir ---
  [ -d "$LANDING_DIR" ] || die "landing/ directory not found at $LANDING_DIR"

  cd "$LANDING_DIR"

  # --- Install deps ---
  step "Checking dependencies..."
  bun install 2>&1 | tail -3
  info "Dependencies OK"

  # --- Start if needed ---
  if is_port_listening "$LANDING_PORT"; then
    warn "Landing port $LANDING_PORT occupied but unhealthy -- restarting..."
    kill_by_pid_file
    kill_on_port
    sleep 1
  fi
  clean_stale_pid

  step "Starting landing site on port $LANDING_PORT..."
  nohup bun run dev > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  wait_for_port
  echo ""
  info "Landing site ready on http://localhost:$LANDING_PORT (PID: $(cat "$PID_FILE"))"
}

# --------------- main ---------------

case "${1:-}" in
  --stop)   cmd_stop   ;;
  --status) cmd_status ;;
  *)        cmd_start  ;;
esac
