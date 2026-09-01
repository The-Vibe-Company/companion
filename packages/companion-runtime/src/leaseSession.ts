import { COMPANION_BUDGETS } from "@companion/contracts";

import type { RuntimeClock } from "./clock";
import { RuntimeHandoffError, RuntimeInvariantError, RuntimeShutdownError } from "./errors";
import {
  RUNTIME_LEASE_SECONDS,
  type RuntimeStore,
} from "./store";
import type {
  LeaseFence,
  RuntimeAuthorization,
  RuntimeCheckpointInput,
  RuntimeClaim,
  RuntimeObservationInput,
  RuntimeSettlementInput,
} from "./types";

export const RUNTIME_RENEW_INTERVAL_MS = COMPANION_BUDGETS.renewIntervalMs;

/**
 * Short retry cadence after a *transient* background renewal failure (a network/DB throw, not an
 * authoritative denial). The lease still has runway, so retry quickly rather than waiting a full
 * renew interval. Bounded by the renew interval so a slow lease never widens its own gap.
 */
export const RUNTIME_RENEW_RETRY_MS = 2_000;

/** Structured, PII-free description of a transient renewal failure for the process log. */
export interface LeaseRenewalErrorInfo {
  fence: LeaseFence;
  /** Consecutive transient failures in the current burst; resets on any success. */
  attempt: number;
  error: unknown;
}

export class LeaseFenceLostError extends Error {
  constructor() {
    super("Runtime lease fence was lost");
    this.name = "LeaseFenceLostError";
  }
}

export class LeaseAuthorizationDeniedError extends Error {
  constructor(readonly denialCode: string) {
    super("Runtime authorization was denied");
    this.name = "LeaseAuthorizationDeniedError";
  }
}

export class LeaseRenewalError extends Error {
  constructor() {
    super("Runtime lease could not be renewed");
    this.name = "LeaseRenewalError";
  }
}

export function claimFence(claim: RuntimeClaim, executorId: string): LeaseFence {
  return {
    orgId: claim.orgId,
    companionId: claim.companionId,
    claimToken: claim.claimToken,
    claimEpoch: claim.claimEpoch,
    gateEpoch: claim.gateEpoch,
    executorId,
    workKind: claim.workKind,
    workId: claim.workId,
  };
}

/** Serializes renewal and every fenced mutation for one claimed Companion. */
export class LeaseSession {
  readonly fence: LeaseFence;
  readonly #abortController = new AbortController();
  readonly #store: RuntimeStore;
  readonly #clock: RuntimeClock;
  readonly #renewIntervalMs: number;
  #sequence: bigint;
  #authorization: RuntimeAuthorization | null = null;
  #lastAuthorizedAuthorization: RuntimeAuthorization | null = null;
  #tail: Promise<void> = Promise.resolve();
  #timer: unknown;
  #running = false;
  #lost = false;
  #denialCode: string | null = null;
  #renewalFailed = false;
  #handoffRequested = false;
  #shutdownRequested = false;
  #lastRenewSuccessAt: Date | null = null;
  #renewFailureStreak = 0;
  readonly #onRenewalError: ((info: LeaseRenewalErrorInfo) => void) | undefined;

  constructor(input: {
    store: RuntimeStore;
    claim: RuntimeClaim;
    executorId: string;
    clock: RuntimeClock;
    renewIntervalMs?: number;
    /**
     * Notified when a background lease renewal fails transiently (before any short retry). The
     * composition layer wires this to the runtime process log; LeaseSession stays logger-free.
     */
    onRenewalError?: (info: LeaseRenewalErrorInfo) => void;
  }) {
    this.#store = input.store;
    this.#clock = input.clock;
    this.#renewIntervalMs = input.renewIntervalMs ?? RUNTIME_RENEW_INTERVAL_MS;
    this.#sequence = input.claim.checkpointSequence;
    this.fence = claimFence(input.claim, input.executorId);
    this.#onRenewalError = input.onRenewalError;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get sequence(): bigint {
    return this.#sequence;
  }

  get authorization(): RuntimeAuthorization | null {
    return this.#authorization;
  }

  /**
   * Last authority snapshot that proved this exact fenced item owned its Pi invocation. A denial
   * may redact provider identity, but terminal cleanup must still be able to stop work that was
   * already accepted without authorizing any new effect.
   */
  get cleanupAuthorization(): RuntimeAuthorization | null {
    return this.#authorization?.boxId ? this.#authorization : this.#lastAuthorizedAuthorization;
  }

  get lost(): boolean {
    return this.#lost;
  }

  get denialCode(): string | null {
    return this.#denialCode;
  }

  get renewalFailed(): boolean {
    return this.#renewalFailed;
  }

  get handoffRequested(): boolean {
    return this.#handoffRequested;
  }

  get shutdownRequested(): boolean {
    return this.#shutdownRequested;
  }

  async start(): Promise<RuntimeAuthorization> {
    if (this.#running) {
      if (!this.#authorization) throw new LeaseFenceLostError();
      return this.#authorization;
    }
    this.#running = true;
    const authorization = await this.#renewAuthorization(true);
    if (authorization.authorized) this.#scheduleRenewal();
    return authorization;
  }

  async reauthorize(): Promise<RuntimeAuthorization> {
    return await this.#renewAuthorization(false);
  }

  async #renewAuthorization(allowDenied: boolean): Promise<RuntimeAuthorization> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      let authorization: RuntimeAuthorization | null;
      try {
        authorization = await this.#store.renewAndAuthorize(this.fence, RUNTIME_LEASE_SECONDS);
      } catch {
        this.#renewalFailed = true;
        this.#abort(new LeaseRenewalError());
        throw new LeaseRenewalError();
      }
      if (!authorization) {
        this.#lost = true;
        this.#abort(new LeaseFenceLostError());
        throw new LeaseFenceLostError();
      }
      if (authorization.workCheckpointSequence < this.#sequence) {
        this.#renewalFailed = true;
        this.#abort(new LeaseRenewalError());
        throw new LeaseRenewalError();
      }
      this.#sequence = authorization.workCheckpointSequence;
      this.#authorization = authorization;
      if (authorization.authorized) this.#lastAuthorizedAuthorization = authorization;
      this.#lastRenewSuccessAt = this.#clock.now();
      this.#renewFailureStreak = 0;
      if (!authorization.authorized) {
        this.#denialCode = authorization.denialCode ?? "runtime_authorization_denied";
        this.#abort(new LeaseAuthorizationDeniedError(this.#denialCode));
        if (!allowDenied) throw new LeaseAuthorizationDeniedError(this.#denialCode);
      }
      return authorization;
    });
  }

  /**
   * Background renewal tick. Unlike the mandatory pre-effect {@link reauthorize}, a *transient*
   * store/network throw here is not authoritative: the lease keeps its remaining runway, so the
   * failure is reported to the caller to log and retry rather than abandoning the session.
   * Authoritative outcomes (fence lost, sequence regression, authorization denial) abort exactly as
   * {@link reauthorize} does and report `"stopped"`.
   */
  async #renewInBackground(): Promise<
    | { outcome: "authorized" }
    | { outcome: "transient"; error: unknown }
    | { outcome: "stopped" }
  > {
    return await this.#enqueue(async () => {
      if (
        this.#handoffRequested
        || this.#shutdownRequested
        || this.#lost
        || this.#denialCode
        || this.#renewalFailed
      ) return { outcome: "stopped" } as const;
      let authorization: RuntimeAuthorization | null;
      try {
        authorization = await this.#store.renewAndAuthorize(this.fence, RUNTIME_LEASE_SECONDS);
      } catch (error) {
        // Transient: do not set #renewalFailed or abort. The lease still has runway; the caller
        // decides whether to retry or, once runway is exhausted, fail closed.
        return { outcome: "transient", error } as const;
      }
      if (!authorization) {
        this.#lost = true;
        this.#abort(new LeaseFenceLostError());
        return { outcome: "stopped" } as const;
      }
      if (authorization.workCheckpointSequence < this.#sequence) {
        this.#renewalFailed = true;
        this.#abort(new LeaseRenewalError());
        return { outcome: "stopped" } as const;
      }
      this.#sequence = authorization.workCheckpointSequence;
      this.#authorization = authorization;
      if (authorization.authorized) this.#lastAuthorizedAuthorization = authorization;
      this.#lastRenewSuccessAt = this.#clock.now();
      if (!authorization.authorized) {
        this.#denialCode = authorization.denialCode ?? "runtime_authorization_denied";
        this.#abort(new LeaseAuthorizationDeniedError(this.#denialCode));
        return { outcome: "stopped" } as const;
      }
      return { outcome: "authorized" } as const;
    });
  }

  /** Immediate renewal/authorization is mandatory immediately before every external effect. */
  async external<T>(effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const authorization = await this.reauthorize();
    if (!authorization.authorized) {
      throw new LeaseAuthorizationDeniedError(
        authorization.denialCode ?? "runtime_authorization_denied",
      );
    }
    if (this.signal.aborted) throw this.signal.reason ?? new LeaseFenceLostError();
    return await effect(this.signal);
  }

  async checkpoint(
    input: Omit<RuntimeCheckpointInput, "expectedSequence">,
  ): Promise<bigint> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const sequence = await this.#store.checkpoint(this.fence, {
        ...input,
        expectedSequence: this.#sequence,
      });
      if (sequence === null) return this.#loseFence();
      this.#sequence = sequence;
      return sequence;
    });
  }

  async observe(
    input: Omit<RuntimeObservationInput, "expectedSequence">,
  ): Promise<bigint> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const sequence = await this.#store.observeInstance(this.fence, {
        ...input,
        expectedSequence: this.#sequence,
      });
      if (sequence === null) return this.#loseFence();
      this.#sequence = sequence;
      return sequence;
    });
  }

  /** Adopt the sequence returned by another narrow fenced definer, such as event projection. */
  async adoptExternalMutation<T>(
    mutation: (expectedSequence: bigint) => Promise<{ sequence: bigint; value: T } | null>,
  ): Promise<T> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const result = await mutation(this.#sequence);
      if (!result) return this.#loseFence();
      if (result.sequence <= this.#sequence) {
        this.#renewalFailed = true;
        this.#abort(new LeaseRenewalError());
        throw new LeaseRenewalError();
      }
      this.#sequence = result.sequence;
      return result.value;
    });
  }

  /** Serialize a child-ledger/material definer that does not advance the main work sequence. */
  async fencedMutation<T>(mutation: () => Promise<T | null>): Promise<T> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const result = await mutation();
      if (result === null) return this.#loseFence();
      return result;
    });
  }

  /**
   * Serialize a *read* through definers that re-authorize internally.
   *
   * `store.getMaterial` CROSS JOINs three such definers, so any single one declining collapses the
   * whole lookup to null. Unlike a fenced CAS write, that null is not proof the fence moved, and
   * treating it as one made the executor release, re-claim and decline again once per lease TTL —
   * forever, with no Box contact and no checkpoint. That is the shape that wedged a Companion's
   * main lane for hours on 2026-08-31 while its routine lane kept working, against the contract
   * that a turn "never appears to reply forever".
   *
   * Ask the lease itself instead of guessing: only a fence that really moved is a fence loss, a
   * denial is surfaced as a denial, and a live authorized fence that still cannot produce material
   * is terminal and actionable rather than something to spin on until a deadline kills it.
   */
  async fencedLookup<T>(lookup: () => Promise<T | null>): Promise<T> {
    return await this.#enqueue(async () => {
      this.#assertMutable();
      const result = await lookup();
      if (result !== null) return result;
      const authorization = await this.#store.renewAndAuthorize(this.fence, RUNTIME_LEASE_SECONDS);
      if (!authorization) return this.#loseFence();
      this.#authorization = authorization;
      if (!authorization.authorized) {
        throw new LeaseAuthorizationDeniedError(
          authorization.denialCode ?? "runtime_authorization_denied",
        );
      }
      throw new RuntimeInvariantError({
        code: "work_material_unavailable",
        message: "The runtime could not resolve the material for this work.",
        action: "retry",
      });
    });
  }

  async settle(input: RuntimeSettlementInput): Promise<boolean> {
    return await this.#enqueue(async () => {
      if (this.#handoffRequested) throw new RuntimeHandoffError();
      if (this.#lost) return false;
      const settled = await this.#store.settle(this.fence, input);
      if (!settled) {
        this.#lost = true;
        this.#abort(new LeaseFenceLostError());
      }
      this.stop();
      return settled;
    });
  }

  async release(): Promise<boolean> {
    return await this.#enqueue(async () => {
      if (this.#handoffRequested) throw new RuntimeHandoffError();
      if (this.#lost) return false;
      const released = await this.#store.release(this.fence);
      if (!released) this.#lost = true;
      this.stop();
      return released;
    });
  }

  async deferDelete(): Promise<boolean> {
    return await this.#enqueue(async () => {
      if (this.#handoffRequested) throw new RuntimeHandoffError();
      if (this.#lost) return false;
      const deferred = await this.#store.deferDelete(this.fence);
      if (!deferred) this.#lost = true;
      this.stop();
      return deferred;
    });
  }

  /** Stop local I/O and renewal without mutating the durable lease or work outcome. */
  requestHandoff(): void {
    if (this.#shutdownRequested) return;
    this.#handoffRequested = true;
    this.#abort(new RuntimeHandoffError());
    this.#clearRenewal();
  }

  /** Kill-switch interruption. The engine may still use the live DB fence to settle it. */
  requestShutdown(): void {
    this.#shutdownRequested = true;
    this.#handoffRequested = false;
    this.#abort(new RuntimeShutdownError());
    this.#clearRenewal();
  }

  stop(): void {
    this.#running = false;
    this.#clearRenewal();
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  #assertMutable(): void {
    if (this.#handoffRequested) throw new RuntimeHandoffError();
    if (this.#shutdownRequested) throw new RuntimeShutdownError();
    if (this.#lost) throw new LeaseFenceLostError();
    if (this.#denialCode) throw new LeaseAuthorizationDeniedError(this.#denialCode);
    if (this.#renewalFailed) throw new LeaseRenewalError();
  }

  #loseFence(): never {
    this.#lost = true;
    this.#abort(new LeaseFenceLostError());
    throw new LeaseFenceLostError();
  }

  #abort(reason: Error): void {
    if (!this.#abortController.signal.aborted) this.#abortController.abort(reason);
  }

  #scheduleRenewal(): void {
    if (
      !this.#running
      || this.#handoffRequested
      || this.#shutdownRequested
      || this.#lost
      || this.#denialCode
      || this.#renewalFailed
    ) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#runScheduledRenewal();
    }, this.#renewIntervalMs);
  }

  /**
   * One background renewal attempt. A success re-arms the normal cadence; a transient failure logs
   * and schedules a short retry while the lease has runway; an authoritative outcome has already
   * aborted the session, so the loop simply stops.
   */
  #runScheduledRenewal(): void {
    void this.#renewInBackground()
      .then((result) => {
        if (result.outcome === "authorized") {
          this.#renewFailureStreak = 0;
          this.#scheduleRenewal();
          return;
        }
        if (result.outcome === "transient") {
          this.#renewFailureStreak += 1;
          this.#onRenewalError?.({
            fence: this.fence,
            attempt: this.#renewFailureStreak,
            error: result.error,
          });
          this.#scheduleTransientRetry();
        }
        // "stopped": an authoritative outcome already aborted the session; never reschedule.
      })
      .catch(() => undefined);
  }

  /**
   * Reschedule a short retry after a transient renewal failure, but only while the lease still has
   * runway for another attempt to prove authority. Once the runway is spent, fail closed exactly as
   * an authoritative renewal failure — abort so the engine settles the turn deterministically rather
   * than leaving a silently dead heartbeat.
   */
  #scheduleTransientRetry(): void {
    if (
      !this.#running
      || this.#handoffRequested
      || this.#shutdownRequested
      || this.#lost
      || this.#denialCode
      || this.#renewalFailed
    ) return;
    const leaseMs = RUNTIME_LEASE_SECONDS * 1_000;
    const since = this.#lastRenewSuccessAt
      ? this.#clock.now().getTime() - this.#lastRenewSuccessAt.getTime()
      : leaseMs;
    const remaining = leaseMs - since;
    const retryMs = Math.min(RUNTIME_RENEW_RETRY_MS, this.#renewIntervalMs);
    if (remaining <= retryMs) {
      this.#renewalFailed = true;
      this.#abort(new LeaseRenewalError());
      return;
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#runScheduledRenewal();
    }, retryMs);
  }

  #clearRenewal(): void {
    if (this.#timer === undefined) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
