// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockApi = {
  getFileDiff: vi.fn().mockResolvedValue({ path: "/repo/file.ts", diff: "" }),
  getChangedFiles: vi.fn().mockResolvedValue({ files: [] }),
};

vi.mock("../api.js", () => ({
  api: {
    getFileDiff: (...args: unknown[]) => mockApi.getFileDiff(...args),
    getChangedFiles: (...args: unknown[]) => mockApi.getChangedFiles(...args),
  },
}));

// ─── Store mock ─────────────────────────────────────────────────────────────

interface MockStoreState {
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
  diffPanelSelectedFile: Map<string, string>;
  changedFilesTick: Map<string, number>;
  setDiffPanelSelectedFile: ReturnType<typeof vi.fn>;
  setGitChangedFilesCount: ReturnType<typeof vi.fn>;
  diffBase: "last-commit" | "default-branch";
  setDiffBase: ReturnType<typeof vi.fn>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    diffPanelSelectedFile: new Map(),
    changedFilesTick: new Map(),
    setDiffPanelSelectedFile: vi.fn(),
    setGitChangedFilesCount: vi.fn(),
    diffBase: "last-commit",
    setDiffBase: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { DiffPanel } from "./DiffPanel.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  // Default: no changed files from git
  mockApi.getChangedFiles.mockResolvedValue({ files: [] });
});

describe("DiffPanel", () => {
  it("shows empty state when no files changed", async () => {
    render(<DiffPanel sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("No changes yet")).toBeInTheDocument();
    });
  });

  it("displays changed files in sidebar", async () => {
    // Validates that git-reported changed files are shown with correct count and labels.
    mockApi.getChangedFiles.mockResolvedValue({
      files: [
        { path: "/repo/src/app.ts", status: "M" },
        { path: "/repo/src/utils.ts", status: "A" },
      ],
    });

    render(<DiffPanel sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Changed (2)")).toBeInTheDocument();
    });
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("src/utils.ts")).toBeInTheDocument();
  });

  it("hides changed files outside the session cwd", async () => {
    // Validates that only files within the session cwd are shown.
    mockApi.getChangedFiles.mockResolvedValue({
      files: [
        { path: "/repo/src/app.ts", status: "M" },
        { path: "/Users/stan/.claude/plans/plan.md", status: "M" },
      ],
    });

    render(<DiffPanel sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Changed (1)")).toBeInTheDocument();
    });
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.queryByText("/Users/stan/.claude/plans/plan.md")).not.toBeInTheDocument();
  });

  it("fetches diff when a file is selected", async () => {
    // Validates that file diffs are fetched and rendered, including the baseline context label in the header.
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;

    mockApi.getFileDiff.mockResolvedValueOnce({ path: "/repo/src/app.ts", diff: diffOutput });
    mockApi.getChangedFiles.mockResolvedValue({
      files: [{ path: "/repo/src/app.ts", status: "M" }],
    });

    resetStore({
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts", "last-commit");
    });

    // DiffViewer should render the diff content (may appear in top bar + DiffViewer header)
    await waitFor(() => {
      expect(container.querySelector(".diff-line-add")).toBeTruthy();
    });
    expect(screen.getByText("vs last commit")).toBeInTheDocument();
  });

  it("shows 'No changes' when diff is empty for selected file", async () => {
    mockApi.getFileDiff.mockResolvedValueOnce({ path: "/repo/file.ts", diff: "" });
    mockApi.getChangedFiles.mockResolvedValue({
      files: [{ path: "/repo/file.ts", status: "M" }],
    });

    resetStore({
      diffPanelSelectedFile: new Map([["s1", "/repo/file.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("No changes")).toBeInTheDocument();
    });
  });

  it("shows waiting message when session has no cwd", () => {
    resetStore({
      sessions: new Map([["s1", {}]]),
    });

    render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Waiting for session to initialize...")).toBeInTheDocument();
  });

  it("passes default-branch to API and shows correct label", async () => {
    // Validates that when diffBase is "default-branch", the API receives it and the label updates.
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;

    mockApi.getFileDiff.mockResolvedValueOnce({ path: "/repo/src/app.ts", diff: diffOutput });
    mockApi.getChangedFiles.mockResolvedValue({
      files: [{ path: "/repo/src/app.ts", status: "M" }],
    });

    resetStore({
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
      diffBase: "default-branch",
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts", "default-branch");
    });
    expect(screen.getByText("vs default branch")).toBeInTheDocument();
  });

  it("toggles diff base when label button is clicked", async () => {
    // Validates that clicking the diff base toggle calls setDiffBase with the opposite value.
    mockApi.getFileDiff.mockResolvedValueOnce({ path: "/repo/src/app.ts", diff: "some diff" });
    mockApi.getChangedFiles.mockResolvedValue({
      files: [{ path: "/repo/src/app.ts", status: "M" }],
    });

    resetStore({
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
      diffBase: "last-commit",
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("vs last commit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("vs last commit"));
    expect(storeState.setDiffBase).toHaveBeenCalledWith("default-branch");
  });

  it("reselects when selected file is outside cwd scope", async () => {
    // Validates that if the selected file is outside the cwd, it reselects to the first in-scope file.
    mockApi.getChangedFiles.mockResolvedValue({
      files: [{ path: "/repo/src/inside.ts", status: "M" }],
    });

    resetStore({
      diffPanelSelectedFile: new Map([["s1", "/Users/stan/.claude/plans/plan.md"]]),
    });

    render(<DiffPanel sessionId="s1" />);
    await waitFor(() => {
      expect(storeState.setDiffPanelSelectedFile).toHaveBeenCalledWith("s1", "/repo/src/inside.ts");
    });
  });
});
