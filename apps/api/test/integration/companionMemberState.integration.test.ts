import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCompanionWithRuntime,
  enqueueCompanionTurn,
  getCompanionRuntimeView,
  listCompanionRuntimeViews,
  readCompanionThread,
  saveCompanionProvider,
  setCompanionWorkspaceShare,
  syncCompanionThread,
  updateCompanionMemberState,
} from "@companion/core";
import { schema, withTenantContext, type Db } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

/**
 * Member list preferences and unread watermarks remain Runtime v3 control-plane facts. These tests
 * use the current tenant boundary and never restore a retired transcript executor or delivery
 * watermark.
 */
describe("Runtime v3 Companion member state", () => {
  let fixture: IntegrationFixture;
  let alphaId: string;
  let betaId: string;
  const masterKey = Buffer.alloc(32, 51);

  async function asActor<T>(
    actor: TestActor,
    action: (database: Db) => Promise<T>,
  ): Promise<T> {
    return withTenantContext({ orgId: fixture.orgA, userId: actor.id }, action);
  }

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "integration-secret",
      masterKey,
      database: integrationDb,
    });

    const alpha = await asActor(fixture.developer, (database) => createCompanionWithRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Alpha",
      persona: "First",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }));
    const beta = await asActor(fixture.developer, (database) => createCompanionWithRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Beta",
      persona: "Second",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }));
    alphaId = alpha.id;
    betaId = beta.id;

    for (const companionId of [alphaId, betaId]) {
      await asActor(fixture.developer, (database) => setCompanionWorkspaceShare({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId,
        role: "viewer",
        database,
      }));
    }
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("keeps pin order stable per member and hide/unhide never deletes runtime state", async () => {
    const before = await asActor(fixture.developer, (database) => listCompanionRuntimeViews({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database,
    }));
    expect(before.map((companion) => companion.name)).toEqual(["Beta", "Alpha"]);

    await asActor(fixture.developer, (database) => updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: alphaId,
      patch: { pinned: true },
      database,
    }));
    await asActor(fixture.developer, (database) => updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: betaId,
      patch: { pinned: true },
      database,
    }));

    const ownerPinned = await asActor(fixture.developer, (database) => listCompanionRuntimeViews({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database,
    }));
    expect(ownerPinned.map((companion) => companion.id)).toEqual([alphaId, betaId]);

    await asActor(fixture.admin, (database) => updateCompanionMemberState({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: betaId,
      patch: { pinned: true },
      database,
    }));
    const viewerPinned = await asActor(fixture.admin, (database) => listCompanionRuntimeViews({
      actor: fixture.admin,
      orgId: fixture.orgA,
      database,
    }));
    expect(viewerPinned.map((companion) => companion.id)).toEqual([betaId, alphaId]);
    expect(viewerPinned.find((companion) => companion.id === alphaId)?.pinned).toBe(false);

    const provisionedIdentity = {
      boxId: "bx_23456789",
      invocationId: "pi-member-state-fixture",
    };
    await integrationDb
      .update(schema.companionV3Instances)
      .set({
        boxId: provisionedIdentity.boxId,
        piInvocationId: provisionedIdentity.invocationId,
        preparationCheckpoint: "prepared",
        boxReadyAt: new Date(),
        stagingCompletedAt: new Date(),
        preparedAt: new Date(),
        preparedDiskLayoutVersion: 14,
        preparedSkillsDigest: "a".repeat(64),
        preparedMaterialExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .where(and(
        eq(schema.companionV3Instances.orgId, fixture.orgA),
        eq(schema.companionV3Instances.companionId, alphaId),
      ));

    const hidden = await asActor(fixture.developer, (database) => updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: alphaId,
      patch: { hidden: true },
      database,
    }));
    expect(hidden.hidden).toBe(true);
    expect(hidden.runtime.box_id).toBe(provisionedIdentity.boxId);
    expect(await integrationDb.query.companionV3Instances.findFirst({
      where: and(
        eq(schema.companionV3Instances.orgId, fixture.orgA),
        eq(schema.companionV3Instances.companionId, alphaId),
      ),
    })).toMatchObject({
      boxId: provisionedIdentity.boxId,
      piInvocationId: provisionedIdentity.invocationId,
    });

    const unhidden = await asActor(fixture.developer, (database) => updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: alphaId,
      patch: { hidden: false },
      database,
    }));
    expect(unhidden.hidden).toBe(false);
    expect(unhidden.runtime.box_id).toBe(provisionedIdentity.boxId);
  });

  it("tracks unread independently for a Viewer and returns the previous read ordinal", async () => {
    const send = (content: string) => asActor(fixture.developer, async (database) => {
      const accepted = await enqueueCompanionTurn({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId: alphaId,
        clientMessageId: randomUUID(),
        content,
        clientSurface: "web",
        database,
      });
      await readCompanionThread({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId: alphaId,
        database,
      });
      return accepted;
    });

    await send("First message");
    const sender = await asActor(fixture.developer, (database) => getCompanionRuntimeView({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }));
    expect(sender.unread).toBe(false);

    const viewerBefore = await asActor(fixture.admin, (database) => getCompanionRuntimeView({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }));
    expect(viewerBefore.unread).toBe(true);

    const firstOpen = await asActor(fixture.admin, (database) => readCompanionThread({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }));
    expect(firstOpen.last_read_ordinal).toBeNull();
    expect((await asActor(fixture.admin, (database) => getCompanionRuntimeView({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }))).unread).toBe(false);

    await send("Second message");
    expect((await asActor(fixture.admin, (database) => getCompanionRuntimeView({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }))).unread).toBe(true);

    const backgroundSync = await asActor(fixture.admin, (database) => syncCompanionThread({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }));
    expect(backgroundSync.entries.at(-1)?.content).toBe("Second message");
    expect((await asActor(fixture.admin, (database) => getCompanionRuntimeView({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }))).unread).toBe(true);

    const secondOpen = await asActor(fixture.admin, (database) => readCompanionThread({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }));
    expect(secondOpen.last_read_ordinal).toBe(0);
    expect((await asActor(fixture.admin, (database) => getCompanionRuntimeView({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }))).unread).toBe(false);

    await asActor(fixture.admin, (database) => updateCompanionMemberState({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      patch: { unread: true },
      database,
    }));
    expect((await asActor(fixture.admin, (database) => getCompanionRuntimeView({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: alphaId,
      database,
    }))).unread).toBe(true);
  });
});
