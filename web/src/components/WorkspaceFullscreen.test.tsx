// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ─── Browser API Polyfills ──────────────────────────────────────────────────
// jsdom does not provide ResizeObserver or IntersectionObserver.
// FileTreePanel uses ResizeObserver for dynamic tree height and
// MarkdownViewer uses IntersectionObserver for active heading tracking.

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  } as unknown as typeof globalThis.IntersectionObserver;
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock react-markdown to avoid ESM/jsdom issues (same pattern as WorkspaceSection.test.tsx)
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown-viewer">{children}</div>
  ),
}));
vi.mock("remark-gfm", () => ({
  default: () => {},
}));

// Mock react-arborist — provides a minimal tree component that renders nodes
// and supports file selection via onActivate and directory toggling via onToggle.
// The FileTreePanel component passes its own renderer as `children`, so we also
// accept (but ignore) that prop here — the mock directly renders the node data.
vi.mock("react-arborist", () => ({
  Tree: ({
    data,
    onActivate,
    onToggle,
  }: {
    data: Array<{
      id: string;
      name: string;
      type: string;
      children?: unknown[];
    }>;
    children?: unknown;
    onActivate?: (node: { data: unknown }) => void;
    onToggle?: (id: string) => void;
    [key: string]: unknown;
  }) => (
    <div data-testid="file-tree-panel" role="tree">
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

// Mock store — WorkspaceFullscreen reads sessionCwd from store via useStore selector.
// The component checks sessions Map first, then sdkSessions array.
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

// Mock API — intercepts listEntries, readFile, downloadFile, downloadZip calls.
// listEntries is called by the FileTreePanel on mount to load the file tree.
// readFile is called when a file is selected to load its content.
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

import { WorkspaceFullscreen } from "./WorkspaceFullscreen.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Reset store to default state with a valid cwd
  mockStoreState.sessions = new Map([
    ["test-session", { cwd: "/test/project" }],
  ]);
  mockStoreState.sdkSessions = [];

  // Default mock: listEntries returns empty entries (file tree loads on mount)
  mockListEntries.mockResolvedValue({
    path: "/test/project",
    entries: [],
  });

  // Default mock: readFile resolves with markdown content
  mockReadFile.mockResolvedValue({ content: "# Test\n\nHello" });
});

// ─── Render test ────────────────────────────────────────────────────────────

describe("WorkspaceFullscreen rendering", () => {
  /**
   * Validates that when no initialFile is provided, the fullscreen overlay
   * renders with the empty state message "Select a file to preview".
   * This confirms the component mounts correctly and shows the correct
   * placeholder when the user hasn't selected any file yet.
   */
  it("renders the fullscreen overlay with 'Select a file to preview' when no initial file", async () => {
    render(
      <WorkspaceFullscreen
        sessionId="test-session"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Select a file to preview")).toBeTruthy();
    });
  });
});

// ─── File loading ───────────────────────────────────────────────────────────

describe("WorkspaceFullscreen file loading", () => {
  /**
   * Validates that when initialFile is a .md file, the component calls
   * api.readFile with the full path and renders the markdown content
   * using the MarkdownViewer (mocked react-markdown). This confirms
   * the file loading lifecycle works end-to-end for markdown files.
   */
  it("calls api.readFile and renders markdown content when initialFile is a .md file", async () => {
    mockReadFile.mockResolvedValue({
      content: "# Hello World\n\nMarkdown content here",
    });

    render(
      <WorkspaceFullscreen
        sessionId="test-session"
        initialFile="/test/project/README.md"
        onClose={vi.fn()}
      />,
    );

    // api.readFile should be called with the initial file path
    await waitFor(() => {
      expect(mockReadFile).toHaveBeenCalledWith("/test/project/README.md");
    });

    // The markdown content should be rendered via the mocked react-markdown
    await waitFor(() => {
      expect(screen.getByTestId("markdown-viewer")).toBeTruthy();
      expect(screen.getByTestId("markdown-viewer").textContent).toBe(
        "# Hello World\n\nMarkdown content here",
      );
    });
  });
});

// ─── Close on ESC ───────────────────────────────────────────────────────────

describe("WorkspaceFullscreen ESC key handling", () => {
  /**
   * Validates that pressing the Escape key triggers the onClose callback.
   * The component registers a global keydown listener for ESC to allow
   * users to dismiss the fullscreen overlay with the keyboard.
   */
  it("calls onClose when Escape key is pressed", async () => {
    const onClose = vi.fn();

    render(
      <WorkspaceFullscreen
        sessionId="test-session"
        onClose={onClose}
      />,
    );

    // Wait for component to fully mount
    await waitFor(() => {
      expect(screen.getByText("Select a file to preview")).toBeTruthy();
    });

    // Simulate pressing Escape
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── Close button ───────────────────────────────────────────────────────────

describe("WorkspaceFullscreen close button", () => {
  /**
   * Validates that clicking the close button in the toolbar triggers the
   * onClose callback. The ViewerToolbar renders a button with
   * aria-label="Close fullscreen" which delegates to the onClose prop.
   */
  it("calls onClose when the close button in toolbar is clicked", async () => {
    const onClose = vi.fn();

    render(
      <WorkspaceFullscreen
        sessionId="test-session"
        onClose={onClose}
      />,
    );

    // Wait for component to fully mount
    await waitFor(() => {
      expect(screen.getByText("Select a file to preview")).toBeTruthy();
    });

    // Find and click the close button by its aria-label
    const closeButton = screen.getByLabelText("Close fullscreen");
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── Plain text for non-md files ────────────────────────────────────────────

describe("WorkspaceFullscreen plain text rendering", () => {
  /**
   * Validates that when a non-markdown file (e.g. .json, .txt, .ts) is loaded,
   * the content is rendered in a plain text <pre> block instead of the
   * MarkdownViewer component. This ensures the component correctly
   * differentiates between markdown and non-markdown file types.
   */
  it("renders content in plain text (not markdown) for non-.md files", async () => {
    mockReadFile.mockResolvedValue({
      content: '{ "name": "test-project" }',
    });

    render(
      <WorkspaceFullscreen
        sessionId="test-session"
        initialFile="/test/project/package.json"
        onClose={vi.fn()}
      />,
    );

    // api.readFile should be called with the file path
    await waitFor(() => {
      expect(mockReadFile).toHaveBeenCalledWith("/test/project/package.json");
    });

    // Content should be rendered as plain text, NOT inside the markdown viewer
    await waitFor(() => {
      expect(screen.getByText('{ "name": "test-project" }')).toBeTruthy();
    });

    // The markdown-viewer testid should NOT be present
    expect(screen.queryByTestId("markdown-viewer")).toBeNull();
  });
});

// ─── Accessibility ──────────────────────────────────────────────────────────

describe("WorkspaceFullscreen accessibility", () => {
  /**
   * Runs axe-core accessibility scan to verify the fullscreen overlay
   * meets WCAG standards and has no violations. This test checks the
   * component in its initial empty state (no file selected).
   */
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <WorkspaceFullscreen
        sessionId="test-session"
        onClose={vi.fn()}
      />,
    );

    // Wait for the component to fully render
    await waitFor(() => {
      expect(screen.getByText("Select a file to preview")).toBeTruthy();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
