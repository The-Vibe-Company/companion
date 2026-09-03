import type { CompanionMcpAccount, CompanionMcpCredential } from "@companion/contracts";
import { companionMcpAccountSchema } from "@companion/contracts";
import {
  decryptCompanionMcpRuntimeCredential,
  decryptCompanionProviderRuntimeCredential,
  COMPANION_GMAIL_MCP_ALLOWED_TOOLS,
  type CompanionRuntimeMcpCredential,
  type CompanionRuntimeProviderCredential,
} from "@companion/core";
import type { CompanionRuntimeSkill, CompanionStagedMcpAccount } from "@companion/box-runtime";
import type { RuntimeAuthorization, RuntimeWorkMaterial } from "@companion/companion-runtime";
import { MAX_ARCHIVE_BYTES, skillChecksum, toTar } from "@companion/skills";

export interface RuntimeMaterialRows {
  providerMaterial: RuntimeMaterialRow[];
  skillMaterial: RuntimeMaterialRow[];
  mcpMaterial: RuntimeMaterialRow[];
}

type RuntimeMaterialRow = RuntimeWorkMaterial["providerMaterial"][number];
type RuntimeUntrustedValue = RuntimeMaterialRow[keyof RuntimeMaterialRow];

export interface ResolvedRuntimeResources {
  providerAuth: Record<string, CompanionRuntimeProviderCredential>;
  skills: CompanionRuntimeSkill[];
  mcpAccounts: CompanionStagedMcpAccount[];
  mcpCredentials: CompanionMcpCredential[];
  extraEnv: Record<string, string>;
}

export interface DecryptedRuntimeMcpRow {
  accountId: string;
  credentialGeneration: string;
  account: CompanionMcpAccount;
  decrypted: CompanionRuntimeMcpCredential;
}

function collectCredentialStrings(
  value: RuntimeUntrustedValue,
  output: Set<string>,
): void {
  const text = stringValue(value);
  if (text !== null) {
    if (text.length > 0) output.add(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialStrings(item, output);
    return;
  }
  if (!value || Array.isArray(value) || Object.prototype.toString.call(value) !== "[object Object]") return;
  for (const child of Object.values(value)) {
    collectCredentialStrings(child, output);
  }
}

function collectMcpSensitiveValues(
  decrypted: CompanionRuntimeMcpCredential,
  output: Set<string>,
): void {
  if (decrypted.kind === "environment") {
    for (const credential of decrypted.credentials) {
      if (credential.value.length > 0) output.add(credential.value);
    }
    return;
  }
  const oauth = decrypted.credential;
  if (oauth.accessToken.length > 0) output.add(oauth.accessToken);
  if (oauth.refreshToken && oauth.refreshToken.length > 0) output.add(oauth.refreshToken);
  if (oauth.client.clientSecret && oauth.client.clientSecret.length > 0) {
    output.add(oauth.client.clientSecret);
  }
}

/** Decrypt only the credential fields needed by the in-memory transcript redactor. */
export function collectRuntimeCredentialSensitiveValues(input: {
  orgId: string;
  material: RuntimeMaterialRows;
  masterKey: Buffer;
}): string[] {
  try {
    const values = new Set<string>();
    for (const raw of input.material.providerMaterial) {
      const row = providerRow(raw);
      const credential = decryptCompanionProviderRuntimeCredential({
        orgId: input.orgId,
        providerId: row.providerId,
        credentialGeneration: row.credentialGeneration,
        envelope: row.envelope,
      }, input.masterKey);
      collectCredentialStrings(credential, values);
    }
    for (const row of decryptRuntimeMcpRows({
      orgId: input.orgId,
      mcpMaterial: input.material.mcpMaterial,
      masterKey: input.masterKey,
    })) {
      collectMcpSensitiveValues(row.decrypted, values);
    }
    return [...values];
  } catch (error) {
    if (error instanceof RuntimeMaterialError) throw error;
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

export class RuntimeMaterialError extends Error {
  constructor(readonly code: "runtime_material_invalid" | "skill_archive_invalid") {
    super(code === "skill_archive_invalid"
      ? "An authorized Skill archive failed integrity validation."
      : "Authorized Companion runtime material is invalid.");
    this.name = "RuntimeMaterialError";
  }
}

/**
 * Prove that encrypted/material bytes still represent the exact refs returned by the immediate
 * pre-Box reauthorization. This closes the gap between get_material and session.external when an
 * operator rotates a provider/MCP credential or publishes a different Skill version.
 */
export function assertRuntimeMaterialSnapshot(input: {
  material: RuntimeMaterialRows;
  authorization: Pick<RuntimeAuthorization, "providerRefs" | "skillRefs" | "mcpRefs">;
}): void {
  try {
    const materialProviders = input.material.providerMaterial.map((raw) => {
      const row = providerRow(raw);
      return JSON.stringify([row.providerId, row.credentialGeneration, row.credentialVersion]);
    });
    const authorizedProviders = input.authorization.providerRefs.map((ref) => JSON.stringify([
      ref.provider_id,
      ref.credential_generation,
      ref.credential_version,
    ]));
    const materialSkills = input.material.skillMaterial.map((raw) => {
      const row = skillRow(raw);
      return JSON.stringify([row.skillId, row.versionId]);
    });
    const authorizedSkills = input.authorization.skillRefs.map((ref) => JSON.stringify([
      ref.skill_id,
      ref.current_version_id,
    ]));
    const materialMcp = input.material.mcpMaterial.map((raw) => {
      const row = mcpRow(raw);
      return JSON.stringify([row.accountId, row.credentialGeneration]);
    });
    const authorizedMcp = input.authorization.mcpRefs.map((ref) => JSON.stringify([
      ref.account_id,
      ref.credential_generation,
    ]));
    if (
      !sameUniqueRefs(materialProviders, authorizedProviders)
      || !sameUniqueRefs(materialSkills, authorizedSkills)
      || !sameUniqueRefs(materialMcp, authorizedMcp)
    ) throw new RuntimeMaterialError("runtime_material_invalid");
  } catch (error) {
    if (error instanceof RuntimeMaterialError) throw error;
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

/**
 * Decrypt and integrity-check the exact generation-pinned SQL snapshot. Every thrown message is
 * fixed copy: ciphertext, plaintext, storage keys, signed URLs and provider values never escape.
 */
export async function resolveRuntimeResources(input: {
  orgId: string;
  material: RuntimeMaterialRows;
  masterKey: Buffer;
  loadSkillArchive(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  signal: AbortSignal;
}): Promise<ResolvedRuntimeResources> {
  try {
    input.signal.throwIfAborted();
    const providerAuth: Record<string, CompanionRuntimeProviderCredential> = {};
    for (const raw of input.material.providerMaterial) {
      const row = providerRow(raw);
      if (providerAuth[row.providerId]) throw new RuntimeMaterialError("runtime_material_invalid");
      const credential = decryptCompanionProviderRuntimeCredential({
        orgId: input.orgId,
        providerId: row.providerId,
        credentialGeneration: row.credentialGeneration,
        envelope: row.envelope,
      }, input.masterKey);
      if (
        (row.authMethod === "api_key" && credential.type !== "api_key")
        || (row.authMethod !== "api_key" && credential.type !== "oauth")
      ) throw new RuntimeMaterialError("runtime_material_invalid");
      providerAuth[row.providerId] = credential;
    }

    const skills: CompanionRuntimeSkill[] = [];
    const skillIds = new Set<string>();
    for (const raw of input.material.skillMaterial) {
      const row = skillRow(raw);
      if (skillIds.has(row.skillId)) throw new RuntimeMaterialError("runtime_material_invalid");
      skillIds.add(row.skillId);
      input.signal.throwIfAborted();
      const archive = await input.loadSkillArchive(row.storagePath, input.signal);
      input.signal.throwIfAborted();
      if (
        archive.byteLength !== row.sizeBytes
        || archive.byteLength > MAX_ARCHIVE_BYTES
        || skillChecksum(toTar(archive)) !== row.checksum
      ) throw new RuntimeMaterialError("skill_archive_invalid");
      skills.push({
        slug: row.slug,
        version: row.version,
        checksum: row.checksum,
        archive,
      });
    }

    const mcpRows = decryptRuntimeMcpRows({
      orgId: input.orgId,
      mcpMaterial: input.material.mcpMaterial,
      masterKey: input.masterKey,
    });
    const uniqueGithubGit = mcpRows.filter((row) =>
      row.decrypted.kind === "oauth"
      && row.decrypted.credential.serverName === "io.github.github/github-mcp-server"
    ).length === 1;
    const mcpAccounts: CompanionStagedMcpAccount[] = [];
    const mcpCredentials: CompanionMcpCredential[] = [];
    const extraEnv: Record<string, string> = {};
    const accountIds = new Set<string>();
    for (const row of mcpRows) {
      if (accountIds.has(row.accountId)) throw new RuntimeMaterialError("runtime_material_invalid");
      accountIds.add(row.accountId);
      const { account, decrypted } = row;
      if (decrypted.kind === "environment") {
        mcpAccounts.push({ account });
        mcpCredentials.push(...decrypted.credentials);
        continue;
      }
      const oauth = decrypted.credential;
      const oauthBroker: NonNullable<CompanionStagedMcpAccount["oauthBroker"]> = {
        credentialGeneration: row.credentialGeneration,
        github: oauth.serverName === "io.github.github/github-mcp-server",
      };
      if (oauth.serverName === "com.slack/mcp") oauthBroker.slack = true;
      if (oauth.serverName === "com.google.workspace/gmail") {
        oauthBroker.allowedTools = COMPANION_GMAIL_MCP_ALLOWED_TOOLS;
      }
      mcpAccounts.push({
        account,
        oauthBroker,
      });
      if (uniqueGithubGit && oauth.serverName === "io.github.github/github-mcp-server") {
        extraEnv.COMPANION_GITHUB_MCP_ACCOUNT_ID = row.accountId;
        extraEnv.GIT_TERMINAL_PROMPT = "0";
        extraEnv.GH_PROMPT_DISABLED = "1";
        if (oauth.githubIdentity) {
          extraEnv.GIT_AUTHOR_NAME = oauth.githubIdentity.name;
          extraEnv.GIT_AUTHOR_EMAIL = oauth.githubIdentity.email;
          extraEnv.GIT_COMMITTER_NAME = oauth.githubIdentity.name;
          extraEnv.GIT_COMMITTER_EMAIL = oauth.githubIdentity.email;
        }
      }
    }
    input.signal.throwIfAborted();
    return { providerAuth, skills, mcpAccounts, mcpCredentials, extraEnv };
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (error instanceof RuntimeMaterialError) throw error;
    // Core credential/schema/storage errors may carry implementation detail; collapse all of them.
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

export function decryptRuntimeMcpRows(input: {
  orgId: string;
  mcpMaterial: RuntimeMaterialRow[];
  masterKey: Buffer;
}): DecryptedRuntimeMcpRow[] {
  try {
    return input.mcpMaterial.map((raw) => {
      const row = mcpRow(raw);
      const account = companionMcpAccountSchema.parse(row.accountConfig);
      if (account.id !== row.accountId) throw new RuntimeMaterialError("runtime_material_invalid");
      return {
        accountId: row.accountId,
        credentialGeneration: row.credentialGeneration,
        account,
        decrypted: decryptCompanionMcpRuntimeCredential({
          orgId: input.orgId,
          accountId: row.accountId,
          credentialGeneration: row.credentialGeneration,
          envelope: row.envelope,
        }, input.masterKey),
      };
    });
  } catch (error) {
    if (error instanceof RuntimeMaterialError) throw error;
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

interface EncryptedRow {
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

function providerRow(row: RuntimeMaterialRow): EncryptedRow & {
  providerId: string;
  authMethod: string;
  credentialVersion: number;
} {
  const providerId = stableString(row.provider_id, 63);
  const authMethod = stableString(row.auth_method, 40);
  const credentialVersion = row.credential_version;
  if (!Number.isSafeInteger(credentialVersion) || Number(credentialVersion) < 1) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return {
    providerId,
    authMethod,
    credentialVersion: Number(credentialVersion),
    ...encryptedRow(row),
  };
}

function mcpRow(row: RuntimeMaterialRow): EncryptedRow & {
  accountId: string;
  accountConfig: unknown;
} {
  return {
    accountId: uuid(row.account_id),
    accountConfig: row.account_config,
    ...encryptedRow(row),
  };
}

function encryptedRow(row: RuntimeMaterialRow): EncryptedRow {
  return {
    credentialGeneration: uuid(row.credential_generation),
    envelope: {
      ciphertext: boundedString(row.ciphertext),
      iv: boundedString(row.iv),
      authTag: boundedString(row.auth_tag),
      wrappedDek: boundedString(row.wrapped_dek),
      wrapIv: boundedString(row.wrap_iv),
      wrapAuthTag: boundedString(row.wrap_auth_tag),
      keyId: boundedString(row.key_id),
    },
  };
}

interface RuntimeSkillRow {
  skillId: string;
  versionId: string;
  slug: string;
  version: string;
  checksum: string;
  sizeBytes: number;
  storagePath: string;
}

function skillRow(row: RuntimeMaterialRow): RuntimeSkillRow {
  const checksum = boundedString(row.checksum);
  const sizeBytes = row.size_bytes;
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0 || Number(sizeBytes) > MAX_ARCHIVE_BYTES) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return {
    skillId: uuid(row.skill_id),
    versionId: uuid(row.version_id),
    slug: stableString(row.slug, 200),
    version: stableString(row.version, 100),
    checksum,
    sizeBytes: Number(sizeBytes),
    storagePath: boundedString(row.storage_path, 2_048),
  };
}

function sameUniqueRefs(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  return [...leftSet].every((value) => rightSet.has(value));
}

function boundedString(value: RuntimeUntrustedValue, max = 1_000_000): string {
  const text = stringValue(value);
  if (
    text === null
    || text.length < 1
    || text.length > max
    || /[\r\n\0]/.test(text)
  ) throw new RuntimeMaterialError("runtime_material_invalid");
  return text;
}

function stableString(value: RuntimeUntrustedValue, max: number): string {
  const text = boundedString(value, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+@:/-]*$/.test(text)) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return text;
}

function uuid(value: RuntimeUntrustedValue): string {
  const text = boundedString(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return text;
}

function stringValue(value: RuntimeUntrustedValue): string | null {
  const text = String(value);
  return value === text ? text : null;
}
