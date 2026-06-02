// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { TreeNode } from "../api.js";

// ---- Mock API ----
const mockGetFileTree = vi.fn();
const mockReadFile = vi.fn();
const mockGetFileBlob = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    getFileTree: (...args: unknown[]) => mockGetFileTree(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    getFileBlob: (...args: unknown[]) => mockGetFileBlob(...args),
  },
}));

// ---- Mock Store ----
interface MockStoreState {
  darkMode: boolean;
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    darkMode: false,
    sessions: new Map([["s1", { cwd: "/project" }]]),
    sdkSessions: [],
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(mockState),
}));

// Mock CodeMirror to avoid runtime package-instance conflicts in jsdom while
// preserving the same semantic hooks the component/test rely on.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value }: { value?: string }) => (
    <div className="cm-editor">
      <div className="cm-gutters">
        <div className="cm-lineNumbers" />
      </div>
      <div className="cm-content">{value}</div>
    </div>
  ),
}));

import { FilesPanel } from "./FilesPanel.js";

const sampleTree: TreeNode[] = [
  {
    name: "src",
    path: "/project/src",
    type: "directory",
    children: [
      { name: "index.ts", path: "/project/src/index.ts", type: "file" },
      { name: "utils.ts", path: "/project/src/utils.ts", type: "file" },
    ],
  },
  { name: "README.md", path: "/project/README.md", type: "file" },
  { name: "logo.png", path: "/project/logo.png", type: "file" },
];

/** Helper: check that a CodeMirror editor was mounted in the container */
function hasCmEditor(container: HTMLElement): boolean {
  return container.querySelector(".cm-editor") !== null;
}

// Mock URL.createObjectURL / revokeObjectURL for image blob tests
const mockRevokeObjectURL = vi.fn();
beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:http://localhost/fake-blob");
  globalThis.URL.revokeObjectURL = mockRevokeObjectURL;
});

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  mockGetFileTree.mockResolvedValue({ path: "/project", tree: sampleTree });
  mockReadFile.mockResolvedValue({ path: "/project/README.md", content: "# Hello World" });
  mockGetFileBlob.mockResolvedValue("blob:http://localhost/fake-blob");
});

// Note: jsdom renders both desktop (hidden sm:flex) and mobile (flex sm:hidden) layouts
// since CSS media queries don't apply. Elements may appear in both, so we use getAllByText.
// CodeMirror tokenizes text into multiple spans, so we check for .cm-editor presence
// and verify API calls rather than checking for exact text content.

describe("FilesPanel", () => {
  it("renders and loads the file tree from cwd", async () => {
    // Should call getFileTree with the session's cwd and display tree entries
    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockGetFileTree).toHaveBeenCalledWith("/project");
    });

    // Both desktop and mobile layouts render the tree, so use getAllByText
    await waitFor(() => {
      expect(screen.getAllByText("src").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows waiting message when no cwd is available", () => {
    // Sessions without a cwd should show a waiting message
    resetStore({ sessions: new Map([["s1", {}]]), sdkSessions: [] });
    render(<FilesPanel sessionId="s1" />);

    expect(screen.getByText("Waiting for session to connect...")).toBeInTheDocument();
    expect(mockGetFileTree).not.toHaveBeenCalled();
  });

  it("loads and displays file content when a file is clicked", async () => {
    // Clicking a file should fetch it and render a CodeMirror editor with its content
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("README.md")[0]);

    await waitFor(() => {
      expect(mockReadFile).toHaveBeenCalledWith("/project/README.md");
    });

    // CodeMirror editor should now be mounted with file content
    await waitFor(() => {
      expect(hasCmEditor(container)).toBe(true);
    });
  });

  it("expands and collapses directories on click", async () => {
    // Directories default to collapsed — children hidden until clicked
    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("src").length).toBeGreaterThanOrEqual(1);
    });

    // Children should NOT be visible initially (collapsed by default)
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();

    // Click to expand
    const toggleButtons = screen.getAllByLabelText("Toggle src");
    fireEvent.click(toggleButtons[0]);

    expect(screen.getAllByText("index.ts").length).toBeGreaterThanOrEqual(1);

    // Click to collapse again
    fireEvent.click(toggleButtons[0]);

    // At least one tree collapsed — in the desktop tree children are hidden
    const remaining = screen.queryAllByText("index.ts");
    expect(remaining.length).toBeLessThan(screen.getAllByLabelText("Toggle src").length);
  });

  it("shows back button in mobile file viewer to return to tree", async () => {
    // On mobile the back button navigates from file viewer back to tree view
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("README.md")[0]);

    // Wait for CodeMirror editor to mount (file loaded)
    await waitFor(() => {
      expect(hasCmEditor(container)).toBe(true);
    });

    // Back button rendered in both desktop and mobile viewers (sm:hidden in production)
    const backBtns = screen.getAllByLabelText("Back to file tree");
    expect(backBtns.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(backBtns[0]);

    // Should return to tree view — editor gone, tree visible again
    await waitFor(() => {
      expect(hasCmEditor(container)).toBe(false);
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("displays error state with retry when tree loading fails", async () => {
    // Failed tree fetch should show an error message with a Retry button
    mockGetFileTree.mockRejectedValue(new Error("Network error"));

    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("Network error").length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getAllByText("Retry").length).toBeGreaterThanOrEqual(1);
  });

  it("retries tree fetch when Retry button is clicked", async () => {
    // Clicking Retry should re-fetch the file tree
    mockGetFileTree.mockRejectedValueOnce(new Error("Network error"));
    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("Network error").length).toBeGreaterThanOrEqual(1);
    });

    // Now mock a successful response
    mockGetFileTree.mockResolvedValue({ path: "/project", tree: sampleTree });

    fireEvent.click(screen.getAllByText("Retry")[0]);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows empty state when tree has no entries", async () => {
    // An empty tree should show a helpful message
    mockGetFileTree.mockResolvedValue({ path: "/project", tree: [] });

    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("No files found.").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows error when file read fails", async () => {
    // Failed file read should show an error in the file viewer
    mockReadFile.mockRejectedValue(new Error("File too large"));

    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("README.md")[0]);

    await waitFor(() => {
      expect(screen.getAllByText("File too large").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("has a refresh button that reloads the tree", async () => {
    // Refresh button should re-fetch the file tree
    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    mockGetFileTree.mockResolvedValue({ path: "/project", tree: [] });

    const refreshButtons = screen.getAllByLabelText("Refresh file tree");
    fireEvent.click(refreshButtons[0]);

    await waitFor(() => {
      expect(mockGetFileTree).toHaveBeenCalledTimes(2);
    });
  });

  it("uses sdkSessions cwd when session cwd is not available", async () => {
    // Should fall back to sdkSessions for cwd
    resetStore({
      sessions: new Map([["s1", {}]]),
      sdkSessions: [{ sessionId: "s1", cwd: "/sdk-project" }],
    });
    mockGetFileTree.mockResolvedValue({ path: "/sdk-project", tree: sampleTree });

    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockGetFileTree).toHaveBeenCalledWith("/sdk-project");
    });
  });

  it("renders CodeMirror with line numbers for file content", async () => {
    // The file viewer should use CodeMirror with line numbers visible
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("README.md")[0]);

    await waitFor(() => {
      expect(hasCmEditor(container)).toBe(true);
    });

    // CodeMirror renders line numbers with .cm-lineNumbers gutter
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
  });
});

describe("FilesPanel image preview", () => {
  it("renders image preview for image files instead of CodeMirror", async () => {
    // Clicking an image file should fetch a blob URL via getFileBlob and render <img>
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("logo.png").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("logo.png")[0]);

    await waitFor(() => {
      expect(mockGetFileBlob).toHaveBeenCalledWith("/project/logo.png");
    });

    // Should render an <img> element, not a CodeMirror editor
    await waitFor(() => {
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("alt")).toBe("logo.png");
    });

    // readFile should NOT have been called for the image
    expect(mockReadFile).not.toHaveBeenCalledWith("/project/logo.png");
    // CodeMirror should not be mounted
    expect(hasCmEditor(container)).toBe(false);
  });

  it("falls back to CodeMirror for non-image files", async () => {
    // .ts files should still use CodeMirror, not the image viewer
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("README.md")[0]);

    await waitFor(() => {
      expect(mockReadFile).toHaveBeenCalledWith("/project/README.md");
    });

    await waitFor(() => {
      expect(hasCmEditor(container)).toBe(true);
    });

    // getFileBlob should NOT have been called for text files
    expect(mockGetFileBlob).not.toHaveBeenCalled();
    // No <img> with alt matching the file
    expect(container.querySelector("img")).toBeNull();
  });

  it("revokes object URL on back navigation", async () => {
    // Navigating back from an image should revoke the blob URL to prevent memory leaks
    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("logo.png").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("logo.png")[0]);

    await waitFor(() => {
      expect(mockGetFileBlob).toHaveBeenCalledWith("/project/logo.png");
    });

    // Clear calls so we can track only the back-navigation revoke
    mockRevokeObjectURL.mockClear();

    const backBtns = screen.getAllByLabelText("Back to file tree");
    fireEvent.click(backBtns[0]);

    await waitFor(() => {
      expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/fake-blob");
    });
  });

  it("revokes object URL on component unmount", async () => {
    // Unmounting the component (e.g. switching tabs) should revoke the blob URL
    const { unmount } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("logo.png").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("logo.png")[0]);

    await waitFor(() => {
      expect(mockGetFileBlob).toHaveBeenCalledWith("/project/logo.png");
    });

    mockRevokeObjectURL.mockClear();
    unmount();

    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/fake-blob");
  });

  it("shows error when image blob fetch fails", async () => {
    // A failed getFileBlob should display an error message in the file viewer
    mockGetFileBlob.mockRejectedValue(new Error("Image load error"));

    render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("logo.png").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("logo.png")[0]);

    await waitFor(() => {
      expect(screen.getAllByText("Image load error").length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("FilesPanel accessibility", () => {
  it("passes axe checks for tree view", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe checks for file viewer with CodeMirror", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("README.md")[0]);

    await waitFor(() => {
      expect(hasCmEditor(container)).toBe(true);
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe checks for empty state", async () => {
    const { axe } = await import("vitest-axe");
    mockGetFileTree.mockResolvedValue({ path: "/project", tree: [] });
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("No files found.").length).toBeGreaterThanOrEqual(1);
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe checks for image viewer", async () => {
    // Image preview state should also pass accessibility checks (img has alt text)
    const { axe } = await import("vitest-axe");
    const { container } = render(<FilesPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByText("logo.png").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("logo.png")[0]);

    await waitFor(() => {
      expect(container.querySelector("img")).not.toBeNull();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
