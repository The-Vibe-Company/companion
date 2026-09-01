export const RUNTIME_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type IdempotentObservationCall = "get_broker_state" | "read_events";

export type IdempotentLifecycleCall =
  | "list_boxes"
  | "get_status"
  | "resume_box"
  | "stop_box"
  | "restart_pi"
  | "start_pi"
  | "stop_pi"
  | "terminate_pi_invocation"
  | "apply_box_settings"
  | "apply_runtime_settings"
  | "request_delete"
  | "poll_delete"
  | "stage_attachments"
  | "clear_outbox"
  | "ack_events";

export type NonRetryableRuntimeCall = "create_box" | "prompt" | "decision";

export interface RetryClock {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface RetryableProviderError {
  retryable?: boolean;
  status?: number;
}

export function isRetryableProviderError(error: RetryableProviderError): boolean {
  if (error.retryable === true) return true;
  return error.status === 408
    || error.status === 425
    || error.status === 429
    || (error.status !== undefined && error.status >= 500);
}

function jittered(base: number, sample: number): number {
  const bounded = Math.min(1, Math.max(0, Number.isFinite(sample) ? sample : 0.5));
  return Math.max(1, Math.round(base * (0.8 + (bounded * 0.4))));
}

/**
 * Run once immediately, then at most five retries on a known-idempotent provider operation.
 * Create and broker writes cannot be represented by `IdempotentLifecycleCall`.
 *
 * Provider-state conflicts stay non-retryable by default. Observation-only calls may opt in because
 * a Box transition can briefly reject a read even though replaying that read has no external effect.
 */
interface IdempotentRetryInput<T, Call extends string> {
  call: Call;
  operation(signal: AbortSignal | undefined): Promise<T>;
  clock: RetryClock;
  jitter: () => number;
  deadlineAt?: Date;
  signal?: AbortSignal;
  beforeAttempt?: () => Promise<void>;
}

async function retryKnownIdempotentCall<T, Call extends string>(input: IdempotentRetryInput<T, Call> & {
  retryProviderStateConflict: boolean;
}): Promise<T> {
  let lastError: unknown;
  const assertBudget = (): void => {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Runtime retry aborted");
    if (input.deadlineAt && input.clock.now().getTime() >= input.deadlineAt.getTime()) {
      throw lastError ?? new Error("Runtime retry deadline elapsed");
    }
  };
  for (let attempt = 0; attempt <= RUNTIME_RETRY_DELAYS_MS.length; attempt += 1) {
    assertBudget();
    if (attempt > 0) {
      const delay = jittered(RUNTIME_RETRY_DELAYS_MS[attempt - 1]!, input.jitter());
      const remaining = input.deadlineAt
        ? input.deadlineAt.getTime() - input.clock.now().getTime()
        : Number.POSITIVE_INFINITY;
      if (remaining <= delay) throw lastError;
      await input.clock.sleep(delay, input.signal);
      assertBudget();
    }
    await input.beforeAttempt?.();
    // Hooks commonly renew authorization. They may consume the last deadline budget or abort the
    // active lease, so recheck both immediately before the provider operation.
    assertBudget();
    try {
      return await input.operation(input.signal);
    } catch (error) {
      lastError = error;
      // SAFETY: Object() always produces an object; the optional fields are read defensively.
      const providerError = Object(error) as RetryableProviderError;
      const retryable = isRetryableProviderError(providerError)
        || (input.retryProviderStateConflict === true && providerError.status === 409);
      if (!retryable
        || attempt === RUNTIME_RETRY_DELAYS_MS.length) {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function retryIdempotentLifecycle<T>(
  input: IdempotentRetryInput<T, IdempotentLifecycleCall>,
): Promise<T> {
  return await retryKnownIdempotentCall({ ...input, retryProviderStateConflict: false });
}

/** Retry only observation calls, including provider-state 409 while a Box is transitioning. */
export async function retryIdempotentObservation<T>(
  input: IdempotentRetryInput<T, IdempotentObservationCall>,
): Promise<T> {
  return await retryKnownIdempotentCall({ ...input, retryProviderStateConflict: true });
}
