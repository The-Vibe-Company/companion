import { Cron } from "croner";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentConfig, AgentExecution } from "./agent-types.js";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import * as agentStore from "./agent-store.js";
import * as envManager from "./env-manager.js";
import * as sessionNames from "./session-names.js";
import { ExecutionStore } from "./execution-store.js";

/** Max consecutive failures before auto-disabling an agent */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Max time to wait for CLI to connect (ms) */
const CLI_CONNECT_TIMEOUT_MS = 30_000;
/** Poll interval when waiting for CLI connection */
const CLI_CONNECT_POLL_MS = 500;

export interface ExecuteAgentOptions {
  force?: boolean;
  triggerType?: "manual" | "webhook" | "schedule" | "linear";
  additionalEnv?: Record<string, string>;
  systemPrompt?: string;
}

export class AgentExecutor {
  private timers = new Map<string, Cron>();
  private launcher: CliLauncher;
  private wsBridge: WsBridge;
  /** In-memory execution history (last N per agent) */
  private executions = new Map<string, AgentExecution[]>();
  private static readonly MAX_EXECUTIONS_PER_AGENT = 50;
  /** Persistent execution store (JSONL on disk) */
  private executionStore = new ExecutionStore();

  constructor(launcher: CliLauncher, wsBridge: WsBridge) {
    this.launcher = launcher;
    this.wsBridge = wsBridge;
  }

  /** Start all enabled agents with schedule triggers from disk. Called once at server startup. */
  startAll(): void {
    const agents = agentStore.listAgents();
    let started = 0;
    for (const agent of agents) {
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        this.scheduleAgent(agent);
        started++;
      }
    }
    if (started > 0) {
      console.log(`[agent-executor] Started ${started} scheduled agent(s)`);
    }
  }

  /** Schedule (or reschedule) an agent's cron trigger. */
  scheduleAgent(agent: AgentConfig): void {
    this.stopAgent(agent.id);

    const schedule = agent.triggers?.schedule;
    if (!agent.enabled || !schedule?.enabled || !schedule.expression) return;

    try {
      if (schedule.recurring) {
        const cronTask = new Cron(schedule.expression, {}, () => {
          this.executeAgent(agent.id, undefined, { triggerType: "schedule" }).catch((err) => {
            console.error(`[agent-executor] Unhandled error in agent "${agent.name}":`, err);
          });
        });
        this.timers.set(agent.id, cronTask);
        console.log(`[agent-executor] Scheduled "${agent.name}" with cron "${schedule.expression}"`);
      } else {
        // One-shot: schedule for the specified datetime
        const targetTime = new Date(schedule.expression);
        if (targetTime.getTime() > Date.now()) {
          const cronTask = new Cron(targetTime, () => {
            this.executeAgent(agent.id, undefined, { triggerType: "schedule" })
              .then(() => {
                // Auto-disable schedule after one-shot execution
                const current = agentStore.getAgent(agent.id);
                if (current?.triggers?.schedule) {
                  agentStore.updateAgent(agent.id, {
                    triggers: {
                      ...current.triggers,
                      schedule: { ...current.triggers.schedule, enabled: false },
                    },
                  });
                }
                this.timers.delete(agent.id);
              })
              .catch((err) => {
                console.error(`[agent-executor] Unhandled error in one-shot agent "${agent.name}":`, err);
              });
          });
          this.timers.set(agent.id, cronTask);
          console.log(`[agent-executor] Scheduled one-shot "${agent.name}" at ${targetTime.toISOString()}`);
        } else {
          console.log(`[agent-executor] Skipping one-shot "${agent.name}" — target time is in the past`);
        }
      }
    } catch (err) {
      console.error(`[agent-executor] Failed to schedule "${agent.name}":`, err);
    }
  }

  /** Stop an agent's cron timer. */
  stopAgent(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) {
      timer.stop();
      this.timers.delete(agentId);
    }
  }

  /** Execute an agent: create a session, configure MCP, send the prompt, track the result. */
  async executeAgent(
    agentId: string,
    input?: string,
    opts?: ExecuteAgentOptions,
  ): Promise<SdkSessionInfo | undefined> {
    const agent = agentStore.getAgent(agentId);
    if (!agent) return;
    if (!agent.enabled && !opts?.force) return;

    // Overlap prevention: skip if previous execution is still running (unless forced)
    if (!opts?.force && agent.lastSessionId && this.launcher.isAlive(agent.lastSessionId)) {
      console.log(`[agent-executor] Skipping "${agent.name}" — previous execution still running (${agent.lastSessionId})`);
      return;
    }

    const triggerType = opts?.triggerType || "manual";
    console.log(`[agent-executor] Executing agent "${agent.name}" (${agentId}) via ${triggerType}`);

    const execution: AgentExecution = {
      sessionId: "",
      agentId,
      triggerType,
      startedAt: Date.now(),
    };

    try {
      // Resolve environment variables
      let envVars: Record<string, string> | undefined;
      if (agent.envSlug) {
        const env = envManager.getEnv(agent.envSlug);
        if (env) envVars = { ...env.variables };
      }
      if (agent.env) {
        envVars = { ...envVars, ...agent.env };
      }
      if (opts?.additionalEnv) {
        envVars = { ...envVars, ...opts.additionalEnv };
      }

      // Resolve working directory
      let cwd = agent.cwd;
      if (cwd === "temp" || !cwd) {
        cwd = mkdtempSync(join(tmpdir(), `companion-agent-${agent.id}-`));
      }

      // Launch the session via CliLauncher.
      // Agents always run with full permissions — no interactive prompts.
      // For Claude Code this sets --permission-mode bypassPermissions;
      // for Codex, approvalPolicy is already hardcoded to "never".
      if (agent.permissionMode && agent.permissionMode !== "bypassPermissions") {
        console.warn(
          `[agent-executor] Agent "${agent.name}" has permissionMode="${agent.permissionMode}" ` +
          `but agent sessions always run with bypassPermissions`,
        );
      }
      const sessionInfo = this.launcher.launch({
        model: agent.model,
        permissionMode: "bypassPermissions",
        cwd,
        env: envVars,
        allowedTools: agent.allowedTools,
        backendType: agent.backendType,
        codexInternetAccess: agent.backendType === "codex" ? (agent.codexInternetAccess ?? true) : undefined,
        codexSandbox: agent.backendType === "codex"
          ? (agent.permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write")
          : undefined,
        systemPrompt: agent.backendType === "codex" ? opts?.systemPrompt : undefined,
      });

      execution.sessionId = sessionInfo.sessionId;

      // Tag the session as agent-originated
      sessionInfo.agentId = agentId;
      sessionInfo.agentName = agent.name;

      // Set the session name
      const runLabel = `🤖 ${agent.name}`;
      sessionNames.setName(sessionInfo.sessionId, runLabel);

      // Wait for CLI to connect
      await this.waitForCLIConnection(sessionInfo.sessionId);

      // Configure MCP servers if specified
      if (agent.mcpServers && Object.keys(agent.mcpServers).length > 0) {
        this.wsBridge.injectMcpSetServers(sessionInfo.sessionId, agent.mcpServers);
        // MCP servers need time to initialize before the CLI processes the prompt.
        // The CLI handles MCP setup asynchronously; this delay ensures servers are
        // ready. A proper health-check mechanism would be better long-term, but the
        // CLI doesn't expose an MCP-ready signal yet.
        const MCP_INIT_DELAY_MS = 2000;
        await new Promise((r) => setTimeout(r, MCP_INIT_DELAY_MS));
      }

      if (opts?.systemPrompt && agent.backendType === "claude") {
        this.wsBridge.injectSystemPrompt(sessionInfo.sessionId, opts.systemPrompt);
      }

      // Resolve prompt: replace {{input}} placeholder with trigger input
      let resolvedPrompt = agent.prompt;
      if (input !== undefined) {
        resolvedPrompt = resolvedPrompt.replace(/\{\{input\}\}/g, input);
      } else {
        resolvedPrompt = resolvedPrompt.replace(/\{\{input\}\}/g, "");
      }

      // Send the prompt with agent prefix for traceability
      const fullPrompt = `[agent:${agent.id} ${agent.name}]\n\n${resolvedPrompt}`;
      this.wsBridge.injectUserMessage(sessionInfo.sessionId, fullPrompt);

      // Update agent tracking
      agentStore.updateAgent(agentId, {
        lastRunAt: Date.now(),
        lastSessionId: sessionInfo.sessionId,
        totalRuns: agent.totalRuns + 1,
        consecutiveFailures: 0,
      });

      // Execution is now "running" — completedAt/success will be set
      // when the CLI process exits via handleSessionExited().
      this.addExecution(agentId, execution);

      return sessionInfo;
    } catch (err) {
      console.error(`[agent-executor] Agent "${agent.name}" failed:`, err);
      execution.error = err instanceof Error ? err.message : String(err);
      execution.completedAt = Date.now();
      this.addExecution(agentId, execution);

      const failures = agent.consecutiveFailures + 1;
      const updates: Partial<AgentConfig> = {
        consecutiveFailures: failures,
        lastRunAt: Date.now(),
      };

      // Auto-disable after too many failures
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        updates.enabled = false;
        this.stopAgent(agentId);
        console.warn(`[agent-executor] Agent "${agent.name}" disabled after ${failures} consecutive failures`);
      }

      agentStore.updateAgent(agentId, updates);
      return undefined;
    }
  }

  /** Manual trigger (run now regardless of schedule, bypasses enabled check). */
  executeAgentManually(agentId: string, input?: string): void {
    this.executeAgent(agentId, input, { force: true, triggerType: "manual" }).catch((err) => {
      console.error(`[agent-executor] Manual execution of agent "${agentId}" failed:`, err);
    });
  }

  /** Wait for CLI to be connected (poll up to timeout). */
  private async waitForCLIConnection(sessionId: string): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < CLI_CONNECT_TIMEOUT_MS) {
      const info = this.launcher.getSession(sessionId);
      if (info && (info.state === "connected" || info.state === "running")) {
        return;
      }
      if (info?.state === "exited") {
        throw new Error(`CLI process exited before connecting (exit code: ${info.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, CLI_CONNECT_POLL_MS));
    }

    throw new Error(`CLI process did not connect within ${CLI_CONNECT_TIMEOUT_MS / 1000}s`);
  }

  /** Get next run time for an agent. */
  getNextRunTime(agentId: string): Date | null {
    const timer = this.timers.get(agentId);
    if (!timer) return null;
    return timer.nextRun() || null;
  }

  /** Get recent executions for an agent. */
  getExecutions(agentId: string): AgentExecution[] {
    return this.executions.get(agentId) || [];
  }

  private addExecution(agentId: string, execution: AgentExecution): void {
    if (!this.executions.has(agentId)) {
      this.executions.set(agentId, []);
    }
    const list = this.executions.get(agentId)!;
    list.push(execution);
    if (list.length > AgentExecutor.MAX_EXECUTIONS_PER_AGENT) {
      list.splice(0, list.length - AgentExecutor.MAX_EXECUTIONS_PER_AGENT);
    }
    // Persist to disk
    this.executionStore.append(execution);
  }

  /** Query executions across all agents (for Runs view). */
  listAllExecutions(opts?: { agentId?: string; triggerType?: string; status?: "running" | "success" | "error"; limit?: number; offset?: number }) {
    return this.executionStore.list(opts);
  }

  /** Handle session exit: mark the corresponding execution as completed. */
  handleSessionExited(sessionId: string, exitCode: number | null): void {
    for (const [, execs] of this.executions) {
      const exec = execs.find((e) => e.sessionId === sessionId && !e.completedAt);
      if (exec) {
        exec.completedAt = Date.now();
        exec.success = exitCode === 0 || exitCode === null;
        if (exitCode && exitCode !== 0) {
          exec.error = exec.error || `Process exited with code ${exitCode}`;
        }
        this.executionStore.update(sessionId, {
          completedAt: exec.completedAt,
          success: exec.success,
          error: exec.error,
        });
        break;
      }
    }
  }

  /** Stop all timers (for graceful shutdown). */
  destroy(): void {
    for (const timer of this.timers.values()) {
      timer.stop();
    }
    this.timers.clear();
    this.executions.clear();
  }
}
