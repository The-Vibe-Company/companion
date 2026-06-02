import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
// All node:fs, node:fs/promises, and node:os functions are mocked before any
// module-level code runs. This is critical because SKILLS_DIR is computed at
// import time via homedir().

const mockExistsSync = vi.hoisted(() => vi.fn(() => false));
const mockReaddir = vi.hoisted(() => vi.fn(async () => []));
const mockReadFile = vi.hoisted(() => vi.fn(async () => ""));
const mockWriteFile = vi.hoisted(() => vi.fn(async (_path: string, _content: string) => {}));
const mockRm = vi.hoisted(() => vi.fn(async () => {}));
const mockMkdir = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("node:fs", () => ({ existsSync: mockExistsSync }));
vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rm: mockRm,
  mkdir: mockMkdir,
}));
vi.mock("node:os", () => ({ homedir: () => "/mock-home" }));

import { Hono } from "hono";
import { registerSkillRoutes } from "./skills-routes.js";

// ─── Constants ──────────────────────────────────────────────────────────────
// SKILLS_DIR resolves to /mock-home/.claude/skills because homedir() is mocked.
const SKILLS_DIR = "/mock-home/.claude/skills";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a fake directory entry for readdir({ withFileTypes: true }).
 * Simulates a Dirent object with name and isDirectory method.
 */
function makeDirent(name: string, isDir = true) {
  return { name, isDirectory: () => isDir };
}

/**
 * Builds a SKILL.md file content string with YAML front matter.
 * Allows testing the front matter parser with various name/description values.
 */
function makeSkillMd(name: string, description: string, body = "") {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}`;
}

// ─── Test setup ─────────────────────────────────────────────────────────────

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset all mocks to their default return values
  mockExistsSync.mockReturnValue(false);
  mockReaddir.mockResolvedValue([]);
  mockReadFile.mockResolvedValue("");
  mockWriteFile.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);

  app = new Hono();
  registerSkillRoutes(app);
});

// ─── GET /skills ────────────────────────────────────────────────────────────

describe("GET /skills", () => {
  it("returns an empty array when SKILLS_DIR does not exist", async () => {
    // existsSync returns false by default, so the directory doesn't exist
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("returns an empty array when SKILLS_DIR exists but is empty", async () => {
    // The first existsSync call checks SKILLS_DIR itself
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([]);

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("skips non-directory entries in SKILLS_DIR", async () => {
    // Files inside the skills directory should be ignored (only directories matter)
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([
      makeDirent("readme.txt", false),
      makeDirent(".DS_Store", false),
    ] as any);

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("skips directories that have no SKILL.md file", async () => {
    // A directory exists but its SKILL.md path check returns false
    mockExistsSync
      .mockReturnValueOnce(true) // SKILLS_DIR exists
      .mockReturnValueOnce(false); // SKILL.md does not exist
    mockReaddir.mockResolvedValue([makeDirent("orphan-dir")] as any);

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("parses front matter and returns skill metadata for valid skills", async () => {
    // Two valid skill directories with properly formatted SKILL.md files
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([
      makeDirent("my-skill"),
      makeDirent("another-skill"),
    ] as any);
    mockReadFile
      .mockResolvedValueOnce(makeSkillMd("My Skill", "Does cool things", "# Usage\nRun it."))
      .mockResolvedValueOnce(makeSkillMd("Another Skill", "Also useful"));

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(2);
    expect(json[0]).toEqual({
      slug: "my-skill",
      name: "My Skill",
      description: "Does cool things",
      path: `${SKILLS_DIR}/my-skill/SKILL.md`,
    });
    expect(json[1]).toEqual({
      slug: "another-skill",
      name: "Another Skill",
      description: "Also useful",
      path: `${SKILLS_DIR}/another-skill/SKILL.md`,
    });
  });

  it("uses the directory name as fallback when front matter has no name field", async () => {
    // Front matter exists but has no name: line — slug should be used as name
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeDirent("fallback-skill")] as any);
    mockReadFile.mockResolvedValue("---\ndescription: \"just a description\"\n---\n\nsome content");

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].name).toBe("fallback-skill");
    expect(json[0].description).toBe("just a description");
  });

  it("handles SKILL.md files with no front matter (no --- delimiters)", async () => {
    // Content without front matter — name falls back to directory name, description empty
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeDirent("raw-skill")] as any);
    mockReadFile.mockResolvedValue("# Raw Skill\n\nNo front matter here.");

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].name).toBe("raw-skill");
    expect(json[0].description).toBe("");
  });

  it("strips quotes from name values in front matter", async () => {
    // Name wrapped in double quotes should have them removed
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeDirent("quoted-skill")] as any);
    mockReadFile.mockResolvedValue('---\nname: "Quoted Name"\ndescription: "desc"\n---\n\ncontent');

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].name).toBe("Quoted Name");
  });

  it("strips single quotes from name values in front matter", async () => {
    // Name wrapped in single quotes should also be stripped
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeDirent("sq-skill")] as any);
    mockReadFile.mockResolvedValue("---\nname: 'Single Quoted'\ndescription: 'desc'\n---\n\ncontent");

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].name).toBe("Single Quoted");
  });

  it("returns a mixed list filtering out non-directories and missing SKILL.md entries", async () => {
    // Mix of valid directories, non-directories, and directories without SKILL.md
    mockExistsSync
      .mockReturnValueOnce(true) // SKILLS_DIR exists
      .mockReturnValueOnce(true) // valid-skill/SKILL.md exists
      .mockReturnValueOnce(false); // no-md-skill/SKILL.md does not exist
    mockReaddir.mockResolvedValue([
      makeDirent("valid-skill"),
      makeDirent("just-a-file.txt", false),
      makeDirent("no-md-skill"),
    ] as any);
    mockReadFile.mockResolvedValueOnce(makeSkillMd("Valid", "A valid skill"));

    const res = await app.request("/skills");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].slug).toBe("valid-skill");
  });

  it("returns 500 when readdir throws an unexpected error", async () => {
    // Simulates a filesystem error during directory listing
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockRejectedValue(new Error("Permission denied"));

    const res = await app.request("/skills");

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("Permission denied");
  });

  it("returns 500 when readFile throws an unexpected error", async () => {
    // Simulates a read error on an individual SKILL.md file
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([makeDirent("broken-skill")] as any);
    mockReadFile.mockRejectedValue(new Error("EACCES: permission denied"));

    const res = await app.request("/skills");

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("EACCES");
  });
});

// ─── GET /skills/:slug ──────────────────────────────────────────────────────

describe("GET /skills/:slug", () => {
  it("returns the skill content when slug and SKILL.md are valid", async () => {
    // Happy path: valid slug, file exists, content is returned
    const content = makeSkillMd("My Skill", "A useful skill", "# Usage\nDo stuff.");
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(content);

    const res = await app.request("/skills/my-skill");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      slug: "my-skill",
      path: `${SKILLS_DIR}/my-skill/SKILL.md`,
      content,
    });
  });

  it("returns 404 when SKILL.md does not exist for the slug", async () => {
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills/nonexistent");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Skill not found");
  });

  it("returns 400 when slug contains '..'", async () => {
    // Path traversal attempt with double dots
    const res = await app.request("/skills/..%2F..%2Fetc");

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });

  it("returns 400 when slug contains a forward slash", async () => {
    // The route parameter itself won't contain a literal '/' since Hono
    // treats it as a path separator. However, URL-encoded '/' (%2F) in
    // the slug param is tested here to verify the validation logic.
    // We test the validation by calling the path directly with a known bad slug.
    const res = await app.request("/skills/bad%2Fslug");

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });

  it("returns 400 when slug contains a backslash", async () => {
    const res = await app.request("/skills/bad%5Cslug");

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });
});

// ─── POST /skills ───────────────────────────────────────────────────────────

describe("POST /skills", () => {
  it("creates a new skill with name, description, and content", async () => {
    // Happy path: new skill that does not yet exist
    mockExistsSync.mockReturnValue(false); // SKILL.md doesn't exist yet

    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My New Skill",
        description: "Does amazing things",
        content: "# My New Skill\n\nHere are the instructions.",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe("my-new-skill");
    expect(json.name).toBe("My New Skill");
    expect(json.description).toBe("Does amazing things");
    expect(json.path).toBe(`${SKILLS_DIR}/my-new-skill/SKILL.md`);

    // Verify mkdir was called for both SKILLS_DIR and the skill directory
    expect(mockMkdir).toHaveBeenCalledWith(SKILLS_DIR, { recursive: true });
    expect(mockMkdir).toHaveBeenCalledWith(`${SKILLS_DIR}/my-new-skill`, { recursive: true });

    // Verify writeFile was called with the expected markdown content
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFile.mock.calls[0][1] as string;
    expect(writtenContent).toContain("name: my-new-skill");
    expect(writtenContent).toContain('"Does amazing things"');
    expect(writtenContent).toContain("# My New Skill\n\nHere are the instructions.");
  });

  it("generates default content when content is not provided", async () => {
    // Omitting content should produce a default "# Name" body
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bare Skill" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe("bare-skill");

    // Default content should include the skill name as a heading
    const writtenContent = mockWriteFile.mock.calls[0][1] as string;
    expect(writtenContent).toContain("# Bare Skill");
    expect(writtenContent).toContain("Describe what this skill does");
  });

  it("generates a default description when description is not provided", async () => {
    // Omitting description should fallback to "Skill: <name>"
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Desc" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.description).toBe("Skill: No Desc");
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "No name provided" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("name is required");
  });

  it("returns 400 when name is not a string", async () => {
    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 12345 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("name is required");
  });

  it("returns 400 when name is an empty string", async () => {
    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("name is required");
  });

  it("returns 400 when name produces an empty slug (all special characters)", async () => {
    // A name like "!!!" would become an empty slug after sanitization
    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "!!!" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid name");
  });

  it("returns 409 when a skill with the same slug already exists", async () => {
    // existsSync returns true for the SKILL.md check, indicating conflict
    mockExistsSync.mockReturnValue(true);

    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Existing Skill" }),
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("already exists");
    expect(json.error).toContain("existing-skill");
  });

  it("handles invalid JSON body gracefully", async () => {
    // Malformed JSON should not crash the server — c.req.json().catch returns {}
    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("name is required");
  });

  it("generates a correct slug from a name with special characters", async () => {
    // Names with mixed case, spaces, and special chars should produce clean slugs
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  Hello World!!! @#$ Test  " }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // The slug generation lowercases, replaces non-alphanum with hyphens,
    // and trims leading/trailing hyphens
    expect(json.slug).toBe("hello-world-test");
  });

  it("trims leading and trailing hyphens from the generated slug", async () => {
    // A name with leading/trailing special chars should not produce leading/trailing hyphens
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "---trimmed---" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe("trimmed");
  });
});

// ─── PUT /skills/:slug ──────────────────────────────────────────────────────

describe("PUT /skills/:slug", () => {
  it("updates the skill content when slug is valid and skill exists", async () => {
    // Happy path: existing skill, valid content update
    mockExistsSync.mockReturnValue(true);
    const newContent = "---\nname: updated\n---\n\n# Updated content";

    const res = await app.request("/skills/my-skill", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newContent }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      ok: true,
      slug: "my-skill",
      path: `${SKILLS_DIR}/my-skill/SKILL.md`,
    });

    // Verify writeFile was called with the new content
    expect(mockWriteFile).toHaveBeenCalledWith(
      `${SKILLS_DIR}/my-skill/SKILL.md`,
      newContent,
      "utf-8",
    );
  });

  it("allows updating with empty string content", async () => {
    // An empty string is still a valid content value (typeof is "string")
    mockExistsSync.mockReturnValue(true);

    const res = await app.request("/skills/my-skill", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith(
      `${SKILLS_DIR}/my-skill/SKILL.md`,
      "",
      "utf-8",
    );
  });

  it("returns 404 when the skill does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills/nonexistent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "anything" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Skill not found");
  });

  it("returns 400 when content is missing from the body", async () => {
    mockExistsSync.mockReturnValue(true);

    const res = await app.request("/skills/my-skill", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no content field" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("content is required");
  });

  it("returns 400 when content is not a string", async () => {
    mockExistsSync.mockReturnValue(true);

    const res = await app.request("/skills/my-skill", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: 42 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("content is required");
  });

  it("returns 400 when slug contains '..'", async () => {
    const res = await app.request("/skills/..%2Fevil", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "pwned" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });

  it("returns 400 when slug contains a backslash", async () => {
    const res = await app.request("/skills/back%5Cslash", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });

  it("handles invalid JSON body gracefully", async () => {
    // Malformed body falls through to the content check
    mockExistsSync.mockReturnValue(true);

    const res = await app.request("/skills/my-skill", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{{bad json",
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("content is required");
  });
});

// ─── DELETE /skills/:slug ───────────────────────────────────────────────────

describe("DELETE /skills/:slug", () => {
  it("deletes the skill directory when it exists", async () => {
    // Happy path: directory exists, rm succeeds
    mockExistsSync.mockReturnValue(true);

    const res = await app.request("/skills/doomed-skill", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, slug: "doomed-skill" });

    // Verify rm was called with recursive and force flags on the directory
    expect(mockRm).toHaveBeenCalledWith(
      `${SKILLS_DIR}/doomed-skill`,
      { recursive: true, force: true },
    );
  });

  it("returns 404 when the skill directory does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    const res = await app.request("/skills/ghost", { method: "DELETE" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Skill not found");
  });

  it("returns 400 when slug contains '..'", async () => {
    const res = await app.request("/skills/..%2F..%2Fetc", { method: "DELETE" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });

  it("returns 400 when slug contains a forward slash", async () => {
    const res = await app.request("/skills/a%2Fb", { method: "DELETE" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });

  it("returns 400 when slug contains a backslash", async () => {
    const res = await app.request("/skills/a%5Cb", { method: "DELETE" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });

  it("does not call rm when slug validation fails", async () => {
    // Ensure that the filesystem is never touched for invalid slugs
    await app.request("/skills/..%2Fetc%2Fpasswd", { method: "DELETE" });

    expect(mockRm).not.toHaveBeenCalled();
  });
});
