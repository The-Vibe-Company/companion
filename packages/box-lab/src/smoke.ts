import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  BoxRuntimeProviderError,
  COMPANION_PI_BROKER_SOCKET_PATH,
  COMPANION_PI_BUNDLE,
  COMPANION_PI_NPM_PACKAGE,
  type CompanionPiBundlePlan,
  type AsciiBoxCompanionRuntimeOptions,
} from "@companion/box-runtime";

import type { BoxLabConfig } from "./config";
import type { BoxLabDriver } from "./driver";
import {
  BOX_LAB_FAKE_MODEL_ID,
  BOX_LAB_FAKE_PROVIDER_ID,
  boxLabModelsJson,
  fakeModelServerSource,
  fakeModelSystemdUnit,
} from "./fakeModel";
import { BoxLabService } from "./lab";
import { createBoxLabServer } from "./server";
import { withBoxLabSmokeDispatcher } from "./smokeDispatcher";
import { BoxLabStateStore } from "./state";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const GENERATION = 1;
const BOX_TTL_SECONDS = 21_600;
const PROVIDER_OPERATION_DEADLINE_MS = 25 * 60_000;
const PI_INSTALL_COMMAND = [
  `npm install --global ${COMPANION_PI_NPM_PACKAGE}@${COMPANION_PI_BUNDLE.piVersion}`,
  'export PATH="$(npm prefix --global)/bin:$PATH"',
].join("\n");

export type BoxLabSmokeProfile = "deterministic" | "real-provider";
export type BoxLabSmokeScenario = "lifecycle" | "bundle";
type BoxLabSmokeReportValue = string | number | boolean | null | undefined;
type BoxLabSmokeReport = Record<string, BoxLabSmokeReportValue>;

export interface BoxLabSmokeReportEvent {
  type: string;
  phase: string;
  at: string;
  [key: string]: BoxLabSmokeReportValue;
}

export interface BoxLabSmokeOptions {
  config: BoxLabConfig;
  driver: BoxLabDriver;
  profile: BoxLabSmokeProfile;
  scenario: BoxLabSmokeScenario;
  failureMatrix?: boolean;
  forcePinnedInstall?: boolean;
  env?: NodeJS.ProcessEnv;
  report?: (event: BoxLabSmokeReportEvent) => void;
}

interface ProviderBoxEnvelope {
  box: { id: string; state: string; setupStatus?: string | null; setupError?: string | null };
}

interface ProviderBoxListEnvelope {
  boxes: Array<{ id: string }>;
}

interface ProviderSnapshotListEnvelope {
  snapshots: Array<{ name: string }>;
}

interface ProviderCommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

interface SmokeProvider {
  auth: Record<string, { type: "api_key"; key: string }>;
  modelId: string;
}

export class BoxLabFailureCaseError extends Error {
  readonly boxId: string;
  readonly caseName: string;

  constructor(caseName: string, boxId: string, cause: unknown) {
    super(`Box Lab failure case ${caseName} failed`, { cause });
    this.name = "BoxLabFailureCaseError";
    this.boxId = boxId;
    this.caseName = caseName;
  }
}

export async function runRetainedFailureCase(input: {
  caseName: string;
  boxId: string;
  action: () => Promise<void>;
  cleanup: () => Promise<void>;
}): Promise<void> {
  try {
    await input.action();
    await input.cleanup();
  } catch (error) {
    throw new BoxLabFailureCaseError(input.caseName, input.boxId, error);
  }
}

export async function runRetainedCreatedBoxCase(input: {
  caseName: string;
  create: () => Promise<string>;
  ready: (boxId: string) => Promise<void>;
  action: (boxId: string) => Promise<void>;
  cleanup: (boxId: string) => Promise<void>;
}): Promise<void> {
  const boxId = await input.create();
  await runRetainedFailureCase({
    caseName: input.caseName,
    boxId,
    action: async () => {
      await input.ready(boxId);
      await input.action(boxId);
    },
    cleanup: () => input.cleanup(boxId),
  });
}

export async function retryBoxLabPrewarm(input: {
  action: () => Promise<void>;
  attempts: number;
  delayMs: number;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      await input.action();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < input.attempts) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, input.delayMs));
      }
    }
  }
  throw lastError;
}

export function boxLabFailureIdentitySalt(caseName: string): string {
  return createHash("sha256").update(`box-lab-failure:${caseName}`).digest("hex");
}

function report(options: BoxLabSmokeOptions, phase: string, fields: BoxLabSmokeReport = {}): void {
  options.report?.({ type: "box-lab.smoke", phase, at: new Date().toISOString(), ...fields });
}

function providerOperationDeadlineAt(): Date {
  // The complete Lab smoke intentionally spans several slow provider operations and may exceed
  // this interval. Each individual provider operation receives one fixed absolute deadline.
  return new Date(Date.now() + PROVIDER_OPERATION_DEADLINE_MS);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function providerRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`Box Lab provider request failed with ${response.status}`);
  // SAFETY: Every caller supplies the Box v1 envelope it owns and immediately validates the
  // concrete fields it consumes; the Lab server is the other typed endpoint in this package.
  return await response.json() as T;
}

async function waitForBoxState(
  baseUrl: string,
  apiKey: string,
  boxId: string,
  expected: string,
  timeoutMs = 20 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await providerRequest<ProviderBoxEnvelope>(baseUrl, apiKey, `/boxes/${boxId}`);
    if (observed.box.state === expected) return;
    if (observed.box.state === "error") {
      throw new Error(observed.box.setupError || "Box entered error state");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Box did not reach ${expected} before the smoke deadline`);
}

async function putFile(
  baseUrl: string,
  apiKey: string,
  boxId: string,
  path: string,
  content: Buffer | string,
): Promise<void> {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const chunkBytes = 6 * 1024 * 1024;
  if (bytes.byteLength <= chunkBytes) {
    await providerRequest(baseUrl, apiKey, `/boxes/${boxId}/files`, {
      method: "PUT",
      body: JSON.stringify({ path, content: bytes.toString("base64"), encoding: "base64" }),
    });
    return;
  }
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const part = `${path}.part${parts.length}`;
    parts.push(part);
    await providerRequest(baseUrl, apiKey, `/boxes/${boxId}/files`, {
      method: "PUT",
      body: JSON.stringify({
        path: part,
        content: bytes.subarray(offset, offset + chunkBytes).toString("base64"),
        encoding: "base64",
      }),
    });
  }
  const quoted = parts.map(shellQuote).join(" ");
  await command(baseUrl, apiKey, boxId, `set -e; cd "$HOME"; cat ${quoted} > ${shellQuote(path)}; rm -f ${quoted}`, 120);
}

async function rawCommand(
  baseUrl: string,
  apiKey: string,
  boxId: string,
  value: string,
  timeoutSeconds = 60,
): Promise<ProviderCommandResult> {
  return await providerRequest<ProviderCommandResult>(baseUrl, apiKey, `/boxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command: value, timeoutSeconds }),
  });
}

async function command(
  baseUrl: string,
  apiKey: string,
  boxId: string,
  value: string,
  timeoutSeconds = 60,
): Promise<ProviderCommandResult> {
  const result = await rawCommand(baseUrl, apiKey, boxId, value, timeoutSeconds);
  if (!result.success) {
    const exit = result.exitCode === null ? "timeout" : `exit ${result.exitCode}`;
    throw new Error(`Contained Box command failed (${exit})`);
  }
  return result;
}

async function installFakeModel(baseUrl: string, apiKey: string, boxId: string): Promise<void> {
  await putFile(baseUrl, apiKey, boxId, ".box-lab/fake-model.mjs", fakeModelServerSource());
  await putFile(
    baseUrl,
    apiKey,
    boxId,
    ".config/systemd/user/box-lab-model.service",
    fakeModelSystemdUnit(),
  );
  await command(baseUrl, apiKey, boxId, `set -e
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user daemon-reload
systemctl --user enable --now box-lab-model.service
for attempt in $(seq 1 300); do
  if curl --fail --silent http://127.0.0.1:18099/health >/dev/null; then exit 0; fi
  sleep 0.1
done
exit 1`);
}

function realProvider(env: NodeJS.ProcessEnv): SmokeProvider {
  const raw = env.BOX_LAB_REAL_PROVIDER_AUTH_JSON?.trim();
  const modelId = env.BOX_LAB_REAL_PROVIDER_MODEL_ID?.trim();
  if (!raw || !modelId) {
    throw new Error("real-provider requires BOX_LAB_REAL_PROVIDER_AUTH_JSON and BOX_LAB_REAL_PROVIDER_MODEL_ID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BOX_LAB_REAL_PROVIDER_AUTH_JSON is invalid JSON");
  }
  if (parsed === null || !(parsed instanceof Object) || Array.isArray(parsed) || Object.keys(parsed).length !== 1) {
    throw new Error("BOX_LAB_REAL_PROVIDER_AUTH_JSON must contain exactly one provider credential");
  }
  // SAFETY: The deployment owns the provider-specific auth entry. The runtime validates and
  // serializes this exact one-entry API-key map; the smoke runner never reads or logs its value.
  return { auth: parsed as SmokeProvider["auth"], modelId };
}

function deterministicProvider(): SmokeProvider {
  return {
    auth: { [BOX_LAB_FAKE_PROVIDER_ID]: { type: "api_key", key: "box-lab-synthetic-key" } },
    modelId: BOX_LAB_FAKE_MODEL_ID,
  };
}

async function buildBundleInGuest(
  baseUrl: string,
  apiKey: string,
  boxId: string,
): Promise<CompanionPiBundlePlan> {
  const piPackage = `${COMPANION_PI_NPM_PACKAGE}@${COMPANION_PI_BUNDLE.piVersion}`;
  const extensions = COMPANION_PI_BUNDLE.packages.map(shellQuote).join(" ");
  const qmdPackage = COMPANION_PI_BUNDLE.qmdPackage.replace(/^npm:/, "");
  const built = await command(baseUrl, apiKey, boxId, `set -euo pipefail
root="$HOME/.box-lab/bundle-build"
archive="$HOME/.box-lab/pi-bundle.tar.gz"
rm -rf "$root" "$archive"
mkdir -p "$root/pi" "$root/pi-agent-dir" "$root/tools"
npm install --global --prefix "$root/pi" ${shellQuote(piPackage)}
pi_bin="$root/pi/bin/pi"
test -x "$pi_bin"
for spec in ${extensions}; do
  PI_CODING_AGENT_DIR="$root/pi-agent-dir" "$pi_bin" install "$spec"
done
npm install --global --prefix "$root/tools" ${shellQuote(qmdPackage)}
"$pi_bin" --version
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "$archive" -C "$root" pi pi-agent-dir tools
sha256="$(sha256sum "$archive" | awk '{ print $1 }')"
printf 'box-lab-bundle-sha256 %s\\n' "$sha256"
rm -rf "$root"`, 900);
  const sha256 = /(?:^|\n)box-lab-bundle-sha256 ([a-f0-9]{64})(?:\n|$)/.exec(built.stdout)?.[1];
  if (!sha256) throw new Error("Contained bundle build did not report a checksum");
  return {
    objectKey: `local/companion-pi-bundle-${sha256.slice(0, 12)}.tar.gz`,
    manifest: { ...COMPANION_PI_BUNDLE, sha256 },
  };
}

async function buildMinimalBundleInGuest(
  baseUrl: string,
  apiKey: string,
  boxId: string,
): Promise<string> {
  const built = await command(baseUrl, apiKey, boxId, `set -euo pipefail
root="$HOME/.box-lab/minimal-bundle"
archive="$HOME/.box-lab/minimal-bundle.tar.gz"
rm -rf "$root" "$archive"
mkdir -p "$root/pi" "$root/pi-agent-dir" "$root/tools"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "$archive" -C "$root" pi pi-agent-dir tools
sha256="$(sha256sum "$archive" | awk '{ print $1 }')"
printf 'box-lab-minimal-sha256 %s\\n' "$sha256"
rm -rf "$root"`);
  const sha256 = /(?:^|\n)box-lab-minimal-sha256 ([a-f0-9]{64})(?:\n|$)/.exec(built.stdout)?.[1];
  if (!sha256) throw new Error("Contained minimal bundle did not report a checksum");
  return sha256;
}

function bundlePlan(
  sha256: string,
  nodeMajor: number = COMPANION_PI_BUNDLE.nodeMajor,
): CompanionPiBundlePlan {
  return {
    objectKey: `local/companion-pi-bundle-${sha256.slice(0, 12)}.tar.gz`,
    manifest: { ...COMPANION_PI_BUNDLE, sha256, nodeMajor },
  };
}

async function waitForSettled(
  runtime: AsciiBoxCompanionRuntime,
  boxId: string,
  attemptId: string,
  after: number,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  let cursor = after;
  while (Date.now() < deadline) {
    const page = await runtime.readEvents({ boxId, after: cursor });
    if (page.events.some((entry) =>
      entry.attemptId === attemptId
      && entry.kind === "pi_event"
      && entry.event.type === "agent_settled")) return;
    cursor = page.nextCursor;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Real Pi did not emit agent_settled before the smoke deadline");
}

async function assertLayout(
  baseUrl: string,
  apiKey: string,
  boxId: string,
  runtime: AsciiBoxCompanionRuntime,
  plan: CompanionPiBundlePlan | undefined,
): Promise<void> {
  const expectedPi = plan
    ? `/home/user/.companion/dist/${plan.manifest.sha256.slice(0, 12)}/pi/bin/pi`
    : "/home/user/.local/bin/pi";
  const extensionNames = COMPANION_PI_BUNDLE.packages
    .map((spec) => spec.replace(/^npm:/, "").replace(/@[^@]+$/, ""));
  const extensionChecks = extensionNames.map((name) =>
    `test -n "$(find "$HOME/.companion/pi" -maxdepth 5 -name ${shellQuote(`*${name}*`)} -print -quit 2>/dev/null)"`,
  ).join("\n");
  await command(baseUrl, apiKey, boxId, `set -euo pipefail
test "$(node -p 'process.versions.node.split(".")[0]')" = ${COMPANION_PI_BUNDLE.nodeMajor}
test -x ${shellQuote(expectedPi)}
${shellQuote(expectedPi)} --version | grep -Eq '(^|[^0-9])${COMPANION_PI_BUNDLE.piVersion.replaceAll(".", "\\.")}([^0-9]|$)'
grep -Fqx ${shellQuote(`PI_BIN=${expectedPi}`)} "$HOME/.companion/bin/pi-daemon"
test "$(cat "$HOME/.companion/runtime/state/pi-layout.version")" = ${shellQuote(runtime.layoutIdentity().fullMarker)}
test -x "$HOME/.companion/bin/pi-daemon"
test -x "$HOME/.companion/bin/companion-pi-broker.mjs"
test -f "$HOME/.config/systemd/user/companion-pi-daemon.service"
grep -Fq 'EnvironmentFile=-%t/companion/providers.env' "$HOME/.config/systemd/user/companion-pi-daemon.service"
test "$(stat -c '%a' "$HOME/.companion/runtime")" = 700
test "$(stat -c '%a' "$HOME/.companion/runtime/state")" = 700
test "$(stat -c '%a' "$HOME/.companion/runtime/logs")" = 700
test "$(stat -c '%a' "$HOME/.companion/runtime/memory")" = 700
test "$(stat -c '%a' "$HOME/.companion/bin/pi-daemon")" = 700
test "$(stat -c '%a' "$HOME/.companion/bin/companion-pi-broker.mjs")" = 700
test "$(stat -c '%a' "$HOME/.boxignore")" = 600
test "$(stat -c '%a' "$HOME/.companion/runtime/state/pi-layout.version")" = 644
test "$(stat -c '%a' "$HOME/.config/systemd/user/companion-pi-daemon.service")" = 644
${extensionChecks}`);
}

async function assertStagedPermissions(baseUrl: string, apiKey: string, boxId: string): Promise<void> {
  await command(baseUrl, apiKey, boxId, `set -euo pipefail
for file in \
  "$HOME/.companion/pi/auth.json" \
  "$HOME/.companion/pi/mcp.json" \
  "$HOME/.companion/pi/models.json" \
  "$HOME/.companion/runtime/state/instructions.txt" \
  "$HOME/.companion/runtime/state/model.txt" \
  "$HOME/.companion/runtime/state/providers.env"; do
  test -f "$file"
  test "$(stat -c '%a' "$file")" = 600
done
test "$(stat -c '%a' "$HOME/.companion/pi")" = 700`);
}

async function assertRunningSecurity(baseUrl: string, apiKey: string, boxId: string): Promise<void> {
  await command(baseUrl, apiKey, boxId, `set -euo pipefail
socket="$HOME/${COMPANION_PI_BROKER_SOCKET_PATH}"
credential="/run/user/$(id -u)/companion/providers.env"
test -S "$socket"
test "$(stat -c '%a' "$socket")" = 600
test -f "$credential"
test "$(stat -c '%a' "$credential")" = 600
test ! -e "$HOME/.companion/runtime/state/providers.env"`);
}

async function assertLayoutMarkerAbsent(baseUrl: string, apiKey: string, boxId: string): Promise<void> {
  await command(
    baseUrl,
    apiKey,
    boxId,
    'test ! -e "$HOME/.companion/runtime/state/pi-layout.version"',
  );
}

async function stageBox(
  runtime: AsciiBoxCompanionRuntime,
  boxId: string,
  provider: SmokeProvider,
): Promise<void> {
  await runtime.stageExistingBox({
    companionId: COMPANION_ID,
    runtimeGeneration: GENERATION,
    orgId: ORG_ID,
    boxId,
    clientSurface: "web",
    providerAuth: provider.auth,
    replaceProviderAuth: true,
    instructions: "You are running a contained Box Lab acceptance test.",
    modelId: provider.modelId,
    mcpCredentials: [],
    mcpAccounts: [],
    skills: [],
  });
}

async function sendPrompt(runtime: AsciiBoxCompanionRuntime, boxId: string): Promise<void> {
  const attemptId = `box-lab-${randomUUID()}`;
  const broker = await runtime.brokerState({ boxId });
  const dispatched = await runtime.dispatchPrompt({
    boxId,
    attemptId,
    expectedInvocationId: broker.invocationId,
    message: "Reply with the deterministic acceptance marker.",
  });
  if (dispatched.outcome !== "accepted") throw new Error("Real Pi did not acknowledge the smoke prompt");
  await waitForSettled(runtime, boxId, attemptId, dispatched.initialCursor);
}

async function createBlankBox(maintenance: AsciiBoxMaintenanceClient): Promise<string> {
  const created = await maintenance.createEphemeralBox({
    ttlSeconds: 3_600,
    noEnv: true,
    deadlineAt: providerOperationDeadlineAt(),
  });
  return created.boxId;
}

async function deleteBox(maintenance: AsciiBoxMaintenanceClient, boxId: string): Promise<void> {
  await maintenance.deletePermanentlyAndWait({
    boxId,
    deadlineAt: providerOperationDeadlineAt(),
    pollIntervalMs: 50,
  });
}

async function expectLayoutFailure(
  runtime: AsciiBoxCompanionRuntime,
  baseUrl: string,
  apiKey: string,
  boxId: string,
  stableCode?: string,
  messageFragment?: string,
): Promise<void> {
  let failure: unknown;
  try {
    await runtime.refreshPiLayout({ boxId });
  } catch (error) {
    failure = error;
  }
  if (!failure) throw new Error("The Box Lab failure scenario unexpectedly installed Pi");
  if (stableCode !== undefined) {
    if (!(failure instanceof BoxRuntimeProviderError) || failure.stableCode !== stableCode) {
      throw new Error(`The Box Lab failure scenario did not report ${stableCode}`);
    }
  }
  if (
    messageFragment !== undefined
    && (!(failure instanceof BoxRuntimeProviderError) || !failure.message.includes(messageFragment))
  ) {
    throw new Error(`The Box Lab failure scenario did not report ${messageFragment}`);
  }
  await assertLayoutMarkerAbsent(baseUrl, apiKey, boxId);
}

async function runFailureMatrix(input: {
  options: BoxLabSmokeOptions;
  maintenance: AsciiBoxMaintenanceClient;
  clientEnv: NodeJS.ProcessEnv;
  baseUrl: string;
  apiKey: string;
}): Promise<void> {
  const { options, maintenance, clientEnv, baseUrl, apiKey } = input;
  const run = async (name: string, action: (boxId: string) => Promise<void>): Promise<void> => {
    await runRetainedCreatedBoxCase({
      caseName: name,
      create: () => createBlankBox(maintenance),
      ready: async (boxId) => await waitForBoxState(baseUrl, apiKey, boxId, "running"),
      action,
      cleanup: (boxId) => deleteBox(maintenance, boxId),
    });
    report(options, "failure_case_passed", { case: name });
  };

  await run("npm_nonzero", async (boxId) => {
    const missing = `@companion-box-lab/not-published-${randomUUID().replaceAll("-", "")}@0.0.0`;
    const runtime = new AsciiBoxCompanionRuntime({
      ...clientEnv,
      COMPANION_PI_INSTALL_COMMAND: `printf '%s\n' box-lab-npm-install-started > "$HOME/.companion/box-lab-npm-install-started"
npm install --global --offline ${missing}`,
    }, { imageIdentitySalt: boxLabFailureIdentitySalt("npm_nonzero") });
    await expectLayoutFailure(runtime, baseUrl, apiKey, boxId, undefined, "Pi runtime layout failed to install");
    await command(baseUrl, apiKey, boxId, `grep -Fxq box-lab-npm-install-started "$HOME/.companion/box-lab-npm-install-started"`);
  });

  await run("command_timeout", async (boxId) => {
    // A newly booted TCG guest can spend over a minute faulting the first shell, Node, npm, and
    // file-write paths into memory. Warm those transport prerequisites outside the timeout under
    // test so that the bounded layout command itself reaches the deliberate install witness.
    await putFile(baseUrl, apiKey, boxId, ".box-lab/timeout-prewarm", "ready\n");
    await retryBoxLabPrewarm({
      attempts: 3,
      delayMs: 2_000,
      action: async () => {
        await command(baseUrl, apiKey, boxId, `for attempt in $(seq 1 120); do
  if node --version >/dev/null 2>&1 \
    && npm --version >/dev/null 2>&1 \
    && grep -Fxq ready "$HOME/.box-lab/timeout-prewarm"; then
    exit 0
  fi
  sleep 1
done
exit 1`, 150);
      },
    });
    const runtime = new AsciiBoxCompanionRuntime({
      ...clientEnv,
      COMPANION_PI_INSTALL_COMMAND: `printf '%s\\n' box-lab-layout-timeout-started > "$HOME/.companion/box-lab-layout-timeout-started"
sleep 300`,
    }, {
      // The generated layout performs real Node and filesystem checks before invoking the
      // install command. Foreign-architecture QEMU can spend close to a minute in that preamble,
      // so leave enough time to prove the install started before timing out its deliberate sleep.
      boxLabPiLayoutCommandTimeoutSeconds: 120,
      imageIdentitySalt: boxLabFailureIdentitySalt("command_timeout"),
    });
    await expectLayoutFailure(runtime, baseUrl, apiKey, boxId, undefined, "timed out");
    await command(baseUrl, apiKey, boxId, `grep -Fxq box-lab-layout-timeout-started "$HOME/.companion/box-lab-layout-timeout-started"`);
  });

  await run("node_absent", async (boxId) => {
    await command(baseUrl, apiKey, boxId, `set -euo pipefail
node_path="$(command -v node)"
sudo mv "$node_path" "$node_path.box-lab-disabled"`);
    const runtime = new AsciiBoxCompanionRuntime({
      ...clientEnv,
      COMPANION_PI_INSTALL_COMMAND: `mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\\nprintf "0.84.2\\\\n"\\n' > "$HOME/.local/bin/pi"
chmod 700 "$HOME/.local/bin/pi"
export PATH="$HOME/.local/bin:$PATH"`,
    }, { imageIdentitySalt: boxLabFailureIdentitySalt("node_absent") });
    await expectLayoutFailure(runtime, baseUrl, apiKey, boxId, undefined, "Pi runtime layout failed to install");
  });

  await run("bundle_download", async (boxId) => {
    const runtime = new AsciiBoxCompanionRuntime(clientEnv, {
      bundlePlan: bundlePlan("1".repeat(64)),
      bundleUrlProvider: async () => "http://127.0.0.1:1/box-lab-unavailable.tar.gz",
      imageIdentitySalt: boxLabFailureIdentitySalt("bundle_download"),
    });
    await expectLayoutFailure(runtime, baseUrl, apiKey, boxId, "pi_bundle_download_failed");
  });

  await run("bundle_checksum", async (boxId) => {
    await putFile(baseUrl, apiKey, boxId, ".box-lab/checksum-input.tar.gz", "not-a-pi-bundle");
    const runtime = new AsciiBoxCompanionRuntime(clientEnv, {
      bundlePlan: bundlePlan("2".repeat(64)),
      bundleUrlProvider: async () => "file:///home/user/.box-lab/checksum-input.tar.gz",
      imageIdentitySalt: boxLabFailureIdentitySalt("bundle_checksum"),
    });
    await expectLayoutFailure(runtime, baseUrl, apiKey, boxId, "pi_bundle_checksum_mismatch");
  });

  await run("bundle_node_incompatible", async (boxId) => {
    const sha256 = await buildMinimalBundleInGuest(baseUrl, apiKey, boxId);
    const runtime = new AsciiBoxCompanionRuntime(clientEnv, {
      bundlePlan: bundlePlan(sha256, COMPANION_PI_BUNDLE.nodeMajor - 1),
      bundleUrlProvider: async () => "file:///home/user/.box-lab/minimal-bundle.tar.gz",
      imageIdentitySalt: boxLabFailureIdentitySalt("bundle_node_incompatible"),
    });
    await expectLayoutFailure(runtime, baseUrl, apiKey, boxId, "pi_bundle_node_mismatch");
  });
}

function retainedShellCommand(options: BoxLabSmokeOptions, boxId: string): string {
  const stateRoot = dirname(options.config.stateDirectory);
  return [
    `BOX_LAB_WORKSPACE_ID=${shellQuote(options.config.workspaceId)}`,
    `BOX_LAB_STATE_DIR=${shellQuote(stateRoot)}`,
    `BOX_LAB_DRIVER=${shellQuote(options.config.driver)}`,
    `BOX_LAB_OCI_ENGINE=${shellQuote(options.config.ociEngine)}`,
    `pnpm box:lab:shell ${shellQuote(boxId)}`,
  ].join(" ");
}

async function assertProviderInventoryEmpty(baseUrl: string, apiKey: string): Promise<void> {
  const boxes = await providerRequest<ProviderBoxListEnvelope>(baseUrl, apiKey, "/boxes?limit=200");
  const snapshots = await providerRequest<ProviderSnapshotListEnvelope>(baseUrl, apiKey, "/named-snapshots");
  if (boxes.boxes.length !== 0 || snapshots.snapshots.length !== 0) {
    throw new Error("Box Lab provider inventory retained a Box or snapshot after deletion");
  }
}

export async function runBoxLabSmoke(options: BoxLabSmokeOptions): Promise<void> {
  await withBoxLabSmokeDispatcher(async () => await runBoxLabSmokeWithDispatcher(options));
}

async function runBoxLabSmokeWithDispatcher(options: BoxLabSmokeOptions): Promise<void> {
  const env = options.env ?? process.env;
  const store = new BoxLabStateStore(options.config.stateDirectory, options.config.workspaceScope);
  const service = new BoxLabService({
    driver: options.driver,
    store,
    resourcePrefix: options.config.resourcePrefix,
    diagnosticsDirectory: options.config.diagnosticsDirectory,
  });
  const server = createBoxLabServer({ config: options.config, service, port: 0 });
  let succeeded = false;
  let retainedBoxId: string | undefined;
  try {
    report(options, "server_start", { scenario: options.scenario, profile: options.profile });
    await server.listen();
    const clientEnv: NodeJS.ProcessEnv = {
      COMPANION_BOX_API_KEY: options.config.apiKey,
      COMPANION_BOX_API_BASE: server.baseUrl,
      COMPANION_BOX_POLL_INTERVAL_MS: "100",
      COMPANION_BOX_READY_TIMEOUT_MS: String(20 * 60_000),
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "120000",
      COMPANION_DIRECT_TRANSPORT: "off",
      COMPANION_PI_INSTALL_COMMAND: options.forcePinnedInstall === true
        ? PI_INSTALL_COMMAND
        : env.COMPANION_PI_INSTALL_COMMAND?.trim() || PI_INSTALL_COMMAND,
    };
    const maintenance = new AsciiBoxMaintenanceClient(clientEnv);
    const created = await maintenance.createOrRecoverGenerationBox({
      companionId: COMPANION_ID,
      generation: GENERATION,
      ttlSeconds: BOX_TTL_SECONDS,
      deadlineAt: providerOperationDeadlineAt(),
    });
    retainedBoxId = created.boxId;
    await maintenance.applyGenerationBoxSettings({
      boxId: created.boxId,
      companionId: COMPANION_ID,
      generation: GENERATION,
      ttlSeconds: BOX_TTL_SECONDS,
      deadlineAt: providerOperationDeadlineAt(),
    });
    await waitForBoxState(server.baseUrl, options.config.apiKey, created.boxId, "running");
    report(options, "box_ready", { boxId: created.boxId });

    const plan = options.scenario === "bundle"
      ? await buildBundleInGuest(server.baseUrl, options.config.apiKey, created.boxId)
      : undefined;
    if (plan) report(options, "bundle_built_in_guest", { sha256: plan.manifest.sha256 });
    const runtimeOptions: AsciiBoxCompanionRuntimeOptions = {};
    if (options.profile === "deterministic") runtimeOptions.modelsJsonProvider = boxLabModelsJson;
    // Foreign-architecture QEMU without KVM is intentionally slow. This remains an in-process,
    // contained-Lab override; every production caller retains 300 seconds.
    if (options.config.driver === "lima") {
      runtimeOptions.boxLabPiLayoutCommandTimeoutSeconds = 900;
    }
    if (plan) {
      runtimeOptions.bundlePlan = plan;
      runtimeOptions.bundleUrlProvider = async () => "file:///home/user/.box-lab/pi-bundle.tar.gz";
    }
    const runtime = new AsciiBoxCompanionRuntime(clientEnv, runtimeOptions);

    const firstLayout = await runtime.refreshPiLayout({ boxId: created.boxId });
    if (firstLayout.applied !== "base") throw new Error("Cold Box did not perform a base Pi installation");
    await assertLayout(server.baseUrl, options.config.apiKey, created.boxId, runtime, plan);
    const secondLayout = await runtime.refreshPiLayout({ boxId: created.boxId });
    if (secondLayout.applied !== "none") throw new Error("Second Pi layout refresh was not idempotent");
    report(options, "layout_installed", { mode: firstLayout.applied, piVersion: COMPANION_PI_BUNDLE.piVersion });

    const snapshotName = `box-lab-${Date.now().toString(36)}`.slice(0, 63);
    const snapshotDeadlineAt = providerOperationDeadlineAt();
    await maintenance.saveNamedSnapshot({ boxId: created.boxId, name: snapshotName, deadlineAt: snapshotDeadlineAt });
    for (;;) {
      const snapshot = await maintenance.getNamedSnapshot({ name: snapshotName, deadlineAt: snapshotDeadlineAt });
      if (snapshot?.status === "ready") break;
      if (!snapshot || snapshot.status === "failed") throw new Error("Named snapshot failed");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    report(options, "snapshot_ready", { snapshot: snapshotName });

    const provider = options.profile === "real-provider" ? realProvider(env) : deterministicProvider();
    if (options.profile === "deterministic") {
      await installFakeModel(server.baseUrl, options.config.apiKey, created.boxId);
    }
    await stageBox(runtime, created.boxId, provider);
    await assertStagedPermissions(server.baseUrl, options.config.apiKey, created.boxId);
    const started = await runtime.startPiDaemon({ boxId: created.boxId });
    await assertRunningSecurity(server.baseUrl, options.config.apiKey, created.boxId);
    const restarted = await runtime.restartPiDaemon({ boxId: created.boxId });
    if (started.invocationId === restarted.invocationId) throw new Error("Pi restart kept the same InvocationID");
    await assertRunningSecurity(server.baseUrl, options.config.apiKey, created.boxId);
    report(options, "pi_restarted", { invocationChanged: true });

    await sendPrompt(runtime, created.boxId);
    report(options, "prompt_settled");

    await command(server.baseUrl, options.config.apiKey, created.boxId, `set -e
printf '%s\\n' box-lab-home-persisted > "$HOME/.box-lab/home-persisted"
test -f "/run/user/$(id -u)/companion/providers.env"`);
    await runtime.stopPiDaemon({ boxId: created.boxId });
    await command(server.baseUrl, options.config.apiKey, created.boxId, `set -euo pipefail
runtime_credential_dir="/run/user/$(id -u)/companion"
mkdir -p "$runtime_credential_dir"
printf '%s\\n' box-lab-synthetic-volatile-credential > "$runtime_credential_dir/providers.env"
chmod 600 "$runtime_credential_dir/providers.env"
grep -Fxq box-lab-synthetic-volatile-credential "$runtime_credential_dir/providers.env"
test "$(stat -c '%a' "$runtime_credential_dir/providers.env")" = 600`);
    await runtime.archiveExistingBox({ boxId: created.boxId });
    await waitForBoxState(server.baseUrl, options.config.apiKey, created.boxId, "archived");
    await runtime.resumeExistingBox({ boxId: created.boxId });
    await waitForBoxState(server.baseUrl, options.config.apiKey, created.boxId, "running");
    await command(server.baseUrl, options.config.apiKey, created.boxId, `set -e
grep -Fxq box-lab-home-persisted "$HOME/.box-lab/home-persisted"
test ! -e "/run/user/$(id -u)/companion/providers.env"`);
    await stageBox(runtime, created.boxId, provider);
    await assertStagedPermissions(server.baseUrl, options.config.apiKey, created.boxId);
    const resumed = await runtime.startPiDaemon({ boxId: created.boxId });
    if (resumed.invocationId === restarted.invocationId) {
      throw new Error("Box resume kept the previous systemd InvocationID");
    }
    await assertRunningSecurity(server.baseUrl, options.config.apiKey, created.boxId);
    await sendPrompt(runtime, created.boxId);
    report(options, "archive_resume_settled", { homePersisted: true, runtimeCredentialsVolatile: true });

    const clone = await maintenance.createEphemeralBox({
      ttlSeconds: 3_600,
      from: snapshotName,
      noEnv: true,
      deadlineAt: providerOperationDeadlineAt(),
    });
    if (clone.boxId === created.boxId) throw new Error("Snapshot clone reused the source Box id");
    await waitForBoxState(server.baseUrl, options.config.apiKey, clone.boxId, "running");
    const cloneRefresh = await runtime.refreshPiLayout({ boxId: clone.boxId });
    if (cloneRefresh.applied !== "none") throw new Error("Snapshot clone performed a cold Pi install");
    await assertLayout(server.baseUrl, options.config.apiKey, clone.boxId, runtime, plan);
    await command(server.baseUrl, options.config.apiKey, clone.boxId, `set -euo pipefail
# Pi may materialize an empty auth.json while its real CLI installs or refreshes extensions. That
# file is safe in the pre-staging snapshot; the invariant is that no provider credential written
# after the snapshot can leak into its clone.
auth="$HOME/.companion/pi/auth.json"
if [ -e "$auth" ]; then
  node - "$auth" <<'BOX_LAB_EMPTY_AUTH'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
  process.exit(1);
}
BOX_LAB_EMPTY_AUTH
fi
test ! -e "$HOME/.companion/runtime/state/providers.env"
test ! -e "$HOME/.box-lab/fake-model.mjs"
test ! -e "/run/user/$(id -u)/companion/providers.env"`);
    if (options.profile === "deterministic") {
      await installFakeModel(server.baseUrl, options.config.apiKey, clone.boxId);
    }
    await stageBox(runtime, clone.boxId, provider);
    await runtime.startPiDaemon({ boxId: clone.boxId });
    await assertRunningSecurity(server.baseUrl, options.config.apiKey, clone.boxId);
    await sendPrompt(runtime, clone.boxId);
    report(options, "clone_settled", { boxId: clone.boxId, coldInstall: false, snapshotImmutable: true });
    await deleteBox(maintenance, clone.boxId);
    await maintenance.deleteNamedSnapshot({ name: snapshotName, deadlineAt: providerOperationDeadlineAt() });

    if (options.failureMatrix === true) {
      await runFailureMatrix({
        options,
        maintenance,
        clientEnv,
        baseUrl: server.baseUrl,
        apiKey: options.config.apiKey,
      });
      report(options, "failure_matrix_complete");
    }

    await deleteBox(maintenance, created.boxId);
    retainedBoxId = undefined;
    await assertProviderInventoryEmpty(server.baseUrl, options.config.apiKey);
    await service.reset();
    await assertProviderInventoryEmpty(server.baseUrl, options.config.apiKey);
    succeeded = true;
    report(options, "complete", { ok: true, scenario: options.scenario, scopedResources: 0 });
  } catch (error) {
    if (error instanceof BoxLabFailureCaseError) retainedBoxId = error.boxId;
    const preserve = options.profile !== "real-provider";
    const fields = {
      ok: false,
      code: "box_lab_smoke_failed",
      retained: preserve && retainedBoxId !== undefined,
      boxId: retainedBoxId,
      shell: preserve && retainedBoxId ? retainedShellCommand(options, retainedBoxId) : undefined,
      diagnostics: preserve ? options.config.diagnosticsDirectory : undefined,
      journalHint: preserve && retainedBoxId
        ? "Inside the retained Box: journalctl --user -u companion-pi-daemon.service --no-pager"
        : undefined,
    } satisfies BoxLabSmokeReport;
    report(options, "failed", fields);
    throw error;
  } finally {
    try {
      if (!succeeded && options.profile === "real-provider") {
        await service.reset();
      }
    } finally {
      await server.close();
    }
  }
}
