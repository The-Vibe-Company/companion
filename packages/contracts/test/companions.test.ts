import { describe, expect, it } from "vitest";
import {
  COMPANION_HUB_TOKEN_SCOPES,
  COMPANION_CONFIG_PROPOSAL_MAX_IDS,
  COMPANION_CONTROL_PROPOSAL_MAX_BYTES,
  COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS,
  COMPANION_PROVIDER_CATALOG,
  COMPANION_PROVIDER_SUPPLEMENTARY_MODELS,
  COMPANION_REASONING_MAX_CHARACTERS,
  COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS,
  COMPANION_TRIGGER_NAME_MAX_CHARACTERS,
  COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS,
  companionConfigProposalMessageSchema,
  companionConfigProposalSchema,
  companionControlProposalSchema,
  companionDecisionSchema,
  companionRoutineProposalMessageSchema,
  companionRoutineProposalSchema,
  companionRoutineSchema,
  companionRoutineRunDetailSchema,
  companionRoutineRunDetailQuerySchema,
  companionRoutineRunListQuerySchema,
  companionRoutineRunSummarySchema,
  companionRequestRoutineChangeInputSchema,
  companionRequestTriggerChangeInputSchema,
  companionTriggerProposalMessageSchema,
  companionTriggerProposalSchema,
  companionTriggerRunDetailSchema,
  companionTriggerRunSummarySchema,
  companionTriggerSchema,
  createCompanionTriggerInputSchema,
  updateCompanionTriggerInputSchema,
  companionProviderOAuthCompleteInputSchema,
  companionProviderOAuthStartInputSchema,
  companionDesktopSchema,
  companionLastMessageSchema,
  companionMcpAccountSchema,
  companionMcpCredentialSchema,
  companionMessageEventId,
  companionSchema,
  companionThreadSchema,
  companionToolRunSchema,
  companionTranscriptEntrySchema,
  companionSharesSchema,
  createCompanionInputSchema,
  saveCompanionProviderInputSchema,
  saveCompanionPluginInputSchema,
  sendCompanionMessageAcceptedResponseSchema,
  sendCompanionMessageInputSchema,
  setCompanionWorkspaceShareInputSchema,
  supplementCompanionProviderModels,
  updateCompanionInputSchema,
  updateCompanionMemberStateInputSchema,
  assignCompanionSectionInputSchema,
  companionSectionSchema,
  createCompanionSectionInputSchema,
  reorderCompanionSectionsInputSchema,
} from "../src/companions";
import { restartCompanionRuntimeInputSchema } from "../src/companionRuntime";
import { companionToolRunKind } from "../src/companionToolKinds";

describe("Companion provider contracts", () => {
  it("accepts a maximum-length automation prompt inside a bounded control envelope", () => {
    const proposal = companionControlProposalSchema.parse({
      kind: "control",
      request_kind: "routine_change",
      action: "create",
      summary: "Create the routine",
      payload: {
        action: "create",
        draft: {
          name: "Maximum prompt",
          prompt: "p".repeat(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS),
          cron: "0 9 * * *",
          timezone: "Europe/Paris",
        },
      },
    });

    expect(Buffer.byteLength(JSON.stringify(proposal), "utf8"))
      .toBeLessThanOrEqual(COMPANION_CONTROL_PROPOSAL_MAX_BYTES);
    expect(() => companionControlProposalSchema.parse({
      ...proposal,
      payload: { arbitrary: "\0".repeat(22_000) },
    })).toThrow("control proposal exceeds 128 KiB");
  });

  it("requires ids for existing automation and complete drafts for creation", () => {
    const routineId = "11111111-1111-4111-8111-111111111111";
    const triggerId = "22222222-2222-4222-8222-222222222222";
    const routineDraft = {
      name: "Morning brief",
      prompt: "Prepare the daily brief.",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Paris",
    };
    const triggerDraft = { name: "Issue update", prompt: "Summarize the incoming issue." };

    expect(companionRequestRoutineChangeInputSchema.safeParse({ action: "create" }).success).toBe(false);
    expect(companionRequestRoutineChangeInputSchema.safeParse({
      action: "create", draft: { name: "Incomplete" },
    }).success).toBe(false);
    expect(companionRequestRoutineChangeInputSchema.safeParse({ action: "update", routine_id: routineId }).success)
      .toBe(false);
    expect(companionRequestRoutineChangeInputSchema.safeParse({ action: "enable" }).success).toBe(false);
    expect(companionRequestRoutineChangeInputSchema.safeParse({ action: "create", draft: routineDraft }).success)
      .toBe(true);
    expect(companionRequestRoutineChangeInputSchema.safeParse({
      action: "update", routine_id: routineId, draft: { prompt: "Updated prompt." },
    }).success).toBe(true);

    expect(companionRequestTriggerChangeInputSchema.safeParse({ action: "create" }).success).toBe(false);
    expect(companionRequestTriggerChangeInputSchema.safeParse({
      action: "create", draft: { name: "Incomplete" },
    }).success).toBe(false);
    expect(companionRequestTriggerChangeInputSchema.safeParse({ action: "update", trigger_id: triggerId }).success)
      .toBe(false);
    expect(companionRequestTriggerChangeInputSchema.safeParse({ action: "rotate_secret" }).success).toBe(false);
    expect(companionRequestTriggerChangeInputSchema.safeParse({ action: "create", draft: triggerDraft }).success)
      .toBe(true);
    expect(companionRequestTriggerChangeInputSchema.safeParse({
      action: "disable", trigger_id: triggerId,
    }).success).toBe(true);
  });

  it("bounds owner sections and requires exact, unique reorder membership", () => {
    expect(createCompanionSectionInputSchema.parse({ name: "  Work  " })).toEqual({ name: "Work" });
    expect(assignCompanionSectionInputSchema.parse({ section_id: null })).toEqual({ section_id: null });
    expect(() => assignCompanionSectionInputSchema.parse({})).toThrow();
    expect(() => reorderCompanionSectionsInputSchema.parse({
      section_ids: [
        "11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-111111111111",
      ],
    })).toThrow();
    expect(companionSectionSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      org_id: "22222222-2222-4222-8222-222222222222",
      owner_id: "user-1",
      name: "Work",
      position: 0,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:00:00.000Z",
    }).name).toBe("Work");
  });
  it("keeps API keys write-only and removes browser-submitted subscription credentials", () => {
    expect(saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "sk-test",
    })).toEqual({ auth_method: "api_key", credential: "sk-test" });
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "subscription",
      credential: { type: "oauth", access: "token", refresh: "refresh", expires: 123 },
    })).toThrow();
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "line-one\nline-two",
    })).toThrow();
  });

  it("pins Pi's Kimi, Moonshot, OpenAI, and Google API-key providers", () => {
    expect(COMPANION_PROVIDER_CATALOG).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "kimi-coding", auth_methods: ["api_key"] }),
      expect.objectContaining({ id: "moonshotai", auth_methods: ["api_key"] }),
      expect.objectContaining({ id: "openai", auth_methods: ["api_key"] }),
      expect.objectContaining({ id: "google", auth_methods: ["api_key"] }),
    ]));
  });

  it("pins at least one Pi model and exactly one default for every provider", () => {
    for (const provider of COMPANION_PROVIDER_CATALOG) {
      expect(provider.models.length).toBeGreaterThanOrEqual(1);
      expect(provider.models.filter((model) => model.default)).toHaveLength(1);
    }
  });

  it("supplements the z.ai fallback without overriding later Pi metadata", () => {
    const zaiFallback = COMPANION_PROVIDER_CATALOG.find((provider) => provider.id === "zai");
    expect(zaiFallback?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        input: ["text", "image"],
      }),
    ]));
    expect(COMPANION_PROVIDER_SUPPLEMENTARY_MODELS.zai).toEqual([
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image"] },
    ]);

    expect(supplementCompanionProviderModels("zai", [
      { id: "glm-5.3-flash", name: "Pi GLM-5.3-Flash", input: ["text", "image"] },
      { id: "glm-5.3", name: "GLM-5.3", default: true },
    ])).toEqual([
      { id: "glm-5.3-flash", name: "Pi GLM-5.3-Flash", input: ["text", "image"] },
      { id: "glm-5.3", name: "GLM-5.3", default: true },
    ]);
  });

  it("starts only native Claude/Codex subscription login and accepts one-time codes only", () => {
    expect(companionProviderOAuthStartInputSchema.parse({
      provider_id: "anthropic",
    })).toEqual({ provider_id: "anthropic" });
    expect(companionProviderOAuthStartInputSchema.parse({
      provider_id: "openai-codex",
    })).toEqual({ provider_id: "openai-codex" });
    expect(() => companionProviderOAuthStartInputSchema.parse({
      provider_id: "zai",
    })).toThrow();
    expect(companionProviderOAuthCompleteInputSchema.parse({
      authorization_code: "one-time-code",
    })).toEqual({ authorization_code: "one-time-code" });
    expect(() => companionProviderOAuthCompleteInputSchema.parse({
      authorization_code: "{\"type\":\n\"oauth\"}",
    })).toThrow();
  });

  it("selects a provider at creation and rejects model credentials on start", () => {
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
      model_id: "claude-opus-4-8",
    })).toMatchObject({ provider_id: "anthropic", model_id: "claude-opus-4-8" });
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
      model_id: "claude-sonnet-5",
      selected_skill_ids: ["11111111-1111-4111-8111-111111111111"],
    })).toMatchObject({
      selected_skill_ids: ["11111111-1111-4111-8111-111111111111"],
    });
    // Skills Hub access is unconditional, so creation has nothing to say about it.
    expect(() => createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
      can_write_skills: true,
    })).toThrow();
    expect(createCompanionInputSchema.parse({
      name: "Luna",
      persona: "  Content marketing assistant  ",
      provider_id: "anthropic",
    })).toMatchObject({ persona: "Content marketing assistant" });
    expect(() => createCompanionInputSchema.parse({
      name: "Luna",
      persona: "x".repeat(281),
    })).toThrow();
    expect(() => createCompanionInputSchema.parse({
      name: "Luna",
      system_prompt: "not part of creation",
    })).toThrow();
  });

  it("accepts only the temporary Pi-only runtime restart", () => {
    expect(restartCompanionRuntimeInputSchema.parse({ target: "pi" })).toEqual({ target: "pi" });
    expect(() => restartCompanionRuntimeInputSchema.parse({ target: "box" })).toThrow();
    expect(() => restartCompanionRuntimeInputSchema.parse({ target: "server" })).toThrow();
    expect(() => restartCompanionRuntimeInputSchema.parse({ target: "pi", wake: true })).toThrow();
    expect(() => restartCompanionRuntimeInputSchema.parse({ target: "pi", continuation: true })).toThrow();
  });

  it("persists skill selection on update and refuses Skills Hub access fields", () => {
    expect(updateCompanionInputSchema.parse({
      selected_skill_ids: [],
    })).toEqual({ selected_skill_ids: [] });
    // Neither field is configurable any more: every Companion holds the whole Skills Hub scope set.
    expect(() => updateCompanionInputSchema.parse({ can_write_skills: false })).toThrow();
    expect(() => updateCompanionInputSchema.parse({
      hub_access: { skills_read: true },
    })).toThrow();
    expect(updateCompanionInputSchema.parse({
      selected_mcp_account_ids: ["22222222-2222-4222-8222-222222222222"],
    })).toEqual({
      selected_mcp_account_ids: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(updateCompanionInputSchema.parse({
      selected_mcp_account_ids: [],
    })).toEqual({ selected_mcp_account_ids: [] });
    expect(() => updateCompanionInputSchema.parse({})).toThrow();
  });

  it("accepts member-state patches for pin, hide, and unread", () => {
    expect(updateCompanionMemberStateInputSchema.parse({ pinned: true })).toEqual({ pinned: true });
    expect(updateCompanionMemberStateInputSchema.parse({ muted: true })).toEqual({ muted: true });
    expect(updateCompanionMemberStateInputSchema.parse({
      hidden: true,
      unread: false,
    })).toEqual({ hidden: true, unread: false });
    expect(() => updateCompanionMemberStateInputSchema.parse({})).toThrow();
    expect(() => updateCompanionMemberStateInputSchema.parse({ pinned: true, share: "no" })).toThrow();
  });

  it("accepts MCP plugin selection on create", () => {
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
      model_id: "claude-opus-4-8",
      selected_mcp_account_ids: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
    })).toMatchObject({
      selected_mcp_account_ids: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
    });
  });

  it("accepts only the editable Companion settings and supports clearing instructions", () => {
    expect(updateCompanionInputSchema.parse({
      name: "Luna research",
      persona: null,
      provider_id: "openai-codex",
      model_id: "gpt-5.5",
    })).toEqual({
      name: "Luna research",
      persona: null,
      provider_id: "openai-codex",
      model_id: "gpt-5.5",
    });
    expect(updateCompanionInputSchema.parse({
      provider_id: "openai-codex",
      model_id: "gpt-5.6-sol",
    })).toMatchObject({ model_id: "gpt-5.6-sol" });
    expect(() => updateCompanionInputSchema.parse({})).toThrow();
    expect(() => updateCompanionInputSchema.parse({ owner_id: "user-2" })).toThrow();
  });

  it("mints the whole Skills Hub scope set and never a secrets:write or install capability", () => {
    expect([...COMPANION_HUB_TOKEN_SCOPES]).toEqual([
      "skills:read",
      "skills:write",
      "secrets:read",
      "database:read",
      "database:write",
    ]);
    expect(COMPANION_HUB_TOKEN_SCOPES).not.toContain("secrets:write");
    expect(COMPANION_HUB_TOKEN_SCOPES).not.toContain("public-skills:install");
  });
});

describe("Companion runtime injection contract", () => {
  it("validates the compact write-only Plugins form for both adapter transports", () => {
    expect(saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "work",
      transport: "http",
      url: "https://mcp.example.test/github",
      credential_name: "Authorization",
      credential_value: "Bearer secret",
    })).toMatchObject({ provider: "github", label: "work", args: [] });
    expect(saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "personal",
      transport: "stdio",
      command: "github-mcp-server",
      args: ["stdio"],
      credential_name: "GITHUB_TOKEN",
      credential_value: "secret",
    })).toMatchObject({ transport: "stdio" });
    expect(() => saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "work",
      transport: "http",
      credential_name: "Authorization",
    })).toThrow();
    expect(() => saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "work",
      transport: "stdio",
      command: "github-mcp-server",
      credential_name: "NOT-AN-ENV",
      credential_value: "secret",
    })).toThrow();
  });

  it("keeps internal MCP material schemas outside public lifecycle contracts", () => {
    expect(companionMcpCredentialSchema.parse({
      env_key: "GITHUB_WORK",
      value: "work-secret",
    })).toMatchObject({ env_key: "GITHUB_WORK" });
    expect(companionMcpAccountSchema.parse({
      id: "github-work",
      label: "GitHub work",
      transport: "stdio",
      command: "github-mcp-server",
      env: { GITHUB_TOKEN: "GITHUB_WORK" },
    })).toMatchObject({ transport: "stdio" });
  });
});

describe("Companion chat contracts", () => {
  const clientMessageId = "33333333-3333-4333-8333-333333333333";

  it("trims one message and rejects empty or oversized content", () => {
    expect(sendCompanionMessageInputSchema.parse({
      content: "  Ship it  ",
      client_message_id: clientMessageId,
    })).toEqual({
      content: "Ship it",
      client_message_id: clientMessageId,
      client_surface: "web",
    });
    expect(() => sendCompanionMessageInputSchema.parse({
      content: "   ",
      client_message_id: clientMessageId,
    })).toThrow();
    expect(() => sendCompanionMessageInputSchema.parse({
      content: "x".repeat(16_385),
      client_message_id: clientMessageId,
    })).toThrow();
    // A thread carries no harness controls, so no client can smuggle tools into a message.
    expect(() => sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      client_message_id: clientMessageId,
      tools: ["bash"],
    })).toThrow();
  });

  it("lets a send name the turn it creates, and only as an id", () => {
    // One send, one id: the control plane stores the turn a resent request names once, so the id has
    // to survive parsing intact and anything that is not one is refused before persistence.
    expect(sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      client_message_id: clientMessageId,
    })).toEqual({
      content: "Ship it",
      client_message_id: clientMessageId,
      client_surface: "web",
    });
    expect(sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      client_message_id: clientMessageId,
      client_surface: "native_mobile",
    }).client_surface).toBe("native_mobile");
    expect(() => sendCompanionMessageInputSchema.parse({ content: "Ship it" })).toThrow();
    expect(() => sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      client_message_id: "pi:512",
    })).toThrow();
  });

  it("keeps sent messages and projected Pi events in separate id namespaces", () => {
    // The composer shows a message under the id the control plane will store it under, so the two
    // must agree and neither may be able to name an entry the Pi log will claim later.
    expect(companionMessageEventId("33333333-3333-4333-8333-333333333333"))
      .toBe("msg:33333333-3333-4333-8333-333333333333");
  });

  it("bounds the asynchronous send acknowledgement to the accepted turn", () => {
    const turn = {
      id: "22222222-2222-4222-8222-222222222222",
      companion_id: "11111111-1111-4111-8111-111111111111",
      client_message_id: clientMessageId,
      status: "queued",
      queue_sequence: 1,
      latest_attempt: null,
      replying: false,
      error: null,
      state_changed_at: "2026-08-17T00:00:00.000Z",
      settled_at: null,
      created_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z",
    };
    expect(sendCompanionMessageAcceptedResponseSchema.parse({ turn })).toEqual({ turn });
    expect(() => sendCompanionMessageAcceptedResponseSchema.parse({ turn, thread: {} })).toThrow();
  });

  it("describes one thread per Companion with its run boundary and message authors", () => {
    const thread = companionThreadSchema.parse({
      companion_id: "11111111-1111-4111-8111-111111111111",
      viewer_id: "user-2",
      access: "viewer",
      read_only: true,
      can_send: false,
      entries: [{
        event_id: "msg:1",
        ordinal: 0,
        role: "user",
        content: "Hello",
        author_id: "user-1",
        author_name: "Owner",
        created_at: "2026-08-12T12:00:00.000Z",
      }, {
        event_id: "pi:0",
        ordinal: 1,
        role: "assistant",
        content: "Hi",
        author_id: null,
        author_name: null,
        created_at: "2026-08-12T12:00:01.000Z",
      }],
      active_turn: null,
      queued_count: 0,
      interrupted_turn: null,
      last_message_at: "2026-08-12T12:00:00.000Z",
    });

    expect(thread.read_only).toBe(true);
    expect(thread.can_send).toBe(false);
    // The reader is not the author, so the surface can attribute the message to the Owner.
    expect(thread.entries[0]?.author_id).not.toBe(thread.viewer_id);
    expect(thread.entries[1]?.author_id).toBeNull();
    // A message is not a tool run, and the thread says so rather than leaving the field absent.
    expect(thread.entries[0]?.tool).toBeNull();
    expect(thread.entries[0]?.queued).toBe(false);
    expect(thread.entries[0]?.turn_id).toBeNull();
  });

  it("carries earlier routine notifications inside the latest server-projected group", () => {
    const parsed = companionTranscriptEntrySchema.parse({
      event_id: "routine-return:22222222-2222-4222-8222-222222222222",
      ordinal: 3,
      role: "assistant",
      content: "Skills Hub: 1.87.0 → 1.88.0.",
      author_id: null,
      author_name: null,
      routine_notify_group: {
        routine_name: "Skills Hub",
        total_count: 2,
        hidden_entries: [{
          event_id: "msg:routine-1",
          ordinal: 0,
          role: "user",
          content: "Check for updates.",
          author_id: "user-1",
          author_name: "Owner",
          routine: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Skills Hub",
            run_id: "33333333-3333-4333-8333-333333333333",
          },
          turn_id: "33333333-3333-4333-8333-333333333333",
          created_at: "2026-08-11T12:00:00.000Z",
        }, {
          event_id: "routine-return:33333333-3333-4333-8333-333333333333",
          ordinal: 1,
          role: "assistant",
          content: "Skills Hub: 1.86.0 → 1.87.0.",
          author_id: null,
          author_name: null,
          created_at: "2026-08-11T12:00:01.000Z",
        }],
      },
      created_at: "2026-08-12T12:00:01.000Z",
    });

    expect(parsed.routine_notify_group).toMatchObject({
      routine_name: "Skills Hub",
      total_count: 2,
    });
    expect(parsed.routine_notify_group?.hidden_entries.map((entry) => entry.event_id)).toEqual([
      "msg:routine-1",
      "routine-return:33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("lets a user message name its queued turn and refuses that on any other role", () => {
    const turnId = "22222222-2222-4222-8222-222222222222";
    expect(companionTranscriptEntrySchema.parse({
      event_id: "msg:1",
      ordinal: 0,
      role: "user",
      content: "Follow up",
      author_id: "user-1",
      author_name: null,
      turn_id: turnId,
      queued: true,
      created_at: "2026-08-12T12:00:00.000Z",
    })).toMatchObject({ turn_id: turnId, queued: true });
    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "pi:0",
      ordinal: 1,
      role: "assistant",
      content: "Hi",
      author_id: null,
      author_name: null,
      queued: true,
      created_at: "2026-08-12T12:00:01.000Z",
    })).toThrow();
  });

  it("carries reasoning only on a reply, and absent means none", () => {
    const reply = {
      event_id: "pi:512",
      ordinal: 4,
      role: "assistant" as const,
      content: "Two services timed out.",
      author_id: null,
      author_name: null,
      created_at: "2026-08-12T12:00:03.000Z",
    };

    expect(companionTranscriptEntrySchema.parse({ ...reply, reasoning: "checked the logs" }).reasoning)
      .toBe("checked the logs");
    // An entry stored before this column existed reads back as a reply with nothing to disclose,
    // not as one whose disclosure is missing.
    expect(companionTranscriptEntrySchema.parse(reply).reasoning).toBeNull();
    // Thinking belongs to the turn that produced it; nothing else in the thread may claim any.
    expect(() => companionTranscriptEntrySchema.parse({
      ...reply,
      role: "user",
      author_id: "user-1",
      reasoning: "checked the logs",
    })).toThrow();
    expect(() => companionTranscriptEntrySchema.parse({
      ...reply,
      reasoning: "t".repeat(COMPANION_REASONING_MAX_CHARACTERS + 1),
    })).toThrow();
  });

  it("carries a tool run only on a tool entry", () => {
    const run = {
      call_id: "call_1",
      kind: "shell" as const,
      name: "bash",
      title: "ls -la",
      status: "ok" as const,
      detail: '{"command":"ls -la"}',
      screenshot: null,
    };

    expect(companionTranscriptEntrySchema.parse({
      event_id: "pi:512:tool:0",
      ordinal: 2,
      role: "tool",
      content: "ls -la",
      author_id: null,
      author_name: null,
      tool: run,
      created_at: "2026-08-12T12:00:02.000Z",
    }).tool).toMatchObject({ kind: "shell", status: "ok" });

    // A tool entry with nothing to report, and a reply smuggling a chip, are both incoherent.
    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "pi:512:tool:0",
      ordinal: 2,
      role: "tool",
      content: "ls -la",
      author_id: null,
      author_name: null,
      created_at: "2026-08-12T12:00:02.000Z",
    })).toThrow();
    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "pi:512",
      ordinal: 2,
      role: "assistant",
      content: "Listing the repository.",
      author_id: null,
      author_name: null,
      tool: run,
      created_at: "2026-08-12T12:00:02.000Z",
    })).toThrow();
  });

  it("keeps a permission card coupled to the decision role", () => {
    const decision = {
      request_id: "ui-1",
      kind: "shell" as const,
      name: "bash",
      title: "ls -la",
      detail: "ls -la",
      status: "pending" as const,
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: "2026-08-12T12:05:00.000Z",
    };

    expect(companionTranscriptEntrySchema.parse({
      event_id: "decision:ui-1",
      ordinal: 3,
      role: "decision",
      content: "ls -la",
      author_id: null,
      author_name: null,
      decision,
      created_at: "2026-08-12T12:00:03.000Z",
    }).decision).toMatchObject({ kind: "shell", status: "pending" });

    expect(companionTranscriptEntrySchema.parse({
      event_id: "decision:ui-1",
      ordinal: 3,
      role: "decision",
      content: "ls -la",
      author_id: null,
      author_name: null,
      decision: {
        ...decision,
        status: "cancelled",
        decided_at: "2026-08-12T12:01:00.000Z",
      },
      created_at: "2026-08-12T12:00:03.000Z",
    }).decision).toMatchObject({ kind: "shell", status: "cancelled" });

    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "decision:ui-1",
      ordinal: 3,
      role: "decision",
      content: "ls -la",
      author_id: null,
      author_name: null,
      created_at: "2026-08-12T12:00:03.000Z",
    })).toThrow();
    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "pi:512",
      ordinal: 3,
      role: "assistant",
      content: "Listing.",
      author_id: null,
      author_name: null,
      decision,
      created_at: "2026-08-12T12:00:03.000Z",
    })).toThrow();
  });

  it("carries a routine origin only on a user message", () => {
    expect(companionTranscriptEntrySchema.parse({
      event_id: "msg:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ordinal: 1,
      role: "user",
      content: "Write the standup.",
      author_id: "user-1",
      author_name: "Ada",
      routine: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Standup" },
      created_at: "2026-08-19T09:00:00.000Z",
    }).routine).toEqual({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Standup" });
    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "pi:1",
      ordinal: 2,
      role: "assistant",
      content: "Standup drafted.",
      author_id: null,
      author_name: null,
      routine: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Standup" },
      created_at: "2026-08-19T09:00:01.000Z",
    })).toThrow();
  });

  it("accepts a bounded config proposal and refuses mixed or oversized payloads", () => {
    const skillId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const pluginId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const valid = companionConfigProposalSchema.parse({
      kind: "config",
      add_skill_ids: [skillId],
      model_id: "claude-sonnet-4-6",
    });
    expect(valid).toEqual({
      kind: "config",
      add_skill_ids: [skillId],
      model_id: "claude-sonnet-4-6",
    });
    expect(companionConfigProposalSchema.parse({
      kind: "config",
      connect_plugin: { server_name: "linear", reason: "Need issue search" },
    }).connect_plugin).toEqual({ server_name: "linear", reason: "Need issue search" });
    expect(companionConfigProposalSchema.parse({
      kind: "config",
      connect_plugin: { server_name: "slack", reason: "Send the release update" },
    }).connect_plugin).toEqual({ server_name: "slack", reason: "Send the release update" });
    expect(companionConfigProposalSchema.parse({
      kind: "config",
      connect_plugin: { server_name: "gmail", reason: "Need an email draft" },
    }).connect_plugin).toEqual({ server_name: "gmail", reason: "Need an email draft" });
    expect(companionConfigProposalSchema.parse({
      kind: "config",
      connect_plugin: { server_name: "sentry", reason: "Investigate the production error" },
    }).connect_plugin).toEqual({
      server_name: "sentry",
      reason: "Investigate the production error",
    });
    expect(companionConfigProposalMessageSchema.parse({
      summary: "Add the search skill and switch to Sonnet",
      proposal: valid,
    }).summary).toBe("Add the search skill and switch to Sonnet");

    expect(() => companionConfigProposalSchema.parse({
      kind: "config",
      add_skill_ids: [skillId],
      connect_plugin: { server_name: "github" },
    })).toThrow();
    expect(() => companionConfigProposalSchema.parse({
      kind: "config",
      can_write_skills: true,
      add_skill_ids: [skillId],
    })).toThrow();
    expect(() => companionConfigProposalSchema.parse({
      kind: "config",
      hub_access: { skills_read: true },
      persona: "helpful",
    })).toThrow();
    expect(() => companionConfigProposalSchema.parse({
      kind: "config",
      name: "renamed",
      persona: "helpful",
    })).toThrow();
    expect(() => companionConfigProposalSchema.parse({ kind: "config" })).toThrow();
    expect(() => companionConfigProposalSchema.parse({
      kind: "config",
      add_skill_ids: Array.from({ length: COMPANION_CONFIG_PROPOSAL_MAX_IDS + 1 }, () => skillId),
    })).toThrow();
    expect(() => companionConfigProposalSchema.parse({
      kind: "config",
      attach_plugin_ids: [pluginId],
      extra: true,
    })).toThrow();
    expect(() => companionConfigProposalSchema.parse({
      kind: "config",
      persona: "x".repeat(281),
    })).toThrow();

    const decision = {
      request_id: "ui-config-1",
      kind: "config" as const,
      name: "propose_config",
      title: "Add the search skill",
      detail: "Add the search skill",
      status: "pending" as const,
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: "2026-08-12T12:05:00.000Z",
      proposal: valid,
    };
    expect(companionDecisionSchema.parse(decision).proposal).toEqual(valid);
    expect(companionDecisionSchema.parse({
      ...decision,
      kind: "question",
      name: "ask_user",
      proposal: undefined,
    }).proposal).toBeNull();
    expect(() => companionDecisionSchema.parse({ ...decision, proposal: null })).toThrow();
    expect(() => companionDecisionSchema.parse({
      ...decision,
      kind: "shell",
      name: "bash",
    })).toThrow();
  });

  it("accepts a bounded routine proposal and rejects a card that mixes kinds", () => {
    const proposal = companionRoutineProposalSchema.parse({
      kind: "routine",
      name: "Standup",
      prompt: "Write the standup.",
      cron: "0 9 * * 1-5",
      timezone: "America/New_York",
    });
    expect(companionRoutineProposalMessageSchema.parse({
      summary: "Schedule Standup each weekday at 9am",
      proposal,
    }).proposal.name).toBe("Standup");
    expect(() => companionRoutineProposalSchema.parse({
      kind: "routine",
      name: "Standup",
      prompt: "Write the standup.",
      cron: "0 9 * * 1-5",
      timezone: "America/New_York",
      extra: true,
    })).toThrow();
    const decision = {
      request_id: "ui-routine-1",
      kind: "routine" as const,
      name: "routine",
      title: "Schedule Standup",
      detail: "Schedule Standup each weekday at 9am",
      status: "pending" as const,
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: "2026-08-19T12:05:00.000Z",
      proposal,
    };
    expect(companionDecisionSchema.parse(decision).proposal).toEqual(proposal);
    expect(() => companionDecisionSchema.parse({ ...decision, proposal: null })).toThrow();
    expect(companionRoutineSchema.parse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companion_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Standup",
      prompt: "Write the standup.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      enabled: true,
      next_fire_at: "2026-08-20T09:00:00.000Z",
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: "2026-08-19T12:00:00.000Z",
      updated_at: "2026-08-19T12:00:00.000Z",
    }).name).toBe("Standup");
  });

  it("keeps surfaced routine payloads out of the private run transcript contract", () => {
    const summary = companionRoutineRunSummarySchema.parse({
      run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companion_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      routine: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        name: "Standup",
      },
      status: "succeeded",
      outcome: "surfaced",
      surface_mode: "notify",
      main_entry_event_id: "routine-return:notice",
      relay_turn_id: null,
      created_at: "2026-08-19T12:00:00.000Z",
      started_at: "2026-08-19T12:00:01.000Z",
      settled_at: "2026-08-19T12:00:10.000Z",
      error: null,
    });
    expect(summary.surface_mode).toBe("notify");
    expect(summary.recovery_status).toBeUndefined();
    expect(companionRoutineRunSummarySchema.parse({
      ...summary,
      status: "interrupted",
      outcome: "error",
      surface_mode: null,
      main_entry_event_id: null,
      error: {
        code: "turn_stalled",
        message: "The routine stopped making progress.",
        action: "retry",
      },
      recovery_status: "future_cleanup_phase",
    }).recovery_status).toBeNull();
    expect(companionRoutineRunDetailSchema.parse({
      ...summary,
      internal_entries: [{
        event_id: "routine:work:1",
        ordinal: 0,
        role: "assistant",
        content: "Checked the deployment before returning.",
        reasoning: null,
        created_at: "2026-08-19T12:00:09.000Z",
      }],
      next_entry_cursor: null,
    }).internal_entries).toHaveLength(1);
    expect(() => companionRoutineRunDetailSchema.parse({
      ...summary,
      internal_entries: [],
      next_entry_cursor: null,
      surfaced_payload: "This belongs only in the main thread.",
    })).toThrow();
    expect(() => companionRoutineRunSummarySchema.parse({
      ...summary,
      surface_mode: "relay",
      relay_turn_id: null,
    })).toThrow();
    expect(() => companionRoutineRunSummarySchema.parse({
      ...summary,
      outcome: "no_output",
      surface_mode: null,
      main_entry_event_id: null,
      status: "failed",
    })).toThrow();
    expect(() => companionRoutineRunSummarySchema.parse({
      ...summary,
      surface_mode: null,
    })).toThrow();
    expect(() => companionRoutineRunSummarySchema.parse({
      ...summary,
      main_entry_event_id: null,
    })).toThrow();
    expect(companionRoutineRunListQuerySchema.parse({}).limit).toBe(50);
    expect(companionRoutineRunListQuerySchema.parse({
      cursor: summary.run_id,
    }).cursor).toBe(summary.run_id);
    expect(() => companionRoutineRunListQuerySchema.parse({ limit: 101 })).toThrow();
    expect(companionRoutineRunDetailQuerySchema.parse({})).toEqual({
      entry_limit: 50,
    });
    expect(companionRoutineRunDetailQuerySchema.parse({
      entry_limit: "25",
      entry_cursor: "7",
    })).toEqual({ entry_limit: 25, entry_cursor: 7 });
    expect(() => companionRoutineRunDetailQuerySchema.parse({ entry_limit: 101 })).toThrow();
  });

  it("accepts a Box frame only as an inline image and never as a URL a browser would fetch", () => {
    const frame = (screenshot: string) => companionToolRunSchema.parse({
      call_id: null,
      kind: "computer",
      name: "computer",
      title: "screenshot",
      status: "ok",
      detail: null,
      screenshot,
    });

    expect(frame("data:image/jpeg;base64,/9j/4AAQSkZJRg==").screenshot).toContain("data:image/jpeg");

    // The transcript hands this straight to an `img`, so anything that could reach out of the page —
    // or run in it — is refused here rather than trusted because the control plane wrote it.
    expect(() => frame("https://example.test/frame.jpg")).toThrow();
    expect(() => frame("javascript:alert(1)")).toThrow();
    expect(() => frame("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toThrow();
    // One downscaled still, not a recording: an oversized frame is refused, not truncated.
    expect(() => frame(`data:image/jpeg;base64,${"A".repeat(
      COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS,
    )}`)).toThrow();
  });

  it("names a delegated run, whatever Pi calls the tool that launched it", () => {
    expect(companionToolRunSchema.parse({
      call_id: null,
      kind: "subagent",
      name: "subagent",
      title: "researcher: read the changelog",
      status: "running",
      detail: "read the changelog",
      screenshot: null,
    }).kind).toBe("subagent");

    for (const name of ["subagent", "run_subagent", "Subagents", "spawn-subagent"]) {
      expect(companionToolRunKind(name)).toBe("subagent");
    }
    // The catalog it sits in front of still classifies everything it classified before.
    expect(companionToolRunKind("bash")).toBe("shell");
    expect(companionToolRunKind("run_command")).toBe("shell");
    expect(companionToolRunKind("read_file")).toBe("file");
    expect(companionToolRunKind("web_search")).toBe("browse");
    expect(companionToolRunKind("stargazer")).toBe("tool");
  });
});

describe("Companion desktop contract", () => {
  it("names Lux as the only computer-use surface and allows a provisioning desktop", () => {
    expect(companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
    })).toMatchObject({ automation: "lux" });
    expect(companionDesktopSchema.parse({
      desktop_url: null,
      provisioning: true,
      automation: "lux",
      transport: null,
    }).desktop_url).toBeNull();
    // A second computer-use surface cannot be introduced through this payload.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "vnc",
      transport: "vnc",
    })).toThrow();
    // Nothing else travels with a secret-bearing URL.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
      box_token: "must-not-enter-the-contract",
    })).toThrow();
  });

  it("names the stream this mint got, and only a stream Box actually offers", () => {
    // The two Box desktop streams: VNC is asked for first, WebRTC is the fallback.
    expect(companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "webrtc",
    }).transport).toBe("webrtc");
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "screenshots",
    })).toThrow();
    // A URL always came over one of them, so the surface is never left to infer which.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
    })).toThrow();
  });
});

describe("Companion sharing contracts", () => {
  it("accepts only Editor or Viewer for the workspace-wide grant", () => {
    expect(setCompanionWorkspaceShareInputSchema.parse({ role: "viewer" })).toEqual({
      role: "viewer",
    });
    expect(setCompanionWorkspaceShareInputSchema.parse({ role: null })).toEqual({ role: null });
    expect(() => setCompanionWorkspaceShareInputSchema.parse({ role: "owner" })).toThrow();
  });

  it("carries the workspace role only — sharing is workspace-only after THE-329", () => {
    const shares = companionSharesSchema.parse({
      companion_id: "11111111-1111-1111-1111-111111111111",
      workspace_role: "editor",
    });
    expect(shares).toEqual({
      companion_id: "11111111-1111-1111-1111-111111111111",
      workspace_role: "editor",
    });
    // No per-member list survives on the contract.
    expect("members" in shares).toBe(false);
    expect(() => companionSharesSchema.parse({
      companion_id: "11111111-1111-1111-1111-111111111111",
      workspace_role: null,
      members: [],
    })).not.toThrow();
  });
});

describe("Companion conversation-list contracts", () => {
  const companion = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Luna",
    persona: null,
    model_id: "claude-opus-4-8",
    selected_skill_ids: [],
    can_write_skills: false,
    selected_mcp_account_ids: [],
    owner_id: "user-1",
    access: "owner",
    pinned: false,
    hidden: false,
    unread: false,
    runtime: {
      generation: 1,
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
      desktop_available: true,
      last_error: null,
      skills_revision: 1,
      skills_applied_revision: 1,
      skills_applied_at: null,
      skills_last_error: null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
      latest_operation: null,
    },
    created_at: "2026-08-14T09:00:00.000Z",
    updated_at: "2026-08-14T09:00:00.000Z",
  };

  it("previews the newest chat line and lets a mutation answer without one", () => {
    const withPreview = companionSchema.parse({
      ...companion,
      last_message: {
        preview: "Drafted the launch note.",
        role: "assistant",
        author_id: null,
        author_name: null,
        created_at: "2026-08-14T09:05:00.000Z",
      },
    });
    expect(withPreview.last_message?.preview).toBe("Drafted the launch note.");
    // A response that carries no preview — every mutation — parses to an explicit null.
    expect(companionSchema.parse(companion).last_message).toBeNull();
  });

  it("accepts layout zero before a Runtime v2 Box has been installed", () => {
    expect(companionSchema.parse({
      ...companion,
      runtime: { ...companion.runtime, disk_layout_version: 0 },
    }).runtime.disk_layout_version).toBe(0);
    expect(() => companionSchema.parse({
      ...companion,
      runtime: { ...companion.runtime, disk_layout_version: -1 },
    })).toThrow();
  });

  it("requires a positive runtime generation", () => {
    expect(companionSchema.parse(companion).runtime.generation).toBe(1);
    expect(() => companionSchema.parse({
      ...companion,
      runtime: { ...companion.runtime, generation: 0 },
    })).toThrow();
  });

  it("accepts only the temporary Pi operation in the legacy read projection", () => {
    const parsed = companionSchema.parse({
      ...companion,
      runtime: {
        ...companion.runtime,
        latest_operation: {
          id: "22222222-2222-4222-8222-222222222222",
          source_turn_id: null,
          kind: "restart_pi",
          status: "running",
          error: null,
        },
      },
    });

    expect(parsed.runtime.latest_operation).toEqual(expect.objectContaining({
      kind: "restart_pi",
      status: "running",
    }));
    expect(parsed.runtime.latest_operation).not.toHaveProperty("checkpoint");
    expect(() => companionSchema.parse({
      ...companion,
      runtime: {
        ...companion.runtime,
        latest_operation: { ...parsed.runtime.latest_operation, kind: "restart_box" },
      },
    })).toThrow();
  });

  it("carries only what a person or Pi said, in one bounded line", () => {
    // Tool runs and permission cards are not chat roles, so they can never reach a list row.
    for (const role of ["tool", "decision", "system"]) {
      expect(() => companionLastMessageSchema.parse({
        preview: "rm -rf /tmp/build",
        role,
        author_id: null,
        author_name: null,
        created_at: "2026-08-14T09:05:00.000Z",
      })).toThrow();
    }
    expect(() => companionLastMessageSchema.parse({
      preview: "x".repeat(COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS + 1),
      role: "user",
      author_id: "user-1",
      author_name: "Ada",
      created_at: "2026-08-14T09:05:00.000Z",
    })).toThrow();
  });

  it("masks a trigger fire like a routine and defaults trigger_name to null", () => {
    // A row stored before triggers existed reads back as an ordinary message, not a broken one.
    const plain = companionLastMessageSchema.parse({
      preview: "Drafted the launch note.",
      role: "assistant",
      author_id: null,
      author_name: null,
      created_at: "2026-08-14T09:05:00.000Z",
    });
    expect(plain.trigger_name).toBeNull();

    // A webhook fire's composed prompt embeds an external payload; the list names the trigger and
    // carries no preview text at all.
    expect(companionLastMessageSchema.parse({
      preview: "",
      role: "user",
      author_id: "user-1",
      author_name: "Ada",
      trigger_name: "CI failed on main",
      created_at: "2026-08-14T09:05:00.000Z",
    })).toMatchObject({ preview: "", trigger_name: "CI failed on main" });

    expect(() => companionLastMessageSchema.parse({
      preview: "",
      role: "user",
      author_id: "user-1",
      author_name: "Ada",
      trigger_name: "x".repeat(COMPANION_TRIGGER_NAME_MAX_CHARACTERS + 1),
      created_at: "2026-08-14T09:05:00.000Z",
    })).toThrow();
  });
});

describe("Companion trigger contracts", () => {
  const triggerRow = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companion_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "CI failed on main",
    prompt: "Investigate the failing workflow and summarize the break.",
    provider: "github" as const,
    enabled: true,
    webhook_url: "https://companions.example.test/v1/hooks/triggers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0123456789abcdef0123456789abcdef",
    last_fired_at: null,
    last_error_code: null,
    last_error_message: null,
    last_error_at: null,
    consecutive_failures: 0,
    created_at: "2026-08-19T12:00:00.000Z",
    updated_at: "2026-08-19T12:00:00.000Z",
  };

  it("accepts a trigger row with or without a webhook URL and refuses everything else", () => {
    expect(companionTriggerSchema.parse(triggerRow).provider).toBe("github");
    // A Viewer projection has no secret, so it has no URL either — never an empty string.
    expect(companionTriggerSchema.parse({ ...triggerRow, webhook_url: null }).webhook_url)
      .toBeNull();
    expect(() => companionTriggerSchema.parse({ ...triggerRow, webhook_url: "not-a-url" }))
      .toThrow();
    // The provider is a closed label list, not a free-form string.
    expect(() => companionTriggerSchema.parse({ ...triggerRow, provider: "slack" })).toThrow();
    expect(() => companionTriggerSchema.parse({
      ...triggerRow,
      name: "x".repeat(COMPANION_TRIGGER_NAME_MAX_CHARACTERS + 1),
    })).toThrow();
    // A name that is only line-break whitespace trims to nothing and is refused.
    expect(() => companionTriggerSchema.parse({ ...triggerRow, name: "\r\n" })).toThrow();
    // A bare secret never rides a wire trigger; only the composed URL does.
    expect(() => companionTriggerSchema.parse({
      ...triggerRow,
      secret: "0123456789abcdef0123456789abcdef",
    })).toThrow();
  });

  it("bounds the create and update payloads and never accepts a client-supplied secret", () => {
    expect(createCompanionTriggerInputSchema.parse({
      id: triggerRow.id,
      name: "  CI failed on main  ",
      prompt: triggerRow.prompt,
      provider: "github",
    })).toMatchObject({ id: triggerRow.id, name: "CI failed on main", enabled: true });
    expect(createCompanionTriggerInputSchema.parse({
      name: triggerRow.name,
      prompt: triggerRow.prompt,
      provider: "github",
    })).toMatchObject({ name: triggerRow.name, mode: "relay", enabled: true });
    expect(() => createCompanionTriggerInputSchema.parse({
      id: triggerRow.id,
      name: triggerRow.name,
      prompt: triggerRow.prompt,
      provider: "github",
      secret: "0123456789abcdef0123456789abcdef",
    })).toThrow();
    expect(() => createCompanionTriggerInputSchema.parse({
      id: triggerRow.id,
      name: triggerRow.name,
      prompt: "x".repeat(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS + 1),
      provider: "github",
    })).toThrow();
    expect(updateCompanionTriggerInputSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(() => updateCompanionTriggerInputSchema.parse({ webhook_url: "https://x.test" }))
      .toThrow();
  });

  it("accepts a bounded trigger proposal and refuses extra keys or an oversized payload", () => {
    const proposal = companionTriggerProposalSchema.parse({
      kind: "trigger",
      name: "CI failed on main",
      prompt: "Investigate the failing workflow.",
      provider: "github",
      target: { repo: "acme/demo", events: ["push"] },
    });
    expect(proposal.provider).toBe("github");
    expect(companionTriggerProposalMessageSchema.parse({
      summary: "Wake me when CI on main fails",
      proposal,
    }).proposal.name).toBe("CI failed on main");
    // The legacy account field remains readable during rollout, but Pi no longer emits it.
    expect(companionTriggerProposalSchema.parse({
      ...proposal,
      provider_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }).provider_account_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    // Pi never names a secret, a URL, or any other unrecognized key.
    expect(() => companionTriggerProposalSchema.parse({
      kind: "trigger",
      name: "CI failed on main",
      prompt: "Investigate the failing workflow.",
      provider: "github",
      secret: "0123456789abcdef0123456789abcdef",
    })).toThrow();
    expect(() => companionTriggerProposalSchema.parse({
      kind: "trigger",
      name: "CI failed on main",
      prompt: "Investigate the failing workflow.",
      provider: "jira",
    })).toThrow();
    // A maximum-length prompt plus the envelope exceeds the 16 KiB stored-proposal cap.
    expect(() => companionTriggerProposalSchema.parse({
      kind: "trigger",
      name: "CI failed on main",
      prompt: "p".repeat(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS),
      provider: "github",
    })).toThrow();
  });

  it("binds the trigger card to its proposal and to no other kind", () => {
    const proposal = companionTriggerProposalSchema.parse({
      kind: "trigger",
      name: "CI failed on main",
      prompt: "Investigate the failing workflow.",
      provider: "github",
      target: { repo: "acme/demo", events: ["push"] },
    });
    const decision = {
      request_id: "ui-trigger-1",
      kind: "trigger" as const,
      name: "propose_trigger",
      title: "Create the CI trigger",
      detail: "Wake me when CI on main fails",
      status: "pending" as const,
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: "2026-08-19T12:05:00.000Z",
      proposal,
    };
    expect(companionDecisionSchema.parse(decision).proposal).toEqual(proposal);
    expect(() => companionDecisionSchema.parse({ ...decision, proposal: null })).toThrow();
    // A trigger card cannot smuggle a routine proposal, and a question card carries none at all.
    expect(() => companionDecisionSchema.parse({
      ...decision,
      proposal: companionRoutineProposalSchema.parse({
        kind: "routine",
        name: "Standup",
        prompt: "Write the standup.",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
      }),
    })).toThrow();
    expect(() => companionDecisionSchema.parse({
      ...decision,
      kind: "question",
      name: "ask_user",
    })).toThrow();
  });

  it("models notify, relay, and silent trigger validation outcomes", () => {
    const base = {
      run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companion_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      trigger: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "CI failed" },
      status: "succeeded" as const,
      mode: "notify" as const,
      created_at: "2026-08-30T12:00:00.000Z",
      started_at: "2026-08-30T12:00:01.000Z",
      settled_at: "2026-08-30T12:00:02.000Z",
      error: null,
    };
    expect(companionTriggerRunSummarySchema.parse({
      ...base,
      outcome: "no_output",
      surface_mode: null,
      main_entry_event_id: null,
      relay_turn_id: null,
    }).outcome).toBe("no_output");
    expect(companionTriggerRunDetailSchema.parse({
      ...base,
      outcome: "surfaced",
      surface_mode: "notify",
      main_entry_event_id: "routine-return:run",
      relay_turn_id: null,
      internal_entries: [],
      next_entry_cursor: null,
    }).surface_mode).toBe("notify");
    expect(() => companionTriggerRunSummarySchema.parse({
      ...base,
      outcome: "surfaced",
      surface_mode: "relay",
      main_entry_event_id: "routine-return:run",
      relay_turn_id: null,
    })).toThrow();
  });

  it("carries a trigger origin only on a user message and never beside a routine origin", () => {
    const entry = {
      event_id: "msg:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ordinal: 1,
      role: "user" as const,
      content: "Investigate the failing workflow.",
      author_id: "user-1",
      author_name: "Ada",
      created_at: "2026-08-19T09:00:00.000Z",
    };
    expect(companionTranscriptEntrySchema.parse({
      ...entry,
      trigger: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "CI failed on main" },
    }).trigger).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "CI failed on main",
    });
    // An entry stored before triggers existed reads back with an explicit null origin.
    expect(companionTranscriptEntrySchema.parse(entry).trigger).toBeNull();
    expect(() => companionTranscriptEntrySchema.parse({
      ...entry,
      role: "assistant",
      author_id: null,
      author_name: null,
      trigger: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "CI failed on main" },
    })).toThrow();
    // One origin per message: a turn was enqueued by a routine or by a trigger, never both.
    expect(() => companionTranscriptEntrySchema.parse({
      ...entry,
      routine: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Standup" },
      trigger: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "CI failed on main" },
    })).toThrow();
  });
});
