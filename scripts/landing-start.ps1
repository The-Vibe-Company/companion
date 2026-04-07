# =============================================================================
# landing-start.ps1 — Idempotent landing page bootstrap (Windows)
#
# Usage: pwsh scripts/landing-start.ps1          Start/verify landing site
#        pwsh scripts/landing-start.ps1 -Stop    Stop the landing site
#        pwsh scripts/landing-start.ps1 -Status  Check if running
#
# Starts the Vite dev server for landing/ on port 5175.
# =============================================================================

param(
    [switch]$Stop,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

$ROOT_DIR = Resolve-Path (Join-Path $PSScriptRoot "..")
$LANDING_DIR = Join-Path $ROOT_DIR "landing"
$LANDING_PORT = 5175
$PID_FILE = Join-Path $ROOT_DIR ".dev-landing.pid"
$LOG_FILE = Join-Path $ROOT_DIR ".dev-landing.log"

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

function Test-HttpHealthy($port) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$port" -TimeoutSec 3 -UseBasicParsing
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

function Stop-PidFromFile {
    if (Test-Path $PID_FILE) {
        $pid = (Get-Content $PID_FILE -Raw).Trim()
        if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $PID_FILE -Force -ErrorAction SilentlyContinue
    }
}

function Stop-PortProc {
    if (Test-PortListening $LANDING_PORT) {
        $pid = Get-PidOnPort $LANDING_PORT
        if ($pid) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }
    }
}

function Clear-StalePid {
    if (Test-Path $PID_FILE) {
        $pid = (Get-Content $PID_FILE -Raw).Trim()
        if ($pid -and -not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
            Remove-Item $PID_FILE -Force -ErrorAction SilentlyContinue
        }
    }
}

function Wait-ForLanding($maxWaitSec = 60) {
    $waited = 0
    while ($waited -lt $maxWaitSec) {
        if (Test-HttpHealthy $LANDING_PORT) { return }
        if ((Test-Path $PID_FILE)) {
            $pidVal = (Get-Content $PID_FILE -Raw).Trim()
            if ($pidVal -and -not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) {
                if (Test-Path $LOG_FILE) {
                    Write-Die "Landing site crashed. Last 20 lines:`n$(Get-Content $LOG_FILE -Tail 20 -ErrorAction SilentlyContinue)"
                } else {
                    Write-Die "Landing site crashed (no log file)."
                }
            }
        }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
        $waited++
    }
    if (Test-Path $LOG_FILE) {
        Write-Die "Timeout waiting for landing site (${maxWaitSec}s). Last 20 lines:`n$(Get-Content $LOG_FILE -Tail 20 -ErrorAction SilentlyContinue)"
    } else {
        Write-Die "Timeout waiting for landing site (${maxWaitSec}s)."
    }
}

# --------------- commands ---------------

function Stop-Landing {
    Write-Step "Stopping landing site..."
    Stop-PidFromFile
    Stop-PortProc
    Start-Sleep -Seconds 1
    Write-Info "Landing site stopped"
}

function Show-LandingStatus {
    if ((Test-PortListening $LANDING_PORT) -and (Test-HttpHealthy $LANDING_PORT)) {
        $pid = Get-PidOnPort $LANDING_PORT
        Write-Info "Landing site running on http://localhost:${LANDING_PORT} (PID: $pid)"
    } elseif (Test-PortListening $LANDING_PORT) {
        Write-Warn "Landing port $LANDING_PORT occupied but not healthy"
        exit 1
    } else {
        Write-Warn "Landing site is not running"
        exit 1
    }
}

function Start-Landing {
    # --- Fast path: already running and healthy ---
    if ((Test-PortListening $LANDING_PORT) -and (Test-HttpHealthy $LANDING_PORT)) {
        Write-Info "Landing site already running on http://localhost:${LANDING_PORT}"
        return
    }

    # --- Check bun ---
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCmd) { Write-Die "bun not found. Install: https://bun.sh" }
    Write-Info "bun $(bun --version)"

    # --- Check landing dir ---
    if (-not (Test-Path $LANDING_DIR)) {
        Write-Die "landing/ directory not found at $LANDING_DIR"
    }

    Set-Location $LANDING_DIR

    # --- Install deps ---
    Write-Step "Checking dependencies..."
    & bun install 2>&1 | Select-Object -Last 3
    Write-Info "Dependencies OK"

    # --- Start if needed ---
    if (Test-PortListening $LANDING_PORT) {
        Write-Warn "Landing port $LANDING_PORT occupied but unhealthy -- restarting..."
        Stop-PidFromFile
        Stop-PortProc
        Start-Sleep -Seconds 1
    }
    Clear-StalePid

    Write-Step "Starting landing site on port $LANDING_PORT..."
    $proc = Start-Process -FilePath "bun" -ArgumentList "run","dev" `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $LOG_FILE `
        -RedirectStandardError (Join-Path $ROOT_DIR ".dev-landing.err.log")
    $proc.Id | Set-Content $PID_FILE

    Wait-ForLanding
    Write-Host ""
    $pid = (Get-Content $PID_FILE -Raw).Trim()
    Write-Info "Landing site ready on http://localhost:${LANDING_PORT} (PID: $pid)"
}

# --------------- main ---------------

if ($Stop) {
    Stop-Landing
} elseif ($Status) {
    Show-LandingStatus
} else {
    Start-Landing
}
