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
  query CompanionWebhooks($after: String) {
    webhooks(first: 100, after: $after) {
      nodes { id url }
      pageInfo { hasNextPage endCursor }
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
  remoteHookId?: string;
}): Promise<string | null> {
  const seen = new Set<string>();
  let foundId: string | null = null;
  let after: string | null = null;
  for (;;) {
    const response = await input.fetch(LINEAR_API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: input.token.trim() },
      body: JSON.stringify({ query: LINEAR_LIST_QUERY, variables: { after } }),
    });
    const payload = z.object({
      data: z.object({
        webhooks: z.object({
          nodes: z.array(z.object({ id: z.string(), url: z.string() })),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }).optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    }).safeParse(await response.json().catch(() => null));
    if (!response.ok || !payload.success || payload.data.errors?.length || !payload.data.data) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        `linear webhook reconciliation failed (${response.status})`,
      );
    }
    const matches = payload.data.data.webhooks.nodes.filter(
      (candidate) => input.remoteHookId
        ? candidate.id === input.remoteHookId
        : candidate.url === input.webhookUrl,
    );
    if (matches.length > 1 || (foundId && matches.length > 0)) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "linear webhook reconciliation returned duplicate registrations",
      );
    }
    if (matches[0]) foundId = matches[0].id;
    const pageInfo = payload.data.data.webhooks.pageInfo;
    if (!pageInfo.hasNextPage) return foundId;
    if (!pageInfo.endCursor || seen.has(pageInfo.endCursor)) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "linear webhook reconciliation returned invalid pagination",
      );
    }
    seen.add(pageInfo.endCursor);
    after = pageInfo.endCursor;
  }
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

const PROVIDER_WEBHOOK_PAGE_LIMIT = 100;
const LINK_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SUPPORTED_LINK_RELATIONS = new Set(["first", "last", "next", "previous"]);

function malformedProviderPagination(provider: "github" | "Sentry", detail: string): never {
  throw new CompanionTriggerRegistrationError(
    "provider_rejected",
    `${provider} webhook reconciliation returned malformed pagination ${detail}`,
  );
}

function parseProviderLinkParameterValue(
  provider: "github" | "Sentry",
  rawValue: string,
): string {
  if (LINK_TOKEN.test(rawValue)) return rawValue;
  // Accepted Link grammar is intentionally narrower than RFC 8288: provider pagination values may
  // be a token or a non-empty quoted visible-ASCII string without escapes or delimiters. Anything
  // outside that grammar is unknown evidence and must not be interpreted as end-of-list.
  const quoted = /^"([^"\\;,]+)"$/.exec(rawValue);
  if (quoted && ![...quoted[1]!].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f;
  })) return quoted[1]!;
  return malformedProviderPagination(provider, "parameter value");
}

function isProviderPaginationPath(input: {
  provider: "github" | "Sentry";
  currentPath: string;
  candidatePath: string;
}): boolean {
  if (input.candidatePath === input.currentPath) return true;
  return input.provider === "github"
    && /^\/repos\/[^/]+\/[^/]+\/hooks$/.test(input.currentPath)
    && /^\/repositories\/[1-9]\d*\/hooks$/.test(input.candidatePath);
}

function providerNextPageUrl(input: {
  response: Response;
  currentUrl: string;
  provider: "github" | "Sentry";
  seenUrls: ReadonlySet<string>;
}): string | null {
  const link = input.response.headers.get("link");
  if (!link) {
    if (input.provider === "Sentry") {
      return malformedProviderPagination(input.provider, "missing link header");
    }
    return null;
  }
  let next: string | null = null;
  let nextHasResults: boolean | null = null;
  const seenRelations = new Set<string>();
  const current = new URL(input.currentUrl);
  for (const rawPart of link.split(",")) {
    const part = /^\s*<([^<>,\s]+)>((?:\s*;\s*[^;,]+)+)\s*$/.exec(rawPart);
    if (!part) return malformedProviderPagination(input.provider, "link value");
    let relation: string | null = null;
    let results: string | null = null;
    const parameterNames = new Set<string>();
    for (const rawParameter of part[2]!.split(";").slice(1)) {
      const parameter = /^\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*(.+?)\s*$/.exec(rawParameter);
      if (!parameter) return malformedProviderPagination(input.provider, "parameter");
      const name = parameter[1]!.toLowerCase();
      if (parameterNames.has(name)) return malformedProviderPagination(input.provider, "duplicate parameter");
      parameterNames.add(name);
      const value = parseProviderLinkParameterValue(input.provider, parameter[2]!);
      if (name === "rel") {
        const relations = value.toLowerCase().split(/\s+/).map((item) =>
          item === "prev" ? "previous" : item);
        if (relations.length !== 1 || !SUPPORTED_LINK_RELATIONS.has(relations[0]!)) {
          return malformedProviderPagination(input.provider, "relation");
        }
        relation = relations[0]!;
      } else if (name === "results") {
        results = value;
      }
    }
    if (!relation) return malformedProviderPagination(input.provider, "missing relation");
    if (seenRelations.has(relation)) return malformedProviderPagination(input.provider, "duplicate relation");
    seenRelations.add(relation);
    let hasResults: boolean | null = null;
    if (input.provider === "Sentry" && relation === "next") {
      const normalizedResults = results?.toLowerCase();
      if (normalizedResults !== "true" && normalizedResults !== "false") {
        return malformedProviderPagination(input.provider, "results marker");
      }
      hasResults = normalizedResults === "true";
    }
    let candidate: URL;
    try {
      if (!part[1]!.startsWith("https://")) return malformedProviderPagination(input.provider, "URI");
      candidate = new URL(part[1]!);
    } catch {
      return malformedProviderPagination(input.provider, "URI");
    }
    if (
      candidate.protocol !== "https:"
      || candidate.username !== ""
      || candidate.password !== ""
      || candidate.hash !== ""
      || candidate.origin !== current.origin
      || !isProviderPaginationPath({
        provider: input.provider,
        currentPath: current.pathname,
        candidatePath: candidate.pathname,
      })
    ) return malformedProviderPagination(input.provider, "URI boundary");
    if (relation !== "next") continue;
    if (next) return malformedProviderPagination(input.provider, "ambiguous next relation");
    next = candidate.toString();
    nextHasResults = hasResults;
  }
  if (!next) {
    if (input.provider === "Sentry") {
      return malformedProviderPagination(input.provider, "missing next relation");
    }
    return null;
  }
  // Sentry always emits a next cursor. Its documented `results` marker, not cursor presence,
  // determines whether another authenticated page exists.
  if (input.provider === "Sentry" && nextHasResults === false) return null;
  if (input.seenUrls.has(next)) return malformedProviderPagination(input.provider, "cycle");
  return next;
}

async function findWebhookFromProviderList<T>(input: {
  fetch: typeof globalThis.fetch;
  initialUrl: string;
  headers: Record<string, string>;
  provider: "github" | "Sentry";
  schema: z.ZodType<T>;
  matches: (hook: T) => boolean;
  idOf: (hook: T) => string;
}): Promise<string | null> {
  const seen = new Set<string>();
  let foundId: string | null = null;
  let url: string | null = input.initialUrl;
  for (let page = 0; url && page < PROVIDER_WEBHOOK_PAGE_LIMIT; page += 1) {
    if (seen.has(url)) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        `${input.provider} webhook reconciliation repeated pagination`,
      );
    }
    seen.add(url);
    const response = await input.fetch(url, { headers: input.headers });
    const hooks = z.array(input.schema).safeParse(await response.json().catch(() => null));
    if (!response.ok || !hooks.success) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        `${input.provider} webhook reconciliation failed (${response.status})`,
      );
    }
    const nextUrl = providerNextPageUrl({
      response,
      currentUrl: url,
      provider: input.provider,
      seenUrls: seen,
    });
    const matches = hooks.data.filter(input.matches);
    if (matches.length > 1 || (foundId && matches.length > 0)) {
      return malformedProviderPagination(input.provider, "duplicate target registrations");
    }
    if (matches[0]) foundId = input.idOf(matches[0]);
    url = nextUrl;
  }
  if (url) {
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      `${input.provider} webhook reconciliation exceeded its pagination bound`,
    );
  }
  return foundId;
}

async function findTriggerWebhook(input: {
  orgId: string;
  masterKey: Buffer;
  database: Db;
  fetch?: typeof globalThis.fetch;
}, trigger: RegistrationTrigger): Promise<string | null> {
  const doFetch = input.fetch ?? globalThis.fetch;
  if (trigger.provider === "linear") {
    const key = await linearTriggerKeyToken({
      ...input,
      providerAccountId: trigger.remote_hook_account_id ?? trigger.provider_account_id,
    });
    const lookup: Parameters<typeof findLinearWebhook>[0] = {
      fetch: doFetch,
      token: key.token,
      webhookUrl: trigger.webhook_url,
    };
    if (trigger.remote_hook_id) lookup.remoteHookId = trigger.remote_hook_id;
    return findLinearWebhook(lookup);
  }
  if (trigger.provider === "sentry") {
    if (!trigger.target?.organization || !trigger.target.project) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "Sentry webhook reconciliation lacks its exact provider locator",
      );
    }
    const account = await loadTriggerProviderAccount({
      orgId: input.orgId,
      provider: "sentry",
      providerAccountId: trigger.remote_hook_account_id ?? trigger.provider_account_id,
      database: input.database,
    });
    const projectPath = [trigger.target.organization, trigger.target.project]
      .map(encodeURIComponent)
      .join("/");
    return findWebhookFromProviderList({
      fetch: doFetch,
      initialUrl: `${SENTRY_API}/projects/${projectPath}/hooks/`,
      headers: { authorization: `Bearer ${providerTokenOf(account, input.orgId, input.masterKey)}` },
      provider: "Sentry",
      schema: z.object({ id: z.string().min(1).max(200), url: z.string() }).passthrough(),
      matches: (hook) => trigger.remote_hook_id
        ? hook.id === trigger.remote_hook_id
        : hook.url === trigger.webhook_url,
      idOf: (hook) => hook.id,
    });
  }
  if (trigger.provider === "github") {
    if (!trigger.target?.repo) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "GitHub webhook reconciliation lacks its exact provider locator",
      );
    }
    const account = await loadTriggerProviderAccount({
      orgId: input.orgId,
      provider: "github",
      providerAccountId: trigger.remote_hook_account_id ?? trigger.provider_account_id,
      database: input.database,
    });
    const repoPath = trigger.target.repo.split("/").map(encodeURIComponent).join("/");
    return findWebhookFromProviderList({
      fetch: doFetch,
      initialUrl: `${GITHUB_API}/repos/${repoPath}/hooks?per_page=100&page=1`,
      headers: githubHeaders(providerTokenOf(account, input.orgId, input.masterKey)),
      provider: "github",
      schema: z.object({
        id: z.number().int(),
        config: z.object({ url: z.string() }).passthrough(),
      }).passthrough(),
      matches: (hook) => trigger.remote_hook_id
        ? String(hook.id) === trigger.remote_hook_id
        : hook.config.url === trigger.webhook_url,
      idOf: (hook) => String(hook.id),
    });
  }
  throw new CompanionTriggerRegistrationError(
    "provider_rejected",
    "Webhook reconciliation is unavailable for this registered provider",
  );
}

export async function inspectCompanionTriggerWebhook(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  masterKey: Buffer;
  database: Db;
  fetch?: typeof globalThis.fetch;
}): Promise<"present" | "absent"> {
  const trigger = await loadRegistrationTrigger(input);
  const found = await findTriggerWebhook(input, trigger);
  if (found === null) return "absent";
  return "present";
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
  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    let detailedReason = "Unknown error";
    
    // Extract Sentry's specific error message
    if (responseBody) {
      if (typeof responseBody.detail === "string") {
        detailedReason = responseBody.detail;
      } else if (typeof responseBody.message === "string") {
        detailedReason = responseBody.message;
      }
    }

    // Map common Sentry API rejection scenarios
    if (response.status === 401) {
      detailedReason = "Unauthorized. The Sentry integration token is invalid or expired.";
    } else if (response.status === 403) {
      detailedReason = "Access forbidden. Ensure the token has 'project:write' or 'project:admin' permissions.";
    } else if (response.status === 404) {
      detailedReason = "Organization or project not found. Verify the target project path.";
    }

    const error = sanitizeCompanionRuntimeError(
      `Sentry rejected the webhook (${response.status}): ${detailedReason}`
    ).slice(0, 500);
    
    return recoverSentryRegistration(input, trigger, account.id, token, projectPath, doFetch, error);
  }

  const created = z.object({ id: z.string().min(1).max(200) }).safeParse(responseBody);
  
  if (!created.success) {
    const error = sanitizeCompanionRuntimeError("Sentry returned an unreadable webhook payload").slice(0, 500);
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
export async function registerCompanionTriggerWebhook(input: {
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
  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    let detailedReason = "Unknown error";
    
    if (responseBody?.message) {
      detailedReason = responseBody.message;
    }

    // Map common GitHub webhook rejection scenarios
    if (response.status === 404) {
      detailedReason = "Repository not found or token lacks 'admin:repo_hook' permission.";
    } else if (response.status === 403) {
      detailedReason = "Access forbidden. Check if the organization restricts third-party OAuth apps.";
    } else if (response.status === 422) {
      detailedReason = "Validation failed. Check the webhook configuration and repository webhook limit.";
    }

    const message = sanitizeCompanionRuntimeError(
      `github rejected the webhook (${response.status}): ${detailedReason}`
    ).slice(0, 500);

    return recoverGitHubRegistration(input, trigger, account.id, token, repoPath, doFetch, message);
  }

  // Pass the already-extracted body to Zod for validation on success
  
  const created = z.object({ id: z.number().int() }).safeParse(responseBody);
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

export async function unregisterCompanionTriggerWebhook(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  masterKey: Buffer;
  database: Db;
  fetch?: typeof globalThis.fetch;
  /** One-shot purge keeps ownership rows intact until every external resource is gone. */
  preserveRegistration?: boolean;
}): Promise<"completed" | "absent"> {
  const trigger = await loadRegistrationTrigger(input);
  // A failed create can have committed remotely before its id was persisted. Destructive cleanup
  // re-resolves that narrow case by the exact callback on every attempt, so a crash before DELETE
  // or an ambiguous DELETE response never turns a local null into provider absence.
  const remoteHookId = trigger.remote_hook_id ?? (
    trigger.provider === "linear" || trigger.provider === "sentry" || trigger.provider === "github"
      ? await findTriggerWebhook(input, trigger)
      : null
  );
  const persist = input.preserveRegistration
    ? async (): Promise<void> => undefined
    : async (registration: Parameters<typeof persistRegistration>[0]): Promise<void> => {
        await persistRegistration(registration);
      };
  if (trigger.provider === "linear") {
    if (!remoteHookId) {
      await persist({
        ...input,
        accountId: null,
        remoteHookId: null,
        status: "unregistered",
        error: null,
      });
      return "absent";
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
          variables: { id: remoteHookId },
        }),
      });
    } catch {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "linear webhook removal could not reach the provider; the registration is kept",
      );
    }
    if (response.status === 404) {
      if (input.preserveRegistration) {
        throw new CompanionTriggerRegistrationError(
          "provider_rejected",
          "linear webhook removal returned ambiguous absence; reconcile the parent list",
        );
      }
      await persist({
        ...input,
        accountId: null,
        remoteHookId: null,
        status: "unregistered",
        error: null,
      });
      return "absent";
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
    return "completed";
  }
  if (trigger.provider === "sentry") {
    if (!remoteHookId || !trigger.target?.organization || !trigger.target.project) {
      if (input.preserveRegistration && remoteHookId) {
        throw new CompanionTriggerRegistrationError(
          "provider_rejected",
          "Sentry webhook deletion lacks its exact provider locator",
        );
      }
      await persist({
        ...input,
        accountId: null,
        remoteHookId: null,
        status: "unregistered",
        error: null,
      });
      return "absent";
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
        `${SENTRY_API}/projects/${projectPath}/hooks/${encodeURIComponent(remoteHookId)}/`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      );
    } catch {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "Sentry webhook removal could not reach the provider; the registration is kept",
      );
    }
    if (response.status === 404 && input.preserveRegistration) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "Sentry webhook removal returned ambiguous absence; reconcile the parent list",
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
    return response.status === 404 ? "absent" : "completed";
  }
  if (trigger.provider !== "github" || !trigger.target?.repo || !remoteHookId) {
    if (input.preserveRegistration && remoteHookId) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        trigger.provider === "github"
          ? "GitHub webhook deletion lacks its exact provider locator"
          : "Webhook deletion is unavailable for this registered provider",
      );
    }
    await persist({
      ...input,
      accountId: null,
      remoteHookId: null,
      status: trigger.provider === "webhook" || trigger.provider === "custom" ? "manual" : "unregistered",
      error: null,
    });
    return "absent";
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
      `${GITHUB_API}/repos/${repoPath}/hooks/${encodeURIComponent(remoteHookId)}`,
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
  if (response.status === 404 && input.preserveRegistration) {
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      "github webhook removal returned ambiguous absence; reconcile the parent list",
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
  return response.status === 404 ? "absent" : "completed";
}
