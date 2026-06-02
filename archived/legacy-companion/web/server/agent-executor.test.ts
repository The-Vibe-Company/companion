import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentConfig, AgentExecution } from "./agent-types.js";
import type { SdkSessionInfo } from "./cli-launcher.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
// These must be hoisted so vi.mock() factory functions can reference them.

// We need a mock that works with `new Cron(...)`. Vitest requires a real
// class/function for `new` calls. We track all constructor calls and
// instances so tests can inspect them.
const mockCronState = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ args: unknown[] }>,
  instances: [] as Array<{ stop: ReturnType<typeof vi.fn>; nextRun: ReturnType<typeof vi.fn> }>,
}));

const MockCronClass = vi.hoisted(() => {
  return class MockCron {
    stop = vi.fn();
    nextRun = vi.fn();
    constructor(...args: unknown[]) {
      mockCronState.constructorCalls.push({ args });
      mockCronState.instances.push(this);
    }
  };
});

const mockAgentStore = vi.hoisted(() => ({
  listAgents: vi.fn<() => AgentConfig[]>().mockReturnValue([]),
  getAgent: vi.fn<(id: string) => AgentConfig | null>().mockReturnValue(null),
  updateAgent: vi.fn<(id: string, updates: Partial<AgentConfig>) => AgentConfig | null>().mockReturnValue(null),
}));

const mockEnvManager = vi.hoisted(() => ({
  getEnv: vi.fn().mockReturnValue(null),
}));

const mockSessionNames = vi.hoisted(() => ({
  setName: vi.fn(),
}));

const mockExecutionStoreInstance = vi.hoisted(() => ({
  append: vi.fn(),
  update: vi.fn(),
  list: vi.fn().mockReturnValue({ executions: [], total: 0 }),
}));

// Use a proper class so `new ExecutionStore()` works correctly.
const MockExecutionStoreClass = vi.hoisted(() => {
  return class MockExecutionStore {
    append = mockExecutionStoreInstance.append;
    update = mockExecutionStoreInstance.update;
    list = mockExecutionStoreInstance.list;
  };
});

// ─── vi.mock() calls ────────────────────────────────────────────────────────

vi.mock("croner", () => ({
  Cron: MockCronClass,
}));

vi.mock("./agent-store.js", () => mockAgentStore);

vi.mock("./env-manager.js", () => mockEnvManager);

vi.mock("./session-names.js", () => mockSessionNames);

vi.mock("./execution-store.js", () => ({
  ExecutionStore: MockExecutionStoreClass,
}));

// Mock mkdtempSync to avoid filesystem side effects in tests.
// The agent-executor uses it for "temp" cwd.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn().mockReturnValue("/tmp/companion-agent-test-abc123"),
  };
});

// ─── Import the class under test (after mocks are set up) ───────────────────

import { AgentExecutor } from "./agent-executor.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal AgentConfig with sensible defaults. Override as needed. */
function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    version: 1,
    name: "Test Agent",
    description: "A test agent",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    cwd: "/tmp/test-repo",
    prompt: "Do something useful",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** Create a mock CliLauncher with the methods AgentExecutor uses. */
function makeMockLauncher() {
  return {
    launch: vi.fn<(opts: Record<string, unknown>) => SdkSessionInfo>().mockImplementation((opts) => ({
      sessionId: "session-123",
      state: "starting" as const,
      cwd: (opts?.cwd as string) || "/tmp",
      createdAt: Date.now(),
    })),
    isAlive: vi.fn<(id: string) => boolean>().mockReturnValue(false),
    getSession: vi.fn<(id: string) => SdkSessionInfo | undefined>().mockReturnValue({
      sessionId: "session-123",
      state: "connected",
      cwd: "/tmp",
      createdAt: Date.now(),
    }),
  };
}

/** Create a mock WsBridge with the methods AgentExecutor uses. */
function makeMockWsBridge() {
  return {
    injectMcpSetServers: vi.fn(),
    injectSystemPrompt: vi.fn(),
    injectUserMessage: vi.fn(),
  };
}

/** Helper to get the most recently created Cron mock instance. */
function getLastCronInstance() {
  return mockCronState.instances[mockCronState.instances.length - 1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("AgentExecutor", () => {
  let launcher: ReturnType<typeof makeMockLauncher>;
  let wsBridge: ReturnType<typeof makeMockWsBridge>;
  let executor: AgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Cron tracking state between tests
    mockCronState.constructorCalls.length = 0;
    mockCronState.instances.length = 0;
    // Use fake timers so we can control setTimeout/setInterval in
    // waitForCLIConnection without actually waiting.
    vi.useFakeTimers();

    launcher = makeMockLauncher();
    wsBridge = makeMockWsBridge();
    executor = new AgentExecutor(launcher as never, wsBridge as never);
  });

  afterEach(() => {
    executor.destroy();
    vi.useRealTimers();
  });

  // =========================================================================
  // startAll
  // =========================================================================
  describe("startAll", () => {
    it("loads agents from disk and schedules enabled ones with schedule triggers", () => {
      // Three agents: one enabled with schedule, one disabled, one without schedule.
      // Only the enabled agent with a schedule trigger should get a Cron timer.
      const enabledAgent = makeAgent({
        id: "cron-agent",
        name: "Cron Agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "*/5 * * * *", recurring: true } },
      });
      const disabledAgent = makeAgent({
        id: "off-agent",
        name: "Off Agent",
        enabled: false,
      });
      const noScheduleAgent = makeAgent({
        id: "no-schedule",
        name: "No Schedule",
        enabled: true,
        // No schedule trigger
      });

      mockAgentStore.listAgents.mockReturnValue([enabledAgent, disabledAgent, noScheduleAgent]);

      executor.startAll();

      // listAgents should be called once
      expect(mockAgentStore.listAgents).toHaveBeenCalledOnce();
      // Cron constructor should have been called once (only for the enabled scheduled agent)
      expect(mockCronState.constructorCalls).toHaveLength(1);
      // The first argument to Cron should be the cron expression
      expect(mockCronState.constructorCalls[0].args[0]).toBe("*/5 * * * *");
    });

    it("does nothing when no agents exist", () => {
      mockAgentStore.listAgents.mockReturnValue([]);

      executor.startAll();

      expect(mockCronState.constructorCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // scheduleAgent
  // =========================================================================
  describe("scheduleAgent", () => {
    it("creates a Cron timer for recurring agents", () => {
      const agent = makeAgent({
        id: "recurring-agent",
        name: "Recurring Agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Cron should be created with the expression
      expect(mockCronState.constructorCalls).toHaveLength(1);
      expect(mockCronState.constructorCalls[0].args[0]).toBe("0 8 * * *");
      // The third argument should be the callback function (for recurring)
      expect(typeof mockCronState.constructorCalls[0].args[2]).toBe("function");
    });

    it("skips disabled agents", () => {
      const agent = makeAgent({
        id: "disabled-agent",
        enabled: false,
        triggers: { schedule: { enabled: true, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Cron should NOT be created
      expect(mockCronState.constructorCalls).toHaveLength(0);
    });

    it("skips agents with disabled schedule trigger", () => {
      const agent = makeAgent({
        id: "disabled-schedule",
        enabled: true,
        triggers: { schedule: { enabled: false, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      expect(mockCronState.constructorCalls).toHaveLength(0);
    });

    it("skips agents with no schedule expression", () => {
      const agent = makeAgent({
        id: "no-expression",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "", recurring: true } },
      });

      executor.scheduleAgent(agent);

      expect(mockCronState.constructorCalls).toHaveLength(0);
    });

    it("stops existing timer before rescheduling", () => {
      const agent = makeAgent({
        id: "reschedule-me",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });

      // Schedule once
      executor.scheduleAgent(agent);
      expect(mockCronState.instances).toHaveLength(1);
      const firstInstance = mockCronState.instances[0];

      // Schedule again -- should stop the old timer first, then create a new one
      executor.scheduleAgent(agent);
      expect(firstInstance.stop).toHaveBeenCalledTimes(1);
      expect(mockCronState.instances).toHaveLength(2);
    });

    it("creates a one-shot Cron for non-recurring agents with future date", () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const agent = makeAgent({
        id: "one-shot",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: futureDate, recurring: false } },
      });

      executor.scheduleAgent(agent);

      // Cron should be created with a Date object (one-shot)
      expect(mockCronState.constructorCalls).toHaveLength(1);
      // First arg should be a Date for one-shot
      const firstArg = mockCronState.constructorCalls[0].args[0];
      expect(firstArg).toBeInstanceOf(Date);
    });

    it("skips one-shot agent when target time is in the past", () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const agent = makeAgent({
        id: "past-one-shot",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: pastDate, recurring: false } },
      });

      executor.scheduleAgent(agent);

      // Cron should NOT be created for a past date
      expect(mockCronState.constructorCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // stopAgent
  // =========================================================================
  describe("stopAgent", () => {
    it("stops and removes the timer for a scheduled agent", () => {
      const agent = makeAgent({
        id: "stop-me",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);
      const cronInstance = getLastCronInstance();

      executor.stopAgent("stop-me");

      expect(cronInstance.stop).toHaveBeenCalledOnce();
      // After stopping, getNextRunTime should return null (timer removed)
      expect(executor.getNextRunTime("stop-me")).toBeNull();
    });

    it("does nothing when agent has no timer", () => {
      // Should not throw or have side effects
      executor.stopAgent("nonexistent-agent");
      // No Cron instances should have been created at all
      expect(mockCronState.instances).toHaveLength(0);
    });
  });

  // =========================================================================
  // executeAgent -- full flow
  // =========================================================================
  describe("executeAgent", () => {
    it("full flow: creates session, waits for CLI, sends prompt, tracks execution", async () => {
      const agent = makeAgent({
        id: "exec-agent",
        name: "Exec Agent",
        enabled: true,
        prompt: "Run the tests",
        cwd: "/my/project",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("exec-agent");

      // Should have launched a session
      expect(launcher.launch).toHaveBeenCalledOnce();
      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-sonnet-4-6",
          permissionMode: "bypassPermissions",
          cwd: "/my/project",
        }),
      );

      // Should set the session name
      expect(mockSessionNames.setName).toHaveBeenCalledWith(
        "session-123",
        expect.stringContaining("Exec Agent"),
      );

      // Should inject the user message with agent prefix
      expect(wsBridge.injectUserMessage).toHaveBeenCalledOnce();
      const sentPrompt = wsBridge.injectUserMessage.mock.calls[0][1] as string;
      expect(sentPrompt).toContain("[agent:exec-agent Exec Agent]");
      expect(sentPrompt).toContain("Run the tests");

      // Should update agent tracking (lastRunAt, totalRuns, etc.)
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("exec-agent", expect.objectContaining({
        lastRunAt: expect.any(Number),
        lastSessionId: "session-123",
        totalRuns: 1,
        consecutiveFailures: 0,
      }));

      // Should persist execution to the ExecutionStore
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const appendedExec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appendedExec.agentId).toBe("exec-agent");
      expect(appendedExec.sessionId).toBe("session-123");
      expect(appendedExec.triggerType).toBe("manual");
      expect(appendedExec.startedAt).toBeGreaterThan(0);

      // Return value should be the session info
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe("session-123");
    });

    it("skips when agent is not found", async () => {
      // getAgent returns null by default -- agent does not exist
      mockAgentStore.getAgent.mockReturnValue(null);

      const result = await executor.executeAgent("nonexistent");

      expect(result).toBeUndefined();
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it("skips when agent is disabled and force is not set", async () => {
      const agent = makeAgent({ id: "disabled", enabled: false });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("disabled");

      expect(result).toBeUndefined();
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it("runs disabled agent when force=true", async () => {
      // Even though agent.enabled is false, force=true should bypass the check
      const agent = makeAgent({ id: "disabled-force", enabled: false, prompt: "forced run" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("disabled-force", undefined, { force: true });

      expect(result).toBeDefined();
      expect(launcher.launch).toHaveBeenCalledOnce();
    });

    it("skips when previous execution is still running (overlap prevention)", async () => {
      // Simulate an agent whose previous session is still alive
      const agent = makeAgent({
        id: "overlapping",
        lastSessionId: "still-running-session",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);
      // isAlive returns true for the previous session
      launcher.isAlive.mockReturnValue(true);

      const result = await executor.executeAgent("overlapping");

      expect(result).toBeUndefined();
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it("handles errors: marks execution as failed, increments consecutiveFailures", async () => {
      const agent = makeAgent({
        id: "fail-agent",
        name: "Fail Agent",
        consecutiveFailures: 1,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // Make launch throw an error
      launcher.launch.mockImplementation(() => {
        throw new Error("CLI binary not found");
      });

      const result = await executor.executeAgent("fail-agent");

      expect(result).toBeUndefined();

      // Execution should be recorded with error
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const appendedExec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appendedExec.error).toBe("CLI binary not found");
      expect(appendedExec.completedAt).toBeGreaterThan(0);

      // consecutiveFailures should be incremented from 1 to 2
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("fail-agent", expect.objectContaining({
        consecutiveFailures: 2,
        lastRunAt: expect.any(Number),
      }));
    });

    it("auto-disables agent after MAX_CONSECUTIVE_FAILURES (5)", async () => {
      // Agent already has 4 consecutive failures -- one more triggers auto-disable
      const agent = makeAgent({
        id: "auto-disable",
        name: "Auto Disable Agent",
        consecutiveFailures: 4,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      launcher.launch.mockImplementation(() => {
        throw new Error("repeated failure");
      });

      await executor.executeAgent("auto-disable");

      // Should update agent with enabled=false and consecutiveFailures=5
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("auto-disable", expect.objectContaining({
        enabled: false,
        consecutiveFailures: 5,
      }));
    });

    it("does not auto-disable when failures are below threshold", async () => {
      // After this failure: consecutiveFailures = 3, below the threshold of 5
      const agent = makeAgent({
        id: "below-threshold",
        consecutiveFailures: 2,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      launcher.launch.mockImplementation(() => {
        throw new Error("temporary failure");
      });

      await executor.executeAgent("below-threshold");

      // Should NOT include enabled=false in the update
      const updateCall = mockAgentStore.updateAgent.mock.calls[0];
      const updates = updateCall[1] as Partial<AgentConfig>;
      expect(updates.enabled).toBeUndefined();
      expect(updates.consecutiveFailures).toBe(3);
    });

    it("replaces {{input}} in prompt with provided input", async () => {
      const agent = makeAgent({
        id: "input-agent",
        prompt: "Process this PR: {{input}}",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("input-agent", "https://github.com/org/repo/pull/42");

      const sentPrompt = wsBridge.injectUserMessage.mock.calls[0][1] as string;
      expect(sentPrompt).toContain("Process this PR: https://github.com/org/repo/pull/42");
      expect(sentPrompt).not.toContain("{{input}}");
    });

    it("strips {{input}} placeholder when no input is provided", async () => {
      const agent = makeAgent({
        id: "strip-input-agent",
        prompt: "Run task: {{input}} now",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("strip-input-agent");

      const sentPrompt = wsBridge.injectUserMessage.mock.calls[0][1] as string;
      expect(sentPrompt).toContain("Run task:  now");
      expect(sentPrompt).not.toContain("{{input}}");
    });

    it("resolves environment variables from envSlug and inline env", async () => {
      // Agent uses both an envSlug (resolved via envManager) and inline env vars.
      // The inline env should override envSlug vars if they overlap.
      const agent = makeAgent({
        id: "env-agent",
        envSlug: "prod-env",
        env: { INLINE_VAR: "inline-value" },
      });
      mockAgentStore.getAgent.mockReturnValue(agent);
      mockEnvManager.getEnv.mockReturnValue({
        name: "Production",
        slug: "prod-env",
        variables: { ENV_VAR: "env-value" },
      });

      await executor.executeAgent("env-agent");

      // launch should be called with merged env vars (envSlug + inline)
      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { ENV_VAR: "env-value", INLINE_VAR: "inline-value" },
        }),
      );
    });

    it("merges additional env vars and injects a Claude system prompt when provided", async () => {
      const agent = makeAgent({
        id: "linear-agent",
        name: "Linear Agent",
        backendType: "claude",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("linear-agent", "Handle this issue", {
        triggerType: "linear",
        additionalEnv: {
          LINEAR_OAUTH_ACCESS_TOKEN: "lin_oauth_test",
          LINEAR_API_KEY: "lin_oauth_test",
        },
        systemPrompt: "Use the Linear OAuth token for GraphQL requests.",
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            LINEAR_OAUTH_ACCESS_TOKEN: "lin_oauth_test",
            LINEAR_API_KEY: "lin_oauth_test",
          }),
        }),
      );
      expect(wsBridge.injectSystemPrompt).toHaveBeenCalledWith(
        "session-123",
        "Use the Linear OAuth token for GraphQL requests.",
      );
    });

    it("passes the extra system prompt directly to Codex launches", async () => {
      const agent = makeAgent({
        id: "linear-codex-agent",
        name: "Linear Codex Agent",
        backendType: "codex",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("linear-codex-agent", "Handle this issue", {
        triggerType: "linear",
        systemPrompt: "Codex linear context",
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "Codex linear context",
        }),
      );
      expect(wsBridge.injectSystemPrompt).not.toHaveBeenCalled();
    });

    it("uses temp directory when cwd is 'temp'", async () => {
      const agent = makeAgent({
        id: "temp-cwd-agent",
        cwd: "temp",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("temp-cwd-agent");

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/companion-agent-test-abc123",
        }),
      );
    });

    it("uses temp directory when cwd is empty", async () => {
      const agent = makeAgent({
        id: "empty-cwd-agent",
        cwd: "",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("empty-cwd-agent");

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/companion-agent-test-abc123",
        }),
      );
    });

    it("configures MCP servers when specified", async () => {
      const mcpServers = {
        myServer: { type: "stdio" as const, command: "node", args: ["server.js"] },
      };
      const agent = makeAgent({
        id: "mcp-agent",
        mcpServers,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // executeAgent has a 2s MCP_INIT_DELAY_MS setTimeout when mcpServers are set.
      // We must advance fake timers to let it resolve.
      const promise = executor.executeAgent("mcp-agent");
      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      // Should inject MCP servers before sending the prompt
      expect(wsBridge.injectMcpSetServers).toHaveBeenCalledWith("session-123", mcpServers);
      // Should still send the user message after MCP setup
      expect(wsBridge.injectUserMessage).toHaveBeenCalled();
    });

    it("does not inject MCP servers when none are specified", async () => {
      const agent = makeAgent({
        id: "no-mcp-agent",
        // No mcpServers
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("no-mcp-agent");

      expect(wsBridge.injectMcpSetServers).not.toHaveBeenCalled();
    });

    it("tags session with agentId and agentName", async () => {
      const agent = makeAgent({
        id: "tag-agent",
        name: "Tag Agent",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("tag-agent");

      // The session info object is mutated in-place to include agent metadata
      expect(result!.agentId).toBe("tag-agent");
      expect(result!.agentName).toBe("Tag Agent");
    });

    it("uses 'schedule' triggerType when specified", async () => {
      const agent = makeAgent({ id: "scheduled" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("scheduled", undefined, { triggerType: "schedule" });

      const appendedExec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appendedExec.triggerType).toBe("schedule");
    });
  });

  // =========================================================================
  // waitForCLIConnection (tested indirectly via executeAgent)
  // =========================================================================
  describe("waitForCLIConnection (via executeAgent)", () => {
    it("throws if CLI exits before connecting", async () => {
      const agent = makeAgent({ id: "exit-early" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // After launch, getSession returns "exited" state on every poll
      launcher.getSession.mockReturnValue({
        sessionId: "session-123",
        state: "exited",
        exitCode: 1,
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      const promise = executor.executeAgent("exit-early");
      // Advance timers to trigger the poll
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      // Should have failed (error path in catch block)
      expect(result).toBeUndefined();

      // Execution should have error about CLI exiting before connecting
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const exec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(exec.error).toContain("CLI process exited before connecting");
    });

    it("throws if CLI does not connect within timeout", async () => {
      const agent = makeAgent({ id: "timeout-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // getSession always returns "starting" -- never transitions to connected
      launcher.getSession.mockReturnValue({
        sessionId: "session-123",
        state: "starting",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      const promise = executor.executeAgent("timeout-agent");

      // Advance past the 30s timeout (CLI_CONNECT_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      expect(result).toBeUndefined();

      // Should have a timeout error
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const exec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(exec.error).toContain("did not connect within");
    });
  });

  // =========================================================================
  // handleSessionExited
  // =========================================================================
  describe("handleSessionExited", () => {
    it("marks execution as completed with exit code 0 (success)", async () => {
      // First, create an execution by running an agent
      const agent = makeAgent({ id: "exit-agent", name: "Exit Agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("exit-agent");

      // Now simulate the session exiting with code 0
      executor.handleSessionExited("session-123", 0);

      // executionStore.update should be called with success=true
      expect(mockExecutionStoreInstance.update).toHaveBeenCalledWith("session-123", expect.objectContaining({
        completedAt: expect.any(Number),
        success: true,
      }));

      // In-memory execution should also be updated
      const executions = executor.getExecutions("exit-agent");
      expect(executions).toHaveLength(1);
      expect(executions[0].completedAt).toBeGreaterThan(0);
      expect(executions[0].success).toBe(true);
    });

    it("marks execution as failed with non-zero exit code", async () => {
      const agent = makeAgent({ id: "fail-exit-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("fail-exit-agent");

      executor.handleSessionExited("session-123", 1);

      expect(mockExecutionStoreInstance.update).toHaveBeenCalledWith("session-123", expect.objectContaining({
        completedAt: expect.any(Number),
        success: false,
        error: "Process exited with code 1",
      }));

      const executions = executor.getExecutions("fail-exit-agent");
      expect(executions[0].success).toBe(false);
      expect(executions[0].error).toContain("Process exited with code 1");
    });

    it("treats null exit code as success (e.g. signalled/normal termination)", async () => {
      const agent = makeAgent({ id: "null-exit-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("null-exit-agent");

      executor.handleSessionExited("session-123", null);

      expect(mockExecutionStoreInstance.update).toHaveBeenCalledWith("session-123", expect.objectContaining({
        success: true,
      }));
    });

    it("does nothing for an unknown session", () => {
      // No executions have been tracked, so this should be a no-op
      executor.handleSessionExited("unknown-session-id", 0);

      expect(mockExecutionStoreInstance.update).not.toHaveBeenCalled();
    });

    it("only marks the first matching incomplete execution", async () => {
      const agent = makeAgent({ id: "multi-exec-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // Run the agent once with session-aaa
      launcher.launch.mockReturnValueOnce({
        sessionId: "session-aaa",
        state: "starting" as const,
        cwd: "/tmp",
        createdAt: Date.now(),
      });
      await executor.executeAgent("multi-exec-agent");

      // Run the agent again with session-bbb
      launcher.launch.mockReturnValueOnce({
        sessionId: "session-bbb",
        state: "starting" as const,
        cwd: "/tmp",
        createdAt: Date.now(),
      });
      // Need to reset isAlive to allow second execution
      launcher.isAlive.mockReturnValue(false);
      // Need to reset getAgent to match the updated lastSessionId
      mockAgentStore.getAgent.mockReturnValue(
        makeAgent({ id: "multi-exec-agent", lastSessionId: "session-aaa" }),
      );
      await executor.executeAgent("multi-exec-agent");

      // Exit session-aaa
      executor.handleSessionExited("session-aaa", 0);

      const executions = executor.getExecutions("multi-exec-agent");
      const aaa = executions.find((e) => e.sessionId === "session-aaa");
      const bbb = executions.find((e) => e.sessionId === "session-bbb");
      expect(aaa!.completedAt).toBeDefined();
      expect(aaa!.success).toBe(true);
      // session-bbb should still be running (no completedAt)
      expect(bbb!.completedAt).toBeUndefined();
    });
  });

  // =========================================================================
  // executeAgentManually
  // =========================================================================
  describe("executeAgentManually", () => {
    it("calls executeAgent with force=true and triggerType='manual'", async () => {
      // Even though the agent is disabled, executeAgentManually should
      // call executeAgent with force=true to bypass the enabled check.
      const agent = makeAgent({ id: "manual-agent", enabled: false });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const executeSpy = vi.spyOn(executor, "executeAgent");

      executor.executeAgentManually("manual-agent", "some input");

      // Need to advance timers to let the async execute complete
      await vi.advanceTimersByTimeAsync(100);

      expect(executeSpy).toHaveBeenCalledWith("manual-agent", "some input", {
        force: true,
        triggerType: "manual",
      });
    });
  });

  // =========================================================================
  // getExecutions
  // =========================================================================
  describe("getExecutions", () => {
    it("returns empty array for unknown agent", () => {
      const result = executor.getExecutions("nonexistent-agent");
      expect(result).toEqual([]);
    });

    it("returns executions after agent has run", async () => {
      const agent = makeAgent({ id: "tracked-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("tracked-agent");

      const executions = executor.getExecutions("tracked-agent");
      expect(executions).toHaveLength(1);
      expect(executions[0].agentId).toBe("tracked-agent");
      expect(executions[0].sessionId).toBe("session-123");
    });
  });

  // =========================================================================
  // getNextRunTime
  // =========================================================================
  describe("getNextRunTime", () => {
    it("returns null when no timer is set", () => {
      expect(executor.getNextRunTime("no-timer-agent")).toBeNull();
    });

    it("returns the next run date from the Cron timer", () => {
      const futureDate = new Date(Date.now() + 3600_000);

      const agent = makeAgent({
        id: "next-run-agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Configure the mock instance to return our future date
      const cronInstance = getLastCronInstance();
      cronInstance.nextRun.mockReturnValue(futureDate);

      const nextRun = executor.getNextRunTime("next-run-agent");
      expect(nextRun).toEqual(futureDate);
    });

    it("returns null when timer.nextRun() returns falsy", () => {
      const agent = makeAgent({
        id: "no-next-run-agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Configure the mock instance to return undefined (falsy)
      const cronInstance = getLastCronInstance();
      cronInstance.nextRun.mockReturnValue(undefined);

      expect(executor.getNextRunTime("no-next-run-agent")).toBeNull();
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================
  describe("destroy", () => {
    it("stops all active timers and clears state", () => {
      // Schedule two agents to create two Cron instances
      const agent1 = makeAgent({
        id: "destroy-agent-1",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });
      const agent2 = makeAgent({
        id: "destroy-agent-2",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "30 * * * *", recurring: true } },
      });

      executor.scheduleAgent(agent1);
      executor.scheduleAgent(agent2);

      expect(mockCronState.instances).toHaveLength(2);
      const instance1 = mockCronState.instances[0];
      const instance2 = mockCronState.instances[1];

      executor.destroy();

      // stop() should be called once on each timer instance
      expect(instance1.stop).toHaveBeenCalledOnce();
      expect(instance2.stop).toHaveBeenCalledOnce();

      // After destroy, getNextRunTime should return null for both
      expect(executor.getNextRunTime("destroy-agent-1")).toBeNull();
      expect(executor.getNextRunTime("destroy-agent-2")).toBeNull();

      // After destroy, getExecutions should return empty (executions map is cleared)
      expect(executor.getExecutions("destroy-agent-1")).toEqual([]);
    });
  });

  // =========================================================================
  // permissionMode warning
  // =========================================================================
  describe("permissionMode warning", () => {
    it("logs warning when agent permissionMode differs from bypassPermissions", async () => {
      // An agent with permissionMode="plan" should trigger a console.warn
      // because agent sessions always run with bypassPermissions.
      const agent = makeAgent({
        id: "plan-mode-agent",
        name: "Plan Mode Agent",
        permissionMode: "plan",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await executor.executeAgent("plan-mode-agent");

      // The warning should mention the agent's actual permissionMode
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('permissionMode="plan"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("bypassPermissions"),
      );

      warnSpy.mockRestore();
    });

    it("does not warn when permissionMode is bypassPermissions", async () => {
      const agent = makeAgent({
        id: "bypass-mode-agent",
        permissionMode: "bypassPermissions",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await executor.executeAgent("bypass-mode-agent");

      // No warning about permissionMode should appear
      const permWarns = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("permissionMode"),
      );
      expect(permWarns).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("does not warn when permissionMode is not set (empty string)", async () => {
      // An empty string is falsy, so the guard `agent.permissionMode &&` fails
      const agent = makeAgent({
        id: "no-mode-agent",
        permissionMode: "",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await executor.executeAgent("no-mode-agent");

      // No warning about permissionMode should appear
      const permWarns = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("permissionMode"),
      );
      expect(permWarns).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // listAllExecutions (delegates to ExecutionStore)
  // =========================================================================
  describe("listAllExecutions", () => {
    it("delegates to executionStore.list()", () => {
      const mockResult = {
        executions: [{ sessionId: "s1", agentId: "a1", triggerType: "manual" as const, startedAt: 100 }],
        total: 1,
      };
      mockExecutionStoreInstance.list.mockReturnValue(mockResult);

      const result = executor.listAllExecutions({ agentId: "a1", limit: 10 });

      expect(mockExecutionStoreInstance.list).toHaveBeenCalledWith({ agentId: "a1", limit: 10 });
      expect(result).toEqual(mockResult);
    });
  });
});
