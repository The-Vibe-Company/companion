import "./sentry";
import { captureWorkerError, Sentry } from "./sentry";
import { closeDb } from "@companion/db";
import { keepWorkerProcessAliveWhenIdle, startWorkerSupervisors } from "./supervisors";

async function main(): Promise<void> {
  const { billing, github, skillDatabases } = await startWorkerSupervisors();
  if (!billing && !github && !skillDatabases) {
    console.info("worker idle: no supervisor is configured");
  }
  const idleKeepAlive = keepWorkerProcessAliveWhenIdle({ billing, github, skillDatabases });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      if (idleKeepAlive) clearInterval(idleKeepAlive);
      await Promise.allSettled([
        billing?.stop(),
        github?.stop(),
        skillDatabases?.stop(),
      ]);
      await closeDb();
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
}

main().catch(async (error: Error) => {
  captureWorkerError(error, {
    supervisor: "worker",
    operation: "process.start",
    level: "fatal",
    retryable: false,
  });
  console.error("worker failed to start");
  await Sentry.flush(2000);
  process.exitCode = 1;
});
