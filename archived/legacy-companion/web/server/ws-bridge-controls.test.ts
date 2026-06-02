import { describe, it, expect, vi } from "vitest";

// Mock settings-manager to avoid reading real settings files during tests.
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({
    aiValidationEnabled: false,
    aiValidationAutoApprove: false,
    aiValidationAutoDeny: false,
    anthropicApiKey: "",
  }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { handleSetAiValidation } from "./ws-bridge-controls.js";
import type { Session } from "./ws-bridge-types.js";
import { makeDefaultState } from "./ws-bridge-types.js";
import { SessionStateMachine } from "./session-state-machine.js";

/** Create a minimal Session object for testing handleSetAiValidation. */
function makeMockSession(overrides: Partial<Session["state"]> = {}): Session {
  const state = { ...makeDefaultState("test-session"), ...overrides };
  return {
    id: "test-session",
    backendType: "claude",
    backendAdapter: null,
    browserSockets: new Set(),
    state,
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    nextEventSeq: 1,
    eventBuffer: [],
    lastAckSeq: 0,
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    lastCliActivityTs: Date.now(),
    stateMachine: new SessionStateMachine("test-session"),
  };
}

describe("handleSetAiValidation", () => {
  it("sets aiValidationEnabled on session state", () => {
    // When aiValidationEnabled is provided, it should be written to state.
    const session = makeMockSession({ aiValidationEnabled: false });
    handleSetAiValidation(session, { aiValidationEnabled: true });
    expect(session.state.aiValidationEnabled).toBe(true);
  });

  it("sets aiValidationAutoApprove on session state", () => {
    // When aiValidationAutoApprove is provided, it should be written to state.
    const session = makeMockSession({ aiValidationAutoApprove: false });
    handleSetAiValidation(session, { aiValidationAutoApprove: true });
    expect(session.state.aiValidationAutoApprove).toBe(true);
  });

  it("sets aiValidationAutoDeny on session state", () => {
    // When aiValidationAutoDeny is provided, it should be written to state.
    const session = makeMockSession({ aiValidationAutoDeny: false });
    handleSetAiValidation(session, { aiValidationAutoDeny: true });
    expect(session.state.aiValidationAutoDeny).toBe(true);
  });

  it("does not overwrite existing state when values are undefined", () => {
    // When a field is undefined in the message, handleSetAiValidation should
    // leave the existing value in session.state untouched. This is important
    // because the browser may send only the fields that changed.
    const session = makeMockSession({
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
    });
    handleSetAiValidation(session, {});
    expect(session.state.aiValidationEnabled).toBe(true);
    expect(session.state.aiValidationAutoApprove).toBe(true);
    expect(session.state.aiValidationAutoDeny).toBe(true);
  });

  it("sets values to null when explicitly provided", () => {
    // null is a valid value (different from undefined) and should be written.
    const session = makeMockSession({
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
    });
    handleSetAiValidation(session, {
      aiValidationEnabled: null,
      aiValidationAutoApprove: null,
      aiValidationAutoDeny: null,
    });
    expect(session.state.aiValidationEnabled).toBeNull();
    expect(session.state.aiValidationAutoApprove).toBeNull();
    expect(session.state.aiValidationAutoDeny).toBeNull();
  });

  it("sets values to false when explicitly provided", () => {
    // false is a valid value and should overwrite true.
    const session = makeMockSession({
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
    });
    handleSetAiValidation(session, {
      aiValidationEnabled: false,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: false,
    });
    expect(session.state.aiValidationEnabled).toBe(false);
    expect(session.state.aiValidationAutoApprove).toBe(false);
    expect(session.state.aiValidationAutoDeny).toBe(false);
  });

  it("handles partial updates (only some fields provided)", () => {
    // When only one field is provided, only that field should change.
    const session = makeMockSession({
      aiValidationEnabled: false,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: false,
    });
    handleSetAiValidation(session, { aiValidationEnabled: true });
    expect(session.state.aiValidationEnabled).toBe(true);
    expect(session.state.aiValidationAutoApprove).toBe(false);
    expect(session.state.aiValidationAutoDeny).toBe(false);
  });
});
