/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing Box transport fixtures predate the incremental anti-slop gate. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_CONTROL_MCP_SERVER_NAME,
  COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS,
  COMPANION_ROUTINE_MAX_PER_COMPANION,
  COMPANION_ROUTINE_MIN_INTERVAL_MS,
  COMPANION_TOOL_RUN_TIMEOUT_MS,
  COMPANION_TRIGGER_MAX_PER_COMPANION,
} from "@companion/contracts";
import { COMPANION_RUNTIME_ERROR_MAX_LENGTH } from "@companion/core";
import { z } from "zod";

import {
  AsciiBoxCompanionRuntime,
  BOX_PROVIDER_STATES,
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
  COMPANION_OUTBOX_INSTRUCTIONS,
  composeDaemonFailureDetail,
  composedInstructions,
  composedRoutineInstructions,
  composedTriggerValidationInstructions,
  mintBoxDesktopUrl,
  observedBoxStateFromProvider,
  parseOutboxManifest,
  resolvePiPackages,
} from "./boxCompanionRuntime";
import { companionPiLayoutIdentity } from "./companionRuntimeImage";
import {
  COMPANION_PI_BUNDLE,
  companionPiBundleObjectKey,
  companionPiBundleShaShort,
  type CompanionPiBundlePlan,
} from "./piBundle";
import { COMPANION_PI_MODELS_PATH } from "./companionPiModels";
import {
  COMPANION_PI_ROUTINE_SURFACE_EXTENSION_FILE,
  COMPANION_PI_ROUTINE_SURFACE_EXTENSION_SOURCE,
  companionPiRoutineSessionPaths,
} from "./companionPiRoutineSession";
import type { PiJsonObject } from "./companionPiBroker";
import type { CompanionStagedMcpAccount } from "./companionPiInjection";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Box desktop mint", () => {
  it("mints a fresh VNC URL for every join", async () => {
    let sequence = 0;
    const vnc = vi.fn(async () => ({ desktopUrl: `https://desktop.test/vnc/${++sequence}` }));
    const input = {
      vnc,
      webrtc: vi.fn(async () => ({ desktopUrl: "https://desktop.test/webrtc" })),
      budgetMs: 100,
      pause: vi.fn(async () => undefined),
      now: () => 0,
    };

    await expect(mintBoxDesktopUrl(input)).resolves.toEqual({
      url: "https://desktop.test/vnc/1",
      provisioning: false,
      transport: "vnc",
    });
    await expect(mintBoxDesktopUrl(input)).resolves.toEqual({
      url: "https://desktop.test/vnc/2",
      provisioning: false,
      transport: "vnc",
    });
    expect(input.webrtc).not.toHaveBeenCalled();
  });

  it("waits for VNC until its budget is spent, then falls back to WebRTC", async () => {
    let now = 0;
    const pause = vi.fn(async () => { now += 10; });
    const vnc = vi.fn(async () => ({ provisioning: true }));
    const webrtc = vi.fn(async () => ({ url: "https://desktop.test/webrtc" }));

    await expect(mintBoxDesktopUrl({
      vnc,
      webrtc,
      budgetMs: 20,
      pause,
      now: () => now,
    })).resolves.toEqual({
      url: "https://desktop.test/webrtc",
      provisioning: false,
      transport: "webrtc",
    });
    expect(vnc).toHaveBeenCalledTimes(2);
    expect(webrtc).toHaveBeenCalledOnce();
  });

  it("falls back immediately when the provider build refuses VNC", async () => {
    await expect(mintBoxDesktopUrl({
      vnc: async () => {
        throw new BoxRuntimeProviderError("VNC unsupported", 400);
      },
      webrtc: async () => ({ desktopUrl: "https://desktop.test/webrtc" }),
      budgetMs: 100,
      pause: async () => undefined,
    })).resolves.toEqual({
      url: "https://desktop.test/webrtc",
      provisioning: false,
      transport: "webrtc",
    });
  });
});

describe("narrow AsciiBoxCompanionRuntime", () => {
  it("fails closed when the Box service key is absent", () => {
    expect(() => new AsciiBoxCompanionRuntime({})).toThrow(BoxRuntimeConfigurationError);
  });

  it("observes, resumes, archives, updates TTL, and mints desktop without implicit creation", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let state: "archived" | "ready" | "archiving" = "archived";
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? parseBoxTestBody(init.body) : null;
      requests.push({ method, url, body });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/resume") && method === "POST") {
        state = "ready";
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return response(commandResult("inactive\ncompanion-pi-broker-unready\n"));
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return response({ box: box(state) });
      if (url.endsWith("/boxes/bx_23456789/stop") && method === "POST") {
        state = "archiving";
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/desktop?vnc=1") && method === "POST") {
        return response({ desktopUrl: "https://desktop.test/vnc" });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const runtime = runtimeClient();

    await expect(runtime.existingBoxStatus({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "archived",
    });
    await expect(runtime.resumeExistingBox({ boxId: "bx_23456789" })).resolves.toMatchObject({
      boxId: "bx_23456789",
      runtimeState: "stopped",
      daemonState: "stopped",
    });
    await runtime.refreshTtl({ boxId: "bx_23456789", ttlSeconds: 21_600 });
    await expect(runtime.desktop({ boxId: "bx_23456789" })).resolves.toEqual({
      url: "https://desktop.test/vnc",
      provisioning: false,
      transport: "vnc",
    });
    await expect(runtime.archiveExistingBox({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "archiving",
    });

    expect(requests.some((request) => request.url.endsWith("/boxes") && request.method === "POST"))
      .toBe(false);
    expect(requests.find((request) => request.method === "PATCH")?.body)
      .toEqual({ ttlSeconds: 21_600 });
    const archiveCleanup = requests.findIndex((request) =>
      request.url.endsWith("/commands")
      && boxTestBodySchema.safeParse(request.body).success
      && requiredText(boxTestBodySchema.parse(request.body), "command")
        .includes("control-bundle-v1.json"));
    const archiveRequest = requests.findIndex((request) => request.url.endsWith("/stop"));
    expect(archiveCleanup).toBeGreaterThanOrEqual(0);
    expect(archiveCleanup).toBeLessThan(archiveRequest);
  });

  it("waits for Pi readiness inside one Box command instead of polling the provider", async () => {
    const commands: Array<{ command: string; timeoutSeconds: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = parseBoxTestBody(init?.body);
      const command = requiredText(body, "command");
      const timeoutSeconds = requiredNumber(body, "timeoutSeconds");
      commands.push({ command, timeoutSeconds });
      if (command.includes("for companion_pi_probe")) {
        return response(commandResult(
          "active\ncompanion-pi-broker-ready\ncompanion-pi-invocation invocation-1\n",
        ));
      }
      return response(commandResult());
    }));
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "1000",
    });

    await expect(runtime.restartPiDaemon({ boxId: "bx_23456789" })).resolves.toEqual({
      state: "idle",
      invocationId: "invocation-1",
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toContain("seq 1 10");
    expect(commands[0]?.command).toContain("sleep 0.1");
    expect(commands[0]?.command).toContain(
      'stat -c \'%a\' "$HOME/.companion/pi" 2>/dev/null || true',
    );
    expect(commands[0]?.timeoutSeconds).toBe(120);
  });

  it.each([
    ["companion-pi-termination-terminated", "terminated"],
    ["companion-pi-termination-already-gone", "already_gone"],
    ["companion-pi-termination-superseded", "superseded"],
  ] as const)("maps exact Pi termination proof %s", async (marker, outcome) => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = parseBoxTestBody(init?.body);
      commands.push(requiredText(body, "command"));
      return response(commandResult(`${marker}\n`));
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.terminatePiInvocation({
      boxId: "bx_23456789",
      expectedInvocationId: "invocation-original",
    })).resolves.toEqual({ outcome });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("flock -w 20");
    expect(commands[0]).toContain("expected_invocation='invocation-original'");
    expect(commands[0]).toContain('confirmed_invocation="$(systemctl --user show');
    expect(spawnSync("bash", ["-n"], { input: commands[0], encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it("quarantines main Pi state under a stable recovery id without touching Box lifecycle", async () => {
    let command = "";
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = parseBoxTestBody(init?.body);
      command = requiredText(body, "command");
      return response(commandResult("companion-pi-session-reset\n"));
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.resetPiSession({
      boxId: "bx_23456789",
      recoveryId: "2f883a91-92dd-4fec-b674-b7d250f81f61",
    })).resolves.toBeUndefined();

    expect(command).toContain("flock -w 20");
    expect(command).toContain("if systemctl --user is-active --quiet companion-pi-daemon.service");
    expect(command).toContain("recovery_id='2f883a91-92dd-4fec-b674-b7d250f81f61'");
    expect(command).toContain('mv "$runtime_root/sessions" "$recovery_root/sessions"');
    expect(command).not.toContain("systemctl --user start");
    expect(command).not.toContain("systemctl --user restart");
    expect(spawnSync("bash", ["-n"], { input: command, encoding: "utf8" })).toMatchObject({
      status: 0, stderr: "",
    });
  });

  it.each(["archived", "archiving"] as const)(
    "archives an already %s Box with one GET and no rejected cleanup command",
    async (state) => {
      const requests: Array<{ url: string; method: string }> = [];
      vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
          return response({ box: box(state) });
        }
        throw new Error(`unexpected Box request: ${method} ${url}`);
      }));

      await expect(runtimeClient().archiveExistingBox({ boxId: "bx_23456789" }))
        .resolves.toEqual({ boxId: "bx_23456789", state });
      expect(requests).toEqual([{
        url: "https://ascii.dev/api/box/v1/boxes/bx_23456789",
        method: "GET",
      }]);
    },
  );

  it("expunges persistent and runtime provider credentials for disposable Box cleanup", async () => {
    let command = "";
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = parseBoxTestBody(init?.body);
      command = requiredText(body, "command");
      return response(commandResult());
    }));

    await expect(runtimeClient().clearPersistedProviderAuth({ boxId: "bx_23456789" }))
      .resolves.toBeUndefined();
    expect(command).toContain('rm -f "$HOME/.companion/pi/auth.json"');
    expect(command).toContain('"$HOME/.companion/runtime/state/providers.env"');
    expect(command).toContain('"$HOME/.companion/runtime/state/control-bundle-v1.json"');
    expect(command).toContain('"/run/user/$(id -u)/companion/providers.env"');
    expect(command).toContain("control-transaction-v1");
    expect(command).toContain("set -euo pipefail");
    expect(command).toContain('if [ -e "$target" ] || [ -L "$target" ]; then exit 1; fi');
  });

  it("cleans and retries the idempotent control bundle when apply submission fails once", async () => {
    const commands: string[] = [];
    const files: string[] = [];
    let rejectedApply = false;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") {
        files.push(requiredText(parseBoxTestBody(init?.body), "path"));
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const body = parseBoxTestBody(init?.body);
        const command = requiredText(body, "command");
        commands.push(command);
        if (command.includes("COMPANION_CONTROL_APPLY") && !rejectedApply) {
          rejectedApply = true;
          throw new BoxRuntimeProviderError("control apply rate limited", 429);
        }
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    await expect(runtimeClient().stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { provider: { type: "api_key", key: "ephemeral-test-token" } },
      replaceProviderAuth: true,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
    })).resolves.toMatchObject({ stagingMode: "skills" });

    expect(files.filter((path) => path.endsWith("control-bundle-v1.json"))).toHaveLength(2);
    expect(commands.filter((command) => command.includes("COMPANION_CONTROL_APPLY"))).toHaveLength(2);
    expect(commands.some((command) =>
      command.includes('bundle="$HOME/.companion/runtime/state/control-bundle-v1.json"')
      && command.includes('rm -f "$bundle"')
      && command.includes("control-transaction-v1"))).toBe(true);
  });

  it("reports safe semantic timings for every staging boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") return response({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));
    const timings: Array<{ phase: string; ok: boolean }> = [];
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_BOX_READY_TIMEOUT_MS: "100",
    }, {
      onStageTiming: (sample) => timings.push({ phase: sample.phase, ok: sample.ok }),
    });

    await runtime.stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { provider: { type: "api_key", key: "ephemeral-test-token" } },
      replaceProviderAuth: true,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
    });

    // The control bundle and the Skill transfer overlap, so only the phase set is deterministic.
    expect(timings.map((timing) => timing.phase).sort()).toEqual([
      "control_bundle",
      "identity_probe",
      "interaction_extension",
      "layout",
      "resource_preflight",
      "skill_apply",
      "skill_transfer",
    ]);
    expect(timings.every((timing) => timing.ok)).toBe(true);
  });

  it("cleans the secret-bearing control bundle and fails after two rejected applies", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") return response({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const body = parseBoxTestBody(init?.body);
        const command = requiredText(body, "command");
        commands.push(command);
        if (command.includes("COMPANION_CONTROL_APPLY")) {
          throw new Error("control apply transport failed");
        }
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    await expect(runtimeClient().stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { provider: { type: "api_key", key: "ephemeral-test-token" } },
      replaceProviderAuth: true,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
    })).rejects.toThrow("The Box provider could not be reached");

    expect(commands.filter((command) => command.includes("COMPANION_CONTROL_APPLY"))).toHaveLength(2);
    expect(commands.some((command) =>
      command.includes('bundle="$HOME/.companion/runtime/state/control-bundle-v1.json"')
      && command.includes('rm -f "$bundle"')
      && command.includes("control-transaction-v1"))).toBe(true);
    const providerCleanup = commands.at(-1)!;
    expect(providerCleanup).toContain("runtime/state/providers.env");
    expectCleanupFailsWhenRmFails(providerCleanup);
  });

  it("proves transient provider credentials absent when Git helper activation fails", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") return response({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = requiredText(parseBoxTestBody(init?.body), "command");
        commands.push(command);
        if (command.includes("credential.helper")) {
          return response({ success: false, exitCode: 1, stdout: "", stderr: "git refused" });
        }
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    await expect(runtimeClient().stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { provider: { type: "api_key", key: "ephemeral-test-token" } },
      replaceProviderAuth: true,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [githubBrokerAccount()],
      skills: [],
    })).rejects.toThrow("git refused");

    const helper = commands.findIndex((command) => command.includes("credential.helper"));
    const cleanup = commands.findIndex((command, index) =>
      index > helper && command.includes("runtime/state/providers.env"));
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(helper);
  });

  it("rolls every control file back when a later atomic commit step fails", async () => {
    let bundle = "";
    let applyCommand = "";
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") {
        const body = parseBoxTestBody(init?.body);
        const path = requiredText(body, "path");
        const content = requiredText(body, "content");
        if (path.endsWith("control-bundle-v1.json")) bundle = content;
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const command = requiredText(parseBoxTestBody(init?.body), "command");
        if (command.includes("COMPANION_CONTROL_APPLY")) applyCommand = command;
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));
    await runtimeClient().stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { provider: { type: "api_key", key: "ephemeral-test-token" } },
      replaceProviderAuth: true,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
    });

    const home = mkdtempSync(join(tmpdir(), "companion-control-"));
    try {
      const state = join(home, ".companion/runtime/state");
      const auth = join(home, ".companion/pi/auth.json");
      mkdirSync(state, { recursive: true });
      mkdirSync(join(home, ".companion/pi"), { recursive: true });
      writeFileSync(join(state, "control-bundle-v1.json"), bundle);
      writeFileSync(auth, "old-auth");

      const injectedCommand = applyCommand.replace(
        "    record.installed = true;\n",
        "    record.installed = true;\n    if (records.indexOf(record) === 0) throw new Error(\"injected commit failure\");\n",
      );
      expect(injectedCommand).not.toBe(applyCommand);

      const applied = spawnSync("bash", ["-c", injectedCommand], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });

      expect(applied.status).not.toBe(0);
      expect(readFileSync(auth, "utf8")).toBe("old-auth");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dispatches only correlated layout-14 commands and validates monotonic journal pages", async () => {
    const commandTypes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = parseBoxTestBody(init?.body);
      const command = decodeBrokerCommand(requiredText(body, "command"));
      commandTypes.push(String(command.type));
      const id = String(command.id);
      if (command.type === "prompt") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "prompt",
          success: true,
          data: {
            attemptId: command.attemptId,
            responseAttemptId: command.attemptId,
            invocationId: "invocation-1",
            piAcknowledged: true,
            initialCursor: 0,
            clearOutbox: true,
          },
        }) + "\n"));
      }
      if (command.type === "runtime_state") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "runtime_state",
          success: true,
          data: {
            invocationId: "invocation-1",
            activeAttemptId: "attempt-1",
            tailCursor: 1,
            acknowledgedCursor: 0,
            modelInput: ["text", "image"],
            counters: zeroCounters(),
          },
        }) + "\n"));
      }
      if (command.type === "read_events") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "read_events",
          success: true,
          data: {
            events: [{
              sequence: 1,
              invocationId: "invocation-1",
              attemptId: "attempt-1",
              kind: "pi_event",
              event: { type: "agent_start" },
            }],
            nextCursor: 1,
            acknowledgedCursor: 0,
            hasMore: false,
          },
        }) + "\n"));
      }
      if (command.type === "ack_events") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "ack_events",
          success: true,
          data: { acknowledgedCursor: 1 },
        }) + "\n"));
      }
      throw new Error(`unexpected broker command ${String(command.type)}`);
    }));
    const runtime = runtimeClient();

    await expect(runtime.dispatchPrompt({
      boxId: "bx_23456789",
      attemptId: "attempt-1",
      requestId: "prompt-1",
      message: "do work",
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-1",
      responseAttemptId: "attempt-1",
      invocationId: "invocation-1",
      initialCursor: 0,
    });
    await expect(runtime.brokerState({ boxId: "bx_23456789" })).resolves.toMatchObject({
      invocationId: "invocation-1",
      modelInput: ["text", "image"],
    });
    await expect(runtime.readEvents({ boxId: "bx_23456789", after: 0 })).resolves.toMatchObject({
      nextCursor: 1,
      acknowledgedCursor: 0,
      events: [expect.objectContaining({ sequence: 1, attemptId: "attempt-1" })],
    });
    await expect(runtime.ackEvents({ boxId: "bx_23456789", through: 1 })).resolves.toEqual({
      acknowledgedCursor: 1,
    });
    expect(commandTypes).toEqual(["prompt", "runtime_state", "read_events", "ack_events"]);
  });

  it("keeps a lost prompt acknowledgement ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("synthetic transport loss");
    }));
    await expect(runtimeClient().dispatchPrompt({
      boxId: "bx_23456789",
      attemptId: "attempt-ambiguous",
      message: "possibly written",
    })).resolves.toEqual({
      outcome: "ambiguous",
      code: "pi_ack_ambiguous",
      message: "Pi prompt acknowledgement is unavailable",
    });
  });

  it("sends exactly one abortable resume request without polling Box or Pi", async () => {
    const controller = new AbortController();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/boxes/bx_23456789/resume") && init?.method === "POST") {
        commandStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const observation = runtime.resumeExistingBox({ boxId: "bx_23456789", signal: controller.signal });
    await started;
    const stopped = new Error("runtime handoff");
    controller.abort(stopped);

    await expect(observation).rejects.toBe(stopped);
  });

  it("propagates abort while reading broker state for Pi status", async () => {
    const controller = new AbortController();
    let brokerStarted!: () => void;
    const started = new Promise<void>((resolve) => { brokerStarted = resolve; });
    let commandCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/commands") && init?.method === "POST") {
        commandCount += 1;
        if (commandCount === 1) {
          return response({
            success: true,
            exitCode: 0,
            stdout: "active\ncompanion-pi-broker-ready\n",
            stderr: "",
          });
        }
        brokerStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const status = runtime.piDaemonStatus({ boxId: "bx_23456789", signal: controller.signal });
    await started;
    const stopped = new Error("runtime handoff");
    controller.abort(stopped);

    await expect(status).rejects.toBe(stopped);
  });

  it("maps a network transport failure to a retryable 503 provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/boxes/bx_23456789/resume") && init?.method === "POST") {
        throw new TypeError("fetch failed");
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const error = await runtime.resumeExistingBox({ boxId: "bx_23456789" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BoxRuntimeProviderError);
    expect(error.status).toBe(503);
    // status >= 500 makes isRetryableProviderError(retry.ts) true, so an idempotent lifecycle call
    // (resume/get_status/apply_settings/...) will now be retried instead of failing immediately.
    expect(error.status).toBeGreaterThanOrEqual(500);
  });

  it("maps a request timeout to a retryable 504 provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/boxes/bx_23456789/resume") && init?.method === "POST") {
        // The shape AbortSignal.timeout() produces when it aborts an in-flight fetch.
        throw new DOMException("The operation timed out", "TimeoutError");
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const error = await runtime.resumeExistingBox({ boxId: "bx_23456789" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BoxRuntimeProviderError);
    expect(error.status).toBe(504);
    expect(error.status).toBeGreaterThanOrEqual(500);
  });

  it("keeps a caller abort non-retryable and preserves its control reason", async () => {
    const controller = new AbortController();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/boxes/bx_23456789/resume") && init?.method === "POST") {
        commandStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const observation = runtime.resumeExistingBox({ boxId: "bx_23456789", signal: controller.signal });
    await started;
    const handoff = new Error("runtime handoff");
    controller.abort(handoff);

    // The raw control reason propagates unchanged — never wrapped as a retryable/ambiguous provider
    // error — so the runtime layer still recognises a lease handoff/shutdown as a must-abandon outcome.
    const error = await observation.catch((caught) => caught);
    expect(error).toBe(handoff);
    expect(error).not.toBeInstanceOf(BoxRuntimeProviderError);
  });
});

describe("provider Box lifecycle states", () => {
  it("maps every documented provider state and does not treat provisioned as ready", () => {
    expect(BOX_PROVIDER_STATES).toEqual([
      "init",
      "provisioning",
      "provisioned",
      "cloning",
      "ready",
      "idle",
      "running",
      "archiving",
      "archived",
      "error",
    ]);
    expect(observedBoxStateFromProvider("init")).toBe("initializing");
    expect(observedBoxStateFromProvider("provisioning")).toBe("provisioning");
    expect(observedBoxStateFromProvider("provisioned")).toBe("provisioning");
    expect(observedBoxStateFromProvider("cloning")).toBe("provisioning");
    expect(observedBoxStateFromProvider("ready")).toBe("ready");
    expect(observedBoxStateFromProvider("idle")).toBe("idle");
    expect(observedBoxStateFromProvider("running")).toBe("running");
    expect(observedBoxStateFromProvider("archiving")).toBe("archiving");
    expect(observedBoxStateFromProvider("archived")).toBe("archived");
    expect(observedBoxStateFromProvider("error")).toBe("error");
  });

  it("allows a slow bake archive and retries one transient command race after resume", async () => {
    const now = vi.spyOn(Date, "now");
    let currentTime = 0;
    now.mockImplementation(() => currentTime);
    let archivePolls = 0;
    let warmupCommands = 0;
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      requests.push({ method, url, body });
      if (url.endsWith("/files") && method === "PUT") return response({ ok: true });
      if (url.endsWith("/stop") && method === "POST") {
        return response({ box: box("archiving") });
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        archivePolls += 1;
        if (archivePolls <= 2) {
          currentTime += 60;
          return response({ box: box("archiving") });
        }
        return response({ box: box(archivePolls === 3 ? "archived" : "ready") });
      }
      if (url.endsWith("/resume") && method === "POST") {
        return response({ box: box("ready") }, 202);
      }
      if (url.endsWith("/commands") && method === "POST") {
        warmupCommands += 1;
        if (warmupCommands === 1) {
          return response({ message: "Box command service is still starting" }, 409);
        }
        if (warmupCommands === 2) {
          return response({
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: "Node.js v24.18.1\n",
          });
        }
        return response({
          success: false,
          exitCode: 1,
          stdout: "companion-runtime-playbook-ready\n",
          stderr: "",
        });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const bundledSkill = {
      slug: "companion-runtime",
      version: "1.0.0",
      checksum: "a".repeat(64),
      archive: Buffer.from("skill"),
    };
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_BOX_READY_TIMEOUT_MS: "100",
    }, { companionSkillChecksum: bundledSkill.checksum });

    await expect(runtime.prepareRuntimeImage({
      boxId: "bx_23456789",
      bundledSkill,
    })).resolves.toBeUndefined();

    expect(archivePolls).toBe(4);
    expect(warmupCommands).toBe(3);
    const warmup = requests.find((request) => request.url.endsWith("/commands"))?.body;
    expect(warmup).toMatchObject({ timeoutSeconds: 45 });
    expect(String((warmup as { command?: string } | undefined)?.command)).toContain("seq 1 300");
  });

  it("reads live GET box.info and resume box.resuming envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({
          ok: true,
          type: "box.info",
          box: box("idle"),
        });
      }
      if (url.endsWith("/boxes/bx_23456789/resume") && method === "POST") {
        return response({
          ok: true,
          type: "box.resuming",
          box: box("ready"),
        }, 202);
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const runtime = runtimeClient();
    await expect(runtime.existingBoxStatus({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "idle",
    });
  });

  it("rejects a durable Box id that does not belong to the expected Companion generation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      box: {
        ...box("archived"),
        name: "Companion 22222222-2222-4222-8222-222222222222 g1",
      },
    })));

    await expect(runtimeClient().existingBoxStatus({
      boxId: "bx_23456789",
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
    })).rejects.toThrow("durable Box identity does not match");
  });
});

describe("bounded daemon diagnostics", () => {
  it("keeps a stable, one-line failure inside the persistence limit", () => {
    const detail = composeDaemonFailureDetail([
      "companion-pi-state failed",
      "companion-pi-status Active: failed (Result: exit-code)",
      "companion-pi-restarts 123456",
      `companion-pi-stderr ${"x".repeat(500)}`,
    ].join("\n"));
    expect(detail).not.toContain("\n");
    expect(`Pi daemon is not running after start${detail}`.length)
      .toBeLessThanOrEqual(COMPANION_RUNTIME_ERROR_MAX_LENGTH);
  });
});

function runtimeClient(): AsciiBoxCompanionRuntime {
  return new AsciiBoxCompanionRuntime({
    COMPANION_BOX_API_KEY: "box_test",
    COMPANION_BOX_POLL_INTERVAL_MS: "1",
    COMPANION_BOX_READY_TIMEOUT_MS: "100",
    COMPANION_BOX_DESKTOP_MINT_BUDGET_MS: "10",
  });
}

function githubBrokerAccount(): CompanionStagedMcpAccount {
  return {
    account: {
      id: "33333333-3333-4333-8333-333333333333",
      label: "GitHub",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "GITHUB_MCP_AUTH" },
      lifecycle: "lazy",
      direct_tools: false,
    },
    oauthBroker: {
      credentialGeneration: "44444444-4444-4444-8444-444444444444",
      github: true,
    },
  };
}

describe("default Pi packages on the Box disk", () => {
  const layoutCommands: Array<{ command: string; timeoutSeconds: number }> = [];
  const stagedFiles = new Map<string, string>();

  /** Stage a Box and hand back the layout script the adapter wrote to its disk. */
  async function stagedLayoutScript(
    env: Record<string, string> = {},
    mcpCredentials: Array<{ env_key: string; value: string }> = [],
    companionSkillChecksum?: string,
    mcpAccounts: CompanionStagedMcpAccount[] = [],
    runtimeOptions: ConstructorParameters<typeof AsciiBoxCompanionRuntime>[1] = {},
  ): Promise<string> {
    stagedFiles.clear();
    layoutCommands.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return response({ box: box("ready") });
      if (url.endsWith("/files") && method === "PUT") {
        const body = parseBoxTestBody(init?.body);
        const path = requiredText(body, "path");
        const content = requiredText(body, "content");
        stagedFiles.set(path, content);
        if (path.endsWith("control-bundle-v1.json")) {
          const bundleResult = z.object({
            files: z.array(z.object({ path: z.string(), content: z.string() })),
          }).safeParse(JSON.parse(content));
          if (!bundleResult.success) throw new Error("control bundle is invalid");
          const bundle = bundleResult.data;
          for (const file of bundle.files) {
            stagedFiles.set(file.path, Buffer.from(file.content, "base64").toString("utf8"));
          }
        }
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const body = parseBoxTestBody(init?.body);
        const command = requiredText(body, "command");
        const timeoutSeconds = requiredNumber(body, "timeoutSeconds");
        if (command.includes("ensure-pi-layout.sh") || command.includes("git-credential-github")) {
          layoutCommands.push({ command, timeoutSeconds });
        }
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    const options: ConstructorParameters<typeof AsciiBoxCompanionRuntime>[1] = {
      ...runtimeOptions,
    };
    if (companionSkillChecksum) options.companionSkillChecksum = companionSkillChecksum;
    await new AsciiBoxCompanionRuntime(
      { COMPANION_BOX_API_KEY: "box_test", ...env },
      options,
    )
      .stageExistingBox({
        companionId: "11111111-1111-4111-8111-111111111111",
        runtimeGeneration: 1,
        orgId: "22222222-2222-4222-8222-222222222222",
        boxId: "bx_23456789",
        clientSurface: "web",
        providerAuth: {},
        replaceProviderAuth: false,
        modelId: "glm-4.6",
        mcpCredentials,
        mcpAccounts,
        skills: [],
      });
    const script = stagedFiles.get(".companion/bin/ensure-pi-layout.sh");
    if (!script) throw new Error("staging did not write the Pi layout script");
    return script;
  }

  it("rebuilds a requested reusable Skill tree when its archive checksum marker is stale", async () => {
    const stagedPaths: string[] = [];
    const commands: string[] = [];
    const runtime = runtimeClient();
    const layoutMarker = runtime.layoutIdentity().fullMarker;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") {
        stagedPaths.push(requiredText(parseBoxTestBody(init?.body), "path"));
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const command = requiredText(parseBoxTestBody(init?.body), "command");
        commands.push(command);
        if (command.includes("companion-box-runnable")) {
          return response(commandResult("companion-box-runnable\n"));
        }
        if (command.includes("pi-layout.version")) return response(commandResult(`${layoutMarker}\n`));
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    const staged = await runtime.stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: {},
      replaceProviderAuth: false,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [{
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("updated-companion-skill"),
      }],
      reuseSkills: true,
    });

    expect(staged.stagingMode).toBe("skills");
    expect(stagedPaths).toContain(
      ".companion/runtime/state/skill-archives/companion.tar.gz.b64",
    );
    expect(commands.some((command) => command.includes("skills-tree.version.next"))).toBe(true);
  });

  it("preserves the installed Skills snapshot and reports its digest on a preserve-skills wake", async () => {
    const stagedPaths: string[] = [];
    const commands: string[] = [];
    const installedDigest = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") {
        // SAFETY: This test controls the request body emitted by the Box runtime file transport.
        stagedPaths.push((JSON.parse(String(init?.body)) as { path: string }).path);
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        // SAFETY: This test controls the request body emitted by the Box runtime command transport.
        const body = JSON.parse(String(init?.body)) as { command: string };
        commands.push(body.command);
        if (body.command.includes("companion-box-runnable")) {
          return response(commandResult(
            `companion-box-runnable\n${installedDigest}\ncompanion-skills-tree-reused\n`,
          ));
        }
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    const staged = await runtimeClient().stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { provider: { type: "api_key", key: "ephemeral-test-token" } },
      replaceProviderAuth: true,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [{
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"3".repeat(64)}`,
        archive: Buffer.from("unused-preserved-skill"),
      }],
      preserveSkills: true,
    });

    expect(staged).toMatchObject({ stagingMode: "refresh", skillsDigest: installedDigest });
    expect(stagedPaths.some((path) => path.includes("skill-archives"))).toBe(false);
    expect(stagedPaths.some((path) => path.endsWith("skills.json"))).toBe(false);
    expect(commands.some((command) => command.includes("skills-tree.version.next"))).toBe(false);
  });

  it("checkpoints an already-installed Skill-only tree without staging credentials or archives", async () => {
    const stagedPaths: string[] = [];
    const commands: string[] = [];
    const runtime = runtimeClient();
    const skill = {
      slug: "companion",
      version: "1.0.0",
      checksum: `sha256:${"2".repeat(64)}`,
      archive: Buffer.from("already-installed-companion-skill"),
    };
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") {
        // SAFETY: This test controls the request body emitted by the Box runtime file transport.
        const body = JSON.parse(String(init?.body)) as { path: string };
        stagedPaths.push(body.path);
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        // SAFETY: This test controls the request body emitted by the Box runtime command transport.
        const body = JSON.parse(String(init?.body)) as { command: string };
        commands.push(body.command);
        if (body.command.includes("companion-box-runnable")) {
          return response(commandResult("companion-box-runnable\n"));
        }
        if (body.command.includes('test "$(cat ')) return response(commandResult());
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    const staged = await runtime.stageSkillTree({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      boxId: "bx_23456789",
      skills: [skill],
    });

    expect(staged).toMatchObject({
      boxId: "bx_23456789",
      skillBytesTransferred: 0,
      skillsDigest: createHash("sha256")
        .update(JSON.stringify([{
          slug: skill.slug,
          version: skill.version,
          checksum: skill.checksum,
        }]))
        .digest("hex"),
    });
    expect(stagedPaths).toEqual([".companion/runtime/state/skills.json"]);
    expect(commands.some((command) => command.includes("skill-archives"))).toBe(false);
    expect(stagedPaths.some((path) => /provider|credential|mcp|hub/i.test(path))).toBe(false);
  });

  it("installs the pinned default set beside the adapter, and qmd without being able to fail", async () => {
    const script = await stagedLayoutScript();

    expect(script).toContain('> "$HOME/.boxignore"');
    const encodedBoxIgnore = /printf '%s' '([^']+)' \| base64 --decode > "\$HOME\/\.boxignore"/
      .exec(script)?.[1];
    expect(encodedBoxIgnore).toBeTruthy();
    expect(Buffer.from(encodedBoxIgnore!, "base64").toString("utf8"))
      .toContain(".companion/runtime/state/control-bundle-v1.json");
    expect(Buffer.from(encodedBoxIgnore!, "base64").toString("utf8"))
      .toContain(".companion/runtime/control-transaction-v1/");
    expect(Buffer.from(encodedBoxIgnore!, "base64").toString("utf8"))
      .toContain(".companion/runtime/routines/");

    for (const spec of [
      "npm:pi-mcp-adapter@2.12.1",
      "npm:pi-web-access@0.24.0",
      "npm:pi-subagents@0.51.0",
      "npm:pi-memory@0.4.2",
    ]) {
      expect(script).toContain(`"$pi_bin" install '${spec}'`);
    }
    // Semantic search is an optimization for memory, so its install may not end a staging: it runs
    // outside `set -e` and reports on stdout, which Box does not promote to a setup failure.
    expect(script).toContain(
      `npm install --global --prefix "$HOME/.companion/tools" '@tobilu/qmd@2.8.3'`,
    );
    expect(script).toMatch(/set \+e\nnpm install --global/);
    expect(script).not.toMatch(/npm install --global[^\n]*>&2/);
    // Memory has to survive one Pi restart and one Box wake, so it lives on the persistent disk.
    expect(script).toContain('export PI_MEMORY_DIR="$root/memory"');
    // Jiti's compiled extension cache must survive /tmp being discarded on archive/resume, and the
    // image bake pre-populates it once instead of charging the first user message.
    expect(script).toContain('export TMPDIR="$root/tmp"');
    expect(script).toContain("export JITI_RESPECT_TMPDIR_ENV=1");
    expect(script).toContain('timeout 90 "$pi_bin" --help');
    expect(script).toContain("pi-startup-cache.version");
    expect(script).toContain('!= "$expected_layout"');
    expect(script).toContain('"$expected_layout" > "$startup_cache_marker"');
    // Pi stays first while audited Companion wrappers precede system GitHub tooling.
    expect(script).toContain(
      'PATH="$(dirname "$PI_BIN"):$HOME/.companion/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.companion/tools/bin"',
    );
    expect(script).toContain('if [ ! -x "$NODE_BIN" ]; then');
    expect(script).toContain('NODE_BIN="$(command -v node 2>/dev/null || true)"');
    // npm's own words never reach stdout, which is what the control plane falls back to for the
    // reason a later step failed.
    expect(script).not.toContain("awk 'NF { line=$0 } END { print line }' \"$qmd_log\"");
  });

  it("keeps Pi's credential-bearing configuration directory owner-only", async () => {
    const script = await stagedLayoutScript();
    const overlayStart = script.indexOf("companion_layout_apply_overlay() {");
    const overlayEnd = script.indexOf("\n}", overlayStart);
    const overlay = script.slice(overlayStart, overlayEnd);

    expect(overlay).toContain('mkdir -p "$HOME/.companion/bin" "$HOME/.companion/pi"');
    expect(overlay).toContain('chmod 700 "$HOME/.companion/pi"');
    expect(overlay.indexOf('chmod 700 "$HOME/.companion/pi"'))
      .toBeLessThan(overlay.indexOf('> "$HOME/.boxignore"'));
  });

  it("lets a contained runtime inject models.json without changing the production default", async () => {
    const modelsJsonProvider = vi.fn((providerId: string | undefined, modelId: string) => (
      `${JSON.stringify({ providers: { local: { providerId, modelId } } })}\n`
    ));

    await stagedLayoutScript({}, [], undefined, [], { modelsJsonProvider });

    expect(modelsJsonProvider).toHaveBeenCalledExactlyOnceWith(undefined, "glm-4.6");
    expect(stagedFiles.get(COMPANION_PI_MODELS_PATH)).toBe(
      `${JSON.stringify({ providers: { local: { modelId: "glm-4.6" } } })}\n`,
    );

    await stagedLayoutScript();
    expect(stagedFiles.get(COMPANION_PI_MODELS_PATH)).toBe(
      `${JSON.stringify({ providers: {} }, null, 2)}\n`,
    );
  });

  // Full Turbo quality runs many workspaces concurrently; keep the syntax guard deterministic
  // without coupling it to Vitest's five-second default under runner contention.
  it("is a script bash can parse, with and without the optional install", async () => {
    // The layout script is generated from a template literal, so no shell linter in CI ever sees
    // it. A quoting slip in it is a Box that fails every staging, which is every message.
    const variants: Array<Record<string, string>> = [
      {},
      { COMPANION_PI_INSTALL_COMMAND: "curl -fsSL https://pi.test/install | bash" },
    ];
    for (const env of variants) {
      const script = await stagedLayoutScript(env);
      const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(parsed.stderr).toBe("");
      expect(parsed.status).toBe(0);
    }
  }, 15_000);

  it("keeps the production relayout deadline fixed while allowing a bounded Box Lab override", async () => {
    await stagedLayoutScript();

    // The marker is written only after the install finishes. A budget that stops it short is a Box
    // that repeats the same work on every wake and can never record it.
    expect(layoutCommands).toEqual([
      expect.objectContaining({ timeoutSeconds: 300 }),
    ]);

    await stagedLayoutScript({}, [], undefined, [], {
      boxLabPiLayoutCommandTimeoutSeconds: 900,
    });
    expect(layoutCommands).toEqual([
      expect.objectContaining({ timeoutSeconds: 900 }),
    ]);
  });

  it.each([0, 1.5, 901])("rejects an unsafe Box Lab relayout deadline (%s)", (timeoutSeconds) => {
    expect(() => new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
    }, {
      boxLabPiLayoutCommandTimeoutSeconds: timeoutSeconds,
    })).toThrow("boxLabPiLayoutCommandTimeoutSeconds must be an integer between 1 and 900");
  });

  it("stages token-on-demand Git and gh helpers only for one brokered GitHub account", async () => {
    await stagedLayoutScript();
    expect(stagedFiles.get(".companion/bin/git-credential-github")).toBeUndefined();

    await stagedLayoutScript({}, [], undefined, [githubBrokerAccount()]);
    const helper = stagedFiles.get(".companion/bin/git-credential-github");
    const wrapper = stagedFiles.get(".companion/bin/gh");
    expect(helper).toContain("protocol=https");
    expect(helper).toContain("host=github.com");
    expect(helper).toContain("$COMPANION_MCP_GATEWAY_ORIGIN/git/");
    expect(helper).not.toContain("GITHUB_TOKEN");
    expect(wrapper).toContain('GH_TOKEN="$token" exec');
    expect(layoutCommands.some((command) => command.command.includes("credential.helper"))).toBe(true);
  });

  it("makes every pin part of the layout marker, so an existing Box relayouts on its next wake", async () => {
    // The marker is the whole update system: changing a pin is what a Box holding the old one
    // cannot short-circuit past. Overlay is hashed separately so a broker change does not reinstall
    // packages.
    const identity = companionPiLayoutIdentity({
      layoutVersion: 14,
      packages: resolvePiPackages({}),
      qmdPackage: "@tobilu/qmd@2.8.3",
      minimumPiVersion: "0.84.2",
    });
    const script = await stagedLayoutScript();
    expect(script).toContain(`base_layout='${identity.baseMarker}'`);
    expect(script).toContain(`expected_layout='${identity.fullMarker}'`);
    expect(script).toContain("companion-layout-unchanged");
    expect(script).toContain("companion-layout-overlay");
    expect(script).toContain("companion-layout-base");
    expect(script.indexOf("companion-layout-overlay"))
      .toBeLessThan(script.indexOf(`"$pi_bin" install`));
  });

  it("keeps image-only Companion skill identity out of the installed broker marker", async () => {
    const checksum = "sha256:companion-skill-contract";
    const script = await stagedLayoutScript({}, [], checksum);
    expect(script).not.toContain(checksum);
    expect(script).not.toContain(":skill=");
    expect(script).not.toContain(":boot=");
  });

  it("gives a deployment no way to drop what a Companion can do", async () => {
    // Web access, delegation, and memory are the Companion, not a deployment setting. The only pin
    // an environment can still move is the MCP adapter, which was configurable before any of this.
    const script = await stagedLayoutScript({
      COMPANION_PI_DEFAULT_PACKAGES: "none",
      COMPANION_PI_QMD_PACKAGE: "none",
    });

    for (const spec of [
      "npm:pi-web-access@0.24.0",
      "npm:pi-subagents@0.51.0",
      "npm:pi-memory@0.4.2",
    ]) {
      expect(script).toContain(`"$pi_bin" install '${spec}'`);
    }
    expect(script).toContain("npm install --global");
    expect(script).not.toContain("qmd=none");
    expect(resolvePiPackages({ COMPANION_PI_DEFAULT_PACKAGES: "none" }))
      .toEqual(resolvePiPackages({}));
  });

  it("refuses an adapter specification that is not a package name", () => {
    for (const spec of ["npm:pi-memory@0.4.2; rm -rf /", "$(id)", "pi memory", "a".repeat(201)]) {
      expect(() => new AsciiBoxCompanionRuntime({
        COMPANION_BOX_API_KEY: "box_test",
        COMPANION_PI_MCP_ADAPTER_PACKAGE: spec,
      })).toThrow(BoxRuntimeConfigurationError);
    }
    // A deployment that pinned a range before this existed keeps working.
    expect(resolvePiPackages({ COMPANION_PI_MCP_ADAPTER_PACKAGE: "npm:pi-mcp-adapter@^2.12.1" })[0])
      .toBe("npm:pi-mcp-adapter@^2.12.1");
  });

  // A presigned GET on the content-addressed key inside the skill-archives bucket, as
  // apps/runtime's presigner would mint it. The runtime treats it as an opaque input.
  const BUNDLE_URL =
    "https://fly.storage.tigris.dev/skill-archives/"
    + `${companionPiBundleObjectKey(COMPANION_PI_BUNDLE.sha256)}`
    + "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=deadbeef";
  const BUNDLE_ENV = { COMPANION_PI_BUNDLE_ENABLED: "true" };
  const BUNDLE_OPTIONS = { bundleUrlProvider: async () => BUNDLE_URL };

  it("rejects an injected bundle plan without a contained URL provider", () => {
    const injectedSha = "b".repeat(64);
    expect(() => new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box-key",
    }, {
      bundlePlan: {
        objectKey: `pi-bundles/box-lab-${injectedSha}.tar.gz`,
        manifest: { ...COMPANION_PI_BUNDLE, sha256: injectedSha },
      },
    })).toThrow("bundlePlan requires bundleUrlProvider");
  });

  it("uses an injected bundle plan without enabling the production bundle flag", async () => {
    const injectedSha = "a".repeat(64);
    const bundlePlan: CompanionPiBundlePlan = {
      objectKey: `pi-bundles/box-lab-${injectedSha}.tar.gz`,
      manifest: {
        ...COMPANION_PI_BUNDLE,
        nodeMajor: 23,
        sha256: injectedSha,
      },
    };
    const script = await stagedLayoutScript(
      { COMPANION_PI_INSTALL_COMMAND: "curl -fsSL https://pi.test/install | bash" },
      [],
      undefined,
      [],
      { bundlePlan, bundleUrlProvider: async () => "http://box-lab.test/pi.tar.gz" },
    );

    expect(script).toContain("bundle_url='http://box-lab.test/pi.tar.gz'");
    expect(script).toContain(`bundle_sha='${injectedSha}'`);
    expect(script).toContain("bundle_node_major='23'");
    expect(script).toContain(`:bundle=${injectedSha.slice(0, 12)}`);
    expect(script).not.toContain(COMPANION_PI_BUNDLE.sha256);
    expect(script).not.toContain("https://pi.test/install");
  });

  it("downloads, verifies, and extracts the pinned bundle instead of installing npm at boot", async () => {
    const script = await stagedLayoutScript(BUNDLE_ENV, [], undefined, [], BUNDLE_OPTIONS);
    const distDir = `$HOME/.companion/dist/${companionPiBundleShaShort(COMPANION_PI_BUNDLE.sha256)}`;
    // The object key is content-addressed under the pi-bundles/ prefix of the shared bucket.
    expect(companionPiBundleObjectKey(COMPANION_PI_BUNDLE.sha256)).toBe(
      `pi-bundles/companion-pi-bundle-${companionPiBundleShaShort(COMPANION_PI_BUNDLE.sha256)}.tar.gz`,
    );
    // The download uses the injected presigned URL exactly, with retry.
    expect(script).toContain(`bundle_url='${BUNDLE_URL}'`);
    expect(script).toContain("curl -fsSL --retry 3 -o \"$bundle_archive\" \"$bundle_url\"");
    // The checksum is verified against the pin, then the tarball is extracted into its dist dir.
    expect(script).toContain(`bundle_sha='${COMPANION_PI_BUNDLE.sha256}'`);
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain(`tar -xzf "$bundle_archive" -C "$bundle_dir"`);
    expect(script).toContain(`bundle_dir="${distDir}"`);
    // Pi resolves from the bundle first, and the Node major is checked against the manifest.
    expect(script).toContain(`PATH="$bundle_dir/pi/bin:$PATH"`);
    expect(script).toContain(`bundle_node_major='${COMPANION_PI_BUNDLE.nodeMajor}'`);
    // The baked extensions and tools are placed into the persistent layout the daemon resolves.
    expect(script).toContain(`cp -a "$bundle_dir/pi-agent-dir/." "$HOME/.companion/pi/"`);
    expect(script).toContain(`cp -a "$bundle_dir/tools/." "$HOME/.companion/tools/"`);
    // Every registry install the npm path runs is gone.
    expect(script).not.toContain(`"$pi_bin" install`);
    expect(script).not.toContain("npm install --global");
    // The three failure markers are emitted for the download-and-verify sequence.
    for (const marker of [
      "companion-bundle-download-failed",
      "companion-bundle-checksum-mismatch",
      "companion-bundle-node-mismatch",
    ]) {
      expect(script).toContain(`echo '${marker}' >&2`);
    }
  });

  it("folds the bundle sha into the base layout marker so warm Boxes relayout once", async () => {
    const script = await stagedLayoutScript(BUNDLE_ENV, [], undefined, [], BUNDLE_OPTIONS);
    const shaShort = companionPiBundleShaShort(COMPANION_PI_BUNDLE.sha256);
    expect(script).toContain(`:bundle=${shaShort}'`);
    // The presigned URL is transport, never identity: it must not leak into any marker.
    expect(script).not.toContain(`:bundle=${BUNDLE_URL}`);
    // The install marker never carries a bundle segment, so identities never collide.
    const installScript = await stagedLayoutScript({
      COMPANION_PI_INSTALL_COMMAND: "curl -fsSL https://pi.test/install | bash",
    });
    expect(installScript).not.toContain(":bundle=");
  });

  it("lets the bundle win when both bundle mode and an install command are set", async () => {
    const script = await stagedLayoutScript(
      {
        ...BUNDLE_ENV,
        COMPANION_PI_INSTALL_COMMAND: "curl -fsSL https://pi.test/install | bash",
      },
      [],
      undefined,
      [],
      BUNDLE_OPTIONS,
    );
    expect(script).toContain("tar -xzf \"$bundle_archive\" -C \"$bundle_dir\"");
    expect(script).not.toContain("https://pi.test/install");
    expect(script).toContain(":bundle=");
  });

  it("keeps the escape hatch when bundle mode is enabled without a URL provider", async () => {
    // S3 credentials absent → apps/runtime injects no provider → the flag alone changes nothing,
    // and the identity carries no bundle segment so the marker matches the installed layout.
    const script = await stagedLayoutScript({
      ...BUNDLE_ENV,
      COMPANION_PI_INSTALL_COMMAND: "curl -fsSL https://pi.test/install | bash",
    });
    expect(script).toContain("$pi_install_script");
    expect(script).not.toContain("bundle_dir=");
    expect(script).not.toContain(":bundle=");
  });

  it("mints a fresh presigned URL for every layout script generation", async () => {
    let minted = 0;
    const options = {
      bundleUrlProvider: async () => `${BUNDLE_URL}&X-Amz-Date=2026${(minted += 1)}`,
    };
    const first = await stagedLayoutScript(BUNDLE_ENV, [], undefined, [], options);
    const second = await stagedLayoutScript(BUNDLE_ENV, [], undefined, [], options);
    expect(minted).toBe(2);
    expect(first).toContain("X-Amz-Date=20261");
    expect(second).toContain("X-Amz-Date=20262");
    expect(second).not.toContain("X-Amz-Date=20261");
  });

  it("keeps the escape-hatch install exactly as it is when no bundle is configured", async () => {
    const script = await stagedLayoutScript({
      COMPANION_PI_INSTALL_COMMAND: "curl -fsSL https://pi.test/install | bash",
    });
    expect(script).toContain("$pi_install_script");
    expect(script).not.toContain("bundle_dir=");
    expect(script).not.toContain("companion-bundle-download-failed");
    for (const spec of resolvePiPackages({})) {
      expect(script).toContain(`"$pi_bin" install '${spec}'`);
    }
  });

  it("is a script bash can parse in bundle mode", async () => {
    const script = await stagedLayoutScript(BUNDLE_ENV, [], undefined, [], BUNDLE_OPTIONS);
    const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
  });

  it("maps each bundle stderr marker to its stable code and never writes the layout marker", async () => {
    const cases: Array<{ marker: string; code: string }> = [
      { marker: "companion-bundle-download-failed", code: "pi_bundle_download_failed" },
      { marker: "companion-bundle-checksum-mismatch", code: "pi_bundle_checksum_mismatch" },
      { marker: "companion-bundle-node-mismatch", code: "pi_bundle_node_mismatch" },
    ];
    for (const { marker, code } of cases) {
      const stagedPaths: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const method = init?.method ?? "GET";
        if (url.endsWith("/boxes/bx_23456789") && method === "GET") return response({ box: box("ready") });
        if (url.endsWith("/files") && method === "PUT") {
          stagedPaths.push(requiredText(parseBoxTestBody(init?.body), "path"));
          return response({ ok: true });
        }
        if (url.endsWith("/commands") && method === "POST") {
          const command = requiredText(parseBoxTestBody(init?.body), "command");
          if (/^\s*bash\s/.test(command) && command.includes("ensure-pi-layout.sh")) {
            return response({ success: false, exitCode: 1, stdout: "", stderr: `${marker}\n` });
          }
          return response(commandResult("companion-box-runnable\n"));
        }
        throw new Error(`unexpected Box request: ${method} ${url}`);
      }));

      const runtime = new AsciiBoxCompanionRuntime(
        {
          COMPANION_BOX_API_KEY: "box_test",
          COMPANION_PI_BUNDLE_ENABLED: "true",
        },
        BUNDLE_OPTIONS,
      );
      await expect(runtime.stageExistingBox({
        companionId: "11111111-1111-4111-8111-111111111111",
        runtimeGeneration: 1,
        orgId: "22222222-2222-4222-8222-222222222222",
        boxId: "bx_23456789",
        clientSurface: "web",
        providerAuth: {},
        replaceProviderAuth: false,
        modelId: "glm-4.6",
        mcpCredentials: [],
        mcpAccounts: [],
        skills: [],
      })).rejects.toMatchObject({ stableCode: code });
      // The Box never records a layout version on a failed download, so its next wake relayouts.
      expect(stagedPaths).not.toContain(".companion/runtime/state/pi-layout.version");
    }
  });
});

describe("staged Companion instructions", () => {
  it("stages the concise delivery contract for chats and routine returns", () => {
    for (const text of [composedInstructions(), composedRoutineInstructions()]) {
      expect(text).toContain("Give updates in one short sentence.");
      expect(text).toContain("Skills Hub: companion 1.86.0 → 1.88.0. Everything else was already current.");
      expect(text).toContain("Use one-word acknowledgements such as Done or Sent.");
      expect(text).toContain("Never narrate process, apologize, prefix a reply");
      expect(text).toContain("with btw, or add filler when nothing changed beyond that fact.");
    }
  });

  it("always asks for direct links to specific resources", () => {
    for (const surface of ["web", "mobile_web", "native_mobile"] as const) {
      const text = composedInstructions(null, surface);
      expect(text).toContain("include a direct link whenever one exists");
      expect(text).toContain("Prefer GitHub URLs, official documentation, or the authoritative source.");
    }
  });

  it("always tells Pi how to show an image, with or without a persona", () => {
    expect(composedInstructions("Answer briefly.")).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
    expect(composedInstructions(null)).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
    expect(composedInstructions("   ")).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
    expect(composedInstructions("   ")).not.toContain("# This Companion");
  });

  it("places a persona exactly once, in the trailing section, and omits that section when absent", () => {
    const persona = "Answer briefly.";
    const withPersona = composedInstructions(persona);
    expect(withPersona.endsWith(`# This Companion\n\n${persona}\n`)).toBe(true);
    expect(withPersona.indexOf(persona)).toBe(withPersona.lastIndexOf(persona));
    expect(composedInstructions(null)).not.toContain("# This Companion");
    expect(composedInstructions(undefined)).not.toContain("# This Companion");
  });

  it("stages the same Skills Hub and control MCP capabilities on every first-party surface", () => {
    for (const surface of ["web", "mobile_web", "native_mobile"] as const) {
      const text = composedInstructions(null, surface);
      expect(text).toContain("Skills Hub");
      expect(text).toContain("companion-control");
      expect(text).toContain("- Plugins:");
      expect(text).toContain("- Routines:");
      expect(text).toContain("- Triggers:");
      expect(text).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
      expect(text).toContain("ask_user");
      expect(text).toContain("companion_request_trigger_change");
      expect(text).not.toContain("propose_config");
      expect(text).not.toContain("propose_routine");
      expect(text).not.toContain("propose_trigger");
    }
  });

  it("interpolates tool-run timeout constants rather than literals", () => {
    const text = composedInstructions();
    expect(text).toContain(
      `stopped after ${COMPANION_TOOL_RUN_TIMEOUT_MS / 1_000} seconds, or ${COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS / 60_000} minutes for shell commands and subagents`,
    );
    expect(text).toContain(
      `At most ${COMPANION_ROUTINE_MAX_PER_COMPANION} per Companion, at least ${COMPANION_ROUTINE_MIN_INTERVAL_MS / 60_000} minutes apart.`,
    );
    expect(text).toContain(
      `At most ${COMPANION_TRIGGER_MAX_PER_COMPANION} per Companion.`,
    );
  });

  it("describes the fixed per-turn time metadata without embedding a changing clock value", () => {
    const text = composedInstructions();
    expect(text).toContain("fixed-format Current time and User timezone block");
    expect(text).toContain("trusted runtime metadata");
    expect(text).not.toMatch(/Current time: \d{4}-\d{2}-\d{2}T/);
  });

  it("does not tell Pi that memory is wiped or that tool runs are invisible", () => {
    const text = composedInstructions();
    expect(text).toContain("~/.companion/runtime/memory");
    expect(text).toContain("Staging does not wipe it.");
    expect(text).toContain("~/.companion/pi and ~/.companion/runtime/state");
    expect(text).not.toContain("The person does not see your tool calls");
    expect(text).not.toContain("or your reasoning");
    expect(text).toContain("compact cards for each tool run");
    expect(text).toContain("collapsible block");
  });

  it("reserves ordinary assistant text for the user-facing answer", () => {
    const text = composedInstructions("Keep a warm, conversational voice.");
    expect(text).toContain("Ordinary assistant text is shown immediately as your reply.");
    expect(text).toContain("Do not use it to restate the request");
    expect(text).toContain("choose tools aloud");
    expect(text).toContain("narrate internal plans or progress checks");
    expect(text).toContain("structured reasoning when available, or omit it");
    expect(text).toContain("one user-facing");
    expect(text).toContain("answer after the tool work is complete");
    expect(text.endsWith("# This Companion\n\nKeep a warm, conversational voice.\n")).toBe(true);
  });
});

describe("Pi outbox manifest", () => {
  const digest = "a".repeat(64);

  function manifest(...lines: string[]): string {
    return [
      "companion-outbox-manifest-begin",
      ...lines,
      "companion-outbox-manifest-end",
      "",
    ].join("\n");
  }

  it("reads one entry per file and decodes its name", () => {
    const encoded = Buffer.from("plot 1.png", "utf8").toString("base64");
    expect(parseOutboxManifest(manifest(`${digest} 2048 ${encoded}`))).toEqual([{
      name: "plot 1.png",
      encodedName: encoded,
      byteSize: 2048,
      sha256: digest,
    }]);
  });

  it("ignores a shell banner outside the sentinels rather than reading it as content", () => {
    const encoded = Buffer.from("ok.png", "utf8").toString("base64");
    const stdout = ["motd: welcome", manifest(`${digest} 10 ${encoded}`), "bye"].join("\n");
    expect(parseOutboxManifest(stdout)).toHaveLength(1);
  });

  it("drops a line it cannot parse and a name that could escape the outbox", () => {
    expect(parseOutboxManifest(manifest(
      "not a manifest line",
      `${digest} 10 ${Buffer.from("../escape.png", "utf8").toString("base64")}`,
      `${digest} 10 ${Buffer.from("nested/deep.png", "utf8").toString("base64")}`,
    ))).toEqual([]);
  });

  it("reports a zero-byte file rather than hiding it", () => {
    // Dropping it here would make a failed or truncated Pi write invisible to everyone. The
    // harvester filters it and counts it as a shortfall instead.
    expect(parseOutboxManifest(manifest(
      `${digest} 0 ${Buffer.from("empty.png", "utf8").toString("base64")}`,
    ))).toEqual([expect.objectContaining({ name: "empty.png", byteSize: 0 })]);
  });

  it("refuses a response whose sentinels are missing", () => {
    expect(() => parseOutboxManifest("companion-outbox-manifest-begin\n")).toThrow(
      BoxRuntimeProviderError,
    );
  });
});

describe("Pi outbox transfer", () => {
  const bytes = Buffer.from("a PNG that spans more than one chunk".repeat(40), "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const encodedName = Buffer.from("plot.png", "utf8").toString("base64");

  function stubOutboxTransport(
    options: { truncateChunkTo?: number; timeouts?: number[] } = {},
  ) {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (!url.endsWith("/commands")) throw new Error(`unexpected Box request: ${url}`);
      const sent = parseBoxTestBody(init?.body);
      const command = requiredText(sent, "command");
      commands.push(command);
      options.timeouts?.push(requiredNumber(sent, "timeoutSeconds"));
      const chunk = /bs=(\d+)/.exec(command);
      const skip = /skip=(\d+)/.exec(command);
      if (!chunk?.[1] || !skip?.[1]) throw new Error("not a chunk read");
      const size = Number(chunk[1]);
      const slice = bytes.subarray(Number(skip[1]) * size, (Number(skip[1]) + 1) * size);
      const body = options.truncateChunkTo === undefined
        ? slice
        : slice.subarray(0, options.truncateChunkTo);
      return response(commandResult([
        "companion-outbox-chunk-begin",
        body.toString("base64"),
        "companion-outbox-chunk-end",
        "",
      ].join("\n")));
    }));
    return commands;
  }

  it("reassembles a file from its chunks and proves it against the manifest digest", async () => {
    stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const file = await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
    });

    expect(file.bytes.equals(bytes)).toBe(true);
  });

  it("gives up on a file whose chunks keep arriving truncated instead of storing them", async () => {
    // The command transport has a demonstrated habit of mangling large bodies. A short chunk still
    // decodes as valid base64, so only the whole-file digest catches it.
    const commands = stubOutboxTransport({ truncateChunkTo: 16 });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
    })).rejects.toThrow(BoxRuntimeProviderError);
    expect(commands.length).toBeGreaterThan(0);
  });

  it("never lets a Pi-chosen filename reach a shell", async () => {
    const commands = stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });
    const hostile = Buffer.from("a\"; rm -rf ~; echo \".png", "utf8").toString("base64");

    await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "ignored", encodedName: hostile, byteSize: bytes.byteLength, sha256: digest },
    }).catch(() => undefined);

    // The command carries the name as base64 and decodes it on the Box, so nothing quotable travels.
    expect(commands[0]).toContain(hostile);
    expect(commands[0]).not.toContain("rm -rf ~");
  });

  it("recovers a chunk that arrives mangled once, without abandoning the file", async () => {
    // Truncation is the transport's known failure mode, and a short chunk still decodes as valid
    // base64 -- so the retry has to be driven by the whole-file digest, and it has to actually retry.
    let firstChunkReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const command = requiredText(parseBoxTestBody(init?.body), "command");
      const size = Number(/bs=(\d+)/.exec(command)![1]);
      const skip = Number(/skip=(\d+)/.exec(command)![1]);
      const slice = bytes.subarray(skip * size, (skip + 1) * size);
      const mangled = skip === 0 && ++firstChunkReads === 1;
      return response(commandResult([
        "companion-outbox-chunk-begin",
        (mangled ? slice.subarray(0, 8) : slice).toString("base64"),
        "companion-outbox-chunk-end",
        "",
      ].join("\n")));
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const file = await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
    });

    expect(file.bytes.equals(bytes)).toBe(true);
    expect(firstChunkReads).toBe(2);
  });

  it("stops reading once the harvest budget is spent", async () => {
    // The budget has to bound the retries, not just the gaps between chunks: three 120s command
    // attempts on one hung chunk would otherwise hold a settled turn far past it.
    const commands = stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
      deadlineAt: new Date(Date.now() - 1),
    })).rejects.toThrow(BoxRuntimeProviderError);
    expect(commands).toHaveLength(0);
  });

  it("shrinks a read's own timeout to what is left of the budget", async () => {
    // Checking the deadline between attempts is not enough: an attempt that starts one second inside
    // it would still run a 120s command, so a hung read holds the settled turn -- and its
    // "replying..." state -- two minutes past the bound the caller derived from its lease authority.
    const timeouts: number[] = [];
    stubOutboxTransport({ timeouts });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
      deadlineAt: new Date(Date.now() + 8_000),
    });

    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeout of timeouts) expect(timeout).toBeLessThanOrEqual(8);
  });

  it("refuses an entry whose encoded name is not base64", async () => {
    stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "x", encodedName: "not base64!", byteSize: 1, sha256: digest },
    })).rejects.toThrow(BoxRuntimeProviderError);
  });
});

describe("Pi outbox maintenance", () => {
  function stubCommands(result: { success: boolean } = { success: true }) {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (!url.endsWith("/commands")) throw new Error(`unexpected Box request: ${url}`);
      commands.push(requiredText(parseBoxTestBody(init?.body), "command"));
      return result.success
        ? response(commandResult())
        : response({ success: false, exitCode: 1, stdout: "", stderr: "refused" });
    }));
    return commands;
  }

  it("creates the outbox and empties it, so a harvest can only find this turn's files", async () => {
    const commands = stubCommands();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.clearOutbox({ boxId: "bx_23456789" });

    // mkdir before delete: a Box provisioned before the outbox existed gains it here rather than
    // needing a forced restage.
    expect(commands[0]).toContain('mkdir -p "$dir"');
    expect(commands[0]).toContain('find "$dir" -mindepth 1 -delete');
  });

  it("fails loudly when the Box will not empty its outbox", async () => {
    stubCommands({ success: false });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.clearOutbox({ boxId: "bx_23456789" }))
      .rejects.toThrow(BoxRuntimeProviderError);
  });

  it("fails loudly when the Box will not list its outbox", async () => {
    stubCommands({ success: false });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.listOutbox({ boxId: "bx_23456789" }))
      .rejects.toThrow(BoxRuntimeProviderError);
  });
});

describe("isolated routine Pi sessions", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const invocationId = `routine:${runId}:dispatch-v2:22222222-2222-4222-8222-222222222222`;

  it("rejects a non-UUID run id before contacting the Box", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId: "../main",
      persona: null,
      expectedInvocationId: invocationId,
    })).rejects.toMatchObject({
      status: 400,
      code: "routine_run_id_invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unversioned start identity before contacting the Box", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: null,
      expectedInvocationId: `routine:${runId}:legacy`,
    })).rejects.toMatchObject({ code: "routine_invocation_id_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stages surface_to_main only in the run root and launches separate broker paths", async () => {
    const commands: string[] = [];
    const files: Array<{ path: string; content: string }> = [];
    const paths = companionPiRoutineSessionPaths(runId);
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = parseBoxTestBody(init?.body);
      if (url.endsWith("/files") && init?.method === "PUT") {
        files.push({ path: requiredText(body, "path"), content: requiredText(body, "content") });
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        const command = requiredText(body, "command");
        commands.push(command);
        if (command.includes("routine-pi-session-prepared")) {
          return response(commandResult("routine-pi-session-prepared\n"));
        }
        if (command.includes("routine-pi-session-ready")) {
          const invocation = /export COMPANION_PI_INVOCATION_ID='([^']+)'/.exec(command)?.[1];
          if (!invocation) throw new Error("routine launch did not include its invocation id");
          return response(commandResult(`routine-pi-session-ready ${invocation}\n`));
        }
        return response(commandResult());
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: "Routine persona.",
      validationOnly: true,
      expectedInvocationId: invocationId,
    })).resolves.toMatchObject({
      state: "idle",
    });

    expect(files).toEqual([
      {
        path: `${paths.root}/state/instructions.txt`,
        content: composedTriggerValidationInstructions("Routine persona."),
      },
      { path: paths.extension, content: COMPANION_PI_ROUTINE_SURFACE_EXTENSION_SOURCE },
    ]);
    expect(files[1]?.content).toContain('name: "surface_to_main"');
    expect(files[1]?.content).toContain("Use one short sentence with no process narration.");
    expect(files[1]?.content).toContain('enum: ["relay", "notify"]');
    expect(files[1]?.content).not.toContain('from "typebox"');
    expect(files.some((file) => file.path === `.companion/pi/extensions/${COMPANION_PI_ROUTINE_SURFACE_EXTENSION_FILE}`))
      .toBe(false);
    expect(commands[0]).toContain(`routine_root="$HOME/${paths.root}"`);
    expect(commands[0]).not.toContain('cp -a "$HOME/.companion/pi/." "$routine_root/pi/"');
    expect(commands[0]).toContain('cp -p "$HOME/.companion/pi/auth.json" "$routine_root/pi/auth.json"');
    expect(commands[0]).not.toContain("mcp-accounts.json");
    expect(commands[0]).toContain("routine-pi-session run root is still owned by a process");
    expect(commands[0]).toContain("trap cleanup_failed_prepare ERR");
    expect(commands[0]).toContain("flock -w 20 9");
    expect(commands[0]).toContain(`reservation_file="$HOME/${paths.reservation}"`);
    expect(commands[0]).toContain('rm -f "$routine_cancel_marker"');
    const launch = commands.at(-1)!;
    expect(launch).toContain(`socket="$HOME/${paths.socket}"`);
    expect(launch).toContain(`broker_script="$HOME/.companion/bin/companion-pi-broker.mjs"`);
    expect(launch).toContain("routine-pi-session could not be stopped after readiness timeout");
    expect(launch).toContain("# The cancellation marker may be published");
    expect(launch).toContain('"$broker_script" 9>&- </dev/null');
    expect(launch).toContain("export COMPANION_PI_VALIDATION_ONLY=1");
    expect(launch).not.toContain("companion/providers.env");
    expect(launch).toContain('rm -rf "$routine_root"');
    expect(launch).not.toContain("systemctl --user");
    // Terminate publishes its tombstone before waiting for the launch lock. A launch already
    // holding that lock must observe the marker at its pre-spawn/readiness checks and must never
    // erase it as "stale"; stale replacement belongs solely to serialized prepare above.
    expect(launch).not.toContain('rm -f "$routine_cancel_marker"');
    expect(launch.lastIndexOf("\nacquire_routine_lock\n"))
      .toBeLessThan(launch.indexOf("# The cancellation marker may be published"));
    for (const command of commands) {
      expect(spawnSync("bash", ["-n"], { input: command, encoding: "utf8" })).toMatchObject({
        status: 0,
        stderr: "",
      });
    }
  });

  it("stages current capabilities without a Companion memory snapshot for direct workspace runs", async () => {
    const commands: string[] = [];
    const files: Array<{ path: string; content: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = parseBoxTestBody(init?.body);
      if (url.endsWith("/files") && init?.method === "PUT") {
        files.push({ path: requiredText(body, "path"), content: requiredText(body, "content") });
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        const command = requiredText(body, "command");
        commands.push(command);
        if (command.includes("routine-pi-session-prepared")) {
          return response(commandResult("routine-pi-session-prepared\n"));
        }
        if (command.includes("routine-pi-session-ready")) {
          return response(commandResult(`routine-pi-session-ready ${invocationId}\n`));
        }
        return response(commandResult());
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: "Routine persona.",
      validationOnly: false,
      directWorkspace: true,
      expectedInvocationId: invocationId,
    })).resolves.toMatchObject({ state: "idle", invocationId });

    expect(files[0]).toEqual(expect.objectContaining({
      content: composedRoutineInstructions("Routine persona."),
    }));
    const preparation = commands[0]!;
    expect(preparation).toContain('cp -a "$HOME/.companion/pi/." "$routine_root/pi/"');
    expect(preparation).toContain('cp -a "$HOME/.companion/runtime/skills" "$routine_root/skills"');
    expect(preparation).toContain('cp -a "$HOME/.companion/tools/." "$routine_root/tools/"');
    expect(preparation).toContain("mcp-accounts.json");
    expect(preparation).not.toContain("parent_memory=");
    expect(preparation).not.toContain("routine_memory=");
    const launch = commands.at(-1)!;
    expect(launch).toContain('provider_env="/run/user/$(id -u)/companion/providers.env"');
    expect(launch).not.toContain("COMPANION_PI_VALIDATION_ONLY=1");
  });

  it("pins the main Companion memory into the disposable routine root", async () => {
    const boxHome = mkdtempSync(join(tmpdir(), "companion-routine-memory-"));
    const parentMemory = join(boxHome, ".companion", "runtime", "memory");
    const parentDaily = join(parentMemory, "daily");
    const parentMemoryBytes = "# Durable memory\n\nThe launch code is cobalt.\n";
    const parentDailyBytes = "# 2026-08-28\n\nValidated the routine boundary.\n";
    const paths = companionPiRoutineSessionPaths(runId);
    const parentToolsBin = join(boxHome, ".companion", "tools", "bin");
    const hostToolsBin = join(boxHome, "host-tools");
    const commands: string[] = [];
    let preparedResult: ReturnType<typeof spawnSync> | null = null;

    mkdirSync(join(boxHome, ".companion", "pi", "extensions"), { recursive: true });
    mkdirSync(parentToolsBin, { recursive: true });
    mkdirSync(hostToolsBin, { recursive: true });
    writeFileSync(join(hostToolsBin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    mkdirSync(parentDaily, { recursive: true });
    writeFileSync(
      join(parentToolsBin, "qmd"),
      "#!/bin/sh\nprintf '%s\\n' \"$QMD_CONFIG_DIR\" \"$INDEX_PATH\" \"$@\"\n",
      { mode: 0o700 },
    );
    writeFileSync(join(parentMemory, "MEMORY.md"), parentMemoryBytes);
    writeFileSync(join(parentDaily, "2026-08-28.md"), parentDailyBytes);
    writeFileSync(join(boxHome, ".companion", "pi", "mcp.json"), JSON.stringify({
      mcpServers: {
        [COMPANION_CONTROL_MCP_SERVER_NAME]: { url: "http://127.0.0.1:1/control" },
        mail: { url: "http://127.0.0.1:1/mcp/mail" },
      },
    }));

    try {
      vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const body = parseBoxTestBody(init?.body);
        if (url.endsWith("/files") && init?.method === "PUT") return response({ ok: true });
        if (url.endsWith("/commands") && init?.method === "POST") {
          const command = requiredText(body, "command");
          commands.push(command);
          if (command.includes("routine-pi-session-prepared")) {
            const result = spawnSync("bash", ["-c", command], {
              encoding: "utf8",
              env: { ...process.env, HOME: boxHome, PATH: `${hostToolsBin}:${process.env.PATH ?? ""}` },
            });
            preparedResult = result;
            return response(commandResult(result.stdout));
          }
          if (command.includes("routine-pi-session-ready")) {
            return response(commandResult(`routine-pi-session-ready ${invocationId}\n`));
          }
          return response(commandResult());
        }
        throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
      }));
      const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

      await expect(runtime.startRoutineSession({
        boxId: "bx_23456789",
        runId,
        persona: null,
        expectedInvocationId: invocationId,
      })).resolves.toMatchObject({ state: "idle" });

      // Some Linux hosts deny reads of unrelated `/proc/*/environ` files before the shell can apply
      // the command's stderr redirect. That benign warning must not hide the preparation exit code.
      expect(preparedResult).toMatchObject({ status: 0 });
      const routineMemory = join(boxHome, paths.root, "memory");
      const routineMcp = JSON.parse(readFileSync(join(boxHome, paths.root, "pi", "mcp.json"), "utf8"));
      expect(readFileSync(join(routineMemory, "MEMORY.md"), "utf8")).toBe(parentMemoryBytes);
      expect(readFileSync(join(routineMemory, "daily", "2026-08-28.md"), "utf8"))
        .toBe(parentDailyBytes);
      expect(routineMcp.mcpServers).toEqual({ mail: { url: "http://127.0.0.1:1/mcp/mail" } });

      // The routine's memory directory is a copied run-local pin, never a link to the parent. Even
      // if pi-memory writes during the isolated session, the main Pi's authoritative bytes cannot
      // change and the disposable copy is removed with the run root.
      writeFileSync(join(routineMemory, "MEMORY.md"), "routine-only mutation\n");
      writeFileSync(join(routineMemory, "daily", "2026-08-28.md"), "routine-only daily mutation\n");
      expect(readFileSync(join(parentMemory, "MEMORY.md"), "utf8")).toBe(parentMemoryBytes);
      expect(readFileSync(join(parentDaily, "2026-08-28.md"), "utf8")).toBe(parentDailyBytes);
      expect(commands.at(-1)).toContain('export PI_MEMORY_DIR="$routine_root/memory"');
      expect(commands.at(-1)).toContain('export QMD_CONFIG_DIR="$routine_root/qmd/config"');
      expect(commands.at(-1)).toContain('export INDEX_PATH="$routine_root/qmd/index.sqlite"');
      expect(commands.at(-1)).toContain('export PATH="$routine_root/bin:');
      expect(commands.at(-1)).toContain("unset COMPANION_CONTROL_TOKEN");
      const prepareCommand = commands[0];
      if (!prepareCommand) throw new Error("routine preparation command was not captured");
      expect(prepareCommand).toContain('if [ -x "$routine_root/tools/bin/qmd" ]; then');
      expect(prepareCommand).toContain('if [ -L "$routine_root/pi/mcp.json" ]; then');

      const symlinkHome = mkdtempSync(join(tmpdir(), "companion-routine-mcp-symlink-"));
      const externalMcp = join(symlinkHome, "external-mcp.json");
      const externalBytes = JSON.stringify({ mcpServers: {
        [COMPANION_CONTROL_MCP_SERVER_NAME]: { url: "http://127.0.0.1:1/control" },
      } });
      try {
        mkdirSync(join(symlinkHome, ".companion", "pi", "extensions"), { recursive: true });
        mkdirSync(join(symlinkHome, ".companion", "runtime"), { recursive: true });
        writeFileSync(externalMcp, externalBytes);
        symlinkSync(externalMcp, join(symlinkHome, ".companion", "pi", "mcp.json"));

        const rejected = spawnSync("bash", ["-c", prepareCommand], {
          encoding: "utf8",
          env: { ...process.env, HOME: symlinkHome, PATH: `${hostToolsBin}:${process.env.PATH ?? ""}` },
        });

        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain("routine-pi-session mcp config is a symlink");
        expect(readFileSync(externalMcp, "utf8")).toBe(externalBytes);
        expect(existsSync(join(symlinkHome, paths.root))).toBe(false);
      } finally {
        rmSync(symlinkHome, { recursive: true, force: true });
      }

      const routineRoot = join(boxHome, paths.root);
      const qmd = spawnSync(join(routineRoot, "bin", "qmd"), ["collection", "list"], {
        encoding: "utf8",
        env: { ...process.env, COMPANION_PI_ROOT: routineRoot },
      });
      expect(qmd).toMatchObject({
        status: 0,
        stderr: "",
        stdout: [
          join(routineRoot, "qmd", "config"),
          join(routineRoot, "qmd", "index.sqlite"),
          "--index",
          "companion-routine",
          "collection",
          "list",
          "",
        ].join("\n"),
      });
    } finally {
      rmSync(boxHome, { recursive: true, force: true });
    }
  });

  it("leaves qmd unavailable when its best-effort installation is absent", async () => {
    const boxHome = mkdtempSync(join(tmpdir(), "companion-routine-no-qmd-"));
    const hostToolsBin = join(boxHome, "host-tools");
    const paths = companionPiRoutineSessionPaths(runId);
    let preparedResult: ReturnType<typeof spawnSync> | null = null;

    mkdirSync(join(boxHome, ".companion", "pi", "extensions"), { recursive: true });
    mkdirSync(hostToolsBin, { recursive: true });
    writeFileSync(join(hostToolsBin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    try {
      vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const body = parseBoxTestBody(init?.body);
        if (url.endsWith("/files") && init?.method === "PUT") return response({ ok: true });
        if (url.endsWith("/commands") && init?.method === "POST") {
          const command = requiredText(body, "command");
          if (command.includes("routine-pi-session-prepared")) {
            const result = spawnSync("bash", ["-c", command], {
              encoding: "utf8",
              env: { ...process.env, HOME: boxHome, PATH: `${hostToolsBin}:${process.env.PATH ?? ""}` },
            });
            preparedResult = result;
            return response(commandResult(result.stdout));
          }
          if (command.includes("routine-pi-session-ready")) {
            return response(commandResult(`routine-pi-session-ready ${invocationId}\n`));
          }
          return response(commandResult());
        }
        throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
      }));
      const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

      await expect(runtime.startRoutineSession({
        boxId: "bx_23456789",
        runId,
        persona: null,
        expectedInvocationId: invocationId,
      })).resolves.toMatchObject({ state: "idle" });

      expect(preparedResult).toMatchObject({ status: 0 });
      expect(existsSync(join(boxHome, paths.root, "bin", "qmd"))).toBe(false);
    } finally {
      rmSync(boxHome, { recursive: true, force: true });
    }
  });

  it("accepts a readiness marker the Box runner reports as exit 1 without cleaning up", async () => {
    // The Box command runner reports exit 1 for any script that leaves a detached daemon child
    // behind, even when the script itself reached `exit 0`. The launch script prints its readiness
    // acknowledgement only after the broker socket exists, so the marker outranks the exit code.
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/files") && init?.method === "PUT") {
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        const command = requiredText(parseBoxTestBody(init?.body), "command");
        commands.push(command);
        if (command.includes("routine-pi-session-prepared")) {
          return response(commandResult("routine-pi-session-prepared\n"));
        }
        if (command.includes("routine-pi-session-ready")) {
          const invocation = /export COMPANION_PI_INVOCATION_ID='([^']+)'/.exec(command)?.[1];
          if (!invocation) throw new Error("routine launch did not include its invocation id");
          return response({
            success: false,
            exitCode: 1,
            stdout: `routine-pi-session-ready ${invocation}\n`,
            stderr: "",
          });
        }
        return response(commandResult());
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: null,
      expectedInvocationId: invocationId,
    })).resolves.toMatchObject({ state: "idle" });

    expect(commands).toHaveLength(3);
    expect(commands.at(-1)).toContain("routine-pi-session-ready");
    expect(commands.join("\n")).not.toContain("routine-pi-session-terminated");
  });

  it("recovers an already-running routine session when Box reports prepare as exit 1", async () => {
    const invocation = invocationId;
    const commands: string[] = [];
    const files = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/files")) {
        files();
        return response({ ok: true });
      }
      if (!url.endsWith("/commands") || init?.method !== "POST") {
        throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
      }
      const command = requiredText(parseBoxTestBody(init.body), "command");
      commands.push(command);
      return response({
        success: false,
        exitCode: 1,
        stdout: `routine-pi-session-already-running ${invocation}\n`,
        stderr: "",
      });
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: null,
      expectedInvocationId: invocation,
    })).resolves.toEqual({ state: "idle", invocationId: invocation });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("routine-pi-session-already-running");
    expect(commands[0]).not.toContain("routine-pi-session-terminated");
    expect(files).not.toHaveBeenCalled();
  });

  it("preserves a dead routine root for explicit reconciliation", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (!url.endsWith("/commands") || init?.method !== "POST") {
        throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
      }
      commands.push(requiredText(parseBoxTestBody(init.body), "command"));
      return response({
        success: false,
        exitCode: 1,
        stdout: "routine-pi-session-root-ambiguous\n",
        stderr: "routine-pi-session root exists without a live process\n",
      });
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: null,
      expectedInvocationId: invocationId,
    })).rejects.toMatchObject({ code: "routine_session_root_ambiguous" });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("routine-pi-session-root-ambiguous");
    expect(commands[0]).not.toContain("routine-pi-session-terminated");
  });

  it("removes the copied run root when pre-launch staging fails", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/files") && init?.method === "PUT") {
        return response({ error: "staging unavailable" }, 500);
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        const command = requiredText(parseBoxTestBody(init.body), "command");
        commands.push(command);
        if (command.includes("routine-pi-session-prepared")) {
          return response(commandResult("routine-pi-session-prepared\n"));
        }
        if (command.includes("routine-pi-session-terminated")) {
          return response(commandResult("routine-pi-session-terminated\n"));
        }
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: null,
      expectedInvocationId: invocationId,
    })).rejects.toThrow();

    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("routine-pi-session-terminated");
    expect(commands[1]).toContain('rm -rf "$routine_root"');
  });

  it("retries cleanup through the termination command when preparation fails", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (!url.endsWith("/commands") || init?.method !== "POST") {
        throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
      }
      const command = requiredText(parseBoxTestBody(init.body), "command");
      commands.push(command);
      if (commands.length === 1) {
        return response({ success: false, exitCode: 1, stdout: "", stderr: "copy failed" });
      }
      return response(commandResult("routine-pi-session-terminated\n"));
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.startRoutineSession({
      boxId: "bx_23456789",
      runId,
      persona: null,
      expectedInvocationId: invocationId,
    })).rejects.toMatchObject({ code: "routine_session_prepare_failed" });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("trap cleanup_failed_prepare ERR");
    expect(commands[1]).toContain("routine-pi-session-terminated");
  });

  it("terminates only the run-scoped process, proves it stopped, and removes its run root", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (!url.endsWith("/commands") || init?.method !== "POST") {
        throw new Error(`unexpected Box request: ${url}`);
      }
      const body = parseBoxTestBody(init.body);
      commands.push(requiredText(body, "command"));
      return response(commandResult("routine-pi-session-terminated\n"));
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.terminateRoutineSession({
      boxId: "bx_23456789",
      runId,
      expectedInvocationId: invocationId,
    })).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`pid_file="$HOME/${companionPiRoutineSessionPaths(runId).pid}"`);
    expect(commands[0]).toContain('kill -- -"$pid"');
    expect(commands[0]).toContain("signal_routine_root_processes TERM");
    expect(commands[0]).toContain("signal_routine_root_processes KILL");
    expect(commands[0]).toContain("routine-pi-session process survived termination");
    const ownershipGuard = commands[0]!.indexOf(
      'if [ ! -s "$reservation_file" ] && [ ! -s "$invocation_file" ]',
    );
    expect(ownershipGuard).toBeGreaterThan(-1);
    expect(commands[0]).toContain(
      '&& { [ -e "$routine_root" ] || [ -L "$routine_root" ]; }; then',
    );
    expect(ownershipGuard)
      .toBeGreaterThan(commands[0]!.lastIndexOf("\nacquire_routine_lock\n"));
    expect(ownershipGuard).toBeLessThan(commands[0]!.indexOf('rm -rf "$routine_root"'));
    expect(commands[0]!.indexOf("mv -f \"$cancel_marker_tmp\" \"$routine_cancel_marker\""))
      .toBeLessThan(commands[0]!.lastIndexOf("\nacquire_routine_lock\n"));
    expect(commands[0]).toContain('rm -rf "$routine_root"');
    expect(commands[0]).not.toContain("systemctl --user");
    expect(spawnSync("bash", ["-n"], { input: commands[0], encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
  });
});

describe("staged Companion attachments", () => {
  it("replaces the message directory, writes each file, and makes them read-only", async () => {
    const commands: string[] = [];
    const files: Array<{ path: string; encoding?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = parseBoxTestBody(init?.body);
      if (url.endsWith("/commands")) {
        commands.push(requiredText(body, "command"));
        return response(commandResult());
      }
      if (url.endsWith("/files")) {
        files.push({ path: requiredText(body, "path"), encoding: body.encoding });
        return response({ ok: true });
      }
      throw new Error(`unexpected Box request: ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const staged = await runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{
        position: 0,
        filename: "chart.png",
        contentType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    });

    expect(staged).toEqual([{
      position: 0,
      filename: "chart.png",
      contentType: "image/png",
      byteSize: 4,
      path: "~/attachments/66666666-6666-4666-8666-666666666666/0-chart.png",
    }]);
    // The whole staging root is replaced, so a previous message's files cannot accumulate.
    expect(commands[0]).toContain("rm -rf 'attachments'");
    expect(commands[0]).toContain("mkdir -p 'attachments/66666666-6666-4666-8666-666666666666'");
    expect(commands.at(-1)).toContain("chmod a-w");
    // Binary bytes cannot travel as a UTF-8 body, so the write is base64 whatever its size.
    expect(files).toEqual([{
      path: "attachments/66666666-6666-4666-8666-666666666666/0-chart.png",
      encoding: "base64",
    }]);
  });

  it("sends a payload whose base64 body would exceed the write limit as numbered parts", async () => {
    // The provider's limit is on the request body, and base64 is four bytes per three. A 4 MB
    // attachment is under the raw limit but over it once encoded, so it must take the parts path.
    const files: string[] = [];
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = parseBoxTestBody(init?.body);
      if (url.endsWith("/commands")) {
        commands.push(requiredText(body, "command"));
        return response(commandResult());
      }
      files.push(requiredText(body, "path"));
      // Nothing this adapter sends may exceed the provider's body limit once encoded.
      expect(requiredText(body, "content").length).toBeLessThan(5 * 1024 * 1024);
      return response({ ok: true });
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{
        position: 0,
        filename: "big.png",
        contentType: "image/png",
        bytes: Buffer.alloc(4 * 1024 * 1024, 7),
      }],
    });

    expect(files.filter((path) => path.includes(".part"))).not.toHaveLength(0);
    expect(commands.some((command) => command.includes("cat ") && command.includes(".part0")))
      .toBe(true);
  });

  it("locks the files without locking the directory it must clear on the next stage", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = parseBoxTestBody(init?.body);
      if (url.endsWith("/commands")) {
        commands.push(requiredText(body, "command"));
        return response(commandResult());
      }
      return response({ ok: true });
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{
        position: 0,
        filename: "chart.png",
        contentType: "image/png",
        bytes: Buffer.from([0x89, 0x50]),
      }],
    });

    // A recursive chmod would clear the directory's own write bit, and unlinking an entry needs
    // write on its directory -- so the next retry's `rm -rf` would fail and the message would
    // become permanently unsendable on a non-root Box user.
    const lock = commands.at(-1)!;
    expect(lock).toContain("-type f -exec chmod a-w");
    expect(lock).not.toContain("chmod -R a-w");
    // The staging root is replaced, so an earlier message's files cannot accumulate on the disk.
    expect(commands[0]).toContain("rm -rf 'attachments'");
  });

  it("refuses a message id or filename outside the stored charset", async () => {
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });
    const file = {
      position: 0,
      filename: "chart.png",
      contentType: "image/png",
      bytes: Buffer.alloc(1),
    };

    await expect(runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "../escape",
      files: [file],
    })).rejects.toThrow(BoxRuntimeProviderError);
    await expect(runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{ ...file, filename: "../escape.png" }],
    })).rejects.toThrow(BoxRuntimeProviderError);
  });
});

function box(state: "archived" | "ready" | "archiving" | "idle") {
  return {
    id: "bx_23456789",
    name: "Companion 11111111-1111-4111-8111-111111111111 g1",
    state,
    desktopAvailable: state === "ready",
    setupStatus: "done",
  };
}

function commandResult(stdout = "") {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function expectCleanupFailsWhenRmFails(command: string): void {
  const root = mkdtempSync(join(tmpdir(), "companion-cleanup-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "rm"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const result = spawnSync("bash", ["-c", command], {
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const boxTestBodySchema = z.object({
  command: z.string().optional(),
  content: z.string().optional(),
  encoding: z.string().optional(),
  path: z.string().optional(),
  timeoutSeconds: z.number().optional(),
}).passthrough();
type BoxTestBody = z.infer<typeof boxTestBodySchema>;

function parseBoxTestBody(rawBody: RequestInit["body"]): BoxTestBody {
  const parsed = boxTestBodySchema.safeParse(JSON.parse(String(rawBody)));
  if (!parsed.success) throw new Error("test request body is invalid");
  return parsed.data;
}

function requiredText(body: BoxTestBody, key: "command" | "content" | "path"): string {
  const value = body[key];
  if (value === undefined) throw new Error(`test request body is missing ${key}`);
  return value;
}

function requiredNumber(body: BoxTestBody, key: "timeoutSeconds"): number {
  const value = body[key];
  if (value === undefined) throw new Error(`test request body is missing ${key}`);
  return value;
}

function response(value: PiJsonObject, status = 200): Response {
  return Response.json(value, { status });
}

function decodeBrokerCommand(command: string): PiJsonObject {
  const encoded = /COMPANION_PI_BROKER_COMMAND='([A-Za-z0-9+/=]+)'/.exec(command)?.[1];
  if (!encoded) throw new Error("adapter did not send a layout-14 broker command");
  const parsed = z.record(z.string(), z.unknown()).safeParse(
    JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
  );
  if (!parsed.success) throw new Error("adapter sent an invalid broker command");
  return parsed.data;
}

function zeroCounters() {
  return {
    malformedLines: 0,
    oversizedLines: 0,
    unterminatedLines: 0,
    unknownEvents: 0,
    unboundEvents: 0,
    orphanResponses: 0,
  };
}
