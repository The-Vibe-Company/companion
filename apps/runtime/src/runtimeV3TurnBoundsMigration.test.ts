import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Runtime v3 Turn bounds migration", () => {
  it("backfills admission write-intent for terminal accepted and ambiguous Turns", async () => {
    const source = await readFile(fileURLToPath(new URL(
      "../../../packages/db/drizzle/0168_companion_runtime_v3_turn_bounds.sql",
      import.meta.url,
    )), "utf8");
    const admissionBackfill = source.split("--> statement-breakpoint")[2]!;

    expect(admissionBackfill).toContain("SET admission_started_at = admitted_at");
    expect(admissionBackfill).toContain("admission_state IN ('accepted', 'ambiguous')");
    expect(admissionBackfill).not.toContain("WHERE state IN (");
  });
});
