import { z } from "zod";

/**
 * Stable identifiers for the MCP plugins curated and shipped by Companion. These values remain
 * compatible with already-encrypted OAuth credentials created before the external registry was
 * removed.
 */
export const COMPANION_PLUGIN_OAUTH_SERVER_NAMES = [
  "app.linear/linear",
  "io.github.github/github-mcp-server",
  "com.notion/mcp",
  "build.conductor/mcp",
  "com.slack/mcp",
  "com.google.workspace/gmail",
  "io.sentry/mcp",
] as const;
export const companionPluginOAuthServerNameSchema = z.enum(
  COMPANION_PLUGIN_OAUTH_SERVER_NAMES,
);
export type CompanionPluginOAuthServerName = z.infer<
  typeof companionPluginOAuthServerNameSchema
>;

export interface CompanionPluginCatalogEntry {
  server_name: CompanionPluginOAuthServerName;
  provider: "linear" | "github" | "notion" | "conductor" | "slack" | "gmail" | "sentry";
  title: string;
  description: string;
}

/** Product-owned MCP catalog. Adding or removing an entry requires a Companion release. */
export const COMPANION_PLUGIN_CATALOG = [
  {
    server_name: "app.linear/linear",
    provider: "linear",
    title: "Linear",
    description: "Linear project management and issue tracking.",
  },
  {
    server_name: "io.github.github/github-mcp-server",
    provider: "github",
    title: "GitHub",
    description: "Git clone, commit, and push, plus repositories, issues, and pull requests.",
  },
  {
    server_name: "com.notion/mcp",
    provider: "notion",
    title: "Notion",
    description: "Notion pages, databases, and search.",
  },
  {
    server_name: "build.conductor/mcp",
    provider: "conductor",
    title: "Conductor",
    description: "Conductor cloud workspaces, sessions, and coding agents.",
  },
  {
    server_name: "com.slack/mcp",
    provider: "slack",
    title: "Slack",
    description: "Send bounded messages to Slack conversations through a connected Bot User.",
  },
  {
    server_name: "com.google.workspace/gmail",
    provider: "gmail",
    title: "Gmail",
    description: "Search and read email, and create drafts for review in Gmail.",
  },
  {
    server_name: "io.sentry/mcp",
    provider: "sentry",
    title: "Sentry",
    description: "Sentry issues, events, traces, releases, and debugging context.",
  },
] as const satisfies readonly CompanionPluginCatalogEntry[];

export const companionPluginOAuthStartInputSchema = z.object({
  server_name: companionPluginOAuthServerNameSchema,
  label: z.string().trim().min(1).max(40),
  companion_id: z.string().uuid().optional(),
  control_request_id: z.string().uuid().optional(),
}).strict().refine(
  (input) => (input.companion_id === undefined) === (input.control_request_id === undefined),
  { message: "companion_id and control_request_id must be provided together" },
);
export type CompanionPluginOAuthStartInput = z.infer<
  typeof companionPluginOAuthStartInputSchema
>;

export const companionPluginOAuthStartResponseSchema = z.object({
  authorization_url: z.string().url(),
}).strict();
export type CompanionPluginOAuthStartResponse = z.infer<
  typeof companionPluginOAuthStartResponseSchema
>;
