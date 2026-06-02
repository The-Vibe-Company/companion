#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# dev-start.sh — Idempotent dev environment bootstrap
#
# Usage: ./scripts/dev-start.sh          Start/verify dev servers
#        ./scripts/dev-start.sh --stop   Stop all dev servers
#        ./scripts/dev-start.sh --status Check if running
#
# Starts both the Bun backend (port 3456) and Vite frontend (port 5174).
# Idempotent: safe to run N times. If servers are healthy, exits instantly.
# =============================================================================

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
BACKEND_PORT=3457
VITE_PORT=5174
BACKEND_PID_FILE="$ROOT_DIR/.dev-backend.pid"
VITE_PID_FILE="$ROOT_DIR/.dev-vite.pid"
BACKEND_LOG="$ROOT_DIR/.dev-backend.log"
VITE_LOG="$ROOT_DIR/.dev-vite.log"

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
  local pid_file="$1"
  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

kill_on_port() {
  local port="$1"
  if is_port_listening "$port"; then
    local pid
    pid=$(get_pid_on_port "$port")
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
}

clean_stale_pid() {
  local pid_file="$1"
  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file")
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pid_file"
    fi
  fi
}

wait_for_port() {
  local port="$1"
  local label="$2"
  local pid_file="$3"
  local max_wait=60
  local waited=0

  while [ $waited -lt $max_wait ]; do
    if is_http_healthy "$port"; then
      return 0
    fi
    if [ -f "$pid_file" ] && ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      local log_file
      [ "$port" = "$BACKEND_PORT" ] && log_file="$BACKEND_LOG" || log_file="$VITE_LOG"
      die "$label crashed. Logs:\n$(tail -20 "$log_file")"
    fi
    printf "."
    sleep 1
    waited=$((waited + 1))
  done

  local log_file
  [ "$port" = "$BACKEND_PORT" ] && log_file="$BACKEND_LOG" || log_file="$VITE_LOG"
  die "Timeout waiting for $label (${max_wait}s). Logs:\n$(tail -20 "$log_file")"
}

# --------------- commands ---------------

cmd_stop() {
  step "Stopping dev servers..."
  kill_by_pid_file "$BACKEND_PID_FILE"
  kill_by_pid_file "$VITE_PID_FILE"
  kill_on_port "$BACKEND_PORT"
  kill_on_port "$VITE_PORT"
  sleep 1
  info "Dev servers stopped"
}

cmd_status() {
  local ok=true

  if is_port_listening "$BACKEND_PORT" && is_http_healthy "$BACKEND_PORT"; then
    info "Backend running on http://localhost:$BACKEND_PORT (PID: $(get_pid_on_port "$BACKEND_PORT"))"
  elif is_port_listening "$BACKEND_PORT"; then
    warn "Backend port $BACKEND_PORT occupied but not healthy"
    ok=false
  else
    warn "Backend is not running"
    ok=false
  fi

  if is_port_listening "$VITE_PORT" && is_http_healthy "$VITE_PORT"; then
    info "Vite running on http://localhost:$VITE_PORT (PID: $(get_pid_on_port "$VITE_PORT"))"
  elif is_port_listening "$VITE_PORT"; then
    warn "Vite port $VITE_PORT occupied but not healthy"
    ok=false
  else
    warn "Vite is not running"
    ok=false
  fi

  $ok && return 0 || return 1
}

cmd_start() {
  cd "$WEB_DIR"

  # --- Fast path: both already running and healthy ---
  if is_port_listening "$BACKEND_PORT" && is_http_healthy "$BACKEND_PORT" \
     && is_port_listening "$VITE_PORT" && is_http_healthy "$VITE_PORT"; then
    info "Backend already running on http://localhost:$BACKEND_PORT"
    info "Vite already running on http://localhost:$VITE_PORT"
    exit 0
  fi

  # --- Check bun ---
  command -v bun &>/dev/null || die "bun not found. Install: https://bun.sh"
  info "bun $(bun --version)"

  # --- Install deps (bun install is idempotent) ---
  step "Checking dependencies..."
  bun install --frozen-lockfile 2>&1 | tail -3
  info "Dependencies OK"

  # --- Start backend if needed ---
  if is_port_listening "$BACKEND_PORT" && is_http_healthy "$BACKEND_PORT"; then
    info "Backend already running on http://localhost:$BACKEND_PORT"
  else
    if is_port_listening "$BACKEND_PORT"; then
      warn "Backend port $BACKEND_PORT occupied but unhealthy -- restarting..."
      kill_by_pid_file "$BACKEND_PID_FILE"
      kill_on_port "$BACKEND_PORT"
      sleep 1
    fi
    clean_stale_pid "$BACKEND_PID_FILE"

    step "Starting backend on port $BACKEND_PORT..."
    nohup bun --watch server/index.ts > "$BACKEND_LOG" 2>&1 &
    echo $! > "$BACKEND_PID_FILE"

    wait_for_port "$BACKEND_PORT" "Backend" "$BACKEND_PID_FILE"
    echo ""
    info "Backend ready on http://localhost:$BACKEND_PORT (PID: $(cat "$BACKEND_PID_FILE"))"
  fi

  # --- Start Vite if needed ---
  if is_port_listening "$VITE_PORT" && is_http_healthy "$VITE_PORT"; then
    info "Vite already running on http://localhost:$VITE_PORT"
  else
    if is_port_listening "$VITE_PORT"; then
      warn "Vite port $VITE_PORT occupied but unhealthy -- restarting..."
      kill_by_pid_file "$VITE_PID_FILE"
      kill_on_port "$VITE_PORT"
      sleep 1
    fi
    clean_stale_pid "$VITE_PID_FILE"

    step "Starting Vite dev server on port $VITE_PORT..."
    nohup bun run dev:vite > "$VITE_LOG" 2>&1 &
    echo $! > "$VITE_PID_FILE"

    wait_for_port "$VITE_PORT" "Vite" "$VITE_PID_FILE"
    echo ""
    info "Vite ready on http://localhost:$VITE_PORT (PID: $(cat "$VITE_PID_FILE"))"
  fi

  echo ""
  info "Dev environment ready!"
  echo -e "  Backend API:  ${CYAN}http://localhost:$BACKEND_PORT${NC}"
  echo -e "  Frontend UI:  ${CYAN}http://localhost:$VITE_PORT${NC}"
}

# --------------- main ---------------

case "${1:-}" in
  --stop)   cmd_stop   ;;
  --status) cmd_status ;;
  *)        cmd_start  ;;
esac
