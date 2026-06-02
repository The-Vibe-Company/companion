import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerPortSpec {
  port: number;
  /** Host IP to bind to (default: 0.0.0.0). Use "127.0.0.1" for localhost-only. */
  hostIp?: string;
}

export interface ContainerConfig {
  /** Docker image to use (e.g. "the-companion:latest", "node:22-slim") */
  image: string;
  /** Container ports to expose (e.g. [3000, 8080] or [{ port: 6080, hostIp: "127.0.0.1" }]) */
  ports: (number | ContainerPortSpec)[];
  /** Extra volume mounts in "host:container[:opts]" format */
  volumes?: string[];
  /** Extra env vars to inject into the container */
  env?: Record<string, string>;
  /** Run container in privileged mode (required for Docker-in-Docker) */
  privileged?: boolean;
}

export interface PortMapping {
  containerPort: number;
  hostPort: number;
}

export interface ContainerInfo {
  containerId: string;
  name: string;
  image: string;
  portMappings: PortMapping[];
  hostCwd: string;
  containerCwd: string;
  state: "creating" | "running" | "stopped" | "removed";
  /** Named Docker volume for isolated workspace (absent for legacy bind-mount containers). */
  volumeName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: "utf-8",
  timeout: 30_000,
};
const QUICK_EXEC_TIMEOUT_MS = 8_000;
const STANDARD_EXEC_TIMEOUT_MS = 30_000;
const CONTAINER_BOOT_TIMEOUT_MS = 20_000;
const WORKSPACE_COPY_TIMEOUT_MS = 15 * 60_000; // 15 min for large repos
const IMAGE_PULL_TIMEOUT_MS = 300_000; // 5 min for pulling images

const DOCKER_REGISTRY = "docker.io/stangirard";

function exec(cmd: string, opts?: ExecSyncOptionsWithStringEncoding): string {
  return execSync(cmd, { ...EXEC_OPTS, ...opts }).trim();
}

// ---------------------------------------------------------------------------
// ContainerManager
// ---------------------------------------------------------------------------

export class ContainerManager {
  private containers = new Map<string, ContainerInfo>();

  /** Check whether Docker daemon is reachable. */
  checkDocker(): boolean {
    try {
      exec("docker info --format '{{.ServerVersion}}'", {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Return Docker version string, or null if unavailable. */
  getDockerVersion(): string | null {
    try {
      return exec("docker version --format '{{.Server.Version}}'", {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
  }

  /** List images available locally. Returns image:tag strings. */
  listImages(): string[] {
    try {
      const raw = exec("docker images --format '{{.Repository}}:{{.Tag}}'", {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
      if (!raw) return [];
      return raw
        .split("\n")
        .filter((l) => l && !l.startsWith("<none>"))
        .sort();
    } catch {
      return [];
    }
  }

  /** Check if a specific image exists locally. */
  imageExists(image: string): boolean {
    try {
      exec(`docker image inspect ${shellEscape(image)}`, {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create and start a container for a session.
   *
   * - Mounts `~/.claude` read-only at `/companion-host-claude` (auth seed)
   * - Uses a writable tmpfs at `/root/.claude` for runtime state
   * - Mounts `hostCwd` at `/workspace`
   * - Publishes requested ports with auto-assigned host ports (`-p 0:PORT`)
   */
  createContainer(
    sessionId: string,
    hostCwd: string,
    config: ContainerConfig,
  ): ContainerInfo {
    const name = `companion-${sessionId.slice(0, 8)}`;
    const homedir = process.env.HOME || process.env.USERPROFILE || "/root";

    // Validate port numbers
    for (const portSpec of config.ports) {
      const port = typeof portSpec === "number" ? portSpec : portSpec.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number: ${port} (must be 1-65535)`);
      }
    }

    // Create a named volume for workspace isolation (each container gets its own copy)
    const volumeName = `companion-ws-${sessionId.slice(0, 8)}`;
    exec(`docker volume create ${shellEscape(volumeName)}`, {
      encoding: "utf-8",
      timeout: QUICK_EXEC_TIMEOUT_MS,
    });

    // Build docker create args
    const args: string[] = [
      "docker", "create",
      "--name", name,
      // Enable Docker-in-Docker when privileged mode is requested
      ...(config.privileged ? ["--privileged"] : []),
      // Ensure host.docker.internal resolves (automatic on Mac/Win Docker
      // Desktop, but required explicitly on Linux)
      "--add-host=host.docker.internal:host-gateway",
      // Seed auth/config from host home, but keep runtime writes inside container.
      "-v", `${homedir}/.claude:/companion-host-claude:ro`,
      "--tmpfs", "/root/.claude",
      // Seed Codex auth/config from host (if present)
      ...(existsSync(join(homedir, ".codex"))
        ? ["-v", `${homedir}/.codex:/companion-host-codex:ro`, "--tmpfs", "/root/.codex"]
        : []),
      // Isolated workspace: named volume populated later via docker cp
      "-v", `${volumeName}:/workspace`,
      "-w", "/workspace",
    ];

    // Mount host .gitconfig at a staging path (not /root/.gitconfig) so the
    // container keeps a writable global git config. seedGitAuth() copies
    // user.name / user.email from the staged file into /root/.gitconfig and
    // can also write container-specific overrides (e.g. gpgsign=false).
    const gitconfigPath = join(homedir, ".gitconfig");
    if (existsSync(gitconfigPath)) {
      args.push("-v", `${gitconfigPath}:/companion-host-gitconfig:ro`);
    }

    // Port mappings: -p [hostIp:]0:{containerPort}
    for (const portSpec of config.ports) {
      const port = typeof portSpec === "number" ? portSpec : portSpec.port;
      const hostIp = typeof portSpec === "number" ? undefined : portSpec.hostIp;
      args.push("-p", hostIp ? `${hostIp}:0:${port}` : `0:${port}`);
    }

    // Extra volumes
    if (config.volumes) {
      for (const vol of config.volumes) {
        args.push("-v", vol);
      }
    }

    // Environment variables
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }

    // Image + default command (keep container alive)
    args.push(config.image, "sleep", "infinity");

    const info: ContainerInfo = {
      containerId: "",
      name,
      image: config.image,
      portMappings: [],
      hostCwd,
      containerCwd: "/workspace",
      state: "creating",
      volumeName,
    };

    try {
      // Create
      const containerId = exec(args.map(shellEscape).join(" "), {
        encoding: "utf-8",
        timeout: CONTAINER_BOOT_TIMEOUT_MS,
      });
      info.containerId = containerId;

      // Start
      exec(`docker start ${shellEscape(containerId)}`, {
        encoding: "utf-8",
        timeout: CONTAINER_BOOT_TIMEOUT_MS,
      });
      info.state = "running";

      this.seedAuthFiles(containerId);
      this.seedCodexFiles(containerId);
      this.seedGitAuth(containerId);

      // Resolve actual port mappings
      info.portMappings = this.resolvePortMappings(containerId, config.ports);

      this.containers.set(sessionId, info);
      console.log(
        `[container-manager] Created container ${name} (${containerId.slice(0, 12)}) ` +
        `ports: ${info.portMappings.map((p) => `${p.containerPort}->${p.hostPort}`).join(", ")}`,
      );

      return info;
    } catch (e) {
      // Cleanup partial creation (container + volume)
      try { exec(`docker rm -f ${shellEscape(name)}`); } catch { /* ignore */ }
      try { exec(`docker volume rm ${shellEscape(volumeName)}`); } catch { /* ignore */ }
      info.state = "removed";
      throw new Error(
        `Failed to create container: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Copy auth & config files from the read-only bind mount into the tmpfs home dir.
   * Called after both initial create and restart (tmpfs is wiped on stop).
   *
   * Uses semicolons (not &&) deliberately: individual file copies are best-effort
   * because not all auth files exist on every system. The trailing `true` ensures
   * the overall exec succeeds even when some `cp` commands fail for missing files.
   */
  private seedAuthFiles(containerId: string): void {
    try {
      this.execInContainer(containerId, [
        "sh", "-lc",
        [
          "mkdir -p /root/.claude",
          "for f in .credentials.json auth.json .auth.json credentials.json; do " +
            "[ -f /companion-host-claude/$f ] && cp /companion-host-claude/$f /root/.claude/$f 2>/dev/null; done",
          "for f in settings.json settings.local.json; do " +
            "[ -f /companion-host-claude/$f ] && cp /companion-host-claude/$f /root/.claude/$f 2>/dev/null; done",
          "[ -d /companion-host-claude/skills ] && cp -r /companion-host-claude/skills /root/.claude/skills 2>/dev/null",
          "true",
        ].join("; "),
      ]);
    } catch { /* best-effort — container may not have /companion-host-claude mounted */ }
  }

  /**
   * Copy Codex auth & config files from the read-only bind mount into the
   * tmpfs home dir. Similar to seedAuthFiles but for Codex's ~/.codex directory.
   * Called after both initial create and restart (tmpfs is wiped on stop).
   */
  private seedCodexFiles(containerId: string): void {
    try {
      this.execInContainer(containerId, [
        "sh", "-lc",
        [
          "[ -d /companion-host-codex ] || exit 0",
          "mkdir -p /root/.codex",
          "for f in auth.json config.toml models_cache.json version.json; do " +
            "[ -f /companion-host-codex/$f ] && cp /companion-host-codex/$f /root/.codex/$f 2>/dev/null; done",
          "for d in skills vendor_imports prompts rules; do " +
            "[ -d /companion-host-codex/$d ] && cp -r /companion-host-codex/$d /root/.codex/$d 2>/dev/null; done",
          "true",
        ].join("; "),
      ]);
    } catch { /* best-effort — container may not have /companion-host-codex mounted */ }
  }

  /**
   * Seed git authentication inside the container.
   * - Extracts GitHub CLI token from host keyring and logs in inside container
   * - Always sets up `gh` as the git credential helper for HTTPS operations
   * - Disables GPG commit signing (host tools like 1Password aren't available)
   *
   * Called after both initial create and restart (tmpfs wipes gh config on stop).
   */
  private seedGitAuth(containerId: string): void {
    // Track whether we could read the host token. Containers may still have gh
    // auth via copied files, so setup-git must run even when this is unavailable.
    let token = "";

    // Extract GitHub token from host (may be stored in macOS keyring)
    try {
      token = exec("gh auth token 2>/dev/null", {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
    } catch { /* best-effort — gh may not be installed on host */ }

    // If host token exists, seed gh auth state in the container.
    if (token) {
      try {
        this.execInContainer(containerId, [
          "sh", "-lc",
          `printf '%s\n' ${shellEscape(token)} | gh auth login --with-token 2>/dev/null; true`,
        ]);
      } catch { /* best-effort */ }
    }

    // Always wire git credentials to gh token flow.
    try {
      this.execInContainer(containerId, [
        "sh", "-lc",
        "gh auth setup-git 2>/dev/null; true",
      ]);
    } catch { /* best-effort */ }

    // Copy host git identity (user.name, user.email) from the staged
    // read-only .gitconfig into the container's writable global config,
    // then apply container-specific overrides (disable GPG signing, mark
    // /workspace as safe, rewrite SSH remotes to HTTPS since containers
    // lack host SSH keys).
    try {
      this.execInContainer(containerId, [
        "sh", "-lc",
        [
          // Import user.name and user.email from host gitconfig (if mounted)
          "if [ -f /companion-host-gitconfig ]; then " +
            "NAME=$(git config -f /companion-host-gitconfig user.name 2>/dev/null); " +
            "EMAIL=$(git config -f /companion-host-gitconfig user.email 2>/dev/null); " +
            '[ -n "$NAME" ] && git config --global user.name "$NAME"; ' +
            '[ -n "$EMAIL" ] && git config --global user.email "$EMAIL"; ' +
          "fi",
          // Disable GPG/SSH commit signing — host tools (1Password, GPG agent)
          // aren't available inside the container.
          "git config --global commit.gpgsign false 2>/dev/null",
          // Mark /workspace as safe — the workspace volume may be owned by a
          // different uid (e.g. ubuntu) than the container user (root), which
          // triggers git's "dubious ownership" check.
          "git config --global safe.directory /workspace 2>/dev/null",
          // Rewrite git@github.com:org/repo → https://github.com/org/repo for all remotes
          "cd /workspace 2>/dev/null && " +
            "git remote -v 2>/dev/null | grep 'git@github.com:' | awk '{print $1}' | sort -u | " +
            "while read remote; do " +
              "url=$(git remote get-url \"$remote\" 2>/dev/null); " +
              "https_url=$(echo \"$url\" | sed 's|git@github.com:|https://github.com/|'); " +
              "git remote set-url \"$remote\" \"$https_url\" 2>/dev/null; " +
            "done",
          "true",
        ].join("; "),
      ]);
    } catch { /* best-effort */ }
  }

  /**
   * Copy host workspace files into a running container's /workspace volume.
   * Uses a tar stream piped into `docker exec` for better throughput on Docker
   * Desktop (macOS) while preserving file structure and dotfiles.
   */
  async copyWorkspaceToContainer(
    containerId: string,
    hostCwd: string,
  ): Promise<void> {
    validateContainerId(containerId);

    const cmd = [
      "set -o pipefail",
      `COPYFILE_DISABLE=1 tar -C ${shellEscape(hostCwd)} -cf - . | ` +
        `docker exec -i ${shellEscape(containerId)} tar -xf - -C /workspace`,
    ].join("; ");

    const proc = Bun.spawn(["bash", "-lc", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = new Promise<number>((resolve) => {
      setTimeout(() => resolve(-1), WORKSPACE_COPY_TIMEOUT_MS);
    });

    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await Promise.race([proc.exited, timeout]);

    if (exitCode === -1) {
      try { proc.kill(); } catch { /* best-effort */ }
      throw new Error(`workspace copy timed out after ${Math.floor(WORKSPACE_COPY_TIMEOUT_MS / 1000)}s`);
    }

    if (exitCode !== 0) {
      const stderrText = await stderrPromise;
      throw new Error(
        `workspace copy failed (exit ${exitCode}): ${stderrText.trim() || "unknown error"}`,
      );
    }
  }

  /**
   * Re-seed git auth inside a container. Call this after workspace files have
   * been copied so SSH→HTTPS remote rewriting can find the `.git` directory.
   */
  reseedGitAuth(containerId: string): void {
    this.seedGitAuth(containerId);
  }

  /**
   * Run git fetch/checkout/pull inside a running container at /workspace.
   * Call after copyWorkspaceToContainer + reseedGitAuth so credentials are available.
   * Fetch and pull failures are non-fatal (warnings), matching host-side behavior.
   */
  gitOpsInContainer(
    containerId: string,
    opts: {
      branch: string;
      currentBranch: string;
      createBranch?: boolean;
      defaultBranch?: string;
    },
  ): { fetchOk: boolean; checkoutOk: boolean; pullOk: boolean; errors: string[] } {
    const errors: string[] = [];
    const branch = shellEscape(opts.branch);

    // 1. git fetch --prune
    let fetchOk = false;
    try {
      this.execInContainer(containerId, [
        "sh", "-lc", "cd /workspace && git fetch --prune",
      ]);
      fetchOk = true;
    } catch (e) {
      errors.push(`fetch: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. git checkout (only if different branch requested)
    let checkoutOk = true;
    if (opts.currentBranch !== opts.branch) {
      checkoutOk = false;
      try {
        this.execInContainer(containerId, [
          "sh", "-lc", `cd /workspace && git checkout ${branch}`,
        ]);
        checkoutOk = true;
      } catch {
        if (opts.createBranch) {
          const base = shellEscape(opts.defaultBranch || "main");
          try {
            this.execInContainer(containerId, [
              "sh", "-lc",
              `cd /workspace && git checkout -b ${branch} origin/${base} 2>/dev/null || git checkout -b ${branch} ${base}`,
            ]);
            checkoutOk = true;
          } catch (e2) {
            errors.push(`checkout-create: ${e2 instanceof Error ? e2.message : String(e2)}`);
          }
        } else {
          errors.push(`checkout: branch "${opts.branch}" does not exist`);
        }
      }
    }

    // 3. git pull
    let pullOk = false;
    try {
      this.execInContainer(containerId, [
        "sh", "-lc", "cd /workspace && git pull",
      ]);
      pullOk = true;
    } catch (e) {
      errors.push(`pull: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { fetchOk, checkoutOk, pullOk, errors };
  }

  /** Parse `docker port` output to get host port mappings. */
  private resolvePortMappings(containerId: string, ports: (number | ContainerPortSpec)[]): PortMapping[] {
    const mappings: PortMapping[] = [];
    for (const portSpec of ports) {
      const containerPort = typeof portSpec === "number" ? portSpec : portSpec.port;
      try {
        const raw = exec(
          `docker port ${shellEscape(containerId)} ${containerPort}`,
        );
        // Output like "0.0.0.0:49152" or "127.0.0.1:49152" or "[::]:49152"
        const match = raw.match(/:(\d+)$/m);
        if (match) {
          mappings.push({
            containerPort,
            hostPort: parseInt(match[1], 10),
          });
        }
      } catch {
        console.warn(
          `[container-manager] Could not resolve port ${containerPort} for ${containerId.slice(0, 12)}`,
        );
      }
    }
    return mappings;
  }

  /**
   * Execute a command inside a running container.
   * Returns the stdout output. Throws on failure.
   */
  execInContainer(containerId: string, cmd: string[], timeout = STANDARD_EXEC_TIMEOUT_MS): string {
    validateContainerId(containerId);
    const dockerCmd = [
      "docker", "exec",
      shellEscape(containerId),
      ...cmd.map(shellEscape),
    ].join(" ");
    return exec(dockerCmd, { encoding: "utf-8", timeout });
  }

  /**
   * Execute a command inside a running container asynchronously.
   * Uses Bun.spawn for longer-running operations (like init scripts).
   * Returns exit code and combined stdout+stderr output.
   */
  async execInContainerAsync(
    containerId: string,
    cmd: string[],
    opts?: { timeout?: number; onOutput?: (line: string) => void },
  ): Promise<{ exitCode: number; output: string }> {
    validateContainerId(containerId);
    const timeout = opts?.timeout ?? 120_000;
    const dockerCmd = [
      "docker", "exec",
      containerId,
      ...cmd,
    ];

    const proc = Bun.spawn(dockerCmd, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const lines: string[] = [];
    const decoder = new TextDecoder();

    // Read stdout
    const stdoutReader = proc.stdout.getReader();
    let stdoutBuffer = "";
    const readStdout = (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          stdoutBuffer += decoder.decode(value, { stream: true });
          const parts = stdoutBuffer.split("\n");
          stdoutBuffer = parts.pop() || "";
          for (const line of parts) {
            lines.push(line);
            opts?.onOutput?.(line);
          }
        }
        if (stdoutBuffer.trim()) {
          lines.push(stdoutBuffer);
          opts?.onOutput?.(stdoutBuffer);
        }
      } finally {
        stdoutReader.releaseLock();
      }
    })();

    // Read stderr
    const stderrPromise = new Response(proc.stderr).text();

    // Apply timeout — capture timer ID so we can clear it on normal exit
    const exitPromise = proc.exited;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);
    });

    try {
      const exitCode = await Promise.race([exitPromise, timeoutPromise]);
      clearTimeout(timeoutId);
      await readStdout;
      const stderrText = await stderrPromise;
      if (stderrText.trim()) {
        for (const line of stderrText.split("\n")) {
          if (line.trim()) {
            lines.push(line);
            opts?.onOutput?.(line);
          }
        }
      }
      return { exitCode, output: lines.join("\n") };
    } catch (e) {
      clearTimeout(timeoutId);
      await readStdout.catch(() => {});
      throw e;
    }
  }

  /**
   * Re-track a container under a new key (e.g. when the real sessionId
   * is assigned after container creation).
   */
  retrack(containerId: string, newSessionId: string): void {
    for (const [oldKey, info] of this.containers) {
      if (info.containerId === containerId) {
        this.containers.delete(oldKey);
        this.containers.set(newSessionId, info);
        return;
      }
    }
  }

  /** Stop and remove a container. */
  removeContainer(sessionId: string): void {
    const info = this.containers.get(sessionId);
    if (!info) return;

    try {
      exec(`docker rm -f ${shellEscape(info.containerId)}`);
      info.state = "removed";
      console.log(
        `[container-manager] Removed container ${info.name} (${info.containerId.slice(0, 12)})`,
      );
    } catch (e) {
      console.warn(
        `[container-manager] Failed to remove container ${info.name}:`,
        e instanceof Error ? e.message : String(e),
      );
    }

    // Clean up the named workspace volume if one was created
    if (info.volumeName) {
      try {
        exec(`docker volume rm ${shellEscape(info.volumeName)}`, {
          encoding: "utf-8",
          timeout: QUICK_EXEC_TIMEOUT_MS,
        });
        console.log(`[container-manager] Removed volume ${info.volumeName}`);
      } catch (e) {
        console.warn(
          `[container-manager] Failed to remove volume ${info.volumeName}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    this.containers.delete(sessionId);
  }

  /** Get container info for a session. */
  getContainer(sessionId: string): ContainerInfo | undefined {
    return this.containers.get(sessionId);
  }

  /** Get container info by Docker container ID. */
  getContainerById(containerId: string): ContainerInfo | undefined {
    for (const info of this.containers.values()) {
      if (info.containerId === containerId) return info;
    }
    return undefined;
  }

  /** List all tracked containers. */
  listContainers(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }

  /** Attempt to start a stopped container. Re-seeds auth files (tmpfs is wiped on stop). */
  startContainer(containerId: string): void {
    validateContainerId(containerId);
    exec(`docker start ${shellEscape(containerId)}`, {
      encoding: "utf-8",
      timeout: CONTAINER_BOOT_TIMEOUT_MS,
    });
    this.seedAuthFiles(containerId);
    this.seedCodexFiles(containerId);
    this.seedGitAuth(containerId);
  }

  /**
   * Check whether a Docker container exists and its running state.
   * Returns "running", "stopped", or "missing".
   */
  isContainerAlive(containerId: string): "running" | "stopped" | "missing" {
    validateContainerId(containerId);
    try {
      const state = exec(
        `docker inspect --format '{{.State.Running}}' ${shellEscape(containerId)}`,
        { encoding: "utf-8", timeout: QUICK_EXEC_TIMEOUT_MS },
      );
      return state === "true" ? "running" : "stopped";
    } catch {
      return "missing";
    }
  }

  /**
   * Check if a binary is available inside a running container.
   * Uses `bash -lc` so PATH includes nvm/bun/deno/etc.
   */
  hasBinaryInContainer(containerId: string, binary: string): boolean {
    validateContainerId(containerId);
    try {
      exec(
        `docker exec ${shellEscape(containerId)} bash -lc 'which ${shellEscape(binary)}'`,
        { encoding: "utf-8", timeout: QUICK_EXEC_TIMEOUT_MS },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-register a container that was persisted across a server restart.
   * Verifies the container still exists in Docker before tracking it.
   */
  restoreContainer(sessionId: string, info: ContainerInfo): boolean {
    try {
      const state = exec(
        `docker inspect --format '{{.State.Running}}' ${shellEscape(info.containerId)}`,
      );
      if (state === "true") {
        info.state = "running";
      } else {
        info.state = "stopped";
      }
      this.containers.set(sessionId, info);
      console.log(
        `[container-manager] Restored container ${info.name} (${info.containerId.slice(0, 12)}) state=${info.state}`,
      );
      return true;
    } catch {
      // Container no longer exists in Docker
      console.warn(
        `[container-manager] Container ${info.name} (${info.containerId.slice(0, 12)}) no longer exists, skipping restore`,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence — survive server restarts
  // ---------------------------------------------------------------------------

  /** Persist all tracked container info to disk. */
  persistState(filePath: string): void {
    try {
      const entries: { sessionId: string; info: ContainerInfo }[] = [];
      for (const [sessionId, info] of this.containers) {
        if (info.state !== "removed") {
          entries.push({ sessionId, info });
        }
      }
      writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
    } catch (e) {
      console.warn(
        "[container-manager] Failed to persist state:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /** Restore container tracking from disk, verifying each container still exists. */
  restoreState(filePath: string): number {
    if (!existsSync(filePath)) return 0;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const entries: { sessionId: string; info: ContainerInfo }[] = JSON.parse(raw);
      let restored = 0;
      for (const { sessionId, info } of entries) {
        if (this.restoreContainer(sessionId, info)) {
          restored++;
        }
      }
      if (restored > 0) {
        console.log(`[container-manager] Restored ${restored} container(s) from disk`);
      }
      return restored;
    } catch (e) {
      console.warn(
        "[container-manager] Failed to restore state:",
        e instanceof Error ? e.message : String(e),
      );
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Image building
  // ---------------------------------------------------------------------------

  /**
   * Build a Docker image from a provided Dockerfile path.
   * Returns the build output log. Throws on failure.
   */
  buildImage(dockerfilePath: string, tag: string = "the-companion:latest"): string {
    const contextDir = dockerfilePath.replace(/\/[^/]+$/, "") || ".";
    try {
      const output = exec(
        `docker build -t ${shellEscape(tag)} -f ${shellEscape(dockerfilePath)} ${shellEscape(contextDir)}`,
        { encoding: "utf-8", timeout: 300_000 }, // 5 min for image builds
      );
      console.log(`[container-manager] Built image ${tag}`);
      return output;
    } catch (e) {
      throw new Error(
        `Failed to build image ${tag}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Build a Docker image from inline Dockerfile content using Bun.spawn for streaming output.
   * Writes the Dockerfile to a temp directory and runs docker build.
   */
  async buildImageStreaming(
    dockerfileContent: string,
    tag: string,
    onProgress?: (line: string) => void,
  ): Promise<{ success: boolean; log: string }> {
    // Write Dockerfile to temp dir
    const buildDir = join(tmpdir(), `companion-build-${Date.now()}`);
    mkdirSync(buildDir, { recursive: true });
    const dockerfilePath = join(buildDir, "Dockerfile");
    writeFileSync(dockerfilePath, dockerfileContent, "utf-8");

    try {
      const args = [
        "docker", "build",
        "-t", tag,
        "-f", dockerfilePath,
        buildDir,
      ];

      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const lines: string[] = [];

      // Read stdout and stderr concurrently to avoid deadlock.
      // Docker BuildKit sends build progress to stderr; if we read them
      // sequentially, the stderr pipe buffer fills up and blocks Docker
      // while we're still waiting on stdout.
      const readStdout = (async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n");
            buffer = parts.pop() || "";
            for (const line of parts) {
              if (line.trim()) {
                lines.push(line);
                onProgress?.(line);
              }
            }
          }
          if (buffer.trim()) {
            lines.push(buffer);
            onProgress?.(buffer);
          }
        } finally {
          reader.releaseLock();
        }
      })();

      const readStderr = (async () => {
        const text = await new Response(proc.stderr).text();
        if (text.trim()) {
          for (const line of text.split("\n")) {
            if (line.trim()) {
              lines.push(line);
              onProgress?.(line);
            }
          }
        }
      })();

      await Promise.all([readStdout, readStderr]);
      const exitCode = await proc.exited;
      const log = lines.join("\n");

      if (exitCode === 0) {
        console.log(`[container-manager] Built image ${tag} (streaming)`);
        return { success: true, log };
      }

      return { success: false, log };
    } finally {
      // Clean up temp build directory
      try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Return the Docker Hub remote path for a default image, or null for non-default images.
   */
  static getRegistryImage(localTag: string): string | null {
    if (localTag === "the-companion:latest") {
      return `${DOCKER_REGISTRY}/the-companion:latest`;
    }
    return null;
  }

  /**
   * Pull a Docker image from a registry and optionally tag it locally.
   * Returns true on success, false on failure (never throws).
   */
  async pullImage(
    remoteImage: string,
    localTag: string,
    onProgress?: (line: string) => void,
  ): Promise<boolean> {
    try {
      const proc = Bun.spawn(["docker", "pull", remoteImage], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const readOutput = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n");
            buffer = parts.pop() || "";
            for (const line of parts) {
              if (line.trim()) onProgress?.(line);
            }
          }
          if (buffer.trim()) onProgress?.(buffer);
        } finally {
          reader.releaseLock();
        }
      };

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          proc.kill();
          reject(new Error("Pull timed out"));
        }, IMAGE_PULL_TIMEOUT_MS);
      });

      const exitPromise = (async () => {
        await Promise.all([readOutput(proc.stdout), readOutput(proc.stderr)]);
        return proc.exited;
      })();

      const exitCode = await Promise.race([exitPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        console.warn(`[container-manager] docker pull ${remoteImage} failed (exit ${exitCode})`);
        return false;
      }

      // Tag as local name if different
      if (remoteImage !== localTag) {
        exec(`docker tag ${shellEscape(remoteImage)} ${shellEscape(localTag)}`, {
          encoding: "utf-8",
          timeout: QUICK_EXEC_TIMEOUT_MS,
        });
      }

      console.log(`[container-manager] Pulled ${remoteImage} → ${localTag}`);
      return true;
    } catch (e) {
      console.warn(
        `[container-manager] Pull failed for ${remoteImage}:`,
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
  }

  /** Clean up all tracked containers (e.g. on server shutdown). */
  cleanupAll(): void {
    for (const [sessionId] of this.containers) {
      this.removeContainer(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Shell escape helper
// ---------------------------------------------------------------------------

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9._\-/:=@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Validate that a container ID is a hex string (Docker format) or a safe container name. */
function validateContainerId(id: string): void {
  // Docker container IDs are 64-char hex, but we accept short IDs too.
  // Container names are alphanumeric with hyphens and underscores.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/.test(id)) {
    throw new Error(`Invalid container ID or name: ${id.slice(0, 40)}`);
  }
}

// Singleton
export const containerManager = new ContainerManager();
