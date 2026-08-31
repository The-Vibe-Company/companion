/* oxlint-disable anti-slop/no-unknown-parameters -- This is the process-level rejected-promise boundary; startup reporting normalizes the value before any sink receives it. */
import "./sentry";
import { captureRuntimeException, Sentry } from "./sentry";
import { runRuntimeUntilSignal } from "./process";
import { buildProductionRuntimeService } from "./production";
import { handleRuntimeStartupFailure, logRuntimeStartupFailure } from "./startupLog";

void runRuntimeUntilSignal({ build: buildProductionRuntimeService }).catch((error: unknown) =>
  handleRuntimeStartupFailure(error, {
    capture: captureRuntimeException,
    flush: async () => {
      await Sentry.flush(2000);
    },
    log: logRuntimeStartupFailure,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  }),
);
