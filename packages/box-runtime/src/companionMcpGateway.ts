import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { pipeline, Readable, Transform } from "node:stream";
import { z } from "zod";
import {
  COMPANION_CONTROL_MCP_PROTOCOL_VERSION,
  COMPANION_CONTROL_MCP_SERVER_NAME,
  COMPANION_CONTROL_MCP_TOOLS,
} from "@companion/contracts";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_SLACK_MCP_REQUEST_BYTES = 64 * 1024;
const MAX_SLACK_RESPONSE_BYTES = 64 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;
const SLACK_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const gatewayConfigSchema = z.object({
  accounts: z.array(z.object({
    accountId: z.string().regex(UUID),
    credentialGeneration: z.string().regex(UUID),
    upstreamUrl: z.string().url(),
    github: z.boolean(),
    slack: z.literal(true).optional(),
    allowedTools: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  }).strict()).max(50),
}).strict();
const gatewayAddressSchema = z.object({ port: z.number().int().min(1).max(65_535) }).passthrough();
const accessTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_at: z.string().datetime().nullable(),
  credential_version: z.number().int().positive(),
}).strict();
const forwardedHeaderSchema = z.string();
const mcpRequestSchema = z.object({
  method: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  params: z.object({ name: z.string().optional() }).passthrough().optional(),
}).passthrough();
const mcpRequestEnvelopeSchema = z.union([
  mcpRequestSchema,
  z.array(mcpRequestSchema).min(1),
]);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));
const mcpToolSchema = z.object({ name: z.string() }).passthrough();
const mcpToolsListResponseSchema = z.object({
  result: z.object({ tools: z.array(mcpToolSchema) }).passthrough(),
}).passthrough();
type McpToolsListResponse = z.infer<typeof mcpToolsListResponseSchema>;

interface GatewayAccount {
  accountId: string;
  credentialGeneration: string;
  upstreamUrl: string;
  github: boolean;
  slack: boolean;
  allowedTools: readonly string[] | null;
}

interface CachedAccess {
  token: string;
  expiresAt: number | null;
  receivedAt: number;
}

export interface CompanionMcpGateway {
  origin: string;
  close(): Promise<void>;
}

export async function startCompanionMcpGateway(input: {
  configPath: string;
  apiUrl: string;
  brokerToken: string;
  controlToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<CompanionMcpGateway | null> {
  const accounts = readGatewayAccounts(input.configPath);
  const controlToken = input.controlToken ?? "";
  if (accounts.length === 0 && !controlToken) return null;
  if (accounts.length > 0 && !/^cmp_mcp_[0-9a-f]{48}$/.test(input.brokerToken)) {
    throw new Error("MCP broker capability is unavailable");
  }
  if (!/^cmp_ctl_[0-9a-f]{48}$/.test(controlToken)) {
    throw new Error("Companion control capability is unavailable");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const cache = new Map<string, CachedAccess>();
  const pending = new Map<string, { force: boolean; promise: Promise<CachedAccess> }>();
  let origin = "";

  const accessFor = async (account: GatewayAccount, force: boolean): Promise<CachedAccess> => {
    const cached = cache.get(account.accountId);
    const requestForce = force || Boolean(cached && !cacheUsable(cached, now()));
    const active = pending.get(account.accountId);
    if (active) {
      const value = await active.promise;
      if (!force || active.force) return value;
      return await accessFor(account, true);
    }
    const request = fetchAccessToken({
      account,
      apiUrl: input.apiUrl,
      brokerToken: input.brokerToken,
      forceRefresh: requestForce,
      fetchImpl,
      now,
    }).then((value) => {
      cache.set(account.accountId, value);
      return value;
    }).finally(() => pending.delete(account.accountId));
    pending.set(account.accountId, { force: requestForce, promise: request });
    return await request;
  };

  const server = createServer((request, response) => {
    void handleGatewayRequest({
      request,
      response,
      accounts,
      accessFor,
      fetchImpl,
      apiUrl: input.apiUrl,
      controlToken,
      gatewayOrigin: () => origin,
    }).catch(() => {
      if (response.headersSent) response.destroy();
      else safeError(response, 502);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = gatewayAddressSchema.safeParse(server.address());
  if (!address.success) {
    server.close();
    throw new Error("MCP gateway did not bind a loopback port");
  }
  origin = `http://127.0.0.1:${address.data.port}`;
  return {
    origin,
    close: async () => await new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

function readGatewayAccounts(path: string): GatewayAccount[] {
  if (!existsSync(path)) return [];
  const parsed = gatewayConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const seen = new Set<string>();
  return parsed.accounts.map((value) => {
    if (seen.has(value.accountId)) throw new Error("invalid MCP gateway account");
    const upstream = new URL(value.upstreamUrl);
    if (upstream.protocol !== "https:" || upstream.username || upstream.password) {
      throw new Error("invalid MCP gateway upstream");
    }
    seen.add(value.accountId);
    return {
      accountId: value.accountId,
      credentialGeneration: value.credentialGeneration,
      upstreamUrl: upstream.toString(),
      github: value.github,
      slack: value.slack === true,
      allowedTools: value.allowedTools ? [...new Set(value.allowedTools)] : null,
    };
  });
}

function cacheUsable(cached: CachedAccess, now: number): boolean {
  if (cached.expiresAt === null) return true;
  const lifetime = Math.max(0, cached.expiresAt - cached.receivedAt);
  const margin = Math.min(30_000, Math.max(100, Math.floor(lifetime / 10)));
  return cached.expiresAt - now > margin;
}

async function fetchAccessToken(input: {
  account: GatewayAccount;
  apiUrl: string;
  brokerToken: string;
  forceRefresh: boolean;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<CachedAccess> {
  const endpoint = new URL("runtime/mcp-access-token", `${input.apiUrl.replace(/\/+$/, "")}/`);
  const response = await input.fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.brokerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      account_id: input.account.accountId,
      credential_generation: input.account.credentialGeneration,
      force_refresh: input.forceRefresh,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("MCP access token request failed");
  }
  const raw = accessTokenResponseSchema.parse(await response.json());
  const expiresAt = raw.expires_at === null ? null : Date.parse(raw.expires_at);
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= input.now())) {
    throw new Error("MCP access token is already expired");
  }
  return { token: raw.access_token, expiresAt, receivedAt: input.now() };
}

async function handleGatewayRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  accounts: GatewayAccount[];
  accessFor(account: GatewayAccount, force: boolean): Promise<CachedAccess>;
  fetchImpl: typeof fetch;
  apiUrl: string;
  controlToken: string;
  gatewayOrigin(): string;
}): Promise<void> {
  const requestUrl = new URL(input.request.url ?? "/", input.gatewayOrigin());
  if (requestUrl.pathname === "/control") {
    return await handleCompanionControlRequest({
      request: input.request,
      response: input.response,
      apiUrl: input.apiUrl,
      controlToken: input.controlToken,
      fetchImpl: input.fetchImpl,
    });
  }
  const route = /^\/(mcp|git)\/([0-9a-f-]{36})(?:\/endpoint\/([A-Za-z0-9_-]+))?$/.exec(requestUrl.pathname);
  if (!route) return safeError(input.response, 404);
  const account = input.accounts.find((candidate) => candidate.accountId === route[2]);
  if (!account) return safeError(input.response, 404);
  if (route[1] === "git") {
    if (!account.github || input.request.method !== "GET") return safeError(input.response, 404);
    const access = await input.accessFor(account, false);
    input.response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      pragma: "no-cache",
    });
    input.response.end(access.token);
    return;
  }
  if (account.slack) {
    return await handleSlackMcpRequest({
      request: input.request,
      response: input.response,
      account,
      accessFor: input.accessFor,
      fetchImpl: input.fetchImpl,
    });
  }
  if (!input.request.method || !["GET", "POST", "DELETE"].includes(input.request.method)) {
    return safeError(input.response, 405);
  }
  const body = input.request.method === "GET" || input.request.method === "DELETE"
    ? undefined
    : await readBoundedBody(input.request, MAX_REQUEST_BYTES);
  const toolRequest = inspectMcpToolRequest(body, account.allowedTools);
  if (toolRequest.blocked) return jsonRpcToolDenied(input.response, toolRequest.id);
  const endpointTarget = route[3] ? decodeEndpoint(route[3], account.upstreamUrl) : null;
  const target = endpointTarget ?? new URL(account.upstreamUrl);
  const firstAccess = await input.accessFor(account, false);
  let upstream = await forward({
    target,
    method: input.request.method,
    incomingHeaders: input.request.headers,
    body,
    accessToken: firstAccess.token,
    fetchImpl: input.fetchImpl,
  });
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    const refreshed = await input.accessFor(account, true);
    upstream = await forward({
      target,
      method: input.request.method,
      incomingHeaders: input.request.headers,
      body,
      accessToken: refreshed.token,
      fetchImpl: input.fetchImpl,
    });
  }
  await proxyResponse({
    response: input.response,
    upstream,
    account,
    gatewayOrigin: input.gatewayOrigin(),
    filterToolsList: toolRequest.filterToolsList,
  });
}

async function handleCompanionControlRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  apiUrl: string;
  controlToken: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  if (input.request.method !== "POST") return safeError(input.response, 405);
  const body = await readBoundedBody(input.request, MAX_REQUEST_BYTES);
  let request: JsonRpcRequest | null = null;
  try {
    const parsed = jsonRpcRequestSchema.safeParse(JSON.parse(body.toString("utf8")));
    if (parsed.success) request = parsed.data;
  } catch {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" },
    });
  }
  if (!request) {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" },
    });
  }
  if (request.method === "notifications/initialized") {
    input.response.writeHead(202, { "cache-control": "no-store" });
    input.response.end();
    return;
  }
  if (request.method === "initialize") {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: COMPANION_CONTROL_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: COMPANION_CONTROL_MCP_SERVER_NAME, version: "1.0.0" },
      },
    });
  }
  if (request.method === "tools/list") {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: { tools: jsonValueSchema.parse(COMPANION_CONTROL_MCP_TOOLS) },
    });
  }
  if (request.method !== "tools/call") {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0", id: request.id ?? null,
      error: { code: -32601, message: "Method not found" },
    });
  }
  const endpoint = new URL("runtime/companion-control", `${input.apiUrl.replace(/\/+$/, "")}/`);
  const upstream = await input.fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.controlToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": COMPANION_CONTROL_MCP_PROTOCOL_VERSION,
    },
    body,
  });
  const bytes = await readBoundedWebBody(upstream.body ?? new ReadableStream<Uint8Array>());
  input.response.writeHead(upstream.status, {
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
  });
  input.response.end(bytes);
}

interface McpToolRequestInspection {
  blocked: boolean;
  filterToolsList: boolean;
  id: string | number | null;
}

function inspectMcpToolRequest(
  body: Buffer | undefined,
  allowedTools: readonly string[] | null,
): McpToolRequestInspection {
  const fallback = { blocked: false, filterToolsList: false, id: null };
  if (!body || !allowedTools) return fallback;
  let raw: object;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    return fallback;
  }
  const parsed = mcpRequestEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { blocked: true, filterToolsList: false, id: null };
  const requests = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const allowed = new Set(allowedTools);
  let filterToolsList = false;
  for (const request of requests) {
    if (request.method === "tools/list") filterToolsList = true;
    if (request.method !== "tools/call") continue;
    const name = request.params?.name;
    if (!name || !allowed.has(name)) {
      const id = request.id ?? null;
      return { blocked: true, filterToolsList, id };
    }
  }
  return { blocked: false, filterToolsList, id: null };
}

async function forward(input: {
  target: URL;
  method: string;
  incomingHeaders: IncomingHttpHeaders;
  body: Buffer | undefined;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${input.accessToken}` });
  for (const name of ["accept", "content-type", "last-event-id", "mcp-protocol-version", "mcp-session-id"]) {
    const value = forwardedHeaderSchema.safeParse(input.incomingHeaders[name]);
    if (value.success) headers.set(name, value.data);
  }
  return await input.fetchImpl(input.target, {
    method: input.method,
    headers,
    body: input.body,
    redirect: "error",
  });
}

async function proxyResponse(input: {
  response: ServerResponse;
  upstream: Response;
  account: GatewayAccount;
  gatewayOrigin: string;
  filterToolsList: boolean;
}): Promise<void> {
  const headers: OutgoingHttpHeaders = { "cache-control": "no-store" };
  for (const name of ["content-type", "mcp-protocol-version", "mcp-session-id", "retry-after"]) {
    const value = input.upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  input.response.writeHead(input.upstream.status, headers);
  if (!input.upstream.body) {
    input.response.end();
    return;
  }
  const contentType = input.upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    input.filterToolsList
    && input.account.allowedTools
    && contentType.includes("application/json")
  ) {
    const bytes = await readBoundedWebBody(input.upstream.body);
    input.response.end(filterMcpToolsListJson(bytes, input.account.allowedTools));
    return;
  }
  // SAFETY: Node's fetch body is a Web ReadableStream, while this Node release's overload keeps a
  // narrower generic declaration. The runtime value is exactly the stream accepted by fromWeb.
  const body = Readable.fromWeb(input.upstream.body as never);
  if (contentType.startsWith("text/event-stream")) {
    pipeline(body, endpointRewriteTransform(
      input.account,
      input.gatewayOrigin,
      input.filterToolsList,
    ), input.response, (error) => {
      if (error && !input.response.destroyed) input.response.destroy(error);
    });
  } else {
    pipeline(body, input.response, (error) => {
      if (error && !input.response.destroyed) input.response.destroy(error);
    });
  }
}

function endpointRewriteTransform(
  account: GatewayAccount,
  gatewayOrigin: string,
  filterToolsList: boolean,
): Transform {
  let pending = "";
  let endpointEvent = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        this.push(lines.map((line) => {
          if (line.trim() === "event: endpoint") endpointEvent = true;
          if (endpointEvent && line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            const target = new URL(raw, account.upstreamUrl);
            if (target.origin !== new URL(account.upstreamUrl).origin || target.username || target.password) {
              throw new Error("invalid MCP SSE endpoint");
            }
            endpointEvent = false;
            const encoded = Buffer.from(target.toString(), "utf8").toString("base64url");
            return `data: ${gatewayOrigin}/mcp/${account.accountId}/endpoint/${encoded}`;
          }
          if (filterToolsList && account.allowedTools && line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            if (raw && raw !== "[DONE]") {
              return `data: ${filterMcpToolsListPayload(raw, account.allowedTools)}`;
            }
          }
          if (line === "\r" || line === "") endpointEvent = false;
          return line;
        }).join("\n") + "\n");
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error("invalid MCP SSE endpoint"));
      }
    },
    flush(callback) {
      if (pending) this.push(pending);
      callback();
    },
  });
}

function filterMcpToolsListJson(bytes: Buffer, allowedTools: readonly string[]): Buffer {
  return Buffer.from(filterMcpToolsListPayload(bytes.toString("utf8"), allowedTools), "utf8");
}

function filterMcpToolsListPayload(raw: string, allowedTools: readonly string[]): string {
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(raw));
    return JSON.stringify(filterMcpToolsListValue(parsed, allowedTools));
  } catch {
    // Non-result events and provider errors must remain provider responses, not gateway failures.
    return raw;
  }
}

function filterMcpToolsListValue(
  value: JsonValue,
  allowedTools: readonly string[],
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => filterMcpToolsListValue(item, allowedTools));
  }
  const response = mcpToolsListResponseSchema.safeParse(value);
  if (!response.success) return value;
  return jsonValueSchema.parse(filterMcpToolsListResponse(response.data, allowedTools));
}

function filterMcpToolsListResponse(
  value: McpToolsListResponse,
  allowedTools: readonly string[],
): McpToolsListResponse {
  const allowed = new Set(allowedTools);
  return {
    ...value,
    result: {
      ...value.result,
      tools: value.result.tools.filter((tool) => allowed.has(tool.name)),
    },
  };
}

async function readBoundedWebBody(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      size += bytes.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error("MCP response body is too large");
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function jsonRpcToolDenied(response: ServerResponse, id: string | number | null): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "This MCP tool is not enabled for this plugin." },
  }));
}

function decodeEndpoint(encoded: string, upstreamUrl: string): URL {
  const value = Buffer.from(encoded, "base64url").toString("utf8");
  const endpoint = new URL(value);
  if (endpoint.origin !== new URL(upstreamUrl).origin || endpoint.username || endpoint.password) {
    throw new Error("invalid MCP endpoint origin");
  }
  return endpoint;
}

async function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) throw new Error("MCP request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

const slackConversationIdSchema = z.string().trim().regex(/^[CGD][A-Z0-9]{1,31}$/);
const slackThreadTimestampSchema = z.string().trim().regex(/^\d{1,16}\.\d{6}$/);
const slackPostMessageArgumentsSchema = z.object({
  channel: slackConversationIdSchema,
  text: z.string().trim().min(1).max(4_000),
  thread_ts: slackThreadTimestampSchema.optional(),
  reply_broadcast: z.boolean().optional(),
}).strict();
const slackSuccessSchema = z.object({
  ok: z.literal(true),
  channel: slackConversationIdSchema,
  ts: slackThreadTimestampSchema,
}).passthrough();

type CompanionMcpJsonValue =
  | string
  | number
  | boolean
  | null
  | CompanionMcpJsonValue[]
  | { [key: string]: CompanionMcpJsonValue };
const companionMcpJsonValueSchema: z.ZodType<CompanionMcpJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(companionMcpJsonValueSchema),
  z.record(companionMcpJsonValueSchema),
]));
const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
  method: z.string(),
  params: companionMcpJsonValueSchema.optional(),
}).strict();
type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

async function handleSlackMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  account: GatewayAccount;
  accessFor(account: GatewayAccount, force: boolean): Promise<CachedAccess>;
  fetchImpl: typeof fetch;
}): Promise<void> {
  if (input.request.method !== "POST") return safeError(input.response, 405);
  if (input.account.upstreamUrl !== "https://slack.com/api/chat.postMessage") {
    return safeError(input.response, 502);
  }
  const body = await readBoundedBody(input.request, MAX_SLACK_MCP_REQUEST_BYTES);
  let request: JsonRpcRequest | null = null;
  try {
    const parsed = jsonRpcRequestSchema.safeParse(JSON.parse(body.toString("utf8")));
    if (parsed.success) request = parsed.data;
  } catch {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON" },
    });
  }
  if (!request) {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
  }
  if (request.method === "notifications/initialized") {
    input.response.writeHead(202, { "cache-control": "no-store" });
    input.response.end();
    return;
  }
  if (request.method === "initialize") {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "companion-slack", version: "1.0.0" },
      },
    });
  }
  if (request.method === "tools/list") {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        tools: [{
          name: "slack_chat_post_message",
          description: "Send a message to a Slack channel, direct message, or thread.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              channel: {
                type: "string",
                description: "Slack conversation ID, such as C…, G…, or D….",
              },
              text: { type: "string", minLength: 1, maxLength: 4000 },
              thread_ts: {
                type: "string",
                description: "Optional parent message timestamp for a thread reply.",
              },
              reply_broadcast: {
                type: "boolean",
                description: "Also show a thread reply in the channel.",
              },
            },
            required: ["channel", "text"],
          },
        }],
      },
    });
  }
  if (request.method !== "tools/call") {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32601, message: "Method not found" },
    });
  }
  const params = z.object({
    name: z.literal("slack_chat_post_message"),
    arguments: slackPostMessageArgumentsSchema,
  }).strict().safeParse(request.params);
  if (!params.success) {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32602, message: "Invalid Slack message arguments" },
    });
  }
  const access = await input.accessFor(input.account, false);
  const providerResponse = await input.fetchImpl(input.account.upstreamUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${access.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      ...params.data.arguments,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const providerBody = await readFetchBodyBounded(providerResponse, MAX_SLACK_RESPONSE_BYTES);
  const posted = parseSlackSuccess(providerBody);
  if (!providerResponse.ok || !posted) {
    return jsonRpcResponse(input.response, {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        content: [{ type: "text", text: "Slack could not send this message. Reconnect the account or verify the conversation ID and bot membership." }],
        isError: true,
      },
    });
  }
  return jsonRpcResponse(input.response, {
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ sent: true, channel: posted.channel, ts: posted.ts }),
      }],
      structuredContent: { sent: true, channel: posted.channel, ts: posted.ts },
    },
  });
}

function parseSlackSuccess(body: string): z.infer<typeof slackSuccessSchema> | null {
  try {
    const parsed = slackSuccessSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    // Provider details never cross the gateway boundary.
    return null;
  }
}

function jsonRpcResponse(response: ServerResponse, value: CompanionMcpJsonValue): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readFetchBodyBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new Error("Slack response is too large");
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
}

function safeError(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
  response.end("MCP gateway unavailable");
}
