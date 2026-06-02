// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  terminalCwd: string | null;
  openTerminal: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    terminalCwd: null,
    openTerminal: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

vi.mock("./TerminalView.js", () => ({
  TerminalView: ({ cwd }: { cwd: string }) => <div data-testid="terminal-view">{cwd}</div>,
}));

vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({ onSelect }: { onSelect: (path: string) => void }) => (
    <div data-testid="folder-picker">
      <button onClick={() => onSelect("/tmp/terminal-project")}>Pick folder</button>
    </div>
  ),
}));

import { TerminalPage } from "./TerminalPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  window.location.hash = "#/terminal";
});

describe("TerminalPage", () => {
  it("shows empty state when no terminal folder is selected", () => {
    render(<TerminalPage />);
    expect(screen.getByText("No terminal started yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose Folder" })).toBeInTheDocument();
  });

  it("renders terminal view when a folder is selected", () => {
    mockState = createMockState({ terminalCwd: "/tmp/existing" });
    render(<TerminalPage />);
    expect(screen.getByTestId("terminal-view")).toHaveTextContent("/tmp/existing");
    expect(screen.getByRole("button", { name: "Change Folder" })).toBeInTheDocument();
  });

  it("opens picker and starts terminal with selected folder", () => {
    render(<TerminalPage />);

    fireEvent.click(screen.getByRole("button", { name: "Choose Folder" }));
    fireEvent.click(screen.getByText("Pick folder"));

    expect(mockState.openTerminal).toHaveBeenCalledWith("/tmp/terminal-project");
    expect(window.location.hash).toBe("#/terminal");
  });
});
