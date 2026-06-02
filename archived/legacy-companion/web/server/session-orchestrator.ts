import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { AgentExecutor } from "./agent-executor.js";
import type { BackendType, CreationStepId } from "./session-types.js";
import type { ContainerConfig, ContainerInfo } from "./container-manager.js";
import { containerManager } from "./container-manager.js";
import { imagePullManager } from "./image-pull-manager.js";
import * as envManager from "./env-manager.js";
import * as sandboxManager from "./sandbox-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import * as sessionLinearIssues from "./session-linear-issues.js";
import { getConnection, resolveApiKey } from "./linear-connections.js";
import { buildLinearSystemPrompt } from "./linear-prompt-builder.js";
import { transitionLinearIssue, fetchLinearTeamStates } from "./routes/linear-routes.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { discoverCommandsAndSkills } from "./commands-discovery.js";
import { getSettings } from "./settings-manager.js";
import { generateSessionTitle } from "./auto-namer.js";
import { companionBus } from "./event-bus.js";
import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_AUTO_RELAUNCHES = 3;
const RELAUNCH_GRACE_MS = 10_000;
const RELAUNCH_COOLDOWN_MS = 5_000;
const RECONNECT_GRACE_MS = Number(process.env.COMPANION_RECONNECT_GRACE_MS || "30000");

// Proactive keepalive: base delay before relaunching a crashed CLI (doubles per attempt)
const KEEPALIVE_BASE_DELAY_MS = 3_000;

const VSCODE_EDITOR_CONTAINER_PORT = 13337;
const CODEX_APP_SERVER_CONTAINER_PORT = Number(
  process.env.COMPANION_CODEX_CONTAINER_WS_PORT || "4502",
);
const NOVNC_CONTAINER_PORT = 6080;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionOrchestratorDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  sessionStore: SessionStore;
  worktreeTracker: WorktreeTracker;
  prPoller: {
    watch(sessionId: string, cwd: string, branch: string): void;
    unwatch(sessionId: string): void;
  };
  agentExecutor: AgentExecutor;
}

export interface CreateSessionRequest {
  backend?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  envSlug?: string;
  sandboxEnabled?: boolean;
  sandboxSlug?: string;
  linearConnectionId?: string;
  linearIssue?: unknown;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  container?: { image?: string; ports?: number[]; volumes?: string[] };
  resumeSessionAt?: string;
  forkSession?: boolean;
}

export type CreateSessionResult =
  | { ok: true; session: SdkSessionInfo }
  | { ok: false; error: string; status: number };

export type ProgressCallback = (
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
) => Promise<void>;

export interface ArchiveSessionOptions {
  force?: boolean;
  linearTransition?: string;
}

export interface ArchiveSessionResult {
  ok: boolean;
  worktree?: { cleaned?: boolean; dirty?: boolean; path?: string };
  linearTransition?: {
    ok: boolean;
    skipped?: boolean;
    error?: string;
    issue?: { id: string; identifier: string; stateName: string; stateType: string };
  };
}

export interface DeleteSessionResult {
  ok: boolean;
  worktree?: { cleaned?: boolean; dirty?: boolean; path?: string };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Single entry point for session lifecycle operations: create, resume,
 * reconnect, and terminate. Coordinates between CliLauncher (process
 * management), WsBridge (message routing), and SessionStore (persistence).
 */
export class SessionOrchestrator {
  private launcher: CliLauncher;
  private wsBridge: WsBridge;
  private sessionStore: SessionStore;
  private worktreeTracker: WorktreeTracker;
  private prPoller: SessionOrchestratorDeps["prPoller"];
  private agentExecutor: AgentExecutor;

  // Auto-relaunch state
  private relaunchingSet = new Set<string>();
  private autoRelaunchCounts = new Map<string, number>();
  // Sessions that have already been notified about relaunch exhaustion.
  // Prevents repeated "keeps crashing" warnings for dead sessions.
  private relaunchExhaustedNotified = new Set<string>();

  // Tracks sessions intentionally killed (idle-kill, manual delete/archive)
  // so the proactive keepalive doesn't relaunch them.
  private intentionalKills = new Set<string>();
  // Timers for proactive keepalive relaunches (for cancellation on delete)
  private keepaliveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Idempotency guard for initialize()
  private _initialized = false;

  // Event listeners
  private exitCallbacks: ((sessionId: string, exitCode: number | null) => void)[] = [];

  constructor(deps: SessionOrchestratorDeps) {
    this.launcher = deps.launcher;
    this.wsBridge = deps.wsBridge;
    this.sessionStore = deps.sessionStore;
    this.worktreeTracker = deps.worktreeTracker;
    this.prPoller = deps.prPoller;
    this.agentExecutor = deps.agentExecutor;
  }

  // ── Initialization (event wiring) ──────────────────────────────────────────

  initialize(): void {
    if (this._initialized) return;
    this._initialized = true;

    // When the CLI reports its internal session_id, store it for --resume
    companionBus.on("session:cli-id-received", ({ sessionId, cliSessionId }) => {
      this.launcher.setCLISessionId(sessionId, cliSessionId);
    });

    // When a Codex adapter is created, attach it to the WsBridge
    companionBus.on("backend:codex-adapter-created", ({ sessionId, adapter }) => {
      this.wsBridge.attachBackendAdapter(sessionId, adapter, "codex");
    });

    // When a CLI/Codex process exits, notify agent executor and external listeners
    // separately so a throw in one doesn't skip the other (bus isolates each handler).
    companionBus.on("session:exited", ({ sessionId, exitCode }) => {
      this.agentExecutor.handleSessionExited(sessionId, exitCode);
    });
    companionBus.on("session:exited", ({ sessionId, exitCode }) => {
      for (const cb of this.exitCallbacks) {
        try {
          cb(sessionId, exitCode);
        } catch (err) {
          console.error("[orchestrator] exitCallback error:", err);
        }
      }
    });
    companionBus.on("session:exited", ({ sessionId }) => {
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.transition("terminated", "process_exited");
      }
    });

    // Proactive keepalive: auto-relaunch crashed CLI processes even without
    // a browser connected. This ensures long-running sessions (agents, cron
    // jobs) stay alive. Intentional kills (idle-kill, manual delete/archive)
    // are excluded via the intentionalKills set.
    companionBus.on("session:exited", ({ sessionId }) => {
      this.scheduleProactiveRelaunch(sessionId);
    });

    // Start watching PRs when git info is resolved
    companionBus.on("session:git-info-ready", ({ sessionId, cwd, branch }) => {
      this.prPoller.watch(sessionId, cwd, branch);
    });

    // Auto-relaunch CLI when a browser connects to a session with no CLI
    companionBus.on("session:relaunch-needed", async ({ sessionId }) => {
      await this.handleAutoRelaunch(sessionId);
    });

    // Kill CLI process when idle with no browsers for 24 hours.
    // Only kills the CLI process — containers are preserved so the session
    // can be relaunched without recreating the container.
    companionBus.on("session:idle-kill", async ({ sessionId }) => {
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) return;
      log.info("orchestrator", "Idle-killing session (preserving container)", { sessionId, reason: "no browsers, no activity" });
      this.intentionalKills.add(sessionId);
      // Cancel the CLI disconnect debounce timer so it doesn't fire
      // session:relaunch-needed after we intentionally kill the process.
      this.wsBridge.cancelDisconnectTimer(sessionId);
      await this.launcher.kill(sessionId);
      // Clear relaunch counters so the session gets a fresh budget when the user
      // returns. Idle-kill is intentional cleanup, not a crash — the session
      // should be fully relaunchable.
      this.clearAutoRelaunchCount(sessionId);
    });

    // Auto-generate session title after first turn completes
    companionBus.on("session:first-turn-completed", async ({ sessionId, firstUserMessage }) => {
      await this.handleAutoNaming(sessionId, firstUserMessage);
    });

    // Reconnection watchdog for stale sessions after server restart
    this.startReconnectionWatchdog();
  }

  // ── Session Creation ───────────────────────────────────────────────────────

  async createSession(body: CreateSessionRequest): Promise<CreateSessionResult> {
    return this.doCreateSession(body);
  }

  async createSessionStreaming(
    body: CreateSessionRequest,
    onProgress: ProgressCallback,
  ): Promise<CreateSessionResult> {
    return this.doCreateSession(body, onProgress);
  }

  private async doCreateSession(
    body: CreateSessionRequest,
    onProgress?: ProgressCallback,
  ): Promise<CreateSessionResult> {
    try {
      const resumeSessionAt =
        typeof body.resumeSessionAt === "string" && body.resumeSessionAt.trim()
          ? body.resumeSessionAt.trim()
          : undefined;
      const forkSession = body.forkSession === true;
      const backend = (body.backend ?? "claude") as BackendType;
      if (backend !== "claude" && backend !== "codex") {
        return { ok: false, error: `Invalid backend: ${String(body.backend)}`, status: 400 };
      }

      // --- Step: Resolve environment ---
      if (onProgress) await onProgress("resolving_env", "Resolving environment...", "in_progress");

      let envVars: Record<string, string> | undefined = body.env;
      const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug) : null;
      if (body.envSlug && companionEnv) {
        console.log(
          `[orchestrator] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
          Object.keys(companionEnv.variables).join(", "),
        );
        envVars = { ...companionEnv.variables, ...body.env };
      } else if (body.envSlug) {
        console.warn(`[orchestrator] Environment "${body.envSlug}" not found, ignoring`);
      }

      // Inject provider tokens from global settings (if not already set by env profile).
      // Note: these tokens also flow into containerized sessions intentionally — the
      // global onboarding tokens serve as defaults for all session types, including
      // containers, so that container auth preflight checks pass automatically.
      const globalSettings = getSettings();
      if (backend === "claude" && globalSettings.claudeCodeOAuthToken && !("CLAUDE_CODE_OAUTH_TOKEN" in (envVars ?? {}))) {
        envVars = { ...envVars, CLAUDE_CODE_OAUTH_TOKEN: globalSettings.claudeCodeOAuthToken };
      }
      if (backend === "codex" && globalSettings.openaiApiKey && !("OPENAI_API_KEY" in (envVars ?? {}))) {
        envVars = { ...envVars, OPENAI_API_KEY: globalSettings.openaiApiKey };
      }

      // Resolve sandbox configuration
      const sandboxEnabled = body.sandboxEnabled === true;
      const companionSandbox = body.sandboxSlug ? sandboxManager.getSandbox(body.sandboxSlug) : null;
      if (sandboxEnabled && body.sandboxSlug && !companionSandbox) {
        return { ok: false, error: `Sandbox "${body.sandboxSlug}" not found`, status: 404 };
      }

      // Inject LINEAR_API_KEY if a Linear connection is specified
      let linearSystemPrompt: string | undefined;
      if (body.linearConnectionId) {
        const conn = getConnection(body.linearConnectionId);
        if (conn?.apiKey) {
          envVars = { ...envVars, LINEAR_API_KEY: conn.apiKey };
          linearSystemPrompt = buildLinearSystemPrompt(conn, body.linearIssue as { identifier: string; title: string; stateName: string; teamName: string; url: string } | undefined);
        }
      }

      // Resolve Docker image early
      let effectiveImage: string | null = null;
      if (sandboxEnabled) {
        effectiveImage = "the-companion:latest";
      } else if (body.container?.image) {
        effectiveImage = body.container.image;
      }
      const isDockerSession = !!effectiveImage;

      if (onProgress) await onProgress("resolving_env", "Environment resolved", "done");

      let cwd = body.cwd;
      let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string } | undefined;

      // Validate branch name to prevent command injection
      if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
        return { ok: false, error: "Invalid branch name", status: 400 };
      }

      // --- Step: Git operations (host only) ---
      if (!isDockerSession && body.useWorktree && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          if (onProgress) await onProgress("fetching_git", "Fetching from remote...", "in_progress");
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[orchestrator] git fetch failed (non-fatal): ${fetchResult.output}`);
          }
          if (onProgress) await onProgress("fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

          if (onProgress) await onProgress("creating_worktree", "Creating worktree...", "in_progress");
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
        if (onProgress) await onProgress("creating_worktree", "Worktree ready", "done");
      } else if (!isDockerSession && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          if (onProgress) await onProgress("fetching_git", "Fetching from remote...", "in_progress");
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[orchestrator] git fetch failed (non-fatal): ${fetchResult.output}`);
          }
          if (onProgress) await onProgress("fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

          if (repoInfo.currentBranch !== body.branch) {
            if (onProgress) await onProgress("checkout_branch", `Checking out ${body.branch}...`, "in_progress");
            gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch, {
              createBranch: body.createBranch,
              defaultBranch: repoInfo.defaultBranch,
            });
            if (onProgress) await onProgress("checkout_branch", `On branch ${body.branch}`, "done");
          }

          if (onProgress) await onProgress("pulling_git", "Pulling latest changes...", "in_progress");
          const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
          if (!pullResult.success) {
            console.warn(`[orchestrator] git pull warning (non-fatal): ${pullResult.output}`);
          }
          if (onProgress) await onProgress("pulling_git", "Up to date", "done");
        }
      }

      let containerInfo: ContainerInfo | undefined;
      let containerId: string | undefined;
      let containerName: string | undefined;
      let containerImage: string | undefined;

      // Container auth pre-flight check
      if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
        return {
          ok: false,
          error: "Containerized Claude requires auth available inside the container. " +
            "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
          status: 400,
        };
      }
      if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
        return {
          ok: false,
          error: "Containerized Codex requires auth available inside the container. " +
            "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
          status: 400,
        };
      }

      // --- Step: Container setup ---
      if (effectiveImage) {
        if (!imagePullManager.isReady(effectiveImage)) {
          const pullState = imagePullManager.getState(effectiveImage);
          if (pullState.status === "idle" || pullState.status === "error") {
            imagePullManager.ensureImage(effectiveImage);
          }

          if (onProgress) {
            await onProgress("pulling_image", "Pulling Docker image...", "in_progress");
            const unsub = imagePullManager.onProgress(effectiveImage, (line: string) => {
              onProgress("pulling_image", "Pulling Docker image...", "in_progress", line).catch(() => {});
            });
            const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
            unsub();
            if (ready) {
              await onProgress("pulling_image", "Image ready", "done");
            } else {
              const state = imagePullManager.getState(effectiveImage);
              return {
                ok: false,
                error: state.error || `Docker image ${effectiveImage} could not be pulled or built.`,
                status: 503,
              };
            }
          } else {
            const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
            if (!ready) {
              const state = imagePullManager.getState(effectiveImage);
              return {
                ok: false,
                error: state.error || `Docker image ${effectiveImage} could not be pulled or built.`,
                status: 503,
              };
            }
          }
        }

        // Create container
        if (onProgress) await onProgress("creating_container", "Starting container...", "in_progress");
        const tempId = crypto.randomUUID().slice(0, 8);
        const requestedPorts = Array.isArray(body.container?.ports)
          ? body.container!.ports!.map(Number).filter((n: number) => n > 0)
          : [];
        const containerPorts: (number | { port: number; hostIp?: string })[] = [
          ...Array.from(new Set([
            ...requestedPorts.filter((p: number) => p !== NOVNC_CONTAINER_PORT),
            VSCODE_EDITOR_CONTAINER_PORT,
            ...(backend === "codex" ? [CODEX_APP_SERVER_CONTAINER_PORT] : []),
          ])),
          { port: NOVNC_CONTAINER_PORT, hostIp: "127.0.0.1" },
        ];
        const cConfig: ContainerConfig = {
          image: effectiveImage,
          ports: containerPorts,
          volumes: body.container?.volumes,
          env: { ...(envVars ?? {}), DISPLAY: ":99" },
          privileged: sandboxEnabled && effectiveImage === "the-companion:latest",
        };
        try {
          containerInfo = containerManager.createContainer(tempId, cwd!, cConfig);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: `Docker is required to run this environment image (${effectiveImage}) but container startup failed: ${reason}`,
            status: 503,
          };
        }
        containerId = containerInfo.containerId;
        containerName = containerInfo.name;
        containerImage = effectiveImage;
        if (onProgress) await onProgress("creating_container", "Container running", "done");

        // Copy workspace
        if (onProgress) await onProgress("copying_workspace", "Copying workspace files...", "in_progress");
        try {
          await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd!);
          containerManager.reseedGitAuth(containerInfo.containerId);
          if (onProgress) await onProgress("copying_workspace", "Workspace copied", "done");
        } catch (err) {
          containerManager.removeContainer(tempId);
          const reason = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `Failed to copy workspace to container: ${reason}`, status: 503 };
        }

        // Git operations inside container
        if (body.branch) {
          const repoInfo = cwd ? gitUtils.getRepoInfo(cwd) : null;
          if (onProgress) await onProgress("fetching_git", "Fetching from remote (in container)...", "in_progress");
          const gitResult = containerManager.gitOpsInContainer(containerInfo.containerId, {
            branch: body.branch,
            currentBranch: repoInfo?.currentBranch || "HEAD",
            createBranch: body.createBranch,
            defaultBranch: repoInfo?.defaultBranch,
          });
          if (onProgress) await onProgress("fetching_git", gitResult.fetchOk ? "Fetch complete" : "Fetch skipped", "done");
          if (onProgress && repoInfo?.currentBranch !== body.branch) {
            await onProgress("checkout_branch",
              gitResult.checkoutOk ? `On branch ${body.branch}` : "Checkout failed",
              gitResult.checkoutOk ? "done" : "error",
            );
          }
          if (onProgress) await onProgress("pulling_git", gitResult.pullOk ? "Up to date" : "Pull skipped", "done");
          if (gitResult.errors.length > 0) {
            console.warn(`[orchestrator] In-container git ops warnings: ${gitResult.errors.join("; ")}`);
          }
          if (!gitResult.checkoutOk) {
            containerManager.removeContainer(tempId);
            return {
              ok: false,
              error: `Failed to checkout branch "${body.branch}" inside container: ${gitResult.errors.join("; ")}`,
              status: 400,
            };
          }
        }

        // Init script
        const initScript = companionSandbox?.initScript?.trim();
        if (initScript) {
          if (onProgress) await onProgress("running_init_script", "Running init script...", "in_progress");
          try {
            console.log(`[orchestrator] Running init script for sandbox "${companionSandbox?.name || "sandbox"}" in container ${containerInfo.name}...`);
            const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
            const result = await containerManager.execInContainerAsync(
              containerInfo.containerId,
              ["sh", "-lc", initScript],
              {
                timeout: initTimeout,
                onOutput: onProgress
                  ? (line: string) => { onProgress("running_init_script", "Running init script...", "in_progress", line).catch(() => {}); }
                  : undefined,
              },
            );
            if (result.exitCode !== 0) {
              console.error(`[orchestrator] Init script failed (exit ${result.exitCode}):\n${result.output}`);
              containerManager.removeContainer(tempId);
              const truncated = result.output.length > 2000
                ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
                : result.output;
              return { ok: false, error: `Init script failed (exit ${result.exitCode}):\n${truncated}`, status: 503 };
            }
            if (onProgress) await onProgress("running_init_script", "Init script complete", "done");
            console.log(`[orchestrator] Init script completed successfully for sandbox "${companionSandbox?.name || "sandbox"}"`);
          } catch (e) {
            containerManager.removeContainer(tempId);
            const reason = e instanceof Error ? e.message : String(e);
            return { ok: false, error: `Init script execution failed: ${reason}`, status: 503 };
          }
        }
      }

      // --- Step: Launch CLI ---
      if (onProgress) await onProgress("launching_cli", `Launching ${backend === "codex" ? "Codex" : "Claude Code"}...`, "in_progress");

      let session: SdkSessionInfo;
      try {
        session = this.launcher.launch({
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
          systemPrompt: backend === "codex" ? linearSystemPrompt : undefined,
          sandboxSlug: sandboxEnabled ? (body.sandboxSlug || undefined) : undefined,
        });
      } catch (e) {
        // Clean up container if it was created but launch failed
        if (containerId) containerManager.removeContainer(containerId);
        const reason = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Failed to launch CLI: ${reason}`, status: 503 };
      }

      // Post-launch wiring
      if (containerInfo) {
        containerManager.retrack(containerInfo.containerId, session.sessionId);
        this.wsBridge.markContainerized(session.sessionId, cwd!);
      }

      if (worktreeInfo) {
        this.worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      if (linearSystemPrompt && backend === "claude") {
        this.wsBridge.injectSystemPrompt(session.sessionId, linearSystemPrompt);
      }

      const discovered = await discoverCommandsAndSkills(cwd).catch(() => ({ slash_commands: [] as string[], skills: [] as string[] }));
      this.wsBridge.prePopulateCommands(session.sessionId, discovered.slash_commands, discovered.skills);

      if (onProgress) await onProgress("launching_cli", "Session started", "done");

      metricsCollector.recordSessionCreated(backend);
      metricsCollector.recordSessionSpawned(session.sessionId);

      return { ok: true, session };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("orchestrator", "Failed to create session", { error: msg });
      return { ok: false, error: msg, status: 500 };
    }
  }

  // ── Kill ───────────────────────────────────────────────────────────────────

  async killSession(sessionId: string): Promise<{ ok: boolean }> {
    const killed = await this.launcher.kill(sessionId);
    if (killed) {
      containerManager.removeContainer(sessionId);
    }
    return { ok: killed };
  }

  // ── Relaunch ───────────────────────────────────────────────────────────────

  async relaunchSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) {
      return { ok: false, error: "Session is archived and cannot be relaunched" };
    }
    this.clearAutoRelaunchCount(sessionId);
    const session = this.wsBridge.getSession(sessionId);
    if (session?.stateMachine) {
      session.stateMachine.transition("starting", "relaunch_initiated");
    }
    return this.launcher.relaunch(sessionId);
  }

  // ── Archive ────────────────────────────────────────────────────────────────

  async archiveSession(sessionId: string, options?: ArchiveSessionOptions): Promise<ArchiveSessionResult> {
    let linearTransitionResult: ArchiveSessionResult["linearTransition"];
    const linearTransition = options?.linearTransition;

    if (linearTransition && linearTransition !== "none") {
      const linkedIssue = sessionLinearIssues.getLinearIssue(sessionId);
      if (linkedIssue) {
        const resolved = resolveApiKey(linkedIssue.connectionId);
        if (resolved) {
          const { apiKey: linearApiKey, connectionId: resolvedConnId } = resolved;
          const settings = getSettings();
          const conn = resolvedConnId !== "legacy" ? getConnection(resolvedConnId) : null;
          let targetStateId = "";

          if (linearTransition === "backlog" && linkedIssue.teamId) {
            const teams = await fetchLinearTeamStates(linearApiKey);
            const team = teams.find((t) => t.id === linkedIssue.teamId);
            const backlogState = team?.states.find((s) => s.type === "backlog");
            if (backlogState) targetStateId = backlogState.id;
          } else if (linearTransition === "configured") {
            const archiveStateId = conn ? conn.archiveTransitionStateId : settings.linearArchiveTransitionStateId;
            targetStateId = archiveStateId.trim();
          }

          if (targetStateId) {
            try {
              linearTransitionResult = await transitionLinearIssue(linkedIssue.id, targetStateId, linearApiKey, resolvedConnId);
            } catch {
              linearTransitionResult = { ok: false, error: "Transition failed unexpectedly" };
            }
          } else {
            linearTransitionResult = { ok: true, skipped: true };
          }
        }
      }
    }

    this.intentionalKills.add(sessionId);
    this.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    containerManager.removeContainer(sessionId);
    this.prPoller.unwatch(sessionId);

    const worktreeResult = this.cleanupWorktree(sessionId, options?.force);
    this.launcher.setArchived(sessionId, true);
    this.sessionStore.setArchived(sessionId, true);

    return { ok: true, worktree: worktreeResult, linearTransition: linearTransitionResult };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    this.intentionalKills.add(sessionId);
    this.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    containerManager.removeContainer(sessionId);
    const worktreeResult = this.cleanupWorktree(sessionId, true);
    this.prPoller.unwatch(sessionId);
    sessionLinearIssues.removeLinearIssue(sessionId);
    this.launcher.removeSession(sessionId);
    this.wsBridge.closeSession(sessionId);
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
    this.relaunchingSet.delete(sessionId);
    this.intentionalKills.delete(sessionId);
    return { ok: true, worktree: worktreeResult };
  }

  // ── Unarchive ──────────────────────────────────────────────────────────────

  unarchiveSession(sessionId: string): { ok: boolean } {
    this.launcher.setArchived(sessionId, false);
    this.sessionStore.setArchived(sessionId, false);
    return { ok: true };
  }

  // ── Auto-relaunch count ────────────────────────────────────────────────────

  clearAutoRelaunchCount(sessionId: string): void {
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
  }

  // ── Event registration ─────────────────────────────────────────────────────

  /** Register a callback for session exit events. Returns unsubscribe function. */
  onSessionExited(cb: (sessionId: string, exitCode: number | null) => void): () => void {
    this.exitCallbacks.push(cb);
    return () => {
      const idx = this.exitCallbacks.indexOf(cb);
      if (idx !== -1) this.exitCallbacks.splice(idx, 1);
    };
  }

  // ── Query delegation ───────────────────────────────────────────────────────

  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.launcher.getSession(sessionId);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  shutdown(): void {
    // Timers are owned by the process lifecycle
  }

  // ── Private: Auto-relaunch ─────────────────────────────────────────────────

  private async handleAutoRelaunch(sessionId: string): Promise<void> {
    if (this.relaunchingSet.has(sessionId)) return;
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) return;

    // If we've already notified the user about relaunch exhaustion, bail out
    // silently. Without this, every reconnect event from a dead session
    // (e.g. deleted container) re-logs the "limit reached" warning endlessly.
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    this.relaunchingSet.add(sessionId);

    await new Promise((r) => setTimeout(r, RELAUNCH_GRACE_MS));
    if (this.wsBridge.isCliConnected(sessionId)) { this.relaunchingSet.delete(sessionId); return; }
    const freshInfo = this.launcher.getSession(sessionId);
    if (freshInfo && (freshInfo.state === "connected" || freshInfo.state === "running")) {
      this.relaunchingSet.delete(sessionId); return;
    }
    // Only check PID liveness if the session is NOT already "exited".
    // After idle-kill or explicit kill(), the PID field stays set but the
    // process is dead. If the kernel recycles the PID to a different process,
    // kill(pid, 0) would incorrectly succeed, preventing any relaunch.
    // For containerized sessions, use container liveness instead of PID check
    // (the PID is the `docker exec` wrapper, which exits immediately for some
    // transports and is unreliable for container health).
    if (freshInfo && freshInfo.state !== "exited") {
      if (freshInfo.containerId) {
        const containerState = containerManager.isContainerAlive(freshInfo.containerId);
        if (containerState === "running") {
          this.relaunchingSet.delete(sessionId);
          return;
        }
      } else if (freshInfo.pid) {
        try { process.kill(freshInfo.pid, 0); this.relaunchingSet.delete(sessionId); return; } catch {}
      }
    }

    const count = this.autoRelaunchCounts.get(sessionId) ?? 0;
    if (count >= MAX_AUTO_RELAUNCHES) {
      metricsCollector.recordRelaunchExhausted();
      log.warn("orchestrator", "Auto-relaunch limit reached", { sessionId, maxAttempts: MAX_AUTO_RELAUNCHES });
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: "Session keeps crashing. Please relaunch manually.",
      });
      this.relaunchExhaustedNotified.add(sessionId);
      this.relaunchingSet.delete(sessionId);
      return;
    }

    if (freshInfo && freshInfo.state !== "starting") {
      this.autoRelaunchCounts.set(sessionId, count + 1);
      metricsCollector.recordRelaunchAttempted();
      log.info("orchestrator", "Auto-relaunching CLI", { sessionId, attempt: count + 1, maxAttempts: MAX_AUTO_RELAUNCHES });
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.transition("starting", "relaunch_initiated");
      }
      try {
        const result = await this.launcher.relaunch(sessionId);
        if (!result.ok && result.error) {
          this.wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
        } else if (result.ok) {
          metricsCollector.recordRelaunchSucceeded();
          this.autoRelaunchCounts.delete(sessionId);
          this.relaunchExhaustedNotified.delete(sessionId);
          // Clear intentionalKills so future crashes can use proactive keepalive.
          // After a successful relaunch, the session is alive again — any prior
          // idle-kill intent no longer applies.
          this.intentionalKills.delete(sessionId);
        }
        // ok=false without error: keep count to preserve the retry budget
      } finally {
        setTimeout(() => this.relaunchingSet.delete(sessionId), RELAUNCH_COOLDOWN_MS);
      }
    } else {
      this.relaunchingSet.delete(sessionId);
    }
  }

  // ── Private: Proactive keepalive ────────────────────────────────────────────

  /**
   * Schedules a proactive relaunch of a crashed CLI process, regardless of
   * whether any browsers are connected. Uses exponential backoff (3s, 6s, 12s)
   * based on the auto-relaunch attempt count.
   *
   * Skips relaunch for:
   * - Intentional kills (idle-kill, manual delete/archive)
   * - Archived sessions
   * - Sessions that have exhausted their relaunch budget
   */
  private scheduleProactiveRelaunch(sessionId: string): void {
    // Skip if this was an intentional kill. Use has() instead of delete() so
    // the guard is preserved for handleAutoRelaunch (debounce path fires later).
    if (this.intentionalKills.has(sessionId)) return;

    const info = this.launcher.getSession(sessionId);
    if (!info || info.archived) return;

    // Skip if already at relaunch limit
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    // Skip if a relaunch is already in progress (e.g. triggered by browser reconnect)
    if (this.relaunchingSet.has(sessionId)) return;

    // Exponential backoff: 3s → 6s → 12s based on attempt count
    const attempt = this.autoRelaunchCounts.get(sessionId) ?? 0;
    const delay = KEEPALIVE_BASE_DELAY_MS * Math.pow(2, attempt);

    log.info("orchestrator", "Scheduling proactive keepalive relaunch", {
      sessionId,
      attempt: attempt + 1,
      maxAttempts: MAX_AUTO_RELAUNCHES,
      delayMs: delay,
    });

    // Cancel any existing keepalive timer for this session
    this.cancelKeepaliveTimer(sessionId);

    const timer = setTimeout(async () => {
      this.keepaliveTimers.delete(sessionId);

      // Re-check conditions — state may have changed during the delay
      const freshInfo = this.launcher.getSession(sessionId);
      if (!freshInfo || freshInfo.archived) return;
      if (freshInfo.state === "connected" || freshInfo.state === "running") return;

      // Delegate to the existing auto-relaunch mechanism which handles
      // budget, PID checks, state transitions, and cooldowns.
      await this.handleAutoRelaunch(sessionId);
    }, delay);

    this.keepaliveTimers.set(sessionId, timer);
  }

  private cancelKeepaliveTimer(sessionId: string): void {
    const timer = this.keepaliveTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.keepaliveTimers.delete(sessionId);
    }
  }

  // ── Private: Auto-naming ───────────────────────────────────────────────────

  private async handleAutoNaming(sessionId: string, firstUserMessage: string): Promise<void> {
    if (sessionNames.getName(sessionId)) return;
    if (!getSettings().anthropicApiKey.trim()) return;
    const info = this.launcher.getSession(sessionId);
    const model = info?.model || "claude-sonnet-4-6";
    console.log(`[orchestrator] Auto-naming session ${sessionId} via Anthropic with model ${model}...`);
    const title = await generateSessionTitle(firstUserMessage, model);
    if (title && !sessionNames.getName(sessionId)) {
      console.log(`[orchestrator] Auto-named session ${sessionId}: "${title}"`);
      sessionNames.setName(sessionId, title);
      this.wsBridge.broadcastNameUpdate(sessionId, title);
    }
  }

  // ── Private: Reconnection watchdog ─────────────────────────────────────────

  private startReconnectionWatchdog(): void {
    const starting = this.launcher.getStartingSessions();
    if (starting.length > 0) {
      console.log(`[orchestrator] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
      setTimeout(async () => {
        const stale = this.launcher.getStartingSessions();
        for (const info of stale) {
          if (info.archived) continue;
          console.log(`[orchestrator] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
          await this.launcher.relaunch(info.sessionId);
        }
      }, RECONNECT_GRACE_MS);
    }
  }

  // ── Private: Worktree cleanup ──────────────────────────────────────────────

  private cleanupWorktree(
    sessionId: string,
    force?: boolean,
  ): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
    const mapping = this.worktreeTracker.getBySession(sessionId);
    if (!mapping) return undefined;

    if (this.worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
      this.worktreeTracker.removeBySession(sessionId);
      return { cleaned: false, path: mapping.worktreePath };
    }

    const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
    if (dirty && !force) {
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    const branchToDelete =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch
        ? mapping.actualBranch
        : undefined;
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
      force: dirty,
      branchToDelete,
    });
    if (result.removed) {
      this.worktreeTracker.removeBySession(sessionId);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }
}
