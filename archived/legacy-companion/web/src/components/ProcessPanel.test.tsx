// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ProcessItem, ProcessStatus, SystemProcess } from "../types.js";

// ---- Mock API ----
const mockKillProcess = vi.fn().mockResolvedValue({ ok: true, taskId: "abc123" });
const mockKillAllProcesses = vi.fn().mockResolvedValue({ ok: true, results: [] });
const mockGetSystemProcesses = vi.fn().mockResolvedValue({ ok: true, processes: [] });
const mockKillSystemProcess = vi.fn().mockResolvedValue({ ok: true, pid: 1234 });

vi.mock("../api.js", () => ({
  api: {
    killProcess: (...args: unknown[]) => mockKillProcess(...args),
    killAllProcesses: (...args: unknown[]) => mockKillAllProcesses(...args),
    getSystemProcesses: (...args: unknown[]) => mockGetSystemProcesses(...args),
    killSystemProcess: (...args: unknown[]) => mockKillSystemProcess(...args),
  },
}));

// ---- Mock Store ----
interface MockStoreState {
  sessions: Map<string, { cwd: string; repo_root?: string }>;
  sessionProcesses: Map<string, ProcessItem[]>;
  updateProcess: ReturnType<typeof vi.fn>;
}

function makeProcess(overrides: Partial<ProcessItem> = {}): ProcessItem {
  return {
    taskId: "abc123",
    toolUseId: "tool_1",
    command: "python3 -m http.server 8000",
    description: "Start dev server",
    outputFile: "/tmp/abc123.out",
    status: "running" as ProcessStatus,
    startedAt: Date.now() - 30_000,
    ...overrides,
  };
}

function makeSystemProcess(overrides: Partial<SystemProcess> = {}): SystemProcess {
  return {
    pid: 1234,
    command: "node",
    fullCommand: "node ./server.js --port 3000",
    ports: [3000],
    ...overrides,
  };
}

let mockState: MockStoreState;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessions: new Map(),
    sessionProcesses: new Map(),
    updateProcess: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { ProcessPanel } from "./ProcessPanel.js";

async function expandSystemGroup(label?: string) {
  const button = label
    ? await screen.findByRole("button", { name: `Toggle process group ${label}` })
    : await screen.findByRole("button", { name: /Toggle process group/ });
  // Wait for default-collapse effect to settle before toggling.
  await waitFor(() => {
    expect(button).toHaveAttribute("aria-expanded");
  });
  if (button.getAttribute("aria-expanded") === "false") {
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toHaveAttribute("aria-expanded", "true");
    });
  }
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  // Default: no system processes
  mockGetSystemProcesses.mockResolvedValue({ ok: true, processes: [] });
});

describe("ProcessPanel", () => {
  it("shows loading state while the initial dev server scan is running", async () => {
    const pending = deferred<{ ok: boolean; processes: SystemProcess[] }>();
    mockGetSystemProcesses.mockReturnValueOnce(pending.promise);
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.getByText("Searching for running dev servers...")).toBeInTheDocument();
    expect(screen.getByText(/Checking listening ports/)).toBeInTheDocument();

    pending.resolve({ ok: true, processes: [] });
    await waitFor(() => {
      expect(screen.getByText("No background processes")).toBeInTheDocument();
    });
  });

  it("renders empty state when no processes exist", async () => {
    // Empty panel should show instructional text after initial scan completes.
    render(<ProcessPanel sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("No background processes")).toBeInTheDocument();
    });
    expect(screen.getByText(/dev servers listening on ports/)).toBeInTheDocument();
  });

  it("shows an error state when the initial dev server scan fails", async () => {
    mockGetSystemProcesses.mockRejectedValueOnce(new Error("lsof failed"));
    render(<ProcessPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't scan dev servers")).toBeInTheDocument();
      expect(screen.getByText(/lsof failed/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry scan" })).toBeInTheDocument();
    });
  });

  it("renders a running process with description, taskId, and kill button", () => {
    // A single running process should show its description, ID, and a Kill button
    const proc = makeProcess();
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.getByText("Start dev server")).toBeInTheDocument();
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Kill process abc123/ })).toBeInTheDocument();
  });

  it("renders a completed process with summary and no kill button", () => {
    // Completed processes should show summary and not offer a Kill button
    const proc = makeProcess({
      taskId: "def456",
      status: "completed",
      completedAt: Date.now(),
      summary: "Server exited cleanly",
    });
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.getByText("Start dev server")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Kill process/ })).not.toBeInTheDocument();
  });

  it("calls killProcess API when Kill button is clicked", async () => {
    // Clicking Kill should call the API with the correct sessionId and taskId
    const proc = makeProcess({ taskId: "abc123" });
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: /Kill process abc123/ }));

    await waitFor(() => {
      expect(mockKillProcess).toHaveBeenCalledWith("s1", "abc123");
    });
  });

  it("shows Kill All button when more than 1 process is running", () => {
    // Kill All should appear only when there are 2+ running processes
    const procs = [
      makeProcess({ taskId: "a1", toolUseId: "t1" }),
      makeProcess({ taskId: "a2", toolUseId: "t2" }),
    ];
    resetStore({ sessionProcesses: new Map([["s1", procs]]) });
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.getByRole("button", { name: "Kill all running processes" })).toBeInTheDocument();
  });

  it("does not show Kill All button with only 1 running process", () => {
    // Kill All should only appear with 2+ running processes
    const procs = [makeProcess()];
    resetStore({ sessionProcesses: new Map([["s1", procs]]) });
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.queryByRole("button", { name: "Kill all running processes" })).not.toBeInTheDocument();
  });

  it("calls killAllProcesses API when Kill All is clicked", async () => {
    // Clicking Kill All should call the API with all running task IDs
    const procs = [
      makeProcess({ taskId: "a1", toolUseId: "t1" }),
      makeProcess({ taskId: "a2", toolUseId: "t2" }),
    ];
    resetStore({ sessionProcesses: new Map([["s1", procs]]) });
    render(<ProcessPanel sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Kill all running processes" }));

    await waitFor(() => {
      expect(mockKillAllProcesses).toHaveBeenCalledWith("s1", ["a1", "a2"]);
    });
  });

  it("expands to show full command when process description is clicked", () => {
    // Clicking the description should expand to reveal the full command
    const proc = makeProcess({ command: "python3 -m http.server 8000 --bind 0.0.0.0" });
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    // Click the description to expand
    fireEvent.click(screen.getByText("Start dev server"));

    // Full command should now be visible in the expanded <pre> block
    expect(screen.getByText("python3 -m http.server 8000 --bind 0.0.0.0")).toBeInTheDocument();
  });

  it("shows summary text in expanded view for completed process", () => {
    // Completed processes with a summary should show it when expanded
    const proc = makeProcess({
      status: "completed",
      completedAt: Date.now(),
      summary: "Server exited with code 0",
    });
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    // Click to expand
    fireEvent.click(screen.getByText("Start dev server"));
    expect(screen.getByText("Server exited with code 0")).toBeInTheDocument();
  });

  it("shows 'Completed' divider when both running and completed processes exist", () => {
    // The divider helps visually separate running from completed processes
    const procs = [
      makeProcess({ taskId: "r1", toolUseId: "t1", status: "running" }),
      makeProcess({ taskId: "c1", toolUseId: "t2", status: "completed", completedAt: Date.now() }),
    ];
    resetStore({ sessionProcesses: new Map([["s1", procs]]) });
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("falls back to truncated command when description is empty", () => {
    // If no description is provided, the command should be shown (truncated)
    const proc = makeProcess({
      description: "",
      command: "npm run dev -- --port 3000 --host 0.0.0.0 --open --verbose",
    });
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    // The truncated command should appear (truncateCommand uses 60 chars by default)
    expect(screen.getByText(/npm run dev/)).toBeInTheDocument();
  });

  it("renders process list with proper role and label", () => {
    // The Claude tasks process list should be accessible with role="list"
    const proc = makeProcess();
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.getByRole("list", { name: "Background processes" })).toBeInTheDocument();
  });

  it("shows 'Claude Tasks' section header when Claude processes exist", () => {
    // Section header labels the Claude-spawned tasks
    const proc = makeProcess();
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    render(<ProcessPanel sessionId="s1" />);

    expect(screen.getByText(/Claude Tasks/)).toBeInTheDocument();
  });
});

describe("ProcessPanel system processes", () => {
  it("shows system dev processes returned by the API", async () => {
    // System processes should appear in the "Dev Servers" section
    const sysProcs = [makeSystemProcess({ pid: 5555, command: "bun", ports: [3000] })];
    mockGetSystemProcesses.mockResolvedValue({ ok: true, processes: sysProcs });
    render(<ProcessPanel sessionId="s1" />);

    await expandSystemGroup();

    await waitFor(() => {
      expect(screen.getByText("bun")).toBeInTheDocument();
      expect(screen.getByText("localhost:3000")).toBeInTheDocument();
      expect(screen.getByText("PID: 5555")).toBeInTheDocument();
    });
  });

  it("shows a readable app label inferred from the full command", async () => {
    // The UI should infer a clearer app name than just "node" when possible.
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [
        makeSystemProcess({
          command: "node",
          fullCommand: "node /repo/web/node_modules/vite/bin/vite.js --port 3000",
          ports: [3000],
        }),
      ],
    });
    render(<ProcessPanel sessionId="s1" />);

    await expandSystemGroup();

    await waitFor(() => {
      expect(screen.getByText("Vite dev server")).toBeInTheDocument();
      expect(screen.getByText("node")).toBeInTheDocument();
    });
  });

  it("groups system processes by project folder and marks current repo", async () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo/app", repo_root: "/repo/app" }]]),
    });
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [
        makeSystemProcess({
          pid: 101,
          command: "node",
          fullCommand: "node /repo/app/node_modules/.bin/vite",
          cwd: "/repo/app",
          ports: [3000],
          startedAt: Date.now() - 65_000,
        }),
        makeSystemProcess({
          pid: 202,
          command: "bun",
          fullCommand: "bun run --hot src/index.ts",
          cwd: "/repo/worker",
          ports: [3001],
        }),
      ],
    });

    render(<ProcessPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Toggle process group app" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Toggle process group worker" })).toBeInTheDocument();
      // Group-level summary info should be visible even while collapsed.
      expect(screen.getAllByText("1 running").length).toBeGreaterThan(0);
      expect(screen.getByText("Current repo")).toBeInTheDocument();
    });

    // Current repo should start expanded; other folders should start collapsed.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Toggle process group app" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: "Toggle process group worker" })).toHaveAttribute("aria-expanded", "false");
    });

    await expandSystemGroup("worker");

    await waitFor(() => {
      expect(screen.getByText("Current repo")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open http://localhost:3000" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open http://localhost:3001" })).toBeInTheDocument();
      expect(screen.getByText(/Started /)).toBeInTheDocument();
      expect(screen.getByText(/Up /)).toBeInTheDocument();
    });
  });

  it("collapses a project group when its header is clicked", async () => {
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [
        makeSystemProcess({
          pid: 303,
          command: "node",
          fullCommand: "node /repo/app/node_modules/.bin/vite",
          cwd: "/repo/app",
          ports: [3002],
        }),
      ],
    });
    render(<ProcessPanel sessionId="s1" />);

    const groupButton = await screen.findByRole("button", { name: "Toggle process group app" });
    await waitFor(() => {
      expect(groupButton).toHaveAttribute("aria-expanded", "false");
    });
    expect(screen.queryByRole("button", { name: "Kill system process 303" })).not.toBeInTheDocument();

    fireEvent.click(groupButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Kill system process 303" })).toBeInTheDocument();
    });

    fireEvent.click(groupButton);

    expect(screen.queryByRole("button", { name: "Kill system process 303" })).not.toBeInTheDocument();
  });

  it("shows 'Dev Servers' section header when system processes exist", async () => {
    // Section header labels the system dev processes
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [makeSystemProcess()],
    });
    render(<ProcessPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText(/Dev Servers/)).toBeInTheDocument();
    });
  });

  it("shows kill button on system processes", async () => {
    // Each system process should have a Kill button with PID-based label
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [makeSystemProcess({ pid: 9999 })],
    });
    render(<ProcessPanel sessionId="s1" />);

    await expandSystemGroup();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Kill system process 9999" })).toBeInTheDocument();
    });
  });

  it("calls killSystemProcess API when system process Kill is clicked", async () => {
    // Clicking Kill on a system process should call the kill by PID API
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [makeSystemProcess({ pid: 7777 })],
    });
    render(<ProcessPanel sessionId="s1" />);

    await expandSystemGroup();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Kill system process 7777" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Kill system process 7777" }));

    await waitFor(() => {
      expect(mockKillSystemProcess).toHaveBeenCalledWith("s1", 7777);
    });
  });

  it("shows both Claude tasks and system processes when both exist", async () => {
    // Both sections should appear when we have Claude tasks and system dev servers
    const proc = makeProcess();
    resetStore({ sessionProcesses: new Map([["s1", [proc]]]) });
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [makeSystemProcess({ pid: 2222, command: "node" })],
    });
    render(<ProcessPanel sessionId="s1" />);

    // Claude task
    expect(screen.getByText("Start dev server")).toBeInTheDocument();

    // System process (wait for async fetch)
    await expandSystemGroup();
    await waitFor(() => {
      expect(screen.getByText("node")).toBeInTheDocument();
    });

    // Both section headers should be present
    expect(screen.getByText(/Claude Tasks/)).toBeInTheDocument();
    expect(screen.getByText(/Dev Servers/)).toBeInTheDocument();
  });

  it("expands system process to show full command", async () => {
    // Clicking command name should expand to show full command line
    const fullCommand = "node ./server.js --port 3000 --verbose";
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo/app" }]]),
    });
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [makeSystemProcess({ cwd: "/repo/app", fullCommand })],
    });
    render(<ProcessPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Kill system process 1234" })).toBeInTheDocument();
    });

    const killButton = screen.getByRole("button", { name: "Kill system process 1234" });
    const row = killButton.closest("[data-testid='system-process-row']");
    expect(row).not.toBeNull();
    const rowButtons = within(row as HTMLElement).getAllByRole("button");
    const expandButton = rowButtons.find((btn) => btn !== killButton);
    expect(expandButton).toBeDefined();
    fireEvent.click(expandButton!);
    expect(screen.getByText(fullCommand)).toBeInTheDocument();
  });

  it("polls for system processes on the interval", async () => {
    // The panel should call getSystemProcesses on mount
    render(<ProcessPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockGetSystemProcesses).toHaveBeenCalledWith("s1");
    });
  });
});

describe("ProcessPanel accessibility", () => {
  it("passes axe accessibility checks for empty state", async () => {
    const { axe } = await import("vitest-axe");
    resetStore();
    const { container } = render(<ProcessPanel sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with Claude processes", async () => {
    const { axe } = await import("vitest-axe");
    const procs = [
      makeProcess({ taskId: "a1", toolUseId: "t1" }),
      makeProcess({ taskId: "a2", toolUseId: "t2", status: "completed", completedAt: Date.now() }),
    ];
    resetStore({ sessionProcesses: new Map([["s1", procs]]) });
    const { container } = render(<ProcessPanel sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with system processes", async () => {
    const { axe } = await import("vitest-axe");
    mockGetSystemProcesses.mockResolvedValue({
      ok: true,
      processes: [makeSystemProcess()],
    });
    const { container } = render(<ProcessPanel sessionId="s1" />);
    // Wait for system processes to render
    await waitFor(() => {
      expect(screen.getByText("node")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
