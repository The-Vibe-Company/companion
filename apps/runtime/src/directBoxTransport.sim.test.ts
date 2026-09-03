/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Simulator contract fixtures narrow live HTTP bodies and broker pages the same way the adapter contract test does. */
/**
 * Direct transport against the deterministic Box/Pi simulator: full dispatch→consume→settle and
 * bounded file cycles travel over the hosted agent listener, with safe per-call exec fallback under
 * injected faults. The provider command counter proves the hot path no longer shells through exec.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  type CompanionPiBrokerEventPage,
} from "@companion/box-runtime";
import { createBoxSimServer, type BoxSimServerHandle } from "@companion/box-sim/server";

import type { RuntimeLogRecord } from "@companion/companion-runtime/runtime-support";

import { createRuntimePiControl } from "./boxAdapters";
import {
  createDirectBoxDataTransport,
  createDirectRuntimePiControl,
  DIRECT_SUSPECT_REPROBE_COOLDOWN_MS,
  DirectBoxEndpointRegistry,
} from "./directBoxTransport";

const openServers: BoxSimServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function provision() {
  const apiKey = "box_direct_transport_kernel";
  const companionId = "55555555-5555-4555-8555-555555555555";
  const server = createBoxSimServer({ apiKey, agentPort: 0 });
  await server.listen();
  openServers.push(server);
  const env = {
    COMPANION_BOX_API_KEY: apiKey,
    COMPANION_BOX_API_BASE: server.baseUrl,
    COMPANION_BOX_POLL_INTERVAL_MS: "1",
    COMPANION_BOX_READY_TIMEOUT_MS: "5000",
    COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
    COMPANION_DIRECT_TRANSPORT: "on",
  };
  const lifecycle = new AsciiBoxMaintenanceClient(env);
  const runtime = new AsciiBoxCompanionRuntime(env);
  const deadlineAt = Date.now() + 10_000;
  const created = await lifecycle.createOrRecoverGenerationBox({
    companionId,
    generation: 1,
    ttlSeconds: 21_600,
    deadlineAt,
  });
  const boxId = created.boxId;
  await lifecycle.applyGenerationBoxSettings({
    boxId,
    companionId,
    generation: 1,
    ttlSeconds: 21_600,
    deadlineAt,
  });
  for (;;) {
    const status = await fetch(`${server.baseUrl}/boxes/${boxId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await status.json() as { box?: { state?: string } };
    if (["ready", "running", "idle"].includes(body.box?.state ?? "")) break;
    if (Date.now() >= deadlineAt) throw new Error("simulated Box did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const staged = await runtime.stageExistingBox({
    companionId,
    runtimeGeneration: 1,
    orgId: "22222222-2222-4222-8222-222222222222",
    boxId,
    clientSurface: "web",
    providerAuth: { anthropic: { type: "api_key", key: "simulator-only" } },
    replaceProviderAuth: true,
    modelId: "simulated-model",
    mcpCredentials: [],
    mcpAccounts: [],
    skills: [],
  });
  await runtime.startPiDaemon({ boxId });
  const endpoint = staged.agentEndpoint;
  if (!endpoint) throw new Error("staging returned no agent endpoint with direct transport on");

  let clockOffsetMs = 0;
  const now = () => Date.now() + clockOffsetMs;
  const registry = new DirectBoxEndpointRegistry({ now });
  registry.register(boxId, { ...endpoint, observedAt: new Date(now()) });
  const records: RuntimeLogRecord[] = [];
  const log = {
    error: (record: RuntimeLogRecord) => records.push(record),
    warn: (record: RuntimeLogRecord) => records.push(record),
    info: (record: RuntimeLogRecord) => records.push(record),
  };
  const exec = createRuntimePiControl({ lifecycle, runtime: () => runtime });
  const facade = createDirectRuntimePiControl({
    mode: "on",
    exec,
    registry,
    layoutFullMarker: runtime.layoutIdentity().fullMarker,
    log,
    now,
  });
  const files = createDirectBoxDataTransport({
    exec: () => runtime,
    registry,
    log,
    now,
  });
  const execCommandCount = () => server.simulator.snapshot().requests
    .filter((request) => request.method === "POST" && request.path.endsWith("/commands"))
    .length;
  return {
    server,
    boxId,
    endpoint,
    registry,
    facade,
    files,
    records,
    execCommandCount,
    advanceClock: (ms: number) => {
      clockOffsetMs += ms;
    },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function consumeUntilSettled(input: {
  facade: Awaited<ReturnType<typeof provision>>["facade"];
  boxId: string;
  after: number;
  /** Skip acknowledgements to keep the journal readable from cursor 0 for later fault steps. */
  ack?: boolean;
}): Promise<number> {
  let cursor = input.after;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const page = await input.facade.pi.readBrokerEvents({
      boxId: input.boxId,
      after: BigInt(cursor),
      signal: signal(),
    }) as CompanionPiBrokerEventPage;
    cursor = page.nextCursor;
    if (input.ack !== false) {
      await input.facade.pi.ackBrokerEvents({
        boxId: input.boxId,
        through: BigInt(cursor),
        signal: signal(),
      });
    }
    if (page.events.some((record) =>
      record.kind === "pi_event" && record.event.type === "agent_settled")) {
      return cursor;
    }
  }
  throw new Error("the simulated turn did not settle within the consume budget");
}

describe("direct transport against the Box simulator", () => {
  it("runs a full turn over the hosted agent with zero exec broker commands", async () => {
    const { facade, boxId, execCommandCount } = await provision();

    // The direct probe answers with layout parity and idle broker state.
    const idle = await facade.pi.brokerState({ boxId, signal: signal() });
    expect(idle.layoutCurrent).toBe(true);
    expect(idle.activeAttemptId).toBeNull();

    await expect(facade.pi.piDaemonStatus({ boxId, signal: signal() })).resolves.toMatchObject({
      state: "idle",
      invocationId: "00000000000000000000000000000001",
    });

    const beforeDispatch = execCommandCount();
    await expect(facade.pi.prompt({
      boxId,
      commandId: "dispatch-direct-1",
      attemptId: "attempt-direct-1",
      expectedInvocationId: "00000000000000000000000000000001",
      message: "Hello over the direct event channel.",
      signal: signal(),
    })).resolves.toMatchObject({ outcome: "accepted" });
    const afterDispatch = execCommandCount();
    expect(afterDispatch).toBe(beforeDispatch);

    // Consume the whole turn over the direct channel: events arrive via long-poll and the exec
    // command counter must not move — this is the 500 ms polling the direct path retires.
    const settledCursor = await consumeUntilSettled({ facade, boxId, after: 0 });
    expect(settledCursor).toBeGreaterThan(0);
    expect(execCommandCount()).toBe(afterDispatch);
    expect(facade.eventPollIntervalMs({ boxId })).toBe(0);

    const settledState = await facade.pi.brokerState({ boxId, signal: signal() });
    expect(settledState.activeAttemptId).toBeNull();
    expect(settledState.acknowledgedCursor).toBe(BigInt(settledCursor));
    expect(execCommandCount()).toBe(afterDispatch);
  }, 30_000);

  it("resolves a response lost after Pi accepted the prompt from the same command ledger", async () => {
    const { server, facade, boxId, execCommandCount } = await provision();
    server.simulator.addFault({
      point: "agent.prompt.after",
      action: { kind: "disconnect" },
    });
    const before = execCommandCount();
    await expect(facade.pi.prompt({
      boxId,
      commandId: "dispatch-lost-response-1",
      attemptId: "attempt-lost-response-1",
      expectedInvocationId: "00000000000000000000000000000001",
      message: "Accept once, resolve durably.",
      signal: signal(),
    })).resolves.toMatchObject({ outcome: "accepted" });
    expect(execCommandCount()).toBe(before);
    await expect(facade.pi.resolvePrompt?.({
      boxId,
      commandId: "dispatch-lost-response-1",
      attemptId: "attempt-lost-response-1",
      expectedInvocationId: "00000000000000000000000000000001",
      message: "Accept once, resolve durably.",
      signal: signal(),
    })).resolves.toMatchObject({ outcome: "accepted" });
  }, 30_000);

  it("stages attachments and harvests the outbox direct without base64 exec chunks", async () => {
    const { server, files, boxId, execCommandCount } = await provision();
    const messageId = "11111111-1111-4111-8111-111111111111";
    const before = execCommandCount();
    await expect(files.stageAttachments({
      boxId,
      messageId,
      files: [{
        position: 0,
        filename: "notes.txt",
        contentType: "text/plain",
        bytes: Buffer.from("direct attachment"),
      }],
      signal: signal(),
    })).resolves.toMatchObject([{
      path: `~/attachments/${messageId}/0-notes.txt`,
    }]);
    const machine = server.simulator.commandMachine(boxId);
    expect(machine.persistentFiles.get(`attachments/${messageId}/0-notes.txt`)?.toString("utf8"))
      .toBe("direct attachment");

    machine.persistentFiles.set("outbox/answer.txt", Buffer.from("direct answer"));
    const entries = await files.listOutbox({ boxId, signal: signal() });
    expect(entries).toHaveLength(1);
    await expect(files.readOutboxFile({ boxId, entry: entries[0]!, signal: signal() }))
      .resolves.toMatchObject({ bytes: Buffer.from("direct answer") });
    await files.clearOutbox({ boxId, signal: signal() });
    await expect(files.listOutbox({ boxId, signal: signal() })).resolves.toEqual([]);
    expect(execCommandCount()).toBe(before);
  }, 30_000);

  it("falls back per call when the agent drops, then recovers on the next state probe", async () => {
    const { server, facade, boxId, records, execCommandCount, advanceClock } = await provision();
    // Seed the journal with one settled turn so no read below has to ride out an empty long-poll.
    await facade.pi.prompt({
      boxId,
      commandId: "dispatch-fault-1",
      attemptId: "attempt-fault-1",
      expectedInvocationId: "00000000000000000000000000000001",
      message: "Seed events before the fault.",
      signal: signal(),
    });
    await consumeUntilSettled({ facade, boxId, after: 0, ack: false });
    records.length = 0;

    // One dropped connection: the read falls back to exec, logs once, and the turn keeps moving.
    server.simulator.addFault({
      point: "agent.disconnect",
      action: { kind: "disconnect" },
    });
    const beforeFault = execCommandCount();
    const page = await facade.pi.readBrokerEvents({
      boxId,
      after: 0n,
      signal: signal(),
    }) as CompanionPiBrokerEventPage;
    expect(page.nextCursor).toBeGreaterThan(0);
    expect(execCommandCount()).toBeGreaterThan(beforeFault);
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.fallback",
        operation: "read_events",
        stableCode: "agent_unreachable",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("_token");
    expect(facade.eventPollIntervalMs({ boxId })).toBe(500);

    // Suspect: acks skip direct until the next brokerState probe clears it after the cooldown.
    const beforeAck = execCommandCount();
    await facade.pi.ackBrokerEvents({ boxId, through: 0n, signal: signal() });
    expect(execCommandCount()).toBeGreaterThan(beforeAck);

    advanceClock(DIRECT_SUSPECT_REPROBE_COOLDOWN_MS);
    const recovered = await facade.pi.brokerState({ boxId, signal: signal() });
    expect(recovered.layoutCurrent).toBe(true);
    const beforeDirectAgain = execCommandCount();
    await facade.pi.readBrokerEvents({ boxId, after: 0n, signal: signal() });
    expect(execCommandCount()).toBe(beforeDirectAgain);
    expect(facade.eventPollIntervalMs({ boxId })).toBe(0);
  }, 30_000);

  it("falls back on an authentication failure without leaking the bearer", async () => {
    const { facade, boxId, endpoint, registry, records, execCommandCount } = await provision();
    registry.register(boxId, {
      ...endpoint,
      bearerToken: "0".repeat(64),
      observedAt: new Date(Date.now() + 1),
    });
    const before = execCommandCount();
    await facade.pi.readBrokerEvents({ boxId, after: 0n, signal: signal() });
    expect(execCommandCount()).toBeGreaterThan(before);
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.fallback",
        operation: "read_events",
        stableCode: "agent_auth_failed",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(endpoint.bearerToken);
  }, 30_000);

  it("lets the session signal cut a server-side long-poll immediately", async () => {
    const { facade, boxId } = await provision();
    const controller = new AbortController();
    const reason = new Error("lease fence lost");
    // No pending events: the agent holds this read open server-side for up to 20 s.
    const pending = facade.pi.readBrokerEvents({
      boxId,
      after: 0n,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 100);
    const startedAt = Date.now();
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);
});
