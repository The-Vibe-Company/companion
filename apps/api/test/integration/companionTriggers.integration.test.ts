import { randomUUID } from "node:crypto";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompanionTriggerDecisionUpdateError,
  CompanionTriggerNotFoundError,
  answerCompanionTriggerDecisionV2,
  composeTriggerPrompt,
  createCompanionTriggerV2,
  createCompanionV2,
  deleteCompanionTriggerV2,
  deleteCompanionPlugin,
  failCompanionTriggerFire,
  fireCompanionTrigger,
  getCompanionTriggerForWebhook,
  getCompanionTriggerRunV2,
  inspectCompanionTriggerWebhookV2,
  listCompanionTriggerRunsV2,
  listCompanionTriggersV2,
  listCompanionsV2,
  readCompanionThreadV2,
  registerCompanionTriggerWebhookV2,
  ensureOAuthCompanionTriggerProviderAccount,
  rotateCompanionTriggerSecretV2,
  saveCompanionTriggerProviderAccount,
  saveCompanionPlugin,
  saveCompanionPluginTriggerKey,
  saveCompanionProvider,
  setCompanionWorkspaceShareV2,
  triggerFireMessageId,
  unregisterCompanionTriggerWebhookV2,
  updateCompanionTriggerV2,
} from "@companion/core";
import { COMPANION_TRIGGER_MAX_PER_COMPANION } from "@companion/contracts";
import { schema, withTenantContext, type Db } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

const WEBHOOK_BASE_URL = "http://127.0.0.1:3000";
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

function webhookSecretOf(trigger: { id: string; webhook_url: string | null }): string {
  const url = trigger.webhook_url;
  if (url === null) throw new Error("expected an Owner/Editor webhook URL");
  const prefix = `${WEBHOOK_BASE_URL}/v1/hooks/triggers/${trigger.id}/`;
  expect(url.startsWith(prefix)).toBe(true);
  const secret = url.slice(prefix.length);
  expect(secret).toMatch(SECRET_PATTERN);
  return secret;
}

const databaseErrorNodeSchema = z.object({
  code: z.string().optional(),
  cause: z.unknown(),
}).passthrough();

/** Drizzle nests the postgres.js SQLSTATE on `cause`; read the first code in the chain. */
function sqlState(cause: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current !== null && !seen.has(current)) {
    const node = databaseErrorNodeSchema.safeParse(current);
    if (!node.success) break;
    seen.add(current);
    if (node.data.code !== undefined) return node.data.code;
    current = "cause" in node.data ? node.data.cause : null;
  }
  return null;
}

// SAFETY: the fake fetch helpers below only return Response objects, the sole part of `fetch` the trigger services use.
const asFetch = (fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch => fn;

async function expectSqlState(work: Promise<unknown>, code: string): Promise<void> {
  let observed: string | null = null;
  let threw = false;
  try {
    await work;
  } catch (error) {
    threw = true;
    observed = sqlState(error);
  }
  expect(threw, `expected SQLSTATE ${code}`).toBe(true);
  expect(observed).toBe(code);
}

/**
 * Triggers are the webhook-fired sibling of routines and cross the same Drizzle boundary. The raw
 * SQL functions own every guarantee that matters here — Owner-impersonated enqueue, replay before
 * throttle, secret visibility, the ten-trigger cap, the approver-attributed proposal apply — and
 * only a real migrated database can prove the TypeScript layer round-trips them intact.
 */
describe("Companion triggers over the real database", () => {
  let fixture: IntegrationFixture;
  let companionId: string;
  const masterKey = Buffer.alloc(32, 71);

  async function asActor<T>(actor: TestActor, action: (database: Db) => Promise<T>): Promise<T> {
    return withTenantContext({ orgId: fixture.orgA, userId: actor.id }, action);
  }

  function draft(name: string) {
    return {
      name,
      prompt: `Investigate the ${name} event.`,
      provider: "github" as const,
      target: { repo: "acme/demo", events: ["push"] },
    };
  }

  function createTrigger(
    actor: TestActor,
    name: string,
    overrides: {
      id?: string;
      prompt?: string;
      mode?: "notify" | "relay";
      provider?: "github" | "webhook";
      enabled?: boolean;
    } = {},
  ) {
    return asActor(actor, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      ...draft(name),
      ...overrides,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
  }

  async function triggerRow(triggerId: string) {
    const [row] = await integrationDb
      .select()
      .from(schema.companionTriggers)
      .where(eq(schema.companionTriggers.id, triggerId));
    if (!row) throw new Error("expected the trigger row to exist");
    return row;
  }

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "integration-secret",
      masterKey,
      database: integrationDb,
    });
    const companion = await asActor(fixture.owner, (database) => createCompanionV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      name: "Trigger runner",
      persona: "Answers external webhooks",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }));
    companionId = companion.id;
    // The default fixture attaches one GitHub account so registration can silently reuse the same
    // OAuth credential as MCP. Trigger definitions themselves remain autonomous.
    const plugin = await saveCompanionPlugin({
      actor: fixture.owner,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "GitHub",
        transport: "http",
        url: "https://mcp.example.com/github",
        args: [],
      },
      oauthCredential: {
        kind: "oauth",
        version: 1,
        serverName: "io.github.github/github-mcp-server",
        accessToken: "gho_registration_test_token",
        refreshToken: null,
        accessExpiresAt: null,
        scope: "repo admin:repo_hook",
        tokenType: "Bearer",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        resource: "https://api.githubcopilot.com/mcp/",
        client: { clientId: "integration-client", clientSecret: null, tokenEndpointAuthMethod: "none" },
      },
      masterKey,
      database: integrationDb,
    });
    await ensureOAuthCompanionTriggerProviderAccount({
      actor: fixture.owner,
      orgId: fixture.orgA,
      mcpAccountId: plugin.id,
      provider: "github",
      label: "GitHub",
      database: integrationDb,
    });
    await integrationDb.update(schema.companions)
      .set({ selectedMcpAccountIds: [plugin.id] })
      .where(eq(schema.companions.id, companionId));
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("creates, lists, updates, rotates, and deletes a trigger through the ordinary tenant boundary", async () => {
    const created = await createTrigger(fixture.owner, "CI failed on main");
    expect(created).toMatchObject({
      name: "CI failed on main",
      provider: "github",
      enabled: true,
      consecutive_failures: 0,
      last_fired_at: null,
      last_error_code: null,
    });
    const originalSecret = webhookSecretOf(created);

    const listed = await asActor(fixture.owner, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(listed).toEqual([created]);

    // An ordinary update never touches the secret: the registered callback keeps working.
    const disabled = await asActor(fixture.owner, (database) => updateCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: created.id,
      enabled: false,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(disabled).toMatchObject({ enabled: false, name: "CI failed on main" });
    expect(disabled.webhook_url).toBe(created.webhook_url);

    // Rotation is the only secret change; the old URL dies at the next request.
    const rotated = await asActor(fixture.owner, (database) => rotateCompanionTriggerSecretV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: created.id,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    const rotatedSecret = webhookSecretOf(rotated);
    expect(rotatedSecret).not.toBe(originalSecret);
    expect(new Date(rotated.updated_at).getTime())
      .toBeGreaterThanOrEqual(new Date(created.updated_at).getTime());
    const stored = await getCompanionTriggerForWebhook({
      triggerId: created.id,
      database: integrationDb,
    });
    expect(stored?.secret).toBe(rotatedSecret);
    expect(stored?.secret).not.toBe(originalSecret);

    await asActor(fixture.owner, (database) => deleteCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: created.id,
      database,
    }));
    await expect(asActor(fixture.owner, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }))).resolves.toEqual([]);
    await expect(asActor(fixture.owner, (database) => deleteCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: created.id,
      database,
    }))).rejects.toBeInstanceOf(CompanionTriggerNotFoundError);
  });

  it("shows a Viewer the trigger but never its webhook secret", async () => {
    const created = await createTrigger(fixture.owner, "CI failed on main");
    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));

    const viewerList = await asActor(fixture.developer, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(viewerList).toHaveLength(1);
    expect(viewerList[0]).toMatchObject({ id: created.id, name: created.name });
    expect(viewerList[0]!.webhook_url).toBeNull();

    // The SQL list JSON itself already redacts the secret for a Viewer, so no later projection
    // layer has anything to leak.
    const listJsonAs = async (actor: TestActor) => {
      const result = await asActor(actor, (database) => database.execute(drizzleSql`
        select public.companion_api_list_triggers(
          ${fixture.orgA}::uuid, ${companionId}::uuid
        ) as triggers
      `));
      // SAFETY: the RPC above returns one row whose triggers column holds the trigger JSON list.
      const [row] = Array.from(result as Iterable<{ triggers: Array<{ secret: string | null }> }>);
      return row!.triggers;
    };
    const viewerJson = await listJsonAs(fixture.developer);
    expect(viewerJson).toHaveLength(1);
    expect(viewerJson[0]!.secret).toBeNull();
    const ownerJson = await listJsonAs(fixture.owner);
    expect(ownerJson[0]!.secret).toMatch(SECRET_PATTERN);
  });

  it("refuses Viewer writes, non-members, cross-tenant reads, and a revoked editor", async () => {
    const created = await createTrigger(fixture.owner, "CI failed on main");

    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));
    await expectSqlState(createTrigger(fixture.developer, "Viewer trigger"), "42501");
    await expectSqlState(asActor(fixture.developer, (database) => updateCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: created.id,
      enabled: false,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    })), "42501");
    await expectSqlState(asActor(fixture.developer, (database) => rotateCompanionTriggerSecretV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: created.id,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    })), "42501");
    await expectSqlState(asActor(fixture.developer, (database) => deleteCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: created.id,
      database,
    })), "42501");

    // Editor access is exactly enough for the whole CRUD surface.
    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "editor",
      database,
    }));
    const editorTrigger = await createTrigger(fixture.developer, "Editor trigger");
    expect(editorTrigger.webhook_url).not.toBeNull();
    await asActor(fixture.developer, (database) => deleteCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: editorTrigger.id,
      database,
    }));

    // A member of another workspace is nobody here, whichever tenant context they present.
    await expectSqlState(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.outsider.id },
      (database) => listCompanionTriggersV2({
        orgId: fixture.orgA,
        companionId,
        database,
        webhookBaseUrl: WEBHOOK_BASE_URL,
      }),
    ), "42501");
    await expectSqlState(withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => listCompanionTriggersV2({
        orgId: fixture.orgB,
        companionId,
        database,
        webhookBaseUrl: WEBHOOK_BASE_URL,
      }),
    ), "P0002");

    // Authority is re-checked at the SQL boundary on every call: a membership deleted mid-flight
    // fails closed even though this actor held editor access a moment ago.
    await integrationDb.delete(schema.memberships).where(and(
      eq(schema.memberships.orgId, fixture.orgA),
      eq(schema.memberships.userId, fixture.developer.id),
    ));
    await expectSqlState(createTrigger(fixture.developer, "Revoked trigger"), "42501");
  });

  it("caps a Companion at ten triggers and treats id reuse as intent replay", async () => {
    const triggerId = randomUUID();
    const first = await createTrigger(fixture.owner, "Alpha", { id: triggerId });

    // A retried create carries a freshly generated secret; the replay returns the stored one
    // instead of conflicting on it.
    const replayed = await createTrigger(fixture.owner, "Alpha", { id: triggerId });
    expect(replayed).toEqual(first);
    await expectSqlState(
      createTrigger(fixture.owner, "Alpha", { id: triggerId, prompt: "A different prompt." }),
      "23505",
    );
    // Names collapse case-insensitively per Companion.
    await expectSqlState(createTrigger(fixture.owner, "alpha"), "23505");

    for (let index = 1; index < COMPANION_TRIGGER_MAX_PER_COMPANION; index += 1) {
      await createTrigger(fixture.owner, `Trigger ${index}`);
    }
    await expectSqlState(createTrigger(fixture.owner, "One too many"), "P0001");
  });

  it("uses a member-wide trigger provider account without attaching it to each Companion", async () => {
    const [account] = await integrationDb
      .select({ id: schema.companionMcpAccounts.id })
      .from(schema.companionMcpAccounts)
      .where(eq(schema.companionMcpAccounts.orgId, fixture.orgA));
    await integrationDb.update(schema.companions)
      .set({ selectedMcpAccountIds: [] })
      .where(eq(schema.companions.id, companionId));
    expect(account).toBeDefined();

    const [providerAccount] = await integrationDb
      .select({ id: schema.companionTriggerProviderAccounts.id })
      .from(schema.companionTriggerProviderAccounts)
      .where(eq(schema.companionTriggerProviderAccounts.orgId, fixture.orgA));
    const autonomous = await createTrigger(fixture.owner, "No github attachment");
    expect(autonomous).toMatchObject({
      provider: "github",
      provider_account_id: providerAccount!.id,
    });

    // `custom` needs no plugin.
    const custom = await asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      name: "Custom hook",
      prompt: "React to the custom event.",
      provider: "custom",
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(custom.provider).toBe("custom");

    const updated = await asActor(fixture.owner, (database) => updateCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: custom.id,
      provider: "github",
      target: { repo: "acme/demo", events: ["push"] },
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(updated.provider).toBe("github");

    // MCP attachment remains independent and does not change trigger authority on either path.
    await integrationDb.update(schema.companions)
      .set({ selectedMcpAccountIds: [account!.id] })
      .where(eq(schema.companions.id, companionId));
    const attached = await createTrigger(fixture.owner, "With github plugin");
    expect(attached).toMatchObject({ provider: "github", provider_account_id: providerAccount!.id });
    await asActor(fixture.owner, (database) => updateCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: custom.id,
      provider: "github",
      target: { repo: "acme/demo", events: ["push"] },
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
  });

  it("degrades every dependent Companion trigger when the shared MCP credential disconnects", async () => {
    const [mcpAccount] = await integrationDb
      .select({ id: schema.companionMcpAccounts.id })
      .from(schema.companionMcpAccounts)
      .where(and(
        eq(schema.companionMcpAccounts.orgId, fixture.orgA),
        eq(schema.companionMcpAccounts.provider, "github"),
      ));
    const first = await createTrigger(fixture.owner, "First shared trigger");
    const secondCompanion = await asActor(fixture.owner, (database) => createCompanionV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      name: "Second trigger runner",
      persona: "Also answers external webhooks",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }));
    const second = await asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId: secondCompanion.id,
      ...draft("Second shared trigger"),
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(second.provider_account_id).toBe(first.provider_account_id);

    await integrationDb.update(schema.companionTriggers).set({ registrationStatus: "registered" })
      .where(and(
        eq(schema.companionTriggers.orgId, fixture.orgA),
        eq(schema.companionTriggers.providerAccountId, first.provider_account_id!),
      ));
    await asActor(fixture.owner, (database) => deleteCompanionPlugin({
      actor: fixture.owner,
      orgId: fixture.orgA,
      accountId: mcpAccount!.id,
      database,
    }));

    const rows = await integrationDb.select({ status: schema.companionTriggers.registrationStatus })
      .from(schema.companionTriggers)
      .where(and(
        eq(schema.companionTriggers.orgId, fixture.orgA),
        eq(schema.companionTriggers.providerAccountId, first.provider_account_id!),
      ));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "unregistered")).toBe(true);
    const providerAccount = await integrationDb.query.companionTriggerProviderAccounts.findFirst({
      where: eq(schema.companionTriggerProviderAccounts.id, first.provider_account_id!),
    });
    expect(providerAccount).toMatchObject({ status: "disconnected", mcpAccountId: null });
    expect((await getCompanionTriggerForWebhook({ triggerId: first.id, database: integrationDb }))?.enabled)
      .toBe(false);

    // A callback from before the disconnect is no longer eligible to enqueue a turn.
    const skipped = await fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: first.id,
      clientMessageId: triggerFireMessageId({ triggerId: first.id, deliveryId: "after-disconnect" }),
      content: first.prompt,
      database: integrationDb,
    });
    expect(skipped).toEqual({ outcome: "skipped_disabled", turn: null, replayed: false });
    const turns = await integrationDb
      .select({ id: schema.companionTurns.id })
      .from(schema.companionTurns)
      .where(eq(schema.companionTurns.triggerId, first.id));
    expect(turns).toHaveLength(0);
  });

  it("fires once as the Owner, masks the prompt behind the trigger name, and collapses replays", async () => {
    const trigger = await createTrigger(fixture.owner, "CI failed on main", { provider: "webhook" });
    const payload = '{"action":"completed","conclusion":"failure"}';
    const content = composeTriggerPrompt(trigger.prompt, payload);
    expect(content).toContain(trigger.prompt);
    expect(content).toContain(payload);
    const clientMessageId = triggerFireMessageId({
      triggerId: trigger.id,
      deliveryId: "gh-delivery-1",
    });

    const fired = await fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: trigger.id,
      clientMessageId,
      content,
      database: integrationDb,
    });
    expect(fired.outcome).toBe("fired");
    expect(fired.replayed).toBe(false);
    expect(fired.turn).toMatchObject({ client_message_id: clientMessageId, status: "queued" });

    // The durable turn is attributed to the immutable Companion Owner and stamped with its origin.
    const [turnRow] = await integrationDb
      .select()
      .from(schema.companionTurns)
      .where(eq(schema.companionTurns.id, fired.turn!.id));
    expect(turnRow).toMatchObject({
      actorId: fixture.owner.id,
      triggerId: trigger.id,
      triggerName: trigger.name,
      triggerMode: "relay",
      routineSnapshotId: trigger.id,
      routineIsolated: false,
      routineName: null,
      routineId: null,
    });

    const thread = await asActor(fixture.owner, (database) => readCompanionThreadV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    const entry = thread.entries.find((candidate) => candidate.trigger !== null);
    expect(entry).toMatchObject({
      role: "user",
      content,
      trigger: { id: trigger.id, name: trigger.name },
      routine: null,
    });

    // The conversation list is read by everyone who can see the Companion; the composed prompt —
    // which embeds an external payload — must not read as something the Owner typed.
    const [listedCompanion] = await asActor(fixture.owner, (database) => listCompanionsV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      database,
    }));
    expect(listedCompanion!.last_message).toMatchObject({
      role: "user",
      preview: "",
      trigger_name: trigger.name,
    });

    const afterFire = await triggerRow(trigger.id);
    expect(afterFire.lastFiredAt).not.toBeNull();
    expect(afterFire.consecutiveFailures).toBe(0);

    // A provider redelivery inside the throttle window still resolves to the same durable turn:
    // the replay check runs before every skip.
    const replay = await fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: trigger.id,
      clientMessageId,
      content,
      database: integrationDb,
    });
    expect(replay.outcome).toBe("replayed");
    expect(replay.replayed).toBe(true);
    expect(replay.turn!.id).toBe(fired.turn!.id);
    const turns = await integrationDb
      .select({ id: schema.companionTurns.id })
      .from(schema.companionTurns)
      .where(eq(schema.companionTurns.clientMessageId, clientMessageId));
    expect(turns).toHaveLength(1);

    // The same delivery id with a different payload is a conflicting intent, never a silent replay.
    await expectSqlState(fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: trigger.id,
      clientMessageId,
      content: composeTriggerPrompt(trigger.prompt, '{"action":"reopened"}'),
      database: integrationDb,
    }), "23505");
  });

  it("serves trigger-only history and enforces the configured terminal surface mode", async () => {
    const trigger = await createTrigger(fixture.owner, "Notify on CI failure", {
      mode: "notify",
      provider: "webhook",
    });
    const fired = await fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: trigger.id,
      clientMessageId: triggerFireMessageId({ triggerId: trigger.id, deliveryId: "history-1" }),
      content: composeTriggerPrompt(trigger.prompt, '{"conclusion":"failure"}'),
      database: integrationDb,
    });
    const runId = fired.turn!.id;
    const [marker] = await integrationDb
      .select({ ordinal: schema.companionTranscriptEntries.ordinal })
      .from(schema.companionTranscriptEntries)
      .where(eq(schema.companionTranscriptEntries.turnId, runId));
    const [substrate] = await integrationDb
      .insert(schema.companionRoutineContextSubstrates)
      .values({
        orgId: fixture.orgA,
        companionId,
        summarySha256: null,
        builtThroughOrdinal: marker?.ordinal ?? 0,
        content: "Pinned main conversation context.",
        sha256: "e".repeat(64),
      })
      .returning({ id: schema.companionRoutineContextSubstrates.id });
    await integrationDb.update(schema.companionTurns)
      .set({ routineIsolated: true, routineContextSubstrateId: substrate!.id })
      .where(eq(schema.companionTurns.id, runId));
    await integrationDb.insert(schema.companionRoutineRunEntries).values({
      orgId: fixture.orgA,
      companionId,
      runId,
      eventId: "trigger:validation:1",
      ordinal: 0,
      role: "assistant",
      content: "Validated the external payload.",
    });

    await expectSqlState(integrationSql`
      select companion_runtime_surface_routine_return(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${runId}::uuid,
        'relay', 'This mode must be rejected.'
      )
    `, "22023");
    const [surfaced] = await integrationSql<{ accepted: boolean }[]>`
      select companion_runtime_surface_routine_return(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${runId}::uuid,
        'notify', 'The main workflow failed.'
      ) as accepted
    `;
    expect(surfaced).toEqual({ accepted: true });

    const history = await asActor(fixture.owner, (database) => listCompanionTriggerRunsV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      database,
    }));
    expect(history).toMatchObject({
      next_cursor: null,
      runs: [{
        run_id: runId,
        trigger: { id: trigger.id, name: trigger.name },
        mode: "notify",
        outcome: "surfaced",
        surface_mode: "notify",
        relay_turn_id: null,
      }],
    });
    const detail = await asActor(fixture.owner, (database) => getCompanionTriggerRunV2({
      orgId: fixture.orgA,
      companionId,
      runId,
      entryLimit: 10,
      database,
    }));
    expect(detail).toMatchObject({
      run_id: runId,
      internal_entries: [{
        event_id: "trigger:validation:1",
        content: "Validated the external payload.",
      }],
      next_entry_cursor: null,
    });
  });

  it("skips disabled, throttled, and piled-up fires without advancing last_fired_at", async () => {
    const trigger = await createTrigger(fixture.owner, "CI failed on main", { provider: "webhook" });
    const fire = (deliveryId: string) => fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: trigger.id,
      clientMessageId: triggerFireMessageId({ triggerId: trigger.id, deliveryId }),
      content: trigger.prompt,
      database: integrationDb,
    });

    await expect(fire("gh-1")).resolves.toMatchObject({ outcome: "fired" });
    const firedAt = (await triggerRow(trigger.id)).lastFiredAt!;

    // A new delivery within sixty seconds is dropped, and the drop does not restart the window.
    const throttled = await fire("gh-2");
    expect(throttled).toEqual({ outcome: "skipped_throttled", turn: null, replayed: false });
    expect((await triggerRow(trigger.id)).lastFiredAt!.getTime()).toBe(firedAt.getTime());

    // Clear the throttle: the first turn is still queued, so the next delivery is a pileup skip.
    const backdated = new Date(Date.now() - 2 * 60 * 1000);
    await integrationDb
      .update(schema.companionTriggers)
      .set({ lastFiredAt: backdated })
      .where(eq(schema.companionTriggers.id, trigger.id));
    const piledUp = await fire("gh-3");
    expect(piledUp).toEqual({ outcome: "skipped_pileup", turn: null, replayed: false });
    expect((await triggerRow(trigger.id)).lastFiredAt!.getTime()).toBe(backdated.getTime());

    // A disabled trigger never wakes anything and records no fire.
    const disabled = await createTrigger(fixture.owner, "Disabled trigger", {
      provider: "webhook",
      enabled: false,
    });
    const skipped = await fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: disabled.id,
      clientMessageId: triggerFireMessageId({ triggerId: disabled.id, deliveryId: "gh-4" }),
      content: disabled.prompt,
      database: integrationDb,
    });
    expect(skipped).toEqual({ outcome: "skipped_disabled", turn: null, replayed: false });
    expect((await triggerRow(disabled.id)).lastFiredAt).toBeNull();
  });

  it("refuses a turn that claims both a routine and a trigger origin", async () => {
    await expectSqlState(asActor(fixture.owner, (database) => database.execute(drizzleSql`
      select * from public.companion_api_enqueue_turn(
        ${fixture.orgA}::uuid,
        ${companionId}::uuid,
        ${randomUUID()}::uuid,
        ${"A message with two origins"},
        'web'::public.companion_client_surface,
        '[]'::jsonb,
        ${randomUUID()}::uuid,
        ${"Standup"},
        ${randomUUID()}::uuid,
        ${"CI failed on main"}
      )
    `)), "22023");
  });

  it("records fire failures, disables after five, and does not mistake enqueue for validation success", async () => {
    const trigger = await createTrigger(fixture.owner, "Flaky trigger", { provider: "webhook" });
    const fail = () => failCompanionTriggerFire({
      orgId: fixture.orgA,
      triggerId: trigger.id,
      errorCode: "fire_failed",
      errorMessage: "Companion trigger fire failed",
      database: integrationDb,
    });

    await fail();
    await fail();
    const afterTwo = await triggerRow(trigger.id);
    expect(afterTwo).toMatchObject({
      consecutiveFailures: 2,
      lastErrorCode: "fire_failed",
      lastErrorMessage: "Companion trigger fire failed",
      enabled: true,
    });
    expect(afterTwo.lastErrorAt).not.toBeNull();

    // Enqueue only starts isolated validation; it cannot claim the run itself succeeded or erase
    // the existing failure streak.
    await expect(fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: trigger.id,
      clientMessageId: triggerFireMessageId({ triggerId: trigger.id, deliveryId: "ok-1" }),
      content: trigger.prompt,
      database: integrationDb,
    })).resolves.toMatchObject({ outcome: "fired" });
    const afterSuccess = await triggerRow(trigger.id);
    expect(afterSuccess).toMatchObject({
      consecutiveFailures: 2,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      enabled: true,
    });

    // Five consecutive failures fail the trigger closed rather than hammering the Companion.
    const flaky = await createTrigger(fixture.owner, "Always failing", { provider: "webhook" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await failCompanionTriggerFire({
        orgId: fixture.orgA,
        triggerId: flaky.id,
        errorCode: "fire_failed",
        errorMessage: "Companion trigger fire failed",
        database: integrationDb,
      });
    }
    const disabledRow = await triggerRow(flaky.id);
    expect(disabledRow).toMatchObject({
      enabled: false,
      consecutiveFailures: 5,
      lastErrorCode: "fire_failed",
    });
    await expect(fireCompanionTrigger({
      orgId: fixture.orgA,
      triggerId: flaky.id,
      clientMessageId: triggerFireMessageId({ triggerId: flaky.id, deliveryId: "post-disable" }),
      content: flaky.prompt,
      database: integrationDb,
    })).resolves.toMatchObject({ outcome: "skipped_disabled" });

    // Re-enabling through the ordinary update is the recovery path, and it resets the triple.
    const reenabled = await asActor(fixture.owner, (database) => updateCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: flaky.id,
      enabled: true,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(reenabled).toMatchObject({
      enabled: true,
      consecutive_failures: 0,
      last_error_code: null,
      last_error_message: null,
    });
  });

  it("decouples definitions from delivery metadata and records shared-credential registrations", async () => {
    const incomplete = await asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      name: "No target",
      prompt: "p",
      provider: "github",
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(incomplete.provider).toBe("github");
    const customWithTarget = await asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      name: "Custom with target",
      prompt: "p",
      provider: "custom",
      target: { repo: "acme/demo", events: ["push"] },
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(customWithTarget.target).toEqual({ repo: "acme/demo", events: ["push"] });

    const trigger = await createTrigger(fixture.owner, "Wired trigger");

    // Registration is on demand: approval and creation leave the row manual.
    expect((await triggerRow(trigger.id)).registrationStatus).toBe("manual");
    const [githubAccount] = await integrationDb
      .select({ id: schema.companionTriggerProviderAccounts.id })
      .from(schema.companionTriggerProviderAccounts)
      .where(and(
        eq(schema.companionTriggerProviderAccounts.orgId, fixture.orgA),
        eq(schema.companionTriggerProviderAccounts.provider, "github"),
      ));

    // A rejected registration persists its failure instead of silently staying manual.
    // Legacy consent without admin:repo_hook and revoked tokens are ordinary retryable failures.
    const failingFetch = asFetch(async () => new Response("{}", { status: 403 }));
    await expect(asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: failingFetch,
    }))).resolves.toMatchObject({ status: "failed", error: /github webhook reconciliation failed/ });
    let row = await triggerRow(trigger.id);
    expect(row.registrationStatus).toBe("failed");
    expect(row.lastRegistrationError).toContain("github webhook reconciliation failed");

    // A successful registration stores the remote hook id and never touches the secret.
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const okFetch = asFetch(async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      if ((init?.method ?? "GET") === "GET") {
        return new Response("[]", { status: 200 });
      }
      return new Response(JSON.stringify({ id: 424242 }), { status: 201 });
    });
    await asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: okFetch,
    }));
    row = await triggerRow(trigger.id);
    expect(row).toMatchObject({
      registrationStatus: "registered",
      remoteHookId: "424242",
      remoteHookAccountId: githubAccount!.id,
      lastRegistrationError: null,
    });
    expect(requests[0]!.url).toBe("https://api.github.com/repos/acme/demo/hooks?per_page=100");
    expect(requests[1]!.url).toBe("https://api.github.com/repos/acme/demo/hooks");
    const body = JSON.parse(String(requests[1]!.init.body));
    expect(body.events).toEqual(["push"]);
    expect(body.config.url).toContain(`/v1/hooks/triggers/${trigger.id}/`);
    // The URL secret doubles as the provider HMAC secret.
    expect(body.config.secret).toBe((await getCompanionTriggerForWebhook({
      triggerId: trigger.id,
      database: integrationDb,
    }))!.secret);

    // Purge reconciliation can prove a committed delete without mutating the ownership row.
    const reconcilePresent = asFetch(async () => new Response(JSON.stringify([{
      id: 424242,
      config: { url: requests[1]!.init.body
        ? JSON.parse(String(requests[1]!.init.body)).config.url
        : "" },
    }]), { status: 200 }));
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: reconcilePresent,
    }))).resolves.toBe("present");
    const paginatedGitHubRequests: string[] = [];
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async (url) => {
        paginatedGitHubRequests.push(String(url));
        if (String(url).endsWith("page=1")) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: {
              link: "<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=2>; rel=next",
            },
          });
        }
        return new Response(JSON.stringify([{ id: 424242 }]), { status: 200 });
      }),
    }))).resolves.toBe("present");
    expect(paginatedGitHubRequests).toEqual([
      "https://api.github.com/repos/acme/demo/hooks?per_page=100&page=1",
      "https://api.github.com/repos/acme/demo/hooks?per_page=100&page=2",
    ]);
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(JSON.stringify([{ id: 111111 }]), { status: 200 })),
    }))).resolves.toBe("absent");
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(null, { status: 404 })),
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(JSON.stringify({ id: 424242 }), { status: 200 })),
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          link: "<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=2>; rel",
        },
      })),
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    let quotedPage = 0;
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => {
        quotedPage += 1;
        return quotedPage === 1
          ? new Response(JSON.stringify([]), {
              status: 200,
              headers: {
                link: '<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=2>; rel="next"',
              },
            })
          : new Response(JSON.stringify([{ id: 424242 }]), { status: 200 });
      }),
    }))).resolves.toBe("present");
    const invalidLinkHeaders = [
      '<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=2>; rel="next',
      '<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=2>; rel="next previous"',
      '<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=2>; rel=last, '
        + '<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=3>; rel=last',
      '<https://api.github.com/repos/acme/other/hooks?per_page=100&page=2>; rel=next',
      '<https://example.test/repos/acme/demo/hooks?per_page=100&page=2>; rel=next',
      '<https://user@api.github.com/repos/acme/demo/hooks?per_page=100&page=2>; rel=next',
      '<https://[invalid/repos/acme/demo/hooks?per_page=100&page=2>; rel=next',
      '<?per_page=100&page=2>; rel=next',
      '<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=1>; rel=next',
    ];
    for (const link of invalidLinkHeaders) {
      await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
        orgId: fixture.orgA,
        companionId,
        triggerId: trigger.id,
        webhookBaseUrl: WEBHOOK_BASE_URL,
        masterKey,
        database,
        fetch: asFetch(async () => new Response(JSON.stringify([]), {
          status: 200,
          headers: { link },
        })),
      }))).rejects.toMatchObject({ code: "provider_rejected" });
    }
    let boundedPageCalls = 0;
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => {
        boundedPageCalls += 1;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            link: `<https://api.github.com/repos/acme/demo/hooks?per_page=100&page=${boundedPageCalls + 1}>; rel=next`,
          },
        });
      }),
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    expect(boundedPageCalls).toBe(100);
    let malformedLookupCalls = 0;
    const malformedLookup = asFetch(async () => {
      malformedLookupCalls += 1;
      throw new Error("malformed provider locator must fail before fetch");
    });
    await integrationDb.update(schema.companionTriggers).set({ target: {} })
      .where(eq(schema.companionTriggers.id, trigger.id));
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: malformedLookup,
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(asActor(fixture.owner, (database) => unregisterCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: malformedLookup,
      preserveRegistration: true,
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    expect(malformedLookupCalls).toBe(0);
    await integrationDb.update(schema.companionTriggers).set({
      target: { repo: "acme/demo", events: ["push"] },
    }).where(eq(schema.companionTriggers.id, trigger.id));
    const deleteRequests: string[] = [];
    const deleteFetch = asFetch(async (url) => {
      deleteRequests.push(String(url));
      return new Response(null, { status: 204 });
    });
    await expect(asActor(fixture.owner, (database) => unregisterCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: deleteFetch,
      preserveRegistration: true,
    }))).resolves.toBe("completed");
    row = await triggerRow(trigger.id);
    expect(row.registrationStatus).toBe("registered");
    expect(row.remoteHookId).toBe("424242");
    expect(deleteRequests[0]).toBe("https://api.github.com/repos/acme/demo/hooks/424242");
    const reconcileAbsent = asFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: reconcileAbsent,
    }))).resolves.toBe("absent");
    await expect(asActor(fixture.owner, (database) => unregisterCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(null, { status: 404 })),
    }))).resolves.toBe("absent");
    row = await triggerRow(trigger.id);
    expect(row.registrationStatus).toBe("unregistered");
    expect(row.remoteHookId).toBeNull();

    // A provider-committed create whose response was lost is adopted by URL on retry instead of
    // creating a duplicate remote hook.
    let ambiguousCall = 0;
    const ambiguousFetch = asFetch(async (_url, init) => {
      ambiguousCall += 1;
      if (ambiguousCall === 1 && (init?.method ?? "GET") === "GET") {
        return new Response("[]", { status: 200 });
      }
      throw new Error("connection closed after provider commit");
    });
    await expect(asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: ambiguousFetch,
    }))).resolves.toMatchObject({ status: "failed" });

    const callbackUrl = (await getCompanionTriggerForWebhook({
      triggerId: trigger.id,
      database: integrationDb,
    }))!.secret;
    const recoveredRequests: string[] = [];
    const recoveredFetch = asFetch(async (url) => {
      recoveredRequests.push(String(url));
      return new Response(JSON.stringify([{
        id: 515151,
        config: { url: `${WEBHOOK_BASE_URL}/v1/hooks/triggers/${trigger.id}/${callbackUrl}` },
      }]), { status: 200 });
    });
    await expect(asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: recoveredFetch,
    }))).resolves.toEqual({ status: "registered", remote_hook_id: "515151" });
    expect(recoveredRequests).toEqual([
      "https://api.github.com/repos/acme/demo/hooks?per_page=100",
    ]);

    // Linear needs a member-scoped API-key provider account and says so plainly when absent.
    const linearAccount = await saveCompanionPlugin({
      actor: fixture.owner,
      orgId: fixture.orgA,
      plugin: { provider: "linear", label: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", args: [] },
      masterKey,
      database: integrationDb,
    });
    await integrationDb.update(schema.companions)
      .set({ selectedMcpAccountIds: [linearAccount.id] })
      .where(eq(schema.companions.id, companionId));
    const linearTrigger = await asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      name: "New ticket",
      prompt: "Triage the ticket.",
      provider: "linear",
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    await expect(asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: linearTrigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
    }))).resolves.toMatchObject({ status: "failed", error: /no connected linear trigger provider account/ });
  });

  it("registers a linear webhook once the plugin's trigger key is stored, and unwires it", async () => {
    const linearAccount = await saveCompanionPlugin({
      actor: fixture.owner,
      orgId: fixture.orgA,
      plugin: { provider: "linear", label: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", args: [] },
      masterKey,
      database: integrationDb,
    });
    await integrationDb.update(schema.companions)
      .set({ selectedMcpAccountIds: [linearAccount.id] })
      .where(eq(schema.companions.id, companionId));
    const trigger = await asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      name: "New ticket",
      prompt: "Triage the ticket.",
      provider: "linear",
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));

    // Without a stored trigger key the registration says exactly what is missing.
    await expect(asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
    }))).resolves.toMatchObject({ status: "failed", error: /no connected linear trigger provider account/ });

    // Storing the key unlocks the GraphQL registration path.
    await asActor(fixture.owner, (database) => saveCompanionPluginTriggerKey({
      actor: fixture.owner,
      orgId: fixture.orgA,
      provider: "linear",
      credential: "lin_api_integration_key",
      masterKey,
      database,
    }));
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const okFetch = asFetch(async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      const requestBody = JSON.parse(String(init?.body));
      if (requestBody.query.includes("query CompanionWebhooks")) {
        return new Response(JSON.stringify({
          data: { webhooks: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { webhookSubscriptionCreate: { success: true, webhookSubscription: { id: "linear-hook-1" } } },
      }), { status: 200 });
    });
    const outcome = await asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: okFetch,
    }));
    expect(outcome).toEqual({ status: "registered", remote_hook_id: "linear-hook-1" });
    expect((await triggerRow(trigger.id)).registrationStatus).toBe("registered");
    const body = JSON.parse(String(requests[1]!.init.body));
    expect(requests[0]!.url).toBe("https://api.linear.app/graphql");
    expect(requests[1]!.url).toBe("https://api.linear.app/graphql");
    expect(body.variables.input.url).toContain(`/v1/hooks/triggers/${trigger.id}/`);
    expect(body.variables.input.secret).toBe((await getCompanionTriggerForWebhook({
      triggerId: trigger.id,
      database: integrationDb,
    }))!.secret);
    // SAFETY: this request's headers were built by registerLinearTriggerWebhook as a plain string record.
    expect((requests[0]!.init.headers as Record<string, string>).authorization)
      .toBe("lin_api_integration_key");
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(JSON.stringify({
        data: { webhooks: {
          nodes: [{ id: "linear-hook-1", url: trigger.webhook_url }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } },
      }), { status: 200 })),
    }))).resolves.toBe("present");
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(JSON.stringify({
        data: { webhooks: { nodes: [] } },
      }), { status: 200 })),
    }))).rejects.toMatchObject({ code: "provider_rejected" });

    // Unregistering removes the remote subscription and keeps provider intent unregistered.
    const rejectedDeleteFetch = asFetch(async () => new Response(JSON.stringify({
      errors: [{ message: "subscription could not be removed" }],
      data: { webhookSubscriptionDelete: { success: false } },
    }), { status: 200 }));
    await expect(asActor(fixture.owner, (database) => unregisterCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: rejectedDeleteFetch,
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    expect(await triggerRow(trigger.id)).toMatchObject({
      registrationStatus: "registered",
      remoteHookId: "linear-hook-1",
    });

    const deleteRequests: Array<{ url: string; init: RequestInit }> = [];
    const deleteFetch = asFetch(async (url, init) => {
      deleteRequests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        data: { webhookSubscriptionDelete: { success: true } },
      }), { status: 200 });
    });
    await asActor(fixture.owner, (database) => unregisterCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: deleteFetch,
    }));
    const row = await triggerRow(trigger.id);
    expect(row.registrationStatus).toBe("unregistered");
    expect(row.remoteHookId).toBeNull();
    const deleteBody = JSON.parse(String(deleteRequests[0]!.init.body));
    expect(deleteBody.variables.id).toBe("linear-hook-1");
  });

  it("serializes concurrent remote registration retries for one trigger", async () => {
    const trigger = await createTrigger(fixture.owner, "Serialized registration");
    let releaseCreate: (() => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const firstFetch = asFetch(async (_url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response("[]", { status: 200 });
      }
      markCreateStarted?.();
      await createReleased;
      return new Response(JSON.stringify({ id: 616161 }), { status: 201 });
    });
    let secondFetchCalls = 0;
    const secondFetch = asFetch(async () => {
      secondFetchCalls += 1;
      return new Response(JSON.stringify({ id: 717171 }), { status: 201 });
    });

    const first = asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: firstFetch,
    }));
    await createStarted;
    const second = asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: secondFetch,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondFetchCalls).toBe(0);
    releaseCreate?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "registered", remote_hook_id: "616161" },
      { status: "registered", remote_hook_id: "616161" },
    ]);
    expect(secondFetchCalls).toBe(0);
  });

  it("reconciles Sentry service hooks before creating a remote duplicate", async () => {
    await saveCompanionTriggerProviderAccount({
      actor: fixture.owner,
      orgId: fixture.orgA,
      account: {
        provider: "sentry",
        label: "Sentry",
        credential: "sentry_registration_test_token",
      },
      masterKey,
      database: integrationDb,
    });
    const trigger = await asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      name: "New Sentry issue",
      prompt: "Triage the issue.",
      provider: "sentry",
      target: { organization: "acme", project: "frontend", events: ["error"] },
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    const requests: Array<{ url: string; method: string }> = [];
    const providerFetch = asFetch(async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url: String(url), method });
      if (method === "GET") return new Response("[]", { status: 200 });
      return new Response(JSON.stringify({ id: "sentry-hook-1" }), { status: 201 });
    });

    await expect(asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: providerFetch,
    }))).resolves.toEqual({ status: "registered", remote_hook_id: "sentry-hook-1" });
    expect(requests).toEqual([
      { url: "https://sentry.io/api/0/projects/acme/frontend/hooks/", method: "GET" },
      { url: "https://sentry.io/api/0/projects/acme/frontend/hooks/", method: "POST" },
    ]);

    let duplicateCreateCalls = 0;
    const existingFetch = asFetch(async (url) => {
      duplicateCreateCalls += 1;
      return String(url).endsWith("/hooks/")
        ? new Response(JSON.stringify([{
            id: "sentry-hook-1",
            url: trigger.webhook_url,
          }]), { status: 200 })
        : new Response(JSON.stringify({ id: "sentry-hook-1" }), { status: 200 });
    });
    await integrationDb.update(schema.companionTriggers).set({ registrationStatus: "failed" })
      .where(eq(schema.companionTriggers.id, trigger.id));
    await expect(asActor(fixture.owner, (database) => registerCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: existingFetch,
    }))).resolves.toEqual({ status: "registered", remote_hook_id: "sentry-hook-1" });
    expect(duplicateCreateCalls).toBe(1);
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: existingFetch,
    }))).resolves.toBe("present");
    let terminalPageCalls = 0;
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => {
        terminalPageCalls += 1;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            link: '<https://sentry.io/api/0/projects/acme/frontend/hooks/?cursor=next>; rel="next"; results="false"',
          },
        });
      }),
    }))).resolves.toBe("absent");
    expect(terminalPageCalls).toBe(1);
    let nextPageCalls = 0;
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => {
        nextPageCalls += 1;
        return nextPageCalls === 1
          ? new Response(JSON.stringify([]), {
              status: 200,
              headers: {
                link: '<https://sentry.io/api/0/projects/acme/frontend/hooks/?cursor=next>; rel=next; results=true',
              },
            })
          : new Response(JSON.stringify([{ id: "sentry-hook-1" }]), { status: 200 });
      }),
    }))).resolves.toBe("present");
    expect(nextPageCalls).toBe(2);
    const invalidSentryPagination = [
      '<https://sentry.io/api/0/projects/acme/frontend/hooks/?cursor=next>; rel=next',
      '<https://sentry.io/api/0/projects/acme/frontend/hooks/?cursor=next>; rel=next; results=unknown',
      '<https://sentry.io/api/0/projects/acme/frontend/hooks/?cursor=next>; rel=next; results=true; results=false',
    ];
    for (const link of invalidSentryPagination) {
      await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
        orgId: fixture.orgA,
        companionId,
        triggerId: trigger.id,
        webhookBaseUrl: WEBHOOK_BASE_URL,
        masterKey,
        database,
        fetch: asFetch(async () => new Response(JSON.stringify([]), {
          status: 200,
          headers: { link },
        })),
      }))).rejects.toMatchObject({ code: "provider_rejected" });
    }
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(JSON.stringify([]), {
        status: 200,
        headers: { link: '<https://untrusted.invalid/hooks/?cursor=next>; rel="next"' },
      })),
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(JSON.stringify([]), { status: 200 })),
    }))).resolves.toBe("absent");
    await integrationDb.update(schema.companionTriggers).set({ target: {} })
      .where(eq(schema.companionTriggers.id, trigger.id));
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: existingFetch,
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(asActor(fixture.owner, (database) => unregisterCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: existingFetch,
      preserveRegistration: true,
    }))).rejects.toMatchObject({ code: "provider_rejected" });
    await integrationDb.update(schema.companionTriggers).set({
      target: { organization: "acme", project: "frontend", events: ["error"] },
    }).where(eq(schema.companionTriggers.id, trigger.id));
    await expect(asActor(fixture.owner, (database) => inspectCompanionTriggerWebhookV2({
      orgId: fixture.orgA,
      companionId,
      triggerId: trigger.id,
      webhookBaseUrl: WEBHOOK_BASE_URL,
      masterKey,
      database,
      fetch: asFetch(async () => new Response(null, { status: 404 })),
    }))).rejects.toMatchObject({ code: "provider_rejected" });
  });

  it("applies an approved trigger proposal under the approver and refuses every other path", async () => {
    const proposal = {
      kind: "trigger",
      name: "CI failed on main",
      prompt: "Investigate the failing workflow.",
      provider: "github",
      target: { repo: "acme/demo", events: ["push", "pull_request"] },
    };
    const allowKey = `trigger-allow-${randomUUID()}`;
    const denyKey = `trigger-deny-${randomUUID()}`;
    const genericKey = `trigger-generic-${randomUUID()}`;
    const expiredKey = `trigger-expired-${randomUUID()}`;
    const requests = [
      { key: allowKey, expiresAt: new Date(Date.now() + 10 * 60_000) },
      { key: denyKey, expiresAt: new Date(Date.now() + 10 * 60_000) },
      { key: genericKey, expiresAt: new Date(Date.now() + 10 * 60_000) },
      { key: expiredKey, expiresAt: new Date(Date.now() - 60_000) },
    ];

    // Seed the pending deliveries the way the runtime projects a `propose_trigger` card: one
    // needs_input turn and attempt, one delivery plus one pending transcript decision per request.
    const turnId = randomUUID();
    const attemptId = randomUUID();
    const clientMessageId = randomUUID();
    await integrationSql`
      insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
      values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${requests.length + 1}, now()
      )
      on conflict (companion_id) do update
      set next_ordinal = ${requests.length + 1}, updated_at = now()
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
        0, 'user', 'Set up a CI trigger for me', ${fixture.owner.id}
      )
    `;
    await integrationSql`
      insert into companion_turns (
        id, org_id, companion_id, client_message_id, message_event_id,
        queue_sequence, actor_id, client_surface, status,
        inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${turnId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid,
        ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
        ${fixture.owner.id}, 'web', 'needs_input',
        now() + interval '10 minutes', now() + interval '2 hours'
      )
    `;
    await integrationSql`
      insert into companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, provider_credential_refs, selected_skill_ids,
        selected_mcp_account_ids, mcp_credential_refs,
        status, checkpoint, dispatch_state, command_id,
        dispatch_accepted_at, pi_invocation_id, last_activity_at
      ) values (
        ${attemptId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
        1, ${fixture.owner.id}, 1, 1, 1, 'claude-opus-4-8',
        ${JSON.stringify(["anthropic"])}::jsonb,
        ${JSON.stringify([{ provider_id: "anthropic", credential_generation: randomUUID(), credential_version: 1 }])}::jsonb,
        ${JSON.stringify([])}::jsonb, ${JSON.stringify([])}::jsonb, ${JSON.stringify([])}::jsonb,
        'needs_input', 'needs_input', 'accepted', ${randomUUID()}::uuid,
        now(), ${`pi-${attemptId}`}, now()
      )
    `;
    for (const [index, request] of requests.entries()) {
      await integrationSql`
        insert into companion_decision_deliveries(
          org_id, companion_id, turn_id, attempt_id,
          request_key, request_kind, expires_at, proposal
        ) values (
          ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
          ${request.key}, 'trigger_proposal', ${request.expiresAt.toISOString()},
          ${JSON.stringify(proposal)}::jsonb
        )
      `;
      const decision = {
        request_id: request.key,
        kind: "trigger",
        name: "propose_trigger",
        title: "Create the CI trigger",
        detail: "Wake me when CI on main fails",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: request.expiresAt.toISOString(),
        proposal,
      };
      await integrationSql`
        insert into companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision
        ) values (
          ${fixture.orgA}::uuid, ${companionId}::uuid, ${`decision:${request.key}`},
          ${index + 1}, 'decision', ${decision.title}, ${JSON.stringify(decision)}::jsonb
        )
      `;
    }

    // The approver is a workspace Editor, not the Owner: the created row must be theirs.
    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "editor",
      database,
    }));
    await asActor(fixture.developer, (database) => answerCompanionTriggerDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: allowKey,
      decision: "allow",
      database,
    }));
    const triggers = await asActor(fixture.owner, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      name: proposal.name,
      prompt: proposal.prompt,
      provider: proposal.provider,
      target: proposal.target,
      registration_status: "manual",
      enabled: true,
    });
    expect(triggers[0]!.webhook_url).not.toBeNull();
    const created = await triggerRow(triggers[0]!.id);
    expect(created.createdBy).toBe(fixture.developer.id);
    expect(created.secret).toMatch(SECRET_PATTERN);

    // Replaying the same allow is idempotent for the same approver: still exactly one trigger.
    await asActor(fixture.developer, (database) => answerCompanionTriggerDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: allowKey,
      decision: "allow",
      database,
    }));
    await expect(asActor(fixture.owner, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }))).resolves.toHaveLength(1);

    // Deny settles the delivery and creates nothing.
    await asActor(fixture.developer, (database) => answerCompanionTriggerDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: denyKey,
      decision: "deny",
      database,
    }));
    await expect(asActor(fixture.owner, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }))).resolves.toHaveLength(1);
    const [denied] = await integrationDb
      .select({ decisionStatus: schema.companionDecisionDeliveries.decisionStatus })
      .from(schema.companionDecisionDeliveries)
      .where(eq(schema.companionDecisionDeliveries.requestKey, denyKey));
    expect(denied).toEqual({ decisionStatus: "denied" });

    // The generic answer path stays fail-closed for trigger proposals.
    await expectSqlState(asActor(fixture.owner, (database) => database.execute(drizzleSql`
      select * from public.companion_api_answer_decision(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${genericKey}, 'allow', null
      )
    `)), "22023");

    // An expired card cannot be approved into a live webhook.
    await expect(asActor(fixture.developer, (database) => answerCompanionTriggerDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: expiredKey,
      decision: "allow",
      database,
    }))).rejects.toMatchObject({
      name: CompanionTriggerDecisionUpdateError.name,
      code: "trigger_update_failed",
      httpStatus: 409,
      message: "Unable to apply the trigger proposal. Please try again.",
    });
  });

  it("recovers unavailable proposal account ids without crossing the approver boundary", async () => {
    const [ownerProviderAccount] = await integrationDb
      .select({ id: schema.companionTriggerProviderAccounts.id })
      .from(schema.companionTriggerProviderAccounts)
      .where(and(
        eq(schema.companionTriggerProviderAccounts.orgId, fixture.orgA),
        eq(schema.companionTriggerProviderAccounts.ownerId, fixture.owner.id),
        eq(schema.companionTriggerProviderAccounts.provider, "github"),
      ));
    expect(ownerProviderAccount).toBeDefined();

    const developerProviderAccount = await saveCompanionTriggerProviderAccount({
      actor: fixture.developer,
      orgId: fixture.orgA,
      account: { provider: "github", label: "Developer GitHub", credential: "developer-token" },
      masterKey,
      database: integrationDb,
    });
    const otherTenantProviderAccount = await saveCompanionTriggerProviderAccount({
      actor: fixture.outsider,
      orgId: fixture.orgB,
      account: { provider: "github", label: "Other tenant GitHub", credential: "tenant-token" },
      masterKey,
      database: integrationDb,
    });
    const unrelatedRequestId = randomUUID();
    const requests = [
      {
        key: `trigger-unavailable-${randomUUID()}`,
        name: "Unavailable proposal account",
        providerAccountId: unrelatedRequestId,
      },
      {
        key: `trigger-valid-${randomUUID()}`,
        name: "Valid historical account",
        providerAccountId: ownerProviderAccount!.id,
      },
      {
        key: `trigger-other-member-${randomUUID()}`,
        name: "Other member account",
        providerAccountId: developerProviderAccount.id,
      },
      {
        key: `trigger-other-tenant-${randomUUID()}`,
        name: "Other tenant account",
        providerAccountId: otherTenantProviderAccount.id,
      },
      {
        key: `trigger-ambiguous-${randomUUID()}`,
        name: "Ambiguous account fallback",
        providerAccountId: unrelatedRequestId,
      },
    ];
    const turnId = randomUUID();
    const attemptId = randomUUID();
    const clientMessageId = randomUUID();
    await integrationSql`
      insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
      values (${fixture.orgA}::uuid, ${companionId}::uuid, ${requests.length + 1}, now())
      on conflict (companion_id) do update
      set next_ordinal = ${requests.length + 1}, updated_at = now()
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
        0, 'user', 'Set up GitHub triggers', ${fixture.owner.id}
      )
    `;
    await integrationSql`
      insert into companion_turns(
        id, org_id, companion_id, client_message_id, message_event_id,
        queue_sequence, actor_id, client_surface, status,
        inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${turnId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid,
        ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
        ${fixture.owner.id}, 'web', 'needs_input',
        now() + interval '10 minutes', now() + interval '2 hours'
      )
    `;
    await integrationSql`
      insert into companion_turn_attempts(
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, provider_credential_refs, selected_skill_ids,
        selected_mcp_account_ids, mcp_credential_refs,
        status, checkpoint, dispatch_state, command_id,
        dispatch_accepted_at, pi_invocation_id, last_activity_at
      ) values (
        ${attemptId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
        1, ${fixture.owner.id}, 1, 1, 1, 'claude-opus-4-8',
        ${JSON.stringify(["anthropic"])}::jsonb,
        ${JSON.stringify([{ provider_id: "anthropic", credential_generation: randomUUID(), credential_version: 1 }])}::jsonb,
        ${JSON.stringify([])}::jsonb, ${JSON.stringify([])}::jsonb, ${JSON.stringify([])}::jsonb,
        'needs_input', 'needs_input', 'accepted', ${randomUUID()}::uuid,
        now(), ${`pi-${attemptId}`}, now()
      )
    `;
    for (const [index, request] of requests.entries()) {
      const proposal = {
        kind: "trigger",
        name: request.name,
        prompt: `Handle ${request.name}.`,
        mode: "relay",
        provider: "github",
        provider_account_id: request.providerAccountId,
        target: { repo: "acme/demo", events: ["push"] },
      };
      await integrationSql`
        insert into companion_decision_deliveries(
          org_id, companion_id, turn_id, attempt_id,
          request_key, request_kind, expires_at, proposal
        ) values (
          ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
          ${request.key}, 'trigger_proposal', now() + interval '10 minutes',
          ${JSON.stringify(proposal)}::jsonb
        )
      `;
      const decision = {
        request_id: request.key,
        kind: "trigger",
        name: "propose_trigger",
        title: `Create ${request.name}`,
        detail: request.name,
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        proposal,
      };
      await integrationSql`
        insert into companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision
        ) values (
          ${fixture.orgA}::uuid, ${companionId}::uuid, ${`decision:${request.key}`},
          ${index + 1}, 'decision', ${decision.title}, ${JSON.stringify(decision)}::jsonb
        )
      `;
    }

    for (const request of [requests[0]!, requests[2]!, requests[3]!]) {
      await asActor(fixture.owner, (database) => answerCompanionTriggerDecisionV2({
        orgId: fixture.orgA,
        companionId,
        requestId: request.key,
        decision: "allow",
        database,
      }));
    }

    await saveCompanionTriggerProviderAccount({
      actor: fixture.owner,
      orgId: fixture.orgA,
      account: { provider: "github", label: "Secondary GitHub", credential: "secondary-token" },
      masterKey,
      database: integrationDb,
    });
    // A valid historical choice remains authoritative even after fallback becomes ambiguous.
    await asActor(fixture.owner, (database) => answerCompanionTriggerDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: requests[1]!.key,
      decision: "allow",
      database,
    }));
    const recovered = await asActor(fixture.owner, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }));
    expect(recovered).toHaveLength(4);
    expect(recovered.every((trigger) =>
      trigger.provider_account_id === ownerProviderAccount!.id)).toBe(true);

    await expect(asActor(fixture.owner, (database) => answerCompanionTriggerDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: requests[4]!.key,
      decision: "allow",
      database,
    }))).rejects.toMatchObject({
      name: CompanionTriggerDecisionUpdateError.name,
      code: "trigger_update_failed",
      httpStatus: 400,
    });
    const [ambiguousDelivery] = await integrationDb
      .select({ status: schema.companionDecisionDeliveries.decisionStatus })
      .from(schema.companionDecisionDeliveries)
      .where(eq(schema.companionDecisionDeliveries.requestKey, requests[4]!.key));
    expect(ambiguousDelivery).toEqual({ status: "pending" });
    expect(await asActor(fixture.owner, (database) => listCompanionTriggersV2({
      orgId: fixture.orgA,
      companionId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    }))).toHaveLength(4);

    await expectSqlState(asActor(fixture.owner, (database) => createCompanionTriggerV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Direct invalid account"),
      providerAccountId: unrelatedRequestId,
      database,
      webhookBaseUrl: WEBHOOK_BASE_URL,
    })), "42501");
  });
});
