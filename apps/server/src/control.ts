import type {RunExecution} from './executor';
import {ExecutionStopped} from './machines';
import {LifecycleConflict} from './lifecycle-errors';
import {requireHostedActivation} from './activation';
import {controlHelp} from './control-help';
import {availableModels,validateModel} from './models';
import { z } from 'zod';
import {encrypt,decrypt} from './config';
import { db, Conflict } from './store';
import type { ControlOperation } from '../../../packages/control/agent';
export type ControlContext={ownerId:string;companionId:string;runId:string;commandId:string;isChild:boolean};
export type ControlHandler=(context:ControlContext,input:unknown)=>Promise<unknown>;
export const controlHandlers:Partial<Record<ControlOperation,ControlHandler>>={};
export function registerControl(handlers:Partial<Record<ControlOperation,ControlHandler>>) {Object.assign(controlHandlers,handlers);}
export async function migrateProduct(sql:any) {await sql.unsafe(await Bun.file(new URL('./product.sql',import.meta.url)).text());}
const commandSchema=z.object({id:z.string().uuid(),runId:z.string().uuid(),operation:z.string(),input:z.record(z.string(),z.unknown())});
/** Claim before effect; an interrupted unknown outcome is reported, never blindly replayed. */
export async function applyControl(companionId:string,raw:unknown,execution?:RunExecution) {
  const command=commandSchema.parse(raw);
  await execution?.assertActive();
  const [actor]=await db`SELECT c.owner_id,r.status,r.cancel_requested FROM companions c JOIN runs r ON r.companion_id=c.id JOIN "user" u ON u.id=c.owner_id WHERE c.id=${companionId} AND r.id=${command.runId} AND c.retired_at IS NULL`;
  if(!actor||actor.cancel_requested||!['running','needs_input'].includes(actor.status)) return {error:'This task no longer has control authority.'};
  const claimCommand=(sql:any)=>sql`INSERT INTO control_commands (id,companion_id,run_id,operation) VALUES (${command.id},${companionId},${command.runId},${command.operation}) ON CONFLICT DO NOTHING RETURNING id`;
  const [claim]=execution?await execution.checkpoint(claimCommand):await claimCommand(db);
  if(!claim) {
    const [previous]=await db`SELECT operation,result,result_secret,status FROM control_commands WHERE id=${command.id} AND companion_id=${companionId} AND run_id=${command.runId}`;
    const result=previous?.result_secret?JSON.parse(decrypt(previous.result_secret)):previous?.result;
    // Old daemons can remain parked until their question is answered, which also
    // defers their runtime update. Resolve only the existing unanswered question;
    // preserve explicit answers and requests with an unknown outcome.
    if(command.operation==='app_tool_confirm'&&previous?.operation===command.operation&&result?.pendingQuestionId===command.id){
      const answer=(sql:any)=>sql`UPDATE task_questions SET answer='Approve this call',answered_at=now(),context_text=(SELECT preview_text FROM runs WHERE id=${command.runId}) WHERE id=${command.id} AND companion_id=${companionId} AND run_id=${command.runId} AND answer IS NULL`;
      if(execution)await execution.checkpoint(answer);else await answer(db);
    }
    return result??{error:'The previous attempt has an unknown outcome. Inspect the current state before requesting a new change.'};
  }
  let result:unknown;
  try {
    if(['companion_create','prepare','delegate','desktop_takeover'].includes(command.operation))await requireHostedActivation(actor.owner_id);
    await execution?.assertActive();
    // Compatibility for old runtimes: acknowledge directly without exposing this
    // retired operation in discovery or creating a human approval question.
    const handle=command.operation==='app_tool_confirm'
      ?async()=>({answer:'Approve this call'})
      :controlHandlers[command.operation as ControlOperation];
    if(!handle) result={error:'This operation is not available.'};
    else result=await handle({ownerId:actor.owner_id,companionId,runId:command.runId,commandId:command.id,isChild:false},command.input);
  }catch(error){
    if(error instanceof ExecutionStopped)throw error;
    result=error instanceof LifecycleConflict
      ?{error:error.message,code:error.code,commandId:command.id}
      :{error:error instanceof z.ZodError?'The operation input is invalid.':'The operation could not be completed. Inspect its state before retrying.',code:error instanceof z.ZodError?'invalid_input':'operation_failed',commandId:command.id};
  }
  if(JSON.stringify(result).length>90_000) result={error:'Result too large. Request a narrower result.'};
  const persistResult=(sql:any)=>sql`UPDATE control_commands SET status='done',result=null,result_secret=${encrypt(JSON.stringify(result))},finished_at=now() WHERE id=${command.id}`;
  if(execution)await execution.checkpoint(persistResult,false);else await persistResult(db);
  return result;
}
export const avatarSchema=z.object({shape:z.number().int().min(0).max(7),color:z.number().int().min(0).max(10),face:z.number().int().min(0).max(4)});
export const identitySchema=z.object({name:z.string().trim().min(1).max(80).optional(),instructions:z.string().max(20_000).optional(),avatar:avatarSchema.optional(),modelId:z.string().min(1).max(200).nullable().optional()});
export async function configureCompanion(ownerId:string,id:string,input:unknown,sql:any=db) {
  const value=identitySchema.parse(input);
  if(value.modelId)await validateModel(value.modelId);
  const [row]=await sql`UPDATE companions SET model_id=CASE WHEN ${value.modelId!==undefined} THEN ${value.modelId??null} ELSE model_id END,name=COALESCE(${value.name??null},name),instructions=COALESCE(${value.instructions??null},instructions),avatar=COALESCE(${value.avatar??null},avatar) WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL RETURNING id,name,instructions,avatar,model_id AS "modelId"`;
  return row??null;
}
registerControl({
  history_search:async(context,input)=>{
    const value=z.object({query:z.string().trim().min(2).max(200),limit:z.number().int().min(1).max(10).default(5)}).parse(input);
    const matches=await db`SELECT r.id AS "runId",r.lane,r.status,r.created_at AS "createdAt",
      left(ts_headline('simple',r.content || E'\\n' || COALESCE(r.result_text,''),websearch_to_tsquery('simple',${value.query}),
        'StartSel=[, StopSel=], MaxWords=60, MinWords=15, MaxFragments=2'),1200) AS excerpt
      FROM runs r JOIN companions c ON c.id=r.companion_id
      WHERE c.id=${context.companionId} AND c.owner_id=${context.ownerId} AND c.retired_at IS NULL
        AND r.discussion_id IS NOT DISTINCT FROM (SELECT discussion_id FROM runs WHERE id=${context.runId})
        AND r.id<>${context.runId} AND r.status IN ('succeeded','failed','interrupted','cancelled')
        AND to_tsvector('simple',r.content || E'\\n' || COALESCE(r.result_text,'')) @@ websearch_to_tsquery('simple',${value.query})
      ORDER BY r.created_at DESC,r.id DESC LIMIT ${value.limit}`;
    return {matches};
  },
  models:async()=>({models:await availableModels()}),
  identity:async context=>{
    const [companion]=await db`SELECT id,name,instructions,avatar,model_id AS "modelId",desktop_taken AS "desktopTaken",desktop_paused_at AS "desktopPausedAt",status FROM companions WHERE id=${context.companionId} AND owner_id=${context.ownerId}`;
    return {companion,isChild:false,operations:Object.keys(controlHandlers).filter(operation=>!operation.startsWith('composio_')),examples:controlHelp,instructions:'Read current state before changing it. Omit example placeholder IDs. OAuth returns a consent link for the human; never claim connection before consent succeeds. Use plugin_check with an accountId to verify catalog discovery. Local Pi skills belong under the agent skills directory. Human desktop control persists until the human explicitly releases it.'};
  },
  configure:(context,input)=>configureCompanion(context.ownerId,context.companionId,input),
  companions:async context=>db`SELECT id,name,instructions,avatar,status FROM companions WHERE owner_id=${context.ownerId} AND retired_at IS NULL ORDER BY created_at`,
  ask_user:async(context,input)=>{
    const value=z.object({question:z.string().min(1).max(2000),options:z.array(z.string().max(200)).max(6).default([])}).parse(input);
    await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${context.commandId},${context.companionId},${context.runId},${value.question},${value.options}) ON CONFLICT DO NOTHING`;
    return {pendingQuestionId:context.commandId};
  },
  // Desktop authority is registered by lifecycleControlHandlers, alongside its durable
  // generation and explicit human-release checks. Never provide an unfenced fallback.
});
