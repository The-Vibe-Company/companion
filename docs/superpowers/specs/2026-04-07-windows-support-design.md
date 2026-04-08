# Windows Support for Development Workflow

**Date:** 2026-04-07
**Scope:** Development workflow only (dev, start, test)
**Approach:** .ps1 scripts + code fixes + documentation

## Problem

The Companion project does not support native Windows development. Key blockers:

- All `scripts/*.sh` use bash + Unix tools (`lsof`, `ps`, `nohup`)
- `NODE_ENV=production command` syntax in `web/package.json` fails on CMD/PowerShell
- `web/server/path-resolver.ts` assumes Unix shell for PATH capture
- `web/server/service.ts` hard-exits on Windows
- No Windows equivalent for Makefile commands

## Scope

**In scope:**
- `bun run dev`, `bun run start`, `bun run test` working on native Windows
- PowerShell equivalents for dev-start.sh, restart.sh, landing-start.sh
- Core server code gracefully handles Windows
- Documentation updates

**Out of scope:**
- Windows Service management (launchd/systemd equivalent)
- Docker build scripts
- CI/CD Windows testing
- `build-push-companion-server.sh`

## Design

### 1. package.json Script Fix

**File:** `web/package.json`

Change the `start` script from:
```json
"start": "NODE_ENV=production bun server/index.ts"
```

To:
```json
"start": "bun server/index.ts"
```

Set `NODE_ENV` in `web/server/index.ts` at the top:
```typescript
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
```

This is cross-platform — no shell-specific syntax needed.

### 2. PowerShell Scripts

Create three `.ps1` scripts mirroring the existing `.sh` scripts:

#### `scripts/dev-start.ps1`
- **Port check:** `Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue`
- **Health check:** `(Invoke-WebRequest -Uri "http://localhost:$port/$path" -TimeoutSec 3 -UseBasicParsing).StatusCode`
- **Background process:** `Start-Process -FilePath "bun" -ArgumentList ... -NoNewWindow -RedirectStandardOutput $logFile`
- **PID tracking:** Same `.dev-backend.pid` / `.dev-vite.pid` file approach
- **Process kill:** `Stop-Process -Id $pid -Force` with safety checks via `Get-Process`
- **Commands:** `dev-start.ps1` (start), `dev-start.ps1 -Stop`, `dev-start.ps1 -Status`

#### `scripts/restart.ps1`
- Same replacements as above
- Safe kill verification: check `Get-Process -Id $pid | Select-Object -ExpandProperty Name` matches "bun" or "node"
- Graceful shutdown wait loop (5 second timeout, then force kill)

#### `scripts/landing-start.ps1`
- Same replacements as above
- Same command interface: `landing-start.ps1`, `-Stop`, `-Status`

### 3. Core Code Fixes

#### `web/server/path-resolver.ts`

`captureUserShellPath()` — skip shell sourcing on Windows, go straight to fallback:

```typescript
export function captureUserShellPath(): string {
  if (process.platform === "win32") {
    return buildFallbackPath();
  }
  // existing Unix shell capture...
}
```

`buildFallbackPath()` — add Windows-specific candidate paths:

```typescript
const candidates = [
  // existing Unix paths...
  // Windows paths
  join(process.env.LOCALAPPDATA || "", "Programs", "bun"),
  join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps"),
  join(home, "AppData", "Roaming", "npm"),
];
```

#### `web/server/service.ts`

`ensureSupportedPlatform()` — friendly message instead of generic exit:

```typescript
if (process.platform === "win32") {
  console.error("Service management is not supported on Windows yet.");
  console.error("Use 'bun run dev' or 'bun run start' instead.");
  process.exit(1);
}
```

#### `web/server/cli-launcher.ts`

No changes needed. Existing code already:
- Detects `process.platform === "win32"` for `.cmd`/`.bat` wrapping (line 588)
- Uses correct PATH separator `";"` on Windows (lines 796, 1036)
- Guards `process.getuid` calls with `typeof` checks

### 4. Root package.json

Add npm scripts as Makefile alternative (works on all platforms):

```json
{
  "scripts": {
    "dev": "cd web && bun run dev",
    "build": "cd web && bun run build",
    "start": "cd web && bun run start",
    "test": "cd web && bun run test",
    "typecheck": "cd web && bun run typecheck"
  }
}
```

### 5. Documentation

Update `CLAUDE.md` Development Commands section to include Windows instructions:

```markdown
# Windows Dev (PowerShell)
pwsh scripts/dev-start.ps1          # start dev
pwsh scripts/dev-start.ps1 -Stop    # stop
pwsh scripts/dev-start.ps1 -Status  # check status
```

### 6. Testing

- Add Windows-path test cases to `path-resolver.test.ts` (mock `process.platform`)
- Add Windows graceful-degradation test to `service.test.ts`
- No automated tests for .ps1 scripts (manual verification)

## Files Changed

| File | Action |
|------|--------|
| `web/package.json` | Fix `start` script |
| `web/server/index.ts` | Add default `NODE_ENV` |
| `web/server/path-resolver.ts` | Windows PATH capture + fallback paths |
| `web/server/service.ts` | Friendly Windows error message |
| `package.json` (root) | Add cross-platform npm scripts |
| `scripts/dev-start.ps1` | New file |
| `scripts/restart.ps1` | New file |
| `scripts/landing-start.ps1` | New file |
| `CLAUDE.md` | Add Windows dev instructions |
| `web/server/path-resolver.test.ts` | Windows test cases |
| `web/server/service.test.ts` | Windows graceful degradation test |
