import {handleDiscussions,DiscussionMissing} from "./discussions";
import {handleDiscussionFiles} from "./discussion-files";
import {privateBetaEmails} from "./private-beta";
import { companionSkillCommands } from "./skill-commands";
import {requireHostedActivation,mutationStartsWork} from "./activation";
import {handleModelGateway,MODEL_GATEWAY_MAX_REQUEST_BYTES} from './model-gateway';
import {handleMaintenance} from "./maintenance";
import {availableModels} from "./models";
import { handleBilling, handleStripeWebhook, requireProductActivation, billingConfiguration, ProductActivationRequired } from "./billing";
import { handleDelivery } from "./delivery";
import { handleLifecycle } from "./lifecycle";
import { retireCompanion } from "./retirement";
import {LifecycleConflict} from './lifecycle-errors';
import { z } from "zod";
import { config } from "./config";
import { db, migrateForService, listCompanions, createCompanion, acceptMessage, cancel, Conflict } from "./store";
import {chatPage,companionHttpDetail,parseChatQuery,ChatPaginationError} from './chat';
import { BoxClient, BoxError } from "../../../packages/box/client";
import { auth, AuthenticationRequired, requireUser, sessionUser } from "./auth";

import { handlePlugins, PluginError } from "./plugins";
import {handleComposioWebhook,handleComposioTriggers,deleteCompanionTriggers} from "./composio-triggers";
import {ComposioUnavailable} from "./composio";
import { handleFiles, FILE_REQUEST_MAX_BYTES, FileRequestError } from "./files";
import { handleTasks } from "./tasks";
import { avatarSchema, configureCompanion } from "./control";
import { handleCompanionEvents } from "./events";
import { serveStaticWeb } from "./static-web";

const idSchema = z.string().uuid();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
async function lifecycleRoute(request:Request,ownerId:string):Promise<Response|null>{
 const path=new URL(request.url).pathname;
 const desktop=path.match(/^\/api\/companions\/([^/]+)\/desktop\/(takeover|release)$/);
 if(desktop&&request.method==='POST')return json(await handleLifecycle({operation:'desktop_'+desktop[2],companionId:idSchema.parse(desktop[1]),source:'human'},ownerId),202);
 const match=path.match(/^\/api\/companions\/([^/]+)\/(prepare|desktop-takeover|desktop-release)$/);
 if(!match||request.method!=='POST')return null;
 return json(await handleLifecycle({operation:match[2].replaceAll('-','_'),companionId:idSchema.parse(match[1]),source:'human'},ownerId),202);
}
export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Native provider protocols authenticate with a scoped run credential and enforce their
  // own streamed body limit. They never inherit a browser cookie session or its routes.
  if(url.pathname==='/api/model-gateway'||url.pathname.startsWith('/api/model-gateway/'))
    return await handleModelGateway(request)??json({error:'Not found.'},404);
  if(url.pathname === "/api/stripe/webhook") return handleStripeWebhook(request);
  if(url.pathname === "/api/composio/webhook") return handleComposioWebhook(request).catch(()=>{console.error("composio_webhook_failed");return json({error:"Webhook failed."},500);});
  if (url.pathname === "/health") return json({ ok: true });
  // Public assets must load through TLS-terminating proxies and domain changes.
  const apiPath = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (!apiPath) return await serveStaticWeb(request, config.webDist) ?? json({ error: "Not found." }, 404);
  // Reject cross-origin browser writes, including login. Vite forwards same origin.
  const origin = request.headers.get("origin");
  if (origin && ![url.origin, process.env.APP_URL ?? "http://127.0.0.1:4310", `http://localhost:${process.env.WEB_PORT ?? 4310}`].includes(origin)) return json({ error: "Origin not allowed." }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > (url.pathname.endsWith("/files") ? FILE_REQUEST_MAX_BYTES : 100_000)) return json({ error: "Request too large." }, 413);
  try {
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
    if (request.method === "GET" && url.pathname === "/api/me") {
      const user = await sessionUser(request);
      return user ? json({ user: { id: user.id, email: user.email, name: user.name } }) : json({ error: "Authentication required." }, 401);
    }
    const ownerId = await requireUser(request);
    if(mutationStartsWork(url.pathname,request.method))await requireHostedActivation(ownerId);
    const discussionFiles=await handleDiscussionFiles(request,ownerId);if(discussionFiles)return discussionFiles;
    const discussionResponse=await handleDiscussions(request,ownerId);if(discussionResponse)return discussionResponse;
    const maintenanceResponse=await handleMaintenance(request,ownerId);
    if(maintenanceResponse)return maintenanceResponse;
    const billingResponse = await handleBilling(request,ownerId);
    if(billingResponse) return billingResponse;
    const deliveryResponse = await handleDelivery(request,ownerId);
    if(deliveryResponse) return deliveryResponse;
    const lifecycleResponse = await lifecycleRoute(request,ownerId);
    if(lifecycleResponse) return lifecycleResponse;
    const fileResponse = await handleFiles(request,ownerId);
    if(fileResponse) return fileResponse;
    const taskResponse = await handleTasks(request,ownerId);
    if(taskResponse) return taskResponse;
    const pluginResponse = await handlePlugins(request,ownerId);
    if(pluginResponse) return pluginResponse;
    const triggerResponse = await handleComposioTriggers(request,ownerId);
    if(triggerResponse) return triggerResponse;
    if (request.method === "GET" && url.pathname === "/api/config") return json({ models:await availableModels(),localAvailable: config.localAvailable, defaultProvider: config.defaultProvider, boxAvailable: !!(config.boxKey && (config.managedBoxTemplate || config.boxTemplate)), model: config.testMode ? "Local test model" : `${config.modelProvider}/${config.modelId}` });
    if (url.pathname === "/api/companions") {
      if (request.method === "GET") return json({ companions: await listCompanions(ownerId) });
      if (request.method === "POST") {
        if(privateBetaEmails() !== null || billingConfiguration().mode === "stripe" || process.env.NODE_ENV === "production") await requireProductActivation(ownerId);
        const input = z.object({ clientCreationId:idSchema.optional(),prepare:z.boolean().default(true),name: z.string().trim().min(1).max(80), instructions: z.string().max(20_000).optional(), provider: z.enum(["local", "box"]).default(config.defaultProvider), avatar: avatarSchema.optional() }).parse(await request.json());
        if (input.provider === "box" && (!config.boxKey || (!config.managedBoxTemplate && !config.boxTemplate))) return json({ error: "Box needs an API key and a prepared template." }, 409);
        if (input.provider === "local" && !config.localAvailable) return json({ error: "Local runtime is disabled." }, 409);
        return json({ companion: await createCompanion(ownerId, input) }, 201);
      }
    }
    const match = url.pathname.match(/^\/api\/companions\/([^/]+)(?:\/(messages|cancel|desktop|events|skills|chat))?$/);
    if (match) {
      const id = idSchema.parse(match[1]);
      if (match[2] === "skills" && request.method === "GET") return await companionSkillCommands(ownerId, id);
      if (match[2] === "chat" && request.method === "GET") { const result=await chatPage(ownerId,id,parseChatQuery(url,id));return result?json(result):json({error:"Companion not found."},404); }
      if (!match[2] && request.method === "DELETE") { const result=await retireCompanion(ownerId,id);
        // Retirement is committed first; webhooks already ignore retired Companions if cleanup fails.
        if(result)await deleteCompanionTriggers(ownerId,id).catch(()=>console.error("composio_trigger_cleanup_failed"));
        return result ? json(result,202) : json({error:"Companion not found."},404); }
      if (!match[2] && request.method === "PATCH") { const companion=await configureCompanion(ownerId,id,await request.json()); return companion ? json({companion}) : json({error:"Companion not found."},404); }
      if (!match[2] && request.method === "GET") { const result = await companionHttpDetail(ownerId,id,parseChatQuery(url,id));
        return result?json(result):json({error:"Companion not found."},404); }
      if (match[2] === "events" && request.method === "GET") return handleCompanionEvents(request, ownerId, id);
      if (match[2] === "messages" && request.method === "POST") {
        const body = z.object({ clientMessageId: idSchema, content: z.string().trim().min(1).max(50_000), attachmentCount: z.number().int().min(0).max(5).default(0) }).parse(await request.json());
        const runId = await acceptMessage(ownerId, id, body.clientMessageId, body.content, body.attachmentCount);
        return runId ? json({ runId }, 202) : json({ error: "Companion not found." }, 404);
      }
      if (match[2] === "cancel" && request.method === "POST") return await cancel(ownerId, id) ? json({ ok: true }) : json({ error: "Companion not found." }, 404);
      if (match[2] === "desktop" && request.method === "POST") {
        const [row] = await db`SELECT box_id,status FROM companions WHERE id=${id} AND owner_id=${ownerId} AND provider='box' AND retired_at IS NULL AND archive_requested_at IS NULL`;
        if (!row) return json({error:"Companion not found."},404);
        if(row.status !== "ready" || !config.boxKey) {await handleLifecycle({operation:"open_desktop",companionId:id},ownerId);return json({preparing:true},202);}
        return json({ url: await new BoxClient(config.boxKey).desktop(row.box_id) });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if(error instanceof DiscussionMissing)return json({error:error.message},404);
    if(error instanceof FileRequestError)return json({error:error.message},error.status);
    if (error instanceof BoxError && error.code === "desktop_preparing") return json({preparing:true},202);
    if (error instanceof AuthenticationRequired) return json({ error: "Authentication required." }, 401);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request." }, 400);
    if (error instanceof PluginError) return json({error:error.message},400);
    if (error instanceof ComposioUnavailable) return json({error:error.message},409);
    if (error instanceof ProductActivationRequired) return json({error:error.message},402);
    if (error instanceof LifecycleConflict) return json({error:error.message},409);
    if (error instanceof ChatPaginationError) return json({error:error.message},400);
    if (error instanceof Conflict) return json({ error: error.message }, 409);
    console.error(error instanceof BoxError ? `api_request_failed:${error.code}:${error.status}` : "api_request_failed");
    return json({ error: "The request could not be completed. Please try again." }, 500);
  }
}
if (import.meta.main) {
  await migrateForService();
  Bun.serve({ hostname: config.host, port: config.port, idleTimeout:255,
    maxRequestBodySize:Math.max(FILE_REQUEST_MAX_BYTES,MODEL_GATEWAY_MAX_REQUEST_BYTES), fetch: handler });
  console.log(`API ready at http://${config.host}:${config.port}`);
}
