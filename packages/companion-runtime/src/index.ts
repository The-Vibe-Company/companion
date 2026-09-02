/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Optional kernel dependencies are conditionally spread at this composition boundary. */
import { randomUUID } from "node:crypto";
import { systemRuntimeClock, type RuntimeClock } from "./clock";
import { RuntimeEngine } from "./engine";
import { RuntimeHealth } from "./health";
import type { RuntimeProcessLog } from "./logging";
import type {
  RuntimeAttachmentStager,
  RuntimeBoxControl,
  RuntimeEventProjector,
  RuntimeIdFactory,
  RuntimeMaterialProvider,
  RuntimeOutboxHarvester,
  RuntimePiControl,
  RuntimeProjectionRedactorFactory,
  RuntimeResourceStager,
} from "./ports";
import { storeEventProjector, storeMaterialProvider } from "./ports";
import { genericRuntimeVisibleTextRedactor } from "./projectionRedaction";
import {
  DEFAULT_RUNTIME_CONCURRENCY,
  DEFAULT_RUNTIME_SWEEP_INTERVAL_MS,
  RuntimeScheduler,
} from "./scheduler";
import type { RuntimeStore } from "./store";

export interface CreateRuntimeKernelInput {
  store: RuntimeStore;
  box: RuntimeBoxControl;
  pi: RuntimePiControl;
  resourceStager: RuntimeResourceStager;
  attachmentStager: RuntimeAttachmentStager;
  outboxHarvester: RuntimeOutboxHarvester;
  materialProvider?: RuntimeMaterialProvider;
  projectionRedactorFactory?: RuntimeProjectionRedactorFactory;
  eventProjector?: RuntimeEventProjector;
  idFactory?: RuntimeIdFactory;
  clock?: RuntimeClock;
  jitter?: () => number;
  executorId: string;
  concurrency?: number;
  sweepIntervalMs?: number;
  eventPollIntervalMs?: number | ((input: { boxId: string }) => number);
  claimsEnabled: boolean;
  log?: RuntimeProcessLog;
}

export interface RuntimeKernel {
  engine: RuntimeEngine;
  scheduler: RuntimeScheduler;
  health: RuntimeHealth;
}

export function createRuntimeKernel(input: CreateRuntimeKernelInput): RuntimeKernel {
  const clock = input.clock ?? systemRuntimeClock;
  if (input.claimsEnabled && !input.projectionRedactorFactory) {
    throw new Error("Runtime claims require a credential-aware projection redactor");
  }
  const engine = new RuntimeEngine({
    store: input.store,
    box: input.box,
    pi: input.pi,
    materialProvider: input.materialProvider ?? storeMaterialProvider,
    projectionRedactorFactory: input.projectionRedactorFactory ?? {
      forMaterial: () => genericRuntimeVisibleTextRedactor,
    },
    resourceStager: input.resourceStager,
    attachmentStager: input.attachmentStager,
    outboxHarvester: input.outboxHarvester,
    eventProjector: input.eventProjector ?? storeEventProjector,
    idFactory: input.idFactory ?? { uuid: randomUUID },
    clock,
    jitter: input.jitter ?? Math.random,
    executorId: input.executorId,
    ...(input.eventPollIntervalMs === undefined
      ? {}
      : { eventPollIntervalMs: input.eventPollIntervalMs }),
    ...(input.log ? { log: input.log } : {}),
  });
  const scheduler = new RuntimeScheduler({
    store: input.store,
    engine,
    clock,
    executorId: input.executorId,
    concurrency: input.concurrency ?? DEFAULT_RUNTIME_CONCURRENCY,
    sweepIntervalMs: input.sweepIntervalMs ?? DEFAULT_RUNTIME_SWEEP_INTERVAL_MS,
    claimsEnabled: input.claimsEnabled,
    ...(input.log ? { log: input.log } : {}),
  });
  return {
    engine,
    scheduler,
    health: new RuntimeHealth({ store: input.store, scheduler, clock }),
  };
}

export * from "./attempt";
export * from "./clock";
export * from "./decision";
export * from "./desktopAuth";
export * from "./engine";
export * from "./errors";
export * from "./executionControl";
export * from "./handler";
export * from "./health";
export * from "./imageRegistry";
export * from "./leaseSession";
export * from "./logging";
export * from "./operations";
export * from "./piEvents";
export * from "./ports";
export * from "./projectionRedaction";
export * from "./retry";
export * from "./scheduler";
export * from "./settings";
export * from "./store";
export * from "./types";
export {
  RUNTIME_V3_LANES,
  RUNTIME_V3_LIFECYCLE_INTENTS,
} from "./v3/progression";
export type {
  RuntimeV3Admission,
  RuntimeV3DesiredLifecycleChange,
  RuntimeV3Lane,
  RuntimeV3LifecycleIntent,
  RuntimeV3LifecycleRevision,
  RuntimeV3Progression,
  RuntimeV3Turn,
  RuntimeV3TurnState,
} from "./v3/progression";
