#!/usr/bin/env bun
/**
 * CLI handler module for `companion` management subcommands.
 * Each subcommand maps 1:1 to a Companion REST API endpoint.
 * All output is JSON to stdout for easy parsing by both humans and AI agents.
 */

const DEFAULT_PORT = 3456;

function getPort(argv: string[]): number {
  const idx = argv.indexOf("--port");
  if (idx !== -1 && argv[idx + 1]) {
    const p = Number(argv[idx + 1]);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  return Number(process.env.COMPANION_PORT) || DEFAULT_PORT;
}

function getBase(argv: string[]): string {
  return `http://localhost:${getPort(argv)}/api`;
}

/** Strip --port <n> from argv so subcommand parsers don't see it */
function stripGlobalFlags(argv: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--port" && argv[i + 1]) {
      i += 2;
      continue;
    }
    result.push(argv[i]);
    i++;
  }
  return result;
}

async function apiGet(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(base: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPut(base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPatch(base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiDelete(base: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function err(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

/** Parse --key value pairs from argv. Supports --flag (boolean true). */
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      i++;
    }
  }
  return flags;
}

/** Collect all --var KEY=VALUE pairs from argv */
function parseVars(argv: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--var" && argv[i + 1]) {
      const eq = argv[i + 1].indexOf("=");
      if (eq > 0) {
        vars[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
      }
      i += 2;
    } else {
      i++;
    }
  }
  return vars;
}

// ─── Subcommand handlers ────────────────────────────────────────────────────

async function handleStatus(base: string): Promise<void> {
  const [sessions, backends] = await Promise.all([
    apiGet(base, "/sessions") as Promise<unknown[]>,
    apiGet(base, "/backends") as Promise<unknown[]>,
  ]);
  const active = (sessions as Array<{ state?: string; archived?: boolean }>).filter(
    (s) => !s.archived && s.state !== "exited",
  );
  out({
    activeSessions: active.length,
    totalSessions: sessions.length,
    backends,
  });
}

async function handleSessions(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list": {
      const sessions = await apiGet(base, "/sessions");
      out(sessions);
      break;
    }
    case "get": {
      const id = rest[0];
      if (!id) err("Usage: companion sessions get <sessionId>");
      out(await apiGet(base, `/sessions/${encodeURIComponent(id)}`));
      break;
    }
    case "create": {
      const flags = parseFlags(rest);
      const body: Record<string, unknown> = {};
      if (flags.cwd) body.cwd = flags.cwd;
      if (flags.model) body.model = flags.model;
      if (flags["permission-mode"]) body.permissionMode = flags["permission-mode"];
      if (flags.env) body.envSlug = flags.env;
      if (flags.backend) body.backend = flags.backend;
      if (flags.worktree) body.useWorktree = true;
      if (flags.branch) body.branch = flags.branch;
      if (flags["create-branch"]) body.createBranch = true;
      out(await apiPost(base, "/sessions/create", body));
      break;
    }
    case "kill": {
      const id = rest[0];
      if (!id) err("Usage: companion sessions kill <sessionId>");
      out(await apiPost(base, `/sessions/${encodeURIComponent(id)}/kill`));
      break;
    }
    case "relaunch": {
      const id = rest[0];
      if (!id) err("Usage: companion sessions relaunch <sessionId>");
      out(await apiPost(base, `/sessions/${encodeURIComponent(id)}/relaunch`));
      break;
    }
    case "archive": {
      const id = rest[0];
      if (!id) err("Usage: companion sessions archive <sessionId>");
      out(await apiPost(base, `/sessions/${encodeURIComponent(id)}/archive`));
      break;
    }
    case "rename": {
      const id = rest[0];
      const name = rest.slice(1).join(" ");
      if (!id || !name) err("Usage: companion sessions rename <sessionId> <name>");
      out(await apiPatch(base, `/sessions/${encodeURIComponent(id)}/name`, { name }));
      break;
    }
    case "send-message": {
      const id = rest[0];
      const content = rest.slice(1).join(" ");
      if (!id || !content) err("Usage: companion sessions send-message <sessionId> <message>");
      out(await apiPost(base, `/sessions/${encodeURIComponent(id)}/message`, { content }));
      break;
    }
    default:
      err(`Unknown sessions subcommand: ${sub}. Available: list, get, create, kill, relaunch, archive, rename, send-message`);
  }
}

async function handleEnvs(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list": {
      out(await apiGet(base, "/envs"));
      break;
    }
    case "get": {
      const slug = rest[0];
      if (!slug) err("Usage: companion envs get <slug>");
      out(await apiGet(base, `/envs/${encodeURIComponent(slug)}`));
      break;
    }
    case "create": {
      const flags = parseFlags(rest);
      const vars = parseVars(rest);
      if (!flags.name) err("Usage: companion envs create --name <name> [--var KEY=VALUE ...]");
      out(await apiPost(base, "/envs", { name: flags.name, variables: vars }));
      break;
    }
    case "update": {
      const slug = rest[0];
      if (!slug) err("Usage: companion envs update <slug> [--name <name>] [--var KEY=VALUE ...]");
      const flagArgs = rest.slice(1);
      const flags = parseFlags(flagArgs);
      const vars = parseVars(flagArgs);
      const body: Record<string, unknown> = {};
      if (flags.name) body.name = flags.name;
      if (Object.keys(vars).length > 0) body.variables = vars;
      out(await apiPut(base, `/envs/${encodeURIComponent(slug)}`, body));
      break;
    }
    case "delete": {
      const slug = rest[0];
      if (!slug) err("Usage: companion envs delete <slug>");
      out(await apiDelete(base, `/envs/${encodeURIComponent(slug)}`));
      break;
    }
    default:
      err(`Unknown envs subcommand: ${sub}. Available: list, get, create, update, delete`);
  }
}

async function handleCron(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list": {
      out(await apiGet(base, "/cron/jobs"));
      break;
    }
    case "get": {
      const id = rest[0];
      if (!id) err("Usage: companion cron get <jobId>");
      out(await apiGet(base, `/cron/jobs/${encodeURIComponent(id)}`));
      break;
    }
    case "create": {
      const flags = parseFlags(rest);
      if (!flags.name || !flags.schedule || !flags.prompt)
        err("Usage: companion cron create --name <name> --schedule <cron|datetime> --prompt <prompt> [--cwd <path>] [--model <model>] [--env <slug>] [--recurring] [--backend <type>] [--permission-mode <mode>]");
      const body: Record<string, unknown> = {
        name: flags.name,
        schedule: flags.schedule,
        prompt: flags.prompt,
      };
      if (flags.cwd) body.cwd = flags.cwd;
      if (flags.model) body.model = flags.model;
      if (flags.env) body.envSlug = flags.env;
      if (flags.backend) body.backendType = flags.backend;
      if (flags["permission-mode"]) body.permissionMode = flags["permission-mode"];
      // Default: recurring=true for cron expressions, false if looks like a datetime
      body.recurring = flags.recurring === true || flags.recurring === "true"
        || (flags.recurring === undefined && !(flags.schedule as string).includes("T"));
      out(await apiPost(base, "/cron/jobs", body));
      break;
    }
    case "update": {
      const id = rest[0];
      if (!id) err("Usage: companion cron update <jobId> [--name <n>] [--schedule <s>] [--prompt <p>] ...");
      const flagArgs = rest.slice(1);
      const flags = parseFlags(flagArgs);
      const body: Record<string, unknown> = {};
      if (flags.name) body.name = flags.name;
      if (flags.schedule) body.schedule = flags.schedule;
      if (flags.prompt) body.prompt = flags.prompt;
      if (flags.cwd) body.cwd = flags.cwd;
      if (flags.model) body.model = flags.model;
      if (flags.env) body.envSlug = flags.env;
      if (flags.backend) body.backendType = flags.backend;
      if (flags["permission-mode"]) body.permissionMode = flags["permission-mode"];
      if (flags.recurring !== undefined) body.recurring = flags.recurring === true || flags.recurring === "true";
      out(await apiPut(base, `/cron/jobs/${encodeURIComponent(id)}`, body));
      break;
    }
    case "delete": {
      const id = rest[0];
      if (!id) err("Usage: companion cron delete <jobId>");
      out(await apiDelete(base, `/cron/jobs/${encodeURIComponent(id)}`));
      break;
    }
    case "toggle": {
      const id = rest[0];
      if (!id) err("Usage: companion cron toggle <jobId>");
      out(await apiPost(base, `/cron/jobs/${encodeURIComponent(id)}/toggle`));
      break;
    }
    case "run": {
      const id = rest[0];
      if (!id) err("Usage: companion cron run <jobId>");
      out(await apiPost(base, `/cron/jobs/${encodeURIComponent(id)}/run`));
      break;
    }
    case "executions": {
      const id = rest[0];
      if (!id) err("Usage: companion cron executions <jobId>");
      out(await apiGet(base, `/cron/jobs/${encodeURIComponent(id)}/executions`));
      break;
    }
    default:
      err(`Unknown cron subcommand: ${sub}. Available: list, get, create, update, delete, toggle, run, executions`);
  }
}

async function handleSettings(base: string, args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "get": {
      out(await apiGet(base, "/settings"));
      break;
    }
    case "set": {
      const flags = parseFlags(args.slice(1));
      const body: Record<string, unknown> = {};
      if (flags["anthropic-key"]) body.anthropicApiKey = flags["anthropic-key"];
      if (flags["anthropic-model"]) body.anthropicModel = flags["anthropic-model"];
      if (Object.keys(body).length === 0) err("Usage: companion settings set --anthropic-key <key> or --anthropic-model <model>");
      out(await apiPut(base, "/settings", body));
      break;
    }
    default:
      err(`Unknown settings subcommand: ${sub}. Available: get, set`);
  }
}

async function handleAssistant(base: string, args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "status": {
      out(await apiGet(base, "/assistant/status"));
      break;
    }
    case "launch": {
      out(await apiPost(base, "/assistant/launch"));
      break;
    }
    case "stop": {
      out(await apiPost(base, "/assistant/stop"));
      break;
    }
    case "config": {
      const action = args[1];
      if (action === "set") {
        const flags = parseFlags(args.slice(2));
        const body: Record<string, unknown> = {};
        if (flags.model) body.model = flags.model;
        if (flags["permission-mode"]) body.permissionMode = flags["permission-mode"];
        if (flags.enabled !== undefined) body.enabled = flags.enabled === true || flags.enabled === "true";
        out(await apiPut(base, "/assistant/config", body));
      } else {
        out(await apiGet(base, "/assistant/config"));
      }
      break;
    }
    default:
      err(`Unknown assistant subcommand: ${sub}. Available: status, launch, stop, config`);
  }
}

async function handleSkills(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list": {
      out(await apiGet(base, "/skills"));
      break;
    }
    case "get": {
      const slug = rest[0];
      if (!slug) err("Usage: companion skills get <slug>");
      out(await apiGet(base, `/skills/${encodeURIComponent(slug)}`));
      break;
    }
    case "create": {
      const flags = parseFlags(rest);
      if (!flags.name) err("Usage: companion skills create --name <name> [--description <desc>] [--content <markdown>]");
      const body: Record<string, unknown> = { name: flags.name };
      if (flags.description) body.description = flags.description;
      if (flags.content) body.content = flags.content;
      out(await apiPost(base, "/skills", body));
      break;
    }
    case "update": {
      const slug = rest[0];
      if (!slug) err("Usage: companion skills update <slug> --content <markdown>");
      const flags = parseFlags(rest.slice(1));
      if (!flags.content) err("Usage: companion skills update <slug> --content <full SKILL.md content>");
      out(await apiPut(base, `/skills/${encodeURIComponent(slug)}`, { content: flags.content }));
      break;
    }
    case "delete": {
      const slug = rest[0];
      if (!slug) err("Usage: companion skills delete <slug>");
      out(await apiDelete(base, `/skills/${encodeURIComponent(slug)}`));
      break;
    }
    default:
      err(`Unknown skills subcommand: ${sub}. Available: list, get, create, update, delete`);
  }
}

// ─── Main dispatch ──────────────────────────────────────────────────────────

function printCtlUsage(): void {
  console.log(`
Management commands:

  companion status                        Overall Companion status
  companion sessions <subcommand>         Manage sessions
  companion envs <subcommand>             Manage environment profiles
  companion cron <subcommand>             Manage scheduled jobs
  companion skills <subcommand>           Manage Claude Code skills
  companion settings <subcommand>         Manage settings
  companion assistant <subcommand>        Manage the Companion Assistant

Global options:
  --port <n>    Override the Companion API port (default: 3456, or COMPANION_PORT env)

Run 'companion <command>' without subcommand for available subcommands.
`);
}

export async function handleCtlCommand(command: string, rawArgv: string[]): Promise<void> {
  const argv = stripGlobalFlags(rawArgv);
  const base = getBase(rawArgv);

  try {
    switch (command) {
      case "status":
        await handleStatus(base);
        break;
      case "sessions":
        if (argv.length === 0) err("Usage: companion sessions <list|get|create|kill|relaunch|archive|rename|send-message>");
        await handleSessions(base, argv);
        break;
      case "envs":
        if (argv.length === 0) err("Usage: companion envs <list|get|create|update|delete>");
        await handleEnvs(base, argv);
        break;
      case "cron":
        if (argv.length === 0) err("Usage: companion cron <list|get|create|update|delete|toggle|run|executions>");
        await handleCron(base, argv);
        break;
      case "settings":
        if (argv.length === 0) err("Usage: companion settings <get|set>");
        await handleSettings(base, argv);
        break;
      case "skills":
        if (argv.length === 0) err("Usage: companion skills <list|get|create|update|delete>");
        await handleSkills(base, argv);
        break;
      case "assistant":
        if (argv.length === 0) err("Usage: companion assistant <status|launch|stop|config>");
        await handleAssistant(base, argv);
        break;
      case "ctl-help":
        printCtlUsage();
        break;
      default:
        err(`Unknown command: ${command}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Check if it's a connection error
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      err(`Cannot connect to The Companion at ${base}. Is the server running?`);
    }
    err(message);
  }
}
