// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock react-markdown to avoid ESM/jsdom issues (same pattern as MessageBubble.test.tsx)
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown-preview">{children}</div>
  ),
}));
vi.mock("remark-gfm", () => ({
  default: () => {},
}));

// Mock react-arborist — provides a minimal tree component that renders nodes
// and delegates click events to the appropriate handlers
vi.mock("react-arborist", () => ({
  Tree: ({
    data,
    onActivate,
    onToggle,
  }: {
    data: Array<{ id: string; name: string; type: string; children?: unknown[] }>;
    children: unknown;
    onActivate?: (node: { data: unknown }) => void;
    onToggle?: (id: string) => void;
    [key: string]: unknown;
  }) => (
    <div data-testid="file-tree" role="tree">
      {data.map((node) => (
        <div
          key={node.id}
          data-testid={`tree-node-${node.name}`}
          role="treeitem"
          onClick={() => {
            if (node.type === "directory") {
              onToggle?.(node.id);
            } else {
              onActivate?.({ data: node });
            }
          }}
        >
          {node.name}
        </div>
      ))}
    </div>
  ),
}));

// Mock store — WorkspaceSection reads sessionCwd from store via useStore selector
// The component checks sessions Map first, then sdkSessions array
const mockStoreState: {
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: Array<{ sessionId: string; cwd?: string }>;
} = {
  sessions: new Map([["test-session", { cwd: "/test/project" }]]),
  sdkSessions: [],
};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
}));

// Mock API — intercepts listEntries, readFile, downloadFile, downloadZip calls
const mockListEntries = vi.fn();
const mockReadFile = vi.fn();
const mockDownloadFile = vi.fn();
const mockDownloadZip = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    listEntries: (...args: unknown[]) => mockListEntries(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
    downloadZip: (...args: unknown[]) => mockDownloadZip(...args),
  },
}));

import { WorkspaceSection } from "./WorkspaceSection.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Reset store to default state with a valid cwd
  mockStoreState.sessions = new Map([
    ["test-session", { cwd: "/test/project" }],
  ]);
  mockStoreState.sdkSessions = [];

  // Default mock: successful directory listing
  mockListEntries.mockResolvedValue({
    path: "/test/project",
    entries: [
      { name: "src", type: "directory" },
      {
        name: "README.md",
        type: "file",
        size: 1024,
        mtime: "2026-02-20T10:00:00Z",
      },
      { name: "package.json", type: "file", size: 256 },
    ],
  });
});

// ─── Render test ────────────────────────────────────────────────────────────

describe("WorkspaceSection rendering", () => {
  /**
   * Validates that the component renders and shows the "Files" section header.
   * This confirms the basic mount path works when session has a valid cwd.
   */
  it("renders the section header with 'Files' label", async () => {
    render(<WorkspaceSection sessionId="test-session" />);

    await waitFor(() => {
      expect(screen.getByText("Files")).toBeTruthy();
    });
  });
});

// ─── Accessibility ──────────────────────────────────────────────────────────

describe("WorkspaceSection accessibility", () => {
  /**
   * Runs axe-core accessibility scan to verify the component
   * meets WCAG standards and has no violations.
   */
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <WorkspaceSection sessionId="test-session" />,
    );
    // Wait for tree to load before scanning
    await waitFor(() => {
      expect(screen.getByTestId("file-tree")).toBeTruthy();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ─── File tree loading ──────────────────────────────────────────────────────

describe("WorkspaceSection file tree loading", () => {
  /**
   * Validates that on mount, the component calls api.listEntries
   * with the session's working directory to load root entries.
   */
  it("calls api.listEntries with the session cwd on mount", async () => {
    render(<WorkspaceSection sessionId="test-session" />);

    await waitFor(() => {
      expect(mockListEntries).toHaveBeenCalledWith("/test/project", {
        showHidden: false,
      });
    });
  });

  /**
   * After loading, the file tree should display all returned entries.
   */
  it("renders file tree nodes after loading", async () => {
    render(<WorkspaceSection sessionId="test-session" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-tree")).toBeTruthy();
    });

    expect(screen.getByTestId("tree-node-src")).toBeTruthy();
    expect(screen.getByTestId("tree-node-README.md")).toBeTruthy();
    expect(screen.getByTestId("tree-node-package.json")).toBeTruthy();
  });
});

// ─── Markdown preview ───────────────────────────────────────────────────────

describe("WorkspaceSection markdown preview", () => {
  /**
   * Clicking a .md file should call api.readFile with the file's full path
   * and then render the markdown content in a preview pane.
   */
  it("opens markdown preview when clicking a .md file", async () => {
    mockReadFile.mockResolvedValue({ content: "# Hello World\n\nSome content" });

    render(<WorkspaceSection sessionId="test-session" />);

    // Wait for tree to load
    await waitFor(() => {
      expect(screen.getByTestId("tree-node-README.md")).toBeTruthy();
    });

    // Click the .md file to trigger preview
    fireEvent.click(screen.getByTestId("tree-node-README.md"));

    // api.readFile should be called with the full path
    await waitFor(() => {
      expect(mockReadFile).toHaveBeenCalledWith("/test/project/README.md");
    });

    // Markdown content should be rendered via the mock react-markdown
    await waitFor(() => {
      expect(screen.getByTestId("markdown-preview")).toBeTruthy();
      expect(screen.getByTestId("markdown-preview").textContent).toBe(
        "# Hello World\n\nSome content",
      );
    });
  });
});

// ─── Back navigation ────────────────────────────────────────────────────────

describe("WorkspaceSection back navigation", () => {
  /**
   * From the markdown preview, clicking the "Back" button should
   * return to the file tree view.
   */
  it("navigates back to file tree from markdown preview", async () => {
    mockReadFile.mockResolvedValue({ content: "# Test" });

    render(<WorkspaceSection sessionId="test-session" />);

    // Wait for tree, then open preview
    await waitFor(() => {
      expect(screen.getByTestId("tree-node-README.md")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("tree-node-README.md"));

    // Wait for preview to appear
    await waitFor(() => {
      expect(screen.getByText("Back")).toBeTruthy();
    });

    // Click back button
    fireEvent.click(screen.getByText("Back"));

    // File tree should be visible again
    await waitFor(() => {
      expect(screen.getByTestId("file-tree")).toBeTruthy();
    });
  });
});

// ─── No cwd ─────────────────────────────────────────────────────────────────

describe("WorkspaceSection with no cwd", () => {
  /**
   * When the session has no workspace directory (cwd is null/undefined),
   * the component should display an informational message instead of the tree.
   */
  it("shows 'No workspace directory available' when session has no cwd", () => {
    // Override store to return no cwd
    mockStoreState.sessions = new Map([["test-session", {}]]);

    render(<WorkspaceSection sessionId="test-session" />);

    expect(
      screen.getByText("No workspace directory available"),
    ).toBeTruthy();
    // Should not attempt to load entries
    expect(mockListEntries).not.toHaveBeenCalled();
  });
});

// ─── Refresh ────────────────────────────────────────────────────────────────

describe("WorkspaceSection refresh", () => {
  /**
   * Clicking the refresh button should re-call api.listEntries to reload
   * the file tree data from the server.
   */
  it("reloads tree data when clicking the refresh button", async () => {
    render(<WorkspaceSection sessionId="test-session" />);

    // Wait for initial load
    await waitFor(() => {
      expect(mockListEntries).toHaveBeenCalledTimes(1);
    });

    // Find and click the refresh button (has title="Refresh file tree")
    const refreshButton = screen.getByTitle("Refresh file tree");
    fireEvent.click(refreshButton);

    // listEntries should be called again
    await waitFor(() => {
      expect(mockListEntries).toHaveBeenCalledTimes(2);
    });
  });
});

// ─── Error state ────────────────────────────────────────────────────────────

describe("WorkspaceSection error state", () => {
  /**
   * When api.listEntries fails, the component should display
   * the error message to the user instead of the file tree.
   */
  it("shows error message when loading fails", async () => {
    mockListEntries.mockRejectedValue(new Error("Permission denied"));

    render(<WorkspaceSection sessionId="test-session" />);

    await waitFor(() => {
      expect(screen.getByText("Permission denied")).toBeTruthy();
    });
  });

  /**
   * When api.listEntries fails with a non-Error value, it should
   * fall back to a generic error message.
   */
  it("shows generic error for non-Error exceptions", async () => {
    mockListEntries.mockRejectedValue("network timeout");

    render(<WorkspaceSection sessionId="test-session" />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load files")).toBeTruthy();
    });
  });
});
