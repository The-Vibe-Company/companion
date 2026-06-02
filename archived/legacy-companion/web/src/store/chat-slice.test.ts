// @vitest-environment jsdom

// vi.hoisted runs before any imports, ensuring browser globals are available when store.ts initializes.
vi.hoisted(() => {
  // jsdom does not implement matchMedia
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // Node.js 22+ native localStorage may be broken (invalid --localstorage-file).
  // Polyfill before store.ts import triggers getInitialSessionId().
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import { useStore } from "../store.js";
import type { SessionState, ChatMessage } from "../types.js";

function makeSession(id: string): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-6",
    cwd: "/test",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

// ─── Messages ───────────────────────────────────────────────────────────────

describe("Messages", () => {
  it("appendMessage: adds to session's list", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ content: "first" });
    useStore.getState().appendMessage("s1", msg);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: creates list even if session was not pre-initialized", () => {
    const msg = makeMessage({ content: "orphan" });
    useStore.getState().appendMessage("s1", msg);
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);
  });

  it("appendMessage: deduplicates by ID", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ id: "dup-1", content: "first" });
    useStore.getState().appendMessage("s1", msg);
    useStore.getState().appendMessage("s1", { ...msg, content: "duplicate" });

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: allows messages without IDs (no dedup)", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg1 = makeMessage({ id: "", content: "a" });
    const msg2 = makeMessage({ id: "", content: "b" });
    useStore.getState().appendMessage("s1", msg1);
    useStore.getState().appendMessage("s1", msg2);

    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("setMessages: replaces all messages for a session", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ content: "old" }));

    const newMessages = [
      makeMessage({ content: "new1" }),
      makeMessage({ content: "new2" }),
    ];
    useStore.getState().setMessages("s1", newMessages);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("new1");
    expect(messages[1].content).toBe("new2");
  });

  it("updateLastAssistantMessage: updates the last assistant message", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "q" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a1" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a2" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "a2-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[1].content).toBe("a1"); // first assistant unchanged
    expect(messages[2].content).toBe("a2-updated"); // last assistant updated
  });

  it("updateLastAssistantMessage: skips non-assistant messages from end", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "answer" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "followup" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "answer-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[0].content).toBe("answer-updated");
    expect(messages[1].content).toBe("followup");
  });
});

// ─── Streaming ──────────────────────────────────────────────────────────────

describe("Streaming", () => {
  it("setStreaming: sets text for a session", () => {
    useStore.getState().setStreaming("s1", "partial output");
    expect(useStore.getState().streaming.get("s1")).toBe("partial output");
  });

  it("setStreaming(null): deletes entry", () => {
    useStore.getState().setStreaming("s1", "some text");
    useStore.getState().setStreaming("s1", null);
    expect(useStore.getState().streaming.has("s1")).toBe(false);
  });

  it("setStreamingStats: sets startedAt and outputTokens", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 12345, outputTokens: 42 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(12345);
    expect(useStore.getState().streamingOutputTokens.get("s1")).toBe(42);
  });

  it("setStreamingStats: sets only provided fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(100);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });

  it("setStreamingStats(null): clears both fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100, outputTokens: 50 });
    useStore.getState().setStreamingStats("s1", null);
    expect(useStore.getState().streamingStartedAt.has("s1")).toBe(false);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });
});

describe("Prompt suggestions", () => {
  it("setPromptSuggestions: stores suggestions for a session", () => {
    useStore.getState().setPromptSuggestions("s1", ["First", "Second"]);

    expect(useStore.getState().promptSuggestions.get("s1")).toEqual([
      "First",
      "Second",
    ]);
  });

  it("setPromptSuggestions: overwrites only the targeted session", () => {
    useStore.getState().setPromptSuggestions("s1", ["Old value"]);
    useStore.getState().setPromptSuggestions("s2", ["Other session"]);
    useStore.getState().setPromptSuggestions("s1", ["New value"]);

    expect(useStore.getState().promptSuggestions.get("s1")).toEqual(["New value"]);
    expect(useStore.getState().promptSuggestions.get("s2")).toEqual(["Other session"]);
  });

  it("clearPromptSuggestions: removes one session without affecting others", () => {
    useStore.getState().setPromptSuggestions("s1", ["Clear me"]);
    useStore.getState().setPromptSuggestions("s2", ["Keep me"]);

    useStore.getState().clearPromptSuggestions("s1");

    expect(useStore.getState().promptSuggestions.has("s1")).toBe(false);
    expect(useStore.getState().promptSuggestions.get("s2")).toEqual(["Keep me"]);
  });

  it("clearPromptSuggestions: is a no-op for unknown sessions", () => {
    useStore.getState().setPromptSuggestions("s1", ["Keep me"]);

    useStore.getState().clearPromptSuggestions("missing-session");

    expect(useStore.getState().promptSuggestions.get("s1")).toEqual(["Keep me"]);
  });
});
