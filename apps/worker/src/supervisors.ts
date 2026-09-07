import { captureWorkerError } from "./sentry";
import { startBillingSupervisor, type Supervisor } from "./billingSupervisor";
import { startGitHubSupervisor } from "./githubSupervisor";
import { startSkillDatabaseCleanupSupervisor } from "./skillDatabaseCleanup";

type SupervisorStart = () => Promise<Supervisor | null>;

async function startSafely(name: string, start: SupervisorStart): Promise<Supervisor | null> {
  try {
    return await start();
  } catch (error) {
    // Supervisors are isolated: one optional subsystem failing configuration must not stop another.
    captureWorkerError(error, {
      supervisor: name === "billing"
        ? "billing"
        : name === "GitHub sync"
          ? "github"
          : "skill-database",
      operation: "supervisor.start",
      level: "error",
      retryable: false,
    });
    console.error(`${name} supervisor failed to start`);
    return null;
  }
}

export async function startWorkerSupervisors(input: {
  billing?: SupervisorStart;
  github?: SupervisorStart;
  skillDatabases?: SupervisorStart;
} = {}): Promise<{
  billing: Supervisor | null;
  github: Supervisor | null;
  skillDatabases: Supervisor | null;
}> {
  const [billing, github, skillDatabases] = await Promise.all([
    startSafely("billing", input.billing ?? startBillingSupervisor),
    startSafely("GitHub sync", input.github ?? startGitHubSupervisor),
    startSafely("Skill Database cleanup", input.skillDatabases ?? startSkillDatabaseCleanupSupervisor),
  ]);
  return { billing, github, skillDatabases };
}

/**
 * An unresolved Promise does not keep Node's event loop alive. Keep an intentionally idle worker
 * process available for health checks when every optional Skills Hub subsystem is disabled.
 */
export function keepWorkerProcessAliveWhenIdle(input: {
  billing: Supervisor | null;
  github?: Supervisor | null;
  skillDatabases?: Supervisor | null;
}): ReturnType<typeof setInterval> | null {
  if (input.billing || input.github || input.skillDatabases) return null;
  return setInterval(() => undefined, 60_000);
}
