import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { CreationStepId } from "./session-types.js";
import type { ContainerConfig, ContainerInfo } from "./container-manager.js";
import * as envManager from "./env-manager.js";
import * as sandboxManager from "./sandbox-manager.js";
import * as gitUtils from "./git-utils.js";
import { containerManager } from "./container-manager.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { imagePullManager } from "./image-pull-manager.js";
import { getConnection } from "./linear-connections.js";
import { buildLinearSystemPrompt } from "./linear-prompt-builder.js";
import { discoverCommandsAndSkills } from "./commands-discovery.js";
import { VSCODE_EDITOR_CONTAINER_PORT, CODEX_APP_SERVER_CONTAINER_PORT, NOVNC_CONTAINER_PORT } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProgressCallback = (
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
) => Promise<void>;

export interface SessionCreationDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  worktreeTracker: WorktreeTracker;
}

export interface SessionCreationResult {
  session: SdkSessionInfo;
}

export class SessionCreationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly step?: CreationStepId,
  ) {
    super(message);
    this.name = "SessionCreationError";
  }
}

// ---------------------------------------------------------------------------
// Helper: emit progress if a callback is provided (no-op otherwise)
// ---------------------------------------------------------------------------

async function emit(
  onProgress: ProgressCallback | undefined,
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
): Promise<void> {
  if (onProgress) {
    await onProgress(step, label, status, detail);
  }
}

// ---------------------------------------------------------------------------
// Main service function
// ---------------------------------------------------------------------------

export async function executeSessionCreation(
  body: Record<string, unknown>,
  deps: SessionCreationDeps,
  onProgress?: ProgressCallback,
): Promise<SessionCreationResult> {
  const { launcher, wsBridge, worktreeTracker } = deps;

  // -- Parse input --
  const resumeSessionAt =
    typeof body.resumeSessionAt === "string" && (body.resumeSessionAt as string).trim()
      ? (body.resumeSessionAt as string).trim()
      : undefined;
  const forkSession = body.forkSession === true;
  const backend = (body.backend as string) ?? "claude";
  if (backend !== "claude" && backend !== "codex") {
    throw new SessionCreationError(`Invalid backend: ${String(backend)}`, 400);
  }

  // -- Step: Resolve environment --
  await emit(onProgress, "resolving_env", "Resolving environment...", "in_progress");

  let envVars: Record<string, string> | undefined = body.env as Record<string, string> | undefined;
  const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug as string) : null;
  if (body.envSlug && companionEnv) {
    console.log(
      `[session-creation] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
      Object.keys(companionEnv.variables).join(", "),
    );
    envVars = { ...companionEnv.variables, ...(body.env as Record<string, string>) };
  } else if (body.envSlug) {
    console.warn(`[session-creation] Environment "${body.envSlug}" not found, ignoring`);
  }

  // Resolve sandbox configuration
  const sandboxEnabled = body.sandboxEnabled === true;
  const companionSandbox = body.sandboxSlug ? sandboxManager.getSandbox(body.sandboxSlug as string) : null;
  if (sandboxEnabled && body.sandboxSlug && !companionSandbox) {
    throw new SessionCreationError(`Sandbox "${body.sandboxSlug}" not found`, 404, "resolving_env");
  }

  // Inject LINEAR_API_KEY if a Linear connection is specified
  let linearSystemPrompt: string | undefined;
  if (body.linearConnectionId) {
    const conn = getConnection(body.linearConnectionId as string);
    if (conn?.apiKey) {
      envVars = { ...envVars, LINEAR_API_KEY: conn.apiKey };
      linearSystemPrompt = buildLinearSystemPrompt(conn, body.linearIssue as Parameters<typeof buildLinearSystemPrompt>[1]);
    }
  }

  // Resolve Docker image early
  let effectiveImage: string | null = null;
  if (sandboxEnabled) {
    effectiveImage = "the-companion:latest";
  } else if ((body.container as Record<string, unknown>)?.image) {
    effectiveImage = (body.container as Record<string, unknown>).image as string;
  }
  const isDockerSession = !!effectiveImage;

  await emit(onProgress, "resolving_env", "Environment resolved", "done");

  // -- Step: Git operations (host-only) --
  let cwd = body.cwd as string | undefined;
  let worktreeInfo: {
    isWorktree: boolean;
    repoRoot: string;
    branch: string;
    actualBranch: string;
    worktreePath: string;
  } | undefined;

  // Validate branch name
  if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch as string)) {
    throw new SessionCreationError("Invalid branch name", 400, "checkout_branch");
  }

  if (!isDockerSession && body.useWorktree && body.branch && cwd) {
    const repoInfo = gitUtils.getRepoInfo(cwd);
    if (repoInfo) {
      await emit(onProgress, "fetching_git", "Fetching from remote...", "in_progress");
      const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
      if (!fetchResult.success) {
        console.warn(`[session-creation] git fetch failed (non-fatal): ${fetchResult.output}`);
      }
      await emit(onProgress, "fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

      await emit(onProgress, "creating_worktree", "Creating worktree...", "in_progress");
      const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch as string, {
        baseBranch: repoInfo.defaultBranch,
        createBranch: body.createBranch as boolean | undefined,
        forceNew: true,
      });
      cwd = result.worktreePath;
      worktreeInfo = {
        isWorktree: true,
        repoRoot: repoInfo.repoRoot,
        branch: body.branch as string,
        actualBranch: result.actualBranch,
        worktreePath: result.worktreePath,
      };
      await emit(onProgress, "creating_worktree", "Worktree ready", "done");
    }
  } else if (!isDockerSession && body.branch && cwd) {
    const repoInfo = gitUtils.getRepoInfo(cwd);
    if (repoInfo) {
      await emit(onProgress, "fetching_git", "Fetching from remote...", "in_progress");
      const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
      if (!fetchResult.success) {
        console.warn(`[session-creation] git fetch failed (non-fatal): ${fetchResult.output}`);
      }
      await emit(onProgress, "fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

      if (repoInfo.currentBranch !== body.branch) {
        await emit(onProgress, "checkout_branch", `Checking out ${body.branch}...`, "in_progress");
        gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch as string, {
          createBranch: body.createBranch as boolean | undefined,
          defaultBranch: repoInfo.defaultBranch,
        });
        await emit(onProgress, "checkout_branch", `On branch ${body.branch}`, "done");
      }

      await emit(onProgress, "pulling_git", "Pulling latest changes...", "in_progress");
      const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
      if (!pullResult.success) {
        console.warn(`[session-creation] git pull warning (non-fatal): ${pullResult.output}`);
      }
      await emit(onProgress, "pulling_git", "Up to date", "done");
    }
  }

  // -- Step: Container creation --
  let containerInfo: ContainerInfo | undefined;
  let containerId: string | undefined;
  let containerName: string | undefined;
  let containerImage: string | undefined;
  let tempId: string | undefined;

  // Validate cwd before container operations (cwd! assertions below rely on this)
  if (effectiveImage && !cwd) {
    throw new SessionCreationError(
      "Working directory (cwd) is required for containerized sessions",
      400,
    );
  }

  // Auth checks for containerized sessions
  if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
    throw new SessionCreationError(
      "Containerized Claude requires auth available inside the container. " +
      "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
      400,
    );
  }
  if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
    throw new SessionCreationError(
      "Containerized Codex requires auth available inside the container. " +
      "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
      400,
    );
  }

  if (effectiveImage) {
    // -- Image pull --
    if (!imagePullManager.isReady(effectiveImage)) {
      const pullState = imagePullManager.getState(effectiveImage);
      if (pullState.status === "idle" || pullState.status === "error") {
        imagePullManager.ensureImage(effectiveImage);
      }

      await emit(onProgress, "pulling_image", "Pulling Docker image...", "in_progress");

      // Stream pull progress lines if the caller wants progress
      let unsub: (() => void) | undefined;
      if (onProgress) {
        unsub = imagePullManager.onProgress(effectiveImage, (line) => {
          emit(onProgress, "pulling_image", "Pulling Docker image...", "in_progress", line).catch(() => {});
        });
      }

      const ready = await imagePullManager.waitForReady(effectiveImage, 300_000);
      unsub?.();

      if (ready) {
        await emit(onProgress, "pulling_image", "Image ready", "done");
      } else {
        const state = imagePullManager.getState(effectiveImage);
        throw new SessionCreationError(
          state.error ||
          `Docker image ${effectiveImage} could not be pulled or built. Use the environment manager to pull/build the image first.`,
          503,
          "pulling_image",
        );
      }
    }

    // -- Create container --
    await emit(onProgress, "creating_container", "Starting container...", "in_progress");
    tempId = crypto.randomUUID().slice(0, 8);
    const requestedPorts = Array.isArray((body.container as Record<string, unknown>)?.ports)
      ? ((body.container as Record<string, unknown>).ports as number[]).map(Number).filter((n: number) => n > 0)
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
      volumes: (body.container as Record<string, unknown>)?.volumes as string[] | undefined,
      env: { ...(envVars ?? {}), DISPLAY: ":99" },
      privileged: sandboxEnabled && effectiveImage === "the-companion:latest",
    };
    try {
      containerInfo = containerManager.createContainer(tempId, cwd!, cConfig);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SessionCreationError(
        `Docker is required to run this environment image (${effectiveImage}) ` +
        `but container startup failed: ${reason}`,
        503,
        "creating_container",
      );
    }
    containerId = containerInfo.containerId;
    containerName = containerInfo.name;
    containerImage = effectiveImage;
    await emit(onProgress, "creating_container", "Container running", "done");

    // -- Copy workspace --
    await emit(onProgress, "copying_workspace", "Copying workspace files...", "in_progress");
    try {
      await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd!);
      containerManager.reseedGitAuth(containerInfo.containerId);
      await emit(onProgress, "copying_workspace", "Workspace copied", "done");
    } catch (err) {
      containerManager.removeContainer(tempId);
      const reason = err instanceof Error ? err.message : String(err);
      throw new SessionCreationError(
        `Failed to copy workspace to container: ${reason}`,
        503,
        "copying_workspace",
      );
    }

    // -- Git ops in container --
    if (body.branch) {
      const repoInfo = cwd ? gitUtils.getRepoInfo(cwd) : null;

      await emit(onProgress, "fetching_git", "Fetching from remote (in container)...", "in_progress");
      const gitResult = containerManager.gitOpsInContainer(containerInfo.containerId, {
        branch: body.branch as string,
        currentBranch: repoInfo?.currentBranch || "HEAD",
        createBranch: body.createBranch as boolean | undefined,
        defaultBranch: repoInfo?.defaultBranch,
      });
      await emit(onProgress, "fetching_git", gitResult.fetchOk ? "Fetch complete" : "Fetch skipped", "done");

      if (repoInfo?.currentBranch !== body.branch) {
        await emit(
          onProgress,
          "checkout_branch",
          gitResult.checkoutOk ? `On branch ${body.branch}` : "Checkout failed",
          gitResult.checkoutOk ? "done" : "error",
        );
      }

      await emit(onProgress, "pulling_git", gitResult.pullOk ? "Up to date" : "Pull skipped", "done");

      if (gitResult.errors.length > 0) {
        console.warn(`[session-creation] In-container git ops warnings: ${gitResult.errors.join("; ")}`);
      }
      if (!gitResult.checkoutOk) {
        containerManager.removeContainer(tempId);
        throw new SessionCreationError(
          `Failed to checkout branch "${body.branch}" inside container: ${gitResult.errors.join("; ")}`,
          400,
          "checkout_branch",
        );
      }
    }

    // -- Init script --
    const initScript = companionSandbox?.initScript?.trim();
    if (initScript) {
      await emit(onProgress, "running_init_script", "Running init script...", "in_progress");
      try {
        const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
        const result = await containerManager.execInContainerAsync(
          containerInfo.containerId,
          ["sh", "-lc", initScript],
          {
            timeout: initTimeout,
            onOutput: onProgress
              ? (line) => {
                  emit(onProgress, "running_init_script", "Running init script...", "in_progress", line).catch(() => {});
                }
              : undefined,
          },
        );
        if (result.exitCode !== 0) {
          console.error(
            `[session-creation] Init script failed for sandbox "${companionSandbox?.name || "sandbox"}" (exit ${result.exitCode}):\n${result.output}`,
          );
          containerManager.removeContainer(tempId);
          const truncated =
            result.output.length > 2000
              ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
              : result.output;
          throw new SessionCreationError(
            `Init script failed (exit ${result.exitCode}):\n${truncated}`,
            503,
            "running_init_script",
          );
        }
        console.log(`[session-creation] Init script completed successfully for sandbox "${companionSandbox?.name || "sandbox"}"`);
        await emit(onProgress, "running_init_script", "Init script complete", "done");
      } catch (e) {
        if (e instanceof SessionCreationError) throw e;
        containerManager.removeContainer(tempId);
        const reason = e instanceof Error ? e.message : String(e);
        throw new SessionCreationError(
          `Init script execution failed: ${reason}`,
          503,
          "running_init_script",
        );
      }
    }
  }

  // -- Step: Launch CLI --
  await emit(
    onProgress,
    "launching_cli",
    `Launching ${backend === "codex" ? "Codex" : "Claude Code"}...`,
    "in_progress",
  );

  let session: SdkSessionInfo;
  try {
    session = launcher.launch({
      model: body.model as string | undefined,
      permissionMode: body.permissionMode as string | undefined,
      cwd,
      claudeBinary: body.claudeBinary as string | undefined,
      codexBinary: body.codexBinary as string | undefined,
      codexInternetAccess: backend === "codex",
      codexSandbox: backend === "codex" ? "danger-full-access" : undefined,
      allowedTools: body.allowedTools as string[] | undefined,
      env: envVars,
      backendType: backend,
      containerId,
      containerName,
      containerImage,
      containerCwd: containerInfo?.containerCwd,
      resumeSessionAt,
      forkSession,
      systemPrompt: backend === "codex" ? linearSystemPrompt : undefined,
      sandboxSlug: sandboxEnabled ? ((body.sandboxSlug as string) || undefined) : undefined,
    });
  } catch (err) {
    if (tempId) containerManager.removeContainer(tempId);
    const reason = err instanceof Error ? err.message : String(err);
    throw new SessionCreationError(
      `Failed to launch CLI: ${reason}`,
      503,
      "launching_cli",
    );
  }

  // -- Post-launch tracking --
  if (containerInfo) {
    containerManager.retrack(containerInfo.containerId, session.sessionId);
    wsBridge.markContainerized(session.sessionId, cwd!);
  }

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

  if (linearSystemPrompt && backend === "claude") {
    wsBridge.injectSystemPrompt(session.sessionId, linearSystemPrompt);
  }

  const discovered = await discoverCommandsAndSkills(cwd).catch(() => ({
    slash_commands: [] as string[],
    skills: [] as string[],
  }));
  wsBridge.prePopulateCommands(session.sessionId, discovered.slash_commands, discovered.skills);

  await emit(onProgress, "launching_cli", "Session started", "done");

  return { session };
}
