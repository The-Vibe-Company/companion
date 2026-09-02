import { describe, expect, it } from "vitest";

import {
  assertCompanionV2PurgeDisabled,
  mergeCompanionV2PurgeTargets,
  parseCompanionV2PurgeArgs,
  processCompanionV2PurgeTargets,
  type CompanionV2PurgeJournal,
  type CompanionV2PurgeTarget,
} from "./companionV2Purge";

describe("Runtime v2 purge operator interface", () => {
  it("selects destructive mode only for the exact confirmation phrase", () => {
    expect(parseCompanionV2PurgeArgs(["report"])).toEqual({ mode: "report" });
    expect(parseCompanionV2PurgeArgs(["purge", "--dry-run"])).toEqual({ mode: "dry-run" });
    expect(parseCompanionV2PurgeArgs([
      "purge",
      "--confirm-delete-all-companions",
    ])).toEqual({ mode: "purge" });

    for (const argv of [
      ["purge"],
      ["purge", "--force"],
      ["purge", "--confirm-delete-all-companions", "--dry-run"],
      ["report", "--confirm-delete-all-companions"],
    ]) {
      expect(() => parseCompanionV2PurgeArgs(argv)).toThrow(
        "usage: node dist/companionV2Purge.js report | purge --dry-run | purge --confirm-delete-all-companions",
      );
    }
  });

  it("requires the Companions environment flag to be explicitly false", () => {
    expect(() => assertCompanionV2PurgeDisabled({
      COMPANION_COMPANIONS_ENABLED: " false ",
    })).not.toThrow();
    for (const value of [undefined, "", "true", "0"]) {
      const env: NodeJS.ProcessEnv = {};
      if (value !== undefined) env.COMPANION_COMPANIONS_ENABLED = value;
      expect(() => assertCompanionV2PurgeDisabled(env))
        .toThrow("must be explicitly set to false");
    }
  });
});

describe("Runtime v2 purge inventory", () => {
  it("unions database ownership and provider discovery without leaking payloads", () => {
    expect(mergeCompanionV2PurgeTargets([
      { kind: "box", key: "bx_23456789", evidence: ["database:runtime-instance"] },
      { kind: "box", key: "bx_23456789", evidence: ["provider-name:companion-generation"] },
      { kind: "object", key: "companion-attachments/org/companion/file", evidence: ["storage-prefix"] },
      { kind: "snapshot", key: "companion-l14-0123456789ab", evidence: ["provider-name:v2-image"] },
    ])).toEqual([
      {
        kind: "box",
        key: "bx_23456789",
        evidence: ["database:runtime-instance", "provider-name:companion-generation"],
      },
      {
        kind: "object",
        key: "companion-attachments/org/companion/file",
        evidence: ["storage-prefix"],
      },
      {
        kind: "snapshot",
        key: "companion-l14-0123456789ab",
        evidence: ["provider-name:v2-image"],
      },
    ]);
  });
});

describe("Runtime v2 external purge checkpoints", () => {
  it("checkpoints before effects, accepts absence, and stops at the first unresolved failure", async () => {
    const targets: CompanionV2PurgeTarget[] = [
      { kind: "trigger", key: "trigger-1", evidence: ["database:registered-trigger"] },
      { kind: "object", key: "object-1", evidence: ["database:attachment"] },
      { kind: "box", key: "box-1", evidence: ["database:runtime-instance"] },
    ];
    const events: string[] = [];
    const journal: CompanionV2PurgeJournal = {
      async markRequesting(target) { events.push(`checkpoint:${target.kind}:${target.key}`); },
      async markComplete(target, outcome) { events.push(`complete:${target.key}:${outcome}`); },
      async markFailure(target, message) { events.push(`failure:${target.key}:${message}`); },
    };

    await expect(processCompanionV2PurgeTargets({
      targets,
      journal,
      remove: async (target) => {
        events.push(`effect:${target.kind}:${target.key}`);
        if (target.key === "trigger-1") return "absent";
        if (target.key === "object-1") throw new Error("provider payload: secret-value");
        return "completed";
      },
    })).rejects.toThrow("provider payload: secret-value");

    expect(events).toEqual([
      "checkpoint:trigger:trigger-1",
      "effect:trigger:trigger-1",
      "complete:trigger-1:absent",
      "checkpoint:object:object-1",
      "effect:object:object-1",
      "failure:object-1:external removal failed; retry the purge",
    ]);
  });

  it("skips completed targets when a partial purge resumes", async () => {
    const removed: string[] = [];
    await processCompanionV2PurgeTargets({
      targets: [
        { kind: "object", key: "done", evidence: [], state: "completed" },
        { kind: "object", key: "retry", evidence: [], state: "requesting" },
      ],
      journal: {
        async markRequesting() {},
        async markComplete() {},
        async markFailure() {},
      },
      remove: async (target) => {
        removed.push(target.key);
        return "completed";
      },
    });
    expect(removed).toEqual(["retry"]);
  });
});
