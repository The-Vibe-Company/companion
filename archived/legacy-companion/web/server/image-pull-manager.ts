import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containerManager, ContainerManager } from "./container-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImagePullState {
  image: string;
  status: "idle" | "pulling" | "ready" | "error";
  /** Last N lines of pull/build output (ring buffer) */
  progress: string[];
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PROGRESS_LINES = 50;
const WEB_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// ImagePullManager — singleton that tracks background image pulls
// ---------------------------------------------------------------------------

type ReadyListener = () => void;

class ImagePullManager {
  private states = new Map<string, ImagePullState>();
  /** Listeners waiting for a specific image to become ready */
  private readyListeners = new Map<string, ReadyListener[]>();

  /**
   * Get the current state for an image.
   * If the image exists locally and we have no tracking entry, return "ready".
   */
  getState(image: string): ImagePullState {
    const existing = this.states.get(image);
    if (existing) return existing;

    // Check if already available locally
    const ready = containerManager.imageExists(image);
    return {
      image,
      status: ready ? "ready" : "idle",
      progress: [],
    };
  }

  /** Quick check: is the image available locally right now? */
  isReady(image: string): boolean {
    return this.getState(image).status === "ready";
  }

  /**
   * Ensure the image is available. Starts a background pull if missing.
   * No-op if already pulling or ready.
   */
  ensureImage(image: string): void {
    const state = this.getState(image);
    if (state.status === "ready" || state.status === "pulling") return;
    this.startPull(image);
  }

  /**
   * Wait for an image that is currently pulling to become ready.
   * Resolves true if ready, false if pull failed or timed out.
   * If image is already ready, resolves immediately.
   */
  waitForReady(image: string, timeoutMs = 300_000): Promise<boolean> {
    const state = this.getState(image);
    if (state.status === "ready") return Promise.resolve(true);
    if (state.status === "error") return Promise.resolve(false);
    if (state.status === "idle") {
      // Not pulling yet — start it
      this.startPull(image);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Clean up the listener to avoid memory leaks
        const arr = this.readyListeners.get(image);
        if (arr) {
          const idx = arr.indexOf(listener);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.readyListeners.delete(image);
        }
        resolve(result);
      };

      const timer = setTimeout(() => done(false), timeoutMs);

      const listener: ReadyListener = () => {
        const s = this.getState(image);
        if (s.status === "ready") done(true);
        else if (s.status === "error") done(false);
        // else still pulling — keep waiting
      };

      const listeners = this.readyListeners.get(image) ?? [];
      listeners.push(listener);
      this.readyListeners.set(image, listeners);

      // Re-check after registering the listener to catch races where
      // the pull completed synchronously before the listener was added.
      const currentState = this.getState(image);
      if (currentState.status === "ready") done(true);
      else if (currentState.status === "error") done(false);
    });
  }

  /**
   * Trigger a pull even if image is already present (for updates).
   */
  pull(image: string): void {
    const state = this.getState(image);
    if (state.status === "pulling") return; // already in progress
    this.startPull(image);
  }

  /**
   * Subscribe to progress lines for a specific image.
   * Returns an unsubscribe function.
   * The callback fires for each new progress line while pulling.
   */
  onProgress(image: string, cb: (line: string) => void): () => void {
    const key = `progress:${image}`;
    const listeners = (this.progressListeners.get(key) ?? []);
    listeners.push(cb);
    this.progressListeners.set(key, listeners);
    return () => {
      const arr = this.progressListeners.get(key);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }
  private progressListeners = new Map<string, Array<(line: string) => void>>();

  /**
   * On server startup, check all environments and pre-pull missing images.
   * Environments no longer carry Docker fields — this is now a no-op stub
   * kept for backwards compatibility with callers.
   */
  initFromEnvironments(): void {
    // Environments no longer have imageTag/baseImage (moved to Sandboxes).
    // Nothing to pre-pull from envs.
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private startPull(image: string): void {
    const state: ImagePullState = {
      image,
      status: "pulling",
      progress: [],
      startedAt: Date.now(),
    };
    this.states.set(image, state);

    // Determine if we can pull from registry
    const registryImage = ContainerManager.getRegistryImage(image);

    if (registryImage) {
      this.doPullFromRegistry(image, registryImage);
    } else {
      // No registry mapping — mark as error since we can't pull custom images
      this.markError(image, `No registry mapping for image "${image}". Build it from a Dockerfile instead.`);
    }
  }

  private async doPullFromRegistry(localTag: string, registryImage: string): Promise<void> {
    try {
      const pulled = await containerManager.pullImage(registryImage, localTag, (line) => {
        this.appendProgress(localTag, line);
      });

      if (pulled) {
        this.markReady(localTag);
      } else {
        // Pull failed — try local build for default image
        if (localTag === "the-companion:latest") {
          this.appendProgress(localTag, "Pull failed, falling back to local build...");
          await this.doLocalBuild(localTag);
        } else {
          this.markError(localTag, "Pull failed from registry");
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // Try local build fallback for default image
      if (localTag === "the-companion:latest") {
        this.appendProgress(localTag, `Pull error (${reason}), falling back to local build...`);
        await this.doLocalBuild(localTag);
      } else {
        this.markError(localTag, reason);
      }
    }
  }

  private async doLocalBuild(localTag: string): Promise<void> {
    const dockerfilePath = join(WEB_DIR, "docker", "Dockerfile.the-companion");
    if (!existsSync(dockerfilePath)) {
      this.markError(localTag, `Dockerfile not found at ${dockerfilePath}`);
      return;
    }

    try {
      this.appendProgress(localTag, `Building ${localTag} from local Dockerfile...`);
      containerManager.buildImage(dockerfilePath, localTag);
      this.markReady(localTag);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.markError(localTag, `Build failed: ${reason}`);
    }
  }

  private appendProgress(image: string, line: string): void {
    const state = this.states.get(image);
    if (!state) return;
    state.progress.push(line);
    if (state.progress.length > MAX_PROGRESS_LINES) {
      state.progress.splice(0, state.progress.length - MAX_PROGRESS_LINES);
    }

    // Notify progress listeners
    const key = `progress:${image}`;
    const listeners = this.progressListeners.get(key);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(line); } catch { /* ignore */ }
      }
    }
  }

  private markReady(image: string): void {
    const state = this.states.get(image);
    if (state) {
      state.status = "ready";
      state.completedAt = Date.now();
      this.appendProgress(image, "Image ready");
    }
    this.notifyListeners(image);
  }

  private markError(image: string, error: string): void {
    const state = this.states.get(image);
    if (state) {
      state.status = "error";
      state.error = error;
      state.completedAt = Date.now();
      this.appendProgress(image, `Error: ${error}`);
    }
    this.notifyListeners(image);
  }

  private notifyListeners(image: string): void {
    const listeners = this.readyListeners.get(image);
    if (listeners) {
      for (const listener of listeners) {
        try { listener(); } catch { /* ignore */ }
      }
      this.readyListeners.delete(image);
    }
  }
}

// Singleton export
export const imagePullManager = new ImagePullManager();
