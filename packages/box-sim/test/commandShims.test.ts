/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing simulator fixtures predate the incremental anti-slop gate. */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  appendPiEvent,
  classifyBoxCommand,
  createBoxSimCommandMachine,
  decodeShellQuoted,
  executeBoxCommand,
  extractBrokerJson,
  putBoxFile,
} from "../src/commandShims";
import type { BoxSimPiController } from "../src/protocol";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function brokerShell(command: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
  return `broker_socket="$HOME/.companion/runtime/state/pi-broker.sock"
test -S "$broker_socket"
COMPANION_PI_BROKER_COMMAND=${shellQuote(encoded)} node <<'COMPANION_PI_BROKER_CLIENT'`;
}

describe("semantic Box command shims", () => {
  it("classifies every adapter command family by stable semantic markers", () => {
    const commands: Array<[string, ReturnType<typeof classifyBoxCommand>]> = [
      ["printf '%s\\n' 'companion-box-runnable'", "box-runnable"],
      [
        "companion-box-runnable pi-layout.version companion-provider-auth-present",
        "staging-probe",
      ],
      ["systemctl --user is-active x; printf companion-pi-warm-ready", "warm-daemon-ready"],
      ['mkdir -p "$HOME/.companion/bin"', "mkdir-pi-bin"],
      ['bash "$HOME/.companion/bin/ensure-pi-layout.sh"', "install-layout"],
      ['recorded="$(cat "$HOME/.companion/runtime/state/pi-layout.version" 2>/dev/null || true)"\nif [ "$recorded" = \'14:pins:overlay=abc\' ] \\\n  && [ -x "$HOME/.companion/bin/companion-pi-broker.mjs" ]; then\n  printf \'%s\\n\' companion-layout-unchanged\nfi', "probe-layout"],
      [
        'test -s "$HOME/.companion/bin/companion-pi-broker.mjs"\n'
          + 'playbook="$HOME/.ascii/playbook.json"\n'
          + "printf '%s\\n' 'companion-runtime-playbook-ready'",
        "warm-runtime-image",
      ],
      ['mkdir -p "$HOME/.companion/pi/extensions"', "mkdir-extensions"],
      [
        'root="$HOME/.companion/runtime"; printf companion-provider-auth-present',
        "clear-skill-archives",
      ],
      ["companion-archive-bytes wc -c", "measure-skill-archives"],
      [
        `test "$(cat "$HOME/.companion/runtime/state/skills-tree.version" 2>/dev/null || true)" = '${"a".repeat(64)}'`,
        "match-skills-revision",
      ],
      ["cat '.part0' > '.target'; rm -f '.part0'", "join-file-parts"],
      ["skills.next base64 --decode tar --extract", "prepare-skills"],
      [
        // The registration script also runs daemon-reload, so its endpoint marker must win over the
        // credential/daemon-reload family regardless of classification order drift.
        "systemctl --user daemon-reload\nsystemctl --user start companion-box-agent.service\n"
          + "host 8790 --title companion-agent >/dev/null 2>&1 || true\n"
          + "companion_agent_url=\"$(host url 8790 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | tail -n 1)\"\n"
          + "printf 'companion-agent-endpoint %s\\n' \"$companion_agent_url\"",
        "agent-register",
      ],
      ["staged_credential_file=x; systemctl --user daemon-reload", "start-or-restart-daemon"],
      [
        "staged_credential_file=x; systemctl --user daemon-reload; companion-pi-broker-ready companion-pi-broker-unready",
        "start-or-restart-daemon",
      ],
      ["companion-pi-broker-ready companion-pi-broker-unready", "daemon-state"],
      [brokerShell({ id: "one", type: "prompt", attemptId: "attempt-1" }), "rpc-command"],
      [brokerShell({
        id: "decision-1",
        type: "extension_ui_response",
        response: { id: "question-1", type: "extension_ui_response", value: "yes" },
      }), "extension-ui-response"],
      ["companion-pi-journal companion-pi-restarts", "daemon-diagnostics"],
      [
        'bundle="$HOME/.companion/runtime/state/control-bundle-v1.json"; '
          + 'rm -f "$bundle"; rm -rf "$HOME/.companion/runtime/control-transaction-v1"',
        "remove-control-bundle",
      ],
      [
        'persistent="$HOME/.companion/runtime/state/providers.env"; '
          + 'runtime="/run/user/$(id -u)/companion/providers.env"; rm -f "$persistent" "$runtime"',
        "remove-provider-files",
      ],
      ["Pi daemon is still active after stop", "stop-daemon"],
    ];
    for (const [command, kind] of commands) expect(classifyBoxCommand(command)).toBe(kind);
    expect(classifyBoxCommand("uname -a")).toBe("unsupported");
  });

  it("removes a stale control bundle before Box archive", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const path = ".companion/runtime/state/control-bundle-v1.json";
    putBoxFile(machine, path, Buffer.from("secret-bearing-bundle"));
    const sidecar = ".companion/runtime/control-transaction-v1/0.previous";
    putBoxFile(machine, sidecar, Buffer.from("secret-bearing-backup"));

    await expect(executeBoxCommand(
      machine,
      'bundle="$HOME/.companion/runtime/state/control-bundle-v1.json"\n'
        + 'transaction="$HOME/.companion/runtime/control-transaction-v1"\n'
        + 'rm -f "$bundle"\nrm -rf "$transaction"',
    )).resolves.toMatchObject({ success: true });
    expect(machine.persistentFiles.has(path)).toBe(false);
    expect(machine.persistentFiles.has(sidecar)).toBe(false);
  });

  it("warms a staged runtime image only when its required files exist", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const command = 'test -s "$HOME/.companion/bin/companion-pi-broker.mjs"\n'
      + 'test -s "$HOME/.companion/runtime/image/companion-checksum.tar.gz.b64"\n'
      + 'playbook="$HOME/.ascii/playbook.json"\n'
      + "printf '%s\\n' 'companion-runtime-playbook-ready'";

    await expect(executeBoxCommand(machine, command)).resolves.toMatchObject({
      success: false,
    });
    putBoxFile(machine, ".companion/bin/companion-pi-broker.mjs", Buffer.from("broker"));
    putBoxFile(
      machine,
      ".companion/runtime/image/companion-checksum.tar.gz.b64",
      Buffer.from("archive"),
    );
    await expect(executeBoxCommand(machine, command)).resolves.toMatchObject({
      success: false,
    });
    putBoxFile(machine, ".ascii/playbook.json", Buffer.from('{"boot":"ready"}\n'));
    await expect(executeBoxCommand(machine, command)).resolves.toMatchObject({
      success: true,
      stdout: "companion-runtime-playbook-ready\n",
    });
  });

  it.each([
    ["unknown path", "outside/secret.env", Buffer.from("secret")],
    ["oversized file", ".companion/runtime/state/providers.env", Buffer.alloc(4 * 1024 * 1024 + 1)],
  ])("rejects a control bundle with an %s before applying any file", async (_case, badPath, badBytes) => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const bundlePath = ".companion/runtime/state/control-bundle-v1.json";
    const validBytes = Buffer.from("model");
    const entry = (path: string, bytes: Buffer) => ({
      path,
      mode: 0o600,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes.toString("base64"),
    });
    putBoxFile(machine, bundlePath, Buffer.from(JSON.stringify({
      revision: 1,
      files: [
        entry(".companion/runtime/state/model.txt", validBytes),
        entry(badPath, badBytes),
      ],
    })));

    const result = await executeBoxCommand(
      machine,
      "COMPANION_CONTROL_BUNDLE=x COMPANION_CONTROL_APPLY node",
    );

    expect(result.success).toBe(false);
    expect(machine.persistentFiles.has(".companion/runtime/state/model.txt")).toBe(false);
    expect(machine.persistentFiles.has(badPath)).toBe(false);
    expect(machine.persistentFiles.has(bundlePath)).toBe(false);
  });

  it("prints overlay vs base layout labels from the staged marker", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const script = [
      "#!/usr/bin/env bash",
      "base_layout='14:npm:pi-mcp-adapter@2.12.1:qmd=@tobilu/qmd@2.8.3:pi>=0.84.2'",
      "expected_layout='14:npm:pi-mcp-adapter@2.12.1:qmd=@tobilu/qmd@2.8.3:pi>=0.84.2:overlay=aaaaaaaaaaaaaaaa'",
    ].join("\n");
    putBoxFile(machine, ".companion/bin/ensure-pi-layout.sh", Buffer.from(script));

    expect(await executeBoxCommand(machine, 'bash "$HOME/.companion/bin/ensure-pi-layout.sh"'))
      .toMatchObject({ success: true, stdout: "companion-layout-base\n" });
    expect(await executeBoxCommand(machine, 'bash "$HOME/.companion/bin/ensure-pi-layout.sh"'))
      .toMatchObject({ success: true, stdout: "companion-layout-unchanged\n" });

    putBoxFile(
      machine,
      ".companion/bin/ensure-pi-layout.sh",
      Buffer.from(script.replace("overlay=aaaaaaaaaaaaaaaa", "overlay=bbbbbbbbbbbbbbbb")),
    );
    expect(await executeBoxCommand(machine, 'bash "$HOME/.companion/bin/ensure-pi-layout.sh"'))
      .toMatchObject({ success: true, stdout: "companion-layout-overlay\n" });
  });

  it("fails a bundle-mode layout with a fixed marker and writes no layout file on an injected fault", async () => {
    const bundleScript = [
      "#!/usr/bin/env bash",
      "base_layout='14:npm:pi-mcp-adapter@2.12.1:qmd=@tobilu/qmd@2.8.3:pi>=0.84.2:bundle=abcdef012345'",
      "expected_layout='14:npm:pi-mcp-adapter@2.12.1:qmd=@tobilu/qmd@2.8.3:pi>=0.84.2:bundle=abcdef012345:overlay=aaaaaaaaaaaaaaaa'",
      "bundle_url='https://skill-archives.example/pi-bundles/companion-pi-bundle-abcdef012345.tar.gz?X-Amz-Expires=3600&X-Amz-Signature=deadbeef'",
    ].join("\n");
    const cases: Array<["download" | "checksum" | "node", string]> = [
      ["download", "companion-bundle-download-failed"],
      ["checksum", "companion-bundle-checksum-mismatch"],
      ["node", "companion-bundle-node-mismatch"],
    ];
    for (const [fault, marker] of cases) {
      const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
      machine.bundleDownloadFault = fault;
      putBoxFile(machine, ".companion/bin/ensure-pi-layout.sh", Buffer.from(bundleScript));
      const result = await executeBoxCommand(machine, 'bash "$HOME/.companion/bin/ensure-pi-layout.sh"');
      expect(result.success).toBe(false);
      expect(result.stderr.trim().split(/\r?\n/).at(-1)).toBe(marker);
      expect(machine.persistentFiles.has(".companion/runtime/state/pi-layout.version")).toBe(false);
    }
  });

  it("installs a bundle-mode layout normally when no download fault is injected", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const bundleScript = [
      "#!/usr/bin/env bash",
      "base_layout='14:npm:pi-mcp-adapter@2.12.1:qmd=@tobilu/qmd@2.8.3:pi>=0.84.2:bundle=abcdef012345'",
      "expected_layout='14:npm:pi-mcp-adapter@2.12.1:qmd=@tobilu/qmd@2.8.3:pi>=0.84.2:bundle=abcdef012345:overlay=aaaaaaaaaaaaaaaa'",
      "bundle_url='https://skill-archives.example/pi-bundles/companion-pi-bundle-abcdef012345.tar.gz?X-Amz-Expires=3600&X-Amz-Signature=deadbeef'",
    ].join("\n");
    putBoxFile(machine, ".companion/bin/ensure-pi-layout.sh", Buffer.from(bundleScript));
    expect(await executeBoxCommand(machine, 'bash "$HOME/.companion/bin/ensure-pi-layout.sh"'))
      .toMatchObject({ success: true, stdout: "companion-layout-base\n" });
    expect(machine.persistentFiles.has(".companion/runtime/state/pi-layout.version")).toBe(true);
  });

  it("round-trips the adapter's POSIX quoting, including apostrophes", () => {
    const payload = { id: "req-1", type: "prompt", message: "don't execute this" };
    expect(decodeShellQuoted(shellQuote("don't"))).toBe("don't");
    expect(extractBrokerJson(brokerShell(payload))).toEqual(payload);
  });

  it("models the fused layout and preserve-Skills staging probe", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const layoutMarker = "14:pins:overlay=staging-probe";
    const skillsDigest = "a".repeat(64);
    const files: Array<[string, string]> = [
      [".companion/runtime/state/pi-layout.version", `${layoutMarker}\n`],
      [".companion/bin/companion-pi-broker.mjs", "broker"],
      [".companion/bin/pi-daemon", "daemon"],
      [".config/systemd/user/companion-pi-daemon.service", "service"],
      [".companion/runtime/state/skills-tree.version", `${skillsDigest}\n`],
      [".companion/runtime/state/skill-archives/stale.tar.gz.b64", "stale"],
      [".companion/pi/auth.json", "secret auth"],
    ];
    for (const [path, content] of files) putBoxFile(machine, path, Buffer.from(content));
    const command = `set -e; root="$HOME/.companion/runtime";
printf '%s\\n' 'companion-box-runnable';
recorded="$(cat "$HOME/.companion/runtime/state/pi-layout.version" 2>/dev/null || true)";
if [ "$recorded" = '${layoutMarker}' ] \\
  && [ -x "$HOME/.companion/bin/companion-pi-broker.mjs" ] \\
  && [ -x "$HOME/.companion/bin/pi-daemon" ] \\
  && [ -f "$HOME/.config/systemd/user/companion-pi-daemon.service" ]; then
  printf '%s\\n' 'companion-layout-unchanged'
fi;
digest="$(cat "$HOME/.companion/runtime/state/skills-tree.version" 2>/dev/null || true)";
printf '%s' "$digest" | grep -Eq '^[0-9a-f]{64}$' || {
  printf '%s\\n' 'companion-skills-snapshot-corrupt'; exit 1;
};
printf '%s\\n' "$digest";
rm -rf "$root/state/skill-archives";
printf '%s\\n' 'companion-skills-tree-reused';
if [ -f "$HOME/.companion/pi/auth.json" ]; then
  printf '%s\\n' 'companion-provider-auth-present'
fi`;

    await expect(executeBoxCommand(machine, command)).resolves.toEqual({
      success: true,
      exitCode: 0,
      stdout: [
        "companion-box-runnable",
        "companion-layout-unchanged",
        skillsDigest,
        "companion-skills-tree-reused",
        "companion-provider-auth-present",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(machine.persistentFiles.has(
      ".companion/runtime/state/skill-archives/stale.tar.gz.b64",
    )).toBe(false);

    machine.persistentFiles.delete(".companion/runtime/state/skills-tree.version");
    await expect(executeBoxCommand(machine, command)).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      stdout: expect.stringContaining("companion-skills-snapshot-corrupt"),
    });
  });

  it("captures Pi 0.84.2 rejecting GLM 5.3 Flash when no custom model is staged", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    machine.persistentFiles.set(".companion/pi/auth.json", Buffer.from("{}\n"));
    machine.persistentFiles.set(
      ".companion/runtime/state/providers.env",
      Buffer.from("ZAI_API_KEY=simulator-only\n"),
    );
    machine.persistentFiles.set(
      ".companion/runtime/state/model.txt",
      Buffer.from("glm-5.3-flash\n"),
    );

    const result = await executeBoxCommand(
      machine,
      "staged_credential_file=x; systemctl --user daemon-reload; systemctl --user start companion-pi-daemon.service",
    );

    expect(result).toMatchObject({
      success: true,
      stdout: "failed\ncompanion-pi-broker-unready\n",
    });
    expect(machine.daemon).toMatchObject({ status: "failed", rpcReady: false });
    expect(machine.daemon.stderrLog).toBe(
      'Error: Model "glm-5.3-flash" not found. Use --list-models to see available models.\n',
    );
  });

  it("models credential movement, daemon lifecycle, correlated RPC, and warm probes", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const handleRpc = vi.fn(async (command: Record<string, unknown>) => ({
      type: "response",
      command: command.type,
      id: command.id,
      success: true,
      ...(command.type === "get_state"
        ? { data: { model: { input: ["text", "image"] } } }
        : {}),
    }));
    const controller: BoxSimPiController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc,
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };
    machine.piController = controller;
    putBoxFile(machine, ".companion/pi/auth.json", Buffer.from("secret auth"));
    putBoxFile(machine, ".companion/runtime/state/providers.env", Buffer.from("TOKEN=secret"));

    const started = await executeBoxCommand(
      machine,
      "staged_credential_file=x; systemctl --user daemon-reload; systemctl --user start companion-pi-daemon.service",
    );
    expect(started.success).toBe(true);
    expect(controller.start).toHaveBeenCalledOnce();
    expect(machine.persistentFiles.has(".companion/runtime/state/providers.env")).toBe(false);
    expect(machine.volatileFiles.get("run/user/1000/companion/providers.env")?.toString())
      .toBe("TOKEN=secret");
    expect(machine.daemon).toMatchObject({
      status: "active",
      rpcReady: true,
      invocationId: "00000000000000000000000000000001",
    });
    putBoxFile(machine, ".companion/runtime/state/providers.env", Buffer.from("TOKEN=refreshed"));
    const startedAgain = await executeBoxCommand(
      machine,
      "staged_credential_file=x; systemctl --user daemon-reload; systemctl --user start companion-pi-daemon.service",
    );
    expect(startedAgain.success).toBe(true);
    expect(machine.daemon).toMatchObject({
      invocationId: "00000000000000000000000000000001",
      restartCount: 0,
    });
    expect(controller.start).toHaveBeenCalledOnce();
    expect(await executeBoxCommand(machine, "printf companion-pi-warm-ready"))
      .toMatchObject({ success: true, stdout: "companion-pi-warm-ready\n" });

    const runtimeState = await executeBoxCommand(machine, brokerShell({
      id: "runtime-state-1",
      type: "runtime_state",
    }));
    expect(runtimeState.success).toBe(true);
    expect(JSON.parse(runtimeState.stdout)).toMatchObject({
      type: "response",
      command: "runtime_state",
      id: "runtime-state-1",
      success: true,
      data: {
        invocationId: "00000000000000000000000000000001",
        activeAttemptId: null,
        modelInput: ["text", "image"],
      },
    });
    expect(handleRpc).toHaveBeenCalledWith({ id: "runtime-state-1", type: "get_state" });

    const rpc = await executeBoxCommand(machine, brokerShell({
      id: "turn-with-apostrophe",
      type: "prompt",
      attemptId: "turn-with-apostrophe",
      message: "don't repeat",
    }));
    expect(rpc.success).toBe(true);
    expect(JSON.parse(rpc.stdout)).toMatchObject({
      type: "response",
      command: "prompt",
      id: "turn-with-apostrophe",
      success: true,
      data: {
        attemptId: "turn-with-apostrophe",
        invocationId: "00000000000000000000000000000001",
        piAcknowledged: true,
      },
    });
    expect(handleRpc).toHaveBeenCalledWith(expect.objectContaining({
      message: "don't repeat",
      streamingBehavior: "steer",
    }));

    const decision = await executeBoxCommand(machine, brokerShell({
      id: "decision-1",
      type: "extension_ui_response",
      response: { id: "question-1", type: "extension_ui_response", value: "yes" },
    }));
    expect(decision.success).toBe(true);
    expect(JSON.parse(decision.stdout)).toMatchObject({
      type: "response",
      command: "extension_ui_response",
      id: "decision-1",
      success: true,
      data: {
        attemptId: "turn-with-apostrophe",
        invocationId: "00000000000000000000000000000001",
        delivered: true,
      },
    });
    expect(controller.respondExtensionUi).toHaveBeenCalledWith({
      id: "question-1",
      type: "extension_ui_response",
      value: "yes",
    });

    expect(await executeBoxCommand(machine, "Pi daemon is still active after stop"))
      .toMatchObject({ success: true });
    expect(machine.daemon).toMatchObject({
      status: "inactive",
      rpcReady: false,
      activeAttemptId: null,
      invocationId: null,
    });
    expect(machine.volatileFiles.size).toBe(0);
  });

  it("restarts Pi with the existing volatile credential when no replacement was staged", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const controller: BoxSimPiController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(),
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };
    machine.piController = controller;
    putBoxFile(machine, ".companion/pi/auth.json", Buffer.from("secret auth"));
    putBoxFile(machine, ".companion/runtime/state/providers.env", Buffer.from("TOKEN=secret"));
    const command = (action: "start" | "restart") =>
      `staged_credential_file=x; systemctl --user daemon-reload; systemctl --user ${action} companion-pi-daemon.service`;

    await expect(executeBoxCommand(machine, command("start"))).resolves.toMatchObject({ success: true });
    expect(machine.persistentFiles.has(".companion/runtime/state/providers.env")).toBe(false);
    machine.daemon.activeAttemptId = "attempt-before-restart";
    appendPiEvent(machine, { type: "turn_start" });
    expect(machine.daemon).toMatchObject({ brokerAcknowledgedCursor: 0 });
    await expect(executeBoxCommand(machine, command("restart"))).resolves.toMatchObject({ success: true });

    expect(controller.restart).toHaveBeenCalledOnce();
    expect(machine.volatileFiles.get("run/user/1000/companion/providers.env")?.toString())
      .toBe("TOKEN=secret");
    expect(machine.daemon).toMatchObject({
      status: "active",
      invocationId: "00000000000000000000000000000002",
      restartCount: 1,
      activeAttemptId: null,
      // The old event and the process-exit record belong to the retired invocation. A real layout-14
      // broker acknowledges both before accepting commands for the replacement process.
      brokerAcknowledgedCursor: 2,
    });
  });

  it("preserves malformed Pi model capabilities so the production adapter rejects them", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.piController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(async (command: Record<string, unknown>) => ({
        type: "response",
        command: command.type,
        id: command.id,
        success: true,
        data: { model: { input: ["text", 7, null] } },
      })),
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await executeBoxCommand(machine, brokerShell({
      id: "runtime-state-malformed",
      type: "runtime_state",
    }));

    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      data: { modelInput: ["text", 7, null] },
    });
  });

  it("correlates a Pi event emitted before the prompt acknowledgement", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "ask_user" });
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.piController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(async (command: Record<string, unknown>) => {
        appendPiEvent(machine, {
          type: "extension_ui_request",
          id: "question-before-ack",
          method: "input",
          title: "companion:question:ask_user",
        });
        return {
          type: "response",
          command: command.type,
          id: command.id,
          success: true,
        };
      }),
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await executeBoxCommand(machine, brokerShell({
      id: "prompt-before-ack",
      type: "prompt",
      attemptId: "attempt-before-ack",
      message: "Ask first.",
    }));

    expect(result.success).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { initialCursor: 0 },
    });
    expect(machine.daemon.activeAttemptId).toBe("attempt-before-ack");
    expect(machine.daemon.brokerCounters.unboundEvents).toBe(0);
    expect(machine.daemon.brokerJournal).toEqual([
      expect.objectContaining({
        invocationId: "00000000000000000000000000000001",
        attemptId: "attempt-before-ack",
        kind: "pi_event",
        event: expect.objectContaining({ type: "extension_ui_request" }),
      }),
    ]);
  });

  it("clears the outbox before a prompt whose Pi RPC fails", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    putBoxFile(machine, "outbox/stale.png", Buffer.from("stale"));
    machine.piController = {
      start: vi.fn(), restart: vi.fn(), stop: vi.fn(),
      handleRpc: vi.fn(async () => { throw new Error("Pi failed"); }),
      respondExtensionUi: vi.fn(), crash: vi.fn(), setScenario: vi.fn(), dispose: vi.fn(),
    };

    const result = await executeBoxCommand(machine, brokerShell({
      id: "prompt-failure",
      type: "prompt",
      attemptId: "attempt-failure",
      message: "Fail after cleanup.",
      clearOutbox: true,
    }));

    expect(result.success).toBe(false);
    expect(machine.persistentFiles.has("outbox/stale.png")).toBe(false);
  });

  it.each([
    ["missing id", { type: "extension_ui_response", value: "yes" }],
    ["empty id", { type: "extension_ui_response", id: "", value: "yes" }],
    [
      "oversized id",
      { type: "extension_ui_response", id: "x".repeat(257), value: "yes" },
    ],
    ["non-finite id", { type: "extension_ui_response", id: Number.POSITIVE_INFINITY, value: "yes" }],
    ["wrong type", { type: "extension_ui_request", id: "question-1", value: "yes" }],
  ] as const)("does not deliver a decision with %s", async (_name, response) => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "ask_user" });
    const respondExtensionUi = vi.fn();
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.daemon.activeAttemptId = "attempt-question";
    machine.piController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(),
      respondExtensionUi,
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await executeBoxCommand(machine, brokerShell({
      id: "decision-invalid",
      type: "extension_ui_response",
      response,
    }));

    expect(result.success).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "decision-invalid",
      success: false,
      error: { code: "invalid_command", ambiguous: false },
    });
    expect(respondExtensionUi).not.toHaveBeenCalled();
  });

  it("bounds read_events pages by encoded bytes without loss or duplication", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.daemon.activeAttemptId = "attempt-large-events";
    for (let index = 0; index < 4; index += 1) {
      appendPiEvent(machine, {
        type: "message_update",
        index,
        delta: "x".repeat(60 * 1024),
      });
    }

    const first = await executeBoxCommand(machine, brokerShell({
      id: "read-large-page-1",
      type: "read_events",
      after: 0,
      limit: 256,
    }));
    const firstResponse = JSON.parse(first.stdout) as {
      data: { events: Array<{ sequence: number }>; nextCursor: number; hasMore: boolean };
    };
    expect(Buffer.byteLength(first.stdout, "utf8")).toBeLessThan(256 * 1024);
    expect(firstResponse.data.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(firstResponse.data).toMatchObject({ nextCursor: 3, hasMore: true });

    const second = await executeBoxCommand(machine, brokerShell({
      id: "read-large-page-2",
      type: "read_events",
      after: firstResponse.data.nextCursor,
      limit: 256,
    }));
    const secondResponse = JSON.parse(second.stdout) as {
      data: { events: Array<{ sequence: number }>; nextCursor: number; hasMore: boolean };
    };
    expect(secondResponse.data.events.map((event) => event.sequence)).toEqual([4]);
    expect(secondResponse.data).toMatchObject({ nextCursor: 4, hasMore: false });
    expect([
      ...firstResponse.data.events,
      ...secondResponse.data.events,
    ].map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("joins virtual file parts without invoking a host shell", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    putBoxFile(machine, "archive.part0", Buffer.from("abc"));
    putBoxFile(machine, "archive.part1", Buffer.from("def"));
    expect(await executeBoxCommand(
      machine,
      "set -e; cat 'archive.part0' 'archive.part1' > 'archive'; rm -f 'archive.part0' 'archive.part1'",
    )).toMatchObject({ success: true });
    expect(machine.persistentFiles.get("archive")?.toString()).toBe("abcdef");
    expect(machine.persistentFiles.has("archive.part0")).toBe(false);

  });

  it("classifies and applies every attachment and outbox command the adapter emits", async () => {
    // The classifier's regexes are the contract between the real adapter and this simulator. If the
    // adapter's emitted command drifts, these must fail rather than every command falling through
    // to the unknown-command branch, which would leave the runtime suites green and blind.
    const directory = "attachments/66666666-6666-4666-8666-666666666666";
    const commands = {
      prepare: `set -e; cd "$HOME"; rm -rf ${shellQuote(directory)}; mkdir -p ${shellQuote(directory)}`,
      lock: `set -e; cd "$HOME"; chmod -R a-w ${shellQuote(directory)}`,
      clear: `set -e; dir="$HOME/outbox"; mkdir -p "$dir"; find "$dir" -mindepth 1 -delete`,
    };
    expect(classifyBoxCommand(commands.prepare)).toBe("prepare-attachments");
    expect(classifyBoxCommand(commands.lock)).toBe("lock-attachments");
    expect(classifyBoxCommand(commands.clear)).toBe("clear-outbox");

    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    putBoxFile(machine, `${directory}/0-stale.png`, Buffer.from("stale"));
    putBoxFile(machine, "outbox/left-over.png", Buffer.from("left over"));

    // Preparing replaces the directory, so a retried attempt stages what it was given and nothing
    // a previous one left behind.
    expect(await executeBoxCommand(machine, commands.prepare)).toMatchObject({ success: true });
    expect([...machine.persistentFiles.keys()]).not.toContain(`${directory}/0-stale.png`);
    expect(await executeBoxCommand(machine, commands.lock)).toMatchObject({ success: true });

    expect(await executeBoxCommand(machine, commands.clear)).toMatchObject({ success: true });
    expect([...machine.persistentFiles.keys()].some((path) => path.startsWith("outbox/")))
      .toBe(false);
    expect(machine.unknownCommandDigests).toHaveLength(0);
  });

  it("lets the same message be staged twice, because the lock spares the directory", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const directory = "attachments/66666666-6666-4666-8666-666666666666";
    const prepare = `set -e; cd "$HOME"; rm -rf ${shellQuote("attachments")}; mkdir -p ${shellQuote(directory)}`;
    const lockFilesOnly = `set -e; cd "$HOME"; find ${shellQuote(directory)} -type f -exec chmod a-w {} +`;
    const lockRecursively = `set -e; cd "$HOME"; chmod -R a-w ${shellQuote(directory)}`;

    expect(await executeBoxCommand(machine, prepare)).toMatchObject({ success: true });
    putBoxFile(machine, `${directory}/0-chart.png`, Buffer.from("png"));
    expect(await executeBoxCommand(machine, lockFilesOnly)).toMatchObject({ success: true });

    // A retry of the same turn must be able to clear what the previous attempt staged.
    expect(await executeBoxCommand(machine, prepare)).toMatchObject({ success: true });

    // A recursive lock is what would break it, and the simulator now says so rather than modelling
    // chmod as a no-op that could never reproduce the failure.
    putBoxFile(machine, `${directory}/0-chart.png`, Buffer.from("png"));
    expect(await executeBoxCommand(machine, lockRecursively)).toMatchObject({ success: true });
    expect(await executeBoxCommand(machine, prepare)).toMatchObject({ success: false });
  });

  it("lists the outbox as a sentinel-bracketed manifest and reads it back in chunks", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const bytes = Buffer.from("an image that spans two chunks".repeat(4));
    putBoxFile(machine, "outbox/plot.png", bytes);
    const listCommand = [
      'dir="$HOME/outbox"',
      "printf '%s\\n' 'companion-outbox-manifest-begin'",
      "printf '%s\\n' 'companion-outbox-manifest-end'",
    ].join("\n");

    expect(classifyBoxCommand(listCommand)).toBe("list-outbox");
    const listed = await executeBoxCommand(machine, listCommand);
    const line = listed.stdout.split("\n").find((entry) => entry.includes(" "))!;
    const [manifestDigest, size, encodedName] = line.split(" ");
    expect(Buffer.from(encodedName!, "base64").toString("utf8")).toBe("plot.png");
    expect(Number(size)).toBe(bytes.byteLength);
    expect(manifestDigest).toMatch(/^[a-f0-9]{64}$/);

    const chunkCommand = (skip: number, size_: number) => [
      "set -e",
      `name="$(printf '%s' '${encodedName}' | base64 -d)"`,
      "printf '%s\\n' 'companion-outbox-chunk-begin'",
      `dd if="$HOME/outbox/$name" bs=${size_} skip=${skip} count=1 2>/dev/null | base64 -w0`,
      "printf '\\n%s\\n' 'companion-outbox-chunk-end'",
    ].join("\n");
    expect(classifyBoxCommand(chunkCommand(0, 16))).toBe("read-outbox-chunk");

    const first = await executeBoxCommand(machine, chunkCommand(0, 16));
    const body = first.stdout.split("\n").filter(Boolean)[1]!;
    expect(Buffer.from(body, "base64").equals(bytes.subarray(0, 16))).toBe(true);

    // The mangling hook is what lets a test prove the chunked protocol detects a truncated body.
    machine.mangleOutboxChunkBytes = 4;
    const mangled = await executeBoxCommand(machine, chunkCommand(0, 16));
    const mangledBody = mangled.stdout.split("\n").filter(Boolean)[1]!;
    expect(Buffer.from(mangledBody, "base64").byteLength).toBe(4);
  });

  it("fails closed on unknown commands and records only their digest", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const syntheticSecret = ["simulated", "credential", "771"].join("-");
    const secretCommand =
      `curl https://example.invalid -H 'Authorization: ${syntheticSecret}'`;
    const result = await executeBoxCommand(machine, secretCommand);
    expect(result).toMatchObject({ success: false, exitCode: 127 });
    expect(result.stderr).not.toContain(syntheticSecret);
    expect(machine.unknownCommandDigests).toHaveLength(1);
    expect(machine.unknownCommandDigests[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(machine.persistentFiles.size).toBe(0);
  });
});
