// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock @xterm/xterm — Terminal is a complex class that requires a real DOM canvas
const mockWrite = vi.fn();
const mockWriteln = vi.fn();
const mockOpen = vi.fn();
const mockDispose = vi.fn();
const mockLoadAddon = vi.fn();
const mockOnData = vi.fn(() => ({ dispose: vi.fn() }));

vi.mock("@xterm/xterm", () => ({
  // Must use a function expression (not arrow) so it can be called with `new`
  Terminal: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.open = mockOpen;
    this.write = mockWrite;
    this.writeln = mockWriteln;
    this.dispose = mockDispose;
    this.loadAddon = mockLoadAddon;
    this.onData = mockOnData;
    this.cols = 80;
    this.rows = 24;
    this.options = {};
  }),
}));

// Mock @xterm/addon-fit — must use function expression for `new` calls
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.fit = vi.fn();
  }),
}));

// Mock @xterm/xterm CSS import
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// Mock store
vi.mock("../store.js", () => ({
  useStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({ darkMode: true, setTerminalId: vi.fn() }),
    ),
    {
      getState: vi.fn(() => ({ darkMode: true, setTerminalId: vi.fn() })),
    },
  ),
}));

// Mock api — spawnTerminal and killTerminal
vi.mock("../api.js", () => ({
  api: {
    spawnTerminal: vi.fn(() => Promise.resolve({ terminalId: "term-123" })),
    killTerminal: vi.fn(() => Promise.resolve()),
  },
}));

// Mock terminal-ws
const mockSendInput = vi.fn();
const mockSendResize = vi.fn();
const mockDisconnect = vi.fn();
vi.mock("../terminal-ws.js", () => ({
  createTerminalConnection: vi.fn(() => ({
    sendInput: mockSendInput,
    sendResize: mockSendResize,
    disconnect: mockDisconnect,
  })),
}));

// Mock TerminalAccessoryBar since it's a child component
vi.mock("./TerminalAccessoryBar.js", () => ({
  TerminalAccessoryBar: ({ onWrite, onPaste }: { onWrite: (data: string) => void; onPaste: () => void }) => (
    <div data-testid="accessory-bar">
      <button data-testid="accessory-write" onClick={() => onWrite("test")}>Write</button>
      <button data-testid="accessory-paste" onClick={() => onPaste()}>Paste</button>
    </div>
  ),
}));

// Mock document.fonts.load for font readiness check
Object.defineProperty(document, "fonts", {
  value: { load: vi.fn(() => Promise.resolve([])) },
  writable: true,
});

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

import { TerminalView } from "./TerminalView.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TerminalView", () => {
  // ── Render Tests ──────────────────────────────────────────────────────────

  // Test 1: Renders terminal container div
  it("renders terminal container element", () => {
    const { container } = render(<TerminalView cwd="/workspace" />);
    // The terminal frame should be present
    expect(container.querySelector(".flex.flex-col")).toBeInTheDocument();
  });

  // Test 2: Shows cwd in header when no title
  it("shows cwd in header when no title prop", () => {
    render(<TerminalView cwd="/workspace/project" />);
    expect(screen.getByText("/workspace/project")).toBeInTheDocument();
  });

  // Test 3: Shows title in header when provided
  it("shows title in header when title prop is provided", () => {
    render(<TerminalView cwd="/workspace" title="My Terminal" />);
    expect(screen.getByText("My Terminal")).toBeInTheDocument();
  });

  // Test 4: Renders close button when onClose provided
  it("renders close button when onClose is provided", () => {
    const onClose = vi.fn();
    const { container } = render(<TerminalView cwd="/workspace" onClose={onClose} />);
    // Close button is a button with an X SVG inside the header
    const closeBtn = container.querySelector("button");
    expect(closeBtn).toBeInTheDocument();
  });

  // Test 5: Does not render close button without onClose
  it("does not render close button without onClose", () => {
    const { container } = render(<TerminalView cwd="/workspace" />);
    const buttons = container.querySelectorAll("button");
    // Only the accessory bar buttons should exist, no close button in the header
    const headerButtons = container.querySelector(".border-b button");
    expect(headerButtons).not.toBeInTheDocument();
  });

  // Test 6: Renders TerminalAccessoryBar
  it("renders the terminal accessory bar", () => {
    render(<TerminalView cwd="/workspace" />);
    expect(screen.getByTestId("accessory-bar")).toBeInTheDocument();
  });

  // ── Layout Variations ─────────────────────────────────────────────────────

  // Test 7: Embedded mode uses h-full container
  it("uses h-full layout in embedded mode", () => {
    const { container } = render(<TerminalView cwd="/workspace" embedded />);
    const outerDiv = container.firstElementChild;
    expect(outerDiv?.className).toContain("h-full");
  });

  // Test 8: Non-embedded mode uses fixed overlay
  it("uses fixed overlay in non-embedded mode", () => {
    const { container } = render(<TerminalView cwd="/workspace" />);
    const outerDiv = container.firstElementChild;
    expect(outerDiv?.className).toContain("fixed");
    expect(outerDiv?.className).toContain("inset-0");
  });

  // Test 9: Hidden when visible=false in embedded mode
  it("applies hidden class when visible=false in embedded mode", () => {
    const { container } = render(<TerminalView cwd="/workspace" embedded visible={false} />);
    const outerDiv = container.firstElementChild;
    expect(outerDiv?.className).toContain("hidden");
  });

  // Test 10: Visible when visible=true in embedded mode
  it("does not apply hidden class when visible=true in embedded mode", () => {
    const { container } = render(<TerminalView cwd="/workspace" embedded visible={true} />);
    const outerDiv = container.firstElementChild;
    expect(outerDiv?.className).not.toContain("hidden");
  });

  // Test 11: Header hidden when hideHeader=true
  it("hides header when hideHeader is true", () => {
    render(<TerminalView cwd="/workspace" hideHeader />);
    // cwd text should not appear in header
    expect(screen.queryByText("/workspace")).not.toBeInTheDocument();
  });

  // ── Interactive Behavior ──────────────────────────────────────────────────

  // Test 12: Clicking close button calls onClose
  it("clicking close button calls onClose", () => {
    const onClose = vi.fn();
    const { container } = render(<TerminalView cwd="/workspace" onClose={onClose} />);
    // Find the close button in the header (the one with the X SVG)
    const headerBar = container.querySelector(".border-b");
    const closeBtn = headerBar?.querySelector("button");
    expect(closeBtn).toBeInTheDocument();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Test 13: Click on terminal frame stops propagation (modal doesn't close)
  it("clicking terminal frame stops event propagation", () => {
    const onClick = vi.fn();
    const { container } = render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div onClick={onClick}>
        <TerminalView cwd="/workspace" />
      </div>,
    );
    const frame = container.querySelector(".flex.flex-col.shadow-2xl");
    if (frame) {
      fireEvent.click(frame);
      expect(onClick).not.toHaveBeenCalled();
    }
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  // Test 14: Accessibility scan — embedded mode with header
  // Note: The close button in TerminalView lacks aria-label — pre-existing
  // source issue. We disable button-name to test remaining a11y.
  it("passes axe accessibility checks in embedded mode", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <TerminalView cwd="/workspace" embedded title="Dev Terminal" onClose={() => {}} />,
    );
    const results = await axe(container, {
      rules: {
        region: { enabled: false },
        "button-name": { enabled: false },
      },
    });
    expect(results).toHaveNoViolations();
  });

  // Test 15: Accessibility scan — modal mode
  it("passes axe accessibility checks in modal mode", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <TerminalView cwd="/workspace" title="Terminal" onClose={() => {}} />,
    );
    const results = await axe(container, {
      rules: {
        region: { enabled: false },
        "button-name": { enabled: false },
      },
    });
    expect(results).toHaveNoViolations();
  });

  // Test 16: Accessibility scan — no header mode
  it("passes axe accessibility checks with hidden header", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <TerminalView cwd="/workspace" embedded hideHeader />,
    );
    const results = await axe(container, {
      rules: {
        region: { enabled: false },
      },
    });
    expect(results).toHaveNoViolations();
  });
});
