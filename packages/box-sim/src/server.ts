/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing simulator HTTP boundary parsing predates the incremental anti-slop gate. */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

import { executeBrokerAgentCommand, type BoxSimCommandMachine } from "./commandShims";
import { createBoxSimPiController } from "./piController";
import {
  BOX_SIM_CONTROL_PREFIX,
  BoxSimHttpError,
  type BoxSimCommandResult,
  type BoxSimDefaults,
  type BoxSimFaultAction,
  type BoxSimFaultRuleInput,
  type BoxSimPiControllerFactory,
} from "./protocol";
import { BoxSimulator, type BoxSimulatorOptions } from "./simulator";

const CONTROL_PREFIX_ALIASES = [BOX_SIM_CONTROL_PREFIX, "/__box-sim", "/_sim"] as const;

export interface BoxSimServerOptions extends BoxSimulatorOptions {
  host?: string;
  port?: number;
  apiKey?: string;
  controlToken?: string;
  bodyLimitBytes?: number;
  simulator?: BoxSimulator;
  piControllerFactory?: BoxSimPiControllerFactory;
  /** When set, a second listener serves the hosted Companion box agent for every simulated Box. */
  agentPort?: number;
  /** Test seam for the agent's long-poll ceiling; production caps at the proxy-safe 25 s. */
  agentLongPollCapMs?: number;
}

export interface BoxSimServerHandle {
  readonly server: Server;
  readonly simulator: BoxSimulator;
  readonly baseUrl: string;
  readonly controlUrl: string;
  /** Base URL of the agent listener; throws when the server was built without agentPort. */
  readonly agentBaseUrl: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxSimHttpError(400, "invalid_json_body", "JSON body must be an object");
  }
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
  return value === undefined ? {} : asObject(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.headersSent) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": payload.byteLength,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function sendBytes(response: ServerResponse, status: number, body: Uint8Array): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    "Content-Type": "application/octet-stream",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: BoxSimHttpError, requestId: string): void {
  sendJson(response, error.status, {
    ok: false,
    type: "box.error",
    status: error.status,
    code: error.code,
    message: error.message,
    error: {
      code: error.code,
      message: error.message,
      status: error.status,
      details: { error: error.message },
    },
    requestId,
  });
}

function parseBoxListLimit(value: string | null): number {
  if (value === null) return 100;
  if (!/^\d+$/.test(value)) {
    throw new BoxSimHttpError(400, "invalid_request", "limit must be a positive integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new BoxSimHttpError(400, "invalid_request", "limit must be between 1 and 200");
  }
  return limit;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw new BoxSimHttpError(413, "request_too_large", `JSON body exceeds ${limit} bytes`);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BoxSimHttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) {
      throw new BoxSimHttpError(413, "request_too_large", `Request body exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BoxSimHttpError(400, "invalid_path", "Path contains invalid percent encoding");
  }
}

function commandFromFault(action: Extract<BoxSimFaultAction, { kind: "command" }>): BoxSimCommandResult {
  const success = action.success ?? false;
  return {
    success,
    exitCode: action.exitCode === undefined ? (success ? 0 : 1) : action.exitCode,
    stdout: action.stdout ?? "",
    stderr: action.stderr ?? (success ? "" : "simulated command fault"),
  };
}

function controlPath(pathname: string): string | null {
  for (const prefix of CONTROL_PREFIX_ALIASES) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }
  return null;
}

function headerEquals(request: IncomingMessage, name: string, expected: string): boolean {
  const value = request.headers[name];
  return typeof value === "string" && value === expected;
}

function confirmedDelete(request: IncomingMessage, boxId: string): boolean {
  return request.headers["x-ascii-confirm-delete"] === boxId;
}

export function createBoxSimServer(options: BoxSimServerOptions = {}): BoxSimServerHandle {
  const host = options.host?.trim() || "127.0.0.1";
  const port = options.port ?? 0;
  const apiKey = options.apiKey ?? "box-sim-api-key";
  const controlToken = options.controlToken ?? "box-sim-control-token";
  const bodyLimitBytes = options.bodyLimitBytes ?? 12 * 1024 * 1024;
  if (!apiKey) throw new Error("Box simulator apiKey must not be empty");
  if (!controlToken) throw new Error("Box simulator controlToken must not be empty");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Box simulator port must be between 0 and 65535");
  }
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new Error("Box simulator bodyLimitBytes must be a positive integer");
  }
  const agentPort = options.agentPort;
  if (agentPort !== undefined && (!Number.isSafeInteger(agentPort) || agentPort < 0 || agentPort > 65_535)) {
    throw new Error("Box simulator agentPort must be between 0 and 65535");
  }
  const agentLongPollCapMs = options.agentLongPollCapMs ?? 25_000;
  if (!Number.isSafeInteger(agentLongPollCapMs) || agentLongPollCapMs < 0) {
    throw new Error("Box simulator agentLongPollCapMs must be a non-negative integer");
  }

  const simulator = options.simulator ?? new BoxSimulator({
    defaults: options.defaults,
    piControllerFactory: options.piControllerFactory === undefined
      ? createBoxSimPiController
      : options.piControllerFactory,
  });
  const sockets = new Set<Socket>();
  const requestIds = new WeakMap<IncomingMessage, string>();
  let requestSequence = 0;

  const requestIdFor = (request: IncomingMessage): string => {
    const existing = requestIds.get(request);
    if (existing) return existing;
    requestSequence += 1;
    const requestId = `req_box_sim_${requestSequence.toString(10).padStart(8, "0")}`;
    requestIds.set(request, requestId);
    return requestId;
  };

  let server!: Server;

  async function applyFault(
    request: IncomingMessage,
    response: ServerResponse,
    point: string,
    commandEndpoint = false,
  ): Promise<boolean> {
    const action = simulator.consumeFault(point);
    if (!action) return false;
    switch (action.kind) {
      case "http":
        sendError(
          response,
          new BoxSimHttpError(
            action.status,
            action.code ?? "simulated_fault",
            action.message ?? `Simulated fault at ${point}`,
          ),
          requestIdFor(request),
        );
        return true;
      case "disconnect":
        request.socket.destroy();
        return true;
      case "stall":
        await new Promise<void>((resolve) => response.once("close", resolve));
        return true;
      case "command":
        if (!commandEndpoint) {
          sendError(
            response,
            new BoxSimHttpError(
              500,
              "invalid_fault_action",
              `Command fault cannot run at ${point}`,
            ),
            requestIdFor(request),
          );
        } else {
          sendJson(response, 200, {
            ok: true,
            type: "command.completed",
            ...commandFromFault(action),
            durationMs: 0,
          });
        }
        return true;
    }
  }

  async function withFault<T>(input: {
    request: IncomingMessage;
    response: ServerResponse;
    point: string;
    commandEndpoint?: boolean;
    operation: () => T | Promise<T>;
    respond: (value: T) => void;
  }): Promise<void> {
    if (await applyFault(
      input.request,
      input.response,
      `${input.point}.before`,
      input.commandEndpoint,
    )) return;
    const value = await input.operation();
    if (await applyFault(
      input.request,
      input.response,
      `${input.point}.after`,
      input.commandEndpoint,
    )) return;
    input.respond(value);
  }

  async function handleControl(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    pathname: string,
  ): Promise<void> {
    if (!headerEquals(request, "x-box-sim-token", controlToken)) {
      throw new BoxSimHttpError(401, "invalid_control_token", "A valid Box simulator control token is required");
    }
    const bodyValue = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readJsonBody(request, bodyLimitBytes);
    const body = optionalObject(bodyValue);
    simulator.recordRequest({ surface: "control", method: request.method ?? "GET", path: url.pathname, body });

    if (request.method === "POST" && pathname === "/reset") {
      await simulator.reset();
      sendJson(response, 200, { ok: true, type: "box-sim.reset", state: simulator.snapshot() });
      return;
    }
    if (request.method === "PUT" && pathname === "/defaults") {
      const patch = (body.defaults === undefined ? body : asObject(body.defaults)) as Partial<BoxSimDefaults>;
      const defaults = simulator.configureDefaults(patch);
      sendJson(response, 200, { ok: true, type: "box-sim.defaults", defaults });
      return;
    }
    if (request.method === "GET" && pathname === "/state") {
      sendJson(response, 200, { ok: true, type: "box-sim.state", state: simulator.snapshot() });
      return;
    }
    if (request.method === "POST" && pathname === "/faults") {
      const fault = simulator.addFault(body as unknown as BoxSimFaultRuleInput);
      sendJson(response, 201, { ok: true, type: "box-sim.fault", fault });
      return;
    }
    const faultMatch = /^\/faults\/([^/]+)$/.exec(pathname);
    if (request.method === "DELETE" && faultMatch) {
      const id = decodePathSegment(faultMatch[1]!);
      if (!simulator.removeFault(id)) {
        throw new BoxSimHttpError(404, "fault_not_found", `Fault ${id} was not found`);
      }
      sendJson(response, 200, { ok: true, type: "box-sim.fault.deleted", id });
      return;
    }
    const tickMatch = /^\/boxes\/([^/]+)\/tick$/.exec(pathname);
    if (request.method === "POST" && tickMatch) {
      const box = simulator.tickBox(
        decodePathSegment(tickMatch[1]!),
        typeof body.count === "number" ? body.count : 1,
      );
      sendJson(response, 200, { ok: true, type: "box-sim.box.tick", box });
      return;
    }
    const crashMatch = /^\/boxes\/([^/]+)\/pi\/crash$/.exec(pathname);
    if (request.method === "POST" && crashMatch) {
      const boxId = decodePathSegment(crashMatch[1]!);
      await simulator.crashPi(boxId);
      sendJson(response, 200, { ok: true, type: "box-sim.pi.crashed", boxId });
      return;
    }
    const scenarioMatch = /^\/boxes\/([^/]+)\/scenario$/.exec(pathname);
    if (request.method === "PUT" && scenarioMatch) {
      const scenario = typeof body.scenario === "string"
        ? body.scenario
        : typeof body.name === "string" ? body.name : "";
      const boxId = decodePathSegment(scenarioMatch[1]!);
      await simulator.setScenario(boxId, scenario);
      sendJson(response, 200, { ok: true, type: "box-sim.scenario", boxId, scenario });
      return;
    }
    const outboxMatch = /^\/boxes\/([^/]+)\/outbox$/.exec(pathname);
    if (request.method === "PUT" && outboxMatch) {
      const boxId = decodePathSegment(outboxMatch[1]!);
      const files = Array.isArray(body.files) ? body.files : [];
      const seeded = simulator.seedOutbox(
        boxId,
        files as { name: string; base64: string }[],
      );
      sendJson(response, 200, { ok: true, type: "box-sim.outbox.seeded", boxId, seeded });
      return;
    }
    const outboxTransportMatch = /^\/boxes\/([^/]+)\/outbox-transport$/.exec(pathname);
    if (request.method === "PUT" && outboxTransportMatch) {
      const boxId = decodePathSegment(outboxTransportMatch[1]!);
      const mangle = body.mangleChunkBytes;
      simulator.setOutboxTransportMangling(
        boxId,
        typeof mangle === "number" ? mangle : null,
      );
      sendJson(response, 200, { ok: true, type: "box-sim.outbox.transport", boxId });
      return;
    }
    const deletionMatch = /^\/deletion-operations\/([^/]+)$/.exec(pathname);
    if (request.method === "PUT" && deletionMatch) {
      const allowed = new Set(["pending", "processing", "blocked", "completed"]);
      if (typeof body.status !== "string" || !allowed.has(body.status)) {
        throw new BoxSimHttpError(400, "invalid_deletion_status", "invalid deletion operation status");
      }
      const operation = simulator.setDeletionOperationStatus(
        decodePathSegment(deletionMatch[1]!),
        body.status as "pending" | "processing" | "blocked" | "completed",
      );
      sendJson(response, 200, { ok: true, type: "box-sim.deletion", operation });
      return;
    }
    throw new BoxSimHttpError(404, "route_not_found", `No simulator control route for ${request.method} ${pathname}`);
  }

  async function handleProvider(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      throw new BoxSimHttpError(401, "unauthorized", "A valid Box API bearer token is required");
    }
    const method = request.method ?? "GET";
    const bodyValue = method === "GET" || method === "HEAD"
      ? undefined
      : await readJsonBody(request, bodyLimitBytes);
    const body = optionalObject(bodyValue);
    simulator.recordRequest({ surface: "box", method, path: url.pathname, body });

    if (method === "GET" && url.pathname === "/boxes") {
      await withFault({
        request,
        response,
        point: "box.list",
        operation: () => simulator.listBoxes({
          cursor: url.searchParams.get("cursor"),
          limit: parseBoxListLimit(url.searchParams.get("limit")),
          sort: url.searchParams.get("sort") === "desc" ? "desc" : "asc",
        }),
        respond: (result) => sendJson(response, 200, {
          ok: true,
          type: "box.list",
          boxes: result.boxes,
          pageInfo: result.pageInfo,
        }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/boxes") {
      await withFault({
        request,
        response,
        point: "box.create",
        operation: () => simulator.createBox({
          ...(typeof request.headers["idempotency-key"] === "string"
            ? { idempotencyKey: request.headers["idempotency-key"] }
            : {}),
          ...(typeof body.ttlSeconds === "number" ? { ttlSeconds: body.ttlSeconds } : {}),
          ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
          ...(body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? { env: body.env as Record<string, unknown> }
            : {}),
          ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
          ...(typeof body.noEnv === "boolean" ? { noEnv: body.noEnv } : {}),
          ...(typeof body.from === "string" ? { from: body.from } : {}),
        }),
        respond: (box) => sendJson(response, 202, {
          ok: true,
          type: "box.created",
          status: box.state,
          ttlSeconds: box.ttlSeconds,
          box,
        }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/named-snapshots") {
      await withFault({
        request,
        response,
        point: "named-snapshot.list",
        operation: () => simulator.listNamedSnapshots(),
        respond: (snapshots) => sendJson(response, 200, {
          ok: true,
          type: "snapshot.named.list",
          snapshots,
        }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/named-snapshots") {
      if (typeof body.boxId !== "string" || typeof body.name !== "string") {
        throw new BoxSimHttpError(400, "invalid_request", "boxId and name are required");
      }
      const boxId = body.boxId;
      const name = body.name;
      await withFault({
        request,
        response,
        point: "named-snapshot.save",
        operation: () => simulator.saveNamedSnapshot({ boxId, name }),
        respond: (snapshot) => sendJson(response, 202, {
          ok: true,
          type: "snapshot.named.saving",
          snapshot,
          status: snapshot.status,
        }),
      });
      return;
    }
    const namedSnapshotMatch = /^\/named-snapshots\/([^/]+)$/.exec(url.pathname);
    if (namedSnapshotMatch) {
      const name = decodePathSegment(namedSnapshotMatch[1]!);
      if (method === "GET") {
        await withFault({
          request,
          response,
          point: "named-snapshot.get",
          operation: () => simulator.getNamedSnapshot(name),
          respond: (snapshot) => sendJson(response, 200, {
            ok: true,
            type: "snapshot.named.info",
            snapshot,
            status: snapshot.status,
          }),
        });
        return;
      }
      if (method === "DELETE") {
        await withFault({
          request,
          response,
          point: "named-snapshot.delete",
          operation: () => simulator.deleteNamedSnapshot(name),
          respond: () => sendJson(response, 200, { ok: true, type: "snapshot.named.deleted", name }),
        });
        return;
      }
    }

    const boxMatch = /^\/boxes\/([^/]+)$/.exec(url.pathname);
    if (boxMatch) {
      const boxId = decodePathSegment(boxMatch[1]!);
      if (method === "GET") {
        await withFault({
          request,
          response,
          point: "box.get",
          operation: () => simulator.getBox(boxId),
          respond: (box) => sendJson(response, 200, { ok: true, type: "box.info", box }),
        });
        return;
      }
      if (method === "PATCH") {
        await withFault({
          request,
          response,
          point: "box.patch",
          operation: () => simulator.patchBox(boxId, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.ttlSeconds === "number" ? { ttlSeconds: body.ttlSeconds } : {}),
          }),
          respond: (box) => sendJson(response, 200, { ok: true, type: "box.updated", box }),
        });
        return;
      }
      if (method === "DELETE") {
        if (!confirmedDelete(request, boxId)) {
          throw new BoxSimHttpError(
            409,
            "delete_confirmation_required",
            `Confirm deletion with X-Ascii-Confirm-Delete: ${boxId}`,
          );
        }
        await withFault({
          request,
          response,
          point: "box.delete",
          operation: () => simulator.deleteBox(boxId),
          respond: (operation) => sendJson(response, 202, {
            ok: true,
            type: "box.deleting",
            operation,
          }),
        });
        return;
      }
    }

    const stopMatch = /^\/boxes\/([^/]+)\/stop$/.exec(url.pathname);
    if (method === "POST" && stopMatch) {
      const boxId = decodePathSegment(stopMatch[1]!);
      await withFault({
        request,
        response,
        point: "box.stop",
        operation: () => simulator.stopBox(boxId),
        respond: (box) => sendJson(response, 202, { ok: true, type: "box.stopping", box }),
      });
      return;
    }
    const resumeMatch = /^\/boxes\/([^/]+)\/resume$/.exec(url.pathname);
    if (method === "POST" && resumeMatch) {
      const boxId = decodePathSegment(resumeMatch[1]!);
      await withFault({
        request,
        response,
        point: "box.resume",
        operation: () => simulator.resumeBox(boxId, {
          ...(typeof body.ttlSeconds === "number" ? { ttlSeconds: body.ttlSeconds } : {}),
        }),
        respond: (box) => sendJson(response, 202, { ok: true, type: "box.resuming", box }),
      });
      return;
    }
    const commandMatch = /^\/boxes\/([^/]+)\/commands$/.exec(url.pathname);
    if (method === "POST" && commandMatch) {
      const boxId = decodePathSegment(commandMatch[1]!);
      await withFault({
        request,
        response,
        point: "box.command",
        commandEndpoint: true,
        operation: () => simulator.executeCommand({
          boxId,
          command: typeof body.command === "string" ? body.command : "",
          ...(typeof body.timeoutSeconds === "number" ? { timeoutSeconds: body.timeoutSeconds } : {}),
        }),
        respond: (result) => sendJson(response, 200, {
          ok: true,
          type: "command.completed",
          ...result,
          durationMs: 0,
        }),
      });
      return;
    }
    const filesMatch = /^\/boxes\/([^/]+)\/files$/.exec(url.pathname);
    if (method === "PUT" && filesMatch) {
      const boxId = decodePathSegment(filesMatch[1]!);
      if (body.encoding !== undefined && body.encoding !== "utf8" && body.encoding !== "base64") {
        throw new BoxSimHttpError(400, "invalid_request", "encoding must be utf8 or base64");
      }
      await withFault({
        request,
        response,
        point: "box.file",
        operation: () => simulator.writeFile({
          boxId,
          path: typeof body.path === "string" ? body.path : "",
          content: typeof body.content === "string" ? body.content : "",
          ...(body.encoding === "base64" ? { encoding: "base64" as const } : {}),
        }),
        respond: (file) => sendJson(response, 200, {
          ok: true,
          type: "file.written",
          success: true,
          ...file,
        }),
      });
      return;
    }
    const desktopMatch = /^\/boxes\/([^/]+)\/desktop$/.exec(url.pathname);
    if (method === "POST" && desktopMatch) {
      const boxId = decodePathSegment(desktopMatch[1]!);
      const transport = url.searchParams.get("vnc") === "1" ? "vnc" : "webrtc";
      await withFault({
        request,
        response,
        point: "box.desktop",
        operation: () => simulator.mintDesktop(boxId, transport),
        respond: (desktop) => sendJson(response, 200, {
          ok: true,
          type: "desktop.url",
          success: true,
          transport,
          ...desktop,
        }),
      });
      return;
    }
    const operationMatch = /^\/deletion-operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && operationMatch) {
      const operationId = decodePathSegment(operationMatch[1]!);
      await withFault({
        request,
        response,
        point: "deletion.get",
        operation: () => simulator.getDeletionOperation(operationId),
        respond: (operation) => sendJson(response, 200, {
          ok: true,
          type: "deletion.operation",
          operation,
        }),
      });
      return;
    }
    throw new BoxSimHttpError(404, "route_not_found", `No Box route for ${method} ${url.pathname}`);
  }

  server = createServer((request, response) => {
    const requestId = requestIdFor(request);
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "box-sim.invalid"}`);
      const control = controlPath(url.pathname);
      if (
        request.method === "GET"
        && (url.pathname === "/health" || control === "/health")
      ) {
        sendJson(response, 200, { ok: true, type: "box-sim.health", tick: simulator.currentTick });
        return;
      }
      if (control !== null) await handleControl(request, response, url, control);
      else await handleProvider(request, response, url);
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      if (error instanceof BoxSimHttpError) sendError(response, error, requestId);
      else sendError(
        response,
        new BoxSimHttpError(500, "internal_error", "Box simulator request failed"),
        requestId,
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  // ---- Companion box agent listener -------------------------------------------------------------
  // The second listener stands in for one hosted agent per Box, all answering from the SAME command
  // machines the exec transport mutates, so both transports must observe byte-identical broker data.
  // The `_token` gate below simulates the ascii.dev proxy sitting in front of the real agent. The
  // real agent's per-client auth-failure ban is intentionally not simulated here: it lives in
  // CompanionBoxAgentCore and is unit-tested there.

  interface AgentResult {
    status: number;
    body: JsonObject;
  }

  function agentError(status: number, code: string, message: string, ambiguous = false): AgentResult {
    return { status, body: { error: { code, message, ambiguous } } };
  }

  function agentLayoutMarker(machine: BoxSimCommandMachine): string | null {
    return machine.persistentFiles.get(".companion/runtime/state/pi-layout.version")
      ?.toString("utf8").trim() || null;
  }

  /** True when the presented proxy `_token` matches any hosted registration minted for this Box. */
  function proxyTokenMatches(machine: BoxSimCommandMachine, presented: string | null): boolean {
    if (!presented) return false;
    for (const hosted of machine.hostedPorts.values()) {
      let minted: string | null;
      try {
        minted = new URL(hosted.url).searchParams.get("_token");
      } catch {
        minted = null;
      }
      if (minted && minted === presented) return true;
    }
    return false;
  }

  /** Timing-safe digest comparison against the staged `{ tokenSha256 }`, mirroring the real agent. */
  function bearerMatches(machine: BoxSimCommandMachine, authorization: string | undefined): boolean {
    const token = typeof authorization === "string"
      ? /^Bearer\s+(\S+)$/.exec(authorization.trim())?.[1]
      : undefined;
    const authFile = machine.persistentFiles
      .get(".companion/runtime/state/agent-auth.json")?.toString("utf8");
    if (!token || !authFile) return false;
    let storedSha256: unknown;
    try {
      const parsed = JSON.parse(authFile) as unknown;
      storedSha256 = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonObject).tokenSha256
        : undefined;
    } catch {
      return false;
    }
    if (typeof storedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(storedSha256)) return false;
    const presented = createHash("sha256").update(token, "utf8").digest();
    const expected = Buffer.from(storedSha256, "hex");
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  let agentCommandSequence = 0;

  /** Run one broker control command and map its envelope exactly as the real agent core does. */
  async function agentBroker(
    machine: BoxSimCommandMachine,
    type: string,
    fields: JsonObject,
    preserveCommandId = false,
  ): Promise<AgentResult> {
    if (machine.daemon.status !== "active" || !machine.daemon.rpcReady) {
      // The daemon owns the broker socket, so a stopped Pi is an unreachable broker, not an error
      // from it. This is the retryable state the real agent reports during staging and restarts.
      return agentError(503, "broker_unavailable", "Pi broker is unreachable");
    }
    agentCommandSequence += 1;
    const id = preserveCommandId && typeof fields.id === "string"
      ? fields.id
      : `agent:${agentCommandSequence.toString(10)}`;
    const result = await executeBrokerAgentCommand(machine, {
      // SAFETY: broker control fields are JSON scalars/objects assembled by the handlers below.
      ...(fields as Record<string, string | number>),
      id,
      type,
    });
    if (!result.success) return agentError(503, "broker_unavailable", "Pi broker is unreachable");
    const response = JSON.parse(result.stdout) as JsonObject;
    const data = response.data;
    if (response.success === true && data && typeof data === "object" && !Array.isArray(data)) {
      return { status: 200, body: data as JsonObject };
    }
    const error = response.error && typeof response.error === "object" && !Array.isArray(response.error)
      ? response.error as JsonObject
      : null;
    return agentError(
      502,
      typeof error?.code === "string" && error.code ? error.code : "broker_failed",
      typeof error?.message === "string" ? error.message : "Pi broker command failed",
      error?.ambiguous === true,
    );
  }

  function agentNonNegativeInteger(query: URLSearchParams, name: string, fallback: number): number | null {
    const raw = query.get(name);
    if (raw === null || raw === "") return fallback;
    if (!/^\d{1,15}$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async function agentEvents(machine: BoxSimCommandMachine, query: URLSearchParams): Promise<AgentResult> {
    const after = agentNonNegativeInteger(query, "after", 0);
    if (after === null) return agentError(400, "invalid_request", "after must be a non-negative integer");
    const limit = agentNonNegativeInteger(query, "limit", 0);
    if (limit === null) return agentError(400, "invalid_request", "limit must be a non-negative integer");
    const requestedWait = agentNonNegativeInteger(query, "wait_ms", 0);
    if (requestedWait === null) {
      return agentError(400, "invalid_request", "wait_ms must be a non-negative integer");
    }
    const deadline = Date.now() + Math.min(requestedWait, agentLongPollCapMs);
    // Long-poll, not SSE: an empty page re-polls the shared machine until an event arrives or the
    // capped deadline passes, then the last read is returned as-is.
    for (;;) {
      const result = await agentBroker(machine, "read_events", {
        after,
        ...(limit > 0 ? { limit } : {}),
      });
      if (result.status !== 200) return result;
      const events = result.body.events;
      if (Array.isArray(events) && events.length > 0) return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
  }

  async function agentAck(machine: BoxSimCommandMachine, request: IncomingMessage): Promise<AgentResult> {
    let body: unknown;
    try {
      body = await readJsonBody(request, 64 * 1024);
    } catch (error) {
      if (error instanceof BoxSimHttpError && error.status === 413) {
        return agentError(413, "payload_too_large", "request body exceeds the agent limit");
      }
      return agentError(400, "invalid_request", "a JSON body is required");
    }
    const through = body && typeof body === "object" && !Array.isArray(body)
      ? (body as JsonObject).through
      : undefined;
    if (!Number.isSafeInteger(through) || Number(through) < 0) {
      return agentError(400, "invalid_request", "through must be a non-negative integer");
    }
    return agentBroker(machine, "ack_events", { through: Number(through) });
  }

  function sendAccessDenied(response: ServerResponse): void {
    if (response.destroyed || response.headersSent) return;
    const payload = Buffer.from("Access denied", "utf8");
    response.writeHead(403, {
      "Cache-Control": "no-store",
      "Content-Length": payload.byteLength,
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(payload);
  }

  async function handleAgent(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // (1) The proxy link itself can drop mid-flight; this fires before any gate answers.
    if (simulator.consumeFault("agent.disconnect")) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://box-sim-agent.invalid");
    const match = /^\/boxes\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!match) {
      sendJson(response, 404, { error: { code: "not_found", message: "unknown agent route", ambiguous: false } });
      return;
    }
    // (2) The proxy `_token` gate. An unknown Box and a wrong token answer identically: the real
    // proxy denies without revealing whether the hosted service exists.
    let machine: BoxSimCommandMachine;
    try {
      machine = simulator.commandMachine(decodePathSegment(match[1]!));
    } catch {
      sendAccessDenied(response);
      return;
    }
    if (!proxyTokenMatches(machine, url.searchParams.get("_token"))) {
      sendAccessDenied(response);
      return;
    }
    // (3) The agent's own bearer gate, behind the proxy as defense in depth.
    if (!bearerMatches(machine, request.headers.authorization)) {
      sendJson(response, 401, {
        error: { code: "unauthorized", message: "a valid agent bearer token is required", ambiguous: false },
      });
      return;
    }
    const path = match[2]!.replace(/\/+$/, "") || "/";
    const method = request.method ?? "GET";
    if (method === "GET" && path === "/v1/health") {
      sendJson(response, 200, {
        agentVersion: 2,
        piUnit: machine.daemon.status === "active" ? "active" : "inactive",
        brokerSocketReady: machine.daemon.status === "active" && machine.daemon.rpcReady,
        layoutMarker: agentLayoutMarker(machine),
      });
      return;
    }
    if (method === "GET" && path === "/v1/broker/state") {
      const result = await agentBroker(machine, "runtime_state", {});
      sendJson(response, result.status, result.body);
      return;
    }
    if (method === "GET" && path === "/v1/events") {
      await withFault({
        request,
        response,
        point: "agent.events",
        operation: () => agentEvents(machine, url.searchParams),
        respond: (result) => sendJson(response, result.status, result.body),
      });
      return;
    }
    if (method === "POST" && path === "/v1/ack") {
      const result = await agentAck(machine, request);
      sendJson(response, result.status, result.body);
      return;
    }
    if (method === "POST" && path === "/v1/prompt") {
      const body = asObject(await readJsonBody(request, 64 * 1024));
      if (
        typeof body.commandId !== "string"
        || typeof body.attemptId !== "string"
        || typeof body.expectedInvocationId !== "string"
        || typeof body.message !== "string"
        || body.message.length === 0
      ) {
        sendJson(response, 400, agentError(400, "invalid_request", "prompt identity, invocation, and message are required").body);
        return;
      }
      await withFault({
        request,
        response,
        point: "agent.prompt",
        operation: () => agentBroker(machine, "prompt", {
          id: body.commandId as string,
          attemptId: body.attemptId as string,
          expectedInvocationId: body.expectedInvocationId as string,
          message: body.message as string,
          requiredInput: ["text"],
          clearOutbox: true,
        }, true),
        respond: (result) => sendJson(response, result.status, result.body),
      });
      return;
    }
    if (method === "GET" && path === "/v1/dispatch/status") {
      const attemptId = url.searchParams.get("attempt_id");
      const commandId = url.searchParams.get("command_id");
      if (!attemptId || !commandId) {
        sendJson(response, 400, agentError(400, "invalid_request", "dispatch identity is required").body);
        return;
      }
      const result = await agentBroker(machine, "dispatch_status", { attemptId, commandId });
      sendJson(response, result.status, result.body);
      return;
    }
    if (method === "POST" && path === "/v1/abort") {
      const body = asObject(await readJsonBody(request, 64 * 1024));
      if (typeof body.commandId !== "string" || typeof body.attemptId !== "string") {
        sendJson(response, 400, agentError(400, "invalid_request", "abort identity is required").body);
        return;
      }
      const result = await agentBroker(machine, "abort", {
        id: body.commandId,
        attemptId: body.attemptId,
      }, true);
      sendJson(response, result.status, result.body);
      return;
    }
    if (method === "POST" && path === "/v1/decision") {
      const body = asObject(await readJsonBody(request, 64 * 1024));
      if (
        typeof body.commandId !== "string"
        || typeof body.attemptId !== "string"
        || !body.response
        || typeof body.response !== "object"
        || Array.isArray(body.response)
      ) {
        sendJson(response, 400, agentError(400, "invalid_request", "decision identity and response are required").body);
        return;
      }
      const result = await agentBroker(machine, "extension_ui_response", {
        id: body.commandId,
        attemptId: body.attemptId,
        response: body.response,
      }, true);
      sendJson(response, result.status, result.body);
      return;
    }
    if (method === "PUT" && path === "/v1/files") {
      const messageId = url.searchParams.get("message_id");
      const position = url.searchParams.get("position");
      const digest = url.searchParams.get("sha256");
      if (
        !messageId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(messageId)
        || position === null || !/^\d$/.test(position)
        || !digest || !/^[a-f0-9]{64}$/.test(digest)
      ) {
        sendJson(response, 400, agentError(400, "invalid_request", "attachment upload metadata is invalid").body);
        return;
      }
      const bytes = await readRawBody(request, 10 * 1024 * 1024);
      if (createHash("sha256").update(bytes).digest("hex") !== digest) {
        sendJson(response, 409, agentError(409, "digest_mismatch", "attachment bytes do not match their digest").body);
        return;
      }
      machine.persistentFiles.set(
        `.companion/runtime/attachment-uploads/${messageId}/${position}-${digest}`,
        Buffer.from(bytes),
      );
      sendJson(response, 200, { uploaded: true, position: Number(position), byteSize: bytes.byteLength, sha256: digest });
      return;
    }
    const attachmentCommit = /^\/v1\/attachments\/([0-9a-f-]{36})$/.exec(path);
    if (method === "POST" && attachmentCommit) {
      const messageId = attachmentCommit[1]!;
      const body = asObject(await readJsonBody(request, 64 * 1024));
      if (!Array.isArray(body.files) || body.files.length > 10) {
        sendJson(response, 400, agentError(400, "invalid_request", "attachment manifest is invalid").body);
        return;
      }
      const committed: JsonObject[] = [];
      for (const candidate of body.files) {
        const file = asObject(candidate);
        if (
          !Number.isSafeInteger(file.position)
          || Number(file.position) < 0 || Number(file.position) > 9
          || typeof file.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(file.filename)
          || typeof file.contentType !== "string"
          || !Number.isSafeInteger(file.byteSize) || Number(file.byteSize) < 1
          || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
        ) {
          sendJson(response, 400, agentError(400, "invalid_request", "attachment entry is invalid").body);
          return;
        }
        const uploaded = machine.persistentFiles.get(
          `.companion/runtime/attachment-uploads/${messageId}/${String(file.position)}-${file.sha256}`,
        );
        if (!uploaded || uploaded.byteLength !== file.byteSize) {
          sendJson(response, 409, agentError(409, "attachment_unavailable", "one or more uploaded files are unavailable").body);
          return;
        }
        committed.push({
          ...file,
          path: `~/attachments/${messageId}/${String(file.position)}-${file.filename}`,
        });
      }
      for (const filePath of machine.persistentFiles.keys()) {
        if (filePath.startsWith("attachments/")) machine.persistentFiles.delete(filePath);
      }
      for (const file of committed) {
        const uploadedPath = `.companion/runtime/attachment-uploads/${messageId}/${String(file.position)}-${String(file.sha256)}`;
        machine.persistentFiles.set(
          `attachments/${messageId}/${String(file.position)}-${String(file.filename)}`,
          Buffer.from(machine.persistentFiles.get(uploadedPath)!),
        );
        machine.persistentFiles.delete(uploadedPath);
      }
      sendJson(response, 200, { files: committed });
      return;
    }
    if (method === "POST" && path === "/v1/outbox/clear") {
      for (const filePath of machine.persistentFiles.keys()) {
        if (filePath.startsWith("outbox/")) machine.persistentFiles.delete(filePath);
      }
      sendJson(response, 200, { cleared: true });
      return;
    }
    if (method === "GET" && path === "/v1/outbox") {
      const entries = [...machine.persistentFiles.entries()]
        .filter(([filePath]) => /^outbox\/[^/]+$/.test(filePath))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([filePath, bytes]) => {
          const name = filePath.slice("outbox/".length);
          return {
            name,
            encodedName: Buffer.from(name, "utf8").toString("base64"),
            byteSize: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        });
      sendJson(response, 200, { entries });
      return;
    }
    if (method === "GET" && path === "/v1/outbox/file") {
      const encodedName = url.searchParams.get("name") ?? "";
      const name = Buffer.from(encodedName, "base64").toString("utf8");
      if (!name || name.includes("/") || Buffer.from(name, "utf8").toString("base64") !== encodedName) {
        sendJson(response, 404, agentError(404, "not_found", "outbox entry is unavailable").body);
        return;
      }
      const bytes = machine.persistentFiles.get(`outbox/${name}`);
      if (!bytes) {
        sendJson(response, 404, agentError(404, "not_found", "outbox entry is unavailable").body);
        return;
      }
      sendBytes(response, 200, bytes);
      return;
    }
    sendJson(response, 404, { error: { code: "not_found", message: "unknown agent route", ambiguous: false } });
  }

  const agentServer = agentPort === undefined ? null : createServer((request, response) => {
    void handleAgent(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      if (error instanceof BoxSimHttpError) {
        sendJson(response, error.status, agentError(error.status, error.code, error.message).body);
        return;
      }
      sendJson(response, 500, {
        error: { code: "agent_internal", message: "the box agent simulator failed to answer", ambiguous: false },
      });
    });
  });
  agentServer?.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  if (agentServer) {
    // Late-bound: the machines mint hosted URLs during command execution, which only ever happens
    // after listen(), so resolving the agent address inside the factory is safe.
    simulator.setHostedUrlFactory(() => resolvedUrl(agentServer, "agent"));
  }

  function resolvedUrl(target: Server, label: "provider" | "agent"): string {
    const address = target.address();
    if (!address || typeof address === "string") {
      throw new Error(`Box simulator ${label} listener is not listening`);
    }
    const connectHost = address.address === "0.0.0.0" || address.address === "::"
      ? "127.0.0.1"
      : address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `http://${connectHost}:${address.port}`;
  }

  function resolvedBaseUrl(): string {
    return resolvedUrl(server, "provider");
  }

  function listenOn(target: Server, targetPort: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        target.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        target.off("error", onError);
        resolve();
      };
      target.once("error", onError);
      target.once("listening", onListening);
      target.listen(targetPort, host);
    });
  }

  return {
    server,
    simulator,
    get baseUrl() {
      return resolvedBaseUrl();
    },
    get controlUrl() {
      return `${resolvedBaseUrl()}${BOX_SIM_CONTROL_PREFIX}`;
    },
    get agentBaseUrl() {
      if (!agentServer) throw new Error("Box simulator was created without an agent listener");
      return resolvedUrl(agentServer, "agent");
    },
    async listen() {
      if (!server.listening) await listenOn(server, port);
      if (agentServer && !agentServer.listening) await listenOn(agentServer, agentPort!);
      void (server.address() as AddressInfo | null);
    },
    async close() {
      await simulator.dispose();
      for (const socket of sockets) socket.destroy();
      const closing: Array<Promise<void>> = [];
      for (const target of [server, agentServer]) {
        if (!target?.listening) continue;
        closing.push(new Promise<void>((resolve, reject) => {
          target.close((error) => error ? reject(error) : resolve());
        }));
      }
      await Promise.all(closing);
    },
  };
}
