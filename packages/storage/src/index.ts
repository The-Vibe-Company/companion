/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Hosted Companion removal preserves existing Skills Hub patterns that predate this change. */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export function getStorageConfig(): StorageConfig {
  const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "companion";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "companion-secret";
  const bucket = process.env.S3_BUCKET_SKILL_ARCHIVES ?? "skill-archives";
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_BUCKET_SKILL_ARCHIVES are required");
  }
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  };
}

export function createStorageClient(config = getStorageConfig()): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export function skillArchiveKey(input: { orgId: string; slug: string; version: string }): string {
  return `${input.orgId}/${input.slug}/${input.version}.tar.gz`;
}

function assertStorageKeySegment(value: string, label: string): void {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`${label} is invalid`);
  }
}

/** Mutable SQLite file for one skill database realm. */
export function skillDatabaseKey(input: {
  orgId: string;
  skillId: string;
  realmId: string;
  audience: "organization" | "personal";
  userId?: string;
}): string {
  assertStorageKeySegment(input.orgId, "skill database org id");
  assertStorageKeySegment(input.skillId, "skill database skill id");
  assertStorageKeySegment(input.realmId, "skill database realm id");
  if (input.audience === "organization") {
    if (input.userId !== undefined) throw new Error("organization skill database key must not include a user");
    return `${input.orgId}/skill-databases/${input.skillId}/organization/${input.realmId}.db`;
  }
  if (!input.userId) throw new Error("personal skill database key requires a user");
  assertStorageKeySegment(input.userId, "skill database user id");
  return `${input.orgId}/skill-databases/${input.skillId}/personal/${input.userId}/${input.realmId}.db`;
}

const SHA256_CHECKSUM_PATTERN = /^sha256:([0-9a-f]{64})$/;

/**
 * Content-addressed key for the exact ZIP bytes of a public release. The owning org remains the
 * first path segment so object-storage lifecycle and incident tooling retain the tenant boundary.
 */
export function publicSkillReleaseKey(input: { orgId: string; checksum: string }): string {
  const digest = SHA256_CHECKSUM_PATTERN.exec(input.checksum)?.[1];
  if (!digest) throw new Error("public skill release checksum must be a sha256 digest");
  if (!input.orgId || input.orgId.includes("/") || input.orgId.includes("\\") || input.orgId.includes("..")) {
    throw new Error("public skill release org id is invalid");
  }
  return `${input.orgId}/public-releases/sha256/${digest}.zip`;
}

/**
 * Persist a public ZIP once under its content address. A retry may observe an existing object, but
 * it is accepted only after reading and hashing those exact bytes; the helper never overwrites it.
 */
export async function putPublicSkillReleaseSnapshot(input: {
  orgId: string;
  checksum: string;
  body: Uint8Array;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<string> {
  const key = publicSkillReleaseKey(input);
  const body = Buffer.from(input.body);
  const actualChecksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (actualChecksum !== input.checksum) {
    throw new Error("public skill release bytes do not match their content address");
  }

  try {
    await putSkillArchive({
      key,
      body,
      contentType: "application/zip",
      preventOverwrite: true,
      signal: input.signal,
      client: input.client,
      config: input.config,
    });
  } catch (error) {
    if (!isStoragePreconditionFailure(error)) throw error;
    const existing = await getSkillArchive({
      key,
      signal: input.signal,
      client: input.client,
      config: input.config,
    });
    const existingChecksum = `sha256:${createHash("sha256").update(existing).digest("hex")}`;
    if (existing.length !== body.length || existingChecksum !== input.checksum) {
      throw new Error("stored public skill release does not match its content address");
    }
  }
  return key;
}

/** Stored workspace brand logo for an org (content-type is kept on the object). */
export function orgLogoKey(orgId: string): string {
  return `orgs/${orgId}/logo`;
}

/** Stored custom profile avatar for a user (content-type is kept on the object). */
export function userAvatarKey(userId: string): string {
  return `users/${userId}/avatar`;
}

/**
 * Stored comment image attachment. `imageId` is globally unique (the `skill_comment_images.id`),
 * so the key needs no comment/skill segment. Content-type is kept on the object. Uploaded with the
 * generic `putSkillArchive` / read with `getSkillArchive` / removed with `deleteSkillArchive`.
 */
export function commentImageKey(input: { orgId: string; imageId: string }): string {
  return `${input.orgId}/comments/${input.imageId}`;
}



export async function putOrgLogo(input: {
  orgId: string;
  body: Uint8Array;
  contentType: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: orgLogoKey(input.orgId),
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

export async function getOrgLogo(input: {
  orgId: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<{ body: Buffer; contentType: string } | null> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: orgLogoKey(input.orgId),
      }),
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: res.ContentType ?? "application/octet-stream",
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw error;
  }
}

export async function putUserAvatar(input: {
  userId: string;
  body: Uint8Array;
  contentType: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: userAvatarKey(input.userId),
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

export async function getUserAvatar(input: {
  userId: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<{ body: Buffer; contentType: string } | null> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: userAvatarKey(input.userId),
      }),
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: res.ContentType ?? "application/octet-stream",
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw error;
  }
}

export async function deleteUserAvatar(input: {
  userId: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: userAvatarKey(input.userId),
    }),
  );
}

export async function putSkillArchive(input: {
  key: string;
  body: Uint8Array;
  contentType?: string;
  preventOverwrite?: boolean;
  ifMatch?: string;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<string | null> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  const response = await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType ?? "application/gzip",
      IfNoneMatch: input.preventOverwrite ? "*" : undefined,
      IfMatch: input.ifMatch,
    }),
    { abortSignal: input.signal },
  );
  return response.ETag ?? null;
}

export async function headSkillArchive(input: {
  key: string;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<{ etag: string; contentLength?: number } | null> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: input.key }),
      { abortSignal: input.signal },
    );
    if (!response.ETag) return null;
    return typeof response.ContentLength === "number"
      ? { etag: response.ETag, contentLength: response.ContentLength }
      : { etag: response.ETag };
  } catch (error) {
    const status = typeof error === "object" && error !== null && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
    const name = error instanceof Error ? error.name : "";
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
    throw error;
  }
}

export function isStoragePreconditionFailure(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "$metadata" in error
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined;
  const name = error instanceof Error ? error.name : "";
  return status === 412 || name === "PreconditionFailed";
}

/**
 * Delete one object by key. Companion keeps every object family in the same bucket under distinct
 * prefixes, so callers that hold a stored key can remove exactly that object without knowing which
 * family produced it.
 */
export async function deleteStorageObject(input: {
  key: string;
  ifMatch?: string;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      IfMatch: input.ifMatch,
    }),
    { abortSignal: input.signal },
  );
}

export async function deleteSkillArchive(input: {
  key: string;
  ifMatch?: string;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  await deleteStorageObject(input);
}

export async function getSkillArchive(input: {
  key: string;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<Buffer> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
    }),
    { abortSignal: input.signal },
  );
  if (!res.Body) throw new Error(`object not found: ${input.key}`);
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/** Read mutable bytes and the exact ETag used for the next conditional PUT. */
export async function getSkillArchiveWithEtag(input: {
  key: string;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<{ body: Buffer; etag: string } | null> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: input.key }),
      { abortSignal: input.signal },
    );
    if (!response.Body || !response.ETag) return null;
    const bytes = await response.Body.transformToByteArray();
    return { body: Buffer.from(bytes), etag: response.ETag };
  } catch (error) {
    const status = typeof error === "object" && error !== null && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
    const name = error instanceof Error ? error.name : "";
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
    throw error;
  }
}

export interface SkillArchiveByteRange {
  start: number;
  end: number;
  length: number;
  header: string;
}

export class InvalidSkillArchiveRangeError extends Error {
  constructor() {
    super("requested byte range is not satisfiable");
    this.name = "InvalidSkillArchiveRangeError";
  }
}

/** Resolve one RFC 9110 byte range. Multiple ranges are deliberately unsupported. */
export function resolveSkillArchiveByteRange(value: string, size: number): SkillArchiveByteRange {
  if (!Number.isSafeInteger(size) || size < 0) throw new InvalidSkillArchiveRangeError();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "") || size === 0) {
    throw new InvalidSkillArchiveRangeError();
  }

  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new InvalidSkillArchiveRangeError();
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
      throw new InvalidSkillArchiveRangeError();
    }
    end = Math.min(requestedEnd, size - 1);
  }

  return { start, end, length: end - start + 1, header: `bytes=${start}-${end}` };
}

export interface SkillArchiveStream {
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
  etag: string | null;
}

/** Open an object as a web stream, optionally pinned to the ETag observed by a preceding HEAD. */
export async function streamSkillArchive(input: {
  key: string;
  range?: string;
  ifMatch?: string;
  signal?: AbortSignal;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<SkillArchiveStream> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      Range: input.range,
      IfMatch: input.ifMatch,
    }),
    { abortSignal: input.signal },
  );
  if (!response.Body) throw new Error(`object not found: ${input.key}`);
  return {
    body: response.Body.transformToWebStream(),
    contentLength: response.ContentLength ?? null,
    contentRange: response.ContentRange ?? null,
    contentType: response.ContentType ?? null,
    etag: response.ETag ?? null,
  };
}

export async function signedSkillArchiveUrl(input: {
  key: string;
  expiresIn?: number;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<string> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
    }),
    { expiresIn: input.expiresIn ?? 300 },
  );
}
