import {getAppDefinition,featuredComposioToolkits} from '../../../packages/plugins/definitions';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { db } from './store';
import { encrypt, decrypt } from './config';
import { pluginCatalog, type MachinePlugin } from '../../../packages/plugins/catalog';
import { beginCompanionPluginOAuth, completeCompanionPluginOAuth, refreshCompanionPluginOAuth, CompanionPluginOAuthError, CompanionPluginOAuthRevokedError, type CompanionPluginStoredOAuthCredential } from '../../../packages/plugins/oauth';
import {composio,composioAvailable,composioUserId,ComposioError,type ComposioToolkit} from './composio';
import {deleteAccountTriggers} from './composio-triggers';

const uuid = z.string().uuid();
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const callback = () => new URL('/api/plugins/callback', process.env.APP_URL ?? 'http://127.0.0.1:4310').href;
const composioPrefix='composio:';
const toolkitSlug=z.string().regex(/^[a-z0-9_-]{1,80}$/);
export const composioToolkitOf=(serverId:string|null|undefined)=>serverId?.startsWith(composioPrefix)?toolkitSlug.parse(serverId.slice(composioPrefix.length)):null;
export function pluginConnectionAvailable(serverId:string,env:NodeJS.ProcessEnv=process.env) {
  if(serverId.startsWith(composioPrefix))return composioAvailable(env);
  const client=getAppDefinition(serverId)?.oauth.client;
  return !!client&&[client.clientIdEnv,client.clientSecretEnv].every(key=>!!env[key]?.trim());
}
const composioEntry=(toolkit:ComposioToolkit)=>({id:composioPrefix+toolkit.slug,provider:'composio',kind:'composio' as const,toolkit:toolkit.slug,name:toolkit.name,description:toolkit.description,logo:toolkit.logo,available:toolkit.available});
const catalogCache=new Map<string,{at:number;value:Promise<any>}>();
/** Composio's catalog changes rarely; cache it per process so page loads do not fan out. */
function cached<T>(key:string,load:()=>Promise<T>):Promise<T> {
  const hit=catalogCache.get(key);if(hit&&Date.now()-hit.at<3600_000)return hit.value;
  const value=load();catalogCache.set(key,{at:Date.now(),value});value.catch(()=>catalogCache.delete(key));return value;
}
async function featuredCatalog() {
  if(!composioAvailable())return featuredComposioToolkits.map(slug=>({id:composioPrefix+slug,provider:'composio',kind:'composio' as const,toolkit:slug,name:slug,description:'',logo:'',available:false}));
  return cached('featured',async()=>{
    const entries=await Promise.all(featuredComposioToolkits.map(slug=>composio().getToolkit(slug).then(composioEntry).catch(()=>null)));
    // A partial answer is shown but never cached, so a transient outage does not hide apps for an hour.
    if(entries.includes(null))queueMicrotask(()=>catalogCache.delete('featured'));
    return entries.filter(entry=>!!entry);
  });
}
export async function listPluginCatalog() {
  return [...await featuredCatalog(),...pluginCatalog.map(provider=>({...provider,available:pluginConnectionAvailable(provider.id)}))];
}
export async function searchToolkits(search:string,cursor?:string) {
  if(!composioAvailable())return {items:[],nextCursor:null};
  const query=z.object({search:z.string().trim().max(80),cursor:z.string().max(500).optional()}).parse({search,cursor});
  return cached(`search:${query.search}:${query.cursor??''}`,async()=>{const page=await composio().listToolkits({search:query.search||undefined,cursor:query.cursor});return {items:page.items.map(composioEntry),nextCursor:page.nextCursor};});
}
export async function migratePlugins(sql:any) { await sql.unsafe(await Bun.file(new URL('./plugins.sql',import.meta.url)).text()); }
export class PluginError extends Error {}
const publicColumns = db`id,provider,label,server_id AS "serverId",configuration->>'name' AS "appName",configuration->>'logo' AS "appLogo",health_status AS "healthStatus",health_code AS "healthCode",health_checked_at AS "checkedAt",created_at AS "createdAt"`;
const accountLabel = z.string().trim().min(1).max(80);
export async function listPluginAccounts(ownerId:string) {
  return db`SELECT ${publicColumns}, COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'avatar',c.avatar) ORDER BY c.created_at,c.id)
    FROM companion_plugins cp JOIN companions c ON c.id=cp.companion_id
    WHERE cp.account_id=plugin_accounts.id AND c.owner_id=${ownerId} AND c.retired_at IS NULL
  ),'[]'::jsonb) AS "usedBy" FROM plugin_accounts WHERE owner_id=${ownerId} ORDER BY created_at`;
}
export async function newPluginAccountLabel(ownerId:string,serverId:string,label:string) {
  const [existing]=await db`SELECT id FROM plugin_accounts WHERE owner_id=${ownerId} AND server_id=${serverId} LIMIT 1`;
  if(!existing)return'Default';
  const parsed=accountLabel.safeParse(label);
  if(!parsed.success)throw new PluginError('Name this account before connecting it.');
  return parsed.data;
}
export async function startPluginConnection(ownerId:string, serverId:string, label:string,env:NodeJS.ProcessEnv=process.env) {
  if(serverId.startsWith(composioPrefix))return startComposioConnection(ownerId,serverId,label,env);
  const provider = pluginCatalog.find(p => p.id === serverId);
  if(!provider) throw new PluginError('Choose an available App.');
  if(!pluginConnectionAvailable(serverId,env))throw new PluginError(`${provider.name} connection is unavailable in this deployment.`);
  const accountName=await newPluginAccountLabel(ownerId,serverId,label);
  const state=randomBytes(32).toString('base64url');
  const {authorizationUrl,flow}=await beginCompanionPluginOAuth({serverName:serverId,state,redirectUri:callback(),env});
  await db`INSERT INTO plugin_oauth_flows (state_hash,owner_id,label,flow_secret,expires_at) VALUES (${hash(state)},${ownerId},${accountName},${encrypt(JSON.stringify(flow))},now()+interval '10 minutes')`;
  return {url:authorizationUrl};
}
async function startComposioConnection(ownerId:string,serverId:string,label:string,env:NodeJS.ProcessEnv) {
  const slug=toolkitSlug.safeParse(serverId.slice(composioPrefix.length));
  if(!slug.success)throw new PluginError('Choose an available App.');
  if(!composioAvailable(env))throw new PluginError('Apps are unavailable in this deployment.');
  const toolkit=await composio().getToolkit(slug.data).catch(error=>{if(error instanceof ComposioError&&error.status===404)throw new PluginError('Choose an available App.');throw error;});
  if(!toolkit.available)throw new PluginError(`${toolkit.name} needs an administrator-configured Composio auth config.`);
  const accountName=await newPluginAccountLabel(ownerId,serverId,label);
  const state=randomBytes(32).toString('base64url'),stateHash=hash(state);
  const authConfigId=await composio().authConfigFor(toolkit.slug);
  const callbackUrl=new URL(callback());callbackUrl.searchParams.set('state',state);
  // Persist the state before Composio creates a pending account, so every link we issue is attributable.
  await db`INSERT INTO plugin_oauth_flows (state_hash,owner_id,label,flow_secret,expires_at) VALUES (${stateHash},${ownerId},${accountName},${encrypt(JSON.stringify({kind:'composio',toolkit:toolkit.slug,name:toolkit.name,logo:toolkit.logo,authConfigId}))},now()+interval '10 minutes')`;
  const link=await composio().link(composioUserId(ownerId),authConfigId,callbackUrl.href);
  await db`UPDATE plugin_oauth_flows SET flow_secret=${encrypt(JSON.stringify({kind:'composio',toolkit:toolkit.slug,name:toolkit.name,logo:toolkit.logo,authConfigId,connectedAccountId:link.connectedAccountId}))} WHERE state_hash=${stateHash} AND consumed_at IS NULL`;
  return {url:link.redirectUrl};
}
async function consumePluginFlow(ownerId:string,state:string) {
  const [row]=await db`UPDATE plugin_oauth_flows SET consumed_at=now() WHERE state_hash=${hash(state)} AND owner_id=${ownerId} AND consumed_at IS NULL AND expires_at>now() RETURNING *`;
  if(!row) throw new PluginError('This connection link expired. Connect again.');
  return row;
}
const composioFlow=z.object({kind:z.literal('composio'),toolkit:toolkitSlug,name:z.string(),logo:z.string(),authConfigId:z.string(),connectedAccountId:z.string()});
export async function completeComposioConnection(ownerId:string,state:string) {
  const row=await consumePluginFlow(ownerId,state);
  const flow=composioFlow.parse(JSON.parse(decrypt(row.flow_secret)));
  const account=await composio().getAccount(flow.connectedAccountId);
  // The redirect is unauthenticated input; only Composio's own record proves which account was granted.
  if(account.userId!==composioUserId(ownerId)||account.toolkit!==flow.toolkit||account.authConfigId!==flow.authConfigId)throw new PluginError('This connection does not belong to this account.');
  if(account.status!=='ACTIVE')throw new PluginError('The connection was not completed.');
  const id=crypto.randomUUID();
  await db`INSERT INTO plugin_accounts (id,owner_id,provider,label,server_id,credential_secret,configuration,health_status,health_checked_at)
    VALUES (${id},${ownerId},'composio',${row.label},${composioPrefix+flow.toolkit},${encrypt(JSON.stringify({kind:'composio',toolkit:flow.toolkit,connectedAccountId:account.id,authConfigId:account.authConfigId}))},${{name:flow.name,logo:flow.logo,connectedAccountId:account.id}}::jsonb,'ok',now())`;
  return {id};
}
async function flowKind(ownerId:string,state:string) {
  const [row]=await db`SELECT flow_secret FROM plugin_oauth_flows WHERE state_hash=${hash(state)} AND owner_id=${ownerId}`;
  if(!row||row.flow_secret==='unused')return null;
  try{return JSON.parse(decrypt(row.flow_secret)).kind==='composio'?'composio':'oauth';}catch{return null;}
}
export async function completePluginConnection(ownerId:string,state:string,code:string) {
  const row=await consumePluginFlow(ownerId,state);
  const flow=JSON.parse(decrypt(row.flow_secret));
  const credential=await completeCompanionPluginOAuth({flow,code,redirectUri:callback()});
  const id=crypto.randomUUID();
  await db`INSERT INTO plugin_accounts (id,owner_id,provider,label,server_id,credential_secret) VALUES (${id},${ownerId},${flow.provider},${row.label},${flow.serverName},${encrypt(JSON.stringify(credential))})`;
  return {id};
}
export async function cancelPluginConnection(ownerId:string,state:string) {await consumePluginFlow(ownerId,state);}
const customSchema=z.object({label:z.string().trim().min(1).max(80),transport:z.enum(['http','stdio']).default('http'),url:z.string().url().optional(),command:z.string().min(1).max(500).optional(),args:z.array(z.string().max(2000)).max(50).default([]),headers:z.record(z.string(),z.string().max(8000)).default({}),env:z.record(z.string(),z.string().max(8000)).default({})});
const storedOAuthSchema=z.object({
  kind:z.literal('oauth'),version:z.literal(1),serverName:z.string(),accessToken:z.string().min(1).refine(value=>!/[\r\n\0]/.test(value)),
  refreshToken:z.string().nullable(),accessExpiresAt:z.string().datetime().nullable(),scope:z.string().nullable(),tokenType:z.literal('Bearer'),
  tokenEndpoint:z.string().url(),resource:z.string(),client:z.object({clientId:z.string().min(1),clientSecret:z.string().nullable(),tokenEndpointAuthMethod:z.enum(['none','client_secret_post','client_secret_basic'])}),
}).passthrough();
export async function addCustomPlugin(ownerId:string,input:unknown) {
  const value=customSchema.parse(input);
  if(value.transport==='http') {
    if(!value.url) throw new PluginError('An MCP URL is required.');
    const url=new URL(value.url);
    if(url.protocol!=='https:' || url.username || url.password) throw new PluginError('Use an HTTPS MCP URL without embedded credentials.');
  } else if(!value.command) throw new PluginError('An MCP command is required.');
  const id=crypto.randomUUID();
  // MCP processes and custom URLs are used only inside the member's agent computer.
  await db`INSERT INTO plugin_accounts (id,owner_id,provider,label,credential_secret) VALUES (${id},${ownerId},'custom',${value.label},${encrypt(JSON.stringify({kind:'custom',...value}))})`;
  return {id};
}
export async function attachPlugin(ownerId:string,companionId:string,accountId:string,enabled:boolean) {
  uuid.parse(companionId);uuid.parse(accountId);
  return db.begin(async(tx:any)=>{
    const [owned]=await tx`SELECT c.id FROM companions c JOIN plugin_accounts p ON p.owner_id=c.owner_id WHERE c.id=${companionId} AND p.id=${accountId} AND c.owner_id=${ownerId}`;
    if(!owned) throw new PluginError('Companion or connection not found.');
    if(enabled) await tx`INSERT INTO companion_plugins VALUES (${companionId},${accountId}) ON CONFLICT DO NOTHING`;
    else await tx`DELETE FROM companion_plugins WHERE companion_id=${companionId} AND account_id=${accountId}`;
  });
}
export async function disconnectPlugin(ownerId:string,id:string) {
  uuid.parse(id);
  const [row]=await db`SELECT provider,credential_secret FROM plugin_accounts WHERE id=${id} AND owner_id=${ownerId}`;
  if(row?.provider==='composio'){
    // Remote subscriptions and the grant go first; a failure keeps the row so disconnect can be retried.
    const credential=composioCredential.parse(JSON.parse(decrypt(row.credential_secret)));
    try{await deleteAccountTriggers(ownerId,id);await composio().deleteAccount(credential.connectedAccountId);}
    catch(error){if(error instanceof PluginError)throw error;throw new PluginError('The connection could not be removed. Try again.');}
  }
  await db`DELETE FROM plugin_accounts WHERE id=${id} AND owner_id=${ownerId}`;
}
export async function renamePluginAccount(ownerId:string,id:string,label:string) {
  uuid.parse(id);
  const parsed=accountLabel.safeParse(label);
  if(!parsed.success)throw new PluginError('Account names must be between 1 and 80 characters.');
  const [account]=await db`UPDATE plugin_accounts SET label=${parsed.data} WHERE id=${id} AND owner_id=${ownerId} RETURNING ${publicColumns}`;
  return account??null;
}
export async function selectedPlugins(ownerId:string,companionId:string) {
  return db`SELECT p.id,p.provider,p.label FROM companion_plugins cp JOIN plugin_accounts p ON p.id=cp.account_id JOIN companions c ON c.id=cp.companion_id WHERE c.id=${companionId} AND c.owner_id=${ownerId} AND p.owner_id=${ownerId}`;
}

export type PluginHealthCode='authorization_required'|'connection_failed'|'configuration_invalid'|'agent_check_required';
export type PluginHealthResult={id:string;healthStatus:'ok'|'error'|'requires_agent';healthCode:PluginHealthCode|null;checkedAt:Date};
export interface PluginHealthDependencies {
  check?:(plugin:MachinePlugin,signal:AbortSignal)=>Promise<void>;
  refresh?:(input:{credential:CompanionPluginStoredOAuthCredential;signal?:AbortSignal})=>Promise<CompanionPluginStoredOAuthCredential>;
  now?:()=>Date;
}

async function discoverPlugin(plugin:MachinePlugin,signal:AbortSignal) {
  if(plugin.transport!=='http'||!plugin.url)throw Error('PLUGIN_CONFIGURATION_INVALID');
  const client=new Client({name:'companions.build-health',version:'0.2.0'});
  const transport=new StreamableHTTPClientTransport(new URL(plugin.url),{requestInit:{headers:plugin.headers}});
  try {
    await client.connect(transport,{timeout:10_000,signal});
    await client.listTools(undefined,{timeout:10_000,signal});
  } finally {await client.close().catch(()=>undefined);}
}

function healthProjection(row:any):PluginHealthResult {
  return{id:row.id,healthStatus:row.health_status,healthCode:row.health_code,checkedAt:new Date(row.health_checked_at)};
}

/** Owner-triggered, read-only connection discovery. Custom MCP definitions stay agent-computer-only. */
export async function checkPluginAccount(ownerId:string,accountId:string,deps:PluginHealthDependencies={}):Promise<PluginHealthResult|null> {
  uuid.parse(accountId);
  const now=deps.now?.()??new Date();
  let plugin:MachinePlugin|null=null;
  let early:PluginHealthResult['healthStatus']|null=null;
  let earlyCode:PluginHealthCode|null=null;
  try {
    const prepared=await db.begin(async tx=>{
      const [row]=await tx`SELECT * FROM plugin_accounts WHERE id=${accountId} AND owner_id=${ownerId} FOR UPDATE`;
      if(!row)return null;
      const rawCredential=JSON.parse(decrypt(row.credential_secret));
      if(rawCredential.kind==='custom'){customSchema.parse(rawCredential);return{custom:true as const};}
      if(rawCredential.kind==='composio')return{custom:false as const,composio:composioCredential.parse(rawCredential)};
      let credential=storedOAuthSchema.parse(rawCredential) as CompanionPluginStoredOAuthCredential;
      if(credential.serverName!==row.server_id)throw Error('PLUGIN_CONFIGURATION_INVALID');
      if(credential.accessExpiresAt&&Date.parse(credential.accessExpiresAt)<Date.now()+60_000){
        credential=await (deps.refresh??refreshCompanionPluginOAuth)({credential,signal:AbortSignal.timeout(10_000)});
        await tx`UPDATE plugin_accounts SET credential_secret=${encrypt(JSON.stringify(credential))} WHERE id=${accountId} AND owner_id=${ownerId}`;
      }
      const provider=pluginCatalog.find(item=>item.id===row.server_id);
      if(!provider)throw Error('PLUGIN_CONFIGURATION_INVALID');
      return{custom:false as const,composio:null,plugin:projectAccount(row,credential) satisfies MachinePlugin};
    });
    if(!prepared)return null;
    if(prepared.composio){
      try{const account=await composio().getAccount(prepared.composio.connectedAccountId);if(account.status!=='ACTIVE'){early='error';earlyCode='authorization_required';}}
      catch(error){early='error';earlyCode=error instanceof ComposioError&&error.status===404?'authorization_required':'connection_failed';}
    }
    else if(prepared.custom){early='requires_agent';earlyCode='agent_check_required';}
    else if('plugin' in prepared)plugin=prepared.plugin;
  } catch(error) {
    early='error';
    earlyCode=error instanceof CompanionPluginOAuthRevokedError||error instanceof CompanionPluginOAuthError&&error.code==='oauth_refresh_failed'?'authorization_required':'configuration_invalid';
  }
  if(plugin&&!early){
    try{await (deps.check??discoverPlugin)(plugin,AbortSignal.timeout(10_000));}
    catch{early='error';earlyCode='connection_failed';}
  }
  const healthStatus=early??'ok',healthCode=earlyCode;
  const [saved]=await db`UPDATE plugin_accounts SET health_status=${healthStatus},health_code=${healthCode},health_checked_at=${now} WHERE id=${accountId} AND owner_id=${ownerId} RETURNING id,health_status,health_code,health_checked_at`;
  return saved?healthProjection(saved):null;
}
function projectAccount(row:any,credential:CompanionPluginStoredOAuthCredential):MachinePlugin {
  const definition=getAppDefinition(row.server_id);
  if(!definition)throw new PluginError('Connection requires an update.');
  return {id:row.id,name:row.label,provider:definition.provider,serverId:definition.id,transport:definition.mcp.transport,url:definition.mcp.url,
    headers:{Authorization:`Bearer ${credential.accessToken}`},
    ...(credential.accessExpiresAt?{credentialExpiresAt:Date.parse(credential.accessExpiresAt)}:{}),
    capabilities:{gitCredentials:definition.capabilities.gitCredentials}};
}
export const composioCredential=z.object({kind:z.literal('composio'),toolkit:toolkitSlug,connectedAccountId:z.string().min(1),authConfigId:z.string().min(1)});
/** Server-only view of a Composio connection selected by this Companion. */
export async function selectedComposioAccount(ownerId:string,companionId:string,accountId:string) {
  uuid.parse(accountId);
  const [row]=await db`SELECT p.id,p.credential_secret FROM companion_plugins cp JOIN plugin_accounts p ON p.id=cp.account_id JOIN companions c ON c.id=cp.companion_id
    WHERE c.id=${companionId} AND c.owner_id=${ownerId} AND p.owner_id=${ownerId} AND p.id=${accountId} AND p.provider='composio' AND c.retired_at IS NULL`;
  return row?{id:row.id as string,...composioCredential.parse(JSON.parse(decrypt(row.credential_secret)))}:null;
}
export async function ownedComposioAccount(ownerId:string,accountId:string) {
  uuid.parse(accountId);
  const [row]=await db`SELECT id,label,configuration,credential_secret FROM plugin_accounts WHERE id=${accountId} AND owner_id=${ownerId} AND provider='composio'`;
  return row?{id:row.id as string,label:row.label as string,appName:(row.configuration?.name??null) as string|null,appLogo:(row.configuration?.logo??null) as string|null,...composioCredential.parse(JSON.parse(decrypt(row.credential_secret)))}:null;
}
/** Executor-only projection. Commit each refresh before another provider can fail. */
export async function machinePlugins(companionId:string,deps:Pick<PluginHealthDependencies,'refresh'>&{refreshCredentials?:boolean;accountId?:string}={}):Promise<MachinePlugin[]> {
  const accounts=await db`SELECT p.id FROM companion_plugins cp JOIN plugin_accounts p ON p.id=cp.account_id JOIN companions c ON c.id=cp.companion_id WHERE c.id=${companionId} AND c.owner_id=p.owner_id ORDER BY p.id`;
  const result:MachinePlugin[]=[];
  for(const account of accounts) {
    const plugin=await db.begin(async tx => {
      // Recheck ownership and selection while locking this account; health checks and other
      // companions must see the committed rotated token before trying another refresh.
      const [row]=await tx`SELECT p.* FROM companion_plugins cp JOIN plugin_accounts p ON p.id=cp.account_id JOIN companions c ON c.id=cp.companion_id WHERE c.id=${companionId} AND p.id=${account.id} AND c.owner_id=p.owner_id FOR UPDATE OF p`;
      if(!row)return null;
      let credential=JSON.parse(decrypt(row.credential_secret));
      if(credential.kind==='custom')return {id:row.id,name:row.label,provider:'custom',...credential} as MachinePlugin;
      if(credential.kind==='composio')return {id:row.id,name:row.label,provider:'composio',serverId:row.server_id,transport:'composio',toolkit:composioCredential.parse(credential).toolkit} satisfies MachinePlugin;
      const provider=pluginCatalog.find(p=>p.id===row.server_id);
      if(!provider) throw new PluginError('Connection requires an update.');
      const shouldRefresh=deps.accountId?row.id===deps.accountId:deps.refreshCredentials!==false||!!getAppDefinition(row.server_id)?.capabilities?.gitCredentials;
      if(shouldRefresh && credential.accessExpiresAt && Date.parse(credential.accessExpiresAt)<Date.now()+60_000) {
        credential=await (deps.refresh??refreshCompanionPluginOAuth)({credential:credential as CompanionPluginStoredOAuthCredential,signal:AbortSignal.timeout(10_000)});
        await tx`UPDATE plugin_accounts SET credential_secret=${encrypt(JSON.stringify(credential))} WHERE id=${row.id}`;
      }
      return projectAccount(row,credential) satisfies MachinePlugin;
    });
    if(plugin)result.push(plugin);
  }
  return result;
}
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
type PluginCallbackStatus='connected'|'cancelled'|'error';
export function pluginCallbackLocation(status:PluginCallbackStatus) {
  const target=new URL('/connections',process.env.APP_URL??'http://127.0.0.1:4310');target.searchParams.set('connection',status);return target.href;
}
export async function handlePlugins(request:Request,ownerId:string):Promise<Response|null> {
  const url=new URL(request.url);const path=url.pathname;
  if(path==='/api/plugins' && request.method==='GET') return response({catalog:await listPluginCatalog(),accounts:await listPluginAccounts(ownerId)});
  if(path==='/api/plugins/toolkits' && request.method==='GET') return response(await searchToolkits(url.searchParams.get('search')??'',url.searchParams.get('cursor')??undefined));
  if(path==='/api/plugins/connect' && request.method==='POST') {const v=z.object({serverId:z.string(),label:z.string().max(80).default('')}).parse(await request.json());return response(await startPluginConnection(ownerId,v.serverId,v.label));}
  if(path==='/api/plugins/custom' && request.method==='POST') return response(await addCustomPlugin(ownerId,await request.json()),201);
  const check=path.match(/^\/api\/plugins\/accounts\/([a-f0-9-]+)\/check$/);
  if(check&&request.method==='POST') {const result=await checkPluginAccount(ownerId,check[1]);return result?response({account:result}):response({error:'Connection not found.'},404);}
  if(path==='/api/plugins/callback' && request.method==='GET') {
    let status:PluginCallbackStatus='error';
    try{
      const state=z.string().min(20).max(200).parse(url.searchParams.get('state'));
      const providerError=z.string().max(200).nullable().parse(url.searchParams.get('error'));
      if(providerError){await cancelPluginConnection(ownerId,state);status=providerError==='access_denied'?'cancelled':'error';}
      else if(await flowKind(ownerId,state)==='composio'){
        if(url.searchParams.get('status')==='failed'){await cancelPluginConnection(ownerId,state);status='cancelled';}
        else{await completeComposioConnection(ownerId,state);status='connected';}
      }
      else{await completePluginConnection(ownerId,state,z.string().min(1).max(4000).parse(url.searchParams.get('code')));status='connected';}
    }catch{/* Return a stable browser result; provider details and credentials never enter the URL. */}
    return new Response(null,{status:303,headers:{location:pluginCallbackLocation(status),'cache-control':'no-store'}});
  }
  const account=path.match(/^\/api\/plugins\/([a-f0-9-]+)$/);
  if(account&&request.method==='PATCH') {const {label}=z.object({label:z.string()}).parse(await request.json());const renamed=await renamePluginAccount(ownerId,account[1],label);return renamed?response({account:renamed}):response({error:'Connection not found.'},404);}
  if(account&&request.method==='DELETE') {await disconnectPlugin(ownerId,account[1]);return response({ok:true});}
  const match=path.match(/^\/api\/companions\/([a-f0-9-]+)\/plugins(?:\/([a-f0-9-]+))?$/);
  if(match) {
    if(!match[2]&&request.method==='GET') return response({accounts:await selectedPlugins(ownerId,uuid.parse(match[1]))});
    if(match[2]&&['PUT','DELETE'].includes(request.method)) {await attachPlugin(ownerId,match[1],match[2],request.method==='PUT');return response({ok:true});}
  }
  return null;
}
