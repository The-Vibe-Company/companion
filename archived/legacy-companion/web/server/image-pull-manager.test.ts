import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock container-manager
const mockImageExists = vi.hoisted(() => vi.fn((_image: string) => false));
const mockPullImage = vi.hoisted(() => vi.fn(async (_remote: string, _local: string, _onProgress?: (line: string) => void) => true));
const mockBuildImage = vi.hoisted(() => vi.fn((_path: string, _tag?: string) => "ok"));
const mockGetRegistryImage = vi.hoisted(() => vi.fn((tag: string) => {
  if (tag === "the-companion:latest") return "docker.io/stangirard/the-companion:latest";
  return null as string | null;
}));

vi.mock("./container-manager.js", () => ({
  containerManager: {
    imageExists: mockImageExists,
    pullImage: mockPullImage,
    buildImage: mockBuildImage,
  },
  ContainerManager: {
    getRegistryImage: mockGetRegistryImage,
  },
}));

// Mock env-manager
const mockListEnvs = vi.hoisted(() => vi.fn(() => [] as Array<{ name: string; slug: string; baseImage?: string; imageTag?: string; variables: Record<string, string>; createdAt: number; updatedAt: number }>));
vi.mock("./env-manager.js", () => ({
  listEnvs: mockListEnvs,
}));

// Mock existsSync for Dockerfile fallback
const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, existsSync: mockExistsSync };
});

// We need to re-import for each test to get a fresh singleton.
// Instead we use a factory approach.
async function createManager() {
  // Clear module cache so we get a fresh singleton
  vi.resetModules();
  const mod = await import("./image-pull-manager.js");
  return mod.imagePullManager;
}

describe("ImagePullManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImageExists.mockReturnValue(false);
    mockPullImage.mockResolvedValue(true);
    mockBuildImage.mockReturnValue("ok");
    mockExistsSync.mockReturnValue(true);
    // Restore default registry mapping (clearAllMocks removes it)
    mockGetRegistryImage.mockImplementation((tag: string) => {
      if (tag === "the-companion:latest") return "docker.io/stangirard/the-companion:latest";
      return null as string | null;
    });
  });

  describe("getState", () => {
    it("returns 'ready' when image exists locally", async () => {
      mockImageExists.mockReturnValue(true);
      const manager = await createManager();
      const state = manager.getState("the-companion:latest");
      expect(state.status).toBe("ready");
      expect(state.image).toBe("the-companion:latest");
    });

    it("returns 'idle' when image does not exist locally", async () => {
      mockImageExists.mockReturnValue(false);
      const manager = await createManager();
      const state = manager.getState("the-companion:latest");
      expect(state.status).toBe("idle");
    });
  });

  describe("isReady", () => {
    it("returns true when image exists locally", async () => {
      mockImageExists.mockReturnValue(true);
      const manager = await createManager();
      expect(manager.isReady("the-companion:latest")).toBe(true);
    });

    it("returns false when image does not exist locally", async () => {
      mockImageExists.mockReturnValue(false);
      const manager = await createManager();
      expect(manager.isReady("the-companion:latest")).toBe(false);
    });
  });

  describe("ensureImage", () => {
    it("starts a background pull when image is missing", async () => {
      mockImageExists.mockReturnValue(false);
      const manager = await createManager();

      manager.ensureImage("the-companion:latest");

      const state = manager.getState("the-companion:latest");
      expect(state.status).toBe("pulling");
      expect(state.startedAt).toBeGreaterThan(0);

      // Wait for the async pull to complete
      await vi.waitFor(() => {
        expect(manager.getState("the-companion:latest").status).toBe("ready");
      });
      expect(mockPullImage).toHaveBeenCalledOnce();
    });

    it("is a no-op when image is already ready", async () => {
      mockImageExists.mockReturnValue(true);
      const manager = await createManager();

      manager.ensureImage("the-companion:latest");

      expect(mockPullImage).not.toHaveBeenCalled();
    });

    it("is a no-op when image is already being pulled", async () => {
      mockImageExists.mockReturnValue(false);
      // Make pull hang
      mockPullImage.mockImplementation(() => new Promise(() => {}));
      const manager = await createManager();

      manager.ensureImage("the-companion:latest");
      manager.ensureImage("the-companion:latest"); // second call

      expect(mockPullImage).toHaveBeenCalledOnce();
    });
  });

  describe("waitForReady", () => {
    it("resolves immediately when image already exists", async () => {
      mockImageExists.mockReturnValue(true);
      const manager = await createManager();

      const result = await manager.waitForReady("the-companion:latest");
      expect(result).toBe(true);
    });

    it("waits for an in-progress pull to complete", async () => {
      mockImageExists.mockReturnValue(false);
      const manager = await createManager();

      manager.ensureImage("the-companion:latest");
      const result = await manager.waitForReady("the-companion:latest", 5000);
      expect(result).toBe(true);
    });

    it("returns false when pull fails", async () => {
      mockImageExists.mockReturnValue(false);
      mockPullImage.mockResolvedValue(false);
      mockExistsSync.mockReturnValue(false); // no Dockerfile fallback
      const manager = await createManager();

      const result = await manager.waitForReady("the-companion:latest", 5000);
      expect(result).toBe(false);
    });

    it("starts a pull if image is idle and not present", async () => {
      mockImageExists.mockReturnValue(false);
      const manager = await createManager();

      // Calling waitForReady on an idle image should trigger a pull
      const result = await manager.waitForReady("the-companion:latest", 5000);
      expect(result).toBe(true);
      expect(mockPullImage).toHaveBeenCalledOnce();
    });

    it("times out when pull takes too long", async () => {
      mockImageExists.mockReturnValue(false);
      mockPullImage.mockImplementation(() => new Promise(() => {})); // never resolves
      const manager = await createManager();

      const result = await manager.waitForReady("the-companion:latest", 50);
      expect(result).toBe(false);
    });
  });

  describe("pull (force re-pull)", () => {
    it("triggers a pull even when image is already present", async () => {
      mockImageExists.mockReturnValue(true);
      const manager = await createManager();

      manager.pull("the-companion:latest");

      // Should have started pulling despite image being present
      const state = manager.getState("the-companion:latest");
      expect(state.status).toBe("pulling");
      expect(mockPullImage).toHaveBeenCalledOnce();
    });

    it("is a no-op when a pull is already in progress", async () => {
      mockImageExists.mockReturnValue(false);
      mockPullImage.mockImplementation(() => new Promise(() => {}));
      const manager = await createManager();

      manager.pull("the-companion:latest");
      manager.pull("the-companion:latest");

      expect(mockPullImage).toHaveBeenCalledOnce();
    });
  });

  describe("onProgress", () => {
    it("fires callback for each progress line during pull", async () => {
      mockImageExists.mockReturnValue(false);
      const lines: string[] = [];
      mockPullImage.mockImplementation(async (_remote: string, _local: string, onProgress?: (line: string) => void) => {
        onProgress?.("Downloading layer 1/3");
        onProgress?.("Downloading layer 2/3");
        onProgress?.("Downloading layer 3/3");
        return true;
      });

      const manager = await createManager();
      const unsub = manager.onProgress("the-companion:latest", (line) => lines.push(line));

      manager.ensureImage("the-companion:latest");

      await vi.waitFor(() => {
        expect(manager.getState("the-companion:latest").status).toBe("ready");
      });

      // Should have received the pull lines plus "Image ready"
      expect(lines).toContain("Downloading layer 1/3");
      expect(lines).toContain("Downloading layer 2/3");
      expect(lines).toContain("Downloading layer 3/3");
      expect(lines).toContain("Image ready");

      unsub();
    });
  });

  describe("fallback to local build", () => {
    it("falls back to local build when pull fails for the-companion:latest", async () => {
      mockImageExists.mockReturnValue(false);
      mockPullImage.mockResolvedValue(false);
      mockExistsSync.mockReturnValue(true);

      const manager = await createManager();
      const result = await manager.waitForReady("the-companion:latest", 5000);

      expect(result).toBe(true);
      expect(mockPullImage).toHaveBeenCalledOnce();
      expect(mockBuildImage).toHaveBeenCalledOnce();
    });

    it("errors when pull fails for non-default image", async () => {
      mockImageExists.mockReturnValue(false);
      mockGetRegistryImage.mockReturnValue(null);

      const manager = await createManager();
      const result = await manager.waitForReady("custom-image:v1", 5000);

      expect(result).toBe(false);
      const state = manager.getState("custom-image:v1");
      expect(state.status).toBe("error");
    });

    it("errors when pull fails and no Dockerfile exists", async () => {
      mockImageExists.mockReturnValue(false);
      mockPullImage.mockResolvedValue(false);
      mockExistsSync.mockReturnValue(false); // no Dockerfile

      const manager = await createManager();
      const result = await manager.waitForReady("the-companion:latest", 5000);

      expect(result).toBe(false);
      const state = manager.getState("the-companion:latest");
      expect(state.status).toBe("error");
      expect(state.error).toContain("Dockerfile not found");
    });
  });

  describe("initFromEnvironments", () => {
    it("is a no-op since environments no longer carry Docker fields", async () => {
      mockImageExists.mockReturnValue(false);
      mockListEnvs.mockReturnValue([
        { name: "env1", slug: "env1", baseImage: "the-companion:latest", variables: {}, createdAt: 0, updatedAt: 0 },
        { name: "env2", slug: "env2", imageTag: "custom:v1", variables: {}, createdAt: 0, updatedAt: 0 },
      ]);

      const manager = await createManager();
      manager.initFromEnvironments();

      // initFromEnvironments is now a no-op — Docker fields moved to Sandboxes.
      // No image pulls should be triggered regardless of environment config.
      expect(mockPullImage).not.toHaveBeenCalled();
      expect(mockListEnvs).not.toHaveBeenCalled();
    });

    it("skips images that are already available", async () => {
      mockImageExists.mockReturnValue(true);
      mockListEnvs.mockReturnValue([
        { name: "env1", slug: "env1", baseImage: "the-companion:latest", variables: {}, createdAt: 0, updatedAt: 0 },
      ]);

      const manager = await createManager();
      manager.initFromEnvironments();

      expect(mockPullImage).not.toHaveBeenCalled();
    });
  });
});
