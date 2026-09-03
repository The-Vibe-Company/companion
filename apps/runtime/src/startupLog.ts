/* oxlint-disable anti-slop/no-unknown-parameters -- This is the process-level rejected-promise boundary; describeThrownError performs the repository's bounded normalization before logging. */
import { createJsonRuntimeProcessLog, describeThrownError } from "@companion/companion-runtime/runtime-support";

import { RuntimeDatabaseRoleError } from "./database";

/** A role refusal is already an intentional fatal readiness signal in the platform logs. */
export function shouldCaptureRuntimeStartupFailure(error: unknown): boolean {
  return !(error instanceof RuntimeDatabaseRoleError);
}

/** Startup failures used to print only "runtime failed to start" and drop the cause. */
export function logRuntimeStartupFailure(
  error: unknown,
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  createJsonRuntimeProcessLog(write).error({
    ts: new Date().toISOString(),
    event: "runtime.startup.failed",
    thrown: describeThrownError(error),
  });
}

export interface RuntimeStartupFailureEffects {
  capture(error: unknown): void;
  flush(): Promise<void>;
  log(error: unknown): void;
  setExitCode(code: number): void;
}

/** Apply the complete process-boundary policy for a rejected runtime startup. */
export async function handleRuntimeStartupFailure(
  error: unknown,
  effects: RuntimeStartupFailureEffects,
): Promise<void> {
  effects.log(error);
  effects.setExitCode(1);
  if (!shouldCaptureRuntimeStartupFailure(error)) return;

  effects.capture(error);
  await effects.flush();
}
