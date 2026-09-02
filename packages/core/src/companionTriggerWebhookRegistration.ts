import { sql } from "drizzle-orm";
import { z } from "zod";

import { sanitizeCompanionRuntimeError } from "./companionRuntimeErrors";
import {
  CompanionRuntimeCredentialError,
  decryptCompanionMcpRuntimeCredential,
} from "./companionRuntimeCredentials";
import { decryptOpaqueValue } from "./secretsCrypto";
import { COMPANION_TRIGGER_PROVIDER_CREDENTIAL_PURPOSE } from "./companionTriggerProviderAccounts";
import type { Db } from "@companion/db";

/**
 * Provider-side webhook wiring for zero-friction triggers. Creation and chat approval invoke this
 * synchronously. Trigger-provider authority is member-scoped and never depends on a Companion's
 * MCP attachments. OAuth providers reuse the MCP credential; API-key providers own an envelope.
 */
export class CompanionTriggerRegistrationError extends Error {
  constructor(
    readonly code:
      | "trigger_not_found"
      | "target_required"
      | "provider_unwired"
      | "provider_account_disconnected"
      | "provider_account_ambiguous"
      | "plugin_auth_invalid"
      | "provider_rejected",
    message: string,
  ) {
    super(message);
    this.name = "CompanionTriggerRegistrationError";
  }
}

const GITHUB_API = "https://api.github.com";
const LINEAR_API = "https://api.linear.app/graphql";
const SENTRY_API = "https://sentry.io/api/0";

/** The raw secret row the registration path needs: the secret doubles as the provider HMAC key. */
const registrationTriggerSchema = z.object({
  id: z.string().uuid(),
  companion_id: z.string().uuid(),
  name: z.string(),
  provider: z.enum(["webhook", "linear", "github", "sentry", "custom"]),
  provider_account_id: z.string().uuid().nullable().default(null),
  target: z.object({
    repo: z.string().optional(),
    organization: z.string().optional(),
    project: z.string().optional(),
    events: z.array(z.string()).optional(),
  })
    .nullable()
    .default(null),
  webhook_url: z.string().url(),
  secret: z.string().regex(/^[0-9a-f]{32,128}$/),
  registration_status: z.enum(["manual", "unregistered", "registered", "failed"]),
  remote_hook_id: z.string().nullable(),
  remote_hook_account_id: z.string().uuid().nullable().default(null),
});

type RegistrationTrigger = z.infer<typeof registrationTriggerSchema>;

async function loadRegistrationTrigger(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  database: Db;
}): Promise<RegistrationTrigger> {
  const result = await input.database.execute(sql`
    select public.companion_api_get_trigger_for_registration(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.triggerId}::uuid,
      ${input.webhookBaseUrl.replace(/\/+$/, "")}
    ) as trigger
  `);
  // SAFETY: database.execute resolves to an iterable of rows; the RPC above returns exactly one trigger column.
  const [row] = Array.from(result as Iterable<{ trigger: unknown }>);
  const parsed = registrationTriggerSchema.safeParse(row?.trigger);
  if (!parsed.success) {
    throw new CompanionTriggerRegistrationError("trigger_not_found", "companion trigger not found");
  }
  return parsed.data;
}

interface TriggerProviderQueryRow {
  provider_account_id: unknown;
  credential_source: unknown;
  mcp_account_id: unknown;
  credential_generation: unknown;
  ciphertext: unknown;
  iv: unknown;
  auth_tag: unknown;
  wrapped_dek: unknown;
  wrap_iv: unknown;
  wrap_auth_tag: unknown;
  key_id: unknown;
}

interface TriggerProviderAccount {
  id: string;
  credentialSource: "mcp_oauth" | "api_key";
  credentialAccountId: string;
  credentialGeneration: string;
  envelope: {
    ciphertext: string;
    iv: string;
    authTag: string;
    wrappedDek: string;
    wrapIv: string;
    wrapAuthTag: string;
    keyId: string;
  };
}

async function loadTriggerProviderAccount(input: {
  orgId: string;
  provider: "github" | "linear" | "sentry";
  providerAccountId?: string | null;
  database: Db;
}): Promise<TriggerProviderAccount> {
  const result = await input.database.execute(sql`
    select provider_account.id as provider_account_id, provider_account.credential_source,
           provider_account.mcp_account_id,
           coalesce(mcp_account.credential_generation, provider_account.credential_generation) as credential_generation,
           coalesce(mcp_account.ciphertext, provider_account.ciphertext) as ciphertext,
           coalesce(mcp_account.iv, provider_account.iv) as iv,
           coalesce(mcp_account.auth_tag, provider_account.auth_tag) as auth_tag,
           coalesce(mcp_account.wrapped_dek, provider_account.wrapped_dek) as wrapped_dek,
           coalesce(mcp_account.wrap_iv, provider_account.wrap_iv) as wrap_iv,
           coalesce(mcp_account.wrap_auth_tag, provider_account.wrap_auth_tag) as wrap_auth_tag,
           coalesce(mcp_account.key_id, provider_account.key_id) as key_id
    from public.companion_trigger_provider_accounts provider_account
    left join public.companion_mcp_accounts mcp_account
      on mcp_account.org_id = provider_account.org_id
     and mcp_account.id = provider_account.mcp_account_id
    where provider_account.org_id = ${input.orgId}::uuid
      and provider_account.owner_id = public.companion_api_actor(${input.orgId}::uuid)
      and provider_account.provider = ${input.provider}
      and provider_account.status = 'connected'
      and (${input.providerAccountId ?? null}::uuid is null
        or provider_account.id = ${input.providerAccountId ?? null}::uuid)
    order by provider_account.updated_at desc
    limit 2
  `);
  // SAFETY: the query above selects exactly the TriggerProviderQueryRow aliases.
  const found = Array.from(result as Iterable<TriggerProviderQueryRow>);
  const [row] = found;
  if (!row) {
    throw new CompanionTriggerRegistrationError(
      "provider_account_disconnected",
      `no connected ${input.provider} trigger provider account is available`,
    );
  }
  if (found.length > 1) {
    throw new CompanionTriggerRegistrationError(
      "provider_account_ambiguous",
      `multiple ${input.provider} trigger provider accounts are eligible; choose provider_account_id`,
    );
  }
  const credentialSource = String(row.credential_source);
  if (credentialSource !== "mcp_oauth" && credentialSource !== "api_key") {
    throw new CompanionTriggerRegistrationError(
      "plugin_auth_invalid",
      "the trigger provider credential source is invalid; reconnect the provider",
    );
  }
  return {
    id: String(row.provider_account_id),
    credentialSource,
    credentialAccountId: String(row.mcp_account_id ?? row.provider_account_id),
    credentialGeneration: String(row.credential_generation),
    envelope: {
      ciphertext: String(row.ciphertext),
      iv: String(row.iv),
      authTag: String(row.auth_tag),
      wrappedDek: String(row.wrapped_dek),
      wrapIv: String(row.wrap_iv),
      wrapAuthTag: String(row.wrap_auth_tag),
      keyId: String(row.key_id),
    },
  };
}

function providerTokenOf(account: TriggerProviderAccount, orgId: string, masterKey: Buffer): string {
  try {
    if (account.credentialSource === "mcp_oauth") {
      const credential = decryptCompanionMcpRuntimeCredential({
        orgId,
        accountId: account.credentialAccountId,
        credentialGeneration: account.credentialGeneration,
        envelope: account.envelope,
      }, masterKey);
      if (credential.kind !== "oauth") throw new Error("expected an oauth credential");
      return credential.credential.accessToken;
    }
    return decryptOpaqueValue({
      orgId,
      purpose: COMPANION_TRIGGER_PROVIDER_CREDENTIAL_PURPOSE,
      subjectId: `${account.id}:${account.credentialGeneration}`,
      ...account.envelope,
    }, masterKey);
  } catch (error) {
    if (error instanceof CompanionRuntimeCredentialError) {
      throw new CompanionTriggerRegistrationError(
        "plugin_auth_invalid",
        "the provider credential is unreadable; reconnect the provider",
      );
    }
    throw error;
  }
}

async function persistRegistration(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  accountId: string | null;
  remoteHookId: string | null;
  status: "manual" | "unregistered" | "registered" | "failed";
  error: string | null;
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select public.companion_api_set_trigger_registration(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.triggerId}::uuid,
      ${input.accountId}::uuid,
      ${input.remoteHookId},
      ${input.status},
      ${input.error}
    )
  `);
}

export type CompanionTriggerRegistrationOutcome =
  | { status: "registered"; remote_hook_id: string }
  | { status: "failed"; error: string }
  | { status: "manual" };

const LINEAR_CREATE_MUTATION = `
  mutation WebhookCreate($input: WebhookSubscriptionCreateInput!) {
    webhookSubscriptionCreate(input: $input) {
      success
      webhookSubscription { id }
    }
  }
`;

const LINEAR_DELETE_MUTATION = `
  mutation WebhookDelete($id: String!) {
    webhookSubscriptionDelete(id: $id) { success }
  }
`;

const LINEAR_LIST_QUERY = `
  query CompanionWebhooks {
    webhooks {
      nodes { id url }
    }
  }
`;

function githubHeaders(token: string) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "companion-github-sync",
    "x-github-api-version": "2022-11-28",
  };
}

async function findGitHubWebhook(input: {
  fetch: typeof globalThis.fetch;
  repoPath: string;
  token: string;
  webhookUrl: string;
}): Promise<string | null> {
  const response = await input.fetch(`${GITHUB_API}/repos/${input.repoPath}/hooks?per_page=100`, {
    headers: githubHeaders(input.token),
  });
  const hooks = z.array(z.object({
    id: z.number().int(),
    config: z.object({ url: z.string() }).passthrough(),
  })).safeParse(await response.json().catch(() => null));
  if (!response.ok || !hooks.success) {
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      `github webhook reconciliation failed (${response.status})`,
    );
  }
  const hook = hooks.data.find((candidate) => candidate.config.url === input.webhookUrl);
  return hook ? String(hook.id) : null;
}

async function findLinearWebhook(input: {
  fetch: typeof globalThis.fetch;
  token: string;
  webhookUrl: string;
}): Promise<string | null> {
  const response = await input.fetch(LINEAR_API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: input.token.trim() },
    body: JSON.stringify({ query: LINEAR_LIST_QUERY }),
  });
  const payload = z.object({
    data: z.object({
      webhooks: z.object({ nodes: z.array(z.object({ id: z.string(), url: z.string() })) }),
    }).optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
  }).safeParse(await response.json().catch(() => null));
  if (!response.ok || !payload.success || payload.data.errors?.length || !payload.data.data) {
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      `linear webhook reconciliation failed (${response.status})`,
    );
  }
  return payload.data.data.webhooks.nodes.find((candidate) => candidate.url === input.webhookUrl)?.id ?? null;
}

async function findSentryWebhook(input: {
  fetch: typeof globalThis.fetch;
  projectPath: string;
  token: string;
  webhookUrl: string;
}): Promise<string | null> {
  const response = await input.fetch(`${SENTRY_API}/projects/${input.projectPath}/hooks/`, {
    headers: { authorization: `Bearer ${input.token}` },
  });
  const hooks = z.array(z.object({ id: z.string().min(1).max(200), url: z.string() }))
    .safeParse(await response.json().catch(() => null));
  if (!response.ok || !hooks.success) {
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      `Sentry webhook reconciliation failed (${response.status})`,
    );
  }
  return hooks.data.find((candidate) => candidate.url === input.webhookUrl)?.id ?? null;
}

async function linearTriggerKeyToken(input: {
  orgId: string;
  providerAccountId?: string | null;
  masterKey: Buffer;
  database: Db;
}): Promise<{ accountId: string; token: string }> {
  const account = await loadTriggerProviderAccount({
    orgId: input.orgId,
    provider: "linear",
    providerAccountId: input.providerAccountId,
    database: input.database,
  });
  return { accountId: account.id, token: providerTokenOf(account, input.orgId, input.masterKey) };
}

async function registerLinearTriggerWebhook(
  input: Parameters<typeof loadRegistrationTrigger>[0] & { masterKey: Buffer; fetch?: typeof globalThis.fetch },
  trigger: RegistrationTrigger,
): Promise<CompanionTriggerRegistrationOutcome> {
  const key = await linearTriggerKeyToken({
    ...input,
    providerAccountId: trigger.provider_account_id,
  });
  const doFetch = input.fetch ?? globalThis.fetch;
  let existingHookId: string | null;
  try {
    existingHookId = await findLinearWebhook({
      fetch: doFetch,
      token: key.token,
      webhookUrl: trigger.webhook_url,
    });
  } catch (error) {
    const message = error instanceof CompanionTriggerRegistrationError
      ? error.message
      : "linear webhook reconciliation could not reach the provider";
    await persistRegistration({
      ...input,
      accountId: trigger.remote_hook_account_id ?? key.accountId,
      remoteHookId: trigger.remote_hook_id,
      status: "failed",
      error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    });
    return { status: "failed", error: message };
  }
  if (existingHookId) {
    await persistRegistration({
      ...input,
      accountId: key.accountId,
      remoteHookId: existingHookId,
      status: "registered",
      error: null,
    });
    return { status: "registered", remote_hook_id: existingHookId };
  }
  let response: Response;
  try {
    response = await doFetch(LINEAR_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: key.token.trim(),
      },
      body: JSON.stringify({
        query: LINEAR_CREATE_MUTATION,
        variables: {
          input: { url: trigger.webhook_url, secret: trigger.secret, allTeams: true },
        },
      }),
    });
  } catch {
    return recoverLinearRegistration(input, trigger, key, doFetch,
      "linear webhook registration could not reach the provider");
  }
  const payload = z.object({
    data: z.object({
      webhookSubscriptionCreate: z.object({
        success: z.boolean(),
        webhookSubscription: z.object({ id: z.string() }).nullable(),
      }).optional(),
    }).optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
  }).safeParse(await response.json().catch(() => null));
  const created = payload.success
    ? payload.data.data?.webhookSubscriptionCreate
    : undefined;
  if (!response.ok || !created?.success || !created.webhookSubscription) {
    return recoverLinearRegistration(input, trigger, key, doFetch,
      `linear rejected the webhook (${response.status})`);
  }
  const remoteHookId = created.webhookSubscription.id;
  await persistRegistration({
    orgId: input.orgId,
    companionId: input.companionId,
    triggerId: input.triggerId,
    accountId: key.accountId,
    remoteHookId,
    status: "registered",
    error: null,
    database: input.database,
  });
  return { status: "registered", remote_hook_id: remoteHookId };
}

async function recoverLinearRegistration(
  input: { orgId: string; companionId: string; triggerId: string; database: Db },
  trigger: RegistrationTrigger,
  key: { accountId: string; token: string },
  doFetch: typeof globalThis.fetch,
  message: string,
): Promise<CompanionTriggerRegistrationOutcome> {
  let recoveredHookId: string | null = null;
  try {
    recoveredHookId = await findLinearWebhook({
      fetch: doFetch,
      token: key.token,
      webhookUrl: trigger.webhook_url,
    });
  } catch {
    // The create outcome may be ambiguous. Keep any prior remote id and fail closed; the next
    // serialized retry reconciles by callback URL before it attempts another create.
  }
  if (recoveredHookId) {
    await persistRegistration({
      ...input,
      accountId: key.accountId,
      remoteHookId: recoveredHookId,
      status: "registered",
      error: null,
    });
    return { status: "registered", remote_hook_id: recoveredHookId };
  }
  await persistRegistration({
    ...input,
    accountId: trigger.remote_hook_account_id ?? key.accountId,
    remoteHookId: trigger.remote_hook_id,
    status: "failed",
    error: sanitizeCompanionRuntimeError(message).slice(0, 500),
  });
  return { status: "failed", error: message };
}

async function persistLinearFailure(
  input: { orgId: string; companionId: string; triggerId: string; database: Db },
  message: string,
): Promise<{ status: "failed"; error: string }> {
  await persistRegistration({
    orgId: input.orgId,
    companionId: input.companionId,
    triggerId: input.triggerId,
    accountId: null,
    remoteHookId: null,
    status: "failed",
    error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    database: input.database,
  });
  return { status: "failed", error: message };
}

async function registerSentryTriggerWebhook(
  input: Parameters<typeof loadRegistrationTrigger>[0] & { masterKey: Buffer; fetch?: typeof globalThis.fetch },
  trigger: RegistrationTrigger,
): Promise<CompanionTriggerRegistrationOutcome> {
  if (!trigger.target?.organization || !trigger.target.project || !trigger.target.events?.length) {
    const error = "a Sentry trigger needs organization, project, and at least one event";
    await persistRegistration({ ...input, accountId: trigger.provider_account_id, remoteHookId: null, status: "failed", error });
    return { status: "failed", error };
  }
  let account: TriggerProviderAccount;
  let token: string;
  try {
    account = await loadTriggerProviderAccount({
      orgId: input.orgId,
      provider: "sentry",
      providerAccountId: trigger.provider_account_id,
      database: input.database,
    });
    token = providerTokenOf(account, input.orgId, input.masterKey);
  } catch (error) {
    const message = error instanceof CompanionTriggerRegistrationError
      ? error.message
      : "Sentry credential could not be resolved";
    await persistRegistration({
      ...input,
      accountId: trigger.provider_account_id,
      remoteHookId: null,
      status: "failed",
      error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    });
    return { status: "failed", error: message };
  }
  const projectPath = [trigger.target.organization, trigger.target.project]
    .map(encodeURIComponent)
    .join("/");
  const doFetch = input.fetch ?? globalThis.fetch;
  let existingHookId: string | null;
  try {
    existingHookId = await findSentryWebhook({
      fetch: doFetch,
      projectPath,
      token,
      webhookUrl: trigger.webhook_url,
    });
  } catch (error) {
    const message = error instanceof CompanionTriggerRegistrationError
      ? error.message
      : "Sentry webhook reconciliation could not reach the provider";
    await persistRegistration({
      ...input,
      accountId: trigger.remote_hook_account_id ?? account.id,
      remoteHookId: trigger.remote_hook_id,
      status: "failed",
      error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    });
    return { status: "failed", error: message };
  }
  if (existingHookId) {
    await persistRegistration({
      ...input,
      accountId: account.id,
      remoteHookId: existingHookId,
      status: "registered",
      error: null,
    });
    return { status: "registered", remote_hook_id: existingHookId };
  }
  let response: Response;
  try {
    response = await doFetch(`${SENTRY_API}/projects/${projectPath}/hooks/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: trigger.webhook_url, events: trigger.target.events }),
    });
  } catch {
    return recoverSentryRegistration(input, trigger, account.id, token, projectPath, doFetch,
      "Sentry webhook registration could not reach the provider");
  }
  const created = z.object({ id: z.string().min(1).max(200) })
    .safeParse(await response.json().catch(() => null));
  if (!response.ok || !created.success) {
    const error = sanitizeCompanionRuntimeError(`Sentry rejected the webhook (${response.status})`).slice(0, 500);
    return recoverSentryRegistration(input, trigger, account.id, token, projectPath, doFetch, error);
  }
  await persistRegistration({
    ...input,
    accountId: account.id,
    remoteHookId: created.data.id,
    status: "registered",
    error: null,
  });
  return { status: "registered", remote_hook_id: created.data.id };
}

async function recoverSentryRegistration(
  input: { orgId: string; companionId: string; triggerId: string; database: Db },
  trigger: RegistrationTrigger,
  accountId: string,
  token: string,
  projectPath: string,
  doFetch: typeof globalThis.fetch,
  message: string,
): Promise<CompanionTriggerRegistrationOutcome> {
  let recoveredHookId: string | null = null;
  try {
    recoveredHookId = await findSentryWebhook({
      fetch: doFetch,
      projectPath,
      token,
      webhookUrl: trigger.webhook_url,
    });
  } catch {
    // A later retry performs this same lookup before creating another remote hook.
  }
  if (recoveredHookId) {
    await persistRegistration({
      ...input,
      accountId,
      remoteHookId: recoveredHookId,
      status: "registered",
      error: null,
    });
    return { status: "registered", remote_hook_id: recoveredHookId };
  }
  await persistRegistration({
    ...input,
    accountId: trigger.remote_hook_account_id ?? accountId,
    remoteHookId: trigger.remote_hook_id,
    status: "failed",
    error: sanitizeCompanionRuntimeError(message).slice(0, 500),
  });
  return { status: "failed", error: message };
}

/**
 * Attempt the provider-side wiring. Provider rejection is a recorded outcome (`failed`), never an
 * exception: the failure row must survive the caller's transaction. Missing, ambiguous, revoked,
 * or insufficient credentials are persisted as failed registration state for an explicit retry.
 */
export async function registerCompanionTriggerWebhookV2(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  masterKey: Buffer;
  database: Db;
  fetch?: typeof globalThis.fetch;
}): Promise<CompanionTriggerRegistrationOutcome> {
  const trigger = await loadRegistrationTrigger(input);
  // The registration read holds the trigger row lock for the tenant transaction. A concurrent
  // retry observes this committed state instead of issuing a second provider mutation.
  if (trigger.registration_status === "registered" && trigger.remote_hook_id) {
    return { status: "registered", remote_hook_id: trigger.remote_hook_id };
  }
  if (trigger.provider === "sentry") return registerSentryTriggerWebhook(input, trigger);
  if (trigger.provider === "linear") {
    try {
      return await registerLinearTriggerWebhook(input, trigger);
    } catch (error) {
      const message = error instanceof CompanionTriggerRegistrationError
        ? error.message
        : "linear credential could not be resolved";
      return persistLinearFailure(input, message);
    }
  }
  if (trigger.provider === "custom") {
    return { status: "manual" };
  }
  if (trigger.provider === "webhook") {
    return { status: "manual" };
  }
  if (!trigger.target?.repo || !trigger.target.events?.length) {
    const message = "a github trigger needs a target repo and at least one event before registration";
    await persistRegistration({
      ...input,
      accountId: trigger.provider_account_id,
      remoteHookId: null,
      status: "failed",
      error: message,
    });
    return { status: "failed", error: message };
  }

  let account: TriggerProviderAccount;
  let token: string;
  try {
    account = await loadTriggerProviderAccount({
      orgId: input.orgId,
      provider: "github",
      database: input.database,
      providerAccountId: trigger.provider_account_id,
    });
    token = providerTokenOf(account, input.orgId, input.masterKey);
  } catch (error) {
    const message = error instanceof CompanionTriggerRegistrationError
      ? error.message
      : "github credential could not be resolved";
    await persistRegistration({
      ...input,
      accountId: trigger.provider_account_id,
      remoteHookId: null,
      status: "failed",
      error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    });
    return { status: "failed", error: message };
  }
  const doFetch = input.fetch ?? globalThis.fetch;
  // Encode each path segment separately so the owner/repo slash survives.
  const repoPath = trigger.target.repo.split("/").map(encodeURIComponent).join("/");
  let existingHookId: string | null;
  try {
    existingHookId = await findGitHubWebhook({
      fetch: doFetch,
      repoPath,
      token,
      webhookUrl: trigger.webhook_url,
    });
  } catch (error) {
    const message = error instanceof CompanionTriggerRegistrationError
      ? error.message
      : "github webhook reconciliation could not reach the provider";
    await persistRegistration({
      ...input,
      accountId: trigger.remote_hook_account_id ?? account.id,
      remoteHookId: trigger.remote_hook_id,
      status: "failed",
      error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    });
    return { status: "failed", error: message };
  }
  if (existingHookId) {
    await persistRegistration({
      ...input,
      accountId: account.id,
      remoteHookId: existingHookId,
      status: "registered",
      error: null,
    });
    return { status: "registered", remote_hook_id: existingHookId };
  }
  let response: Response;
  try {
    response = await doFetch(
      `${GITHUB_API}/repos/${repoPath}/hooks`,
      {
        method: "POST",
        headers: {
          ...githubHeaders(token),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: trigger.target.events,
          config: {
            url: trigger.webhook_url,
            content_type: "json",
            secret: trigger.secret,
          },
        }),
      },
    );
  } catch {
    return recoverGitHubRegistration(input, trigger, account.id, token, repoPath, doFetch,
      "github webhook registration could not reach the provider");
  }
  if (!response.ok) {
    // The provider has the final word on unknown event names and missing permissions.
    const message = sanitizeCompanionRuntimeError(
      `github rejected the webhook (${response.status})`,
    ).slice(0, 500);
    return recoverGitHubRegistration(input, trigger, account.id, token, repoPath, doFetch, message);
  }
  const created = z.object({ id: z.number().int() }).safeParse(await response.json().catch(() => null));
  if (!created.success) {
    return recoverGitHubRegistration(input, trigger, account.id, token, repoPath, doFetch,
      "github returned an unreadable webhook payload");
  }
  const remoteHookId = String(created.data.id);
  await persistRegistration({
    ...input,
    accountId: account.id,
    remoteHookId,
    status: "registered",
    error: null,
  });
  return { status: "registered", remote_hook_id: remoteHookId };
}

async function recoverGitHubRegistration(
  input: { orgId: string; companionId: string; triggerId: string; database: Db },
  trigger: RegistrationTrigger,
  accountId: string,
  token: string,
  repoPath: string,
  doFetch: typeof globalThis.fetch,
  message: string,
): Promise<CompanionTriggerRegistrationOutcome> {
  let recoveredHookId: string | null = null;
  try {
    recoveredHookId = await findGitHubWebhook({
      fetch: doFetch,
      repoPath,
      token,
      webhookUrl: trigger.webhook_url,
    });
  } catch {
    // A provider-committed request can lose its response. Preserve local evidence and let the
    // next serialized retry reconcile by callback URL before attempting another create.
  }
  if (recoveredHookId) {
    await persistRegistration({
      ...input,
      accountId,
      remoteHookId: recoveredHookId,
      status: "registered",
      error: null,
    });
    return { status: "registered", remote_hook_id: recoveredHookId };
  }
  await persistRegistration({
    ...input,
    accountId: trigger.remote_hook_account_id ?? accountId,
    remoteHookId: trigger.remote_hook_id,
    status: "failed",
    error: sanitizeCompanionRuntimeError(message).slice(0, 500),
  });
  return { status: "failed", error: message };
}

export async function unregisterCompanionTriggerWebhookV2(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  masterKey: Buffer;
  database: Db;
  fetch?: typeof globalThis.fetch;
  /** One-shot purge keeps ownership rows intact until every external resource is gone. */
  preserveRegistration?: boolean;
}): Promise<void> {
  const trigger = await loadRegistrationTrigger(input);
  const persist = input.preserveRegistration
    ? async (): Promise<void> => undefined
    : async (registration: Parameters<typeof persistRegistration>[0]): Promise<void> => {
        await persistRegistration(registration);
      };
  if (trigger.provider === "linear") {
    if (!trigger.remote_hook_id) {
      await persist({
        ...input,
        accountId: null,
        remoteHookId: null,
        status: "unregistered",
        error: null,
      });
      return;
    }
    const key = await linearTriggerKeyToken({
      ...input,
      providerAccountId: trigger.remote_hook_account_id ?? trigger.provider_account_id,
    });
    const doFetch = input.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(LINEAR_API, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: key.token.trim() },
        body: JSON.stringify({
          query: LINEAR_DELETE_MUTATION,
          variables: { id: trigger.remote_hook_id },
        }),
      });
    } catch {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "linear webhook removal could not reach the provider; the registration is kept",
      );
    }
    if (response.status === 404) {
      await persist({
        ...input,
        accountId: null,
        remoteHookId: null,
        status: "unregistered",
        error: null,
      });
      return;
    }
    if (!response.ok) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        `linear refused to remove the webhook (${response.status})`,
      );
    }
    const payload = z.object({
      data: z.object({
        webhookSubscriptionDelete: z.object({ success: z.literal(true) }),
      }).optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    }).safeParse(await response.json().catch(() => null));
    if (!payload.success || payload.data.errors?.length
      || !payload.data.data?.webhookSubscriptionDelete.success) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "linear refused to remove the webhook; the registration is kept",
      );
    }
    await persist({
      ...input,
      accountId: null,
      remoteHookId: null,
      status: "unregistered",
      error: null,
    });
    return;
  }
  if (trigger.provider === "sentry") {
    if (!trigger.remote_hook_id || !trigger.target?.organization || !trigger.target.project) {
      await persist({
        ...input,
        accountId: null,
        remoteHookId: null,
        status: "unregistered",
        error: null,
      });
      return;
    }
    const account = await loadTriggerProviderAccount({
      orgId: input.orgId,
      provider: "sentry",
      providerAccountId: trigger.remote_hook_account_id ?? trigger.provider_account_id,
      database: input.database,
    });
    const token = providerTokenOf(account, input.orgId, input.masterKey);
    const projectPath = [trigger.target.organization, trigger.target.project]
      .map(encodeURIComponent)
      .join("/");
    let response: Response;
    try {
      response = await (input.fetch ?? globalThis.fetch)(
        `${SENTRY_API}/projects/${projectPath}/hooks/${encodeURIComponent(trigger.remote_hook_id)}/`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      );
    } catch {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "Sentry webhook removal could not reach the provider; the registration is kept",
      );
    }
    if (!response.ok && response.status !== 404) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        `Sentry refused to remove the webhook (${response.status})`,
      );
    }
    await persist({
      ...input,
      accountId: null,
      remoteHookId: null,
      status: "unregistered",
      error: null,
    });
    return;
  }
  if (trigger.provider !== "github" || !trigger.target?.repo || !trigger.remote_hook_id) {
    await persist({
      ...input,
      accountId: null,
      remoteHookId: null,
      status: trigger.provider === "webhook" || trigger.provider === "custom" ? "manual" : "unregistered",
      error: null,
    });
    return;
  }
  const account = await loadTriggerProviderAccount({
    orgId: input.orgId,
    provider: "github",
    database: input.database,
    providerAccountId: trigger.remote_hook_account_id ?? trigger.provider_account_id,
  });
  const token = providerTokenOf(account, input.orgId, input.masterKey);
  const doFetch = input.fetch ?? globalThis.fetch;
  const repoPath = trigger.target.repo.split("/").map(encodeURIComponent).join("/");
  let response: Response | null;
  try {
    response = await doFetch(
      `${GITHUB_API}/repos/${repoPath}/hooks/${encodeURIComponent(trigger.remote_hook_id)}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "companion-github-sync",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
  } catch {
    // A transport failure leaves the remote hook live: keep the local wiring so the removal can
    // be retried instead of orphaning a webhook nobody remembers.
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      "github webhook removal could not reach the provider; the registration is kept",
    );
  }
  if (!response.ok && response.status !== 404) {
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      `github refused to remove the webhook (${response.status})`,
    );
  }
  await persist({
    ...input,
    accountId: null,
    remoteHookId: null,
    status: "unregistered",
    error: null,
  });
}
