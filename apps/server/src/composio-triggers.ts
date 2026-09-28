import {createHash} from 'node:crypto';
import {z} from 'zod';
import {db} from './store';
import {encrypt,decrypt} from './config';
import {composio,composioUserId,verifyComposioWebhook,WebhookVerificationError,ComposioError} from './composio';
import {enqueueBackgroundInTransaction} from './task-runtime';
import {PluginError,ownedComposioAccount} from './plugins';

const uuid=z.string().uuid();
const MAX_WEBHOOK_BYTES=1024*1024;
const triggerColumns=db`t.id,t.account_id AS "accountId",p.label AS "accountLabel",p.configuration->>'name' AS "appName",p.configuration->>'logo' AS "appLogo",
 t.trigger_slug AS "triggerSlug",t.trigger_name AS "triggerName",t.trigger_config AS config,t.instructions,t.status,t.created_at AS "createdAt"`;
const createInput=z.object({accountId:uuid,triggerSlug:z.string().regex(/^[A-Z0-9_]{1,120}$/),config:z.record(z.string(),z.unknown()).default({}),instructions:z.string().trim().min(1).max(20_000)})
 .refine(value=>JSON.stringify(value.config).length<=10_000,{message:'Trigger configuration is too large.'});
const updateInput=z.object({enabled:z.boolean().optional(),instructions:z.string().trim().min(1).max(20_000).optional()});

async function ownedCompanion(ownerId:string,companionId:string){
 const [row]=await db`SELECT id FROM companions WHERE id=${uuid.parse(companionId)} AND owner_id=${ownerId} AND retired_at IS NULL`;
 return !!row;
}
export async function listTriggers(ownerId:string,companionId:string){
 return db`SELECT ${triggerColumns} FROM composio_triggers t JOIN plugin_accounts p ON p.id=t.account_id
  WHERE t.companion_id=${uuid.parse(companionId)} AND t.owner_id=${ownerId} ORDER BY t.created_at,t.id`;
}
async function trigger(ownerId:string,id:string){
 const [row]=await db`SELECT ${triggerColumns} FROM composio_triggers t JOIN plugin_accounts p ON p.id=t.account_id WHERE t.id=${id} AND t.owner_id=${ownerId}`;
 return row??null;
}
export async function listTriggerTypes(ownerId:string,accountId:string){
 const account=await ownedComposioAccount(ownerId,accountId);
 if(!account)return null;
 return (await composio().listTriggerTypes(account.toolkit)).map(({toolkit:_,...type})=>type);
}
const sameConfig=(a:Record<string,unknown>,b:Record<string,unknown>)=>JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());

const LEASE_MS=5*60_000,LEASE_WAIT_MS=20_000;
/**
 * Identical subscriptions share one Composio instance, so every decision about it is serialized per
 * (account, trigger type). A persisted lease, not an open transaction, spans the Composio calls: no
 * pooled connection is held during network I/O, and a crashed holder's lease expires on its own.
 */
async function withSubscription<T>(accountId:string,slug:string,body:(sql:any)=>Promise<T>){
 const key=`${accountId}:${slug}`,holder=crypto.randomUUID(),deadline=Date.now()+LEASE_WAIT_MS;
 for(;;){
  const [lease]=await db`INSERT INTO composio_subscription_leases(key,holder,expires_at) VALUES(${key},${holder},now()+${LEASE_MS}*interval '1 millisecond')
   ON CONFLICT(key) DO UPDATE SET holder=EXCLUDED.holder,expires_at=EXCLUDED.expires_at WHERE composio_subscription_leases.expires_at<now() RETURNING holder`;
  if(lease)break;
  if(Date.now()>deadline)throw new PluginError('This trigger is being updated. Try again in a moment.');
  await Bun.sleep(100);
 }
 try{return await body(db);}
 finally{await db`DELETE FROM composio_subscription_leases WHERE key=${key} AND holder=${holder}`;}
}
/** Idempotent: an existing remote subscription with this exact configuration is reused, never duplicated. */
async function register(ownerId:string,id:string){
 const [row]=await db`SELECT t.*,p.credential_secret FROM composio_triggers t JOIN plugin_accounts p ON p.id=t.account_id WHERE t.id=${id} AND t.owner_id=${ownerId}`;
 if(!row)return;
 const connectedAccountId=JSON.parse(decrypt(row.credential_secret)).connectedAccountId as string;
 try{
  await withSubscription(row.account_id,row.trigger_slug,async sql=>{
   const existing=(await composio().listActiveTriggers({connectedAccountIds:[connectedAccountId],triggerNames:[row.trigger_slug]}))
    .find(instance=>instance.connectedAccountId===connectedAccountId&&sameConfig(instance.triggerConfig,row.trigger_config));
   const remoteId=existing?.id??(await composio().createTrigger(composioUserId(ownerId),row.trigger_slug,{connectedAccountId,triggerConfig:row.trigger_config})).triggerId;
   if(existing?.disabledAt)await composio().setTriggerEnabled(remoteId,true);
   await sql`UPDATE composio_triggers SET composio_trigger_id=${remoteId},status='active' WHERE id=${id} AND status IN ('registering','error')`;
  });
 }catch(error){
  await db`UPDATE composio_triggers SET status='error' WHERE id=${id} AND status='registering'`;
  if(!(error instanceof ComposioError))throw error;
 }
}
export async function createTrigger(ownerId:string,companionId:string,raw:unknown){
 const input=createInput.parse(raw);
 if(!await ownedCompanion(ownerId,companionId))return null;
 const account=await ownedComposioAccount(ownerId,input.accountId);
 if(!account)throw new PluginError('Choose one of your connected apps.');
 const type=await composio().getTriggerType(input.triggerSlug).catch(error=>{if(error instanceof ComposioError&&error.status<500)throw new PluginError('Choose an available trigger.');throw error;});
 if(type.toolkit!==account.toolkit)throw new PluginError('This trigger belongs to another app.');
 const required=z.array(z.string()).catch([]).parse((type.config as any).required);
 const missing=required.filter(name=>input.config[name]===undefined||input.config[name]==='');
 if(missing.length)throw new PluginError(`Fill in ${missing.join(', ')}.`);
 const id=crypto.randomUUID();
 // Persist before registering remotely so a crash leaves a visible row that reconciles on retry.
 await db`INSERT INTO composio_triggers(id,owner_id,companion_id,account_id,trigger_slug,trigger_name,trigger_config,instructions)
  VALUES(${id},${ownerId},${companionId},${account.id},${type.slug},${type.name},${input.config}::jsonb,${input.instructions})`;
 await register(ownerId,id);
 return trigger(ownerId,id);
}
/** Remote state follows the union of local rows that share one Composio subscription. */
/** Read under the lease: a resume that overlapped this pause has already made a row active again. */
async function anyActive(sql:any,remoteId:string){
 const [row]=await sql`SELECT count(*)::int AS count FROM composio_triggers WHERE composio_trigger_id=${remoteId} AND status='active'`;
 return row.count>0;
}
export async function updateTrigger(ownerId:string,companionId:string,id:string,raw:unknown){
 const input=updateInput.parse(raw);uuid.parse(id);
 const [row]=await db`SELECT * FROM composio_triggers WHERE id=${id} AND companion_id=${uuid.parse(companionId)} AND owner_id=${ownerId}`;
 if(!row)return null;
 if(input.instructions!==undefined)await db`UPDATE composio_triggers SET instructions=${input.instructions} WHERE id=${id}`;
 if(input.enabled===true&&row.status!=='active'){
  if(!row.composio_trigger_id){await db`UPDATE composio_triggers SET status='registering' WHERE id=${id}`;await register(ownerId,id);}
  else{
   const enabled=await withSubscription(row.account_id,row.trigger_slug,async sql=>{
    await sql`UPDATE composio_triggers SET status='active' WHERE id=${id}`;
    return composio().setTriggerEnabled(row.composio_trigger_id,true).then(()=>true,error=>{if(!(error instanceof ComposioError))throw error;return false;});
   });
   if(!enabled)await db`UPDATE composio_triggers SET status='error' WHERE id=${id}`;
  }
 }
 if(input.enabled===false&&row.status!=='disabled'){
  // Local state commits first: the webhook rechecks it under a row lock before admitting work.
  await db`UPDATE composio_triggers SET status='disabled' WHERE id=${id}`;
  if(row.composio_trigger_id)await withSubscription(row.account_id,row.trigger_slug,async sql=>{
   if(!await anyActive(sql,row.composio_trigger_id))
    await composio().setTriggerEnabled(row.composio_trigger_id,false).catch(error=>{if(!(error instanceof ComposioError))throw error;});
  });
 }
 return trigger(ownerId,id);
}
/**
 * Composio first, then the local rows, under the subscription lease: concurrent deletions of the
 * last rows sharing an instance cannot both skip the remote deletion. A failure keeps the rows.
 */
async function removeRows(rows:Array<{id:string;account_id:string;trigger_slug:string;composio_trigger_id:string|null}>){
 for(const row of rows)await withSubscription(row.account_id,row.trigger_slug,async sql=>{
  const [current]=await sql`SELECT composio_trigger_id FROM composio_triggers WHERE id=${row.id}`;
  if(!current)return;
  if(current.composio_trigger_id){
   const [others]=await sql`SELECT count(*)::int AS count FROM composio_triggers WHERE composio_trigger_id=${current.composio_trigger_id} AND id<>${row.id}`;
   if(others.count===0)await composio().deleteTrigger(current.composio_trigger_id);
  }
  await sql`DELETE FROM composio_triggers WHERE id=${row.id}`;
 });
}
const removable=db`id,account_id,trigger_slug,composio_trigger_id`;
export async function deleteTrigger(ownerId:string,companionId:string,id:string){
 const rows=await db`SELECT ${removable} FROM composio_triggers WHERE id=${uuid.parse(id)} AND companion_id=${uuid.parse(companionId)} AND owner_id=${ownerId}`;
 if(!rows.length)return false;
 try{await removeRows(rows);}catch(error){if(error instanceof ComposioError)throw new PluginError('The trigger could not be removed. Try again.');throw error;}
 return true;
}
export async function deleteAccountTriggers(ownerId:string,accountId:string){
 await removeRows(await db`SELECT ${removable} FROM composio_triggers WHERE account_id=${accountId} AND owner_id=${ownerId}`);
}
export async function deleteCompanionTriggers(ownerId:string,companionId:string){
 await removeRows(await db`SELECT ${removable} FROM composio_triggers WHERE companion_id=${companionId} AND owner_id=${ownerId}`);
}

const triggerMessage=z.object({id:z.string(),type:z.literal('composio.trigger.message'),timestamp:z.string(),
 metadata:z.object({trigger_slug:z.string(),trigger_id:z.string(),connected_account_id:z.string(),user_id:z.string()}).passthrough(),data:z.record(z.string(),z.unknown())});
const accountExpired=z.object({type:z.literal('composio.connected_account.expired'),data:z.object({id:z.string()}).passthrough()});
/** Stable per (delivery, local trigger): Composio retries never admit a second task. */
function eventRunId(webhookId:string,triggerId:string){
 const hex=createHash('sha256').update(`composio-event\0${webhookId}\0${triggerId}`).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function eventTask(row:any,slug:string,timestamp:string){
 return `A Composio trigger fired: ${row.trigger_name} (${slug}) on the "${row.label}" connection at ${timestamp}.\n\nYour instructions for this trigger:\n${row.instructions}`;
}
/** Unauthenticated route: only a valid Composio signature admits work, and payloads never reach logs. */
export async function handleComposioWebhook(request:Request,env:NodeJS.ProcessEnv=process.env):Promise<Response>{
 const reply=(status:number)=>Response.json(status===202?{ok:true}:{error:'Webhook rejected.'},{status,headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')return reply(405);
 if(Number(request.headers.get('content-length')??0)>MAX_WEBHOOK_BYTES)return reply(413);
 const body=await request.text();
 if(Buffer.byteLength(body)>MAX_WEBHOOK_BYTES)return reply(413);
 const webhookId=request.headers.get('webhook-id');
 try{verifyComposioWebhook({id:webhookId,timestamp:request.headers.get('webhook-timestamp'),signature:request.headers.get('webhook-signature'),body,secret:env.COMPOSIO_WEBHOOK_SECRET});}
 catch(error){if(error instanceof WebhookVerificationError)return reply(401);throw error;}
 let payload:unknown;try{payload=JSON.parse(body);}catch{return reply(400);}
 const expired=accountExpired.safeParse(payload);
 if(expired.success){
  await db`UPDATE plugin_accounts SET health_status='error',health_code='authorization_required',health_checked_at=now()
   WHERE provider='composio' AND configuration->>'connectedAccountId'=${expired.data.data.id}`;
  return reply(202);
 }
 const event=triggerMessage.safeParse(payload);
 if(!event.success)return reply(202);
 const {metadata}=event.data;
 const rows=await db`SELECT t.id,t.owner_id,t.companion_id,t.trigger_name,t.instructions,p.label FROM composio_triggers t
  JOIN plugin_accounts p ON p.id=t.account_id AND p.owner_id=t.owner_id JOIN companions c ON c.id=t.companion_id AND c.owner_id=t.owner_id
  WHERE t.composio_trigger_id=${metadata.trigger_id} AND t.status='active' AND c.retired_at IS NULL
   AND p.provider='composio' AND p.configuration->>'connectedAccountId'=${metadata.connected_account_id}`;
 const secret=encrypt(JSON.stringify({id:event.data.id,type:event.data.type,timestamp:event.data.timestamp,triggerSlug:metadata.trigger_slug,data:event.data.data}));
 for(const row of rows){
  // The signed user must own the subscription; a shared instance id alone is not authority.
  if(composioUserId(row.owner_id)!==metadata.user_id)continue;
  await db.begin(async tx=>{
   // Row lock: a concurrent pause either commits first (and admits nothing) or waits for this admission.
   const [current]=await tx`SELECT id FROM composio_triggers WHERE id=${row.id} AND status='active' FOR SHARE`;
   if(!current)return;
   const [inserted]=await tx`INSERT INTO composio_trigger_events(webhook_id,trigger_id,payload_secret) VALUES(${webhookId},${row.id},${secret}) ON CONFLICT DO NOTHING RETURNING trigger_id`;
   if(!inserted)return;
   const runId=await enqueueBackgroundInTransaction({companionId:row.companion_id,clientMessageId:eventRunId(webhookId!,row.id),content:eventTask(row,metadata.trigger_slug,event.data.timestamp),source:'event'},tx);
   await tx`UPDATE composio_trigger_events SET run_id=${runId} WHERE webhook_id=${webhookId} AND trigger_id=${row.id}`;
  });
 }
 return reply(202);
}

/** Executor preparation: stage the verified event as a workspace file instead of prompt text. */
export async function triggerEventFile(runId:string){
 const [row]=await db`SELECT payload_secret FROM composio_trigger_events WHERE run_id=${runId} AND payload_secret IS NOT NULL LIMIT 1`;
 return row?Buffer.from(decrypt(row.payload_secret)):null;
}
/**
 * Provider payloads are kept only while a task may still stage them. The small row outlives its
 * payload so late Composio retries stay deduplicated, and is dropped after the retry horizon.
 */
export async function purgeTriggerEvents(sql:any=db){
 await sql`UPDATE composio_trigger_events e SET payload_secret=NULL WHERE payload_secret IS NOT NULL
  AND (run_id IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.id=e.run_id AND r.status IN ('succeeded','failed','interrupted','cancelled')))`;
 await sql`DELETE FROM composio_trigger_events WHERE payload_secret IS NULL AND received_at<now()-interval '30 days'`;
}

export async function handleComposioTriggers(request:Request,ownerId:string):Promise<Response|null>{
 const path=new URL(request.url).pathname;
 const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 const types=path.match(/^\/api\/plugins\/([a-f0-9-]+)\/trigger-types$/);
 if(types&&request.method==='GET'){const items=await listTriggerTypes(ownerId,uuid.parse(types[1]));return items?json({items}):json({error:'Connection not found.'},404);}
 const match=path.match(/^\/api\/companions\/([a-f0-9-]+)\/triggers(?:\/([a-f0-9-]+))?$/);
 if(!match)return null;
 const companionId=uuid.parse(match[1]);
 if(!match[2]&&request.method==='GET')return await ownedCompanion(ownerId,companionId)?json({triggers:await listTriggers(ownerId,companionId)}):json({error:'Companion not found.'},404);
 if(!match[2]&&request.method==='POST'){const created=await createTrigger(ownerId,companionId,await request.json());return created?json({trigger:created},201):json({error:'Companion not found.'},404);}
 if(match[2]&&request.method==='PATCH'){const updated=await updateTrigger(ownerId,companionId,match[2],await request.json());return updated?json({trigger:updated}):json({error:'Trigger not found.'},404);}
 if(match[2]&&request.method==='DELETE')return await deleteTrigger(ownerId,companionId,match[2])?json({ok:true}):json({error:'Trigger not found.'},404);
 return null;
}
