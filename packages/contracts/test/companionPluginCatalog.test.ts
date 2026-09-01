import { describe, expect, it } from "vitest";
import {
  COMPANION_PLUGIN_CATALOG,
  companionPluginOAuthStartInputSchema,
  companionPluginOAuthServerNameSchema,
} from "../src/companionPluginCatalog";

describe("Companion plugin catalog contracts", () => {
  it("ships exactly the product-owned Linear, GitHub, Notion, Conductor, Slack, Gmail, and Sentry catalog", () => {
    expect(COMPANION_PLUGIN_CATALOG.map((entry) => ({
      server_name: entry.server_name,
      provider: entry.provider,
      title: entry.title,
    }))).toEqual([
      { server_name: "app.linear/linear", provider: "linear", title: "Linear" },
      {
        server_name: "io.github.github/github-mcp-server",
        provider: "github",
        title: "GitHub",
      },
      { server_name: "com.notion/mcp", provider: "notion", title: "Notion" },
      {
        server_name: "build.conductor/mcp",
        provider: "conductor",
        title: "Conductor",
      },
      { server_name: "com.slack/mcp", provider: "slack", title: "Slack" },
      {
        server_name: "com.google.workspace/gmail",
        provider: "gmail",
        title: "Gmail",
      },
      { server_name: "io.sentry/mcp", provider: "sentry", title: "Sentry" },
    ]);
  });

  it("allows only curated catalog entries and requires an account label", () => {
    expect(companionPluginOAuthStartInputSchema.parse({
      server_name: "app.linear/linear",
      label: "  work  ",
    })).toEqual({ server_name: "app.linear/linear", label: "work" });
    expect(companionPluginOAuthServerNameSchema.safeParse(
      "io.github.github/github-mcp-server",
    ).success).toBe(true);
    expect(companionPluginOAuthServerNameSchema.safeParse("io.example/custom").success).toBe(false);
    expect(companionPluginOAuthStartInputSchema.safeParse({
      server_name: "com.notion/mcp",
      label: " ",
    }).success).toBe(false);
  });

  it("binds control-request OAuth starts to both the request and Companion", () => {
    const linked = {
      server_name: "io.github.github/github-mcp-server",
      label: "work",
      companion_id: "11111111-1111-4111-8111-111111111111",
      control_request_id: "22222222-2222-4222-8222-222222222222",
    } as const;
    expect(companionPluginOAuthStartInputSchema.parse(linked)).toEqual(linked);
    expect(companionPluginOAuthStartInputSchema.safeParse({
      server_name: linked.server_name,
      label: linked.label,
      companion_id: linked.companion_id,
    }).success).toBe(false);
  });
});
