import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

/** Composio REST v3.1. The project key stays on API/executor services; agents never receive it. */
export type ComposioToolkit={slug:string;name:string;description:string;logo:string;available:boolean};
export type ComposioAccount={id:string;status:string;userId:string;toolkit:string;authConfigId:string};
export type ComposioTool={slug:string;name:string;description:string;inputSchema:Record<string,unknown>;toolkit:string;version:string};
export type ComposioTriggerType={slug:string;name:string;description:string;instructions:string;type:'webhook'|'poll';config:Record<string,unknown>;toolkit:string};
export type ComposioTriggerInstance={id:string;connectedAccountId:string;triggerName:string;triggerConfig:Record<string,unknown>;disabledAt:string|null};
export type ComposioExecution={successful:boolean;data:unknown;error:string|null};
export interface ComposioGateway {
 listToolkits(query:{search?:string;cursor?:string;limit?:number}):Promise<{items:ComposioToolkit[];nextCursor:string|null}>;
 getToolkit(slug:string):Promise<ComposioToolkit>;
 authConfigFor(toolkit:string):Promise<string>;
 link(userId:string,authConfigId:string,callbackUrl:string):Promise<{connectedAccountId:string;redirectUrl:string}>;
 getAccount(id:string):Promise<ComposioAccount>;
 deleteAccount(id:string):Promise<void>;
 listTools(toolkit:string,search?:string):Promise<ComposioTool[]>;
 getTool(slug:string):Promise<ComposioTool>;
 execute(slug:string,input:{userId:string;connectedAccountId:string;version:string;arguments:Record<string,unknown>},signal?:AbortSignal):Promise<ComposioExecution>;
 listTriggerTypes(toolkit:string):Promise<ComposioTriggerType[]>;
 getTriggerType(slug:string):Promise<ComposioTriggerType>;
 createTrigger(userId:string,slug:string,input:{connectedAccountId:string;triggerConfig:Record<string,unknown>}):Promise<{triggerId:string}>;
 listActiveTriggers(query:{connectedAccountIds:string[];triggerNames?:string[]}):Promise<ComposioTriggerInstance[]>;
 setTriggerEnabled(triggerId:string,enabled:boolean):Promise<void>;
 deleteTrigger(triggerId:string):Promise<void>;
}
/** Status only: provider response bodies may contain account data and never reach logs or users. */
export class ComposioError extends Error {constructor(readonly status:number,readonly operation:string){super(`COMPOSIO_${operation.toUpperCase()}_FAILED:${status}`);}}
export class ComposioUnavailable extends Error {constructor(){super('Composio is not configured in this deployment.');}}

export const composioUserId=(ownerId:string)=>`companions:${ownerId}`;
export function composioAvailable(env:NodeJS.ProcessEnv=process.env){return !!env.COMPOSIO_API_KEY?.trim();}
function configuredAuthConfigs(env:NodeJS.ProcessEnv):Record<string,string>{
 if(!env.COMPOSIO_AUTH_CONFIGS?.trim())return {};
 return z.record(z.string(),z.string().min(1)).parse(JSON.parse(env.COMPOSIO_AUTH_CONFIGS));
}

const toolkitRow=z.object({slug:z.string(),name:z.string(),no_auth:z.boolean().optional(),composio_managed_auth_schemes:z.array(z.string()).optional(),meta:z.object({description:z.string().optional(),logo:z.string().optional()}).passthrough().optional()}).passthrough();
const toolRow=z.object({slug:z.string(),name:z.string(),description:z.string().default(''),input_parameters:z.record(z.string(),z.unknown()).default({}),toolkit:z.object({slug:z.string()}).passthrough(),version:z.string()}).passthrough();
const triggerTypeRow=z.object({slug:z.string(),name:z.string(),description:z.string().default(''),instructions:z.string().default(''),type:z.enum(['webhook','poll']).catch('webhook'),config:z.record(z.string(),z.unknown()).default({}),toolkit:z.object({slug:z.string()}).passthrough()}).passthrough();
const accountRow=z.object({id:z.string(),status:z.string(),user_id:z.string(),toolkit:z.object({slug:z.string()}).passthrough(),auth_config:z.object({id:z.string()}).passthrough()}).passthrough();
const triggerInstanceRow=z.object({id:z.string(),connected_account_id:z.string(),trigger_name:z.string(),trigger_config:z.record(z.string(),z.unknown()).nullish(),disabled_at:z.string().nullish()}).passthrough();

export function createComposioGateway(env:NodeJS.ProcessEnv=process.env,fetchImpl:typeof fetch=fetch):ComposioGateway {
 const key=env.COMPOSIO_API_KEY?.trim();
 const base=(env.COMPOSIO_BASE_URL??'https://backend.composio.dev').replace(/\/$/,'');
 const authConfigs=new Map(Object.entries(configuredAuthConfigs(env)));
 async function request(operation:string,method:string,path:string,{query,body,signal}:{query?:Record<string,string|number|boolean|string[]|undefined>;body?:unknown;signal?:AbortSignal}={}){
  if(!key)throw new ComposioUnavailable();
  const url=new URL(base+path);
  // The API expects comma-separated arrays in query strings.
  for(const [name,value] of Object.entries(query??{}))if(value!==undefined)url.searchParams.set(name,Array.isArray(value)?value.join(','):String(value));
  const response=await fetchImpl(url,{method,headers:{'x-api-key':key,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),
   signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(60_000)])});
  if(!response.ok){await response.body?.cancel();throw new ComposioError(response.status,operation);}
  return response.status===204?{}:await response.json() as any;
 }
 const toolkit=(row:z.infer<typeof toolkitRow>):ComposioToolkit=>({slug:row.slug,name:row.name,description:row.meta?.description??'',logo:row.meta?.logo??'',
  available:!row.no_auth&&((row.composio_managed_auth_schemes?.length??0)>0||authConfigs.has(row.slug))});
 const tool=(row:z.infer<typeof toolRow>):ComposioTool=>({slug:row.slug,name:row.name,description:row.description,inputSchema:row.input_parameters,toolkit:row.toolkit.slug,version:row.version});
 const triggerType=(row:z.infer<typeof triggerTypeRow>):ComposioTriggerType=>({slug:row.slug,name:row.name,description:row.description,instructions:row.instructions,type:row.type,config:row.config,toolkit:row.toolkit.slug});
 return {
  async listToolkits({search,cursor,limit=24}){
   const page=await request('toolkits','GET','/api/v3.1/toolkits',{query:{search,cursor,limit,sort_by:'usage'}});
   return {items:z.array(toolkitRow).parse(page.items).map(toolkit),nextCursor:page.next_cursor??null};
  },
  async getToolkit(slug){return toolkit(toolkitRow.parse(await request('toolkit','GET',`/api/v3.1/toolkits/${encodeURIComponent(slug)}`)));},
  async authConfigFor(slug){
   const known=authConfigs.get(slug);if(known)return known;
   const existing=await request('auth_configs','GET','/api/v3.1/auth_configs',{query:{toolkit_slug:slug,is_composio_managed:true,limit:1}});
   let id=z.array(z.object({id:z.string()}).passthrough()).parse(existing.items)[0]?.id;
   if(!id){
    const created=await request('auth_config_create','POST','/api/v3.1/auth_configs',{body:{toolkit:{slug},auth_config:{type:'use_composio_managed_auth'}}});
    id=z.string().parse(created.auth_config?.id);
   }
   authConfigs.set(slug,id);return id;
  },
  async link(userId,authConfigId,callbackUrl){
   const result=await request('link','POST','/api/v3.1/connected_accounts/link',{body:{auth_config_id:authConfigId,user_id:userId,callback_url:callbackUrl}});
   return {connectedAccountId:z.string().parse(result.connected_account_id),redirectUrl:z.string().url().parse(result.redirect_url)};
  },
  async getAccount(id){
   const row=accountRow.parse(await request('account','GET',`/api/v3.1/connected_accounts/${encodeURIComponent(id)}`));
   return {id:row.id,status:row.status,userId:row.user_id,toolkit:row.toolkit.slug,authConfigId:row.auth_config.id};
  },
  async deleteAccount(id){
   try{await request('account_delete','DELETE',`/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);}
   catch(error){if(!(error instanceof ComposioError&&error.status===404))throw error;}
  },
  async listTools(slug,search){
   const tools:ComposioTool[]=[];let cursor:string|undefined;
   // Without a search, only the toolkit's important tools fit an agent context.
   for(let page=0;page<5;page++){
    const result=await request('tools','GET','/api/v3.1/tools',{query:{toolkit_slug:slug,...(search?{query:search}:{important:'true'}),limit:100,cursor}});
    tools.push(...z.array(toolRow).parse(result.items).map(tool));
    if(!result.next_cursor)break;cursor=result.next_cursor;
   }
   return tools;
  },
  async getTool(slug){return tool(toolRow.parse(await request('tool','GET',`/api/v3.1/tools/${encodeURIComponent(slug)}`)));},
  async execute(slug,input,signal){
   const result=await request('execute','POST',`/api/v3.1/tools/execute/${encodeURIComponent(slug)}`,{signal,body:{user_id:input.userId,connected_account_id:input.connectedAccountId,version:input.version,arguments:input.arguments}});
   return {successful:result.successful===true,data:result.data??null,error:typeof result.error==='string'?result.error:null};
  },
  async listTriggerTypes(slug){
   const result=await request('trigger_types','GET','/api/v3.1/triggers_types',{query:{toolkit_slugs:[slug],limit:100}});
   return z.array(triggerTypeRow).parse(result.items).map(triggerType);
  },
  async getTriggerType(slug){return triggerType(triggerTypeRow.parse(await request('trigger_type','GET',`/api/v3.1/triggers_types/${encodeURIComponent(slug)}`)));},
  async createTrigger(userId,slug,input){
   const result=await request('trigger_create','POST',`/api/v3.1/trigger_instances/${encodeURIComponent(slug)}/upsert`,{body:{user_id:userId,connected_account_id:input.connectedAccountId,trigger_config:input.triggerConfig}});
   return {triggerId:z.string().min(1).parse(result.trigger_id)};
  },
  async listActiveTriggers({connectedAccountIds,triggerNames}){
   const result=await request('triggers','GET','/api/v3.1/trigger_instances/active',{query:{connected_account_ids:connectedAccountIds,trigger_names:triggerNames,show_disabled:true,limit:100}});
   return z.array(triggerInstanceRow).parse(result.items).map(row=>({id:row.id,connectedAccountId:row.connected_account_id,triggerName:row.trigger_name,triggerConfig:row.trigger_config??{},disabledAt:row.disabled_at??null}));
  },
  async setTriggerEnabled(id,enabled){await request('trigger_update','PATCH',`/api/v3.1/trigger_instances/manage/${encodeURIComponent(id)}`,{body:{status:enabled?'enable':'disable'}});},
  async deleteTrigger(id){
   try{await request('trigger_delete','DELETE',`/api/v3.1/trigger_instances/manage/${encodeURIComponent(id)}`);}
   catch(error){if(!(error instanceof ComposioError&&error.status===404))throw error;}
  },
 };
}

let gateway:ComposioGateway|undefined;
export function composio(){return gateway??=createComposioGateway();}
/** Tests replace the network client; production uses the environment. */
export function setComposioGateway(value:ComposioGateway|undefined){gateway=value;}

export class WebhookVerificationError extends Error {}
/** Standard Webhooks: HMAC-SHA256 over `id.timestamp.body`, `v1,<base64>` signatures, bounded clock skew. */
export function verifyComposioWebhook(input:{id:string|null;timestamp:string|null;signature:string|null;body:string;secret:string|undefined;now?:number;toleranceSeconds?:number}){
 const {id,timestamp,signature,body,secret}=input;
 if(!secret)throw new WebhookVerificationError('COMPOSIO_WEBHOOK_SECRET_MISSING');
 if(!id||!timestamp||!signature||!body||id.length>200||signature.length>2000)throw new WebhookVerificationError('WEBHOOK_HEADERS_MISSING');
 if(!/^\d{1,12}$/.test(timestamp))throw new WebhookVerificationError('WEBHOOK_TIMESTAMP_INVALID');
 if(Math.abs((input.now??Date.now())-Number(timestamp)*1000)>(input.toleranceSeconds??300)*1000)throw new WebhookVerificationError('WEBHOOK_TIMESTAMP_EXPIRED');
 const expected=createHmac('sha256',secret).update(`${id}.${timestamp}.${body}`).digest();
 const valid=signature.split(' ').some(part=>{
  const [version,value]=part.split(',');if(version!=='v1'||!value)return false;
  const provided=Buffer.from(value,'base64');return provided.length===expected.length&&timingSafeEqual(provided,expected);
 });
 if(!valid)throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID');
}
