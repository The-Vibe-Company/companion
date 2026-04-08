# =============================================================================
# dev-start.ps1 — Idempotent dev environment bootstrap (Windows)
#
# Usage: pwsh scripts/dev-start.ps1          Start/verify dev servers
#        pwsh scripts/dev-start.ps1 -Stop    Stop all dev servers
#        pwsh scripts/dev-start.ps1 -Status  Check if running
#
# Starts both the Bun backend (port 3457) and Vite frontend (port 3456).
# Idempotent: safe to run N times. If servers are healthy, exits instantly.
# =============================================================================

param(
    [switch]$Stop,
    [switch]$Status
)

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
    } catch {
        return $false
    }
}

function Test-HttpHealthy($port, $path = "/") {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$port$path" -TimeoutSec 3 -UseBasicParsing
        return $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400
    } catch {
        return $false
    }
}

function Get-PidOnPort($port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conn) { return $conn[0].OwningProcess }
    } catch {}
    return $null
}

function Stop-PidFromFile($pidFile, $label) {
    if (-not (Test-Path $pidFile)) { return }

    $pid = Get-Content $pidFile -Raw
    if (-not $pid) { return }

    try {
        $proc = Get-Process -Id $pid.Trim() -ErrorAction SilentlyContinue
        if ($proc) {
            # Verify this looks like a bun/node process
            if ($proc.ProcessName -notmatch "bun|node") {
                Write-Warn "$label (PID $pid) doesn't look like a dev server: $($proc.ProcessName)"
                Write-Die "Refusing to kill unexpected process. Check $pidFile manually."
            }
            Write-Step "Stopping $label (PID $pid)..."
            Stop-Process -Id $pid.Trim() -Force -ErrorAction SilentlyContinue
        }
    } catch {
        # Process may already be gone
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-PortProcess($port, $label) {
    if (-not (Test-PortListening $port)) { return }

    $pid = Get-PidOnPort $port
    if (-not $pid) { return }

    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -notmatch "bun|node") {
        Write-Warn "Port $port is occupied by unexpected process ($($proc.ProcessName))"
        Write-Die "Refusing to kill unexpected process on port $port."
    }

    Write-Step "Stopping $label on port $port (PID $pid)..."
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}

function Wait-ForPort($port, $label, $pidFile, $maxWaitSec = 60) {
    $healthPath = if ($port -eq $BACKEND_PORT) { "/health" } else { "/" }
    $waited = 0

    while ($waited -lt $maxWaitSec) {
        if (Test-HttpHealthy $port $healthPath) { return }
        if ((Test-Path $pidFile) -and -not (Get-Process -Id (Get-Content $pidFile -Raw).Trim() -ErrorAction SilentlyContinue)) {
            $logFile = if ($port -eq $BACKEND_PORT) { $BACKEND_LOG } else { $VITE_LOG }
            if (Test-Path $logFile) {
                Write-Die "$label crashed. Last 20 lines:`n$(Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue)"
            } else {
                Write-Die "$label crashed (no log file found)."
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

# --------------- commands ---------------

function Stop-Dev {
    Write-Step "Stopping dev servers..."
    Stop-PidFromFile $BACKEND_PID_FILE "Backend"
    Stop-PidFromFile $VITE_PID_FILE "Vite"
    Stop-PortProcess $BACKEND_PORT "Backend"
    Stop-PortProcess $VITE_PORT "Vite"
    Start-Sleep -Seconds 1
    Write-Info "Dev servers stopped"
}

function Show-Status {
    $ok = $true

    if ((Test-PortListening $BACKEND_PORT) -and (Test-HttpHealthy $BACKEND_PORT "/health")) {
        $pid = Get-PidOnPort $BACKEND_PORT
        Write-Info "Backend running on http://localhost:${BACKEND_PORT} (PID: $pid)"
    } elseif (Test-PortListening $BACKEND_PORT) {
        Write-Warn "Backend port $BACKEND_PORT occupied but not healthy"
        $ok = $false
    } else {
        Write-Warn "Backend is not running"
        $ok = $false
    }

    if ((Test-PortListening $VITE_PORT) -and (Test-HttpHealthy $VITE_PORT)) {
        $pid = Get-PidOnPort $VITE_PORT
        Write-Info "Vite running on http://localhost:${VITE_PORT} (PID: $pid)"
    } elseif (Test-PortListening $VITE_PORT) {
        Write-Warn "Vite port $VITE_PORT occupied but not healthy"
        $ok = $false
    } else {
        Write-Warn "Vite is not running"
        $ok = $false
    }

    if (-not $ok) { exit 1 }
}

function Start-Dev {
    Set-Location $WEB_DIR

    # --- Fast path: both already running and healthy ---
    if ((Test-PortListening $BACKEND_PORT) -and (Test-HttpHealthy $BACKEND_PORT "/health") `
        -and (Test-PortListening $VITE_PORT) -and (Test-HttpHealthy $VITE_PORT)) {
        Write-Info "Backend already running on http://localhost:${BACKEND_PORT}"
        Write-Info "Vite already running on http://localhost:${VITE_PORT}"
        return
    }

    # --- Check bun ---
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCmd) { Write-Die "bun not found. Install: https://bun.sh" }
    $bunVer = & bun --version
    Write-Info "bun $bunVer"

    # --- Install deps ---
    Write-Step "Checking dependencies..."
    & bun install --frozen-lockfile 2>&1 | Select-Object -Last 3
    Write-Info "Dependencies OK"

    # --- Start backend if needed ---
    if ((Test-PortListening $BACKEND_PORT) -and (Test-HttpHealthy $BACKEND_PORT "/health")) {
        Write-Info "Backend already running on http://localhost:${BACKEND_PORT}"
    } else {
        if (Test-PortListening $BACKEND_PORT) {
            Write-Warn "Backend port $BACKEND_PORT occupied but unhealthy -- restarting..."
            Stop-PidFromFile $BACKEND_PID_FILE "Backend"
            Stop-PortProcess $BACKEND_PORT "Backend"
            Start-Sleep -Seconds 1
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
    }

    # --- Start Vite if needed ---
    if ((Test-PortListening $VITE_PORT) -and (Test-HttpHealthy $VITE_PORT)) {
        Write-Info "Vite already running on http://localhost:${VITE_PORT}"
    } else {
        if (Test-PortListening $VITE_PORT) {
            Write-Warn "Vite port $VITE_PORT occupied but unhealthy -- restarting..."
            Stop-PidFromFile $VITE_PID_FILE "Vite"
            Stop-PortProcess $VITE_PORT "Vite"
            Start-Sleep -Seconds 1
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
    }

    Write-Host ""
    Write-Info "Dev environment ready!"
    Write-Host "  Backend API:  http://localhost:${BACKEND_PORT}" -ForegroundColor Cyan
    Write-Host "  Frontend UI:  http://localhost:${VITE_PORT}" -ForegroundColor Cyan
}

# --------------- main ---------------

if ($Stop) {
    Stop-Dev
} elseif ($Status) {
    Show-Status
} else {
    Start-Dev
}
