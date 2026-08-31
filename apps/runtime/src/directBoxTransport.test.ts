/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- The test harness conditionally installs timing seams so production defaults remain exercised by omission. */
import { describe, expect, it, vi } from "vitest";

import {
  CompanionBoxAgentRequestError,
  type CompanionPiBrokerState,
} from "@companion/box-runtime";
import { encryptOpaqueValue } from "@companion/core";
import type { RuntimeLogRecord, RuntimePiControl } from "@companion/companion-runtime";

import {
  createDirectBoxDataTransport,
  createDirectRuntimePiControl,
  decryptCompanionAgentEndpointTokens,
  DirectBoxEndpointRegistry,
  DIRECT_ENDPOINT_FRESHNESS_MS,
  DIRECT_SHADOW_COMPARE_INTERVAL_MS,
  DIRECT_SUSPECT_REPROBE_COOLDOWN_MS,
  type DirectAgentCalls,
  type DirectAgentEndpoint,
} from "./directBoxTransport";

const BOX_ID = "bx_abcdefgh";
const MARKER = "layout-14/full-marker";

function brokerState(overrides: Partial<CompanionPiBrokerState> = {}): CompanionPiBrokerState {
  return {
    invocationId: "inv-1",
    layoutMarker: MARKER,
    activeAttemptId: null,
    tailCursor: 5,
    acknowledgedCursor: 5,
    counters: {
      malformedLines: 0,
      oversizedLines: 0,
      unterminatedLines: 0,
      unknownEvents: 0,
      unboundEvents: 0,
      orphanResponses: 0,
    },
    modelInput: ["text"],
    ...overrides,
  };
}

function execBrokerState() {
  return {
    invocationId: "inv-exec",
    layoutMarker: MARKER,
    layoutCurrent: true,
    activeAttemptId: null,
    tailCursor: 5n,
    acknowledgedCursor: 5n,
    counters: brokerState().counters,
    modelInput: ["text" as const],
  };
}

function execControl(): RuntimePiControl {
  return {
    stopPiDaemon: vi.fn(async () => undefined),
    startPiDaemon: vi.fn(async () => ({ state: "idle" as const, invocationId: "inv-exec" })),
    restartPiDaemon: vi.fn(async () => ({ state: "idle" as const, invocationId: "inv-exec" })),
    piDaemonStatus: vi.fn(async () => ({ state: "idle" as const, invocationId: "inv-exec" })),
    brokerState: vi.fn(async () => execBrokerState()),
    prompt: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-exec", initialCursor: 0n })),
    abort: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-exec" })),
    readBrokerEvents: vi.fn(async () => ({
      events: [],
      nextCursor: 5,
      acknowledgedCursor: 5,
      hasMore: false,
    })),
    ackBrokerEvents: vi.fn(async () => 5n),
    respondExtensionUi: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-exec" })),
  };
}

function agentCalls(overrides: Partial<DirectAgentCalls> = {}): DirectAgentCalls {
  return {
    health: vi.fn(async () => ({
      agentVersion: 1,
      piUnit: "active",
      brokerSocketReady: true,
      layoutMarker: MARKER,
    })),
    brokerState: vi.fn(async () => brokerState()),
    readEvents: vi.fn(async () => ({
      events: [],
      nextCursor: 5,
      acknowledgedCursor: 5,
      hasMore: false,
    })),
    ackEvents: vi.fn(async () => ({ acknowledgedCursor: 5 })),
    ...overrides,
  };
}

function collectingLog() {
  const records: RuntimeLogRecord[] = [];
  return {
    records,
    log: {
      error: (record: RuntimeLogRecord) => records.push(record),
      warn: (record: RuntimeLogRecord) => records.push(record),
      info: (record: RuntimeLogRecord) => records.push(record),
    },
  };
}

function harness(input: {
  mode?: "on" | "shadow";
  calls?: DirectAgentCalls;
  nowMs?: () => number;
  register?: boolean;
  observedAt?: Date;
  dispatchResolutionMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const nowMs = input.nowMs ?? (() => 1_000_000);
  const registry = new DirectBoxEndpointRegistry({ now: nowMs });
  const endpoint: DirectAgentEndpoint = {
    hostedUrl: "https://abc-8790.on.ascii.dev/boxes/bx_abcdefgh",
    proxyToken: "proxy-token-1234567890",
    bearerToken: "bearer-token",
    observedAt: input.observedAt ?? new Date(nowMs()),
  };
  if (input.register !== false) registry.register(BOX_ID, endpoint);
  const exec = execControl();
  const calls = input.calls ?? agentCalls();
  const { records, log } = collectingLog();
  const facade = createDirectRuntimePiControl({
    mode: input.mode ?? "on",
    exec,
    registry,
    layoutFullMarker: MARKER,
    log,
    now: nowMs,
    clientFactory: () => calls,
    ...(input.dispatchResolutionMs === undefined
      ? {}
      : { dispatchResolutionMs: input.dispatchResolutionMs }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
  });
  return { facade, exec, calls, records, registry, endpoint };
}

const signal = new AbortController().signal;

describe("createDirectRuntimePiControl (on)", () => {
  it("serves brokerState direct, mapping cursors and layoutCurrent, without touching exec", async () => {
    const { facade, exec } = harness({});
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-1");
    expect(state.layoutCurrent).toBe(true);
    expect(state.tailCursor).toBe(5n);
    expect(exec.brokerState).not.toHaveBeenCalled();
  });

  it("falls back to exec without an endpoint, silently", async () => {
    const { facade, exec, records } = harness({ register: false });
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-exec");
    expect(exec.brokerState).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(0);
  });

  it("falls back to exec when the endpoint observation is older than the freshness bound", async () => {
    const { facade, exec, calls } = harness({
      observedAt: new Date(1_000_000 - DIRECT_ENDPOINT_FRESHNESS_MS - 1),
    });
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(exec.brokerState).toHaveBeenCalledTimes(1);
    expect(calls.brokerState).not.toHaveBeenCalled();
  });

  it("falls back per call on a direct failure, logging one expurgated event and marking suspect", async () => {
    const failing = agentCalls({
      readEvents: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_unreachable");
      }),
    });
    const { facade, exec, records, calls } = harness({ calls: failing });
    const page = await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(page).toEqual({ events: [], nextCursor: 5, acknowledgedCursor: 5, hasMore: false });
    expect(exec.readBrokerEvents).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.fallback",
        operation: "read_events",
        stableCode: "agent_unreachable",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("bearer-token");
    expect(JSON.stringify(records)).not.toContain("ascii.dev");

    // Suspect: the next non-probe call skips direct entirely.
    await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(calls.ackEvents).not.toHaveBeenCalled();
    expect(exec.ackBrokerEvents).toHaveBeenCalledTimes(1);
  });

  it("re-probes a suspect endpoint on brokerState only after the cooldown, then recovers", async () => {
    let nowMs = 1_000_000;
    const failing = vi.fn(async () => {
      throw new CompanionBoxAgentRequestError("agent_timeout");
    });
    const calls = agentCalls();
    calls.brokerState = failing;
    const { facade, exec } = harness({ calls, nowMs: () => nowMs });

    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(exec.brokerState).toHaveBeenCalledTimes(1);

    // Within the cooldown the probe stays on exec.
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(exec.brokerState).toHaveBeenCalledTimes(2);

    // After the cooldown the probe retries direct; success clears suspect for every call.
    nowMs += DIRECT_SUSPECT_REPROBE_COOLDOWN_MS;
    calls.brokerState = vi.fn(async () => brokerState());
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(exec.brokerState).toHaveBeenCalledTimes(2);
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(exec.readBrokerEvents).not.toHaveBeenCalled();
  });

  it("backs off repeated probes and preserves fallback state for the same durable endpoint", async () => {
    let nowMs = 1_000_000;
    const failing = vi.fn(async () => {
      throw new CompanionBoxAgentRequestError("agent_http_error", 500);
    });
    const calls = agentCalls({ brokerState: failing });
    const { facade, exec, records, registry, endpoint } = harness({ calls, nowMs: () => nowMs });

    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    nowMs += DIRECT_SUSPECT_REPROBE_COOLDOWN_MS;
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(2);

    // A later claim reading the same durable observation must not make it look healthy again.
    registry.register(BOX_ID, endpoint);
    nowMs += DIRECT_SUSPECT_REPROBE_COOLDOWN_MS;
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(exec.brokerState).toHaveBeenCalledTimes(3);

    // The second failure doubled the recovery interval; the next probe is due after 20 seconds.
    nowMs += DIRECT_SUSPECT_REPROBE_COOLDOWN_MS;
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(3);
    expect(records).toHaveLength(3);

    // A genuinely newer staging observation is allowed to probe immediately.
    registry.register(BOX_ID, { ...endpoint, observedAt: new Date(nowMs + 1) });
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(failing).toHaveBeenCalledTimes(4);
  });

  it("does not mark the endpoint suspect on a broker-relayed failure", async () => {
    const brokerDown = agentCalls({
      readEvents: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_broker_unavailable", 503);
      }),
    });
    const { facade, exec, records, calls } = harness({ calls: brokerDown });
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(records[0]).toMatchObject({ stableCode: "agent_broker_unavailable" });
    // Next call still tries direct: the broker being down does not indict the endpoint.
    await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(calls.ackEvents).toHaveBeenCalledTimes(1);
    expect(exec.readBrokerEvents).toHaveBeenCalledTimes(1);
  });

  it("acknowledges events direct and converts the cursor to bigint", async () => {
    const { facade, exec, calls } = harness({});
    const acknowledged = await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(acknowledged).toBe(5n);
    expect(calls.ackEvents).toHaveBeenCalledWith({ through: 5, signal });
    expect(exec.ackBrokerEvents).not.toHaveBeenCalled();
  });

  it("maps the daemon probe: inactive unit or unready socket is stopped, never inferred further", async () => {
    const stopped = agentCalls({
      health: vi.fn(async () => ({
        agentVersion: 1,
        piUnit: "inactive",
        brokerSocketReady: false,
        layoutMarker: null,
      })),
    });
    const { facade, exec } = harness({ calls: stopped });
    await expect(facade.pi.piDaemonStatus({ boxId: BOX_ID, signal }))
      .resolves.toEqual({ state: "stopped", invocationId: null });
    expect(exec.piDaemonStatus).not.toHaveBeenCalled();
  });

  it("maps the daemon probe through broker state: active attempt means running", async () => {
    const busy = agentCalls({
      brokerState: vi.fn(async () => brokerState({ activeAttemptId: "attempt-9" })),
    });
    const { facade } = harness({ calls: busy });
    await expect(facade.pi.piDaemonStatus({ boxId: BOX_ID, signal }))
      .resolves.toEqual({ state: "running", invocationId: "inv-1" });
  });

  it("falls back to the full exec probe when the direct health read fails", async () => {
    const failing = agentCalls({
      health: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_auth_failed", 401);
      }),
    });
    const { facade, exec, records } = harness({ calls: failing });
    await expect(facade.pi.piDaemonStatus({ boxId: BOX_ID, signal }))
      .resolves.toEqual({ state: "idle", invocationId: "inv-exec" });
    expect(exec.piDaemonStatus).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      operation: "pi_daemon_status",
      stableCode: "agent_auth_failed",
    });
  });

  it("propagates a caller abort instead of falling back", async () => {
    const controller = new AbortController();
    const reason = new Error("kill switch");
    const aborting = agentCalls({
      readEvents: vi.fn(async () => {
        controller.abort(reason);
        throw new CompanionBoxAgentRequestError("agent_timeout");
      }),
    });
    const { facade, exec, records } = harness({ calls: aborting });
    await expect(facade.pi.readBrokerEvents({
      boxId: BOX_ID,
      after: 5n,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(exec.readBrokerEvents).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it("answers a zero poll interval only while events are served direct", async () => {
    const flaky = agentCalls();
    const { facade } = harness({ calls: flaky });
    expect(facade.eventPollIntervalMs({ boxId: BOX_ID })).toBe(500);
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(facade.eventPollIntervalMs({ boxId: BOX_ID })).toBe(0);
    flaky.readEvents = vi.fn(async () => {
      throw new CompanionBoxAgentRequestError("agent_unreachable");
    });
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    expect(facade.eventPollIntervalMs({ boxId: BOX_ID })).toBe(500);
  });

  it("routes prompt, abort, and decision direct while lifecycle calls stay on exec", async () => {
    const calls = agentCalls({
      prompt: vi.fn(async () => ({
        outcome: "accepted" as const,
        invocationId: "inv-1",
        initialCursor: 5,
      })),
      abort: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-1" })),
      decision: vi.fn(async () => ({ outcome: "accepted" as const, invocationId: "inv-1" })),
    });
    const { facade, exec } = harness({ calls });
    await expect(facade.pi.prompt({
      boxId: BOX_ID,
      commandId: "c1",
      attemptId: "a1",
      expectedInvocationId: "inv-1",
      message: "hello",
      signal,
    })).resolves.toEqual({ outcome: "accepted", invocationId: "inv-1", initialCursor: 5n });
    await facade.pi.abort({ boxId: BOX_ID, commandId: "c2", attemptId: "a1", signal });
    await facade.pi.respondExtensionUi({
      boxId: BOX_ID,
      commandId: "c3",
      attemptId: "a1",
      response: {},
      signal,
    });
    await facade.pi.startPiDaemon({ boxId: BOX_ID, signal });
    expect(exec.prompt).not.toHaveBeenCalled();
    expect(exec.abort).not.toHaveBeenCalled();
    expect(exec.respondExtensionUi).not.toHaveBeenCalled();
    expect(exec.startPiDaemon).toHaveBeenCalledTimes(1);
    expect(calls.prompt).toHaveBeenCalledTimes(1);
    expect(calls.abort).toHaveBeenCalledTimes(1);
    expect(calls.decision).toHaveBeenCalledTimes(1);
  });

  it("keeps failed direct abort and decision writes ambiguous without exec replay", async () => {
    const failedAbort = agentCalls({
      abort: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_unreachable");
      }),
    });
    const first = harness({ calls: failedAbort });
    await expect(first.facade.pi.abort({
      boxId: BOX_ID,
      commandId: "abort-1",
      attemptId: "attempt-1",
      signal,
    })).resolves.toEqual({ outcome: "ambiguous", code: "pi_ack_ambiguous" });
    expect(first.exec.abort).not.toHaveBeenCalled();
    expect(first.registry.isSuspect(BOX_ID)).toBe(true);

    const failedDecision = agentCalls({
      decision: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_timeout");
      }),
    });
    const second = harness({ calls: failedDecision });
    await expect(second.facade.pi.respondExtensionUi({
      boxId: BOX_ID,
      commandId: "decision-1",
      attemptId: "attempt-1",
      response: {},
      signal,
    })).resolves.toEqual({ outcome: "ambiguous", code: "decision_delivery_ambiguous" });
    expect(second.exec.respondExtensionUi).not.toHaveBeenCalled();
    expect(second.registry.isSuspect(BOX_ID)).toBe(true);
  });

  it("resolves a lost prompt response from the durable broker ledger without exec replay", async () => {
    const calls = agentCalls({
      prompt: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_timeout");
      }),
      dispatchStatus: vi.fn(async () => ({
        status: "accepted" as const,
        dispatch: {
          outcome: "accepted" as const,
          invocationId: "inv-1",
          initialCursor: 9,
        },
      })),
    });
    const { facade, exec } = harness({ calls });
    await expect(facade.pi.prompt({
      boxId: BOX_ID,
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
      signal,
    })).resolves.toEqual({ outcome: "accepted", invocationId: "inv-1", initialCursor: 9n });
    expect(calls.dispatchStatus).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "command-1",
      attemptId: "attempt-1",
    }));
    expect(exec.prompt).not.toHaveBeenCalled();
  });

  it("repeats only the same idempotent prompt command when the ledger first reports absent", async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce({ outcome: "ambiguous", code: "pi_ack_ambiguous" })
      .mockResolvedValueOnce({ outcome: "accepted", invocationId: "inv-1", initialCursor: 11 });
    const calls = agentCalls({
      prompt,
      dispatchStatus: vi.fn(async () => ({ status: "absent" as const })),
    });
    const { facade, exec } = harness({ calls });
    const input = {
      boxId: BOX_ID,
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
      signal,
    };
    await expect(facade.pi.prompt(input)).resolves.toMatchObject({ outcome: "accepted" });
    expect(prompt).toHaveBeenNthCalledWith(1, input);
    expect(prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      boxId: BOX_ID,
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
      signal: expect.any(AbortSignal),
    }));
    expect(exec.prompt).not.toHaveBeenCalled();
  });

  it("aborts a stalled ledger lookup at the prompt-resolution deadline", async () => {
    const calls = agentCalls({
      prompt: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_timeout");
      }),
      dispatchStatus: vi.fn(async (input) => await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      })),
    });
    const { facade, exec } = harness({
      calls,
      nowMs: Date.now,
      dispatchResolutionMs: 50,
    });
    const started = Date.now();
    await expect(facade.pi.prompt({
      boxId: BOX_ID,
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
      signal,
    })).resolves.toEqual({ outcome: "ambiguous", code: "prompt_dispatch_unresolved" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exec.prompt).not.toHaveBeenCalled();
  });

  it("returns an explicit ambiguity after bounded prompt resolution and never falls back to exec", async () => {
    let nowMs = 1_000_000;
    const calls = agentCalls({
      prompt: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_timeout");
      }),
      dispatchStatus: vi.fn(async () => ({ status: "absent" as const })),
    });
    const { facade, exec } = harness({
      calls,
      nowMs: () => nowMs,
      dispatchResolutionMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
    });
    await expect(facade.pi.prompt({
      boxId: BOX_ID,
      commandId: "command-1",
      attemptId: "attempt-1",
      expectedInvocationId: "inv-1",
      message: "hello",
      signal,
    })).resolves.toEqual({ outcome: "ambiguous", code: "prompt_dispatch_unresolved" });
    expect(exec.prompt).not.toHaveBeenCalled();
  });

  it("never replays a lost prompt onto a replacement Pi invocation", async () => {
    let nowMs = 1_000_000;
    const prompt = vi.fn()
      .mockResolvedValueOnce({ outcome: "ambiguous", code: "pi_ack_ambiguous" })
      .mockResolvedValue({ outcome: "refused", code: "invocation_mismatch" });
    const calls = agentCalls({
      prompt,
      dispatchStatus: vi.fn(async () => ({ status: "absent" as const })),
    });
    const { facade, exec } = harness({
      calls,
      nowMs: () => nowMs,
      dispatchResolutionMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
    });
    const input = {
      boxId: BOX_ID,
      commandId: "command-stale-invocation",
      attemptId: "attempt-stale-invocation",
      expectedInvocationId: "inv-1",
      message: "Do not replay me",
      signal,
    };

    await expect(facade.pi.prompt(input)).resolves.toEqual({
      outcome: "ambiguous",
      code: "prompt_dispatch_unresolved",
    });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      expectedInvocationId: "inv-1",
    }));
    expect(exec.prompt).not.toHaveBeenCalled();
  });
});

describe("createDirectBoxDataTransport", () => {
  it("uses direct bytes on the hot path and falls back per idempotent file operation", async () => {
    const registry = new DirectBoxEndpointRegistry({ now: () => 1_000_000 });
    registry.register(BOX_ID, {
      hostedUrl: "https://agent.invalid",
      proxyToken: "proxy-token-1234567890",
      bearerToken: "bearer-token",
      observedAt: new Date(1_000_000),
    });
    const directFiles = vi.fn(async () => [{
      position: 0,
      filename: "notes.txt",
      contentType: "text/plain",
      byteSize: 5,
      path: "~/attachments/message/0-notes.txt",
    }]);
    const calls = agentCalls({ stageAttachments: directFiles });
    const exec = {
      stageAttachments: vi.fn(async () => []),
      clearOutbox: vi.fn(async () => undefined),
      listOutbox: vi.fn(async () => []),
      readOutboxFile: vi.fn(async (input) => ({ entry: input.entry, bytes: Buffer.alloc(0) })),
    };
    const transport = createDirectBoxDataTransport({
      exec: () => exec,
      registry,
      clientFactory: () => calls,
    });
    const files = [{ position: 0, filename: "notes.txt", contentType: "text/plain", bytes: Buffer.from("hello") }];
    await transport.stageAttachments({ boxId: BOX_ID, messageId: "message", files, signal });
    expect(directFiles).toHaveBeenCalledWith({ messageId: "message", files, signal });
    expect(exec.stageAttachments).not.toHaveBeenCalled();

    calls.listOutbox = vi.fn(async () => {
      throw new CompanionBoxAgentRequestError("agent_unreachable");
    });
    await transport.listOutbox({ boxId: BOX_ID, signal });
    expect(exec.listOutbox).toHaveBeenCalledTimes(1);
  });

  it("forwards the absolute outbox deadline to the direct client", async () => {
    const registry = new DirectBoxEndpointRegistry({ now: () => 1_000_000 });
    registry.register(BOX_ID, {
      hostedUrl: "https://agent.invalid",
      proxyToken: "proxy-token-1234567890",
      bearerToken: "bearer-token",
      observedAt: new Date(1_000_000),
    });
    const listOutbox = vi.fn(async () => []);
    const readOutboxFile = vi.fn(async (input) => ({ entry: input.entry, bytes: Buffer.alloc(0) }));
    const exec = {
      stageAttachments: vi.fn(async () => []),
      clearOutbox: vi.fn(async () => undefined),
      listOutbox: vi.fn(async () => []),
      readOutboxFile: vi.fn(async (input) => ({ entry: input.entry, bytes: Buffer.alloc(0) })),
    };
    const transport = createDirectBoxDataTransport({
      exec: () => exec,
      registry,
      clientFactory: () => agentCalls({ listOutbox, readOutboxFile }),
    });
    const deadlineAt = new Date(1_030_000);
    const entry = { name: "answer.png", encodedName: "YW5zd2VyLnBuZw==", byteSize: 0, sha256: "0".repeat(64) };
    await transport.listOutbox({ boxId: BOX_ID, deadlineAt, signal });
    await transport.readOutboxFile({ boxId: BOX_ID, entry, deadlineAt, signal });
    expect(listOutbox).toHaveBeenCalledWith({ deadlineAt, signal });
    expect(readOutboxFile).toHaveBeenCalledWith({ entry, deadlineAt, signal });
    expect(exec.listOutbox).not.toHaveBeenCalled();
    expect(exec.readOutboxFile).not.toHaveBeenCalled();
  });
});

describe("createDirectRuntimePiControl (shadow)", () => {
  async function flushShadow(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("returns the exec result, logs one throttled comparison, and routes nothing direct", async () => {
    let nowMs = 1_000_000;
    const calls = agentCalls({
      brokerState: vi.fn(async () => brokerState({ invocationId: "inv-exec" })),
    });
    const { facade, exec, records } = harness({ mode: "shadow", calls, nowMs: () => nowMs });
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-exec");
    await flushShadow();
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.shadow",
        match: true,
        latencyDirectMs: expect.any(Number),
        latencyExecMs: expect.any(Number),
      }),
    ]);

    // Throttled: a second probe inside the interval does not shadow again.
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    await flushShadow();
    expect(records).toHaveLength(1);
    expect(calls.brokerState).toHaveBeenCalledTimes(1);

    nowMs += DIRECT_SHADOW_COMPARE_INTERVAL_MS;
    await facade.pi.brokerState({ boxId: BOX_ID, signal });
    await flushShadow();
    expect(records).toHaveLength(2);

    // Events and acks stay pure exec in shadow mode.
    await facade.pi.readBrokerEvents({ boxId: BOX_ID, after: 5n, signal });
    await facade.pi.ackBrokerEvents({ boxId: BOX_ID, through: 5n, signal });
    expect(exec.readBrokerEvents).toHaveBeenCalledTimes(1);
    expect(exec.ackBrokerEvents).toHaveBeenCalledTimes(1);
    expect(calls.readEvents).not.toHaveBeenCalled();
    expect(calls.ackEvents).not.toHaveBeenCalled();
  });

  it("logs a mismatching or failing shadow comparison without affecting the caller", async () => {
    const failing = agentCalls({
      health: vi.fn(async () => {
        throw new CompanionBoxAgentRequestError("agent_unreachable");
      }),
    });
    const { facade, records } = harness({ mode: "shadow", calls: failing });
    const state = await facade.pi.brokerState({ boxId: BOX_ID, signal });
    expect(state.invocationId).toBe("inv-exec");
    await flushShadow();
    expect(records).toEqual([
      expect.objectContaining({
        event: "runtime.direct_transport.shadow",
        match: false,
        stableCode: "agent_unreachable",
      }),
    ]);
  });
});

describe("DirectBoxEndpointRegistry", () => {
  it("keeps the newest observation and drops suspect state on re-registration", () => {
    const registry = new DirectBoxEndpointRegistry({ now: () => 1_000_000 });
    const older: DirectAgentEndpoint = {
      hostedUrl: "https://old.invalid",
      proxyToken: "proxy-old-1234567890",
      bearerToken: "bearer-old",
      observedAt: new Date(500_000),
    };
    const newer: DirectAgentEndpoint = { ...older, hostedUrl: "https://new.invalid", observedAt: new Date(900_000) };
    registry.register(BOX_ID, newer);
    registry.markSuspect(BOX_ID);
    registry.register(BOX_ID, older);
    expect(registry.lookup(BOX_ID)?.hostedUrl).toBe("https://new.invalid");
    expect(registry.isSuspect(BOX_ID)).toBe(true);
    registry.register(BOX_ID, { ...newer, observedAt: new Date(950_000) });
    expect(registry.isSuspect(BOX_ID)).toBe(false);
  });
});

describe("decryptCompanionAgentEndpointTokens", () => {
  const masterKey = Buffer.alloc(32, 7);
  const orgId = "11111111-1111-4111-8111-111111111111";
  const companionId = "22222222-2222-4222-8222-222222222222";

  function ciphertext(value: string, subjectId = companionId): string {
    return JSON.stringify(encryptOpaqueValue(
      { orgId, purpose: "companion_box_agent_endpoint", subjectId, value },
      masterKey,
    ));
  }

  it("round-trips the tokens the material pipeline encrypted", () => {
    const tokenCiphertext = ciphertext(JSON.stringify({
      proxyToken: "proxy-token-1234567890",
      bearerToken: "bearer-token",
    }));
    expect(decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext,
      masterKey,
    })).toEqual({ proxyToken: "proxy-token-1234567890", bearerToken: "bearer-token" });
  });

  it("fails closed on a cross-companion ciphertext", () => {
    const tokenCiphertext = ciphertext(
      JSON.stringify({ proxyToken: "proxy-token-1234567890", bearerToken: "bearer-token" }),
      "33333333-3333-4333-8333-333333333333",
    );
    expect(() => decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext,
      masterKey,
    })).toThrow();
  });

  it.each([
    ["not-json", "not json"],
    ["missing tokens", "{}"],
  ])("fails closed on %s plaintext", (_label, plaintext) => {
    const tokenCiphertext = ciphertext(plaintext === "not json" ? "###" : plaintext);
    expect(() => decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext,
      masterKey,
    })).toThrow();
  });

  it("fails closed on a malformed envelope", () => {
    expect(() => decryptCompanionAgentEndpointTokens({
      orgId,
      companionId,
      tokenCiphertext: "{\"ciphertext\":42}",
      masterKey,
    })).toThrow();
  });
});
