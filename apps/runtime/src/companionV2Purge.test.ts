import { describe, expect, it } from "vitest";
import { BoxRuntimeAdapterError } from "@companion/box-runtime";

import {
  collectCompanionV2ObjectKeys,
  assertCompanionV2PurgeDisabled,
  mergeCompanionV2PurgeTargets,
  parseCompanionV2PurgeArgs,
  processCompanionV2PurgeTargets,
  type CompanionV2PurgeJournal,
  type CompanionV2PurgeTarget,
} from "./companionV2Purge";

describe("Runtime v2 object inventory pagination", () => {
  it("collects every page and rejects truncated responses without forward progress", async () => {
    await expect(collectCompanionV2ObjectKeys(async (token) => token
      ? { Contents: [{ Key: "companion-attachments/b" }], IsTruncated: false }
      : {
          Contents: [{ Key: "companion-attachments/a" }],
          IsTruncated: true,
          NextContinuationToken: "page-2",
        })).resolves.toEqual(["companion-attachments/a", "companion-attachments/b"]);

    await expect(collectCompanionV2ObjectKeys(async () => ({
      IsTruncated: true,
    }))).rejects.toThrow("object inventory returned invalid pagination");

    await expect(collectCompanionV2ObjectKeys(async () => ({
      IsTruncated: true,
      NextContinuationToken: "same-page",
    }))).rejects.toThrow("object inventory returned invalid pagination");
  });
});

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

  it("retains one provider operation checkpoint and rejects conflicting ownership", () => {
    expect(mergeCompanionV2PurgeTargets([
      {
        kind: "box",
        key: "bx_23456789",
        evidence: ["database:image-build-box"],
        operationId: "bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        kind: "box",
        key: "bx_23456789",
        evidence: ["provider-id:box"],
      },
    ])).toEqual([{
      kind: "box",
      key: "bx_23456789",
      evidence: ["database:image-build-box", "provider-id:box"],
      operationId: "bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }]);
    expect(() => mergeCompanionV2PurgeTargets([
      {
        kind: "box",
        key: "bx_23456789",
        evidence: ["database:image-build-box"],
        operationId: "bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        kind: "box",
        key: "bx_23456789",
        evidence: ["database:duplicate-cleanup"],
        operationId: "bdop_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ])).toThrow("conflicting provider deletion operations");
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
      providerPresent: () => true,
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
    const inspected: string[] = [];
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
      providerPresent: (target) => {
        inspected.push(target.key);
        return true;
      },
      remove: async (target) => {
        removed.push(target.key);
        return "completed";
      },
    });
    expect({ inspected, removed }).toEqual({ inspected: ["retry"], removed: ["retry"] });
  });

  it("reconciles every effect committed before its terminal checkpoint without deleting twice", async () => {
    for (const kind of ["trigger", "object", "snapshot"] as const) {
      let present = true;
      let effects = 0;
      const target: CompanionV2PurgeTarget = {
        kind,
        key: `${kind}-reconciled`,
        evidence: [`provider:${kind}`],
      };
      await expect(processCompanionV2PurgeTargets({
        targets: [target],
        journal: {
          async markRequesting() {},
          async markComplete() {},
          async markFailure() {},
        },
        providerPresent: async () => present,
        afterExternalEffect: async () => { throw new Error(`crash after ${kind} effect`); },
        remove: async () => {
          effects += 1;
          present = false;
          return "completed";
        },
      })).rejects.toThrow(`crash after ${kind} effect`);

      const outcomes: string[] = [];
      await processCompanionV2PurgeTargets({
        targets: [{ ...target, state: "requesting" }],
        journal: {
          async markRequesting() {},
          async markComplete(_target, outcome) { outcomes.push(outcome); },
          async markFailure() {},
        },
        providerPresent: async () => present,
        remove: async () => {
          effects += 1;
          return "completed";
        },
      });
      expect({ kind, effects, outcomes }).toEqual({ kind, effects: 1, outcomes: ["absent"] });
    }
  });

  it("retries only after fresh presence proves that Box DELETE admission did not occur", async () => {
    const effects: string[] = [];
    await expect(processCompanionV2PurgeTargets({
      targets: [{
        kind: "box",
        key: "bx_ambiguous",
        evidence: ["provider-name:companion-generation"],
        state: "requesting",
        operationId: null,
      }],
      journal: {
        async markRequesting() {},
        async markComplete() {},
        async markFailure() {},
      },
      providerPresent: () => true,
      remove: async (target) => {
        effects.push(target.key);
        return "completed";
      },
    })).resolves.toBeUndefined();
    expect(effects).toEqual(["bx_ambiguous"]);
  });

  it("does not replay Box DELETE when fresh authenticated inventory proves absence", async () => {
    const effects: string[] = [];
    const outcomes: string[] = [];
    await processCompanionV2PurgeTargets({
      targets: [{
        kind: "box",
        key: "bx_admitted",
        evidence: ["database:runtime-instance"],
        state: "requesting",
        operationId: null,
      }],
      journal: {
        async markRequesting() {},
        async markComplete(_target, outcome) { outcomes.push(outcome); },
        async markFailure() {},
      },
      providerPresent: () => false,
      remove: async (target) => {
        effects.push(target.key);
        return "completed";
      },
    });
    expect({ effects, outcomes }).toEqual({ effects: [], outcomes: ["absent"] });
  });

  it("polls a durable Box operation even after the Box leaves ordinary inventory", async () => {
    const effects: string[] = [];
    await processCompanionV2PurgeTargets({
      targets: [{
        kind: "box",
        key: "bx_operation",
        evidence: ["database:runtime-instance"],
        state: "requesting",
        operationId: "bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      journal: {
        async markRequesting() {},
        async markComplete() {},
        async markFailure() {},
      },
      providerPresent: () => false,
      remove: async (target) => {
        effects.push(target.operationId!);
        return "completed";
      },
    });
    expect(effects).toEqual(["bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("fails closed before a requesting effect when authenticated reconciliation fails", async () => {
    const events: string[] = [];
    await expect(processCompanionV2PurgeTargets({
      targets: [{
        kind: "box",
        key: "bx_unknown",
        evidence: ["database:runtime-instance"],
        state: "requesting",
        operationId: null,
      }],
      journal: {
        async markRequesting() { events.push("requesting"); },
        async markComplete() {},
        async markFailure() {},
      },
      providerPresent: () => { throw new Error("authenticated read failed"); },
      remove: async () => {
        events.push("effect");
        return "completed";
      },
    })).rejects.toThrow("authenticated read failed");
    expect(events).toEqual([]);
  });

  it("leaves a durable requesting checkpoint when the process stops before the effect", async () => {
    const events: string[] = [];
    await expect(processCompanionV2PurgeTargets({
      targets: [{ kind: "box", key: "bx_before", evidence: ["provider-id:box"] }],
      journal: {
        async markRequesting() { events.push("requesting"); },
        async markComplete() { events.push("complete"); },
        async markFailure() { events.push("failure"); },
      },
      providerPresent: () => true,
      beforeExternalEffect: async () => { throw new Error("crash before Box DELETE"); },
      remove: async () => {
        events.push("effect");
        return "completed";
      },
    })).rejects.toThrow("crash before Box DELETE");
    expect(events).toEqual(["requesting", "failure"]);
  });

  it("backs off and makes a known-negative Box rejection safely retryable", async () => {
    const events: string[] = [];
    const retryAfter = new Date(10_000).toISOString();
    await expect(processCompanionV2PurgeTargets({
      targets: [{
        kind: "box",
        key: "bx_retryable",
        evidence: ["provider-id:box"],
        state: "discovered",
        retryAfter,
      }],
      journal: {
        async markRequesting() { events.push("requesting"); },
        async markComplete() {},
        async markFailure(_target, _message, disposition) {
          events.push(`failure:${disposition}`);
        },
      },
      providerPresent: () => true,
      pause: async (milliseconds) => { events.push(`pause:${milliseconds}`); },
      nowMs: () => 7_000,
      remove: async () => {
        throw new BoxRuntimeAdapterError({
          stableCode: "box_conflict",
          message: "The Box delete request was rejected",
          status: 409,
          retryable: true,
          outcomeUnknown: false,
        });
      },
    })).rejects.toMatchObject({ outcomeUnknown: false });
    expect(events).toEqual(["pause:3000", "requesting", "failure:retryable"]);
  });
});
