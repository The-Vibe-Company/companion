/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- PostgreSQL row decoding at the driver boundary mirrors store.ts. */

import type { RuntimeSqlClient, RuntimeSqlRow } from "./store";

/** Retry bases; PostgreSQL adds bounded positive jitter before making each claim available. */
export const IMAGE_BUILD_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
export const IMAGE_BUILD_MAX_ATTEMPTS = 4;
/** Longer than the 40-minute bake budget plus its independent two-minute cleanup reserve. */
export const IMAGE_BUILD_LEASE_SECONDS = 45 * 60;
/** An exhausted failure stays visible for this long before a fresh request may re-arm it. */
export const IMAGE_FAILURE_REARM_COOLDOWN_SECONDS = 600;

export type CompanionImageStatus = "requested" | "building" | "ready" | "failed";

export interface CompanionImage {
  digest: string;
  imageName: string;
  status: CompanionImageStatus;
  parentImageName: string | null;
  buildBoxId: string | null;
  buildDeleteIntentRecorded: boolean;
  buildDeleteOperationId: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  leaseExpiresAt: Date | null;
}

export interface ClaimedImageBuild {
  digest: string;
  imageName: string;
  claimEpoch: number;
  attemptCount: number;
  buildBoxId: string | null;
  buildDeleteIntentRecorded: boolean;
  buildDeleteOperationId: string | null;
  recoveryOnly: boolean;
}

export type ImageBuildOutcome =
  | "ready"
  | "failed"
  | "lease_lost";

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isRecord(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function date(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const decoded = new Date(value);
  return Number.isFinite(decoded.getTime()) ? decoded : null;
}

function decodeImage(row: RuntimeSqlRow): CompanionImage | null {
  if (!isRecord(row)) return null;
  const digest = text(row.digest);
  const imageName = text(row.image_name);
  const status = text(row.status);
  if (!digest || !imageName || status === null || !isCompanionImageStatus(status)) return null;
  return {
    digest,
    imageName,
    status,
    parentImageName: text(row.parent_image_name),
    buildBoxId: text(row.build_box_id),
    buildDeleteIntentRecorded: row.build_delete_intent_at !== null
      && row.build_delete_intent_at !== undefined,
    buildDeleteOperationId: text(row.build_delete_operation_id),
    attemptCount: integer(row.attempt_count) ?? 0,
    lastErrorCode: text(row.last_error_code),
    lastErrorMessage: text(row.last_error_message),
    leaseExpiresAt: date(row.lease_expires_at),
  };
}

export function isCompanionImageStatus(value: string): value is CompanionImageStatus {
  return value === "requested" || value === "building"
    || value === "ready" || value === "failed";
}

/**
 * Durable image registry client: the desired state ("this digest should exist") and the observed
 * build state are separate columns reconciled by a single leased builder. All access crosses the
 * SECURITY DEFINER surface installed by migration 0123 — no process role holds table privileges.
 * See docs/companion-image-pipeline.md.
 */
export class CompanionImageRegistry {
  constructor(private readonly sql: RuntimeSqlClient) {}

  /**
   * Idempotent: concurrent requests collapse onto one row. An exhausted failure re-arms only
   * after a cooldown, so a permanently broken build stays visibly failed instead of looping.
   */
  async requestImage(input: { digest: string; imageName: string }): Promise<CompanionImage> {
    const rows = await this.sql.unsafe(
      "select * from companion_runtime_image_request($1, $2)",
      [input.digest, input.imageName],
    );
    const requested = rows[0];
    const decoded = requested ? decodeImage(requested) : null;
    if (!decoded) throw new Error("The image registry did not return the requested row.");
    return decoded;
  }

  async getByDigest(digest: string): Promise<CompanionImage | null> {
    const rows = await this.sql.unsafe(
      "select * from companion_runtime_image_get($1)",
      [digest],
    );
    const existing = rows[0];
    if (!existing) return null;
    const decoded = decodeImage(existing);
    if (!decoded) throw new Error("The image registry returned a malformed row.");
    return decoded;
  }

  /**
   * Leases one claimable image: never-built, retryable-failed past backoff, or building
   * past an expired lease (crashed builder). Returns null when nothing is claimable.
   */
  async claimImageBuild(input: {
    executorId: string;
    digest: string;
    imageName: string;
  }): Promise<ClaimedImageBuild | null> {
    const rows = await this.sql.unsafe(
      `select image_digest, image_name, image_claim_epoch, image_attempt_count,
         image_build_box_id, image_build_delete_intent_recorded,
         image_build_delete_operation_id, image_recovery_only
       from companion_runtime_image_claim($1, $2, $3)`,
      [input.executorId, input.digest, input.imageName],
    );
    const row = rows[0];
    if (!isRecord(row)) return null;
    const digest = text(row.image_digest);
    const imageName = text(row.image_name);
    const claimEpoch = integer(Number(row.image_claim_epoch));
    const attemptCount = integer(row.image_attempt_count);
    const buildBoxId = text(row.image_build_box_id);
    const buildDeleteIntentRecorded = row.image_build_delete_intent_recorded;
    const buildDeleteOperationId = text(row.image_build_delete_operation_id);
    const recoveryOnly = row.image_recovery_only;
    if (
      !digest || !imageName || claimEpoch === null || attemptCount === null
      || typeof buildDeleteIntentRecorded !== "boolean"
      || typeof recoveryOnly !== "boolean"
    ) {
      throw new Error("The image registry returned a malformed claim row.");
    }
    return {
      digest,
      imageName,
      claimEpoch,
      attemptCount,
      buildBoxId,
      buildDeleteIntentRecorded,
      buildDeleteOperationId,
      recoveryOnly,
    };
  }

  /**
   * Proves an epoch still owns its exact baker Box with enough lease headroom for the bounded
   * snapshot publication call. A stale builder must stop before provider publication.
   */
  async authorizeSnapshotPublication(input: {
    digest: string;
    claimEpoch: number;
    buildBoxId: string;
  }): Promise<boolean> {
    const rows = await this.sql.unsafe(
      "select companion_runtime_image_authorize_publish($1, $2, $3) as authorized",
      [input.digest, input.claimEpoch, input.buildBoxId],
    );
    const first = rows[0];
    return isRecord(first) && first.authorized === true;
  }

  /**
   * Persists a builder transition behind its epoch fence. A stale fence returns
   * lease_lost and changes nothing.
   */
  async recordBuildOutcome(
    input: { digest: string; claimEpoch: number } & (
      | { kind: "ready"; imageName: string; parentImageName?: string | null }
      | { kind: "failed"; errorCode: string; errorMessage: string }
    ),
  ): Promise<ImageBuildOutcome> {
    if (input.kind === "failed" && !ERROR_CODE_PATTERN.test(input.errorCode)) {
      throw new TypeError("The image build error code must be a stable snake_case token.");
    }
    if (input.kind === "ready") {
      const rows = await this.sql.unsafe(
        "select companion_runtime_image_record_ready($1, $2, $3, $4) as recorded",
        [
          input.digest,
          input.claimEpoch,
          input.imageName,
          input.parentImageName ?? null,
        ],
      );
      const first = rows[0];
      return isRecord(first) && first.recorded === true ? "ready" : "lease_lost";
    }
    const rows = await this.sql.unsafe(
      "select companion_runtime_image_record_failure($1, $2, $3, $4) as outcome",
      [input.digest, input.claimEpoch, input.errorCode, input.errorMessage],
    );
    const first = rows[0];
    const outcome = isRecord(first) ? text(first.outcome) : null;
    if (outcome === "requested") return "failed";
    if (outcome === "failed") return "failed";
    return "lease_lost";
  }

  async markBuildingBox(
    input: { digest: string; claimEpoch: number; buildBoxId: string },
  ): Promise<boolean> {
    const rows = await this.sql.unsafe(
      "select companion_runtime_image_mark_building_box($1, $2, $3) as marked",
      [input.digest, input.claimEpoch, input.buildBoxId],
    );
    const first = rows[0];
    return isRecord(first) && first.marked === true;
  }

  async clearBuildingBox(
    input: { digest: string; claimEpoch: number; buildBoxId: string },
  ): Promise<boolean> {
    const rows = await this.sql.unsafe(
      "select companion_runtime_image_clear_building_box($1, $2, $3) as cleared",
      [input.digest, input.claimEpoch, input.buildBoxId],
    );
    const first = rows[0];
    return isRecord(first) && first.cleared === true;
  }

  async markBuildingBoxDeletion(
    input: { digest: string; claimEpoch: number; buildBoxId: string; operationId: string },
  ): Promise<boolean> {
    const rows = await this.sql.unsafe(
      "select companion_runtime_image_mark_delete_operation($1, $2, $3, $4) as marked",
      [input.digest, input.claimEpoch, input.buildBoxId, input.operationId],
    );
    const first = rows[0];
    return isRecord(first) && first.marked === true;
  }

  async markBuildingBoxDeletionIntent(
    input: { digest: string; claimEpoch: number; buildBoxId: string },
  ): Promise<boolean> {
    const rows = await this.sql.unsafe(
      "select companion_runtime_image_mark_delete_intent($1, $2, $3) as marked",
      [input.digest, input.claimEpoch, input.buildBoxId],
    );
    const first = rows[0];
    return isRecord(first) && first.marked === true;
  }
}
