import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { execSync } from "node:child_process";
import { resolveBinary } from "./path-resolver.js";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { TerminalManager } from "./terminal-manager.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import * as sessionLinearIssues from "./session-linear-issues.js";
import { containerManager, ContainerManager, type ContainerConfig, type ContainerInfo } from "./container-manager.js";
import type { CreationStepId } from "./session-types.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { imagePullManager } from "./image-pull-manager.js";
import { registerFsRoutes } from "./routes/fs-routes.js";
import { registerSkillRoutes } from "./routes/skills-routes.js";
import { registerEnvRoutes } from "./routes/env-routes.js";
import { registerCronRoutes } from "./routes/cron-routes.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerPromptRoutes } from "./routes/prompt-routes.js";
import { registerSettingsRoutes } from "./routes/settings-routes.js";
import { registerGitRoutes } from "./routes/git-routes.js";
import { registerSystemRoutes } from "./routes/system-routes.js";
import { registerLinearRoutes, transitionLinearIssue, fetchLinearTeamStates } from "./routes/linear-routes.js";
import { getSettings } from "./settings-manager.js";
import { discoverClaudeSessions } from "./claude-session-discovery.js";
import { getClaudeSessionHistoryPage } from "./claude-session-history.js";
import { verifyToken, getToken, getLanAddress, regenerateToken, getAllAddresses } from "./auth-manager.js";
import QRCode from "qrcode";

const UPDATE_CHECK_STALE_MS = 5 * 60 * 1000;
const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = dirname(ROUTES_DIR);
const VSCODE_EDITOR_CONTAINER_PORT = 13337;
const CODEX_APP_SERVER_CONTAINER_PORT = Number(process.env.COMPANION_CODEX_CONTAINER_WS_PORT || "4502");
const VSCODE_EDITOR_HOST_PORT = Number(process.env.COMPANION_EDITOR_PORT || "13338");

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createRoutes(
  launcher: CliLauncher,
  wsBridge: WsBridge,
  sessionStore: SessionStore,
  worktreeTracker: WorktreeTracker,
  terminalManager: TerminalManager,
  prPoller?: import("./pr-poller.js").PRPoller,
  recorder?: import("./recorder.js").RecorderManager,
  cronScheduler?: import("./cron-scheduler.js").CronScheduler,
  agentExecutor?: import("./agent-executor.js").AgentExecutor,
) {
  const api = new Hono();

  // ─── Auth endpoints (exempt from auth middleware) ──────────────────

  api.post("/auth/verify", async (c) => {
    const body = await c.req.json().catch(() => ({} as { token?: string }));
    if (verifyToken(body.token)) {
      // Set cookie so the dynamic manifest can embed the token in start_url.
      // This bridges auth from Safari to standalone PWA on iOS (isolated storage).
      setCookie(c, "companion_auth", body.token!, {
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        maxAge: 365 * 24 * 60 * 60,
      });
      return c.json({ ok: true });
    }
    return c.json({ error: "Invalid token" }, 401);
  });

  api.get("/auth/qr", async (c) => {
    // QR endpoint requires auth — only authenticated users can generate QR for mobile
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!isLocalhostRequest(c) && !verifyToken(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const port = Number(process.env.PORT) || (process.env.NODE_ENV === "production" ? 3456 : 3457);
    const authToken = getToken();

    // Build QR codes for each remote address (skip localhost — it auto-auths).
    // Each QR encodes the full login URL so the native iPhone Camera app can
    // open it directly: scan → tap popup → Safari opens → auto-authenticated.
    const addresses = getAllAddresses().filter((a) => a.ip !== "localhost");
    const qrCodes = await Promise.all(
      addresses.map(async (a) => {
        const loginUrl = `http://${a.ip}:${port}/?token=${authToken}`;
        const qrDataUrl = await QRCode.toDataURL(loginUrl, { width: 256, margin: 2 });
        return { label: a.label, url: `http://${a.ip}:${port}`, qrDataUrl };
      }),
    );

    return c.json({ qrCodes });
  });

  // ─── Localhost auto-auth (exempt from auth middleware) ────────────
  // Localhost users are on the same machine as the server, so they can
  // auto-authenticate without a token. This makes first-launch seamless.

  // Check if the request comes from localhost (same machine as the server).
  // Uses Bun's requestIP which returns the actual TCP source address.
  // Returns false in test environments where c.env is not a Bun server.
  function isLocalhostRequest(c: { env: unknown; req: { raw: Request } }): boolean {
    const bunServer = c.env as { requestIP?: (req: Request) => { address: string } | null };
    const ip = bunServer?.requestIP?.(c.req.raw);
    const addr = ip?.address ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  api.get("/auth/auto", (c) => {
    if (isLocalhostRequest(c)) {
      const token = getToken();
      setCookie(c, "companion_auth", token, {
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        maxAge: 365 * 24 * 60 * 60,
      });
      return c.json({ ok: true, token });
    }
    return c.json({ ok: false });
  });

  // ─── Auth middleware (protects all routes below) ───────────────────

  api.use("/*", async (c, next) => {
    // Skip auth for the verify endpoint (handled above)
    if (c.req.path === "/auth/verify") {
      return next();
    }

    // Localhost bypass — same machine as the server, always trusted
    if (isLocalhostRequest(c)) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!verifyToken(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  // ─── Auth management (protected) ──────────────────────────────────

  api.get("/auth/token", (c) => {
    return c.json({ token: getToken() });
  });

  api.post("/auth/regenerate", (c) => {
    const token = regenerateToken();
    return c.json({ token });
  });

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const resumeSessionAt = typeof body.resumeSessionAt === "string" && body.resumeSessionAt.trim()
        ? body.resumeSessionAt.trim()
        : undefined;
      const forkSession = body.forkSession === true;
      const backend = body.backend ?? "claude";
      if (backend !== "claude" && backend !== "codex" && backend !== "copilot") {
        return c.json({ error: `Invalid backend: ${String(backend)}` }, 400);
      }

      // Resolve environment variables from envSlug
      let envVars: Record<string, string> | undefined = body.env;
      const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug) : null;
      if (body.envSlug && companionEnv) {
        console.log(
          `[routes] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
          Object.keys(companionEnv.variables).join(", "),
        );
        envVars = { ...companionEnv.variables, ...body.env };
      } else if (body.envSlug) {
        console.warn(
          `[routes] Environment "${body.envSlug}" not found, ignoring`,
        );
      }

      // Resolve Docker image early so we know whether git ops should run on host or in container
      let effectiveImage = companionEnv
        ? (body.envSlug ? envManager.getEffectiveImage(body.envSlug) : null)
        : (body.container?.image || null);
      const isDockerSession = !!effectiveImage;

      let cwd = body.cwd;
      let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string } | undefined;

      // Validate branch name to prevent command injection via shell metacharacters
      if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
        return c.json({ error: "Invalid branch name" }, 400);
      }

      // For Docker sessions, skip host git ops — they'll run inside the container after workspace copy.
      // For non-Docker sessions, run git ops on the host as before.
      if (!isDockerSession && body.useWorktree && body.branch && cwd) {
        // Worktree isolation: create/reuse a worktree for the selected branch
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          // Fetch latest remote refs so ensureWorktree bases new branches on up-to-date origin/{defaultBranch}
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[routes] git fetch failed (non-fatal): ${fetchResult.output}`);
          }

          const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch, {
            baseBranch: repoInfo.defaultBranch,
            createBranch: body.createBranch,
            forceNew: true,
          });
          cwd = result.worktreePath;
          worktreeInfo = {
            isWorktree: true,
            repoRoot: repoInfo.repoRoot,
            branch: body.branch,
            actualBranch: result.actualBranch,
            worktreePath: result.worktreePath,
          };
        }
      } else if (!isDockerSession && body.branch && cwd) {
        // Non-worktree: checkout the selected branch in-place (lightweight)
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[routes] git fetch failed (non-fatal): ${fetchResult.output}`);
          }

          if (repoInfo.currentBranch !== body.branch) {
            gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch, {
              createBranch: body.createBranch,
              defaultBranch: repoInfo.defaultBranch,
            });
          }

          const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
          if (!pullResult.success) {
            console.warn(`[routes] git pull warning (non-fatal): ${pullResult.output}`);
          }
        }
      }

      let containerInfo: ContainerInfo | undefined;
      let containerId: string | undefined;
      let containerName: string | undefined;
      let containerImage: string | undefined;

      // Containers cannot use host keychain auth.
      // Fail fast with a clear error when no container-compatible auth is present.
      if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
        return c.json({
          error:
            "Containerized Claude requires auth available inside the container. " +
            "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
        }, 400);
      }
      if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
        return c.json({
          error:
            "Containerized Codex requires auth available inside the container. " +
            "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
        }, 400);
      }

      // Create container if a Docker image is available.
      // Do not silently fall back to host execution: if container startup fails,
      // return an explicit error.
      if (effectiveImage) {
        if (!imagePullManager.isReady(effectiveImage)) {
          // Image not available — use the pull manager to get it
          const pullState = imagePullManager.getState(effectiveImage);
          if (pullState.status === "idle" || pullState.status === "error") {
            imagePullManager.ensureImage(effectiveImage);
          }
          const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
          if (!ready) {
            const state = imagePullManager.getState(effectiveImage);
            return c.json({
              error: state.error
                || `Docker image ${effectiveImage} could not be pulled or built. Use the environment manager to pull/build the image first.`,
            }, 503);
          }
        }

        const tempId = crypto.randomUUID().slice(0, 8);
        const requestedPorts = companionEnv?.ports
          ?? (Array.isArray(body.container?.ports)
            ? body.container.ports.map(Number).filter((n: number) => n > 0)
            : []);
        const containerPorts = Array.from(
          new Set([
            ...requestedPorts,
            VSCODE_EDITOR_CONTAINER_PORT,
            ...(backend === "codex" ? [CODEX_APP_SERVER_CONTAINER_PORT] : []),
          ]),
        );
        const cConfig: ContainerConfig = {
          image: effectiveImage,
          ports: containerPorts,
          volumes: companionEnv?.volumes ?? body.container?.volumes,
          env: envVars,
        };
        try {
          containerInfo = containerManager.createContainer(tempId, cwd, cConfig);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return c.json({
            error:
              `Docker is required to run this environment image (${effectiveImage}) ` +
              `but container startup failed: ${reason}`,
          }, 503);
        }
        containerId = containerInfo.containerId;
        containerName = containerInfo.name;
        containerImage = effectiveImage;

        // Copy workspace files into the container's isolated volume
        try {
          await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd);
          containerManager.reseedGitAuth(containerInfo.containerId);
        } catch (err) {
          containerManager.removeContainer(tempId);
          const reason = err instanceof Error ? err.message : String(err);
          return c.json({
            error: `Failed to copy workspace to container: ${reason}`,
          }, 503);
        }

        // Run git fetch/checkout/pull inside the container (instead of on host)
        if (body.branch) {
          const repoInfo = cwd ? gitUtils.getRepoInfo(cwd) : null;
          const gitResult = containerManager.gitOpsInContainer(containerInfo.containerId, {
            branch: body.branch,
            currentBranch: repoInfo?.currentBranch || "HEAD",
            createBranch: body.createBranch,
            defaultBranch: repoInfo?.defaultBranch,
          });
          if (gitResult.errors.length > 0) {
            console.warn(`[routes] In-container git ops warnings: ${gitResult.errors.join("; ")}`);
          }
          if (!gitResult.checkoutOk) {
            containerManager.removeContainer(tempId);
            return c.json({
              error: `Failed to checkout branch "${body.branch}" inside container: ${gitResult.errors.join("; ")}`,
            }, 400);
          }
        }

        // Run per-environment init script if configured
        if (companionEnv?.initScript?.trim()) {
          try {
            console.log(`[routes] Running init script for env "${companionEnv.name}" in container ${containerInfo.name}...`);
            const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
            const result = await containerManager.execInContainerAsync(
              containerInfo.containerId,
              ["sh", "-lc", companionEnv.initScript],
              { timeout: initTimeout },
            );
            if (result.exitCode !== 0) {
              console.error(
                `[routes] Init script failed for env "${companionEnv.name}" (exit ${result.exitCode}):\n${result.output}`,
              );
              containerManager.removeContainer(tempId);
              const truncated = result.output.length > 2000
                ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
                : result.output;
              return c.json({
                error: `Init script failed (exit ${result.exitCode}):\n${truncated}`,
              }, 503);
            }
            console.log(`[routes] Init script completed successfully for env "${companionEnv.name}"`);
          } catch (e) {
            containerManager.removeContainer(tempId);
            const reason = e instanceof Error ? e.message : String(e);
            return c.json({
              error: `Init script execution failed: ${reason}`,
            }, 503);
          }
        }
      }

      const session = launcher.launch({
        model: body.model,
        permissionMode: body.permissionMode,
        cwd,
        claudeBinary: body.claudeBinary,
        codexBinary: body.codexBinary,
        codexInternetAccess: backend === "codex",
        codexSandbox: backend === "codex" ? "danger-full-access" : undefined,
        allowedTools: body.allowedTools,
        env: envVars,
        backendType: backend,
        containerId,
        containerName,
        containerImage,
        containerCwd: containerInfo?.containerCwd,
        resumeSessionAt,
        forkSession,
      });

      // Re-track container with real session ID and mark session as containerized
      // so the bridge preserves the host cwd for sidebar grouping
      if (containerInfo) {
        containerManager.retrack(containerInfo.containerId, session.sessionId);
        wsBridge.markContainerized(session.sessionId, cwd);
      }

      // Track the worktree mapping
      if (worktreeInfo) {
        worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── SSE Session Creation (with progress streaming) ─────────────────────

  api.post("/sessions/create-stream", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    const emitProgress = (
      stream: SSEStreamingApi,
      step: CreationStepId,
      label: string,
      status: "in_progress" | "done" | "error",
      detail?: string,
    ) =>
      stream.writeSSE({
        event: "progress",
        data: JSON.stringify({ step, label, status, detail }),
      });

    return streamSSE(c, async (stream) => {
      try {
        const resumeSessionAt = typeof body.resumeSessionAt === "string" && body.resumeSessionAt.trim()
          ? body.resumeSessionAt.trim()
          : undefined;
        const forkSession = body.forkSession === true;
        const backend = body.backend ?? "claude";
        if (backend !== "claude" && backend !== "codex" && backend !== "copilot") {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: `Invalid backend: ${String(backend)}` }),
          });
          return;
        }

        // --- Step: Resolve environment ---
        await emitProgress(stream, "resolving_env", "Resolving environment...", "in_progress");

        let envVars: Record<string, string> | undefined = body.env;
        const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug) : null;
        if (body.envSlug && companionEnv) {
          envVars = { ...companionEnv.variables, ...body.env };
        }

        // Resolve Docker image early so we know whether git ops should run on host or in container
        let effectiveImage = companionEnv
          ? (body.envSlug ? envManager.getEffectiveImage(body.envSlug) : null)
          : (body.container?.image || null);
        const isDockerSession = !!effectiveImage;

        await emitProgress(stream, "resolving_env", "Environment resolved", "done");

        let cwd = body.cwd;
        let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string } | undefined;

        // Validate branch name
        if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: "Invalid branch name", step: "checkout_branch" }),
          });
          return;
        }

        // --- Step: Git operations (host only — Docker sessions do this inside the container) ---
        if (!isDockerSession && body.useWorktree && body.branch && cwd) {
          const repoInfo = gitUtils.getRepoInfo(cwd);
          if (repoInfo) {
            // Fetch latest remote refs so ensureWorktree bases new branches on up-to-date origin/{defaultBranch}
            await emitProgress(stream, "fetching_git", "Fetching from remote...", "in_progress");
            const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
            if (!fetchResult.success) {
              console.warn(`[routes] git fetch failed (non-fatal): ${fetchResult.output}`);
            }
            await emitProgress(stream, "fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

            await emitProgress(stream, "creating_worktree", "Creating worktree...", "in_progress");
            const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch, {
              baseBranch: repoInfo.defaultBranch,
              createBranch: body.createBranch,
              forceNew: true,
            });
            cwd = result.worktreePath;
            worktreeInfo = {
              isWorktree: true,
              repoRoot: repoInfo.repoRoot,
              branch: body.branch,
              actualBranch: result.actualBranch,
              worktreePath: result.worktreePath,
            };
          }
          await emitProgress(stream, "creating_worktree", "Worktree ready", "done");
        } else if (!isDockerSession && body.branch && cwd) {
          const repoInfo = gitUtils.getRepoInfo(cwd);
          if (repoInfo) {
            await emitProgress(stream, "fetching_git", "Fetching from remote...", "in_progress");
            const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
            if (!fetchResult.success) {
              console.warn(`[routes] git fetch failed (non-fatal): ${fetchResult.output}`);
            }
            await emitProgress(stream, "fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

            if (repoInfo.currentBranch !== body.branch) {
              await emitProgress(stream, "checkout_branch", `Checking out ${body.branch}...`, "in_progress");
              gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch, {
                createBranch: body.createBranch,
                defaultBranch: repoInfo.defaultBranch,
              });
              await emitProgress(stream, "checkout_branch", `On branch ${body.branch}`, "done");
            }

            await emitProgress(stream, "pulling_git", "Pulling latest changes...", "in_progress");
            const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
            if (!pullResult.success) {
              console.warn(`[routes] git pull warning (non-fatal): ${pullResult.output}`);
            }
            await emitProgress(stream, "pulling_git", "Up to date", "done");
          }
        }

        let containerInfo: ContainerInfo | undefined;
        let containerId: string | undefined;
        let containerName: string | undefined;
        let containerImage: string | undefined;

        // Auth check for containerized sessions
        if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              error:
                "Containerized Claude requires auth available inside the container. " +
                "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
            }),
          });
          return;
        }
        if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              error:
                "Containerized Codex requires auth available inside the container. " +
                "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
            }),
          });
          return;
        }

        if (effectiveImage) {
          if (!imagePullManager.isReady(effectiveImage)) {
            // Image not available — wait for background pull with progress streaming
            const pullState = imagePullManager.getState(effectiveImage);
            if (pullState.status === "idle" || pullState.status === "error") {
              imagePullManager.ensureImage(effectiveImage);
            }

            await emitProgress(stream, "pulling_image", "Pulling Docker image...", "in_progress");

            // Stream pull progress lines to the client
            const unsub = imagePullManager.onProgress(effectiveImage, (line) => {
              emitProgress(stream, "pulling_image", "Pulling Docker image...", "in_progress", line).catch(() => {});
            });

            const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
            unsub();

            if (ready) {
              await emitProgress(stream, "pulling_image", "Image ready", "done");
            } else {
              const state = imagePullManager.getState(effectiveImage);
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  error: state.error
                    || `Docker image ${effectiveImage} could not be pulled or built. Use the environment manager to pull/build the image first.`,
                  step: "pulling_image",
                }),
              });
              return;
            }
          }

          // --- Step: Create container ---
          await emitProgress(stream, "creating_container", "Starting container...", "in_progress");
          const tempId = crypto.randomUUID().slice(0, 8);
          const requestedPorts = companionEnv?.ports
            ?? (Array.isArray(body.container?.ports)
              ? body.container.ports.map(Number).filter((n: number) => n > 0)
              : []);
          const containerPorts = Array.from(
            new Set([
              ...requestedPorts,
              VSCODE_EDITOR_CONTAINER_PORT,
              ...(backend === "codex" ? [CODEX_APP_SERVER_CONTAINER_PORT] : []),
            ]),
          );
          const cConfig: ContainerConfig = {
            image: effectiveImage,
            ports: containerPorts,
            volumes: companionEnv?.volumes ?? body.container?.volumes,
            env: envVars,
          };
          try {
            containerInfo = containerManager.createContainer(tempId, cwd, cConfig);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                error: `Container startup failed: ${reason}`,
                step: "creating_container",
              }),
            });
            return;
          }
          containerId = containerInfo.containerId;
          containerName = containerInfo.name;
          containerImage = effectiveImage;
          await emitProgress(stream, "creating_container", "Container running", "done");

          // --- Step: Copy workspace into isolated volume ---
          await emitProgress(stream, "copying_workspace", "Copying workspace files...", "in_progress");
          try {
            await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd);
            containerManager.reseedGitAuth(containerInfo.containerId);
            await emitProgress(stream, "copying_workspace", "Workspace copied", "done");
          } catch (err) {
            containerManager.removeContainer(tempId);
            const reason = err instanceof Error ? err.message : String(err);
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                error: `Failed to copy workspace: ${reason}`,
                step: "copying_workspace",
              }),
            });
            return;
          }

          // --- Step: Git operations inside container ---
          if (body.branch) {
            const repoInfo = cwd ? gitUtils.getRepoInfo(cwd) : null;

            await emitProgress(stream, "fetching_git", "Fetching from remote (in container)...", "in_progress");
            const gitResult = containerManager.gitOpsInContainer(containerInfo.containerId, {
              branch: body.branch,
              currentBranch: repoInfo?.currentBranch || "HEAD",
              createBranch: body.createBranch,
              defaultBranch: repoInfo?.defaultBranch,
            });
            await emitProgress(stream, "fetching_git", gitResult.fetchOk ? "Fetch complete" : "Fetch skipped", "done");

            if (repoInfo?.currentBranch !== body.branch) {
              await emitProgress(stream, "checkout_branch",
                gitResult.checkoutOk ? `On branch ${body.branch}` : `Checkout failed`,
                gitResult.checkoutOk ? "done" : "error",
              );
            }

            await emitProgress(stream, "pulling_git", gitResult.pullOk ? "Up to date" : "Pull skipped", "done");

            if (gitResult.errors.length > 0) {
              console.warn(`[routes] In-container git ops warnings: ${gitResult.errors.join("; ")}`);
            }
            if (!gitResult.checkoutOk) {
              containerManager.removeContainer(tempId);
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  error: `Failed to checkout branch "${body.branch}" inside container: ${gitResult.errors.join("; ")}`,
                  step: "checkout_branch",
                }),
              });
              return;
            }
          }

          // --- Step: Init script ---
          if (companionEnv?.initScript?.trim()) {
            await emitProgress(stream, "running_init_script", "Running init script...", "in_progress");
            try {
              const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
              const result = await containerManager.execInContainerAsync(
                containerInfo.containerId,
                ["sh", "-lc", companionEnv.initScript],
                {
                  timeout: initTimeout,
                  onOutput: (line) => {
                    emitProgress(stream, "running_init_script", "Running init script...", "in_progress", line).catch(() => {});
                  },
                },
              );
              if (result.exitCode !== 0) {
                console.error(
                  `[routes] Init script failed for env "${companionEnv.name}" (exit ${result.exitCode}):\n${result.output}`,
                );
                containerManager.removeContainer(tempId);
                const truncated = result.output.length > 2000
                  ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
                  : result.output;
                await stream.writeSSE({
                  event: "error",
                  data: JSON.stringify({
                    error: `Init script failed (exit ${result.exitCode}):\n${truncated}`,
                    step: "running_init_script",
                  }),
                });
                return;
              }
              await emitProgress(stream, "running_init_script", "Init script complete", "done");
            } catch (e) {
              containerManager.removeContainer(tempId);
              const reason = e instanceof Error ? e.message : String(e);
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  error: `Init script execution failed: ${reason}`,
                  step: "running_init_script",
                }),
              });
              return;
            }
          }
        }

        // --- Step: Launch CLI ---
        const launchLabel = backend === "copilot" ? "Launching GitHub Copilot..." : backend === "codex" ? "Launching Codex..." : "Launching Claude Code...";
        await emitProgress(stream, "launching_cli", launchLabel, "in_progress");

        const session = launcher.launch({
          model: body.model,
          permissionMode: body.permissionMode,
          cwd,
          claudeBinary: body.claudeBinary,
          codexBinary: body.codexBinary,
          codexInternetAccess: backend === "codex",
          codexSandbox: backend === "codex" ? "danger-full-access" : undefined,
          allowedTools: body.allowedTools,
          env: envVars,
          backendType: backend,
          containerId,
          containerName,
          containerImage,
          containerCwd: containerInfo?.containerCwd,
          resumeSessionAt,
          forkSession,
        });

        // Re-track container and mark session as containerized
        if (containerInfo) {
          containerManager.retrack(containerInfo.containerId, session.sessionId);
          wsBridge.markContainerized(session.sessionId, cwd);
        }

        // Track worktree mapping
        if (worktreeInfo) {
          worktreeTracker.addMapping({
            sessionId: session.sessionId,
            repoRoot: worktreeInfo.repoRoot,
            branch: worktreeInfo.branch,
            actualBranch: worktreeInfo.actualBranch,
            worktreePath: worktreeInfo.worktreePath,
            createdAt: Date.now(),
          });
        }

        await emitProgress(stream, "launching_cli", "Session started", "done");

        // --- Done ---
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            sessionId: session.sessionId,
            state: session.state,
            cwd: session.cwd,
            backendType: session.backendType,
            resumeSessionAt: session.resumeSessionAt,
            forkSession: session.forkSession,
          }),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[routes] Failed to create session (stream):", msg);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: msg }),
        });
      }
    });
  });

  api.get("/sessions", (c) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((s) => [s.session_id, s]));
    const enriched = sessions.map((s) => {
      const bridge = bridgeMap.get(s.sessionId);
      return {
        ...s,
        // Bridge state is the source of truth for runtime cwd updates
        // (notably containerized sessions mapped back to host paths).
        cwd: bridge?.cwd || s.cwd,
        name: names[s.sessionId] ?? s.name,
        gitBranch: bridge?.git_branch || "",
        gitAhead: bridge?.git_ahead || 0,
        gitBehind: bridge?.git_behind || 0,
        totalLinesAdded: bridge?.total_lines_added || 0,
        totalLinesRemoved: bridge?.total_lines_removed || 0,
      };
    });
    return c.json(enriched);
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  api.get("/claude/sessions/discover", (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const sessions = discoverClaudeSessions({ limit });
    return c.json({ sessions });
  });

  api.get("/claude/sessions/:id/history", (c) => {
    const sessionId = c.req.param("id");
    const limitRaw = c.req.query("limit");
    const cursorRaw = c.req.query("cursor");
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    const cursor = cursorRaw !== undefined ? Number(cursorRaw) : undefined;

    const page = getClaudeSessionHistoryPage({
      sessionId,
      limit,
      cursor,
    });
    if (!page) {
      return c.json({ error: "Claude session history not found" }, 404);
    }
    return c.json(page);
  });

  api.post("/sessions/:id/editor/start", async (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // For container sessions, try code-server inside the container first.
    // If unavailable, fall through to host code-server with the host-mapped cwd.
    let hostFallbackCwd = session.cwd;

    if (session.containerId) {
      const container = containerManager.getContainer(id);
      const hasContainerCodeServer = container
        && containerManager.hasBinaryInContainer(container.containerId, "code-server");

      if (container && hasContainerCodeServer) {
        const editorPathSuffix = `?folder=${encodeURIComponent("/workspace")}`;
        const portMapping = container.portMappings.find(
          (p) => p.containerPort === VSCODE_EDITOR_CONTAINER_PORT,
        );
        if (!portMapping) {
          return c.json({
            available: false,
            installed: true,
            mode: "container",
            message: "Container editor port is missing. Start a new session to enable the VS Code editor.",
          });
        }

        try {
          const alive = containerManager.isContainerAlive(container.containerId);
          if (alive === "stopped") {
            containerManager.startContainer(container.containerId);
          } else if (alive === "missing") {
            return c.json({
              available: false,
              installed: true,
              mode: "container",
              message: "Session container no longer exists. Start a new session to use the editor.",
            });
          }

          const startCmd = [
            `if ! pgrep -f ${shellEscapeArg(`code-server.*--bind-addr 0.0.0.0:${VSCODE_EDITOR_CONTAINER_PORT}`)} >/dev/null 2>&1; then`,
            `nohup code-server --auth none --disable-telemetry --bind-addr 0.0.0.0:${VSCODE_EDITOR_CONTAINER_PORT} /workspace >/tmp/companion-code-server.log 2>&1 &`,
            "fi",
          ].join(" ");
          containerManager.execInContainer(container.containerId, ["sh", "-lc", startCmd], 10_000);

          // Wait for code-server to be ready (up to 5s)
          const containerEditorUrl = `http://localhost:${portMapping.hostPort}${editorPathSuffix}`;
          for (let i = 0; i < 25; i++) {
            try {
              const res = await fetch(`http://127.0.0.1:${portMapping.hostPort}/healthz`);
              if (res.ok || res.status === 302 || res.status === 200) break;
            } catch {
              // not ready yet
            }
            await new Promise((r) => setTimeout(r, 200));
          }

          return c.json({
            available: true,
            installed: true,
            mode: "container",
            url: containerEditorUrl,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return c.json({
            available: false,
            installed: true,
            mode: "container",
            message: `Failed to start VS Code editor in container: ${message}`,
          });
        }
      }

      // Container doesn't have code-server — fall through to host code-server
      // using the host-mapped workspace path
      if (container) {
        hostFallbackCwd = container.hostCwd;
      }
    }

    const hostCodeServer = resolveBinary("code-server");
    if (!hostCodeServer) {
      return c.json({
        available: false,
        installed: false,
        mode: "host",
        message: "VS Code editor is not installed. Install it with: brew install code-server",
      });
    }

    const editorPathSuffix = `?folder=${encodeURIComponent(hostFallbackCwd)}`;

    try {
      const companionDir = join(homedir(), ".companion");
      const logFile = join(companionDir, "code-server-host.log");
      const startCmd = [
        `if ! pgrep -f ${shellEscapeArg(`code-server.*--bind-addr 127.0.0.1:${VSCODE_EDITOR_HOST_PORT}`)} >/dev/null 2>&1; then`,
        `nohup ${shellEscapeArg(hostCodeServer)} --auth none --disable-telemetry --bind-addr 127.0.0.1:${VSCODE_EDITOR_HOST_PORT} ${shellEscapeArg(hostFallbackCwd)} >> ${shellEscapeArg(logFile)} 2>&1 &`,
        "fi",
      ].join(" ");
      const startHostCmd = `mkdir -p ${shellEscapeArg(companionDir)} && ${startCmd}`;
      execSync(startHostCmd, { encoding: "utf-8", timeout: 10_000 });

      // Wait for code-server to be ready (up to 5s)
      const editorUrl = `http://localhost:${VSCODE_EDITOR_HOST_PORT}${editorPathSuffix}`;
      for (let i = 0; i < 25; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${VSCODE_EDITOR_HOST_PORT}/healthz`);
          if (res.ok || res.status === 302 || res.status === 200) break;
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      return c.json({
        available: true,
        installed: true,
        mode: "host",
        url: editorUrl,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({
        available: false,
        installed: true,
        mode: "host",
        message: `Failed to start VS Code editor: ${message}`,
      });
    }
  });

  api.patch("/sessions/:id/name", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sessionNames.setName(id, body.name.trim());
    wsBridge.broadcastNameUpdate(id, body.name.trim());
    return c.json({ ok: true, name: body.name.trim() });
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = c.req.param("id");
    const killed = await launcher.kill(id);
    if (!killed)
      return c.json({ error: "Session not found or already exited" }, 404);

    // Clean up container if any
    containerManager.removeContainer(id);

    return c.json({ ok: true });
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = c.req.param("id");
    const result = await launcher.relaunch(id);
    if (!result.ok) {
      const status = result.error?.includes("not found") || result.error?.includes("Session not found") ? 404 : 503;
      return c.json({ error: result.error || "Relaunch failed" }, status);
    }
    return c.json({ ok: true });
  });

  // Kill a background process spawned by a session
  api.post("/sessions/:id/processes/:taskId/kill", async (c) => {
    const sessionId = c.req.param("id");
    const taskId = c.req.param("taskId");

    // Validate taskId to prevent command injection (hex string from Claude Code)
    if (!/^[a-f0-9]+$/i.test(taskId)) {
      return c.json({ error: "Invalid task ID format" }, 400);
    }

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.pid) return c.json({ error: "Session PID unknown" }, 503);

    try {
      const { execFileSync } = await import("node:child_process");
      // The taskId appears in the output file path of the background process,
      // so pkill -f matches it reliably.
      // Use execFileSync (array form) to avoid shell injection — taskId is passed
      // as an argument, never interpolated into a shell string.
      if (session.containerId) {
        containerManager.execInContainer(
          session.containerId,
          ["pkill", "-f", taskId],
          5_000,
        );
      } else {
        try {
          execFileSync("pkill", ["-f", taskId], {
            timeout: 5_000,
            encoding: "utf-8",
          });
        } catch {
          // pkill returns non-zero when no processes matched — that's fine
        }
      }
      return c.json({ ok: true, taskId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Kill failed: ${msg}` }, 500);
    }
  });

  // Kill all background processes for a session
  api.post("/sessions/:id/processes/kill-all", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json().catch(() => ({} as { taskIds?: string[] }));
    const taskIds = Array.isArray(body.taskIds) ? body.taskIds : [];

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.pid) return c.json({ error: "Session PID unknown" }, 503);

    const results: { taskId: string; ok: boolean; error?: string }[] = [];
    const { execSync } = await import("node:child_process");

    for (const taskId of taskIds) {
      if (!/^[a-f0-9]+$/i.test(taskId)) {
        results.push({ taskId, ok: false, error: "Invalid task ID" });
        continue;
      }
      try {
        if (session.containerId) {
          containerManager.execInContainer(
            session.containerId,
            ["sh", "-c", `pkill -f ${shellEscapeArg(taskId)} 2>/dev/null; true`],
            5_000,
          );
        } else {
          execSync(`pkill -f ${shellEscapeArg(taskId)} 2>/dev/null; true`, {
            timeout: 5_000,
            encoding: "utf-8",
          });
        }
        results.push({ taskId, ok: true });
      } catch (e) {
        results.push({ taskId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return c.json({ ok: true, results });
  });

  // Scan for dev-related processes listening on TCP ports
  const DEV_COMMANDS = new Set([
    "node", "bun", "deno", "ts-node", "tsx",
    "python", "python3", "uvicorn", "gunicorn", "flask",
    "ruby", "rails", "puma",
    "go", "air",
    "java", "gradle", "mvn",
    "cargo",
    "php", "php-fpm",
    "dotnet",
    "vite", "next", "nuxt", "remix", "astro",
    "webpack", "esbuild", "rollup", "parcel",
    "tsc",
  ]);
  // System/IDE processes to exclude even if they listen on a port
  const EXCLUDE_COMMANDS = new Set([
    "launchd", "mDNSResponder", "rapportd", "systemd",
    "sshd", "cupsd", "httpd", "nginx", "postgres", "mysqld",
    "Cursor", "Code", "Electron", "WindowServer", "BetterDisplay",
    "com.docker", "Docker", "docker-proxy", "vpnkit",
    "Dropbox", "Creative Cloud", "zoom.us",
    "ControlCenter", "Finder", "loginwindow", "SystemUIServer",
  ]);

  function parseLsofCwd(raw: string): string | undefined {
    // `lsof -Fn` emits records like:
    // p1234\nfcwd\nn/Users/me/project\n
    const match = raw.match(/^n(.+)$/m);
    const cwd = match?.[1]?.trim();
    return cwd || undefined;
  }

  function parsePsStartTime(raw: string): number | undefined {
    const text = raw.trim();
    if (!text) return undefined;
    const ts = Date.parse(text);
    if (!Number.isFinite(ts)) return undefined;
    return ts;
  }

  api.get("/sessions/:id/processes/system", async (c) => {
    const sessionId = c.req.param("id");
    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    try {
      let raw: string;
      if (session.containerId) {
        raw = containerManager.execInContainer(
          session.containerId,
          ["sh", "-c", "lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || ss -tlnp 2>/dev/null || true"],
          5_000,
        );
      } else {
        raw = execSync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true", {
          timeout: 5_000,
          encoding: "utf-8",
        });
      }

      // Parse lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      const lines = raw.trim().split("\n").slice(1); // skip header
      const pidMap = new Map<number, { command: string; ports: Set<number> }>();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        const command = parts[0];
        const pid = parseInt(parts[1], 10);
        if (isNaN(pid)) continue;
        if (EXCLUDE_COMMANDS.has(command)) continue;

        // macOS lsof NAME ends like `TCP *:3000 (LISTEN)`, so the final token is
        // often `(LISTEN)` rather than the address. Parse from the full line.
        const portMatch = line.match(/:(\d+)\s+\(LISTEN\)\s*$/) ?? line.match(/:(\d+)\s*$/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);

        const existing = pidMap.get(pid);
        if (existing) {
          existing.ports.add(port);
        } else {
          pidMap.set(pid, { command, ports: new Set([port]) });
        }
      }

      // Get full command line for each PID
      const processes: {
        pid: number;
        command: string;
        fullCommand: string;
        ports: number[];
        cwd?: string;
        startedAt?: number;
      }[] = [];

      for (const [pid, info] of pidMap) {
        // Skip if command isn't dev-related (check both exact name and prefix)
        const lowerCmd = info.command.toLowerCase();
        const isDev = DEV_COMMANDS.has(lowerCmd)
          || DEV_COMMANDS.has(info.command)
          || [...DEV_COMMANDS].some((d) => lowerCmd.startsWith(d));

        if (!isDev) continue;

        let fullCommand = info.command;
        let cwd: string | undefined;
        let startedAt: number | undefined;
        try {
          if (session.containerId) {
            fullCommand = containerManager.execInContainer(
              session.containerId,
              ["ps", "-p", String(pid), "-o", "args="],
              2_000,
            ).trim();
          } else {
            fullCommand = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
              timeout: 2_000,
              encoding: "utf-8",
            }).trim();
          }
        } catch {
          // Fall back to short command name
        }

        try {
          if (session.containerId) {
            const cwdRaw = containerManager.execInContainer(
              session.containerId,
              ["sh", "-c", `readlink /proc/${pid}/cwd 2>/dev/null || true`],
              2_000,
            ).trim();
            cwd = cwdRaw || undefined;
          } else {
            const cwdRaw = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null || true`, {
              timeout: 2_000,
              encoding: "utf-8",
            });
            cwd = parseLsofCwd(cwdRaw);
          }
        } catch {
          // Best-effort only
        }

        try {
          if (session.containerId) {
            const startRaw = containerManager.execInContainer(
              session.containerId,
              ["sh", "-c", `ps -p ${pid} -o lstart= 2>/dev/null || true`],
              2_000,
            );
            startedAt = parsePsStartTime(startRaw);
          } else {
            const startRaw = execSync(`ps -p ${pid} -o lstart= 2>/dev/null || true`, {
              timeout: 2_000,
              encoding: "utf-8",
            });
            startedAt = parsePsStartTime(startRaw);
          }
        } catch {
          // Best-effort only
        }

        processes.push({
          pid,
          command: info.command,
          fullCommand: fullCommand || info.command,
          ports: [...info.ports].sort((a, b) => a - b),
          cwd,
          startedAt,
        });
      }

      // Sort by port (lowest first)
      processes.sort((a, b) => (a.ports[0] || 0) - (b.ports[0] || 0));

      return c.json({ ok: true, processes });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Scan failed: ${msg}` }, 500);
    }
  });

  // Kill a system process by PID
  api.post("/sessions/:id/processes/system/:pid/kill", async (c) => {
    const sessionId = c.req.param("id");
    const pidStr = c.req.param("pid");
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid) || pid <= 0) {
      return c.json({ error: "Invalid PID" }, 400);
    }

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Safety: don't allow killing the Companion server or Claude CLI process itself
    if (pid === process.pid) {
      return c.json({ error: "Cannot kill the Companion server" }, 403);
    }
    if (session.pid === pid) {
      return c.json({ error: "Use the session kill endpoint to terminate Claude" }, 403);
    }

    try {
      if (session.containerId) {
        containerManager.execInContainer(
          session.containerId,
          ["kill", "-TERM", String(pid)],
          5_000,
        );
      } else {
        process.kill(pid, "SIGTERM");
      }
      return c.json({ ok: true, pid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Kill failed: ${msg}` }, 500);
    }
  });

  api.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    const worktreeResult = cleanupWorktree(id, true);
    prPoller?.unwatch(id);
    sessionLinearIssues.removeLinearIssue(id);
    launcher.removeSession(id);
    wsBridge.closeSession(id);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.get("/sessions/:id/archive-info", async (c) => {
    const id = c.req.param("id");
    const linkedIssue = sessionLinearIssues.getLinearIssue(id);

    if (!linkedIssue) {
      return c.json({ hasLinkedIssue: false, issueNotDone: false });
    }

    const stateType = (linkedIssue.stateType || "").toLowerCase();
    const isDone = stateType === "completed" || stateType === "canceled" || stateType === "cancelled";

    if (isDone) {
      return c.json({
        hasLinkedIssue: true,
        issueNotDone: false,
        issue: {
          id: linkedIssue.id,
          identifier: linkedIssue.identifier,
          stateName: linkedIssue.stateName,
          stateType: linkedIssue.stateType,
          teamId: linkedIssue.teamId,
        },
      });
    }

    // Issue is not done — check if backlog state is available and if archive transition is configured
    const settings = getSettings();
    const linearApiKey = settings.linearApiKey.trim();
    let hasBacklogState = false;
    if (linearApiKey && linkedIssue.teamId) {
      const teams = await fetchLinearTeamStates(linearApiKey);
      const team = teams.find((t) => t.id === linkedIssue.teamId);
      if (team) {
        hasBacklogState = team.states.some((s) => s.type === "backlog");
      }
    }

    return c.json({
      hasLinkedIssue: true,
      issueNotDone: true,
      issue: {
        id: linkedIssue.id,
        identifier: linkedIssue.identifier,
        stateName: linkedIssue.stateName,
        stateType: linkedIssue.stateType,
        teamId: linkedIssue.teamId,
      },
      hasBacklogState,
      archiveTransitionConfigured: settings.linearArchiveTransition && !!settings.linearArchiveTransitionStateId.trim(),
      archiveTransitionStateName: settings.linearArchiveTransitionStateName || undefined,
    });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));

    // ─── Best-effort Linear transition before archive ─────────────────
    let linearTransitionResult: { ok: boolean; skipped?: boolean; error?: string; issue?: { id: string; identifier: string; stateName: string; stateType: string } } | undefined;
    const linearTransition = body.linearTransition as string | undefined;

    if (linearTransition && linearTransition !== "none") {
      const linkedIssue = sessionLinearIssues.getLinearIssue(id);
      if (linkedIssue) {
        const settings = getSettings();
        const linearApiKey = settings.linearApiKey.trim();
        if (linearApiKey) {
          let targetStateId = "";

          if (linearTransition === "backlog" && linkedIssue.teamId) {
            // Resolve backlog state for the issue's team
            const teams = await fetchLinearTeamStates(linearApiKey);
            const team = teams.find((t) => t.id === linkedIssue.teamId);
            const backlogState = team?.states.find((s) => s.type === "backlog");
            if (backlogState) {
              targetStateId = backlogState.id;
            }
          } else if (linearTransition === "configured") {
            targetStateId = settings.linearArchiveTransitionStateId.trim();
          }

          if (targetStateId) {
            try {
              linearTransitionResult = await transitionLinearIssue(linkedIssue.id, targetStateId, linearApiKey);
            } catch {
              linearTransitionResult = { ok: false, error: "Transition failed unexpectedly" };
            }
          } else {
            linearTransitionResult = { ok: true, skipped: true };
          }
        }
      }
    }

    // ─── Existing archive logic ───────────────────────────────────────
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Stop PR polling for this session
    prPoller?.unwatch(id);

    const worktreeResult = cleanupWorktree(id, body.force);
    launcher.setArchived(id, true);
    sessionStore.setArchived(id, true);
    return c.json({ ok: true, worktree: worktreeResult, linearTransition: linearTransitionResult });
  });

  api.post("/sessions/:id/unarchive", (c) => {
    const id = c.req.param("id");
    launcher.setArchived(id, false);
    sessionStore.setArchived(id, false);
    return c.json({ ok: true });
  });

  // ─── Recording Management ──────────────────────────────────

  api.post("/sessions/:id/recording/start", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ recording: false, available: false });
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
      ...recorder.getRecordingStatus(id),
    });
  });

  api.get("/recordings", (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: recorder.listRecordings() });
  });

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    const backends: Array<{ id: string; name: string; available: boolean }> = [];

    backends.push({ id: "claude", name: "Claude Code", available: resolveBinary("claude") !== null });
    backends.push({ id: "codex", name: "Codex", available: resolveBinary("codex") !== null });
    backends.push({ id: "copilot", name: "GitHub Copilot", available: resolveBinary("copilot") !== null });

    return c.json(backends);
  });

  api.get("/backends/:id/models", async (c) => {
    const backendId = c.req.param("id");

    if (backendId === "codex") {
      // Read Codex model list from its local cache file
      const cachePath = join(homedir(), ".codex", "models_cache.json");
      if (!existsSync(cachePath)) {
        return c.json({ error: "Codex models cache not found. Run codex once to populate it." }, 404);
      }
      try {
        const raw = readFileSync(cachePath, "utf-8");
        const cache = JSON.parse(raw) as {
          models: Array<{
            slug: string;
            display_name?: string;
            description?: string;
            visibility?: string;
            priority?: number;
          }>;
        };
        // Only return visible models, sorted by priority
        const models = cache.models
          .filter((m) => m.visibility === "list")
          .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
          .map((m) => ({
            value: m.slug,
            label: m.display_name || m.slug,
            description: m.description || "",
          }));
        return c.json(models);
      } catch (e) {
        return c.json({ error: "Failed to parse Codex models cache" }, 500);
      }
    }

    if (backendId === "copilot") {
      // Fetch available models from the Copilot ACP initialize response
      const copilotBin = resolveBinary("copilot");
      if (!copilotBin) {
        return c.json({ error: "Copilot CLI not installed" }, 404);
      }
      try {
        const proc = Bun.spawn([copilotBin, "--acp", "--no-color", "--no-auto-update"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });

        const initMsg = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientInfo: { name: "thecompanion", version: "1.0.0" }, capabilities: {} },
        }) + "\n";
        (proc.stdin as { write(d: Uint8Array): number }).write(new TextEncoder().encode(initMsg));

        const newSessionMsg = JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { mcpServers: [], cwd: process.cwd() },
        }) + "\n";
        (proc.stdin as { write(d: Uint8Array): number }).write(new TextEncoder().encode(newSessionMsg));

        // Read stdout until we get the session/new response (id:2)
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let models: Array<{ value: string; label: string; description: string }> | null = null;

        const timeout = new Promise<null>((r) => setTimeout(() => r(null), 5000));
        const readLoop = (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line) as { id?: number; result?: { models?: { availableModels?: Array<{ modelId: string; name: string; description?: string }> } } };
                if (msg.id === 2 && msg.result?.models?.availableModels) {
                  models = msg.result.models.availableModels.map((m) => ({
                    value: m.modelId,
                    label: m.name || m.modelId,
                    description: m.description || "",
                  }));
                  return models;
                }
              } catch {}
            }
          }
          return null;
        })();

        await Promise.race([readLoop, timeout]);
        proc.kill("SIGTERM");

        if (models) {
          return c.json(models);
        }
        return c.json({ error: "Could not retrieve Copilot models" }, 500);
      } catch (e) {
        return c.json({ error: "Failed to query Copilot models" }, 500);
      }
    }

    // Claude models are hardcoded on the frontend
    return c.json({ error: "Use frontend defaults for this backend" }, 404);
  });

  // ─── Containers ─────────────────────────────────────────────────

  api.get("/containers/status", (c) => {
    const available = containerManager.checkDocker();
    const version = available ? containerManager.getDockerVersion() : null;
    return c.json({ available, version });
  });

  api.get("/containers/images", (c) => {
    const images = containerManager.listImages();
    return c.json(images);
  });

  registerFsRoutes(api);
  registerEnvRoutes(api, { webDir: WEB_DIR });

  registerPromptRoutes(api);
  registerSettingsRoutes(api);

  // ─── Linear ────────────────────────────────────────────────────────

  registerLinearRoutes(api);

  registerGitRoutes(api, prPoller);
  registerSystemRoutes(api, {
    launcher,
    wsBridge,
    terminalManager,
    updateCheckStaleMs: UPDATE_CHECK_STALE_MS,
  });

  registerSkillRoutes(api);
  registerCronRoutes(api, cronScheduler);
  registerAgentRoutes(api, agentExecutor);

  // ─── Worktree cleanup helper ────────────────────────────────────

  function cleanupWorktree(
    sessionId: string,
    force?: boolean,
  ): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
    const mapping = worktreeTracker.getBySession(sessionId);
    if (!mapping) return undefined;

    // Check if other sessions still use this worktree
    if (worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
      worktreeTracker.removeBySession(sessionId);
      return { cleaned: false, path: mapping.worktreePath };
    }

    // Auto-remove if clean, or force-remove if requested
    const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
    if (dirty && !force) {
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    // Delete companion-managed branch if it differs from the user-selected branch
    const branchToDelete =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch
        ? mapping.actualBranch
        : undefined;
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
      force: dirty,
      branchToDelete,
    });
    if (result.removed) {
      worktreeTracker.removeBySession(sessionId);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }

  return api;
}
