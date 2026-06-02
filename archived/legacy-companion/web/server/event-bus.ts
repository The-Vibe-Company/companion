// Zero-dependency, strongly-typed internal event bus for the Companion server.

import type { CompanionEventMap } from "./event-bus-types.js";

type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Generic typed event bus. Handlers are invoked synchronously; async handlers
 * are fire-and-forget. Errors in handlers are caught and logged, never
 * propagated to emitters.
 */
export class EventBus<
  TMap extends Record<string, any> = CompanionEventMap,
> {
  private handlers = new Map<keyof TMap, Set<EventHandler<any>>>();
  private onceHandlers = new Map<keyof TMap, Set<EventHandler<any>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof TMap>(
    event: K,
    handler: EventHandler<TMap[K]>,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /** Subscribe to an event; auto-unsubscribe after the first invocation. */
  once<K extends keyof TMap>(
    event: K,
    handler: EventHandler<TMap[K]>,
  ): () => void {
    if (!this.onceHandlers.has(event)) {
      this.onceHandlers.set(event, new Set());
    }
    this.onceHandlers.get(event)!.add(handler);
    return () => {
      this.onceHandlers.get(event)?.delete(handler);
    };
  }

  /** Remove a specific handler for an event. */
  off<K extends keyof TMap>(
    event: K,
    handler: EventHandler<TMap[K]>,
  ): void {
    this.handlers.get(event)?.delete(handler);
    this.onceHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event to all subscribed handlers.
   * Errors are caught and logged — never propagated to the emitter.
   */
  emit<K extends keyof TMap>(event: K, payload: TMap[K]): void {
    const regular = this.handlers.get(event);
    if (regular && regular.size > 0) {
      const snapshot = [...regular];
      for (const handler of snapshot) {
        try {
          const result = handler(payload);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              console.error(
                `[event-bus] Async handler error for "${String(event)}":`,
                err,
              );
            });
          }
        } catch (err) {
          console.error(
            `[event-bus] Handler error for "${String(event)}":`,
            err,
          );
        }
      }
    }

    const onces = this.onceHandlers.get(event);
    if (onces && onces.size > 0) {
      const snapshot = [...onces];
      onces.clear();
      for (const handler of snapshot) {
        try {
          const result = handler(payload);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              console.error(
                `[event-bus] Async once-handler error for "${String(event)}":`,
                err,
              );
            });
          }
        } catch (err) {
          console.error(
            `[event-bus] Once-handler error for "${String(event)}":`,
            err,
          );
        }
      }
    }
  }

  /** Remove all handlers (useful for testing or shutdown). */
  clear(): void {
    this.handlers.clear();
    this.onceHandlers.clear();
  }

  /** Return the number of handlers registered for an event. */
  listenerCount<K extends keyof TMap>(event: K): number {
    return (
      (this.handlers.get(event)?.size ?? 0) +
      (this.onceHandlers.get(event)?.size ?? 0)
    );
  }
}

/** Singleton bus instance for the Companion server. */
export const companionBus = new EventBus<CompanionEventMap>();
