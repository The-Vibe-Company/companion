/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- Fixture rows mirror store.test.ts's recording-SQL pattern; definer-function rows are hand-written fakes. */
import { describe, expect, it } from "vitest";
import {
  CompanionImageRegistry,
  IMAGE_BUILD_BACKOFF_MS,
  IMAGE_BUILD_LEASE_SECONDS,
  IMAGE_FAILURE_REARM_COOLDOWN_SECONDS,
  type ClaimedImageBuild,
  type CompanionImage,
} from "./imageRegistry";
import type { RuntimeSqlClient, RuntimeSqlRow } from "./store";

class RecordingSql implements RuntimeSqlClient {
  readonly calls: Array<{ query: string; parameters: unknown[] }> = [];
  rows: RuntimeSqlRow[] = [];

  async unsafe<T extends RuntimeSqlRow[]>(
    query: string,
    parameters: unknown[] = [],
  ): Promise<T> {
    this.calls.push({ query, parameters });
    return this.rows as T;
  }
}

const DIGEST = "a".repeat(64);
const IMAGE_NAME = "companion-l14-0123456789ab";

function imageRow(overrides: Partial<Record<string, unknown>> = {}): RuntimeSqlRow {
  return {
    digest: DIGEST,
    image_name: IMAGE_NAME,
    status: "requested",
    parent_image_name: null,
    build_box_id: null,
    build_delete_intent_at: null,
    build_delete_operation_id: null,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    ...overrides,
  } as RuntimeSqlRow;
}

describe("CompanionImageRegistry", () => {
  it("requests an image through the definer surface", async () => {
    const sql = new RecordingSql();
    sql.rows = [imageRow()];
    const registry = new CompanionImageRegistry(sql);
    const image = await registry.requestImage({ digest: DIGEST, imageName: IMAGE_NAME });

    expect(image.status).toBe("requested");
    const call = sql.calls[0];
    if (!call) throw new Error("The registry did not query the database.");
    expect(call.query).toContain("companion_runtime_image_request($1, $2)");
    expect(call.parameters).toEqual([DIGEST, IMAGE_NAME]);
  });

  it("claims a build with a single-builder lease and epoch increment", async () => {
    const sql = new RecordingSql();
    sql.rows = [{
      image_digest: DIGEST,
      image_name: IMAGE_NAME,
      image_claim_epoch: "7",
      image_attempt_count: 1,
      image_build_box_id: "bx_recovery01",
      image_build_delete_intent_recorded: true,
      image_build_delete_operation_id: "bdop_00000000000000000000000000000001",
      image_recovery_only: false,
    } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    const claim: ClaimedImageBuild | null = await registry.claimImageBuild({
      executorId: "executor-1",
      digest: DIGEST,
      imageName: IMAGE_NAME,
    });

    expect(claim).toEqual({
      digest: DIGEST,
      imageName: IMAGE_NAME,
      claimEpoch: 7,
      attemptCount: 1,
      buildBoxId: "bx_recovery01",
      buildDeleteIntentRecorded: true,
      buildDeleteOperationId: "bdop_00000000000000000000000000000001",
      recoveryOnly: false,
    });
    const call = sql.calls[0];
    if (!call) throw new Error("The registry did not query the database.");
    expect(call.query).toContain("from companion_runtime_image_claim($1, $2, $3)");
    expect(call.parameters).toEqual(["executor-1", DIGEST, IMAGE_NAME]);
  });

  it("returns null when nothing is claimable", async () => {
    const sql = new RecordingSql();
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.claimImageBuild({
      executorId: "executor-1",
      digest: DIGEST,
      imageName: IMAGE_NAME,
    })).resolves.toBeNull();
  });

  it("records readiness behind the epoch fence", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ recorded: true } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    const outcome = await registry.recordBuildOutcome({
      digest: DIGEST,
      claimEpoch: 7,
      kind: "ready",
      imageName: IMAGE_NAME,
    });

    expect(outcome).toBe("ready");
    const call = sql.calls[0];
    if (!call) throw new Error("The registry did not query the database.");
    expect(call.query).toContain("companion_runtime_image_record_ready($1, $2, $3, $4)");
    expect(call.parameters).toEqual([DIGEST, 7, IMAGE_NAME, null]);
  });

  it("persists a failure and reports the retryable outcome", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ outcome: "requested" } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    const outcome = await registry.recordBuildOutcome({
      digest: DIGEST,
      claimEpoch: 7,
      kind: "failed",
      errorCode: "bake_snapshot_failed",
      errorMessage: "The snapshot never became ready.",
    });

    expect(outcome).toBe("failed");
    const call = sql.calls[0];
    if (!call) throw new Error("The registry did not query the database.");
    expect(call.query).toContain("companion_runtime_image_record_failure($1, $2, $3, $4)");
    expect(call.parameters).toEqual([
      DIGEST,
      7,
      "bake_snapshot_failed",
      "The snapshot never became ready.",
    ]);
  });

  it("maps a terminal failure status to a failed outcome too", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ outcome: "failed" } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.recordBuildOutcome({
      digest: DIGEST,
      claimEpoch: 7,
      kind: "failed",
      errorCode: "bake_snapshot_failed",
      errorMessage: "still broken",
    })).resolves.toBe("failed");
  });

  it("rejects malformed error codes before touching the database", async () => {
    const sql = new RecordingSql();
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.recordBuildOutcome({
      digest: DIGEST,
      claimEpoch: 7,
      kind: "failed",
      errorCode: "Not A Code!",
      errorMessage: "nope",
    })).rejects.toBeInstanceOf(TypeError);
    expect(sql.calls).toHaveLength(0);
  });

  it("reports a lost lease when the fence no longer matches", async () => {
    const sql = new RecordingSql();
    sql.rows = [];
    const registry = new CompanionImageRegistry(sql);
    const outcome = await registry.recordBuildOutcome({
      digest: DIGEST,
      claimEpoch: 6,
      kind: "ready",
      imageName: IMAGE_NAME,
    });
    expect(outcome).toBe("lease_lost");
  });

  it("authorizes provider publication only through the exact epoch and baker Box fence", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ authorized: true } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.authorizeSnapshotPublication({
      digest: DIGEST,
      claimEpoch: 7,
      buildBoxId: "bx_baker01",
    })).resolves.toBe(true);
    expect(sql.calls[0]?.query).toContain(
      "companion_runtime_image_authorize_publish($1, $2, $3)",
    );
    expect(sql.calls[0]?.parameters).toEqual([DIGEST, 7, "bx_baker01"]);
  });

  it("decodes stored images and rejects malformed rows", async () => {
    const sql = new RecordingSql();
    sql.rows = [imageRow({
      status: "ready",
      parent_image_name: "companion-l14-fedcba098765",
    })];
    const registry = new CompanionImageRegistry(sql);
    const image: CompanionImage | null = await registry.getByDigest(DIGEST);
    expect(image?.status).toBe("ready");

    sql.rows = [{ image_name: IMAGE_NAME } as RuntimeSqlRow];
    await expect(registry.getByDigest(DIGEST)).rejects.toBeTruthy();

    sql.rows = [];
    await expect(registry.getByDigest(DIGEST)).resolves.toBeNull();
  });

  it("marks the baking Box only behind its lease", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ marked: true } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.markBuildingBox({
      digest: DIGEST,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
    })).resolves.toBe(true);
    expect(sql.calls[0]?.query).toContain(
      "companion_runtime_image_mark_building_box($1, $2, $3)",
    );
  });

  it("clears the baking Box only behind its lease and exact provider identity", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ cleared: true } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.clearBuildingBox({
      digest: DIGEST,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
    })).resolves.toBe(true);
    expect(sql.calls[0]?.query).toContain(
      "companion_runtime_image_clear_building_box($1, $2, $3)",
    );
    expect(sql.calls[0]?.parameters).toEqual([DIGEST, 3, "bx_baker01"]);
  });

  it("persists the accepted provider deletion behind the Box and lease fence", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ marked: true } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.markBuildingBoxDeletion({
      digest: DIGEST,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
      operationId: "bdop_00000000000000000000000000000001",
    })).resolves.toBe(true);
    expect(sql.calls[0]?.query).toContain(
      "companion_runtime_image_mark_delete_operation($1, $2, $3, $4)",
    );
  });

  it("persists deletion intent before the irreversible provider call", async () => {
    const sql = new RecordingSql();
    sql.rows = [{ marked: true } as RuntimeSqlRow];
    const registry = new CompanionImageRegistry(sql);
    await expect(registry.markBuildingBoxDeletionIntent({
      digest: DIGEST,
      claimEpoch: 3,
      buildBoxId: "bx_baker01",
    })).resolves.toBe(true);
    expect(sql.calls[0]?.query).toContain(
      "companion_runtime_image_mark_delete_intent($1, $2, $3)",
    );
  });

  it("exposes the cooldown constant used by the definer request function", () => {
    expect(IMAGE_FAILURE_REARM_COOLDOWN_SECONDS).toBe(600);
    expect(IMAGE_BUILD_BACKOFF_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(IMAGE_BUILD_LEASE_SECONDS).toBe(2_700);
  });
});
