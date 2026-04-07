# Windows Development Workflow Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun run dev`, `bun run start`, and `bun run test` work natively on Windows (no WSL).

**Architecture:** Fix cross-platform issues in package.json scripts, server code (PATH resolution, service guard), and create PowerShell equivalents for bash dev scripts.

**Tech Stack:** TypeScript, Bun, PowerShell, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `web/package.json` | Modify | Fix `start` script to be cross-platform |
| `web/server/index.ts` | Modify | Default `NODE_ENV` in code |
| `web/server/path-resolver.ts` | Modify | Skip Unix shell sourcing on Windows; add Windows PATH candidates |
| `web/server/path-resolver.test.ts` | Modify | Update Windows `getEnrichedPath` test to match new behavior |
| `web/server/service.ts` | Modify | Friendly Windows error message |
| `package.json` (root) | Modify | Add `test` and `typecheck` scripts |
| `scripts/dev-start.ps1` | Create | PowerShell equivalent of dev-start.sh |
| `scripts/restart.ps1` | Create | PowerShell equivalent of restart.sh |
| `scripts/landing-start.ps1` | Create | PowerShell equivalent of landing-start.sh |
| `CLAUDE.md` | Modify | Add Windows dev instructions |

---

### Task 1: Fix package.json start script

**Files:**
- Modify: `web/package.json:33`

- [ ] **Step 1: Update start script in web/package.json**

In `web/package.json`, change line 33 from:
```json
"start": "NODE_ENV=production bun server/index.ts",
```
to:
```json
"start": "bun server/index.ts",
```

The `NODE_ENV=production command` syntax is a Unix-only shell feature. We'll set `NODE_ENV` in code instead.

- [ ] **Step 2: Add NODE_ENV default in web/server/index.ts**

In `web/server/index.ts`, add this line right before the `defaultPort` calculation (before line 52):

```typescript
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
```

This ensures `NODE_ENV` defaults to `"production"` regardless of how the server is started. The line should go after all the imports and PATH enrichment (after line 7) but before `const defaultPort = ...` (line 52). Best placement: right after the `process.env.PATH = getEnrichedPath();` line (line 7), before the other imports start — no, better placement is right before line 50 (`import { DEFAULT_PORT_DEV ... }`) — actually the cleanest place is right before line 52 (`const defaultPort = ...`). Insert after line 50:

```typescript
import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";

if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
```

- [ ] **Step 3: Run typecheck to verify**

Run: `cd web && bun run typecheck`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/server/index.ts
git commit -m "fix(windows): use cross-platform start script and default NODE_ENV in code"
```

---

### Task 2: Fix path-resolver.ts for Windows

**Files:**
- Modify: `web/server/path-resolver.ts:21-41,47-100`

- [ ] **Step 1: Skip shell sourcing on Windows in captureUserShellPath**

In `web/server/path-resolver.ts`, add an early return at the top of `captureUserShellPath()` (line 22). Change:

```typescript
export function captureUserShellPath(): string {
  try {
    const shell = process.env.SHELL || "/bin/bash";
```

to:

```typescript
export function captureUserShellPath(): string {
  // Windows has no login shell paradigm — skip directly to fallback.
  if (process.platform === "win32") {
    return buildFallbackPath();
  }

  try {
    const shell = process.env.SHELL || "/bin/bash";
```

- [ ] **Step 2: Add Windows candidate paths to buildFallbackPath**

In `buildFallbackPath()` (around line 76), add Windows paths after the existing Unix candidates. Change:

```typescript
    // Deno
    join(home, ".deno", "bin"),
  ];
```

to:

```typescript
    // Deno
    join(home, ".deno", "bin"),
    // Windows paths
    join(process.env.LOCALAPPDATA || "", "Programs", "bun"),
    join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps"),
    join(home, "AppData", "Roaming", "npm"),
  ];
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `cd web && bun run test -- server/path-resolver.test.ts`
Expected: All existing tests PASS.

Note: The `getEnrichedPath` Windows test at line 309-341 will need updating (next task) because `captureUserShellPath` no longer calls execSync on Windows.

- [ ] **Step 4: Commit**

```bash
git add web/server/path-resolver.ts
git commit -m "fix(windows): skip Unix shell sourcing on Windows, add Windows PATH candidates"
```

---

### Task 3: Update path-resolver tests for Windows

**Files:**
- Modify: `web/server/path-resolver.test.ts:309-341`

- [ ] **Step 1: Fix the getEnrichedPath Windows test**

The existing test at line 309 (`describe("Windows support")` inside `getEnrichedPath`) mocks `execSync` to return shell sourcing output. With the new code, `captureUserShellPath` skips execSync on Windows and calls `buildFallbackPath()` directly. The test must be updated to use `mockExistsSync` instead.

Replace the entire `describe("Windows support")` block inside `getEnrichedPath` (lines 309-341) with:

```typescript
  describe("Windows support", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      _resetPathCache();
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("skips shell sourcing on win32 and merges process.env.PATH with fallback paths", () => {
      process.env.PATH = "C:\\Windows\\System32;C:\\Windows";
      // On win32, captureUserShellPath calls buildFallbackPath (no execSync).
      // Mock existsSync so fallback returns a known directory.
      mockExistsSync.mockImplementation((p: string) =>
        p === "C:\\Windows\\System32" || p === "/usr/bin",
      );

      const result = getEnrichedPath();

      // Result should contain process.env.PATH dirs and fallback dirs that exist
      expect(result).toContain("C:\\Windows\\System32");
      expect(result).toContain("C:\\Windows");
      // Should be semicolon-separated on Windows
      const dirs = result.split(";");
      expect(dirs.length).toBeGreaterThanOrEqual(2);
      // Deduplication: C:\Windows\System32 should appear once
      expect(dirs.filter((d) => d === "C:\\Windows\\System32").length).toBe(1);
    });
  });
```

- [ ] **Step 2: Add test for captureUserShellPath skipping shell sourcing on win32**

Add a new test case inside the existing `describe("captureUserShellPath")` block (after the existing tests, around line 127):

```typescript
  describe("Windows support", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("skips shell sourcing on Windows and returns fallback path directly", () => {
      // On Windows, captureUserShellPath should NOT call execSync at all.
      // Instead it returns buildFallbackPath() directly.
      mockExistsSync.mockImplementation((p: string) =>
        p === "C:\\Windows\\System32",
      );

      const result = captureUserShellPath();

      // Should NOT have called execSync for shell sourcing
      expect(mockExecSync).not.toHaveBeenCalled();
      // Should contain the fallback path
      expect(result).toContain("C:\\Windows\\System32");
    });
  });
```

- [ ] **Step 3: Run path-resolver tests**

Run: `cd web && bun run test -- server/path-resolver.test.ts`
Expected: All tests PASS (both old and new Windows tests).

- [ ] **Step 4: Commit**

```bash
git add web/server/path-resolver.test.ts
git commit -m "test(windows): update path-resolver tests for Windows shell sourcing bypass"
```

---

### Task 4: Fix service.ts Windows error message

**Files:**
- Modify: `web/server/service.ts:37-44`

- [ ] **Step 1: Update ensureSupportedPlatform for friendly Windows message**

In `web/server/service.ts`, replace the `ensureSupportedPlatform()` function (lines 37-44) with:

```typescript
function ensureSupportedPlatform(): void {
  if (process.platform === "win32") {
    console.error("Service management is not supported on Windows yet.");
    console.error("Use 'bun run dev' or 'bun run start' instead.");
    process.exit(1);
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error(
      "Service management is only supported on macOS (launchd) and Linux (systemd).",
    );
    process.exit(1);
  }
}
```

- [ ] **Step 2: Update the existing platform check test in service.test.ts**

The existing test at line 1373 (`describe("platform check")`) already tests win32 exits with error. Verify it still passes — the new code still calls `process.exit(1)` on win32, so the test assertion `rejects.toThrow("process.exit(1)")` should remain valid.

Run: `cd web && bun run test -- server/service.test.ts`
Expected: All tests PASS (the win32 test already expects `process.exit(1)`).

- [ ] **Step 3: Commit**

```bash
git add web/server/service.ts
git commit -m "fix(windows): show friendly error message for service commands on Windows"
```

---

### Task 5: Add missing scripts to root package.json

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Add test and typecheck scripts**

The root `package.json` already has `dev`, `build`, `start` but is missing `test` and `typecheck`. Add them:

```json
{
  "scripts": {
    "dev": "cd web && bun run dev",
    "build": "cd web && bun run build",
    "start": "cd web && bun run start",
    "test": "cd web && bun run test",
    "typecheck": "cd web && bun run typecheck",
    "prepare": "husky"
  }
}
```

- [ ] **Step 2: Verify root scripts work**

Run: `cd "D:/workspace/学习/learn/2026-04-03-build-claude-code/my-companion/companion" && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add test and typecheck scripts to root package.json"
```

---

### Task 6: Create scripts/dev-start.ps1

**Files:**
- Create: `scripts/dev-start.ps1`

- [ ] **Step 1: Write the PowerShell script**

Create `scripts/dev-start.ps1` with the following content. This mirrors `dev-start.sh` using PowerShell equivalents:

```powershell
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
```

- [ ] **Step 2: Verify script syntax**

Run: `pwsh -NoProfile -Command "try { [System.Management.Automation.PSParser]::Tokenize((Get-Content 'scripts/dev-start.ps1' -Raw), [ref]$null); Write-Host 'Syntax OK' } catch { Write-Host $_.Exception.Message }"`
Expected: "Syntax OK"

- [ ] **Step 3: Commit**

```bash
git add scripts/dev-start.ps1
git commit -m "feat(windows): add PowerShell dev-start script"
```

---

### Task 7: Create scripts/restart.ps1

**Files:**
- Create: `scripts/restart.ps1`

- [ ] **Step 1: Write the PowerShell script**

Create `scripts/restart.ps1` mirroring `restart.sh`:

```powershell
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
```

- [ ] **Step 2: Verify script syntax**

Run: `pwsh -NoProfile -Command "try { [System.Management.Automation.PSParser]::Tokenize((Get-Content 'scripts/restart.ps1' -Raw), [ref]$null); Write-Host 'Syntax OK' } catch { Write-Host $_.Exception.Message }"`
Expected: "Syntax OK"

- [ ] **Step 3: Commit**

```bash
git add scripts/restart.ps1
git commit -m "feat(windows): add PowerShell restart script"
```

---

### Task 8: Create scripts/landing-start.ps1

**Files:**
- Create: `scripts/landing-start.ps1`

- [ ] **Step 1: Write the PowerShell script**

Create `scripts/landing-start.ps1` mirroring `landing-start.sh`:

```powershell
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
```

- [ ] **Step 2: Verify script syntax**

Run: `pwsh -NoProfile -Command "try { [System.Management.Automation.PSParser]::Tokenize((Get-Content 'scripts/landing-start.ps1' -Raw), [ref]$null); Write-Host 'Syntax OK' } catch { Write-Host $_.Exception.Message }"`
Expected: "Syntax OK"

- [ ] **Step 3: Commit**

```bash
git add scripts/landing-start.ps1
git commit -m "feat(windows): add PowerShell landing-start script"
```

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Windows development commands**

In `CLAUDE.md`, add a Windows section after the existing `# Dev server` block in Development Commands. Find the line:

```markdown
# Production build + serve
cd web && bun run build && bun run start
```

Add after it:

```markdown

# Windows Dev (PowerShell)
pwsh scripts/dev-start.ps1          # start/verify dev servers
pwsh scripts/dev-start.ps1 -Stop    # stop
pwsh scripts/dev-start.ps1 -Status  # check status
pwsh scripts/restart.ps1            # force restart
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(windows): add PowerShell dev instructions to CLAUDE.md"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd web && bun run test`
Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: No type errors.

- [ ] **Step 3: Verify PowerShell scripts parse correctly**

Run all three syntax checks:

```bash
pwsh -NoProfile -Command "[System.Management.Automation.PSParser]::Tokenize((Get-Content 'scripts/dev-start.ps1' -Raw), [ref]$null) | Out-Null; Write-Host 'dev-start.ps1: OK'"
pwsh -NoProfile -Command "[System.Management.Automation.PSParser]::Tokenize((Get-Content 'scripts/restart.ps1' -Raw), [ref]$null) | Out-Null; Write-Host 'restart.ps1: OK'"
pwsh -NoProfile -Command "[System.Management.Automation.PSParser]::Tokenize((Get-Content 'scripts/landing-start.ps1' -Raw), [ref]$null) | Out-Null; Write-Host 'landing-start.ps1: OK'"
```

Expected: All three print "OK".

---

## Self-Review Checklist

**1. Spec coverage:**
- package.json start script fix → Task 1 ✓
- NODE_ENV default in code → Task 1 ✓
- PowerShell scripts (3x) → Tasks 6, 7, 8 ✓
- path-resolver Windows bypass → Task 2 ✓
- path-resolver Windows candidates → Task 2 ✓
- service.ts friendly error → Task 4 ✓
- Root package.json scripts → Task 5 ✓
- CLAUDE.md documentation → Task 9 ✓
- Tests (path-resolver) → Task 3 ✓
- Tests (service) → Task 4 ✓ (existing test already covers win32)

**2. Placeholder scan:** No TBD, TODO, or placeholder patterns found.

**3. Type consistency:** All function names and variable names are consistent across tasks. No mismatches.
