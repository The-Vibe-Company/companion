/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-unknown-parameters -- Existing material boundary predates the incremental anti-slop gate. */

import { createHash } from "node:crypto";
import { COMPANION_SKILL_KEY, companionSkillDir } from "@companion/companion-skill";
import { getCompanionSkillPackage } from "@companion/companion-skill/package";
import {
  type CompanionBoxRuntimeV2,
  type CompanionRuntimeSkill,
} from "@companion/box-runtime";
import {
  RUNTIME_LEASE_SECONDS,
  RuntimeAttachmentExpiredError,
  createRuntimeVisibleTextRedactor,
  type RuntimeAttachmentStager,
  type RuntimeMaterialProvider,
  type RuntimeOutboxHarvester,
  type RuntimeOutputAttachment,
  type RuntimeProjectionRedactorFactory,
  type RuntimeResourceStager,
  type RuntimeWorkMaterial,
} from "@companion/companion-runtime";
import type {
  RuntimeV3PreparationClaim,
  RuntimeV3PreparationStager,
} from "@companion/companion-runtime/v3/internal";
import {
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT,
  COMPANION_OUTPUT_ATTACHMENT_TOTAL_MAX_BYTES,
  isCompanionAttachmentImage,
  sanitizeCompanionAttachmentFilename,
  sniffCompanionAttachmentMime,
} from "@companion/contracts";
import { encryptOpaqueValue } from "@companion/core";
import { packDir } from "@companion/skills";
import { companionAttachmentKey } from "@companion/storage";

import { decryptCompanionAgentEndpointTokens } from "./directBoxTransport";
import {
  assertRuntimeMaterialSnapshot,
  collectRuntimeCredentialSensitiveValues,
  decryptRuntimeMcpRows,
  resolveRuntimeResources,
  RuntimeMaterialError,
  type RuntimeMaterialRows,
} from "./resourceMaterial";

export interface RuntimeMaterialPipeline {
  materialProvider: RuntimeMaterialProvider;
  projectionRedactorFactory: RuntimeProjectionRedactorFactory;
  resourceStager: RuntimeResourceStager;
  preparationStager: RuntimeV3PreparationStager;
  attachmentStager: RuntimeAttachmentStager;
  outboxHarvester: RuntimeOutboxHarvester;
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
  runtime(): CompanionBoxRuntimeV2;
  /** Direct hosted-agent data path for chat files/outbox; lifecycle and staging stay on runtime(). */
  fileRuntime?: () => Pick<CompanionBoxRuntimeV2,
    "stageAttachments" | "clearOutbox" | "listOutbox" | "readOutboxFile">;
  loadSkillArchive(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  /** Object-storage read for one chat attachment. Same bucket, deliberately a separate seam. */
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
  const hubTokensByMaterial = new WeakMap<
    RuntimeWorkMaterial,
    { token: string; expiresAt: Date }
  >();
  const mcpBrokerTokensByMaterial = new WeakMap<
    RuntimeWorkMaterial,
    { token: string; expiresAt: Date }
  >();
  const controlTokensByMaterial = new WeakMap<
    RuntimeWorkMaterial,
    { token: string; expiresAt: Date }
  >();
  const oauthMaterialByMaterial = new WeakMap<RuntimeWorkMaterial, boolean>();

  const materialProvider: RuntimeMaterialProvider = {
    async getMaterial({ store, fence }) {
      const material = await store.getMaterial(fence, RUNTIME_LEASE_SECONDS);
      if (!material) return null;
      const hasOauth = decryptRuntimeMcpRows({
        orgId: fence.orgId,
        mcpMaterial: material.mcpMaterial,
        masterKey: input.masterKey,
      }).some((row) => row.decrypted.kind === "oauth");
      oauthMaterialByMaterial.set(material, hasOauth);
      if (fence.workKind === "settings" || fence.workKind === "operation") {
        material.configCatalog = await store.getConfigCatalog(fence, RUNTIME_LEASE_SECONDS);
        const hubToken = await store.mintHubToken(fence, RUNTIME_LEASE_SECONDS);
        if (hubToken) hubTokensByMaterial.set(material, hubToken);
        // Mint on every staging claim: the SQL function rotates an old capability, or revokes it
        // when the current surface has no selected account. Environment-only accounts may produce
        // an unusable capability, but it is never staged or included in material expiry.
        const mcpBrokerToken = await store.mintMcpBrokerToken(fence, RUNTIME_LEASE_SECONDS);
        if (hasOauth && mcpBrokerToken) mcpBrokerTokensByMaterial.set(material, mcpBrokerToken);
        const controlToken = await store.mintControlToken(fence, RUNTIME_LEASE_SECONDS);
        if (controlToken) controlTokensByMaterial.set(material, controlToken);
      }
      if (input.registerAgentEndpoint && material.boxId && material.agentEndpoint) {
        try {
          const tokens = decryptCompanionAgentEndpointTokens({
            orgId: fence.orgId,
            companionId: fence.companionId,
            tokenCiphertext: material.agentEndpoint.tokenCiphertext,
            masterKey: input.masterKey,
          });
          input.registerAgentEndpoint(material.boxId, {
            hostedUrl: material.agentEndpoint.hostedUrl,
            proxyToken: tokens.proxyToken,
            bearerToken: tokens.bearerToken,
            observedAt: material.agentEndpoint.observedAt,
          });
        } catch {
          // An undecryptable endpoint only keeps this Box on the exec transport; the claim proceeds.
        }
      }
      return material;
    },
  };

  const projectionRedactorFactory: RuntimeProjectionRedactorFactory = {
    forMaterial({ orgId, material }) {
      const sensitiveValues = collectRuntimeCredentialSensitiveValues({
        orgId,
        material,
        masterKey: input.masterKey,
      });
      return createRuntimeVisibleTextRedactor(sensitiveValues);
    },
  };

  const resourceStager: RuntimeResourceStager = {
    async stageExistingBox(stage) {
      if (stage.allowBoxCreate !== false) {
        throw new RuntimeMaterialError("runtime_material_invalid");
      }
      const generation = stage.authorization.runtimeGeneration;
      const modelId = stage.authorization.modelId;
      if (generation === null || modelId === null) {
        throw new RuntimeMaterialError("runtime_material_invalid");
      }
      const materialForStage = stage.preserveInstalledSkills
        ? { ...stage.material, skillMaterial: [] }
        : stage.material;
      const authorizationForStage = stage.preserveInstalledSkills
        ? { ...stage.authorization, skillRefs: [] }
        : stage.authorization;
      assertRuntimeMaterialSnapshot({
        material: materialForStage,
        authorization: authorizationForStage,
      });
      const resources = await resolveRuntimeResources({
        orgId: stage.orgId,
        material: materialForStage,
        masterKey: input.masterKey,
        loadSkillArchive: input.loadSkillArchive,
        signal: stage.signal,
      });
      const hubCredential = hubTokensByMaterial.get(stage.material);
      if (!hubCredential) {
        throw new RuntimeMaterialError("runtime_material_invalid");
      }
      const hasOauth = oauthMaterialByMaterial.get(stage.material) ?? false;
      const mcpBrokerCredential = mcpBrokerTokensByMaterial.get(stage.material);
      if (hasOauth && !mcpBrokerCredential) {
        throw new RuntimeMaterialError("runtime_material_invalid");
      }
      const controlCredential = controlTokensByMaterial.get(stage.material);
      if (!controlCredential) throw new RuntimeMaterialError("runtime_material_invalid");
      const materialExpiresAt = earliestDate(
        earliestDate(hubCredential.expiresAt, mcpBrokerCredential?.expiresAt ?? null),
        controlCredential.expiresAt,
      );
      const skills = [
        input.bundledSkill,
        ...resources.skills.filter((skill) => skill.slug !== COMPANION_SKILL_KEY),
      ];
      // S3 reads and OAuth work above are asynchronous. Recheck the immutable ref tuples at the
      // final side-effect boundary so no local mutation can cross into Box unnoticed.
      assertRuntimeMaterialSnapshot({
        material: materialForStage,
        authorization: authorizationForStage,
      });
      const observed = await input.runtime().stageExistingBox({
        orgId: stage.orgId,
        companionId: stage.companionId,
        boxId: stage.boxId,
        runtimeGeneration: generationNumber(generation),
        clientSurface: stage.clientSurface,
        providerAuth: resources.providerAuth,
        replaceProviderAuth: true,
        instructions: stage.authorization.persona,
        modelId,
        mcpCredentials: resources.mcpCredentials,
        mcpAccounts: resources.mcpAccounts,
        skills,
        preserveSkills: stage.preserveInstalledSkills === true,
        reuseSkills: stage.preserveInstalledSkills !== true
          && stage.authorization.appliedSkillsRevision === stage.targetSkillsRevision,
        hubEnv: buildRuntimeHubEnvironment({
          nativeMobile: false,
          apiUrl: input.apiUrl,
          orgId: stage.orgId,
          extraEnv: resources.extraEnv,
          hubCredential: hubCredential?.token,
          mcpBrokerCredential: mcpBrokerCredential?.token,
          controlCredential: controlCredential.token,
        }),
        configCatalog: stage.material.configCatalog,
        signal: stage.signal,
      });
      // A live staging holds the endpoint in plaintext for exactly this moment: hand it to the
      // direct-transport registry now so the very next turn on this Box can go direct.
      if (input.registerAgentEndpoint && observed.agentEndpoint) {
        input.registerAgentEndpoint(stage.boxId, {
          hostedUrl: observed.agentEndpoint.hostedUrl,
          proxyToken: observed.agentEndpoint.proxyToken,
          bearerToken: observed.agentEndpoint.bearerToken,
          observedAt: new Date(now()),
        });
      }
      return {
        diskLayoutVersion: observed.diskLayoutVersion,
        appliedSettingsRevision: stage.targetSettingsRevision,
        appliedSkillsRevision: stage.preserveInstalledSkills
          ? stage.authorization.appliedSkillsRevision
          : stage.targetSkillsRevision,
        stagingMode: observed.stagingMode,
        skillBytesTransferred: observed.skillBytesTransferred,
        skillsDigest: observed.skillsDigest,
        materialExpiresAt,
        // Both hosted-endpoint tokens are credentials; only masterKey ciphertext crosses into the
        // durable store, so companion-runtime and PostgreSQL never see agent plaintext.
        agentEndpoint: observed.agentEndpoint
          ? {
            hostedUrl: observed.agentEndpoint.hostedUrl,
            tokenCiphertext: JSON.stringify(encryptOpaqueValue(
              {
                orgId: stage.orgId,
                purpose: "companion_box_agent_endpoint",
                subjectId: stage.companionId,
                value: JSON.stringify({
                  proxyToken: observed.agentEndpoint.proxyToken,
                  bearerToken: observed.agentEndpoint.bearerToken,
                }),
              },
              input.masterKey,
            )),
          }
          : null,
      };
    },
    async stageSkillTree(stage) {
      const generation = stage.authorization.runtimeGeneration;
      if (generation === null) throw new RuntimeMaterialError("runtime_material_invalid");
      const resources = await resolveRuntimeResources({
        orgId: stage.orgId,
        material: {
          providerMaterial: [],
          skillMaterial: stage.material.skillMaterial,
          mcpMaterial: [],
        },
        masterKey: input.masterKey,
        loadSkillArchive: input.loadSkillArchive,
        signal: stage.signal,
      });
      const observed = await input.runtime().stageSkillTree({
        companionId: stage.companionId,
        runtimeGeneration: generationNumber(generation),
        boxId: stage.boxId,
        skills: [
          input.bundledSkill,
          ...resources.skills.filter((skill) => skill.slug !== COMPANION_SKILL_KEY),
        ],
        signal: stage.signal,
      });
      return {
        appliedSkillsRevision: stage.material.targetSkillsRevision,
        skillsDigest: observed.skillsDigest,
        skillBytesTransferred: observed.skillBytesTransferred,
      };
    },
    async refreshLayout(stage) {
      const observed = await input.runtime().refreshPiLayout({
        boxId: stage.boxId,
        signal: stage.signal,
      });
      return { applied: observed.applied };
    },
    async invalidateLayout(stage) {
      await input.runtime().invalidatePiLayoutOverlay({
        boxId: stage.boxId,
        signal: stage.signal,
      });
    },
  };
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
      if (!credentials) throw new RuntimeMaterialError("runtime_material_invalid");
      const observed = await input.runtime().stageExistingBox({
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
  const attachmentStager: RuntimeAttachmentStager = {
    async stageAttachments(stage) {
      const files = [];
      for (const attachment of stage.material.attachments) {
        if (now() >= attachment.expiresAt.getTime()) {
          throw new RuntimeAttachmentExpiredError();
        }
        const bytes = await input.loadAttachment(attachment.storageKey, stage.signal);
        // The digest is checked against what the control plane accepted, not against what object
        // storage happened to return. A truncated read, a rewritten object, or the wrong key all
        // fail here rather than being staged and described to Pi as the member's file.
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== attachment.byteSize || digest !== attachment.sha256) {
          throw new RuntimeMaterialError("runtime_material_invalid");
        }
        if (now() >= attachment.expiresAt.getTime()) {
          throw new RuntimeAttachmentExpiredError();
        }
        files.push({
          position: attachment.position,
          filename: attachment.filename,
          contentType: attachment.contentType,
          bytes,
        });
      }
      // Object-storage reads above are asynchronous. Recheck the immutable ref tuples at the final
      // point before Box contact, exactly as resource staging does, so no local mutation crosses
      // into the Box unnoticed.
      assertRuntimeMaterialSnapshot({
        material: stage.material,
        authorization: stage.authorization,
      });
      if (stage.material.attachments.some((attachment) => now() >= attachment.expiresAt.getTime())) {
        throw new RuntimeAttachmentExpiredError();
      }
      return await (input.fileRuntime?.() ?? input.runtime()).stageAttachments({
        boxId: stage.boxId,
        messageId: messageIdFromEventId(stage.messageEventId),
        files,
        signal: stage.signal,
      });
    },
  };
  const outboxHarvester: RuntimeOutboxHarvester = {
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
            attemptId: harvest.attemptId,
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
    materialProvider,
    projectionRedactorFactory,
    resourceStager,
    preparationStager,
    attachmentStager,
    outboxHarvester,
  };
}

function preparationMaterial(claim: RuntimeV3PreparationClaim): RuntimeMaterialRows {
  return {
    providerMaterial: claim.providerMaterial.map((row) => ({ ...row })),
    skillMaterial: claim.skillMaterial.map((row) => ({ ...row })),
    mcpMaterial: claim.mcpMaterial.map((row) => ({ ...row })),
  };
}

function earliestDate(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left <= right ? left : right;
}

const MESSAGE_EVENT_ID_PATTERN
  = /^msg:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * The staging directory is named after the client message id the turn owns, so a retry rewrites the
 * same paths and two turns never share a directory. The event id is the durable spelling of that id.
 */
function messageIdFromEventId(messageEventId: string): string {
  const messageId = MESSAGE_EVENT_ID_PATTERN.exec(messageEventId)?.[1];
  if (!messageId) throw new RuntimeMaterialError("runtime_material_invalid");
  return messageId;
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


function generationNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return number;
}
