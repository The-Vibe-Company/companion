// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TerminalAccessoryBar } from "./TerminalAccessoryBar.js";

// Simulate a touch device with a mobile viewport width.
// The hook checks ontouchstart + innerWidth < 1024 at render time.
// Mobile viewport: innerWidth=390, innerHeight=844 (iPhone 14 dimensions).
// visualViewport.height < innerHeight means keyboard is open.
const INNER_HEIGHT = 844;
const KEYBOARD_OPEN_VV_HEIGHT = 400; // ~444px keyboard
const mockVV = {
  height: KEYBOARD_OPEN_VV_HEIGHT,
  offsetTop: 0,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

beforeAll(() => {
  Object.defineProperty(window, "ontouchstart", { value: null, writable: true });
  Object.defineProperty(window, "innerWidth", { value: 390, writable: true });
  Object.defineProperty(window, "innerHeight", { value: INNER_HEIGHT, writable: true });
  Object.defineProperty(window, "visualViewport", { value: mockVV, writable: true });
});

beforeEach(() => {
  // Reset to keyboard-open state before each test
  mockVV.height = KEYBOARD_OPEN_VV_HEIGHT;
});

describe("TerminalAccessoryBar", () => {
  it("renders all expected keys when keyboard is open", () => {
    /** Verifies that every special key button is present in the accessory bar. */
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    expect(screen.getByText("Esc")).toBeInTheDocument();
    expect(screen.getByText("Tab")).toBeInTheDocument();
    expect(screen.getByText("^C")).toBeInTheDocument();
    expect(screen.getByText("^D")).toBeInTheDocument();
    expect(screen.getByText("^Z")).toBeInTheDocument();
    expect(screen.getByText("^L")).toBeInTheDocument();
    expect(screen.getByText("Ctrl")).toBeInTheDocument();
    // Arrow keys (unicode)
    expect(screen.getByText("\u2191")).toBeInTheDocument(); // ↑
    expect(screen.getByText("\u2193")).toBeInTheDocument(); // ↓
    expect(screen.getByText("\u2190")).toBeInTheDocument(); // ←
    expect(screen.getByText("\u2192")).toBeInTheDocument(); // →
    expect(screen.getByText("|")).toBeInTheDocument();
    expect(screen.getByText("~")).toBeInTheDocument();
  });

  it("sends Esc escape sequence (0x1b)", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("Esc"));
    expect(onWrite).toHaveBeenCalledWith("\x1b");
  });

  it("sends Tab character (0x09)", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("Tab"));
    expect(onWrite).toHaveBeenCalledWith("\t");
  });

  it("sends Ctrl+C (0x03) when ^C is tapped", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("^C"));
    expect(onWrite).toHaveBeenCalledWith("\x03");
  });

  it("sends Ctrl+D (0x04) when ^D is tapped", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("^D"));
    expect(onWrite).toHaveBeenCalledWith("\x04");
  });

  it("sends arrow up escape sequence (ESC[A)", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("\u2191")); // ↑
    expect(onWrite).toHaveBeenCalledWith("\x1b[A");
  });

  it("sends arrow down escape sequence (ESC[B)", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("\u2193")); // ↓
    expect(onWrite).toHaveBeenCalledWith("\x1b[B");
  });

  it("sends arrow left escape sequence (ESC[D)", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("\u2190")); // ←
    expect(onWrite).toHaveBeenCalledWith("\x1b[D");
  });

  it("sends arrow right escape sequence (ESC[C)", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("\u2192")); // →
    expect(onWrite).toHaveBeenCalledWith("\x1b[C");
  });

  it("sends pipe character when | is tapped", () => {
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    fireEvent.click(screen.getByText("|"));
    expect(onWrite).toHaveBeenCalledWith("|");
  });

  it("renders Paste button when onPaste is provided", () => {
    const onWrite = vi.fn();
    const onPaste = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} onPaste={onPaste} />);

    const pasteBtn = screen.getByText("Paste");
    expect(pasteBtn).toBeInTheDocument();

    fireEvent.click(pasteBtn);
    expect(onPaste).toHaveBeenCalled();
  });

  it("does not render Paste button when onPaste is omitted", () => {
    /**
     * With keyboard open but no onPaste callback, bar renders but
     * without the Paste button.
     */
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    expect(screen.queryByText("Paste")).not.toBeInTheDocument();
    // Other keys should still be present
    expect(screen.getByText("Esc")).toBeInTheDocument();
  });

  it("highlights Ctrl toggle and deactivates after a non-letter key", () => {
    /**
     * Ctrl toggle should visually activate (orange bg) when tapped,
     * then deactivate after any key press. Non-letter keys pass through raw.
     */
    const onWrite = vi.fn();
    render(<TerminalAccessoryBar onWrite={onWrite} />);

    const ctrlBtn = screen.getByText("Ctrl");

    // Toggle Ctrl on
    fireEvent.click(ctrlBtn);
    expect(ctrlBtn.className).toContain("bg-cc-primary");

    // Press pipe (not A-Z) — sends raw "|" and deactivates Ctrl
    fireEvent.click(screen.getByText("|"));
    expect(onWrite).toHaveBeenCalledWith("|");
    expect(ctrlBtn.className).not.toContain("bg-cc-primary");
  });

  it("returns null when keyboard is closed (keyboardOffset === 0)", () => {
    /** When visualViewport.height equals innerHeight, no keyboard is open. */
    mockVV.height = INNER_HEIGHT; // same as window.innerHeight → keyboard closed
    const onWrite = vi.fn();
    const { container } = render(<TerminalAccessoryBar onWrite={onWrite} />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null on non-touch or wide-screen devices", () => {
    /** The bar should not render on desktop-width screens. */
    Object.defineProperty(window, "innerWidth", { value: 1440, writable: true });
    const onWrite = vi.fn();
    const { container } = render(<TerminalAccessoryBar onWrite={onWrite} />);
    expect(container.innerHTML).toBe("");
    // Restore mobile width for other tests
    Object.defineProperty(window, "innerWidth", { value: 390, writable: true });
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const onWrite = vi.fn();
    const { container } = render(
      <TerminalAccessoryBar onWrite={onWrite} onPaste={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
