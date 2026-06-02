import { describe, it, expect } from "vitest";
import { buildLinearSystemPrompt, buildLinearOAuthSystemPrompt } from "./linear-prompt-builder.js";

describe("buildLinearSystemPrompt", () => {
  const connection = {
    workspaceName: "Acme Corp",
    viewerName: "Jane Doe",
    viewerEmail: "jane@acme.com",
  };

  const issue = {
    identifier: "ENG-42",
    title: "Fix login redirect",
    stateName: "In Progress",
    teamName: "Engineering",
    url: "https://linear.app/acme/issue/ENG-42",
  };

  it("includes workspace info and API instructions", () => {
    // Verifies the core prompt contains workspace context and API usage guidance
    const prompt = buildLinearSystemPrompt(connection);
    expect(prompt).toContain("LINEAR_API_KEY");
    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("Jane Doe");
    expect(prompt).toContain("jane@acme.com");
    expect(prompt).toContain("https://api.linear.app/graphql");
    expect(prompt).toContain("Authorization: Bearer $LINEAR_API_KEY");
  });

  it("includes issue context when provided", () => {
    // When a Linear issue is linked, the prompt should include issue details
    const prompt = buildLinearSystemPrompt(connection, issue);
    expect(prompt).toContain("ENG-42");
    expect(prompt).toContain("Fix login redirect");
    expect(prompt).toContain("In Progress");
    expect(prompt).toContain("Engineering");
    expect(prompt).toContain("https://linear.app/acme/issue/ENG-42");
  });

  it("omits issue section when no issue provided", () => {
    // Without an issue, the prompt should only contain workspace + API info
    const prompt = buildLinearSystemPrompt(connection);
    expect(prompt).not.toContain("Linked issue:");
    expect(prompt).not.toContain("Issue URL:");
  });

  it("includes common operations guidance", () => {
    // The prompt should tell the agent what it can do with the Linear API
    const prompt = buildLinearSystemPrompt(connection);
    expect(prompt).toContain("add comments");
    expect(prompt).toContain("transition issue status");
    expect(prompt).toContain("read issue details");
  });

  it("returns a multi-line string with newlines", () => {
    // The prompt must be multi-line for readability in the system prompt
    const prompt = buildLinearSystemPrompt(connection, issue);
    const lines = prompt.split("\n");
    expect(lines.length).toBeGreaterThan(3);
  });
});

describe("buildLinearOAuthSystemPrompt", () => {
  it("includes OAuth token guidance for app-scoped Linear access", () => {
    const prompt = buildLinearOAuthSystemPrompt({ name: "Enrich" });

    expect(prompt).toContain("LINEAR_OAUTH_ACCESS_TOKEN");
    expect(prompt).toContain('Connected Linear OAuth app: "Enrich"');
    expect(prompt).toContain("actor=app");
    expect(prompt).toContain("https://api.linear.app/graphql");
    expect(prompt).toContain("Authorization: Bearer $LINEAR_OAUTH_ACCESS_TOKEN");
    expect(prompt).toContain("LINEAR_API_KEY");
  });
});
