# =============================================================================
# restart.ps1 — Force restart dev environment (Windows)
#
# Usage: pwsh scripts/restart.ps1
#
# Always stops existing servers first, then starts fresh.
# =============================================================================

$ErrorActionPreference = "Stop"

$ROOT_DIR = Resolve-Path (Join-Path $PSScriptRoot "..")
$WEB_DIR = Join-Path $ROOT_DIR "web"
$BACKEND_PORT = 3457
$VITE_PORT = 3456
$BACKEND_PID_FILE = Join-Path $ROOT_DIR ".dev-backend.pid"
$VITE_PID_FILE = Join-Path $ROOT_DIR ".dev-vite.pid"
$BACKEND_LOG = Join-Path $ROOT_DIR ".dev-backend.log"
$VITE_LOG = Join-Path $ROOT_DIR ".dev-vite.log"

function Write-Info($msg)  { Write-Host "[ok] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[!!] $msg" -ForegroundColor Yellow }
function Write-Step($msg)  { Write-Host "-->> $msg" -ForegroundColor Cyan }
function Write-Die($msg)   { Write-Host "[xx] $msg" -ForegroundColor Red; exit 1 }

# --------------- helpers ---------------

function Test-PortListening($port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        return $null -ne $conn
    } catch { return $false }
}

function Test-HttpHealthy($port, $path = "/") {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$port$path" -TimeoutSec 3 -UseBasicParsing
        return $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400
    } catch { return $false }
}

function Get-PidOnPort($port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conn) { return $conn[0].OwningProcess }
    } catch {}
    return $null
}

function Get-ProcessName($pid) {
    try {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) { return $proc.ProcessName }
    } catch {}
    return ""
}

function Stop-PidFileSafe($pidFile, $label) {
    if (-not (Test-Path $pidFile)) { return $false }

    $pid = (Get-Content $pidFile -Raw).Trim()
    if (-not $pid) { return $false }

    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Warn "$label (PID $pid from file) is not running"
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return $false
    }

    # Verify this is a bun/node process
    $name = $proc.ProcessName
    if ($name -notmatch "bun|node") {
        Write-Warn "PID $pid ($name) doesn't look like a dev server"
        Write-Die "Refusing to kill unexpected process. Check $pidFile manually."
    }

    Write-Step "Stopping $label (PID $pid)..."
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue

    # Wait for graceful shutdown (up to 5 seconds)
    $waited = 0
    while ($waited -lt 5) {
        if (-not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
        $waited++
    }

    # Force kill if still running
    if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
        Write-Warn "$label didn't exit gracefully, force killing..."
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Info "$label stopped"
    return $true
}

function Stop-PortSafe($port, $label) {
    if (-not (Test-PortListening $port)) { return $false }

    $pid = Get-PidOnPort $port
    if (-not $pid) { return $false }

    $name = Get-ProcessName $pid
    if ($name -notmatch "bun|node") {
        Write-Warn "Port $port is occupied by unexpected process (PID $pid, $name)"
        Write-Die "Refusing to kill unexpected process on port $port."
    }

    Write-Step "Stopping $label on port $port (PID $pid)..."
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue

    # Wait for shutdown
    $waited = 0
    while ($waited -lt 5) {
        if (-not (Test-PortListening $port)) { break }
        Start-Sleep -Seconds 1
        $waited++
    }

    if (Test-PortListening $port) {
        $pid = Get-PidOnPort $port
        if ($pid) {
            Write-Warn "$label didn't exit gracefully, force killing..."
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
    }

    Write-Info "$label stopped"
    return $true
}

function Wait-ForPort($port, $label, $pidFile, $maxWaitSec = 60) {
    $healthPath = if ($port -eq $BACKEND_PORT) { "/health" } else { "/" }
    $waited = 0

    while ($waited -lt $maxWaitSec) {
        if (Test-HttpHealthy $port $healthPath) { return }
        if ((Test-Path $pidFile)) {
            $pidVal = (Get-Content $pidFile -Raw).Trim()
            if ($pidVal -and -not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) {
                $logFile = if ($port -eq $BACKEND_PORT) { $BACKEND_LOG } else { $VITE_LOG }
                if (Test-Path $logFile) {
                    Write-Die "$label crashed. Last 20 lines:`n$(Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue)"
                } else {
                    Write-Die "$label crashed (no log file found)."
                }
            }
        }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
        $waited++
    }

    $logFile = if ($port -eq $BACKEND_PORT) { $BACKEND_LOG } else { $VITE_LOG }
    if (Test-Path $logFile) {
        Write-Die "Timeout waiting for $label (${maxWaitSec}s). Last 20 lines:`n$(Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue)"
    } else {
        Write-Die "Timeout waiting for $label (${maxWaitSec}s)."
    }
}

# --------------- stop ---------------

function Stop-All {
    Write-Step "Stopping all dev servers..."
    Stop-PidFileSafe $BACKEND_PID_FILE "Backend" | Out-Null
    Stop-PidFileSafe $VITE_PID_FILE "Vite" | Out-Null
    Stop-PortSafe $BACKEND_PORT "Backend" | Out-Null
    Stop-PortSafe $VITE_PORT "Vite" | Out-Null
    Start-Sleep -Seconds 1
    Write-Info "All dev servers stopped"
}

# --------------- start ---------------

function Start-All {
    Set-Location $WEB_DIR

    # --- Check bun ---
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCmd) { Write-Die "bun not found. Install: https://bun.sh" }
    Write-Info "bun $(bun --version)"

    # --- Install deps ---
    Write-Step "Checking dependencies..."
    & bun install --frozen-lockfile 2>&1 | Select-Object -Last 3
    Write-Info "Dependencies OK"

    # --- Start backend ---
    if (Test-PortListening $BACKEND_PORT) {
        Write-Die "Backend port $BACKEND_PORT is still occupied after stop. Check manually."
    }

    Write-Step "Starting backend on port $BACKEND_PORT..."
    $proc = Start-Process -FilePath "bun" -ArgumentList "--watch","server/index.ts" `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $BACKEND_LOG `
        -RedirectStandardError (Join-Path $ROOT_DIR ".dev-backend.err.log")
    $proc.Id | Set-Content $BACKEND_PID_FILE

    Wait-ForPort $BACKEND_PORT "Backend" $BACKEND_PID_FILE
    Write-Host ""
    Write-Info "Backend ready on http://localhost:${BACKEND_PORT} (PID: $($proc.Id))"

    # --- Start Vite ---
    if (Test-PortListening $VITE_PORT) {
        Write-Die "Vite port $VITE_PORT is still occupied after stop. Check manually."
    }

    Write-Step "Starting Vite dev server on port $VITE_PORT..."
    $proc = Start-Process -FilePath "bun" -ArgumentList "run","dev:vite" `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $VITE_LOG `
        -RedirectStandardError (Join-Path $ROOT_DIR ".dev-vite.err.log")
    $proc.Id | Set-Content $VITE_PID_FILE

    Wait-ForPort $VITE_PORT "Vite" $VITE_PID_FILE
    Write-Host ""
    Write-Info "Vite ready on http://localhost:${VITE_PORT} (PID: $($proc.Id))"

    Write-Host ""
    Write-Info "Dev environment ready!"
    Write-Host "  Backend API:  http://localhost:${BACKEND_PORT}" -ForegroundColor Cyan
    Write-Host "  Frontend UI:  http://localhost:${VITE_PORT}" -ForegroundColor Cyan
}

# --------------- main ---------------

Write-Step "Force restarting dev environment..."
Write-Host ""

Stop-All
Write-Host ""
Start-All
