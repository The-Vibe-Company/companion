/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-unknown-parameters -- Existing material boundary predates the incremental anti-slop gate. */

import { createHash } from "node:crypto";
import { COMPANION_SKILL_KEY, companionSkillDir } from "@companion/companion-skill";
import { getCompanionSkillPackage } from "@companion/companion-skill/package";
import {
  BoxRuntimeProviderError,
  type CompanionAttachmentFile,
  type CompanionBoxRuntime,
  type CompanionRuntimeSkill,
} from "@companion/box-runtime";
import {
  RuntimeExternalDependencyError,
  RuntimeTerminalPreparationError,
} from "@companion/companion-runtime/runtime-support";
import type {
  RuntimeOutputAttachment,
  RuntimeV3PreparationClaim,
  RuntimeV3PreparationStager,
  RuntimeV3InputAttachmentStager,
} from "@companion/companion-runtime/v3/internal";
import { RuntimeV3InputAttachmentError } from "@companion/companion-runtime/v3/internal";
import {
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT,
  COMPANION_OUTPUT_ATTACHMENT_TOTAL_MAX_BYTES,
  isCompanionAttachmentImage,
  sanitizeCompanionAttachmentFilename,
  sniffCompanionAttachmentMime,
} from "@companion/contracts";
import { packDir } from "@companion/skills";
import { companionAttachmentKey } from "@companion/storage";

import {
  assertRuntimeMaterialSnapshot,
  resolveRuntimeResources,
  RuntimeMaterialError,
  type RuntimeMaterialRows,
} from "./resourceMaterial";

export interface RuntimeMaterialPipeline {
  preparationStager: RuntimeV3PreparationStager;
  inputAttachmentStager: RuntimeV3InputAttachmentStager;
  outboxHarvester: RuntimeV3OutboxHarvester;
}

interface RuntimeV3OutboxHarvester {
  clearOutbox(input: { boxId: string; signal: AbortSignal }): Promise<void>;
  harvestOutbox(input: {
    orgId: string;
    companionId: string;
    boxId: string;
    turnId: string;
    deadlineAt: Date;
    signal: AbortSignal;
  }): Promise<{ attachments: RuntimeOutputAttachment[]; incomplete: boolean }>;
}

interface RuntimeHubEnvironment {
  [key: string]: string;
}

export function companionHubApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export function createRuntimeMaterialPipeline(input: {
  masterKey: Buffer;
  apiUrl: string;
  bundledSkill: CompanionRuntimeSkill;
  runtime(): CompanionBoxRuntime;
  /** Direct hosted-agent data path for chat files/outbox; lifecycle and staging stay on runtime(). */
  fileRuntime?: () => Pick<CompanionBoxRuntime,
    "stageAttachments" | "clearOutbox" | "listOutbox" | "readOutboxFile">;
  loadSkillArchive(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  /** Read one already-authorized chat upload from object storage. */
  loadAttachment(storageKey: string, signal: AbortSignal): Promise<Buffer>;
  /** Store one harvested image under its content address and answer with the key it landed on. */
  storeAttachment(input: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }): Promise<void>;
  /**
   * Direct-transport endpoint sink, present only when the rollout gate enables the direct channel.
   * Receives the decrypted hosted agent endpoint at staging time and on every fenced material read
   * that carries one, so the event path can go direct without waiting for a fresh staging.
   */
  registerAgentEndpoint?: (boxId: string, endpoint: {
    hostedUrl: string;
    proxyToken: string;
    bearerToken: string;
    observedAt: Date;
  }) => void;
  now?: () => number;
}): RuntimeMaterialPipeline {
  const now = input.now ?? Date.now;
  const preparationStager: RuntimeV3PreparationStager = {
    async stagePreparation({ claim, authorize, signal }) {
      if (
        !claim.boxId || !claim.actorId || !claim.modelId
        || claim.settingsRevision === null || claim.skillsRevision === null
      ) throw new RuntimeMaterialError("runtime_material_invalid");
      const material = preparationMaterial(claim);
      assertRuntimeMaterialSnapshot({
        material,
        authorization: {
          providerRefs: claim.providerRefs,
          skillRefs: claim.skillRefs,
          mcpRefs: claim.mcpRefs,
        },
      });
      const resources = await resolveRuntimeResources({
        orgId: claim.orgId,
        material,
        masterKey: input.masterKey,
        loadSkillArchive: input.loadSkillArchive,
        signal,
      });
      // Token minting reauthorizes the exact snapshot under the live preparation fence. It is the
      // final control-plane boundary before any resolved material crosses into the Box.
      const credentials = await authorize();
      if (!credentials) {
        throw new RuntimeExternalDependencyError("external_authority_unavailable", {
          kind: "grant",
          id: `actor:${claim.actorId}`,
        });
      }
      let observed;
      try {
        observed = await input.runtime().stageExistingBox({
          orgId: claim.orgId,
          companionId: claim.companionId,
          boxId: claim.boxId,
          runtimeGeneration: 1,
          clientSurface: "web",
          providerAuth: resources.providerAuth,
          replaceProviderAuth: true,
          instructions: claim.persona,
          modelId: claim.modelId,
          mcpCredentials: resources.mcpCredentials,
          mcpAccounts: resources.mcpAccounts,
          skills: [
            input.bundledSkill,
            ...resources.skills.filter((skill) => skill.slug !== COMPANION_SKILL_KEY),
          ],
          reuseSkills: false,
          preserveSkills: false,
          hubEnv: buildRuntimeHubEnvironment({
            nativeMobile: false,
            apiUrl: input.apiUrl,
            orgId: claim.orgId,
            extraEnv: resources.extraEnv,
            hubCredential: credentials.hubToken,
            mcpBrokerCredential: credentials.mcpBrokerToken ?? undefined,
            controlCredential: credentials.controlToken,
          }),
          configCatalog: claim.configCatalog,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const retryableProviderFailure = error instanceof BoxRuntimeProviderError
          && (error.status === 408 || error.status === 429 || error.status >= 500);
        if (!retryableProviderFailure) {
          if (error instanceof BoxRuntimeProviderError) {
            throw new RuntimeTerminalPreparationError({
              code: "box_staging_conflict",
              message: "The Companion Box rejected its runtime material.",
              action: "none",
            });
          }
          throw error;
        }
        throw new RuntimeExternalDependencyError("box_unavailable", {
          kind: "box",
          id: claim.boxId,
        });
      }
      if (input.registerAgentEndpoint && observed.agentEndpoint) {
        input.registerAgentEndpoint(claim.boxId, {
          hostedUrl: observed.agentEndpoint.hostedUrl,
          proxyToken: observed.agentEndpoint.proxyToken,
          bearerToken: observed.agentEndpoint.bearerToken,
          observedAt: new Date(now()),
        });
      }
      return {
        diskLayoutVersion: observed.diskLayoutVersion,
        appliedSettingsRevision: claim.settingsRevision,
        appliedSkillsRevision: claim.skillsRevision,
        skillsDigest: observed.skillsDigest,
        materialExpiresAt: credentials.expiresAt,
      };
    },
  };
  const inputAttachmentStager: RuntimeV3InputAttachmentStager = {
    async stage(stage) {
      const fileRuntime = input.fileRuntime?.() ?? input.runtime();
      const messageId = messageIdFromEventId(stage.messageEventId);
      const clearStaging = async (): Promise<void> => {
        await fileRuntime.stageAttachments({
          boxId: stage.boxId,
          messageId,
          files: [],
          signal: AbortSignal.timeout(30_000),
        });
      };
      const failExpired = async (): Promise<never> => {
        await clearStaging();
        throw new RuntimeV3InputAttachmentError(
          "attachment_expired",
          "The files attached to this message have expired and must be uploaded again.",
        );
      };
      const files: CompanionAttachmentFile[] = [];
      try {
        for (const attachment of stage.attachments) {
          if (now() >= attachment.expiresAt.getTime()) await failExpired();
          const bytes = await input.loadAttachment(attachment.storageKey, stage.signal);
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (bytes.byteLength !== attachment.byteSize || digest !== attachment.sha256) {
            throw new RuntimeV3InputAttachmentError(
              "attachment_staging_failed",
              "The files attached to this message could not be verified.",
            );
          }
          files.push({
            position: attachment.position,
            filename: attachment.filename,
            contentType: attachment.contentType,
            bytes,
          });
        }
        if (stage.attachments.some((attachment) => now() >= attachment.expiresAt.getTime())) {
          await failExpired();
        }
        if (!await stage.reauthorize(stage.signal)) {
          throw new RuntimeV3InputAttachmentError(
            "runtime_authorization_revoked",
            "The sender no longer has authority to stage these files.",
          );
        }
        const staged = await fileRuntime.stageAttachments({
          boxId: stage.boxId,
          messageId,
          files,
          signal: stage.signal,
        });
        if (stage.attachments.some((attachment) => now() >= attachment.expiresAt.getTime())) {
          await failExpired();
        }
        return staged;
      } catch (error) {
        if (error instanceof RuntimeV3InputAttachmentError && (
          error.code === "attachment_expired"
          || error.code === "runtime_authorization_revoked"
        )) {
          throw error;
        }
        await clearStaging();
        if (error instanceof RuntimeV3InputAttachmentError) throw error;
        throw new RuntimeV3InputAttachmentError(
          "attachment_staging_failed",
          "The files attached to this message could not be staged on the Companion Box.",
        );
      }
    },
  };
  const outboxHarvester: RuntimeV3OutboxHarvester = {
    async clearOutbox({ boxId, signal }) {
      await (input.fileRuntime?.() ?? input.runtime()).clearOutbox({ boxId, signal });
    },
    async harvestOutbox(harvest) {
      const listed = await (input.fileRuntime?.() ?? input.runtime()).listOutbox({
        boxId: harvest.boxId,
        deadlineAt: harvest.deadlineAt,
        signal: harvest.signal,
      });
      // Bound before anything is transferred: a Box that filled its outbox must not be able to turn
      // one reply into an unbounded read. What is dropped here is reported as incomplete rather than
      // silently forgotten.
      const eligible = listed.filter((entry) =>
        entry.byteSize > 0 && entry.byteSize <= COMPANION_ATTACHMENT_MAX_BYTES);
      const selected = eligible.slice(0, COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT);
      let incomplete = selected.length < listed.length;

      const attachments: RuntimeOutputAttachment[] = [];
      let total = 0;
      for (const entry of selected) {
        if (now() >= harvest.deadlineAt.getTime()) {
          incomplete = true;
          break;
        }
        if (total + entry.byteSize > COMPANION_OUTPUT_ATTACHMENT_TOTAL_MAX_BYTES) {
          incomplete = true;
          continue;
        }
        // Reading one file off the Box and storing it are one unit of work, and both are external.
        // By this point Pi has settled and any reply it produced is already durable, so a failure
        // in either costs exactly one image: the harvest keeps whatever it has already stored and
        // reports the shortfall, rather than discarding a partial set and orphaning its objects.
        try {
          const file = await (input.fileRuntime?.() ?? input.runtime()).readOutboxFile({
            boxId: harvest.boxId,
            entry,
            deadlineAt: harvest.deadlineAt,
            signal: harvest.signal,
          });
          // Pi hands back images and nothing else, and the type comes from the bytes rather than
          // from whatever extension Pi happened to choose.
          const contentType = sniffCompanionAttachmentMime(file.bytes, null);
          if (!contentType || !isCompanionAttachmentImage(contentType)) {
            incomplete = true;
            continue;
          }
          const sha256 = createHash("sha256").update(file.bytes).digest("hex");
          const key = companionAttachmentKey({
            kind: "output",
            orgId: harvest.orgId,
            companionId: harvest.companionId,
            attemptId: harvest.turnId,
            position: attachments.length,
            sha256,
          });
          await input.storeAttachment({
            key,
            bytes: file.bytes,
            contentType,
            signal: harvest.signal,
          });
          const uploadedAt = new Date(now());
          total += file.bytes.byteLength;
          attachments.push({
            storageKey: key,
            contentType,
            byteSize: file.bytes.byteLength,
            sha256,
            filename: sanitizeCompanionAttachmentFilename({
              filename: entry.name,
              position: attachments.length,
              contentType,
            }),
            uploadedAt,
          });
        } catch {
          incomplete = true;
          continue;
        }
      }
      return { attachments, incomplete };
    },
  };
  return {
    preparationStager,
    inputAttachmentStager,
    outboxHarvester,
  };
}

const MESSAGE_EVENT_ID_PATTERN
  = /^msg:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function messageIdFromEventId(messageEventId: string): string {
  const messageId = MESSAGE_EVENT_ID_PATTERN.exec(messageEventId)?.[1];
  if (!messageId) throw new RuntimeMaterialError("runtime_material_invalid");
  return messageId;
}

function preparationMaterial(claim: RuntimeV3PreparationClaim): RuntimeMaterialRows {
  return {
    providerMaterial: claim.providerMaterial.map((row) => ({ ...row })),
    skillMaterial: claim.skillMaterial.map((row) => ({ ...row })),
    mcpMaterial: claim.mcpMaterial.map((row) => ({ ...row })),
  };
}

let bundledSkillPromise: Promise<CompanionRuntimeSkill> | null = null;

/** Load immutable bundled bytes before starting the claim loop; no runtime claim reads source files. */
export function loadBundledCompanionRuntimeSkill(): Promise<CompanionRuntimeSkill> {
  bundledSkillPromise ??= Promise.all([
    getCompanionSkillPackage(),
    packDir(companionSkillDir()),
  ]).then(([metadata, packed]) => ({
    slug: COMPANION_SKILL_KEY,
    version: metadata.version,
    checksum: packed.checksum,
    archive: packed.archive,
  })).catch((error) => {
    bundledSkillPromise = null;
    throw error;
  });
  return bundledSkillPromise;
}

function buildRuntimeHubEnvironment(input: {
  nativeMobile: boolean;
  apiUrl: string;
  orgId: string;
  extraEnv: RuntimeHubEnvironment;
  hubCredential?: string;
  mcpBrokerCredential?: string;
  controlCredential?: string;
}): RuntimeHubEnvironment {
  const environment: RuntimeHubEnvironment = {};
  if (input.nativeMobile) return environment;
  environment.COMPANION_API_URL = companionHubApiUrl(input.apiUrl);
  environment.COMPANION_WORKSPACE_ID = input.orgId;
  Object.assign(environment, input.extraEnv);
  if (input.hubCredential) environment.COMPANION_DELEGATION_TOKEN = input.hubCredential;
  if (input.mcpBrokerCredential) environment.COMPANION_MCP_BROKER_TOKEN = input.mcpBrokerCredential;
  if (input.controlCredential) environment.COMPANION_CONTROL_TOKEN = input.controlCredential;
  return environment;
}
