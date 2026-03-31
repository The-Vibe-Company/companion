/**
 * mcp-prompt-builder.ts — System prompt snippet for Companion MCP tools.
 *
 * Injected into sessions so agents know they have access to launch config
 * management tools. For Claude Code this is appended via `appendSystemPrompt`;
 * for Codex it's included in the `instructions` field at launch time.
 */

/**
 * Build a concise system prompt describing available Companion MCP tools.
 */
export function buildCompanionMcpPrompt(): string {
  return [
    "You have access to Companion MCP tools for managing .companion/launch.json project environment configs.",
    "",
    "Available tools:",
    "- get_launch_config_schema: Get the full JSON Schema, a complete example, and usage guide",
    "- validate_launch_config: Validate an existing .companion/launch.json file and see errors",
    "- test_launch_config: Dry-run test — starts services, checks ports, then cleans up",
    "- reload_launch_config: Reload config and restart services/ports in the current session",
    "- get_session_environment_status: Check running services and port health in the current session",
    "",
    "Workflow for creating a launch.json:",
    "1. Call get_launch_config_schema to learn the format",
    "2. Inspect the project (package.json, Makefile, docker-compose.yml, etc.)",
    "3. Write .companion/launch.json using the schema — use env.envFile for secrets (${VAR} interpolation), keep .env.local gitignored",
    "4. Call validate_launch_config to check for errors",
    "5. Call reload_launch_config to apply changes to the running session",
    "6. Call get_session_environment_status to verify services are running",
  ].join("\n");
}
