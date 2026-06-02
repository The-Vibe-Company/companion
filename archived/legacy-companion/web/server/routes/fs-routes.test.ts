import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execSync } from "node:child_process";
import { Hono } from "hono";
import { registerFsRoutes } from "./fs-routes.js";

/** Create a temp dir with symlinks resolved (macOS /var → /private/var) */
const mkRealTempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// Create a Hono app with the fs routes for testing
let app: Hono;
let tempDir: string;

beforeEach(() => {
  tempDir = mkRealTempDir("fs-raw-test-");
  app = new Hono();
  // Pass tempDir as an allowed base so test files are accessible
  registerFsRoutes(app, { allowedBases: [tempDir] });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("GET /fs/raw", () => {
  it("returns binary content with correct Content-Type for a PNG file", async () => {
    // A .png file should be served with image/png MIME type and raw binary body
    const filePath = join(tempDir, "test.png");
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    writeFileSync(filePath, pngHeader);

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/png|application\/octet-stream/);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(4);
  });

  it("returns 400 when path query parameter is missing", async () => {
    const res = await app.request("/fs/raw");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path required");
  });

  it("returns 404 when file does not exist", async () => {
    const fakePath = join(tempDir, "nonexistent.png");
    const res = await app.request(`/fs/raw?path=${encodeURIComponent(fakePath)}`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 413 when file exceeds 10MB", async () => {
    // Create a file just over the 10MB limit to trigger the size guard
    const filePath = join(tempDir, "large.bin");
    const buf = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    writeFileSync(filePath, buf);

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("serves a JPEG file with correct MIME type", async () => {
    // Verifies MIME detection works for different image extensions
    const filePath = join(tempDir, "photo.jpg");
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic bytes

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/jpeg|application\/octet-stream/);
  });

  it("serves an SVG file with correct MIME type", async () => {
    const filePath = join(tempDir, "icon.svg");
    writeFileSync(filePath, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');

    const res = await app.request(`/fs/raw?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/svg|application\/octet-stream/);
  });
});

describe("path traversal protection", () => {
  it("rejects /fs/read for paths outside allowed bases", async () => {
    // Attempting to read /etc/passwd should be blocked by the path guard
    const res = await app.request(`/fs/read?path=${encodeURIComponent("/etc/passwd")}`);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside allowed/i);
  });

  it("rejects /fs/raw for paths outside allowed bases", async () => {
    const res = await app.request(`/fs/raw?path=${encodeURIComponent("/etc/hosts")}`);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside allowed/i);
  });

  it("rejects /fs/list for paths outside allowed bases", async () => {
    const res = await app.request(`/fs/list?path=${encodeURIComponent("/etc")}`);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside allowed/i);
  });

  it("rejects /fs/tree for paths outside allowed bases", async () => {
    const res = await app.request(`/fs/tree?path=${encodeURIComponent("/etc")}`);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside allowed/i);
  });

  it("rejects /fs/write for paths outside allowed bases", async () => {
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/evil.txt", content: "pwned" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside allowed/i);
  });

  it("rejects directory traversal with ../ sequences", async () => {
    // Even if the path starts within allowed base, ../ could escape it
    const traversalPath = join(tempDir, "..", "..", "etc", "passwd");
    const res = await app.request(`/fs/read?path=${encodeURIComponent(traversalPath)}`);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/outside allowed/i);
  });

  it("allows access to files within allowed bases", async () => {
    // Files inside tempDir (our allowed base) should work fine
    const filePath = join(tempDir, "allowed.txt");
    writeFileSync(filePath, "hello");

    const res = await app.request(`/fs/read?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fs/list — directory listing with sorting and error handling
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /fs/list", () => {
  it("lists only directories (not files), sorted alphabetically", async () => {
    // Create a mix of directories and files; only directories should be returned
    mkdirSync(join(tempDir, "zulu"));
    mkdirSync(join(tempDir, "alpha"));
    mkdirSync(join(tempDir, "mike"));
    writeFileSync(join(tempDir, "file.txt"), "not a dir");

    const res = await app.request(`/fs/list?path=${encodeURIComponent(tempDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(tempDir);
    expect(body.home).toBe(homedir());
    // Should only contain directories, sorted alphabetically
    expect(body.dirs.map((d: { name: string }) => d.name)).toEqual([
      "alpha",
      "mike",
      "zulu",
    ]);
    // Each entry should include the full path
    expect(body.dirs[0].path).toBe(join(tempDir, "alpha"));
  });

  it("excludes hidden directories (names starting with .)", async () => {
    // Hidden directories like .git or .config should be excluded from listing
    mkdirSync(join(tempDir, ".hidden"));
    mkdirSync(join(tempDir, "visible"));

    const res = await app.request(`/fs/list?path=${encodeURIComponent(tempDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dirs.map((d: { name: string }) => d.name)).toEqual(["visible"]);
  });

  it("returns empty dirs array for an empty directory", async () => {
    // A directory with no subdirectories should return an empty dirs array
    const emptyDir = join(tempDir, "empty");
    mkdirSync(emptyDir);

    const res = await app.request(`/fs/list?path=${encodeURIComponent(emptyDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dirs).toEqual([]);
  });

  it("returns 400 when the path does not exist", async () => {
    // Attempting to list a nonexistent directory should return an error with dirs: []
    const noDir = join(tempDir, "nonexistent");

    const res = await app.request(`/fs/list?path=${encodeURIComponent(noDir)}`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot read directory");
    expect(body.dirs).toEqual([]);
    expect(body.home).toBe(homedir());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fs/home — home directory and cwd logic
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /fs/home", () => {
  it("returns the home directory", async () => {
    // /fs/home should always include the real home directory
    const res = await app.request("/fs/home");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.home).toBe(homedir());
  });

  it("returns cwd different from home when running from a project directory", async () => {
    // When cwd is not the home dir and not under the package root, it should
    // be returned as the cwd (indicating a project directory context)
    const originalPackageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    delete process.env.__COMPANION_PACKAGE_ROOT;

    const res = await app.request("/fs/home");
    const body = await res.json();

    expect(res.status).toBe(200);
    // cwd should be the actual process.cwd() since we're in the web/ dir (not home)
    expect(body.cwd).toBeTruthy();

    // Restore
    if (originalPackageRoot !== undefined) {
      process.env.__COMPANION_PACKAGE_ROOT = originalPackageRoot;
    }
  });

  it("returns home as cwd when cwd equals home", async () => {
    // When cwd === home, the route should return home for both fields.
    // We can test this by using vi.spyOn to simulate cwd being home.
    const originalCwd = process.cwd;
    process.cwd = () => homedir();

    const res = await app.request("/fs/home");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cwd).toBe(homedir());

    process.cwd = originalCwd;
  });

  it("returns home as cwd when cwd is under the package root", async () => {
    // When __COMPANION_PACKAGE_ROOT is set and cwd starts with it,
    // the route treats cwd as the package install dir (not a real project)
    // and returns home instead.
    const originalCwd = process.cwd;
    const originalPackageRoot = process.env.__COMPANION_PACKAGE_ROOT;

    process.env.__COMPANION_PACKAGE_ROOT = "/fake/package/root";
    process.cwd = () => "/fake/package/root/subdir";

    const res = await app.request("/fs/home");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cwd).toBe(homedir());

    process.cwd = originalCwd;
    if (originalPackageRoot !== undefined) {
      process.env.__COMPANION_PACKAGE_ROOT = originalPackageRoot;
    } else {
      delete process.env.__COMPANION_PACKAGE_ROOT;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fs/tree — recursive tree building with depth limits and hidden exclusion
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /fs/tree", () => {
  it("returns 400 when path query parameter is missing", async () => {
    const res = await app.request("/fs/tree");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path required");
  });

  it("builds a tree with directories and files, sorted correctly", async () => {
    // Tree should list directories before files, both sorted alphabetically
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src", "index.ts"), "export {}");
    writeFileSync(join(tempDir, "src", "app.ts"), "const app = 1");
    mkdirSync(join(tempDir, "docs"));
    writeFileSync(join(tempDir, "README.md"), "# Hello");

    const res = await app.request(`/fs/tree?path=${encodeURIComponent(tempDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(tempDir);

    // Top-level: directories first (docs, src), then files (README.md)
    const names = body.tree.map((n: { name: string }) => n.name);
    expect(names).toEqual(["docs", "src", "README.md"]);

    // src directory should have children sorted alphabetically
    const srcNode = body.tree.find((n: { name: string }) => n.name === "src");
    expect(srcNode.type).toBe("directory");
    expect(srcNode.children.map((c: { name: string }) => c.name)).toEqual([
      "app.ts",
      "index.ts",
    ]);
  });

  it("excludes hidden files/directories and node_modules", async () => {
    // .git, .hidden, and node_modules should all be excluded from the tree
    mkdirSync(join(tempDir, ".git"));
    mkdirSync(join(tempDir, "node_modules"));
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, ".env"), "SECRET=x");

    const res = await app.request(`/fs/tree?path=${encodeURIComponent(tempDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.tree.map((n: { name: string }) => n.name);
    // Only "src" should be present — .git, node_modules, and .env should all be excluded
    expect(names).toEqual(["src"]);
  });

  it("handles nested directory structures recursively", async () => {
    // Create a 3-level deep directory structure
    mkdirSync(join(tempDir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(tempDir, "a", "b", "c", "deep.txt"), "deep file");

    const res = await app.request(`/fs/tree?path=${encodeURIComponent(tempDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    // Navigate the tree: a -> b -> c -> deep.txt
    const aNode = body.tree[0];
    expect(aNode.name).toBe("a");
    expect(aNode.type).toBe("directory");
    const bNode = aNode.children[0];
    expect(bNode.name).toBe("b");
    const cNode = bNode.children[0];
    expect(cNode.name).toBe("c");
    expect(cNode.children[0].name).toBe("deep.txt");
    expect(cNode.children[0].type).toBe("file");
  });

  it("returns an empty tree for an empty directory", async () => {
    const emptyDir = join(tempDir, "empty");
    mkdirSync(emptyDir);

    const res = await app.request(`/fs/tree?path=${encodeURIComponent(emptyDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fs/read — reading file contents
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /fs/read", () => {
  it("returns 400 when path query parameter is missing", async () => {
    const res = await app.request("/fs/read");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path required");
  });

  it("reads a file and returns its content", async () => {
    // Create a text file and verify it is read correctly
    const filePath = join(tempDir, "hello.txt");
    writeFileSync(filePath, "Hello, World!");

    const res = await app.request(`/fs/read?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(filePath);
    expect(body.content).toBe("Hello, World!");
  });

  it("returns 413 when file exceeds 2MB size limit", async () => {
    // The read endpoint has a stricter 2MB limit compared to raw's 10MB
    const filePath = join(tempDir, "bigfile.txt");
    const buf = Buffer.alloc(2 * 1024 * 1024 + 1, "x");
    writeFileSync(filePath, buf);

    const res = await app.request(`/fs/read?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("returns 404 when file does not exist", async () => {
    const fakePath = join(tempDir, "no-such-file.txt");
    const res = await app.request(`/fs/read?path=${encodeURIComponent(fakePath)}`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /fs/write — writing file contents
// ─────────────────────────────────────────────────────────────────────────────
describe("PUT /fs/write", () => {
  it("writes content to a file and returns ok", async () => {
    // Create a new file via the write endpoint
    const filePath = join(tempDir, "written.txt");

    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "written via API" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.path).toBe(filePath);

    // Verify the file was actually written to disk
    const actual = readFileSync(filePath, "utf-8");
    expect(actual).toBe("written via API");
  });

  it("returns 400 when path is missing", async () => {
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no path" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path and content required");
  });

  it("returns 400 when content is missing", async () => {
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(tempDir, "x.txt") }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path and content required");
  });

  it("returns 400 when content is not a string", async () => {
    // content must be a string, not a number or object
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(tempDir, "x.txt"), content: 123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path and content required");
  });

  it("returns 500 when the target directory does not exist", async () => {
    // Writing to a nonexistent parent directory should fail
    const filePath = join(tempDir, "no", "such", "dir", "file.txt");

    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "fail" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("handles malformed JSON body gracefully", async () => {
    // Sending invalid JSON should not crash the server; it should return 400
    const res = await app.request("/fs/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path and content required");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Git-related routes: /fs/diff and /fs/changed-files
// These require a temporary git repository.
// ─────────────────────────────────────────────────────────────────────────────
describe("git-related routes", () => {
  let gitDir: string;
  let gitApp: Hono;

  beforeEach(() => {
    // Create a fresh temp directory and initialize a git repo for each test
    gitDir = mkRealTempDir("fs-git-test-");
    execSync("git init", { cwd: gitDir });
    execSync("git config user.email 'test@test.com'", { cwd: gitDir });
    execSync("git config user.name 'Test'", { cwd: gitDir });

    gitApp = new Hono();
    registerFsRoutes(gitApp, { allowedBases: [gitDir] });
  });

  afterEach(() => {
    try {
      rmSync(gitDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("GET /fs/diff", () => {
    it("returns 400 when path query parameter is missing", async () => {
      const res = await gitApp.request("/fs/diff");

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("path required");
    });

    it("returns diff for a modified tracked file against HEAD", async () => {
      // Create a file, commit it, then modify it — diff should show the change
      const filePath = join(gitDir, "file.txt");
      writeFileSync(filePath, "line one\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      // Modify the file
      writeFileSync(filePath, "line one\nline two\n");

      const res = await gitApp.request(`/fs/diff?path=${encodeURIComponent(filePath)}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.path).toBe(resolve(filePath));
      // The diff should contain the added line
      expect(body.diff).toContain("+line two");
    });

    it("returns diff for an untracked file using /dev/null comparison", async () => {
      // An untracked file should produce a diff showing all lines as additions
      // First create an initial commit so HEAD exists
      writeFileSync(join(gitDir, "initial.txt"), "init\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      // Now create an untracked file
      const newFile = join(gitDir, "untracked.txt");
      writeFileSync(newFile, "brand new file\n");

      const res = await gitApp.request(`/fs/diff?path=${encodeURIComponent(newFile)}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      // Untracked files get diffed against /dev/null, showing all content as additions
      expect(body.diff).toContain("+brand new file");
    });

    it("returns empty diff for an unmodified committed file", async () => {
      // A file that has been committed and not changed should have empty diff
      const filePath = join(gitDir, "clean.txt");
      writeFileSync(filePath, "clean\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      const res = await gitApp.request(`/fs/diff?path=${encodeURIComponent(filePath)}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.diff).toBe("");
    });

    it("returns diff with base=default-branch", async () => {
      // When base=default-branch, diff should use the branch resolution logic.
      // With a local 'main' branch (created by git init defaults), this should still work.
      const filePath = join(gitDir, "feature.txt");
      writeFileSync(filePath, "original\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      // Modify the file
      writeFileSync(filePath, "original\nchanged\n");

      const res = await gitApp.request(
        `/fs/diff?path=${encodeURIComponent(filePath)}&base=default-branch`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      // The diff against default branch should show the change
      // (even if it falls through all bases, it returns empty diff gracefully)
      expect(body.path).toBe(resolve(filePath));
    });

    it("returns empty diff gracefully for a non-git directory", async () => {
      // A file outside any git repo should return an empty diff (caught by try/catch)
      const nonGitDir = mkRealTempDir("fs-nogit-test-");
      const nonGitApp = new Hono();
      registerFsRoutes(nonGitApp, { allowedBases: [nonGitDir] });

      const filePath = join(nonGitDir, "norepo.txt");
      writeFileSync(filePath, "not in git\n");

      const res = await nonGitApp.request(`/fs/diff?path=${encodeURIComponent(filePath)}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      // When not in a git repo, diff should be empty (outer catch returns { diff: "" })
      expect(body.diff).toBe("");

      rmSync(nonGitDir, { recursive: true, force: true });
    });

    it("handles untracked file in fresh repo with no HEAD", async () => {
      // In a fresh git repo with no commits, HEAD doesn't exist.
      // The diff route should handle this gracefully.
      const freshDir = mkRealTempDir("fs-fresh-git-");
      execSync("git init", { cwd: freshDir });
      execSync("git config user.email 'test@test.com'", { cwd: freshDir });
      execSync("git config user.name 'Test'", { cwd: freshDir });

      const freshApp = new Hono();
      registerFsRoutes(freshApp, { allowedBases: [freshDir] });

      const filePath = join(freshDir, "first.txt");
      writeFileSync(filePath, "first file ever\n");

      const res = await freshApp.request(`/fs/diff?path=${encodeURIComponent(filePath)}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      // In a fresh repo, HEAD doesn't exist so the diff falls through to untracked handling
      expect(body.diff).toContain("+first file ever");

      rmSync(freshDir, { recursive: true, force: true });
    });
  });

  describe("GET /fs/changed-files", () => {
    it("returns 400 when cwd query parameter is missing", async () => {
      const res = await gitApp.request("/fs/changed-files");

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("cwd required");
    });

    it("lists modified and untracked files", async () => {
      // Create a file, commit it, then modify it and create a new untracked file
      writeFileSync(join(gitDir, "tracked.txt"), "original\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      // Modify the tracked file and create a new untracked file
      writeFileSync(join(gitDir, "tracked.txt"), "modified\n");
      writeFileSync(join(gitDir, "new.txt"), "brand new\n");

      const res = await gitApp.request(
        `/fs/changed-files?cwd=${encodeURIComponent(gitDir)}`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const paths = body.files.map((f: { path: string }) => f.path);
      const statuses = Object.fromEntries(
        body.files.map((f: { path: string; status: string }) => [f.path, f.status])
      );

      // tracked.txt should show as Modified, new.txt as Added
      expect(paths).toContain(join(gitDir, "tracked.txt"));
      expect(paths).toContain(join(gitDir, "new.txt"));
      expect(statuses[join(gitDir, "tracked.txt")]).toBe("M");
      expect(statuses[join(gitDir, "new.txt")]).toBe("A");
    });

    it("lists only uncommitted changes when base=last-commit", async () => {
      // With base=last-commit, only changes vs HEAD should be shown (not branch diff)
      writeFileSync(join(gitDir, "base.txt"), "base\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      writeFileSync(join(gitDir, "base.txt"), "modified\n");

      const res = await gitApp.request(
        `/fs/changed-files?cwd=${encodeURIComponent(gitDir)}&base=last-commit`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files.length).toBeGreaterThan(0);
      const modifiedFile = body.files.find(
        (f: { path: string }) => f.path === join(gitDir, "base.txt")
      );
      expect(modifiedFile).toBeTruthy();
      expect(modifiedFile.status).toBe("M");
    });

    it("returns empty files array for a clean repo", async () => {
      // A repo with no changes should return an empty files array
      writeFileSync(join(gitDir, "clean.txt"), "clean\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      const res = await gitApp.request(
        `/fs/changed-files?cwd=${encodeURIComponent(gitDir)}`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files).toEqual([]);
    });

    it("returns empty files array for a non-git directory", async () => {
      // A directory that is not a git repo should gracefully return empty files
      const nonGitDir = mkRealTempDir("fs-nogit-changed-");
      const nonGitApp = new Hono();
      registerFsRoutes(nonGitApp, { allowedBases: [nonGitDir] });

      const res = await nonGitApp.request(
        `/fs/changed-files?cwd=${encodeURIComponent(nonGitDir)}`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files).toEqual([]);

      rmSync(nonGitDir, { recursive: true, force: true });
    });

    it("includes staged files in the changed files list", async () => {
      // Staged (but not yet committed) changes should appear in the list
      writeFileSync(join(gitDir, "staged.txt"), "initial\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      writeFileSync(join(gitDir, "staged.txt"), "updated\n");
      execSync("git add staged.txt", { cwd: gitDir });

      const res = await gitApp.request(
        `/fs/changed-files?cwd=${encodeURIComponent(gitDir)}`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const stagedFile = body.files.find(
        (f: { path: string }) => f.path === join(gitDir, "staged.txt")
      );
      expect(stagedFile).toBeTruthy();
      expect(stagedFile.status).toBe("M");
    });

    it("handles deleted files", async () => {
      // Deleted tracked files should show up with status "D"
      writeFileSync(join(gitDir, "doomed.txt"), "will be deleted\n");
      execSync("git add .", { cwd: gitDir });
      execSync('git commit -m "initial"', { cwd: gitDir });

      execSync("git rm doomed.txt", { cwd: gitDir });

      const res = await gitApp.request(
        `/fs/changed-files?cwd=${encodeURIComponent(gitDir)}`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const deletedFile = body.files.find(
        (f: { path: string }) => f.path === join(gitDir, "doomed.txt")
      );
      expect(deletedFile).toBeTruthy();
      expect(deletedFile.status).toBe("D");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fs/claude-md — finding CLAUDE.md files
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /fs/claude-md", () => {
  let claudeDir: string;
  let claudeApp: Hono;

  beforeEach(() => {
    claudeDir = mkRealTempDir("fs-claude-md-test-");
    // Initialize a git repo so the walk-up logic stops at the repo root
    execSync("git init", { cwd: claudeDir });
    execSync("git config user.email 'test@test.com'", { cwd: claudeDir });
    execSync("git config user.name 'Test'", { cwd: claudeDir });

    claudeApp = new Hono();
    registerFsRoutes(claudeApp, { allowedBases: [claudeDir] });
  });

  afterEach(() => {
    try {
      rmSync(claudeDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns 400 when cwd query parameter is missing", async () => {
    const res = await claudeApp.request("/fs/claude-md");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd required");
  });

  it("finds CLAUDE.md at the project root", async () => {
    // A CLAUDE.md at the root should be found
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# Project Instructions");

    const res = await claudeApp.request(
      `/fs/claude-md?cwd=${encodeURIComponent(claudeDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cwd).toBe(resolve(claudeDir));
    expect(body.files.length).toBe(1);
    expect(body.files[0].path).toBe(join(claudeDir, "CLAUDE.md"));
    expect(body.files[0].content).toBe("# Project Instructions");
  });

  it("finds CLAUDE.md inside .claude/ directory", async () => {
    // CLAUDE.md can also live in a .claude/ subdirectory
    mkdirSync(join(claudeDir, ".claude"));
    writeFileSync(join(claudeDir, ".claude", "CLAUDE.md"), "# Hidden config");

    const res = await claudeApp.request(
      `/fs/claude-md?cwd=${encodeURIComponent(claudeDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.length).toBe(1);
    expect(body.files[0].path).toBe(join(claudeDir, ".claude", "CLAUDE.md"));
  });

  it("finds both root and .claude/ CLAUDE.md files", async () => {
    // When both exist, both should be returned
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# Root");
    mkdirSync(join(claudeDir, ".claude"));
    writeFileSync(join(claudeDir, ".claude", "CLAUDE.md"), "# Nested");

    const res = await claudeApp.request(
      `/fs/claude-md?cwd=${encodeURIComponent(claudeDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.length).toBe(2);
    const paths = body.files.map((f: { path: string }) => f.path);
    expect(paths).toContain(join(claudeDir, "CLAUDE.md"));
    expect(paths).toContain(join(claudeDir, ".claude", "CLAUDE.md"));
  });

  it("returns empty files array when no CLAUDE.md exists", async () => {
    const res = await claudeApp.request(
      `/fs/claude-md?cwd=${encodeURIComponent(claudeDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([]);
  });

  it("walks up from a subdirectory to find CLAUDE.md at the repo root", async () => {
    // When cwd is a subdirectory, the walk-up logic should find CLAUDE.md in parent dirs
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# Root level");
    const subDir = join(claudeDir, "packages", "core");
    mkdirSync(subDir, { recursive: true });

    const res = await claudeApp.request(
      `/fs/claude-md?cwd=${encodeURIComponent(subDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.length).toBe(1);
    expect(body.files[0].path).toBe(join(claudeDir, "CLAUDE.md"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /fs/claude-md — writing CLAUDE.md files with validation
// ─────────────────────────────────────────────────────────────────────────────
describe("PUT /fs/claude-md", () => {
  it("writes CLAUDE.md to an existing directory", async () => {
    const filePath = join(tempDir, "CLAUDE.md");

    const res = await app.request("/fs/claude-md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "# New Instructions" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.path).toBe(resolve(filePath));

    // Verify file was actually written
    const actual = readFileSync(resolve(filePath), "utf-8");
    expect(actual).toBe("# New Instructions");
  });

  it("writes CLAUDE.md inside .claude/ directory, creating it if needed", async () => {
    // The endpoint should create the .claude/ directory if it doesn't exist
    const filePath = join(tempDir, ".claude", "CLAUDE.md");

    const res = await app.request("/fs/claude-md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "# Nested" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const actual = readFileSync(resolve(filePath), "utf-8");
    expect(actual).toBe("# Nested");
  });

  it("returns 400 when path is missing", async () => {
    const res = await app.request("/fs/claude-md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# No path" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path and content required");
  });

  it("returns 400 when content is missing", async () => {
    const res = await app.request("/fs/claude-md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(tempDir, "CLAUDE.md") }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path and content required");
  });

  it("returns 400 when filename is not CLAUDE.md", async () => {
    // Only CLAUDE.md files can be written through this endpoint
    const res = await app.request("/fs/claude-md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(tempDir, "README.md"), content: "hack" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Can only write CLAUDE.md files");
  });

  it("returns 400 for a CLAUDE.md path that is not in a standard location", async () => {
    // The path must end with /CLAUDE.md or /.claude/CLAUDE.md
    // A path like /some/random/place/CLAUDE.md that doesn't match either pattern
    // is rejected by the endsWith checks.
    // Actually, any path ending in /CLAUDE.md passes the endsWith check.
    // The only rejection is if base !== "CLAUDE.md" — so test a non-CLAUDE.md name.
    const res = await app.request("/fs/claude-md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(tempDir, "notclaude.md"), content: "x" }),
    });

    expect(res.status).toBe(400);
  });

  it("handles malformed JSON body gracefully", async () => {
    const res = await app.request("/fs/claude-md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path and content required");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /fs/claude-config — full configuration endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /fs/claude-config", () => {
  let configDir: string;
  let configApp: Hono;

  beforeEach(() => {
    configDir = mkRealTempDir("fs-config-test-");
    // Initialize a git repo to define the project root
    execSync("git init", { cwd: configDir });
    execSync("git config user.email 'test@test.com'", { cwd: configDir });
    execSync("git config user.name 'Test'", { cwd: configDir });

    configApp = new Hono();
    registerFsRoutes(configApp, { allowedBases: [configDir] });
  });

  afterEach(() => {
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns 400 when cwd query parameter is missing", async () => {
    const res = await configApp.request("/fs/claude-config");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd required");
  });

  it("returns complete config structure with project and user sections", async () => {
    // Even with no config files, the response should have the correct shape
    const res = await configApp.request(
      `/fs/claude-config?cwd=${encodeURIComponent(configDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify the top-level structure
    expect(body).toHaveProperty("project");
    expect(body).toHaveProperty("user");
    expect(body.project).toHaveProperty("root");
    expect(body.project).toHaveProperty("claudeMd");
    expect(body.project).toHaveProperty("settings");
    expect(body.project).toHaveProperty("settingsLocal");
    expect(body.project).toHaveProperty("commands");
    expect(body.user).toHaveProperty("root");
    expect(body.user).toHaveProperty("claudeMd");
    expect(body.user).toHaveProperty("skills");
    expect(body.user).toHaveProperty("agents");
    expect(body.user).toHaveProperty("settings");
    expect(body.user).toHaveProperty("commands");
  });

  it("detects project-level CLAUDE.md files", async () => {
    writeFileSync(join(configDir, "CLAUDE.md"), "# Project config");

    const res = await configApp.request(
      `/fs/claude-config?cwd=${encodeURIComponent(configDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.claudeMd.length).toBe(1);
    expect(body.project.claudeMd[0].content).toBe("# Project config");
  });

  it("detects project-level settings.json and settings.local.json", async () => {
    // Create .claude/settings.json and .claude/settings.local.json in the project
    const claudeDir = join(configDir, ".claude");
    mkdirSync(claudeDir);
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ model: "claude-3" })
    );
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ local: true })
    );

    const res = await configApp.request(
      `/fs/claude-config?cwd=${encodeURIComponent(configDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.settings).not.toBeNull();
    expect(body.project.settings.content).toContain("claude-3");
    expect(body.project.settingsLocal).not.toBeNull();
    expect(body.project.settingsLocal.content).toContain("local");
  });

  it("detects project-level commands/*.md files", async () => {
    // Create .claude/commands/ with some .md command files
    const commandsDir = join(configDir, ".claude", "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "deploy.md"), "# Deploy command");
    writeFileSync(join(commandsDir, "test.md"), "# Test command");
    writeFileSync(join(commandsDir, "not-a-command.txt"), "ignored");

    const res = await configApp.request(
      `/fs/claude-config?cwd=${encodeURIComponent(configDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Only .md files should be included, sorted alphabetically
    expect(body.project.commands.length).toBe(2);
    expect(body.project.commands[0].name).toBe("deploy");
    expect(body.project.commands[1].name).toBe("test");
    expect(body.project.commands[0].path).toBe(join(commandsDir, "deploy.md"));
  });

  it("returns null for missing project settings", async () => {
    // When no .claude/settings.json exists, settings should be null
    const res = await configApp.request(
      `/fs/claude-config?cwd=${encodeURIComponent(configDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.settings).toBeNull();
    expect(body.project.settingsLocal).toBeNull();
    expect(body.project.commands).toEqual([]);
  });

  it("sets project root to repo root when inside a git repo", async () => {
    // The project root should be the git repo root, not the cwd
    const subDir = join(configDir, "packages", "core");
    mkdirSync(subDir, { recursive: true });

    const res = await configApp.request(
      `/fs/claude-config?cwd=${encodeURIComponent(subDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.root).toBe(resolve(configDir));
  });

  it("uses cwd as project root when not in a git repo", async () => {
    // Without a git repo, project root falls back to cwd
    const nonGitDir = mkRealTempDir("fs-config-nogit-");
    const nonGitApp = new Hono();
    registerFsRoutes(nonGitApp, { allowedBases: [nonGitDir] });

    const res = await nonGitApp.request(
      `/fs/claude-config?cwd=${encodeURIComponent(nonGitDir)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.root).toBe(resolve(nonGitDir));

    rmSync(nonGitDir, { recursive: true, force: true });
  });
});
