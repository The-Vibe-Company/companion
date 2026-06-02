// Tests for the Linear Agent Session Bridge.
// Covers session creation from AgentSessionEvent, follow-up prompt handling,
// message relay from Companion sessions to Linear activities, cleanup,
// session persistence, plan relay, enriched prompts, tool results, and progress flush.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { companionBus } from "./event-bus.js";

// Mock dependencies
vi.mock("./agent-store.js", () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("./linear-agent.js", () => ({
  postActivity: vi.fn().mockResolvedValue(undefined),
  updateSessionUrls: vi.fn().mockResolvedValue(undefined),
  updateSessionPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn().mockReturnValue({ publicUrl: "" }),
}));

// Mock the OAuth connections module used by the bridge for credential resolution
// and agent lookup. Default: no connections found (falls through to legacy path).
vi.mock("./linear-oauth-connections.js", () => ({
  findOAuthConnectionByClientId: vi.fn().mockReturnValue(null),
  getOAuthConnection: vi.fn().mockReturnValue(null),
  updateOAuthConnection: vi.fn(),
}));

import * as agentStore from "./agent-store.js";
import * as linearAgent from "./linear-agent.js";
import * as linearOAuthConnections from "./linear-oauth-connections.js";
import { LinearAgentBridge, buildPrompt } from "./linear-agent-bridge.js";
import type { AgentSessionEventPayload } from "./linear-agent.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

function createMockAgentExecutor() {
  return {
    executeAgent: vi.fn(),
  } as unknown as import("./agent-executor.js").AgentExecutor;
}

function createMockWsBridge(linearMappings: Array<{ sessionId: string; linearSessionId: string }> = []) {
  return {
    injectUserMessage: vi.fn(),
    getSession: vi.fn().mockReturnValue({ id: "mock-session" }), // session exists by default
    setLinearSessionId: vi.fn(),
    getLinearSessionMappings: vi.fn().mockReturnValue(linearMappings),
  } as unknown as import("./ws-bridge.js").WsBridge;
}

function makeCreatedEvent(overrides: Partial<AgentSessionEventPayload> = {}): AgentSessionEventPayload {
  return {
    action: "created",
    type: "AgentSessionEvent",
    oauthClientId: "test-oauth-client-id",
    agentSession: {
      id: "linear-session-1",
      status: "pending",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    promptContext: "Fix the login bug on issue LIN-42",
    ...overrides,
  };
}

function makePromptedEvent(linearSessionId: string, message: string): AgentSessionEventPayload {
  return {
    action: "prompted",
    type: "AgentSessionEvent",
    oauthClientId: "test-oauth-client-id",
    agentSession: {
      id: linearSessionId,
      status: "inProgress",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    agentActivity: { body: message },
  };
}

const testAgent = {
  id: "agent-1",
  name: "Linear Bot",
  enabled: true,
  triggers: { linear: { enabled: true, oauthClientId: "test-oauth-client-id" } },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("LinearAgentBridge", () => {
  let bridge: LinearAgentBridge;
  let executor: ReturnType<typeof createMockAgentExecutor>;
  let wsBridge: ReturnType<typeof createMockWsBridge>;

  beforeEach(() => {
    vi.clearAllMocks();
    companionBus.clear();
    vi.useFakeTimers();
    // Default: getAgent returns the testAgent (needed for setupRelay credential lookup)
    vi.mocked(agentStore.getAgent).mockReturnValue(testAgent as ReturnType<typeof agentStore.getAgent>);
    executor = createMockAgentExecutor();
    wsBridge = createMockWsBridge();
    bridge = new LinearAgentBridge(executor, wsBridge);
  });

  afterEach(() => {
    bridge.shutdown();
    vi.useRealTimers();
  });

  describe("handleEvent — created action", () => {
    it("acknowledges with a thought, launches agent session, and sets up relay", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);

      await bridge.handleEvent(makeCreatedEvent());

      // Should post initial acknowledgement thought
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "thought", body: "Starting Companion session..." }),
        expect.any(Function),
      );

      // Should launch agent session with prompt context
      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-1",
        "Fix the login bug on issue LIN-42",
        { force: true, triggerType: "linear" },
      );

      // Should set external URLs
      expect(linearAgent.updateSessionUrls).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.arrayContaining([
          expect.objectContaining({ label: "Companion Session" }),
        ]),
        expect.any(Function),
      );

      // Should set up relay listeners on the event bus
      expect(companionBus.listenerCount("message:assistant")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("message:result")).toBeGreaterThan(0);

      // Should post "session started" thought
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({
          type: "thought",
          body: expect.stringContaining("Linear Bot"),
        }),
        expect.any(Function),
      );
    });

    it("injects OAuth-backed Linear API access into the spawned agent session", async () => {
      const oauthAgent = {
        ...testAgent,
        triggers: { linear: { enabled: true, oauthConnectionId: "oauth-1" } },
      };
      const oauthConn = {
        id: "oauth-1",
        name: "Enrich",
        oauthClientId: "test-oauth-client-id",
        oauthClientSecret: "secret",
        webhookSecret: "hook",
        accessToken: "lin_oauth_test",
        refreshToken: "lin_refresh_test",
        status: "connected" as const,
        createdAt: 1,
        updatedAt: 1,
      };
      vi.mocked(agentStore.listAgents).mockReturnValue([oauthAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(agentStore.getAgent).mockReturnValue(oauthAgent as ReturnType<typeof agentStore.getAgent>);
      vi.mocked(linearOAuthConnections.findOAuthConnectionByClientId).mockReturnValue(oauthConn);
      vi.mocked(linearOAuthConnections.getOAuthConnection).mockReturnValue(oauthConn);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);

      await bridge.handleEvent(makeCreatedEvent());

      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-1",
        "Fix the login bug on issue LIN-42",
        expect.objectContaining({
          force: true,
          triggerType: "linear",
          additionalEnv: {
            LINEAR_OAUTH_ACCESS_TOKEN: "lin_oauth_test",
            LINEAR_API_KEY: "lin_oauth_test",
          },
          systemPrompt: expect.stringContaining("LINEAR_OAUTH_ACCESS_TOKEN"),
        }),
      );
    });

    it("persists the linear session ID on the Companion session", async () => {
      // Verifies that setLinearSessionId is called so the mapping survives server restarts.
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);

      await bridge.handleEvent(makeCreatedEvent());

      expect(wsBridge.setLinearSessionId).toHaveBeenCalledWith("comp-sess-1", "linear-session-1");
    });

    it("logs error and returns when no agent matches the oauthClientId", async () => {
      // No agents configured — findLinearAgentByClientId returns null
      vi.mocked(agentStore.listAgents).mockReturnValue([]);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await bridge.handleEvent(makeCreatedEvent());

      // Can't post activity without credentials — just logs
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No agent configured for oauthClientId"),
      );
      expect(linearAgent.postActivity).not.toHaveBeenCalled();
      // Should not attempt to launch session
      expect(executor.executeAgent).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("posts error when agent executor returns null (no overlap)", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(agentStore.getAgent).mockReturnValue({ ...testAgent, lastSessionId: undefined } as ReturnType<typeof agentStore.getAgent>);
      vi.mocked(executor.executeAgent).mockResolvedValue(undefined as never);

      await bridge.handleEvent(makeCreatedEvent());

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({
          type: "error",
          body: expect.stringContaining("Failed to start Companion session"),
        }),
        expect.any(Function),
      );
    });

    it("posts 'agent busy' error when executor returns null due to overlap", async () => {
      // Agent is busy with a running session
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(agentStore.getAgent).mockReturnValue({ ...testAgent, lastSessionId: "running-session" } as ReturnType<typeof agentStore.getAgent>);
      vi.mocked(wsBridge.getSession).mockReturnValue({ id: "running-session" } as never);
      vi.mocked(executor.executeAgent).mockResolvedValue(undefined as never);

      await bridge.handleEvent(makeCreatedEvent());

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({
          type: "error",
          body: expect.stringContaining("currently busy"),
        }),
        expect.any(Function),
      );
    });

    it("posts error when agent executor throws", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockRejectedValue(new Error("CLI not found"));

      await bridge.handleEvent(makeCreatedEvent());

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({
          type: "error",
          body: expect.stringContaining("CLI not found"),
        }),
        expect.any(Function),
      );
    });

    it("enriches prompt with issue context when present", async () => {
      // When a payload has structured issue data, the prompt should include
      // the issue identifier, title, URL, and description before the XML.
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-2" } as never);

      await bridge.handleEvent({
        action: "created",
        type: "AgentSessionEvent",
        oauthClientId: "test-oauth-client-id",
        agentSession: {
          id: "real-linear-session",
          status: "pending",
          createdAt: "2026-03-13T16:59:47.380Z",
          updatedAt: "2026-03-13T16:59:47.380Z",
          issue: {
            id: "issue-1",
            title: "Fix bug",
            identifier: "THE-42",
            url: "https://linear.app/the/issue/THE-42",
            description: "Login fails when email has a plus sign",
          },
          comment: {
            id: "comment-1",
            body: "Please fix this ASAP",
            userId: "user-1",
            issueId: "issue-1",
          },
        },
        promptContext: "<issue identifier=\"THE-42\"><title>Fix bug</title></issue>",
        organizationId: "org-1",
      });

      // The enriched prompt should contain issue details followed by the XML
      const prompt = vi.mocked(executor.executeAgent).mock.calls[0][1] as string;
      expect(prompt).toContain("[Linear Issue THE-42] Fix bug");
      expect(prompt).toContain("URL: https://linear.app/the/issue/THE-42");
      expect(prompt).toContain("Login fails when email has a plus sign");
      expect(prompt).toContain("Please fix this ASAP");
      expect(prompt).toContain("<issue identifier=\"THE-42\">");
    });

    it("falls back to raw promptContext when no structured data is present", async () => {
      // When payload has no issue/comment/guidance, just use promptContext as-is.
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-2" } as never);

      await bridge.handleEvent(makeCreatedEvent());

      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-1",
        "Fix the login bug on issue LIN-42",
        { force: true, triggerType: "linear" },
      );
    });

    it("returns early when agentSession is missing from payload", async () => {
      // Malformed payload without agentSession
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await bridge.handleEvent({
        action: "created",
        type: "AgentSessionEvent",
      } as AgentSessionEventPayload);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No session ID found"),
        expect.any(String),
      );
      expect(executor.executeAgent).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("skips disabled agents when finding Linear agent by clientId", async () => {
      // Disabled agent has matching clientId but is disabled — should not be found
      const disabledAgent = { ...testAgent, enabled: false };
      vi.mocked(agentStore.listAgents).mockReturnValue([disabledAgent] as ReturnType<typeof agentStore.listAgents>);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await bridge.handleEvent(makeCreatedEvent());

      // Can't post activity without credentials — just logs
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No agent configured for oauthClientId"),
      );
      expect(linearAgent.postActivity).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("handleEvent — prompted action", () => {
    it("injects follow-up message into existing Companion session", async () => {
      // First, create a session to establish the mapping
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());

      vi.clearAllMocks();
      // Re-mock getAgent after clearAllMocks (needed for credential lookup in handlePrompted/setupRelay)
      vi.mocked(agentStore.getAgent).mockReturnValue(testAgent as ReturnType<typeof agentStore.getAgent>);

      // Now send a follow-up
      await bridge.handleEvent(makePromptedEvent("linear-session-1", "What's the status?"));

      // Should post acknowledgement thought
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "thought", body: "Processing follow-up..." }),
        expect.any(Function),
      );

      // Should inject message into the Companion session
      expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("comp-sess-1", "What's the status?");
    });

    it("creates new session with follow-up message when Companion session is dead", async () => {
      // Create a session first
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());
      vi.clearAllMocks();

      // Simulate the session being dead
      vi.mocked(wsBridge.getSession).mockReturnValue(undefined);
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-new" } as never);

      await bridge.handleEvent(makePromptedEvent("linear-session-1", "Follow up?"));

      // Should launch a new session with the follow-up message as prompt context
      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-1",
        "Follow up?",
        expect.objectContaining({ triggerType: "linear" }),
      );
      expect(wsBridge.injectUserMessage).not.toHaveBeenCalled();
    });

    it("creates new session with follow-up message when no mapping exists", async () => {
      // Send prompted event without a prior created event — the user's
      // message (agentActivity.body) should be passed as promptContext
      // to the new session so the message is not silently dropped.
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-new" } as never);

      await bridge.handleEvent(makePromptedEvent("unknown-session", "help"));

      // Should fall back to handleCreated with the follow-up message as prompt
      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-1",
        "help",
        expect.objectContaining({ triggerType: "linear" }),
      );
    });

    it("ignores prompted events with empty or whitespace-only messages", async () => {
      // Empty agentActivity.body should be silently skipped — no injection, no new session
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());
      vi.clearAllMocks();

      // Send a follow-up with empty body
      await bridge.handleEvent(makePromptedEvent("linear-session-1", ""));
      expect(wsBridge.injectUserMessage).not.toHaveBeenCalled();
      expect(executor.executeAgent).not.toHaveBeenCalled();

      // Send a follow-up with whitespace-only body
      await bridge.handleEvent(makePromptedEvent("linear-session-1", "   "));
      expect(wsBridge.injectUserMessage).not.toHaveBeenCalled();
      expect(executor.executeAgent).not.toHaveBeenCalled();
    });
  });

  describe("session persistence", () => {
    // Verifies that Linear↔Companion session mappings are restored from
    // persisted SessionState on construction.

    it("restores session mappings from wsBridge on construction", async () => {
      // Create a bridge with pre-existing mappings (simulates server restart)
      // listAgents must be mocked before construction for findAnyLinearAgentId
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      const wsBridgeWithMappings = createMockWsBridge([
        { sessionId: "comp-restored-1", linearSessionId: "linear-restored-1" },
      ]);
      const restoredBridge = new LinearAgentBridge(executor, wsBridgeWithMappings);

      // Now a prompted event for the restored session should use the existing mapping
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(wsBridgeWithMappings.getSession).mockReturnValue({ id: "comp-restored-1" } as never);

      await restoredBridge.handleEvent(makePromptedEvent("linear-restored-1", "Still there?"));

      // Should inject into the restored session, NOT create a new one
      expect(wsBridgeWithMappings.injectUserMessage).toHaveBeenCalledWith("comp-restored-1", "Still there?");
      expect(executor.executeAgent).not.toHaveBeenCalled();

      restoredBridge.shutdown();
    });
  });

  describe("relay — assistant message callbacks", () => {
    // These tests exercise the relay subscriptions that are registered
    // inside setupRelay via companionBus. We emit events on the bus directly
    // with synthetic BrowserIncomingMessage payloads.

    async function createSessionAndSetupRelay() {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());

      vi.clearAllMocks(); // clear previous postActivity calls
    }

    /** Emit an assistant message for the test session via the bus. */
    function emitAssistant(msg: unknown) {
      companionBus.emit("message:assistant", { sessionId: "comp-sess-1", message: msg } as any);
    }

    function emitStreamText(text: string) {
      companionBus.emit("message:stream_event", {
        sessionId: "comp-sess-1",
        message: {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
          parent_tool_use_id: null,
        },
      } as any);
    }

    /** Emit a result message for the test session via the bus. */
    async function emitResult(msg: unknown = {}) {
      companionBus.emit("message:result", { sessionId: "comp-sess-1", message: msg } as any);
      // Allow async result handler to settle
      await vi.advanceTimersByTimeAsync(0);
    }

    it("relays assistant text content as a response on turn completion", async () => {
      await createSessionAndSetupRelay();

      // Simulate an assistant message with text content
      emitAssistant({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Here is the fix for the login bug." },
          ],
        },
      });

      // Trigger turn completion — should post the accumulated text as a response
      await emitResult();

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "response", body: "Here is the fix for the login bug." }),
        expect.any(Function),
      );
    });

    it("relays streamed text as a response on turn completion", async () => {
      await createSessionAndSetupRelay();

      emitStreamText("Here is");
      emitStreamText(" the streamed reply.");

      await emitResult();

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "response", body: "Here is the streamed reply." }),
        expect.any(Function),
      );
    });

    it("does not duplicate final assistant text already seen in stream deltas", async () => {
      await createSessionAndSetupRelay();

      emitStreamText("Streamed text");
      emitAssistant({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Streamed text" }],
        },
      });

      await emitResult();

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "response", body: "Streamed text" }),
        expect.any(Function),
      );
    });

    it("relays tool use as action activities", async () => {
      await createSessionAndSetupRelay();

      // Simulate an assistant message with a tool_use content block
      emitAssistant({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file: "login.ts", line: 42 } },
          ],
        },
      });

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({
          type: "action",
          action: "Edit",
        }),
        expect.any(Function),
      );
    });

    it("relays all tool_use blocks when assistant calls multiple tools", async () => {
      await createSessionAndSetupRelay();

      // Simulate an assistant message with multiple parallel tool calls
      emitAssistant({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file: "a.ts" } },
            { type: "tool_use", name: "Read", input: { file: "b.ts" } },
            { type: "tool_use", name: "Edit", input: { file: "c.ts" } },
          ],
        },
      });

      // All three tool_use blocks should be posted as action activities
      expect(linearAgent.postActivity).toHaveBeenCalledTimes(3);
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "action", action: "Read" }),
        expect.any(Function),
      );
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "action", action: "Edit" }),
        expect.any(Function),
      );
    });

    it("accumulates text across multiple assistant messages", async () => {
      await createSessionAndSetupRelay();

      // Two assistant messages before turn completion
      emitAssistant({
        type: "assistant",
        message: { content: [{ type: "text", text: "Line 1" }] },
      });
      emitAssistant({
        type: "assistant",
        message: { content: [{ type: "text", text: "Line 2" }] },
      });

      await emitResult();

      // Should accumulate both into one response
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "response", body: "Line 1\nLine 2" }),
        expect.any(Function),
      );
    });

    it("does not post empty response when no text was accumulated", async () => {
      await createSessionAndSetupRelay();

      // Turn completes with no assistant messages
      await emitResult();

      // Should not post a response activity
      expect(linearAgent.postActivity).not.toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({ type: "response" }),
      );
    });

    it("ignores non-assistant messages in text extraction", async () => {
      await createSessionAndSetupRelay();

      // A non-assistant message type should be ignored
      emitAssistant({ type: "system", message: "hello" });

      await emitResult();

      // No response should be posted
      expect(linearAgent.postActivity).not.toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({ type: "response" }),
      );
    });

    it("handles assistant messages without message.content gracefully", async () => {
      await createSessionAndSetupRelay();

      // Assistant message with no content array
      emitAssistant({ type: "assistant", message: {} });
      emitAssistant({ type: "assistant" });

      await emitResult();

      // No text accumulated → no response
      expect(linearAgent.postActivity).not.toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({ type: "response" }),
      );
    });

    it("extracts tool use without input gracefully", async () => {
      await createSessionAndSetupRelay();

      emitAssistant({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read" }],
        },
      });

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "action", action: "Read" }),
        expect.any(Function),
      );
    });
  });

  describe("relay — plan checklist (TodoWrite)", () => {
    // Verifies that TodoWrite tool calls are intercepted and relayed as
    // Linear plan/checklist updates via updateSessionPlan().

    async function createSessionAndSetupRelay() {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());
      vi.clearAllMocks();
    }

    function emitAssistant(msg: unknown) {
      companionBus.emit("message:assistant", { sessionId: "comp-sess-1", message: msg } as any);
    }

    async function emitResult(msg: unknown = {}) {
      companionBus.emit("message:result", { sessionId: "comp-sess-1", message: msg } as any);
      await vi.advanceTimersByTimeAsync(0);
    }

    it("relays TodoWrite tool calls as Linear plan items", async () => {
      await createSessionAndSetupRelay();

      emitAssistant({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Read the codebase", status: "completed", activeForm: "Reading codebase" },
                { content: "Fix the bug", status: "in_progress", activeForm: "Fixing bug" },
                { content: "Write tests", status: "pending", activeForm: "Writing tests" },
              ],
            },
          }],
        },
      });

      expect(linearAgent.updateSessionPlan).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        [
          { content: "Read the codebase", status: "completed" },
          { content: "Fix the bug", status: "inProgress" },
          { content: "Write tests", status: "pending" },
        ],
        expect.any(Function),
      );
    });

    it("ignores TodoWrite with empty or invalid todos", async () => {
      await createSessionAndSetupRelay();

      // Empty todos array
      emitAssistant({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "TodoWrite",
            input: { todos: [] },
          }],
        },
      });

      expect(linearAgent.updateSessionPlan).not.toHaveBeenCalled();

      // No todos key
      emitAssistant({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "TodoWrite",
            input: {},
          }],
        },
      });

      expect(linearAgent.updateSessionPlan).not.toHaveBeenCalled();
    });
  });

  describe("relay — tool results", () => {
    // Verifies that tool_result content blocks are matched back to their
    // corresponding tool_use and posted as action activities with result field.

    async function createSessionAndSetupRelay() {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());
      vi.clearAllMocks();
    }

    function emitAssistant(msg: unknown) {
      companionBus.emit("message:assistant", { sessionId: "comp-sess-1", message: msg } as any);
    }

    it("posts tool result as action activity when tool_result block matches a pending tool_use", async () => {
      await createSessionAndSetupRelay();

      // First message: tool_use with an id
      emitAssistant({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_123", name: "Read", input: { file: "main.ts" } },
          ],
        },
      });

      vi.clearAllMocks();

      // Second message: tool_result matching the tool_use id
      emitAssistant({
        type: "assistant",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_123", content: "const x = 42;" },
          ],
        },
      });

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({
          type: "action",
          action: "Read",
          result: "const x = 42;",
        }),
        expect.any(Function),
      );
    });

    it("ignores tool_result blocks with no matching tool_use", async () => {
      await createSessionAndSetupRelay();

      // No preceding tool_use — just a tool_result with unknown id
      emitAssistant({
        type: "assistant",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "unknown", content: "data" },
          ],
        },
      });

      // Should not post any action result
      expect(linearAgent.postActivity).not.toHaveBeenCalled();
    });
  });

  describe("relay — intermediate progress flush", () => {
    // Verifies that accumulated text is periodically flushed as ephemeral
    // thought activities so Linear doesn't look stalled during long sessions.

    async function createSessionAndSetupRelay() {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());
      vi.clearAllMocks();
    }

    function emitAssistant(msg: unknown) {
      companionBus.emit("message:assistant", { sessionId: "comp-sess-1", message: msg } as any);
    }

    async function emitResult(msg: unknown = {}) {
      companionBus.emit("message:result", { sessionId: "comp-sess-1", message: msg } as any);
      await vi.advanceTimersByTimeAsync(0);
    }

    it("flushes accumulated text as ephemeral thought after 30 seconds", async () => {
      await createSessionAndSetupRelay();

      // Simulate text accumulation
      emitAssistant({
        type: "assistant",
        message: { content: [{ type: "text", text: "Working on the fix..." }] },
      });

      vi.clearAllMocks();

      // Advance time by 30 seconds to trigger the progress flush
      vi.advanceTimersByTime(30_000);

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({
          type: "thought",
          body: "Working on the fix...",
          ephemeral: true,
        }),
        expect.any(Function),
      );
    });

    it("does not flush when no new text has accumulated since last flush", async () => {
      await createSessionAndSetupRelay();

      // Accumulate some text
      emitAssistant({
        type: "assistant",
        message: { content: [{ type: "text", text: "First chunk" }] },
      });

      vi.clearAllMocks();

      // First flush — should post
      vi.advanceTimersByTime(30_000);
      expect(linearAgent.postActivity).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      // Second flush with no new text — should NOT post
      vi.advanceTimersByTime(30_000);
      expect(linearAgent.postActivity).not.toHaveBeenCalled();
    });

    it("resets flush state when turn completes", async () => {
      await createSessionAndSetupRelay();

      // Accumulate and flush
      emitAssistant({
        type: "assistant",
        message: { content: [{ type: "text", text: "Before completion" }] },
      });
      vi.advanceTimersByTime(30_000);
      vi.clearAllMocks();

      // Turn completes — resets pendingText and lastFlushedLength
      await emitResult();

      // After completion, the timer interval has no new text to flush
      vi.advanceTimersByTime(30_000);

      // Only the response should have been posted, no extra thought
      const thoughtCalls = vi.mocked(linearAgent.postActivity).mock.calls
        .filter(([, , content]) => (content as { type: string }).type === "thought");
      expect(thoughtCalls).toHaveLength(0);
    });
  });

  describe("multi-turn conversation", () => {
    // Verifies that after the first turn completes, the session mapping
    // and relay stay alive so follow-up prompted events work correctly.

    it("keeps session mapping alive after first turn completes", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());

      vi.clearAllMocks();
      // Re-mock getAgent after clearAllMocks (needed for credential lookup in setupRelay)
      vi.mocked(agentStore.getAgent).mockReturnValue(testAgent as ReturnType<typeof agentStore.getAgent>);

      // Trigger turn completion via event bus
      companionBus.emit("message:result", { sessionId: "comp-sess-1", message: {} } as any);
      await vi.advanceTimersByTimeAsync(0);

      // Now send a follow-up — should inject into existing session, NOT create new
      await bridge.handleEvent(makePromptedEvent("linear-session-1", "What about the tests?"));

      expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("comp-sess-1", "What about the tests?");
      // Should NOT launch a new session
      expect(executor.executeAgent).not.toHaveBeenCalled();
    });

    it("re-establishes relay on follow-up so responses are forwarded", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());

      // First turn: simulate response and turn completion via bus
      companionBus.emit("message:assistant", { sessionId: "comp-sess-1", message: { type: "assistant", message: { content: [{ type: "text", text: "First response" }] } } } as any);
      companionBus.emit("message:result", { sessionId: "comp-sess-1", message: {} } as any);
      await vi.advanceTimersByTimeAsync(0);

      vi.clearAllMocks();
      // Re-mock getAgent after clearAllMocks (needed for credential lookup in setupRelay)
      vi.mocked(agentStore.getAgent).mockReturnValue(testAgent as ReturnType<typeof agentStore.getAgent>);

      // Follow-up prompt — should re-establish relay
      await bridge.handleEvent(makePromptedEvent("linear-session-1", "Follow up"));

      // setupRelay should have registered new listeners on the bus
      expect(companionBus.listenerCount("message:assistant")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("message:result")).toBeGreaterThan(0);

      // Simulate second turn response via bus
      vi.clearAllMocks();

      companionBus.emit("message:assistant", { sessionId: "comp-sess-1", message: { type: "assistant", message: { content: [{ type: "text", text: "Second response" }] } } } as any);
      companionBus.emit("message:result", { sessionId: "comp-sess-1", message: {} } as any);
      await vi.advanceTimersByTimeAsync(0);

      // The second response should be forwarded to Linear
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        expect.any(Object),
        "linear-session-1",
        expect.objectContaining({ type: "response", body: "Second response" }),
        expect.any(Function),
      );
    });
  });

  describe("shutdown", () => {
    it("cleans up all session mappings and relay listeners", async () => {
      // Create a session
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);

      await bridge.handleEvent(makeCreatedEvent());

      // Should have listeners registered
      const beforeAssistant = companionBus.listenerCount("message:assistant");
      const beforeResult = companionBus.listenerCount("message:result");
      expect(beforeAssistant).toBeGreaterThan(0);
      expect(beforeResult).toBeGreaterThan(0);

      bridge.shutdown();

      // After shutdown, listeners should have been removed
      expect(companionBus.listenerCount("message:assistant")).toBeLessThan(beforeAssistant);
      expect(companionBus.listenerCount("message:result")).toBeLessThan(beforeResult);
    });
  });
});

describe("buildPrompt", () => {
  // Unit tests for the prompt enrichment function that prepends structured
  // issue context from the webhook payload before the XML promptContext.

  it("prepends issue details when present", () => {
    const prompt = buildPrompt({
      action: "created",
      type: "AgentSessionEvent",
      agentSession: {
        id: "s1",
        status: "pending",
        createdAt: "",
        updatedAt: "",
        issue: {
          id: "i1",
          title: "Fix login",
          identifier: "APP-42",
          url: "https://linear.app/app/issue/APP-42",
          description: "Login page crashes",
        },
      },
      promptContext: "<xml>data</xml>",
    });

    expect(prompt).toContain("[Linear Issue APP-42] Fix login");
    expect(prompt).toContain("URL: https://linear.app/app/issue/APP-42");
    expect(prompt).toContain("Login page crashes");
    expect(prompt).toContain("---");
    expect(prompt).toContain("<xml>data</xml>");
  });

  it("includes comment body when present", () => {
    const prompt = buildPrompt({
      action: "created",
      type: "AgentSessionEvent",
      agentSession: {
        id: "s1",
        status: "pending",
        createdAt: "",
        updatedAt: "",
        comment: { id: "c1", body: "Please fix ASAP", userId: "u1", issueId: "i1" },
      },
      promptContext: "",
    });

    expect(prompt).toContain("User comment:\nPlease fix ASAP");
  });

  it("includes previous comments when present", () => {
    const prompt = buildPrompt({
      action: "created",
      type: "AgentSessionEvent",
      previousComments: [
        { id: "c1", body: "First comment", userId: "u1", issueId: "i1" },
        { id: "c2", body: "Second comment", userId: "u2", issueId: "i1" },
      ],
      promptContext: "",
    });

    expect(prompt).toContain("Thread context (2 previous comments)");
    expect(prompt).toContain("- First comment");
    expect(prompt).toContain("- Second comment");
  });

  it("includes guidance when present", () => {
    const prompt = buildPrompt({
      action: "created",
      type: "AgentSessionEvent",
      guidance: "Always write tests",
      promptContext: "",
    });

    expect(prompt).toContain("Agent guidance:\nAlways write tests");
  });

  it("returns raw promptContext when no structured data is present", () => {
    const prompt = buildPrompt({
      action: "created",
      type: "AgentSessionEvent",
      promptContext: "raw prompt context",
    });

    expect(prompt).toBe("raw prompt context");
  });

  it("returns empty string when nothing is provided", () => {
    const prompt = buildPrompt({
      action: "created",
      type: "AgentSessionEvent",
    });

    expect(prompt).toBe("");
  });
});
