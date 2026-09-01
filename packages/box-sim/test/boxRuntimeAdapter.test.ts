/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- Existing adapter contract fixtures predate the incremental anti-slop gate. */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  type CompanionPiBrokerEventPage,
} from "@companion/box-runtime";
import { createBoxSimServer, type BoxSimServerHandle } from "../src/server";

const openServers: BoxSimServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("production Box runtime v2 against the simulator", () => {
  it("stages GLM 5.3 Flash and completes a turn through the fake z.ai route", async () => {
    const harness = await provision({
      apiKey: "box_adapter_glm_flash",
      companionId: "99999999-9999-4999-8999-999999999999",
      generation: 1,
      providerId: "zai",
      modelId: "glm-5.3-flash",
    });
    const { boxId, runtime, server } = harness;
    const machine = server.simulator.commandMachine(boxId);
    expect(JSON.parse(machine.persistentFiles.get(".companion/pi/models.json")!.toString("utf8")))
      .toMatchObject({
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/coding/paas/v4",
            models: [{
              id: "glm-5.3-flash",
              input: ["text", "image"],
              contextWindow: 1_000_000,
              maxTokens: 131_072,
            }],
          },
        },
      });

    await expect(runtime.dispatchPrompt({
      boxId,
      attemptId: "attempt-glm-flash-1",
      requestId: "dispatch-glm-flash-1",
      message: "Reply through the simulated z.ai provider.",
    })).resolves.toMatchObject({ outcome: "accepted" });
    await waitForBrokerEvent(runtime, boxId, 0, "agent_settled");
    expect(machine.providerRequests).toEqual([{
      providerId: "zai",
      modelId: "glm-5.3-flash",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
    }]);
  });

  it("creates, stages, dispatches, and archives only through explicit narrow checkpoints", async () => {
    const harness = await provision({
      apiKey: "box_adapter_contract",
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
    });
    const { boxId, runtime, server } = harness;

    expect("start" in runtime).toBe(false);
    expect("healPiDaemon" in runtime).toBe(false);
    expect("captureDesktopFrame" in runtime).toBe(false);
    await expect(runtime.existingBoxStatus({ boxId })).resolves.toEqual({
      boxId,
      state: "ready",
    });
    await expect(runtime.piDaemonStatus({ boxId })).resolves.toMatchObject({
      state: "idle",
      invocationId: "00000000000000000000000000000001",
    });
    await expect(runtime.dispatchPrompt({
      boxId,
      attemptId: "attempt-contract-1",
      requestId: "dispatch-contract-1",
      message: "Hello from the adapter contract.",
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-contract-1",
      invocationId: "00000000000000000000000000000001",
      initialCursor: 0,
    });

    const settled = await waitForBrokerEvent(runtime, boxId, 0, "agent_settled");
    expect(settled.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: "response" }) }),
    ]));
    await expect(runtime.ackEvents({ boxId, through: settled.nextCursor })).resolves.toEqual({
      acknowledgedCursor: settled.nextCursor,
    });
    await expect(runtime.readEvents({ boxId, after: 0 })).resolves.toEqual({
      events: [],
      nextCursor: settled.nextCursor,
      acknowledgedCursor: settled.nextCursor,
      hasMore: false,
    });
    await runtime.refreshTtl({ boxId, ttlSeconds: 21_600 });
    await runtime.stopPiDaemon({ boxId });
    await expect(runtime.archiveExistingBox({ boxId })).resolves.toMatchObject({
      boxId,
      state: "archiving",
    });

    const [snapshot] = server.simulator.snapshot().boxes;
    expect(snapshot?.daemon.status).toBe("inactive");
    expect(snapshot?.name).toBe("Companion 11111111-1111-4111-8111-111111111111 g1");
    expect(snapshot?.daemon.unknownCommandDigests).toEqual([]);
  });

  it("terminates only the exact main Pi invocation and leaves a newer one untouched", async () => {
    const { boxId, runtime, server } = await provision({
      apiKey: "box_adapter_exact_termination",
      companionId: "12121212-1212-4212-8212-121212121212",
      generation: 1,
    });
    const machine = server.simulator.commandMachine(boxId);
    const invocationId = machine.daemon.invocationId!;

    await expect(runtime.terminatePiInvocation({
      boxId,
      expectedInvocationId: "ffffffffffffffffffffffffffffffff",
    })).resolves.toEqual({ outcome: "superseded" });
    expect(machine.daemon).toMatchObject({ status: "active", invocationId });

    await expect(runtime.terminatePiInvocation({
      boxId,
      expectedInvocationId: invocationId,
    })).resolves.toEqual({ outcome: "terminated" });
    expect(machine.daemon).toMatchObject({ status: "inactive", invocationId: null });

    await expect(runtime.terminatePiInvocation({
      boxId,
      expectedInvocationId: invocationId,
    })).resolves.toEqual({ outcome: "already_gone" });
    expect(machine.unknownCommandDigests).toEqual([]);
  });

  it("serves monotonic journal cursors and resumes one correlated ask_user decision", async () => {
    const harness = await provision({
      apiKey: "box_adapter_broker_contract",
      companionId: "33333333-3333-4333-8333-333333333333",
      generation: 7,
      piScenario: "ask_user",
    });
    const { boxId, runtime } = harness;

    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      invocationId: "00000000000000000000000000000001",
      layoutMarker: expect.any(String),
      activeAttemptId: null,
      tailCursor: 0,
      acknowledgedCursor: 0,
      modelInput: ["text", "image"],
      counters: {
        malformedLines: 0,
        oversizedLines: 0,
        unterminatedLines: 0,
        unknownEvents: 0,
        unboundEvents: 0,
        orphanResponses: 0,
      },
    });
    await expect(runtime.dispatchPrompt({
      boxId,
      attemptId: "attempt-journal-1",
      requestId: "dispatch-journal-1",
      message: "Ask before continuing.",
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-journal-1",
      invocationId: "00000000000000000000000000000001",
      initialCursor: 0,
    });

    const waiting = await waitForBrokerEvent(runtime, boxId, 0, "extension_ui_request");
    expect(waiting.events.map((event) => event.sequence)).toEqual(
      waiting.events.map((_, index) => index + 1),
    );
    expect(waiting.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        invocationId: "00000000000000000000000000000001",
        attemptId: "attempt-journal-1",
        kind: "pi_event",
      }),
    ]));
    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      activeAttemptId: "attempt-journal-1",
      tailCursor: waiting.nextCursor,
      acknowledgedCursor: 0,
    });

    const acknowledgedThrough = waiting.events[1]?.sequence ?? waiting.nextCursor;
    await expect(runtime.ackEvents({ boxId, through: acknowledgedThrough })).resolves.toEqual({
      acknowledgedCursor: acknowledgedThrough,
    });
    const afterAck = await runtime.readEvents({ boxId, after: 0 });
    expect(afterAck.events.every((event) => event.sequence > acknowledgedThrough)).toBe(true);

    const request = waiting.events.find((record) => (
      record.kind === "pi_event" && record.event.type === "extension_ui_request"
    ));
    const requestId = request?.kind === "pi_event" && typeof request.event.id === "string"
      ? request.event.id
      : null;
    if (!requestId) throw new Error("Pi simulator did not emit a correlated UI request");
    await expect(runtime.dispatchExtensionUi({
      boxId,
      attemptId: "attempt-journal-1",
      requestId: "decision-journal-1",
      response: { type: "extension_ui_response", id: requestId, value: "Continue" },
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-journal-1",
      invocationId: "00000000000000000000000000000001",
    });

    const settled = await waitForBrokerEvent(runtime, boxId, waiting.nextCursor, "agent_settled");
    await expect(runtime.brokerState({ boxId })).resolves.toMatchObject({
      activeAttemptId: null,
      tailCursor: settled.nextCursor,
      acknowledgedCursor: acknowledgedThrough,
    });
  });

  it("registers the hosted agent endpoint and stages its bearer digest when direct transport is on", async () => {
    const harness = await provision({
      apiKey: "box_adapter_direct_transport",
      companionId: "44444444-4444-4444-8444-444444444444",
      generation: 2,
      env: { COMPANION_DIRECT_TRANSPORT: "on" },
      agentPort: 0,
    });
    const { server, boxId, staged } = harness;

    const endpoint = staged.agentEndpoint;
    if (!endpoint) throw new Error("staging returned no agent endpoint with direct transport on");
    // The stored locator is token-free: both tokens are credentials and travel separately.
    expect(endpoint.hostedUrl).toBe(`${server.agentBaseUrl}/boxes/${boxId}`);
    expect(endpoint.hostedUrl).not.toContain("_token");
    expect(endpoint.proxyToken).toMatch(/^[a-f0-9]{64}$/);

    const machine = server.simulator.commandMachine(boxId);
    const authFile = machine.persistentFiles
      .get(".companion/runtime/state/agent-auth.json")?.toString("utf8");
    if (!authFile) throw new Error("staging left no agent auth digest on the Box");
    // Only the digest of the rotating bearer ever reaches the Box disk.
    expect(JSON.parse(authFile)).toEqual({
      tokenSha256: createHash("sha256").update(endpoint.bearerToken, "utf8").digest("hex"),
    });
    expect(authFile).not.toContain(endpoint.bearerToken);
    expect(machine.agentUnitEnabled).toBe(true);
    expect(machine.unknownCommandDigests).toEqual([]);
  });
});

async function provision(input: {
  apiKey: string;
  companionId: string;
  generation: number;
  piScenario?: string;
  env?: Record<string, string>;
  agentPort?: number;
  providerId?: string;
  modelId?: string;
}): Promise<{
  server: BoxSimServerHandle;
  runtime: AsciiBoxCompanionRuntime;
  boxId: string;
  staged: Awaited<ReturnType<AsciiBoxCompanionRuntime["stageExistingBox"]>>;
}> {
  const server = createBoxSimServer({
    apiKey: input.apiKey,
    ...(input.agentPort === undefined ? {} : { agentPort: input.agentPort }),
    ...(input.piScenario ? { defaults: { piScenario: input.piScenario } } : {}),
  });
  await server.listen();
  openServers.push(server);
  const env = {
    COMPANION_BOX_API_KEY: input.apiKey,
    COMPANION_BOX_API_BASE: server.baseUrl,
    COMPANION_BOX_POLL_INTERVAL_MS: "1",
    COMPANION_BOX_READY_TIMEOUT_MS: "5000",
    COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
    ...input.env,
  };
  const lifecycle = new AsciiBoxMaintenanceClient(env);
  const runtime = new AsciiBoxCompanionRuntime(env);
  const deadlineAt = Date.now() + 10_000;
  const created = await lifecycle.createOrRecoverGenerationBox({
    companionId: input.companionId,
    generation: input.generation,
    ttlSeconds: 21_600,
    deadlineAt,
  });
  const boxId = created.boxId;
  await lifecycle.applyGenerationBoxSettings({
    boxId,
    companionId: input.companionId,
    generation: input.generation,
    ttlSeconds: 21_600,
    deadlineAt,
  });
  for (;;) {
    const status = await fetch(`${server.baseUrl}/boxes/${boxId}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    const body = await status.json() as { box?: { state?: string } };
    if (["ready", "running", "idle"].includes(body.box?.state ?? "")) break;
    if (Date.now() >= deadlineAt) throw new Error("simulated Box did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const staged = await runtime.stageExistingBox({
    companionId: input.companionId,
    runtimeGeneration: input.generation,
    orgId: "22222222-2222-4222-8222-222222222222",
    boxId,
    clientSurface: "web",
    providerAuth: {
      [input.providerId ?? "anthropic"]: { type: "api_key", key: "simulator-only" },
    },
    replaceProviderAuth: true,
    modelId: input.modelId ?? "simulated-model",
    mcpCredentials: [],
    mcpAccounts: [],
    skills: [],
  });
  await runtime.startPiDaemon({ boxId });
  return { server, runtime, boxId, staged };
}

async function waitForBrokerEvent(
  runtime: AsciiBoxCompanionRuntime,
  boxId: string,
  after: number,
  eventType: string,
): Promise<CompanionPiBrokerEventPage> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await runtime.readEvents({ boxId, after });
    if (page.events.some((record) => (
      record.kind === "pi_event" && record.event.type === eventType
    ))) return page;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Pi simulator did not emit ${eventType} within the adapter contract deadline`);
}
