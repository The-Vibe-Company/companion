/**
 * Companion question broker — Pi extension source and control-plane helpers.
 *
 * Configuration, plugins, routines, triggers, Pi lifecycle, and peer collaboration are exposed by
 * the product-owned companion-control MCP. This local bridge intentionally keeps only ask_user,
 * because a human answer must resume the same Pi tool call.
 */

import {
  COMPANION_BUDGETS_BASE,
  COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS,
  COMPANION_TOOL_KIND_NAME_TABLE,
  COMPANION_TOOL_RUN_TIMEOUT_MS,
} from "@companion/contracts";

/** Return control to Pi after ten minutes without ever turning absence into approval. */
export const COMPANION_DECISION_TIMEOUT_MS = COMPANION_BUDGETS_BASE.decisionTimeoutMs;

/** Keep the filename so staging overwrites installations that still contain proposal tools. */
export const COMPANION_PERMISSION_BROKER_EXTENSION_FILE = "companion-permission-broker.ts";

/**
 * Legacy kinds remain parseable so durable cards created before this release still render and can
 * settle. Newly staged Pi extensions emit only `question`.
 */
export const COMPANION_DECISION_TITLE_PATTERN =
  /^companion:(shell|file|question|config|routine|trigger):([A-Za-z0-9._-]{1,120})$/;

export function parseCompanionDecisionTitle(title: string): {
  kind: "shell" | "file" | "question" | "config" | "routine" | "trigger";
  name: string;
} | null {
  const match = COMPANION_DECISION_TITLE_PATTERN.exec(title.trim());
  if (!match) return null;
  let kind: "shell" | "file" | "question" | "config" | "routine" | "trigger";
  switch (match[1]) {
    case "shell": kind = "shell"; break;
    case "file": kind = "file"; break;
    case "question": kind = "question"; break;
    case "config": kind = "config"; break;
    case "routine": kind = "routine"; break;
    case "trigger": kind = "trigger"; break;
    default: return null;
  }
  const name = match[2];
  if (!name) return null;
  return {
    kind,
    name,
  };
}

/** Source installed onto every Companion Box. Kept as text to avoid a Pi type dependency. */
export const COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE = `/**
 * Companion question broker — Pi extension installed on every Companion Box.
 *
 * ask_user emits an extension_ui_request and blocks until the control plane answers. Every product
 * mutation is handled asynchronously by the companion-control MCP instead.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DECISION_TIMEOUT_MS = ${COMPANION_DECISION_TIMEOUT_MS};
const TOOL_TIMEOUT_MS = ${COMPANION_TOOL_RUN_TIMEOUT_MS};
const EXEC_TOOL_TIMEOUT_MS = ${COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS};
const INTERACTIVE_TOOLS = new Set(["ask_user"]);

const TOOL_KIND_NAMES: Array<[string, Set<string>]> =
  (${JSON.stringify(COMPANION_TOOL_KIND_NAME_TABLE)} as Array<[string, string[]]>)
    .map(([kind, names]) => [kind, new Set(names)]);

function toolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function toolRunKind(name: string): string {
  const collapsed = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [kind, names] of TOOL_KIND_NAMES) {
    if (names.has(collapsed)) return kind;
  }
  const words = toolNameWords(name);
  for (const [kind, names] of TOOL_KIND_NAMES) {
    if (words.some((word) => names.has(word))) return kind;
  }
  return "tool";
}

function toolTimeoutFor(toolName: string): number {
  const kind = toolRunKind(toolName);
  return kind === "shell" || kind === "subagent" ? EXEC_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
}

const toolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function clearToolTimeouts() {
  for (const timeout of toolTimeouts.values()) clearTimeout(timeout);
  toolTimeouts.clear();
}

function startToolTimeout(toolCallId: string, toolName: string, ctx: { abort(): void }) {
  const existing = toolTimeouts.get(toolCallId);
  if (existing) clearTimeout(existing);
  toolTimeouts.set(toolCallId, setTimeout(() => {
    clearToolTimeouts();
    ctx.abort();
  }, toolTimeoutFor(toolName)));
}

function decisionTitle(name: string): string {
  return \`companion:question:\${name}\`;
}

export default function companionPermissionBroker(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (INTERACTIVE_TOOLS.has(event.toolName)) return undefined;
    startToolTimeout(event.toolCallId, event.toolName, ctx);
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const timeout = toolTimeouts.get(event.toolCallId);
    if (timeout) clearTimeout(timeout);
    toolTimeouts.delete(event.toolCallId);
    return undefined;
  });

  pi.on("turn_end", () => {
    clearToolTimeouts();
    return undefined;
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the human who owns this Companion a question and wait for their answer. Use when you need a decision, preference, missing information, or sign-off before doing something consequential.",
    parameters: Type.Object({
      question: Type.String({ description: "The question, with enough context to answer at a glance" }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = typeof params.question === "string" ? params.question.trim() : "";
      if (!question) {
        return {
          content: [{ type: "text", text: "Error: ask_user requires a question" }],
          details: { question: "", answer: null },
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: no permission UI available" }],
          details: { question, answer: null },
        };
      }
      const answer = await ctx.ui.input(
        decisionTitle("ask_user"),
        question,
        { timeout: DECISION_TIMEOUT_MS },
      );
      if (answer === undefined || !answer.trim()) {
        return {
          content: [{
            type: "text",
            text: "No user answer was received (denied, timed out, or superseded by a newer message). Do not infer approval. Choose a safe fallback, explain that you did so, or stop this turn so the newer message can run.",
          }],
          details: { question, answer: null },
        };
      }
      return {
        content: [{ type: "text", text: answer.trim() }],
        details: { question, answer: answer.trim() },
      };
    },
  });
}
`;
