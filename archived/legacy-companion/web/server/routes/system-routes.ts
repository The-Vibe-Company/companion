import type { Hono } from "hono";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { TerminalManager } from "../terminal-manager.js";
import { getUsageLimits } from "../usage-limits.js";
import {
  getUpdateState,
  checkForUpdate,
  isUpdateAvailable,
  setUpdateInProgress,
} from "../update-checker.js";
import { refreshServiceDefinition } from "../service.js";
import { getSettings } from "../settings-manager.js";
import { imagePullManager } from "../image-pull-manager.js";

export function registerSystemRoutes(
  api: Hono,
  deps: {
    launcher: CliLauncher;
    wsBridge: WsBridge;
    terminalManager: TerminalManager;
    updateCheckStaleMs: number;
  },
): void {
  api.get("/usage-limits", async (c) => {
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/sessions/:id/usage-limits", async (c) => {
    const sessionId = c.req.param("id");
    const session = deps.wsBridge.getSession(sessionId);
    const empty = { five_hour: null, seven_day: null, extra_usage: null };

    if (session?.backendType === "codex") {
      const rl = deps.wsBridge.getCodexRateLimits(sessionId);
      if (!rl) return c.json(empty);
      const toEpochMs = (value: number): number => (
        value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
      );
      const mapLimit = (l: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null) => {
        if (!l) return null;
        const resetsAtMs = toEpochMs(l.resetsAt);
        return {
          utilization: l.usedPercent,
          resets_at: resetsAtMs ? new Date(resetsAtMs).toISOString() : null,
        };
      };
      return c.json({
        five_hour: mapLimit(rl.primary),
        seven_day: mapLimit(rl.secondary),
        extra_usage: null,
      });
    }

    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/update-check", async (c) => {
    const initialState = getUpdateState();
    const needsRefresh =
      initialState.lastChecked === 0
      || Date.now() - initialState.lastChecked > deps.updateCheckStaleMs;
    if (needsRefresh) {
      await checkForUpdate();
    }

    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
      channel: state.channel,
    });
  });

  api.post("/update-check", async (c) => {
    await checkForUpdate();
    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
      channel: state.channel,
    });
  });

  api.post("/update", async (c) => {
    const state = getUpdateState();
    if (!state.isServiceMode) {
      return c.json(
        { error: "Update & restart is only available in service mode" },
        400,
      );
    }
    if (!isUpdateAvailable()) {
      return c.json({ error: "No update available" }, 400);
    }
    if (state.updateInProgress) {
      return c.json({ error: "Update already in progress" }, 409);
    }

    setUpdateInProgress(true);

    setTimeout(async () => {
      try {
        console.log(
          `[update] Updating the-companion to ${state.latestVersion}...`,
        );
        const proc = Bun.spawn(
          ["bun", "install", "-g", `the-companion@${state.latestVersion}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          console.error(
            `[update] bun install failed (code ${exitCode}):`,
            stderr,
          );
          setUpdateInProgress(false);
          return;
        }

        // Re-pull Docker image if auto-update is enabled
        if (getSettings().dockerAutoUpdate) {
          try {
            console.log("[update] Re-pulling Docker image (dockerAutoUpdate enabled)...");
            imagePullManager.pull("the-companion:latest");
            const ready = await imagePullManager.waitForReady("the-companion:latest", 120_000);
            if (ready) {
              console.log("[update] Docker image re-pull complete.");
            } else {
              console.warn("[update] Docker image re-pull failed or timed out, continuing with restart.");
            }
          } catch (err) {
            console.warn("[update] Docker image re-pull error, continuing:", err);
          }
        }

        try {
          refreshServiceDefinition();
          console.log("[update] Service definition refreshed.");
        } catch (err) {
          console.warn("[update] Failed to refresh service definition:", err);
        }

        console.log("[update] Update successful, restarting service...");

        const isLinux = process.platform === "linux";
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        const restartCmd = isLinux
          ? ["systemctl", "--user", "restart", "the-companion.service"]
          : uid !== undefined
            ? ["launchctl", "kickstart", "-k", `gui/${uid}/sh.thecompanion.app`]
            : ["launchctl", "kickstart", "-k", "sh.thecompanion.app"];

        Bun.spawn(restartCmd, {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: isLinux
            ? {
                ...process.env,
                XDG_RUNTIME_DIR:
                  process.env.XDG_RUNTIME_DIR ||
                  `/run/user/${uid ?? 1000}`,
              }
            : undefined,
        });

        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        console.error("[update] Update failed:", err);
        setUpdateInProgress(false);
      }
    }, 100);

    return c.json({
      ok: true,
      message: "Update started. Server will restart shortly.",
    });
  });

  api.get("/terminal", (c) => {
    const terminalId = c.req.query("terminalId");
    const info = deps.terminalManager.getInfo(terminalId || undefined);
    if (!info) return c.json({ active: false });
    return c.json({ active: true, terminalId: info.id, cwd: info.cwd });
  });

  api.post("/terminal/spawn", async (c) => {
    const body = await c.req.json<{ cwd: string; cols?: number; rows?: number; containerId?: string }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const terminalId = deps.terminalManager.spawn(body.cwd, body.cols, body.rows, {
      containerId: body.containerId,
    });
    return c.json({ terminalId });
  });

  api.post("/terminal/kill", async (c) => {
    const body = await c.req.json<{ terminalId?: string }>().catch(() => undefined);
    const terminalId = body?.terminalId?.trim();
    if (!terminalId) return c.json({ error: "terminalId is required" }, 400);
    deps.terminalManager.kill(terminalId);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/message", async (c) => {
    const id = c.req.param("id");
    const session = deps.launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!deps.launcher.isAlive(id)) return c.json({ error: "Session is not running" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    deps.wsBridge.injectUserMessage(id, body.content);
    return c.json({ ok: true, sessionId: id });
  });
}
