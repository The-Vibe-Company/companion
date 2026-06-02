// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const getFileTreeMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const getFileBlobMock = vi.hoisted(() => vi.fn());
const getChangedFilesMock = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  api: {
    getFileTree: getFileTreeMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
    getFileBlob: getFileBlobMock,
    getChangedFiles: getChangedFilesMock,
  },
}));

vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      aria-label="Code editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

interface MockStoreState {
  darkMode: boolean;
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
  changedFilesTick: Map<string, number>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    darkMode: false,
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    changedFilesTick: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { SessionEditorPane } from "./SessionEditorPane.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  // Default: no git-modified files (most tests don't care about git status)
  getChangedFilesMock.mockResolvedValue({ files: [] });
});

// Helper: both desktop and mobile layouts render in jsdom (CSS hidden doesn't apply),
// so file buttons appear twice. Click the first one.
async function clickFile(name: string) {
  const btns = await screen.findAllByText(name);
  fireEvent.click(btns[0]);
}

// Helper: expand a collapsed folder by clicking its toggle button.
// Folders start collapsed by default.
async function expandFolder(name: string) {
  const toggleBtns = await screen.findAllByLabelText(`Toggle ${name}`);
  fireEvent.click(toggleBtns[0]);
}

describe("SessionEditorPane", () => {
  it("loads tree and reads file when selected", async () => {
    // Tree loads on mount, file content loads when a file is clicked.
    // Folders start collapsed, so we expand "src" first to reveal "a.ts".
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "src", path: "/repo/src", type: "directory", children: [{ name: "a.ts", path: "/repo/src/a.ts", type: "file" }] },
      ],
    });
    readFileMock.mockResolvedValue({ path: "/repo/src/a.ts", content: "const a = 1;\n" });

    render(<SessionEditorPane sessionId="s1" />);

    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalledWith("/repo"));

    // Expand the src folder (collapsed by default), then click the file
    await expandFolder("src");
    await clickFile("a.ts");

    await waitFor(() => expect(readFileMock).toHaveBeenCalledWith("/repo/src/a.ts"));
    // File path label appears in the editor header
    const pathLabels = await screen.findAllByText("src/a.ts");
    expect(pathLabels.length).toBeGreaterThanOrEqual(1);
  });

  it("saves when content changes", async () => {
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "index.ts", path: "/repo/index.ts", type: "file" }],
    });
    readFileMock.mockResolvedValue({ path: "/repo/index.ts", content: "hello\n" });
    writeFileMock.mockResolvedValue({ ok: true, path: "/repo/index.ts" });

    render(<SessionEditorPane sessionId="s1" />);

    // Click file to select it first
    await clickFile("index.ts");

    await waitFor(() => expect(readFileMock).toHaveBeenCalled());
    // CodeMirror mock renders as textarea; both layouts render it so get the first
    const editors = screen.getAllByLabelText("Code editor");
    fireEvent.change(editors[0], { target: { value: "hello!\n" } });
    // Save buttons also appear in both layouts — click the first
    const saveBtns = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveBtns[0]);

    await waitFor(() => {
      expect(writeFileMock).toHaveBeenCalled();
      expect(writeFileMock.mock.calls[0][0]).toBe("/repo/index.ts");
    });
  });

  it("shows reconnecting message when cwd is unavailable", () => {
    resetStore({ sessions: new Map([["s1", {}]]) });
    render(<SessionEditorPane sessionId="s1" />);
    expect(screen.getByText("Editor unavailable while session is reconnecting.")).toBeInTheDocument();
  });

  it("renders image preview for image files instead of CodeMirror", async () => {
    // When an image file is selected, getFileBlob is called (not readFile)
    // and an <img> element is rendered instead of CodeMirror
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "logo.png", path: "/repo/logo.png", type: "file" }],
    });
    const fakeUrl = "blob:http://localhost/fake-image";
    getFileBlobMock.mockResolvedValue(fakeUrl);

    render(<SessionEditorPane sessionId="s1" />);

    await clickFile("logo.png");

    await waitFor(() => expect(getFileBlobMock).toHaveBeenCalledWith("/repo/logo.png"));
    // readFile should NOT be called for images
    expect(readFileMock).not.toHaveBeenCalled();

    // Image element should render with the blob URL
    const imgs = await screen.findAllByRole("img");
    expect(imgs[0]).toHaveAttribute("src", fakeUrl);
    expect(imgs[0]).toHaveAttribute("alt", "logo.png");
  });

  it("hides save button for image files", async () => {
    // Save button should not appear when viewing image files (they're read-only)
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "photo.jpg", path: "/repo/photo.jpg", type: "file" }],
    });
    getFileBlobMock.mockResolvedValue("blob:http://localhost/photo");

    render(<SessionEditorPane sessionId="s1" />);

    await clickFile("photo.jpg");

    await waitFor(() => expect(getFileBlobMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("has a refresh button that reloads the file tree", async () => {
    // Manual refresh button re-fetches the tree from the server
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "a.ts", path: "/repo/a.ts", type: "file" }],
    });
    render(<SessionEditorPane sessionId="s1" />);

    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalledTimes(1));

    // Now the tree has been loaded; simulate a new file appearing on disk
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "a.ts", path: "/repo/a.ts", type: "file" },
        { name: "b.ts", path: "/repo/b.ts", type: "file" },
      ],
    });

    // Wait for at least one refresh button to become enabled before clicking.
    // This avoids a race where the test clicks while initial tree load is still in progress.
    const enabledRefreshBtn = await waitFor(() => {
      const refreshBtns = screen.getAllByLabelText("Refresh file tree");
      const enabled = refreshBtns.find((btn) => !btn.hasAttribute("disabled"));
      expect(enabled).toBeDefined();
      return enabled!;
    });
    fireEvent.click(enabledRefreshBtn);

    // Assert user-visible outcome instead of internal call counts.
    const fileButtons = await screen.findAllByText("b.ts");
    expect(fileButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-refreshes tree when changedFilesTick increments", async () => {
    // When Claude edits files, changedFilesTick bumps and the tree should reload
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "a.ts", path: "/repo/a.ts", type: "file" }],
    });
    const { rerender } = render(<SessionEditorPane sessionId="s1" />);

    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalledTimes(1));

    // Simulate changedFilesTick bump (Claude edited a file)
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "a.ts", path: "/repo/a.ts", type: "file" },
        { name: "new-file.ts", path: "/repo/new-file.ts", type: "file" },
      ],
    });
    storeState = { ...storeState, changedFilesTick: new Map([["s1", 1]]) };
    rerender(<SessionEditorPane sessionId="s1" />);

    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalledTimes(2));
  });

  it("auto-refreshes open file content when changedFilesTick increments", async () => {
    // When an open file is modified by Claude, its content should update
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "a.ts", path: "/repo/a.ts", type: "file" }],
    });
    readFileMock.mockResolvedValue({ path: "/repo/a.ts", content: "original\n" });

    const { rerender } = render(<SessionEditorPane sessionId="s1" />);
    await clickFile("a.ts");
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(1));

    // Claude modifies the file
    readFileMock.mockResolvedValue({ path: "/repo/a.ts", content: "updated by claude\n" });
    storeState = { ...storeState, changedFilesTick: new Map([["s1", 1]]) };
    rerender(<SessionEditorPane sessionId="s1" />);

    // File content should be re-fetched
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2));
  });

  it("has mobile back button for navigation", async () => {
    // Mobile layout shows a back button to return to file tree
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "main.ts", path: "/repo/main.ts", type: "file" }],
    });
    readFileMock.mockResolvedValue({ path: "/repo/main.ts", content: "code\n" });

    render(<SessionEditorPane sessionId="s1" />);

    await clickFile("main.ts");

    await waitFor(() => expect(readFileMock).toHaveBeenCalled());
    // Back button should exist (visible on mobile via sm:hidden)
    const backBtns = screen.getAllByLabelText("Back to file tree");
    expect(backBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("renders folders collapsed by default", async () => {
    // All folders should start collapsed — children are not visible until expanded
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        {
          name: "src", path: "/repo/src", type: "directory",
          children: [{ name: "hidden.ts", path: "/repo/src/hidden.ts", type: "file" }],
        },
      ],
    });
    render(<SessionEditorPane sessionId="s1" />);

    // Folder name should be visible
    const folders = await screen.findAllByText("src");
    expect(folders.length).toBeGreaterThanOrEqual(1);
    // But the child file should NOT be visible (collapsed)
    expect(screen.queryByText("hidden.ts")).not.toBeInTheDocument();

    // After expanding the folder, the child should appear
    await expandFolder("src");
    const files = await screen.findAllByText("hidden.ts");
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("has a search button that opens fuzzy file search", async () => {
    // The search icon button should toggle the search input
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "app.tsx", path: "/repo/app.tsx", type: "file" },
        {
          name: "src", path: "/repo/src", type: "directory",
          children: [
            { name: "store.ts", path: "/repo/src/store.ts", type: "file" },
            { name: "api.ts", path: "/repo/src/api.ts", type: "file" },
          ],
        },
      ],
    });
    render(<SessionEditorPane sessionId="s1" />);

    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalled());

    // Search button should exist
    const searchBtns = screen.getAllByLabelText("Search files");
    expect(searchBtns.length).toBeGreaterThanOrEqual(1);

    // Click search button to open search
    fireEvent.click(searchBtns[0]);

    // Search input should now be visible
    const inputs = screen.getAllByPlaceholderText("Search files...");
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  it("fuzzy search filters and selects files from nested directories", async () => {
    // Search should flatten the tree and allow selecting deeply nested files
    // without needing to expand folders manually
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "index.ts", path: "/repo/index.ts", type: "file" },
        {
          name: "src", path: "/repo/src", type: "directory",
          children: [
            { name: "store.ts", path: "/repo/src/store.ts", type: "file" },
            { name: "api.ts", path: "/repo/src/api.ts", type: "file" },
          ],
        },
      ],
    });
    readFileMock.mockResolvedValue({ path: "/repo/src/store.ts", content: "export const store = {};\n" });

    render(<SessionEditorPane sessionId="s1" />);
    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalled());

    // Open search
    const searchBtns = screen.getAllByLabelText("Search files");
    fireEvent.click(searchBtns[0]);

    // Type a query that matches "store.ts"
    const inputs = screen.getAllByPlaceholderText("Search files...");
    fireEvent.change(inputs[0], { target: { value: "store" } });

    // "src/store.ts" should appear in results
    const results = await screen.findAllByTitle("src/store.ts");
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Click the result to select the file
    fireEvent.click(results[0]);

    // File should be loaded and search should close
    await waitFor(() => expect(readFileMock).toHaveBeenCalledWith("/repo/src/store.ts"));
    // Search input should no longer be visible
    expect(screen.queryByPlaceholderText("Search files...")).not.toBeInTheDocument();
  });

  it("closes search on Escape key", async () => {
    // Pressing Escape in the search input should close search mode
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [{ name: "a.ts", path: "/repo/a.ts", type: "file" }],
    });
    render(<SessionEditorPane sessionId="s1" />);
    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalled());

    // Open search
    const searchBtns = screen.getAllByLabelText("Search files");
    fireEvent.click(searchBtns[0]);

    const inputs = screen.getAllByPlaceholderText("Search files...");
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // Press Escape to close
    fireEvent.keyDown(inputs[0], { key: "Escape" });

    // Search should be closed
    expect(screen.queryByPlaceholderText("Search files...")).not.toBeInTheDocument();
  });

  it("navigates search results with arrow keys and Enter", async () => {
    // Arrow keys should move selection, Enter should select the highlighted result
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "alpha.ts", path: "/repo/alpha.ts", type: "file" },
        { name: "beta.ts", path: "/repo/beta.ts", type: "file" },
      ],
    });
    readFileMock.mockResolvedValue({ path: "/repo/beta.ts", content: "beta\n" });

    render(<SessionEditorPane sessionId="s1" />);
    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalled());

    // Open search
    const searchBtns = screen.getAllByLabelText("Search files");
    fireEvent.click(searchBtns[0]);

    const inputs = screen.getAllByPlaceholderText("Search files...");
    // Arrow down to move to second result, then Enter to select
    fireEvent.keyDown(inputs[0], { key: "ArrowDown" });
    fireEvent.keyDown(inputs[0], { key: "Enter" });

    // The second file should be selected (beta.ts)
    await waitFor(() => expect(readFileMock).toHaveBeenCalledWith("/repo/beta.ts"));
  });

  it("supports glob patterns like *.ts in search", async () => {
    // Glob patterns (containing * or ?) should filter by extension/pattern
    // rather than doing fuzzy matching. "*.ts" should match all .ts files
    // regardless of directory depth.
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "index.js", path: "/repo/index.js", type: "file" },
        { name: "app.ts", path: "/repo/app.ts", type: "file" },
        {
          name: "src", path: "/repo/src", type: "directory",
          children: [
            { name: "store.ts", path: "/repo/src/store.ts", type: "file" },
            { name: "styles.css", path: "/repo/src/styles.css", type: "file" },
          ],
        },
      ],
    });
    render(<SessionEditorPane sessionId="s1" />);
    await waitFor(() => expect(getFileTreeMock).toHaveBeenCalled());

    // Open search and type a glob pattern
    const searchBtns = screen.getAllByLabelText("Search files");
    fireEvent.click(searchBtns[0]);

    const inputs = screen.getAllByPlaceholderText("Search files...");
    fireEvent.change(inputs[0], { target: { value: "*.ts" } });

    // Should show both .ts files but not .js or .css
    await waitFor(() => {
      expect(screen.getAllByTitle("app.ts").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTitle("src/store.ts").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByTitle("index.js")).not.toBeInTheDocument();
    expect(screen.queryByTitle("src/styles.css")).not.toBeInTheDocument();
  });

  it("highlights git-modified files with color indicators", async () => {
    // Files with uncommitted changes should get colored text in the tree:
    // modified → amber, added/untracked → green
    getFileTreeMock.mockResolvedValue({
      path: "/repo",
      tree: [
        { name: "clean.ts", path: "/repo/clean.ts", type: "file" },
        { name: "modified.ts", path: "/repo/modified.ts", type: "file" },
        { name: "new-file.ts", path: "/repo/new-file.ts", type: "file" },
      ],
    });
    getChangedFilesMock.mockResolvedValue({
      files: [
        { path: "/repo/modified.ts", status: "M" },
        { path: "/repo/new-file.ts", status: "A" },
      ],
    });
    render(<SessionEditorPane sessionId="s1" />);

    // Wait for tree + git status to load
    await waitFor(() => expect(getChangedFilesMock).toHaveBeenCalled());

    // Modified file should have the warning color class (theme token)
    const modifiedBtns = await screen.findAllByText("modified.ts");
    expect(modifiedBtns[0].className).toContain("text-cc-warning");

    // New/added file should have the success color class (theme token)
    const addedBtns = await screen.findAllByText("new-file.ts");
    expect(addedBtns[0].className).toContain("text-cc-success");

    // Clean file should NOT have git color classes
    const cleanBtns = await screen.findAllByText("clean.ts");
    expect(cleanBtns[0].className).not.toContain("text-cc-warning");
    expect(cleanBtns[0].className).not.toContain("text-cc-success");
  });
});
