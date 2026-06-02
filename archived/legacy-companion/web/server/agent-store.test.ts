import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let agentStore: typeof import("./agent-store.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "agent-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  agentStore = await import("./agent-store.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function agentsDir(): string {
  return join(tempDir, ".companion", "agents");
}

/**
 * Helper to build a valid AgentConfigCreateInput with sensible defaults.
 * Pass overrides to customise specific fields.
 */
function makeAgentInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Agent",
    prompt: "Do something useful",
    description: "A test agent",
    version: 1 as const,
    backendType: "claude" as const,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/test-repo",
    enabled: true,
    permissionMode: "bypassPermissions",
    ...overrides,
  };
}

// ===========================================================================
// listAgents
// ===========================================================================
describe("listAgents", () => {
  it("returns empty array when no agents exist", () => {
    // The agents directory does not exist yet; listAgents should
    // create it and return an empty list without throwing.
    expect(agentStore.listAgents()).toEqual([]);
  });

  it("returns agents sorted alphabetically by name", () => {
    agentStore.createAgent(makeAgentInput({ name: "Zebra Agent" }));
    agentStore.createAgent(makeAgentInput({ name: "Alpha Agent" }));
    agentStore.createAgent(makeAgentInput({ name: "Mango Agent" }));

    const result = agentStore.listAgents();
    expect(result.map((a) => a.name)).toEqual(["Alpha Agent", "Mango Agent", "Zebra Agent"]);
  });

  it("skips corrupt JSON files", () => {
    agentStore.createAgent(makeAgentInput({ name: "Valid Agent" }));
    writeFileSync(join(agentsDir(), "corrupt.json"), "NOT VALID JSON{{{", "utf-8");

    const result = agentStore.listAgents();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Valid Agent");
  });

  it("strips legacy triggers.chat block from agents loaded from disk", () => {
    // Simulate an agent saved with the old Chat SDK schema that has
    // platform credentials embedded in triggers.chat. The store should
    // strip this block on load to prevent leaking secrets via the API.
    const agent = agentStore.createAgent(makeAgentInput({ name: "Legacy Chat Agent" }));
    const agentFile = join(agentsDir(), `${agent.id}.json`);
    const raw = JSON.parse(readFileSync(agentFile, "utf-8"));
    raw.triggers = {
      ...raw.triggers,
      chat: {
        enabled: true,
        platforms: [{
          adapter: "github",
          autoSubscribe: true,
          credentials: { token: "ghp_secret123", webhookSecret: "wh_secret456" },
        }],
      },
    };
    writeFileSync(agentFile, JSON.stringify(raw), "utf-8");

    const loaded = agentStore.listAgents();
    const found = loaded.find((a) => a.id === agent.id);
    expect(found).toBeDefined();
    // The triggers.chat block should be stripped
    expect((found!.triggers as Record<string, unknown>)?.chat).toBeUndefined();
  });

  it("skips non-JSON files in the agents directory", () => {
    agentStore.createAgent(makeAgentInput({ name: "Legit Agent" }));
    writeFileSync(join(agentsDir(), "readme.txt"), "not an agent", "utf-8");
    writeFileSync(join(agentsDir(), "notes.md"), "# notes", "utf-8");

    const agents = agentStore.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Legit Agent");
  });
});

// ===========================================================================
// createAgent
// ===========================================================================
describe("createAgent", () => {
  it("creates a valid agent with auto-generated slug ID", () => {
    const before = Date.now();
    const agent = agentStore.createAgent(makeAgentInput({ name: "My Cool Agent" }));
    const after = Date.now();

    // The ID is a slugified version of the name
    expect(agent.id).toBe("my-cool-agent");
    expect(agent.name).toBe("My Cool Agent");
    expect(agent.prompt).toBe("Do something useful");
    expect(agent.description).toBe("A test agent");
    expect(agent.backendType).toBe("claude");
    expect(agent.permissionMode).toBe("bypassPermissions");
    // Auto-initialised tracking fields
    expect(agent.totalRuns).toBe(0);
    expect(agent.consecutiveFailures).toBe(0);
    // Timestamps should bracket the call
    expect(agent.createdAt).toBeGreaterThanOrEqual(before);
    expect(agent.createdAt).toBeLessThanOrEqual(after);
    expect(agent.updatedAt).toBe(agent.createdAt);
  });

  it("persists the agent to disk as JSON", () => {
    agentStore.createAgent(makeAgentInput({ name: "Disk Agent" }));

    const raw = readFileSync(join(agentsDir(), "disk-agent.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe("Disk Agent");
    expect(parsed.id).toBe("disk-agent");
  });

  it("throws on missing name (empty string)", () => {
    expect(() => agentStore.createAgent(makeAgentInput({ name: "" }))).toThrow(
      "Agent name is required",
    );
  });

  it("throws on missing name (whitespace only)", () => {
    expect(() => agentStore.createAgent(makeAgentInput({ name: "   " }))).toThrow(
      "Agent name is required",
    );
  });

  it("throws on missing prompt (empty string)", () => {
    expect(() => agentStore.createAgent(makeAgentInput({ prompt: "" }))).toThrow(
      "Agent prompt is required",
    );
  });

  it("throws on missing prompt (whitespace only)", () => {
    expect(() => agentStore.createAgent(makeAgentInput({ prompt: "   " }))).toThrow(
      "Agent prompt is required",
    );
  });

  it("throws on duplicate names (slug collision)", () => {
    agentStore.createAgent(makeAgentInput({ name: "Duplicate Test" }));
    expect(() => agentStore.createAgent(makeAgentInput({ name: "Duplicate Test" }))).toThrow(
      'An agent with a similar name already exists ("duplicate-test")',
    );
  });

  it("throws when name contains no alphanumeric characters", () => {
    expect(() => agentStore.createAgent(makeAgentInput({ name: "@#$%^&" }))).toThrow(
      "Agent name must contain alphanumeric characters",
    );
  });

  it("trims the name before saving", () => {
    const agent = agentStore.createAgent(makeAgentInput({ name: "  Spacey Name  " }));
    expect(agent.name).toBe("Spacey Name");
    expect(agent.id).toBe("spacey-name");
  });

  it("trims prompt and description", () => {
    const agent = agentStore.createAgent(
      makeAgentInput({
        name: "Trim Fields Agent",
        prompt: "  some prompt  ",
        description: "  some desc  ",
      }),
    );
    expect(agent.prompt).toBe("some prompt");
    expect(agent.description).toBe("some desc");
  });

  it("auto-generates webhook secret when webhook trigger is enabled without a secret", () => {
    // When triggers.webhook is provided but has no secret, createAgent
    // should auto-generate one (a 48-char hex string from 24 random bytes).
    const agent = agentStore.createAgent(
      makeAgentInput({
        name: "Webhook Agent",
        triggers: { webhook: { enabled: true } },
      }),
    );
    expect(agent.triggers?.webhook?.secret).toBeDefined();
    expect(agent.triggers!.webhook!.secret).toHaveLength(48);
  });

  it("preserves an explicitly provided webhook secret", () => {
    const customSecret = "my-custom-secret-value";
    const agent = agentStore.createAgent(
      makeAgentInput({
        name: "Custom Secret Agent",
        triggers: { webhook: { enabled: true, secret: customSecret } },
      }),
    );
    expect(agent.triggers!.webhook!.secret).toBe(customSecret);
  });
});

// ===========================================================================
// getAgent
// ===========================================================================
describe("getAgent", () => {
  it("returns the created agent", () => {
    agentStore.createAgent(makeAgentInput({ name: "Findable Agent" }));

    const result = agentStore.getAgent("findable-agent");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Findable Agent");
    expect(result!.id).toBe("findable-agent");
    expect(result!.prompt).toBe("Do something useful");
  });

  it("returns null for non-existent ID", () => {
    expect(agentStore.getAgent("nonexistent-id")).toBeNull();
  });

  it("strips legacy triggers.chat block when loading a single agent", () => {
    // Same as the listAgents test but verifies getAgent also strips chat.
    const agent = agentStore.createAgent(makeAgentInput({ name: "Legacy Single" }));
    const agentFile = join(agentsDir(), `${agent.id}.json`);
    const raw = JSON.parse(readFileSync(agentFile, "utf-8"));
    raw.triggers = {
      ...raw.triggers,
      chat: {
        enabled: true,
        platforms: [{ adapter: "github", credentials: { token: "secret" } }],
      },
    };
    writeFileSync(agentFile, JSON.stringify(raw), "utf-8");

    const loaded = agentStore.getAgent(agent.id);
    expect(loaded).not.toBeNull();
    expect((loaded!.triggers as Record<string, unknown>)?.chat).toBeUndefined();
  });
});

// ===========================================================================
// updateAgent
// ===========================================================================
describe("updateAgent", () => {
  it("updates fields correctly and preserves createdAt", async () => {
    const agent = agentStore.createAgent(makeAgentInput({ name: "Update Target" }));
    const originalCreatedAt = agent.createdAt;

    // Small delay so updatedAt differs from createdAt
    await new Promise((r) => setTimeout(r, 10));

    const updated = agentStore.updateAgent("update-target", {
      prompt: "Updated prompt",
      description: "Updated description",
    });

    expect(updated).not.toBeNull();
    expect(updated!.prompt).toBe("Updated prompt");
    expect(updated!.description).toBe("Updated description");
    // createdAt must be preserved
    expect(updated!.createdAt).toBe(originalCreatedAt);
    // updatedAt should advance
    expect(updated!.updatedAt).toBeGreaterThan(originalCreatedAt);
  });

  it("handles name change (new slug) — renames file on disk", () => {
    agentStore.createAgent(makeAgentInput({ name: "Old Agent Name" }));

    const updated = agentStore.updateAgent("old-agent-name", { name: "New Agent Name" });

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe("new-agent-name");
    expect(updated!.name).toBe("New Agent Name");

    // Old file should be gone, new file should exist
    expect(() => readFileSync(join(agentsDir(), "old-agent-name.json"), "utf-8")).toThrow();
    const parsed = JSON.parse(readFileSync(join(agentsDir(), "new-agent-name.json"), "utf-8"));
    expect(parsed.name).toBe("New Agent Name");
    expect(parsed.id).toBe("new-agent-name");
  });

  it("throws on slug collision during rename", () => {
    agentStore.createAgent(makeAgentInput({ name: "Agent Alpha" }));
    agentStore.createAgent(makeAgentInput({ name: "Agent Beta" }));

    expect(() => agentStore.updateAgent("agent-alpha", { name: "Agent Beta" })).toThrow(
      'An agent with a similar name already exists ("agent-beta")',
    );
  });

  it("returns null for a non-existent ID", () => {
    expect(agentStore.updateAgent("ghost-agent", { name: "New" })).toBeNull();
  });

  it("updates tracking fields like consecutiveFailures and totalRuns", () => {
    agentStore.createAgent(makeAgentInput({ name: "Tracked Agent" }));

    const updated = agentStore.updateAgent("tracked-agent", {
      consecutiveFailures: 5,
      totalRuns: 20,
      lastRunAt: Date.now(),
      lastSessionId: "session-xyz",
    });

    expect(updated!.consecutiveFailures).toBe(5);
    expect(updated!.totalRuns).toBe(20);
    expect(updated!.lastSessionId).toBe("session-xyz");
  });

  it("does not allow overriding createdAt", () => {
    const agent = agentStore.createAgent(makeAgentInput({ name: "Immutable Create" }));
    const originalCreatedAt = agent.createdAt;

    agentStore.updateAgent("immutable-create", {
      createdAt: 0,
    } as Partial<import("./agent-types.js").AgentConfig>);

    const refreshed = agentStore.getAgent("immutable-create");
    expect(refreshed!.createdAt).toBe(originalCreatedAt);
  });
});

// ===========================================================================
// deleteAgent
// ===========================================================================
describe("deleteAgent", () => {
  it("removes the agent and returns true", () => {
    agentStore.createAgent(makeAgentInput({ name: "Delete Me Agent" }));
    expect(agentStore.deleteAgent("delete-me-agent")).toBe(true);
    expect(agentStore.getAgent("delete-me-agent")).toBeNull();
  });

  it("returns false for non-existent ID", () => {
    expect(agentStore.deleteAgent("missing-agent")).toBe(false);
  });

  it("removes the file from disk", () => {
    agentStore.createAgent(makeAgentInput({ name: "Disk Remove Agent" }));
    // File should exist before delete
    expect(() => readFileSync(join(agentsDir(), "disk-remove-agent.json"), "utf-8")).not.toThrow();

    agentStore.deleteAgent("disk-remove-agent");
    // File should be gone after delete
    expect(() => readFileSync(join(agentsDir(), "disk-remove-agent.json"), "utf-8")).toThrow();
  });

  it("does not affect other agents when deleting one", () => {
    agentStore.createAgent(makeAgentInput({ name: "Keep This Agent" }));
    agentStore.createAgent(makeAgentInput({ name: "Remove This Agent" }));

    agentStore.deleteAgent("remove-this-agent");

    expect(agentStore.getAgent("keep-this-agent")).not.toBeNull();
    expect(agentStore.listAgents()).toHaveLength(1);
  });
});

// ===========================================================================
// regenerateWebhookSecret
// ===========================================================================
describe("regenerateWebhookSecret", () => {
  it("generates a new secret that differs from the original", () => {
    const agent = agentStore.createAgent(
      makeAgentInput({
        name: "Webhook Regen Agent",
        triggers: { webhook: { enabled: true, secret: "original-secret" } },
      }),
    );
    expect(agent.triggers!.webhook!.secret).toBe("original-secret");

    const updated = agentStore.regenerateWebhookSecret("webhook-regen-agent");

    expect(updated).not.toBeNull();
    expect(updated!.triggers!.webhook!.secret).not.toBe("original-secret");
    // The new secret should be a 48-char hex string (24 random bytes)
    expect(updated!.triggers!.webhook!.secret).toHaveLength(48);
    expect(updated!.triggers!.webhook!.secret).toMatch(/^[0-9a-f]{48}$/);
  });

  it("returns null for non-existent agent", () => {
    expect(agentStore.regenerateWebhookSecret("nonexistent-agent")).toBeNull();
  });

  it("creates a webhook trigger object if none existed", () => {
    // Agent created without any triggers
    agentStore.createAgent(makeAgentInput({ name: "No Trigger Agent" }));

    const updated = agentStore.regenerateWebhookSecret("no-trigger-agent");

    expect(updated).not.toBeNull();
    expect(updated!.triggers).toBeDefined();
    expect(updated!.triggers!.webhook).toBeDefined();
    expect(updated!.triggers!.webhook!.secret).toHaveLength(48);
    // When no previous webhook existed, enabled should default to false
    expect(updated!.triggers!.webhook!.enabled).toBe(false);
  });

  it("preserves the enabled state of the webhook trigger", () => {
    agentStore.createAgent(
      makeAgentInput({
        name: "Enabled Webhook Agent",
        triggers: { webhook: { enabled: true, secret: "old-secret" } },
      }),
    );

    const updated = agentStore.regenerateWebhookSecret("enabled-webhook-agent");

    // The enabled flag should remain true even after secret regeneration
    expect(updated!.triggers!.webhook!.enabled).toBe(true);
    expect(updated!.triggers!.webhook!.secret).not.toBe("old-secret");
  });
});

// ===========================================================================
// Slugification (tested indirectly via createAgent)
// ===========================================================================
describe("slugification via createAgent", () => {
  it("converts spaces to hyphens and lowercases", () => {
    const agent = agentStore.createAgent(makeAgentInput({ name: "My Daily Agent" }));
    expect(agent.id).toBe("my-daily-agent");
  });

  it("strips special characters", () => {
    const agent = agentStore.createAgent(makeAgentInput({ name: "Check PRs! @#$%" }));
    expect(agent.id).toBe("check-prs");
  });

  it("collapses consecutive hyphens", () => {
    const agent = agentStore.createAgent(makeAgentInput({ name: "a   ---  b" }));
    expect(agent.id).toBe("a-b");
  });
});

// ===========================================================================
// Edge cases & integration
// ===========================================================================
describe("edge cases", () => {
  it("handles unicode in agent names by stripping non-alphanumeric", () => {
    // Unicode characters get stripped, leaving only alphanumeric + hyphens
    const agent = agentStore.createAgent(makeAgentInput({ name: "café résumé" }));
    expect(agent.id).toBe("caf-rsum");
  });

  it("handles very long names by preserving full slug", () => {
    const longName = "a".repeat(200);
    const agent = agentStore.createAgent(makeAgentInput({ name: longName }));
    expect(agent.id).toBe(longName.toLowerCase());
  });

  it("preserves all AgentConfig fields through create -> get round-trip", () => {
    // Every field in the AgentConfig interface should survive serialization
    const input = makeAgentInput({
      name: "Full Round Trip Agent",
      prompt: "Complex prompt\nwith newlines\nand special chars: @#$%",
      description: "A comprehensive test agent",
      icon: "robot",
      backendType: "codex",
      model: "gpt-5.3-codex",
      cwd: "/home/user/project",
      envSlug: "production",
      enabled: false,
      permissionMode: "plan",
      codexInternetAccess: true,
      allowedTools: ["Bash", "Read"],
      env: { MY_VAR: "hello" },
      branch: "feature/test",
      createBranch: true,
      useWorktree: false,
      skills: ["skill-a", "skill-b"],
      triggers: {
        webhook: { enabled: true, secret: "abc123" },
        schedule: { enabled: true, expression: "0 8 * * *", recurring: true },
      },
      container: {
        image: "ubuntu:22.04",
        ports: [3000, 8080],
        volumes: ["/data:/data"],
        initScript: "apt-get update",
      },
      mcpServers: {
        myServer: { type: "stdio" as const, command: "node", args: ["server.js"] },
      },
    });

    const created = agentStore.createAgent(input);
    const retrieved = agentStore.getAgent(created.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Full Round Trip Agent");
    expect(retrieved!.prompt).toBe(input.prompt);
    expect(retrieved!.description).toBe("A comprehensive test agent");
    expect(retrieved!.icon).toBe("robot");
    expect(retrieved!.backendType).toBe("codex");
    expect(retrieved!.model).toBe("gpt-5.3-codex");
    expect(retrieved!.cwd).toBe("/home/user/project");
    expect(retrieved!.envSlug).toBe("production");
    expect(retrieved!.enabled).toBe(false);
    expect(retrieved!.permissionMode).toBe("plan");
    expect(retrieved!.codexInternetAccess).toBe(true);
    expect(retrieved!.allowedTools).toEqual(["Bash", "Read"]);
    expect(retrieved!.env).toEqual({ MY_VAR: "hello" });
    expect(retrieved!.branch).toBe("feature/test");
    expect(retrieved!.createBranch).toBe(true);
    expect(retrieved!.useWorktree).toBe(false);
    expect(retrieved!.skills).toEqual(["skill-a", "skill-b"]);
    expect(retrieved!.triggers!.webhook!.enabled).toBe(true);
    expect(retrieved!.triggers!.webhook!.secret).toBe("abc123");
    expect(retrieved!.triggers!.schedule!.enabled).toBe(true);
    expect(retrieved!.triggers!.schedule!.expression).toBe("0 8 * * *");
    expect(retrieved!.triggers!.schedule!.recurring).toBe(true);
    expect(retrieved!.container!.image).toBe("ubuntu:22.04");
    expect(retrieved!.container!.ports).toEqual([3000, 8080]);
    expect(retrieved!.container!.volumes).toEqual(["/data:/data"]);
    expect(retrieved!.container!.initScript).toBe("apt-get update");
    expect(retrieved!.mcpServers!.myServer).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });
    expect(retrieved!.consecutiveFailures).toBe(0);
    expect(retrieved!.totalRuns).toBe(0);
  });

  it("can create multiple agents and list them all", () => {
    for (let i = 0; i < 10; i++) {
      agentStore.createAgent(makeAgentInput({ name: `Agent ${i}` }));
    }
    expect(agentStore.listAgents()).toHaveLength(10);
  });

  it("handles delete then re-create of same name", () => {
    agentStore.createAgent(makeAgentInput({ name: "Recyclable Agent" }));
    agentStore.deleteAgent("recyclable-agent");
    // Should not throw — slot is now free
    const agent = agentStore.createAgent(makeAgentInput({ name: "Recyclable Agent" }));
    expect(agent.id).toBe("recyclable-agent");
  });

  it("defaults description and cwd to empty string when not provided", () => {
    const agent = agentStore.createAgent(
      makeAgentInput({
        name: "Minimal Agent",
        description: undefined,
        cwd: undefined,
      }),
    );
    expect(agent.description).toBe("");
    expect(agent.cwd).toBe("");
  });
});

