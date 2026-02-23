// @vitest-environment jsdom
import type React from "react";
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

// Mock createPortal to render inline instead of to document.body
// This is necessary because createPortal renders outside the test container,
// making it invisible to testing-library queries.
vi.mock("react-dom", async () => {
  const actual = await vi.importActual("react-dom");
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

// Mock WorkspaceFullscreen component with a minimal testable stand-in
// that exposes the initialFile prop and provides a close button for interaction tests.
vi.mock("./WorkspaceFullscreen.js", () => ({
  WorkspaceFullscreen: ({
    initialFile,
    onClose,
  }: {
    initialFile?: string | null;
    onClose: () => void;
    sessionId: string;
  }) => (
    <div data-testid="workspace-fullscreen" data-file={initialFile}>
      <button onClick={onClose}>Close Fullscreen</button>
    </div>
  ),
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

// ─── Fullscreen preview on .md click ────────────────────────────────────────

describe("WorkspaceSection markdown preview", () => {
  /**
   * Clicking a .md file should open the fullscreen workspace overlay
   * with the file path passed as initialFile. The component now uses
   * createPortal + WorkspaceFullscreen instead of inline MarkdownPreview.
   */
  it("opens fullscreen when clicking a .md file", async () => {
    render(<WorkspaceSection sessionId="test-session" />);

    // Wait for tree to load
    await waitFor(() => {
      expect(screen.getByTestId("tree-node-README.md")).toBeTruthy();
    });

    // Click the .md file to trigger fullscreen overlay
    fireEvent.click(screen.getByTestId("tree-node-README.md"));

    // WorkspaceFullscreen should be rendered with the file path
    await waitFor(() => {
      expect(screen.getByTestId("workspace-fullscreen")).toBeTruthy();
    });
  });
});

// ─── Close fullscreen ────────────────────────────────────────────────────────

describe("WorkspaceSection close fullscreen", () => {
  /**
   * From the fullscreen overlay, clicking "Close Fullscreen" should
   * dismiss the overlay and return to the file tree view.
   */
  it("closes fullscreen and returns to file tree", async () => {
    render(<WorkspaceSection sessionId="test-session" />);

    // Wait for tree, then open fullscreen via .md click
    await waitFor(() => {
      expect(screen.getByTestId("tree-node-README.md")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("tree-node-README.md"));

    // Wait for fullscreen overlay to appear
    await waitFor(() => {
      expect(screen.getByTestId("workspace-fullscreen")).toBeTruthy();
    });

    // Click close button on the fullscreen overlay
    fireEvent.click(screen.getByText("Close Fullscreen"));

    // Fullscreen should be dismissed
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-fullscreen")).toBeNull();
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

// ─── Fullscreen expand button ────────────────────────────────────────────────

describe("WorkspaceSection fullscreen button", () => {
  /**
   * The header bar includes an expand button (title="Open fullscreen workspace")
   * that opens the fullscreen overlay without requiring a file click first.
   */
  it("renders an expand button that opens fullscreen", async () => {
    render(<WorkspaceSection sessionId="test-session" />);

    // Wait for the expand button to be available in the header
    await waitFor(() => {
      expect(screen.getByTitle("Open fullscreen workspace")).toBeTruthy();
    });

    // Click the expand button to open fullscreen
    fireEvent.click(screen.getByTitle("Open fullscreen workspace"));

    // WorkspaceFullscreen overlay should appear
    await waitFor(() => {
      expect(screen.getByTestId("workspace-fullscreen")).toBeTruthy();
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
