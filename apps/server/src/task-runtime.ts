import type {SQL} from 'bun';
import {db} from './store';

export class TaskConflict extends Error {}
export type BackgroundInput={companionId:string;clientMessageId:string;content:string;source:'background'|'delegation'|'event'};

export async function enqueueBackground(input:BackgroundInput,sql:SQL=db):Promise<string|null>{
 return sql.begin(tx=>enqueueBackgroundInTransaction(input,tx));
}

/** Persist a background task before the executor may launch it. */
export async function enqueueBackgroundInTransaction(input:BackgroundInput,tx:SQL):Promise<string|null>{
 if(!input.content.trim()||input.content.length>50_000)throw Error('Task content is invalid.');
 const [companion]=await tx`SELECT id FROM companions WHERE id=${input.companionId} AND retired_at IS NULL AND archive_requested_at IS NULL FOR UPDATE`;
 if(!companion)return null;
 const [existing]=await tx`SELECT id,content,lane,source FROM runs WHERE companion_id=${input.companionId} AND client_message_id=${input.clientMessageId}`;
 if(existing){
  if(existing.content!==input.content||existing.lane!=='background'||existing.source!==input.source)throw new TaskConflict('Task identifier is already used.');
  return existing.id;
 }
 const id=crypto.randomUUID();
 await tx`INSERT INTO runs(id,companion_id,client_message_id,content,lane,source) VALUES(${id},${input.companionId},${input.clientMessageId},${input.content},'background',${input.source})`;
 return id;
}

export async function requestRunResume(companionId:string,runId:string,sql:SQL=db){
 const rows=await sql`UPDATE runs SET resume_requested_at=COALESCE(resume_requested_at,now()) WHERE companion_id=${companionId} AND id=${runId} AND status IN ('running','needs_input') RETURNING id`;
 return rows.length>0;
}
