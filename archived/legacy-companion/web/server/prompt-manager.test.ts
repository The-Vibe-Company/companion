import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let promptManager: typeof import("./prompt-manager.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "prompt-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  promptManager = await import("./prompt-manager.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createPrompt", () => {
  it("creates a global prompt", () => {
    // Validates global prompts persist without project path coupling.
    const prompt = promptManager.createPrompt("Review PR", "Review this PR and summarize risks", "global");
    expect(prompt.scope).toBe("global");
    expect(prompt.projectPath).toBeUndefined();
    expect(prompt.projectPaths).toBeUndefined();
    expect(prompt.id).toBeTruthy();
  });

  it("creates a project prompt with normalized path", () => {
    // Validates project scope stores a normalized project root for later cwd matching.
    const prompt = promptManager.createPrompt("Plan", "Plan this feature", "project", "/tmp/my-repo/");
    expect(prompt.scope).toBe("project");
    expect(prompt.projectPath).toBe("/tmp/my-repo");
    expect(prompt.projectPaths).toEqual(["/tmp/my-repo"]);
  });

  it("creates a project prompt with multiple projectPaths", () => {
    // Validates multi-folder targeting stores all paths normalized and deduplicated.
    const prompt = promptManager.createPrompt(
      "Multi",
      "Multi-project prompt",
      "project",
      undefined,
      ["/tmp/repo-a/", "/tmp/repo-b", "/tmp/repo-a/"],
    );
    expect(prompt.scope).toBe("project");
    expect(prompt.projectPaths).toEqual(["/tmp/repo-a", "/tmp/repo-b"]);
    // projectPath is set to the first path for backward compatibility
    expect(prompt.projectPath).toBe("/tmp/repo-a");
  });

  it("merges projectPaths and legacy projectPath without duplicates", () => {
    // When both projectPaths and projectPath are provided, they should be merged and deduped.
    const prompt = promptManager.createPrompt(
      "Merge",
      "Merged",
      "project",
      "/tmp/repo-a",
      ["/tmp/repo-b", "/tmp/repo-a"],
    );
    expect(prompt.projectPaths).toEqual(["/tmp/repo-b", "/tmp/repo-a"]);
  });

  it("rejects project prompts without a project path", () => {
    expect(() => promptManager.createPrompt("Plan", "x", "project")).toThrow(
      "Project path is required for project prompts",
    );
  });

  it("rejects project prompts with empty projectPaths array", () => {
    // An empty array is not valid for project scope.
    expect(() => promptManager.createPrompt("Plan", "x", "project", undefined, [])).toThrow(
      "Project path is required for project prompts",
    );
  });
});

describe("listPrompts", () => {
  it("returns global + matching project prompts for cwd", () => {
    // Verifies cwd filtering includes global prompts and only project prompts in the same repo subtree.
    const global = promptManager.createPrompt("Global", "Global text", "global");
    const project = promptManager.createPrompt("Project", "Project text", "project", "/tmp/repo");
    promptManager.createPrompt("Other", "Other text", "project", "/tmp/other");

    const prompts = promptManager.listPrompts({ cwd: "/tmp/repo/packages/ui" });
    expect(prompts.map((p) => p.id)).toContain(global.id);
    expect(prompts.map((p) => p.id)).toContain(project.id);
    expect(prompts.map((p) => p.name)).not.toContain("Other");
  });

  it("matches cwd against any of the projectPaths", () => {
    // A prompt with multiple projectPaths should be visible in any of those directories.
    const multi = promptManager.createPrompt(
      "Multi-target",
      "Visible in both repos",
      "project",
      undefined,
      ["/tmp/repo-a", "/tmp/repo-b"],
    );

    const inA = promptManager.listPrompts({ cwd: "/tmp/repo-a/src" });
    expect(inA.map((p) => p.id)).toContain(multi.id);

    const inB = promptManager.listPrompts({ cwd: "/tmp/repo-b" });
    expect(inB.map((p) => p.id)).toContain(multi.id);

    const inC = promptManager.listPrompts({ cwd: "/tmp/repo-c" });
    expect(inC.map((p) => p.id)).not.toContain(multi.id);
  });

  it("reads legacy prompts with only projectPath (no projectPaths)", () => {
    // Simulates loading a prompts.json that was created before projectPaths existed.
    const companionDir = join(tempDir, ".companion");
    mkdirSync(companionDir, { recursive: true });
    writeFileSync(
      join(companionDir, "prompts.json"),
      JSON.stringify([
        {
          id: "legacy-1",
          name: "Legacy",
          content: "Legacy prompt",
          scope: "project",
          projectPath: "/tmp/legacy-repo",
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    );

    // Re-import to pick up the written file
    const prompts = promptManager.listPrompts({ cwd: "/tmp/legacy-repo/src" });
    expect(prompts.map((p) => p.id)).toContain("legacy-1");
  });
});

describe("updatePrompt", () => {
  it("updates a prompt name/content", () => {
    // Ensures edits update mutable fields while preserving prompt identity.
    const prompt = promptManager.createPrompt("Old", "Old content", "global");
    const updated = promptManager.updatePrompt(prompt.id, { name: "New", content: "New content" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New");
    expect(updated!.content).toBe("New content");
  });

  it("changes scope from global to project with projectPaths", () => {
    // Validates that update can change scope and set project paths.
    const prompt = promptManager.createPrompt("Was global", "Some content", "global");
    const updated = promptManager.updatePrompt(prompt.id, {
      scope: "project",
      projectPaths: ["/tmp/repo-x"],
    });
    expect(updated!.scope).toBe("project");
    expect(updated!.projectPaths).toEqual(["/tmp/repo-x"]);
    expect(updated!.projectPath).toBe("/tmp/repo-x");
  });

  it("changes scope from project to global and clears paths", () => {
    // Validates that switching to global removes projectPaths.
    const prompt = promptManager.createPrompt("Was project", "Content", "project", "/tmp/repo");
    const updated = promptManager.updatePrompt(prompt.id, { scope: "global" });
    expect(updated!.scope).toBe("global");
    expect(updated!.projectPaths).toBeUndefined();
    expect(updated!.projectPath).toBeUndefined();
  });

  it("rejects switching to project scope without paths", () => {
    // Project scope without paths should fail validation.
    const prompt = promptManager.createPrompt("Global", "Content", "global");
    expect(() => promptManager.updatePrompt(prompt.id, { scope: "project" })).toThrow(
      "Project path is required for project prompts",
    );
  });

  it("updates projectPaths on an existing project prompt", () => {
    // Validates that projectPaths can be updated independently.
    const prompt = promptManager.createPrompt("Project", "Content", "project", "/tmp/repo-a");
    const updated = promptManager.updatePrompt(prompt.id, {
      projectPaths: ["/tmp/repo-b", "/tmp/repo-c"],
    });
    expect(updated!.projectPaths).toEqual(["/tmp/repo-b", "/tmp/repo-c"]);
    expect(updated!.projectPath).toBe("/tmp/repo-b");
  });
});

describe("deletePrompt", () => {
  it("deletes a prompt", () => {
    // Ensures a deleted prompt is no longer retrievable.
    const prompt = promptManager.createPrompt("Delete me", "tmp", "global");
    expect(promptManager.deletePrompt(prompt.id)).toBe(true);
    expect(promptManager.getPrompt(prompt.id)).toBeNull();
  });
});
