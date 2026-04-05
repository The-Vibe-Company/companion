#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# restart.sh — Force restart dev environment
#
# Usage: ./scripts/restart.sh
#
# Always stops existing servers first, then starts fresh.
# Safe: verifies PIDs and ports before killing to avoid wrong processes.
# =============================================================================

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
BACKEND_PORT=3457
VITE_PORT=3456
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
  local path="${2:-/}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:$port$path" 2>/dev/null || echo "000")
  [[ "$code" =~ ^[23] ]]
}

get_pid_on_port() {
  lsof -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

get_process_name() {
  ps -p "$1" -o comm= 2>/dev/null || echo ""
}

get_process_command() {
  ps -p "$1" -o command= 2>/dev/null || echo ""
}

# Safely kill a process by PID file with verification
# Returns 0 if killed, 1 if not running
kill_by_pid_file_safe() {
  local pid_file="$1"
  local label="$2"

  if [ ! -f "$pid_file" ]; then
    return 1
  fi

  local pid
  pid=$(cat "$pid_file")

  # Check if PID is valid and running
  if ! kill -0 "$pid" 2>/dev/null; then
    warn "$label (PID $pid from file) is not running"
    rm -f "$pid_file"
    return 1
  fi

  # Verify this is actually a bun/node process (our expected process type)
  local proc_name
  proc_name=$(get_process_name "$pid")

  if [[ "$proc_name" != "bun" && "$proc_name" != "node" && "$proc_name" != " Bun" ]]; then
    local cmd
    cmd=$(get_process_command "$pid")
    warn "PID $pid ($proc_name) doesn't look like a dev server:"
    echo "  Command: $cmd"
    die "Refusing to kill unexpected process. Check $pid_file manually."
  fi

  step "Stopping $label (PID $pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait for graceful shutdown (up to 5 seconds)
  local waited=0
  while [ $waited -lt 5 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # Force kill if still running
  if kill -0 "$pid" 2>/dev/null; then
    warn "$label didn't exit gracefully, sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi

  rm -f "$pid_file"
  info "$label stopped"
  return 0
}

# Safely kill a process on a port with verification
kill_on_port_safe() {
  local port="$1"
  local label="$2"

  if ! is_port_listening "$port"; then
    return 1
  fi

  local pid
  pid=$(get_pid_on_port "$port")

  if [ -z "$pid" ]; then
    return 1
  fi

  # Verify this is actually a bun/node process
  local proc_name
  proc_name=$(get_process_name "$pid")

  if [[ "$proc_name" != "bun" && "$proc_name" != "node" && "$proc_name" != " Bun" ]]; then
    local cmd
    cmd=$(get_process_command "$pid")
    warn "Port $port is occupied by unexpected process (PID $pid, $proc_name):"
    echo "  Command: $cmd"
    die "Refusing to kill unexpected process on port $port."
  fi

  step "Stopping $label on port $port (PID $pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait for graceful shutdown
  local waited=0
  while [ $waited -lt 5 ]; do
    if ! is_port_listening "$port"; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # Force kill if still running
  if is_port_listening "$port"; then
    pid=$(get_pid_on_port "$port")
    if [ -n "$pid" ]; then
      warn "$label didn't exit gracefully, sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
    fi
  fi

  info "$label stopped"
  return 0
}

wait_for_port() {
  local port="$1"
  local label="$2"
  local pid_file="$3"
  local max_wait=60
  local waited=0
  # Backend uses /health endpoint, Vite uses root
  local health_path
  [ "$port" = "$BACKEND_PORT" ] && health_path="/health" || health_path="/"

  while [ $waited -lt $max_wait ]; do
    if is_http_healthy "$port" "$health_path"; then
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

# --------------- stop command ---------------

cmd_stop() {
  step "Stopping all dev servers..."

  # Try PID file first (most accurate)
  kill_by_pid_file_safe "$BACKEND_PID_FILE" "Backend" || true
  kill_by_pid_file_safe "$VITE_PID_FILE" "Vite" || true

  # Also check ports as fallback
  kill_on_port_safe "$BACKEND_PORT" "Backend" || true
  kill_on_port_safe "$VITE_PORT" "Vite" || true

  sleep 1
  info "All dev servers stopped"
}

# --------------- start command ---------------

cmd_start() {
  cd "$WEB_DIR"

  # --- Check bun ---
  command -v bun &>/dev/null || die "bun not found. Install: https://bun.sh"
  info "bun $(bun --version)"

  # --- Install deps ---
  step "Checking dependencies..."
  bun install --frozen-lockfile 2>&1 | tail -3
  info "Dependencies OK"

  # --- Start backend ---
  if is_port_listening "$BACKEND_PORT"; then
    die "Backend port $BACKEND_PORT is still occupied after stop. Check manually."
  fi

  step "Starting backend on port $BACKEND_PORT..."
  nohup bun --watch server/index.ts > "$BACKEND_LOG" 2>&1 &
  echo $! > "$BACKEND_PID_FILE"

  wait_for_port "$BACKEND_PORT" "Backend" "$BACKEND_PID_FILE"
  echo ""
  info "Backend ready on http://localhost:$BACKEND_PORT (PID: $(cat "$BACKEND_PID_FILE"))"

  # --- Start Vite ---
  if is_port_listening "$VITE_PORT"; then
    die "Vite port $VITE_PORT is still occupied after stop. Check manually."
  fi

  step "Starting Vite dev server on port $VITE_PORT..."
  nohup bun run dev:vite > "$VITE_LOG" 2>&1 &
  echo $! > "$VITE_PID_FILE"

  wait_for_port "$VITE_PORT" "Vite" "$VITE_PID_FILE"
  echo ""
  info "Vite ready on http://localhost:$VITE_PORT (PID: $(cat "$VITE_PID_FILE"))"

  echo ""
  info "Dev environment ready!"
  echo -e "  Backend API:  ${CYAN}http://localhost:$BACKEND_PORT${NC}"
  echo -e "  Frontend UI:  ${CYAN}http://localhost:$VITE_PORT${NC}"
}

# --------------- main: always stop then start ---------------

step "Force restarting dev environment..."
echo ""

cmd_stop
echo ""
cmd_start
