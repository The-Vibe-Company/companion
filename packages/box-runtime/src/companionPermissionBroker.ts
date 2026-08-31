/**
 * Companion permission broker — Pi extension source and control-plane helpers.
 *
 * The extension itself runs inside the Box under Pi. The control plane only stages its source onto
 * `$PI_CODING_AGENT_DIR/extensions/` and projects the `extension_ui_request` events it emits.
 */

import {
  COMPANION_BUDGETS_BASE,
  COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS,
  COMPANION_CONFIG_PROPOSAL_MAX_IDS,
  COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS,
  COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS,
  COMPANION_TOOL_KIND_NAME_TABLE,
  COMPANION_TOOL_RUN_TIMEOUT_MS,
  COMPANION_TRIGGER_PROVIDERS,
} from "@companion/contracts";

/** Return control to Pi after ten minutes without ever turning absence into approval. */
export const COMPANION_DECISION_TIMEOUT_MS = COMPANION_BUDGETS_BASE.decisionTimeoutMs;

/**
 * On-disk name under `$PI_CODING_AGENT_DIR/extensions/`.
 *
 * Keep the legacy permission-broker filename so every start overwrites the older extension that
 * gated shell and file tools. The current extension provides ask_user, config-proposal,
 * routine-proposal, and trigger-proposal tools.
 */
export const COMPANION_PERMISSION_BROKER_EXTENSION_FILE = "companion-permission-broker.ts";

/** Title the extension puts on extension_ui_request events: `companion:<kind>:<tool>`. */
export const COMPANION_DECISION_TITLE_PATTERN =
  /^companion:(shell|file|question|config|routine|trigger):([A-Za-z0-9._-]{1,120})$/;

export function parseCompanionDecisionTitle(title: string): {
  kind: "shell" | "file" | "question" | "config" | "routine" | "trigger";
  name: string;
} | null {
  const match = COMPANION_DECISION_TITLE_PATTERN.exec(title.trim());
  if (!match) return null;
  // SAFETY: the regex has exactly one capturing group per alternative, so match[1] is always one of the listed kinds.
  return {
    kind: match[1] as "shell" | "file" | "question" | "config" | "routine" | "trigger",
    name: match[2]!,
  };
}

/**
 * Source installed onto every Companion Box so Pi can ask the human a blocking question or propose
 * settings. Shell and file tools are deliberately not intercepted: a Companion runs them without
 * approval. Kept as text so the API package does not depend on Pi's extension types.
 */
export const COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE = `/**
 * Companion question and config broker — Pi extension installed on every Companion Box.
 *
 * ask_user, propose_config, propose_routine, propose_trigger, and request_plugin_connection emit
 * extension_ui_request events and block until the control plane answers. Built-in shell and file
 * tools remain unrestricted.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type } from "typebox";

const DECISION_TIMEOUT_MS = ${COMPANION_DECISION_TIMEOUT_MS};
const TOOL_TIMEOUT_MS = ${COMPANION_TOOL_RUN_TIMEOUT_MS};
const EXEC_TOOL_TIMEOUT_MS = ${COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS};
const CONFIG_MAX_IDS = ${COMPANION_CONFIG_PROPOSAL_MAX_IDS};
const CONFIG_SUMMARY_MAX = ${COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS};
const CONNECT_PROVIDERS = ${JSON.stringify(COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS)} as string[];
const TRIGGER_PROVIDERS = ${JSON.stringify(COMPANION_TRIGGER_PROVIDERS)} as string[];
const INTERACTIVE_TOOLS = new Set(["ask_user", "propose_config", "propose_routine", "propose_trigger", "request_plugin_connection"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATALOG_PATH = \`$\{process.env.HOME || ""}/.companion/runtime/state/config-catalog.json\`;

// The control plane classifies a run's kind from this same table with this same priority order,
// so a run the transcript settles as shell also received the shell deadline here.
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
  // A delegated agent runs a whole task of its own, so it takes as long as a build or a test sweep
  // does. Holding it to the 90-second default would abort the turn that launched it, every time.
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
    // Pi may run sibling tools in parallel. One overdue tool aborts this turn, and every sibling
    // timer must disappear with it so none can abort a later queued turn.
    clearToolTimeouts();
    ctx.abort();
  }, toolTimeoutFor(toolName)));
}

function decisionTitle(name: string): string {
  return \`companion:question:\${name}\`;
}

function configTitle(name: string): string {
  return \`companion:config:\${name}\`;
}

function routineTitle(name: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return \`companion:routine:\${slug || "propose_routine"}\`;
}

function triggerTitle(name: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return \`companion:trigger:\${slug || "propose_trigger"}\`;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
}

function uniqueUuids(values: string[]): string[] | null {
  const unique = [...new Set(values)];
  if (unique.length > CONFIG_MAX_IDS || unique.some((id) => !UUID_PATTERN.test(id))) return null;
  return unique;
}

function readCatalog(): {
  skills?: Array<{ id: string; name?: string; slug?: string }>;
  plugins?: Array<{ id: string; label?: string; provider?: string; selected?: boolean }>;
} | null {
  try {
    return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as {
      skills?: Array<{ id: string; name?: string; slug?: string }>;
      plugins?: Array<{ id: string; label?: string; provider?: string; selected?: boolean }>;
    };
  } catch {
    return null;
  }
}

function namedIds(
  ids: string[],
  catalog: Array<{ id: string; name?: string; slug?: string; label?: string; provider?: string }> | undefined,
  fallback: (id: string) => string,
): string {
  return ids.map((id) => {
    const match = catalog?.find((item) => item.id === id);
    return match?.name || match?.slug || match?.label || fallback(id);
  }).join(", ");
}

function summarizeProposal(proposal: Record<string, unknown>): string {
  const catalog = readCatalog();
  const parts: string[] = [];
  const addSkills = Array.isArray(proposal.add_skill_ids) ? proposal.add_skill_ids as string[] : [];
  const removeSkills = Array.isArray(proposal.remove_skill_ids) ? proposal.remove_skill_ids as string[] : [];
  const attach = Array.isArray(proposal.attach_plugin_ids) ? proposal.attach_plugin_ids as string[] : [];
  const detach = Array.isArray(proposal.detach_plugin_ids) ? proposal.detach_plugin_ids as string[] : [];
  if (addSkills.length) parts.push(\`add \${namedIds(addSkills, catalog?.skills, (id) => id.slice(0, 8))}\`);
  if (removeSkills.length) parts.push(\`remove \${namedIds(removeSkills, catalog?.skills, (id) => id.slice(0, 8))}\`);
  if (attach.length) parts.push(\`attach \${namedIds(attach, catalog?.plugins, (id) => id.slice(0, 8))}\`);
  if (detach.length) parts.push(\`detach \${namedIds(detach, catalog?.plugins, (id) => id.slice(0, 8))}\`);
  if (typeof proposal.model_id === "string") parts.push(\`model \${proposal.model_id}\`);
  if (typeof proposal.persona === "string") parts.push("update persona");
  const connect = proposal.connect_plugin as { server_name?: string } | undefined;
  if (connect?.server_name) parts.push(\`connect \${connect.server_name}\`);
  const summary = parts.join("; ") || "Propose Companion settings";
  return summary.length > CONFIG_SUMMARY_MAX ? summary.slice(0, CONFIG_SUMMARY_MAX) : summary;
}

export default function companionPermissionBroker(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Interactive decisions have their own ten-minute fail-closed UI deadline. Their execute bodies
    // do not perform external work, so the shorter execution timer must not abort a
    // still-actionable question or config proposal.
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

  pi.registerTool({
    name: "propose_config",
    label: "Propose settings",
    description:
      "Propose Companion settings changes for Owner/Editor approval. This only proposes; never claim a change is active without approval. Settings apply after the current turn ends.",
    parameters: Type.Object({
      add_skills: Type.Optional(Type.Array(Type.String(), { description: "Skill ids to add" })),
      remove_skills: Type.Optional(Type.Array(Type.String(), { description: "Skill ids to remove" })),
      attach_plugins: Type.Optional(Type.Array(Type.String(), { description: "Plugin account ids to attach" })),
      detach_plugins: Type.Optional(Type.Array(Type.String(), { description: "Plugin account ids to detach" })),
      model_id: Type.Optional(Type.String({ description: "Pi model id from the catalog" })),
      persona: Type.Optional(Type.String({ description: "Short operator-authored persona, max 280 characters" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const addSkills = uniqueUuids(asStringList(params.add_skills));
      const removeSkills = uniqueUuids(asStringList(params.remove_skills));
      const attachPlugins = uniqueUuids(asStringList(params.attach_plugins));
      const detachPlugins = uniqueUuids(asStringList(params.detach_plugins));
      const modelId = typeof params.model_id === "string" ? params.model_id.trim() : "";
      const persona = typeof params.persona === "string" ? params.persona : undefined;
      if (
        addSkills === null || removeSkills === null
        || attachPlugins === null || detachPlugins === null
        || (modelId && (modelId.length > 200 || /[\\n\\r]/.test(modelId)))
        || (persona !== undefined && persona.length > 280)
      ) {
        return {
          content: [{ type: "text", text: "Error: propose_config arguments are invalid" }],
          details: { proposal: null, confirmed: null },
        };
      }
      const proposal: Record<string, unknown> = { kind: "config" };
      if (addSkills.length) proposal.add_skill_ids = addSkills;
      if (removeSkills.length) proposal.remove_skill_ids = removeSkills;
      if (attachPlugins.length) proposal.attach_plugin_ids = attachPlugins;
      if (detachPlugins.length) proposal.detach_plugin_ids = detachPlugins;
      if (modelId) proposal.model_id = modelId;
      if (persona !== undefined) proposal.persona = persona;
      if (Object.keys(proposal).length === 1) {
        return {
          content: [{ type: "text", text: "Error: propose_config requires at least one change" }],
          details: { proposal: null, confirmed: null },
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: no permission UI available" }],
          details: { proposal, confirmed: null },
        };
      }
      const summary = summarizeProposal(proposal);
      const confirmed = await ctx.ui.confirm(
        configTitle("propose_config"),
        JSON.stringify({ summary, proposal }),
        { timeout: DECISION_TIMEOUT_MS },
      );
      if (confirmed === true) {
        return {
          content: [{ type: "text", text: "Approved. Changes apply after this turn ends." }],
          details: { proposal, confirmed: true },
        };
      }
      return {
        content: [{ type: "text", text: "User denied or timed out. No settings changed." }],
        details: { proposal, confirmed: false },
      };
    },
  });

  pi.registerTool({
    name: "propose_routine",
    label: "Propose routine",
    description:
      "Propose a scheduled Companion routine for Owner/Editor approval. This only proposes; never claim a routine is active without approval. Keep confirm copy to one short sentence. Approved routines fire as ordinary turns whose prompt is hidden in the thread.",
    parameters: Type.Object({
      name: Type.String({ description: "Short unique name, max 80 characters" }),
      prompt: Type.String({ description: "The prompt the Companion will run on each fire" }),
      cron: Type.String({ description: "Five- or six-field cron expression" }),
      timezone: Type.String({ description: "IANA timezone, for example America/New_York" }),
      summary: Type.Optional(Type.String({ description: "One short confirm sentence with no setup or process narration" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      const cron = typeof params.cron === "string" ? params.cron.trim() : "";
      const timezone = typeof params.timezone === "string" ? params.timezone.trim() : "";
      const summaryArg = typeof params.summary === "string" ? params.summary.trim() : "";
      if (
        !name || name.length > 80 || /[\\n\\r]/.test(name)
        || !prompt || prompt.length > 16384
        || !cron || cron.length > 120 || /[\\n\\r]/.test(cron)
        || !timezone || timezone.length > 64 || /[\\n\\r]/.test(timezone)
        || (summaryArg && summaryArg.length > CONFIG_SUMMARY_MAX)
      ) {
        return {
          content: [{ type: "text", text: "Error: propose_routine arguments are invalid" }],
          details: { proposal: null, confirmed: null },
        };
      }
      const proposal = { kind: "routine", name, prompt, cron, timezone };
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: no permission UI available" }],
          details: { proposal, confirmed: null },
        };
      }
      const summary = (summaryArg || \`\${name}: \${cron} · \${timezone}.\`).slice(0, CONFIG_SUMMARY_MAX);
      const confirmed = await ctx.ui.confirm(
        routineTitle(name),
        JSON.stringify({ summary, proposal }),
        { timeout: DECISION_TIMEOUT_MS },
      );
      if (confirmed === true) {
        return {
          content: [{ type: "text", text: "Approved. The routine starts after this turn ends." }],
          details: { proposal, confirmed: true },
        };
      }
      return {
        content: [{ type: "text", text: "User denied or timed out. No routine was created." }],
        details: { proposal, confirmed: false },
      };
    },
  });

  pi.registerTool({
    name: "propose_trigger",
    label: "Propose trigger",
    description:
      "Propose an end-to-end webhook trigger for Owner/Editor approval. Companion registers supported provider webhooks itself with held credentials; never ask the person to paste a URL or use a provider console.",
    parameters: Type.Object({
      name: Type.String({ description: "Short unique name, max 80 characters" }),
      prompt: Type.String({ description: "The prompt the Companion will run on each webhook event" }),
      mode: Type.Optional(Type.String({ description: "notify to inform only, or relay for the main Companion to act; defaults to relay" })),
      provider: Type.Optional(Type.String({ description: "webhook, linear, github, sentry, or custom; defaults to webhook" })),
      repo: Type.Optional(Type.String({ description: "github only: repository as owner/repo the webhook watches" })),
      organization: Type.Optional(Type.String({ description: "sentry only: organization slug" })),
      project: Type.Optional(Type.String({ description: "sentry only: project slug" })),
      events: Type.Optional(Type.Array(Type.String(), { description: "github only: webhook event names (push, pull_request, ...) or a single "*"; max 30" })),
      summary: Type.Optional(Type.String({ description: "One-line confirm copy for the human" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      const provider = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "webhook";
      const mode = typeof params.mode === "string" ? params.mode.trim().toLowerCase() : "relay";
      const repo = typeof params.repo === "string" ? params.repo.trim() : "";
      const organization = typeof params.organization === "string" ? params.organization.trim() : "";
      const project = typeof params.project === "string" ? params.project.trim() : "";
      const events = asStringList(params.events).map((event) => event.trim().toLowerCase()).filter(Boolean);
      const summaryArg = typeof params.summary === "string" ? params.summary.trim() : "";
      if (!TRIGGER_PROVIDERS.includes(provider)) {
        return {
          content: [{ type: "text", text: \`Error: propose_trigger provider must be one of \${TRIGGER_PROVIDERS.join(", ")}\` }],
          details: { proposal: null, confirmed: null },
        };
      }
      if (!["notify", "relay"].includes(mode)) {
        return {
          content: [{ type: "text", text: "Error: propose_trigger mode is invalid" }],
          details: { proposal: null, confirmed: null },
        };
      }
      // A github proposal must carry its full target: approval creates the trigger in one SQL call,
      // so a partial target would dead-end the pending decision.
      if (provider === "github" && (!repo || events.length === 0)) {
        return {
          content: [{ type: "text", text: "Error: propose_trigger github triggers need both a repo (owner/repo) and at least one event" }],
          details: { proposal: null, confirmed: null },
        };
      }
      if (provider === "sentry" && (!organization || !project || events.length === 0)) {
        return {
          content: [{ type: "text", text: "Error: propose_trigger sentry triggers need organization, project, and at least one event" }],
          details: { proposal: null, confirmed: null },
        };
      }
      if (provider !== "github" && repo) {
        return {
          content: [{ type: "text", text: \`Error: \${provider} triggers do not take a repo\` }],
          details: { proposal: null, confirmed: null },
        };
      }
      if (provider !== "sentry" && (organization || project)) {
        return {
          content: [{ type: "text", text: \`Error: \${provider} triggers do not take a Sentry organization or project\` }],
          details: { proposal: null, confirmed: null },
        };
      }
      if (!["github", "sentry"].includes(provider) && events.length) {
        return {
          content: [{ type: "text", text: \`Error: \${provider} triggers do not take events yet\` }],
          details: { proposal: null, confirmed: null },
        };
      }
      if (events.some((event) => !/^\\*$|^[a-z_]{1,64}$/.test(event)) || events.length > 30) {
        return {
          content: [{ type: "text", text: "Error: propose_trigger events must be lowercase webhook event names or "*", at most 30" }],
          details: { proposal: null, confirmed: null },
        };
      }
      const target = provider === "github"
        ? { repo, events }
        : provider === "sentry" ? { organization, project, events } : undefined;
      if (
        !name || name.length > 80 || /[\\n\\r]/.test(name)
        || !prompt || prompt.length > 16384
        || (summaryArg && summaryArg.length > CONFIG_SUMMARY_MAX)
      ) {
        return {
          content: [{ type: "text", text: "Error: propose_trigger arguments are invalid" }],
          details: { proposal: null, confirmed: null },
        };
      }
      const proposal = {
        kind: "trigger", name, prompt, mode, provider,
        ...(target ? { target } : {}),
      };
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: no permission UI available" }],
          details: { proposal, confirmed: null },
        };
      }
      const summary = (summaryArg || \`Fire \${name} on \${provider} webhook events\`).slice(0, CONFIG_SUMMARY_MAX);
      const confirmed = await ctx.ui.confirm(
        triggerTitle(name),
        JSON.stringify({ summary, proposal }),
        { timeout: DECISION_TIMEOUT_MS },
      );
      if (confirmed === true) {
        return {
          content: [{
            type: "text",
            text: "Approved. Companion creates the trigger and registers the provider webhook end-to-end after this turn.",
          }],
          details: { proposal, confirmed: true },
        };
      }
      return {
        content: [{ type: "text", text: "User denied or timed out. No trigger was created." }],
        details: { proposal, confirmed: false },
      };
    },
  });

  pi.registerTool({
    name: "request_plugin_connection",
    label: "Request plugin connection",
    description:
      "Ask the human to connect a supported plugin (${COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS.join(", ")}). This only proposes; they finish the connection in the web UI. After it is connected, propose attaching it on a later turn.",
    parameters: Type.Object({
      server_name: Type.String({ description: "One of: ${COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS.join(", ")}" }),
      reason: Type.Optional(Type.String({ description: "Why this plugin is needed" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const serverName = typeof params.server_name === "string" ? params.server_name.trim().toLowerCase() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (!CONNECT_PROVIDERS.includes(serverName) || (reason && reason.length > 280)) {
        return {
          content: [{ type: "text", text: "Error: request_plugin_connection arguments are invalid" }],
          details: { proposal: null, confirmed: null },
        };
      }
      const proposal = {
        kind: "config",
        connect_plugin: reason
          ? { server_name: serverName, reason }
          : { server_name: serverName },
      };
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: no permission UI available" }],
          details: { proposal, confirmed: null },
        };
      }
      const summary = summarizeProposal(proposal);
      const confirmed = await ctx.ui.confirm(
        configTitle("request_plugin_connection"),
        JSON.stringify({ summary, proposal }),
        { timeout: DECISION_TIMEOUT_MS },
      );
      if (confirmed === true) {
        return {
          content: [{
            type: "text",
            text: "Approved. The human must finish the connection in the web UI; propose attaching it on a later turn.",
          }],
          details: { proposal, confirmed: true },
        };
      }
      return {
        content: [{ type: "text", text: "User denied or timed out. No plugin connection was requested." }],
        details: { proposal, confirmed: false },
      };
    },
  });
}
`;
