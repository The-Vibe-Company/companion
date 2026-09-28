import {z} from 'zod';
import {registerControl} from './control';
import {startPluginConnection,addCustomPlugin,disconnectPlugin,listPluginCatalog,checkPluginAccount} from './plugins';
import {handleDelivery} from './delivery';
import {handleMaintenance} from './maintenance';
import {db,createCompanion} from './store';
import {config} from './config';
const uuid=z.string().uuid();
async function maintenanceRequest(ownerId:string,companionId:string,suffix:string,method='GET',body?:unknown){return (await handleMaintenance(new Request(`http://control/api/maintenance/companions/${companionId}${suffix}`,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}),ownerId))!.json();}
registerControl({
 maintenance:async context=>(await handleMaintenance(new Request('http://control/api/maintenance'),context.ownerId))!.json(),
 maintenance_inspect:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,''),
 maintenance_history:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,'/actions'),
 maintenance_prepare:async(context,raw)=>maintenanceRequest(context.ownerId,z.object({companionId:uuid}).parse(raw).companionId,'/prepare','POST'),
 maintenance_configure:async(context,raw)=>{const {companionId,configuration}=z.object({companionId:uuid,configuration:z.record(z.string(),z.unknown())}).parse(raw);return maintenanceRequest(context.ownerId,companionId,'','PATCH',configuration);},
 maintenance_task:async(context,raw)=>{const {companionId,prompt}=z.object({companionId:uuid,prompt:z.string().min(1).max(50_000)}).parse(raw);return maintenanceRequest(context.ownerId,companionId,'/tasks','POST',{clientMessageId:context.commandId,prompt});},
 companion_create:async(context,raw)=>{const input=z.object({name:z.string().trim().min(1).max(80),instructions:z.string().max(20_000).optional()}).parse(raw);return createCompanion(context.ownerId,{...input,clientCreationId:context.commandId,prepare:true,provider:config.defaultProvider});},
 plugin_catalog:async()=>({plugins:await listPluginCatalog()}),
 plugin_connect:async(context,raw)=>{const input=z.object({serverId:z.string(),label:z.string().max(80).default('')}).parse(raw);return startPluginConnection(context.ownerId,input.serverId,input.label);},
 plugin_custom:async(context,raw)=>addCustomPlugin(context.ownerId,raw),
 plugin_check:async(context,raw)=>({account:await checkPluginAccount(context.ownerId,z.object({accountId:uuid}).parse(raw).accountId)}),
 plugin_disconnect:async(context,raw)=>{await disconnectPlugin(context.ownerId,z.object({accountId:uuid}).parse(raw).accountId);return {ok:true};},
 task_cancel:async(context,raw)=>{const {runId}=z.object({runId:uuid}).parse(raw);const [run]=await db`UPDATE runs r SET cancel_requested=true,status=CASE WHEN r.dispatched THEN r.status ELSE 'cancelled' END,finished_at=CASE WHEN r.dispatched THEN r.finished_at ELSE now() END FROM companions c,runs current WHERE r.id=${runId} AND r.companion_id=c.id AND c.owner_id=${context.ownerId} AND current.id=${context.runId} AND current.companion_id=${context.companionId} AND r.discussion_id IS NOT DISTINCT FROM current.discussion_id AND (current.discussion_id IS NOT NULL OR r.companion_id=${context.companionId}) AND r.status IN ('queued','preparing','running','needs_input') RETURNING r.id`;return run?{ok:true}:{error:'Task not found or already finished.'};},
 deliveries:async context=>(await handleDelivery(new Request('http://control/api/deliveries'),context.ownerId))!.json(),
 delivery_prepare:async(context,raw)=>(await handleDelivery(new Request('http://control/api/deliveries',{method:'POST',body:JSON.stringify({...z.record(z.string(),z.unknown()).parse(raw),companionId:context.companionId,clientDeliveryId:context.commandId})}),context.ownerId))!.json(),
});
