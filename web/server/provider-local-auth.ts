type LocalAuthProvider = "claude" | "codex";

export type LocalAuthCheckResult = {
  valid: boolean;
  error?: string;
};

const LOCAL_AUTH_TIMEOUT_MS = 45_000;

function commandForProvider(provider: LocalAuthProvider): string[] {
  if (provider === "claude") {
    return [
      "claude",
      "--output-format",
      "text",
      "--permission-mode",
      "default",
      "--no-session-persistence",
      "-p",
      "hello",
    ];
  }

  return [
    "codex",
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "hello",
  ];
}

function redactAuthOutput(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .trim();
}

export async function verifyLocalCliAuth(provider: LocalAuthProvider): Promise<LocalAuthCheckResult> {
  const command = commandForProvider(provider);
  let proc: ReturnType<typeof Bun.spawn>;

  try {
    proc = Bun.spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      valid: false,
      error: `${provider === "claude" ? "Claude Code" : "Codex"} CLI could not be started: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Process may have already exited.
    }
  }, LOCAL_AUTH_TIMEOUT_MS);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    if (exitCode === 0) return { valid: true };

    const detail = redactAuthOutput(stderr || stdout);
    if (timedOut) {
      return {
        valid: false,
        error: `${provider === "claude" ? "Claude Code" : "Codex"} CLI auth check timed out`,
      };
    }
    return {
      valid: false,
      error: detail || `${provider === "claude" ? "Claude Code" : "Codex"} CLI exited with code ${exitCode}`,
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
