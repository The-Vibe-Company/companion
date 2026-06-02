// @vitest-environment jsdom

// jsdom does not implement scrollIntoView; polyfill it before any React rendering
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage } from "../types.js";

const { getClaudeSessionHistoryMock } = vi.hoisted(() => ({
  getClaudeSessionHistoryMock: vi.fn(),
}));

// Mock react-markdown to avoid ESM issues in tests
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

vi.mock("../api.js", () => ({
  api: {
    getClaudeSessionHistory: getClaudeSessionHistoryMock,
  },
}));

// Build a mock for the store that returns configurable values per session
const mockStoreValues: Record<string, unknown> = {};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      messages: mockStoreValues.messages ?? new Map(),
      streaming: mockStoreValues.streaming ?? new Map(),
      streamingStartedAt: mockStoreValues.streamingStartedAt ?? new Map(),
      streamingOutputTokens: mockStoreValues.streamingOutputTokens ?? new Map(),
      sessionStatus: mockStoreValues.sessionStatus ?? new Map(),
      toolProgress: mockStoreValues.toolProgress ?? new Map(),
      toolActivity: mockStoreValues.toolActivity ?? new Map(),
      chatTabReentryTickBySession:
        mockStoreValues.chatTabReentryTickBySession ?? new Map(),
      sdkSessions: mockStoreValues.sdkSessions ?? [],
    };
    return selector(state);
  },
}));

import { MessageFeed } from "./MessageFeed.js";

function makeMessage(
  overrides: Partial<ChatMessage> & { role: ChatMessage["role"] },
): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function setStoreMessages(sessionId: string, msgs: ChatMessage[]) {
  const map = new Map();
  map.set(sessionId, msgs);
  mockStoreValues.messages = map;
}

function setStoreStreaming(sessionId: string, text: string | undefined) {
  const map = new Map();
  if (text !== undefined) map.set(sessionId, text);
  mockStoreValues.streaming = map;
}

function setStoreStatus(sessionId: string, status: string | null) {
  const statusMap = new Map();
  if (status) statusMap.set(sessionId, status);
  mockStoreValues.sessionStatus = statusMap;
}

function setStoreStreamingStartedAt(
  sessionId: string,
  startedAt: number | undefined,
) {
  const map = new Map();
  if (startedAt !== undefined) map.set(sessionId, startedAt);
  mockStoreValues.streamingStartedAt = map;
}

function setStoreStreamingOutputTokens(
  sessionId: string,
  tokens: number | undefined,
) {
  const map = new Map();
  if (tokens !== undefined) map.set(sessionId, tokens);
  mockStoreValues.streamingOutputTokens = map;
}

function setSdkSessions(sessions: Array<Record<string, unknown>>) {
  mockStoreValues.sdkSessions = sessions;
}

function resetStore() {
  mockStoreValues.messages = new Map();
  mockStoreValues.streaming = new Map();
  mockStoreValues.streamingStartedAt = new Map();
  mockStoreValues.streamingOutputTokens = new Map();
  mockStoreValues.sessionStatus = new Map();
  mockStoreValues.toolProgress = new Map();
  mockStoreValues.toolActivity = new Map();
  mockStoreValues.chatTabReentryTickBySession = new Map();
  mockStoreValues.sdkSessions = [];
}

beforeEach(() => {
  resetStore();
  getClaudeSessionHistoryMock.mockReset();
});

// ─── Pure functions tested through component output ──────────────────────────
// Since getToolOnlyName, extractToolItems, groupToolMessages, groupMessages
// are not exported, we test them through the component's rendered output.
// (formatElapsed and formatTokenCount are now in utils/format.ts with their own tests.)

// ─── formatElapsed (tested via generation stats bar) ─────────────────────────

describe("MessageFeed - formatElapsed via stats bar", () => {
  it("formats seconds only (e.g. '5s') for short durations", () => {
    const sid = "test-elapsed-secs";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    // Set startedAt to 5 seconds ago
    setStoreStreamingStartedAt(sid, Date.now() - 5000);

    render(<MessageFeed sessionId={sid} />);

    // Should show "5s" (or close) in the stats bar
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
  });

  it("formats minutes and seconds (e.g. '2m 30s') for longer durations", () => {
    const sid = "test-elapsed-mins";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 150_000); // 2m 30s ago

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText(/^\d+m \d+s$/)).toBeTruthy();
  });
});

// ─── formatTokens (tested via generation stats bar) ──────────────────────────

describe("MessageFeed - formatTokens via stats bar", () => {
  it("formats token count with 'k' suffix for values >= 1000", () => {
    const sid = "test-tokens-k";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 3000);
    setStoreStreamingOutputTokens(sid, 1500);

    render(<MessageFeed sessionId={sid} />);

    // Should display token count formatted as "1.5k"
    expect(screen.getByText(/1\.5k/)).toBeTruthy();
  });

  it("formats token count as plain number for values < 1000", () => {
    const sid = "test-tokens-plain";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 3000);
    setStoreStreamingOutputTokens(sid, 500);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText(/500/)).toBeTruthy();
  });
});

// ─── Empty state ─────────────────────────────────────────────────────────────

describe("MessageFeed - empty state", () => {
  it("shows empty state when no messages and no streaming", () => {
    const sid = "test-empty";
    setStoreMessages(sid, []);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Start a conversation")).toBeTruthy();
    expect(screen.getByText(/Send a message to begin/)).toBeTruthy();
  });

  it("does not show empty state when there are messages", () => {
    const sid = "test-not-empty";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "Hello" })]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
  });
});

// ─── Message rendering ───────────────────────────────────────────────────────

describe("MessageFeed - message rendering", () => {
  it("renders user and assistant messages", () => {
    const sid = "test-render-msgs";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "What is 2+2?" }),
      makeMessage({ id: "a1", role: "assistant", content: "The answer is 4." }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("What is 2+2?")).toBeTruthy();
    // The assistant message goes through the mocked Markdown component
    expect(screen.getByText("The answer is 4.")).toBeTruthy();
  });

  it("renders system messages in the feed", () => {
    const sid = "test-system-msg";
    setStoreMessages(sid, [
      makeMessage({ id: "s1", role: "system", content: "Session restored" }),
      makeMessage({ id: "u1", role: "user", content: "Continue" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Session restored")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });
});

// ─── Streaming assistant bubble ──────────────────────────────────────────────

describe("MessageFeed - streaming assistant bubble", () => {
  it("renders streaming assistant text in the normal message path with cursor", () => {
    const sid = "test-streaming";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Hello" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "I am currently thinking about",
        isStreaming: true,
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("I am currently thinking about")).toBeTruthy();
    expect(screen.getByTestId("assistant-stream-cursor")).toBeTruthy();
  });

  it("does not render a streaming cursor for non-streaming assistant messages", () => {
    const sid = "test-no-stream";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Hello" }),
      makeMessage({ id: "a1", role: "assistant", content: "Done" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("assistant-stream-cursor")).toBeNull();
  });
});

// ─── Generation stats bar ────────────────────────────────────────────────────

describe("MessageFeed - generation stats bar", () => {
  it("renders stats bar when session is running", () => {
    const sid = "test-stats";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 10_000);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Generating")).toBeTruthy();
  });

  it("does not render stats bar when session is idle", () => {
    const sid = "test-idle";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "idle");

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Generating")).toBeNull();
  });

  it("shows output tokens in stats bar when available", () => {
    const sid = "test-tokens-stats";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreStreamingOutputTokens(sid, 2500);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Generating")).toBeTruthy();
    // Should show "2.5k" token count
    expect(screen.getByText(/2\.5k/)).toBeTruthy();
  });
});

describe("MessageFeed - lazy resume transcript", () => {
  it("loads previous transcript pages for resumed Claude sessions", async () => {
    const sid = "test-resume";
    setStoreMessages(sid, []);
    setSdkSessions([
      {
        sessionId: sid,
        state: "connected",
        cwd: "/Users/test/repo",
        createdAt: Date.now(),
        backendType: "claude",
        resumeSessionAt: "prior-session-123",
        forkSession: true,
      },
    ]);
    getClaudeSessionHistoryMock.mockResolvedValueOnce({
      sourceFile: "/Users/test/.claude/projects/repo/prior-session-123.jsonl",
      nextCursor: 2,
      hasMore: false,
      totalMessages: 2,
      messages: [
        {
          id: "resume-prior-session-123-user-u1",
          role: "user",
          content: "Earlier question",
          timestamp: 1,
        },
        {
          id: "resume-prior-session-123-assistant-a1",
          role: "assistant",
          content: "Earlier answer",
          timestamp: 2,
        },
      ],
    });

    render(<MessageFeed sessionId={sid} />);

    fireEvent.click(
      screen.getByRole("button", { name: /load previous history/i }),
    );

    await waitFor(() => {
      expect(getClaudeSessionHistoryMock).toHaveBeenCalledWith(
        "prior-session-123",
        {
          cursor: 0,
          limit: 40,
        },
      );
    });
    expect(await screen.findByText("Earlier question")).toBeTruthy();
    expect(await screen.findByText("Earlier answer")).toBeTruthy();
  });

  it("shows inline resume banner for active chats and updates loaded transcript status", async () => {
    const sid = "test-resume-inline";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Continue from here" }),
    ]);
    setSdkSessions([
      {
        sessionId: sid,
        state: "connected",
        cwd: "/Users/test/repo",
        createdAt: Date.now(),
        backendType: "claude",
        resumeSessionAt: "prior-inline-456",
        forkSession: true,
      },
    ]);
    getClaudeSessionHistoryMock.mockResolvedValueOnce({
      sourceFile: "/Users/test/.claude/projects/repo/prior-inline-456.jsonl",
      nextCursor: 1,
      hasMore: false,
      totalMessages: 1,
      messages: [
        {
          id: "resume-prior-inline-456-assistant-a1",
          role: "assistant",
          content: "Loaded from previous thread",
          timestamp: 2,
        },
      ],
    });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Forked from existing Claude thread")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /load previous history/i }),
    );

    await waitFor(() => {
      expect(getClaudeSessionHistoryMock).toHaveBeenCalledWith(
        "prior-inline-456",
        {
          cursor: 0,
          limit: 40,
        },
      );
    });

    expect(
      await screen.findByText("Loaded all available prior transcript"),
    ).toBeTruthy();
  });
});

// ─── Compacting context indicator ─────────────────────────────────────────────

describe("MessageFeed - compacting indicator", () => {
  it("renders compacting spinner when session status is 'compacting'", () => {
    const sid = "test-compacting";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "compacting");

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Compacting context...")).toBeTruthy();
  });

  it("does not render compacting spinner when session is running", () => {
    const sid = "test-not-compacting";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 3000);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Compacting context...")).toBeNull();
  });

  it("does not render compacting spinner when session is idle", () => {
    const sid = "test-idle-no-compact";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "idle");

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Compacting context...")).toBeNull();
  });
});

describe("MessageFeed - tool progress indicator", () => {
  it("renders tool progress while tools are running", () => {
    const sid = "test-tool-progress";
    setStoreMessages(sid, [
      makeMessage({ role: "user", content: "run checks" }),
    ]);
    const progressBySession = new Map();
    progressBySession.set(
      sid,
      new Map([
        ["bash-1", { toolName: "Bash", elapsedSeconds: 7 }],
        ["read-1", { toolName: "Read", elapsedSeconds: 2 }],
      ]),
    );
    mockStoreValues.toolProgress = progressBySession;

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.getByText("7s")).toBeTruthy();
    expect(screen.getByText("2s")).toBeTruthy();
  });
});

// ─── getToolOnlyName behavior (tested via grouping) ──────────────────────────

describe("MessageFeed - tool-only message detection", () => {
  it("groups consecutive same-tool assistant messages", () => {
    const sid = "test-tool-group";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "Read",
            input: { file_path: "/a.ts" },
          },
        ],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "Read",
            input: { file_path: "/b.ts" },
          },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // When grouped at message level, both should appear under a single "Read File" group
    // with a count badge showing "2"
    expect(screen.getByText("2")).toBeTruthy();
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(1);
  });

  it("does not group different tool types across messages", () => {
    const sid = "test-no-tool-group";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "Read",
            input: { file_path: "/a.ts" },
          },
        ],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
  });

  it("does not treat assistant messages with text as tool-only", () => {
    const sid = "test-mixed-msg";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "text", text: "Let me check something" },
          {
            type: "tool_use",
            id: "tu-1",
            name: "Read",
            input: { file_path: "/a.ts" },
          },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Should render as a regular message, not grouped
    expect(screen.getByText("Let me check something")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();
  });
});

// ─── groupMessages with subagent nesting ─────────────────────────────────────

describe("MessageFeed - subagent grouping", () => {
  it("nests child messages under Task tool_use entries", () => {
    const sid = "test-subagent";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: {
              description: "Research the problem",
              subagent_type: "researcher",
            },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "Found the answer",
        parentToolUseId: "task-1",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // The description appears in both the tool preview and the subagent container label
    expect(
      screen.getAllByText("Research the problem").length,
    ).toBeGreaterThanOrEqual(1);
    // The agent type badge should be shown
    expect(screen.getByText("researcher")).toBeTruthy();
  });

  it("renders Codex subagent metadata badges (status + receiver count)", () => {
    const sid = "test-codex-subagent-meta";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-cx-1",
            name: "Task",
            input: {
              description: "Investigate auth edge-cases",
              subagent_type: "spawn_agent",
              codex_status: "completed",
              receiver_thread_ids: ["thr_sub_1", "thr_sub_2"],
            },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "Done",
        parentToolUseId: "task-cx-1",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("2 agents")).toBeTruthy();
  });

  it("does not render a receiver badge when receiver list is empty", () => {
    const sid = "test-codex-empty-receivers";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-cx-empty",
            name: "Task",
            input: {
              description: "Validate edge case",
              subagent_type: "spawn_agent",
              codex_status: "running",
              receiver_thread_ids: [],
            },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "Working",
        parentToolUseId: "task-cx-empty",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);
    expect(screen.queryByText("0 agents")).toBeNull();
  });

  it("normalizes Codex status labels and shows participant details when expanded", () => {
    const sid = "test-codex-subagent-details";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-cx-2",
            name: "Task",
            input: {
              description: "Parallelize lint fixes",
              subagent_type: "spawn_agent",
              codex_status: "inProgress",
              sender_thread_id: "thr_main",
              receiver_thread_ids: ["thr_sub_1", "thr_sub_2"],
            },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "Working",
        parentToolUseId: "task-cx-2",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /spawn_agent/i }));

    // After expanding, participant details are shown inline
    expect(screen.getByText(/sender: thr_main/)).toBeTruthy();
    expect(screen.getByText("thr_sub_1")).toBeTruthy();
    expect(screen.getByText("thr_sub_2")).toBeTruthy();
  });
});
