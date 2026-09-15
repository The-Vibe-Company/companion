import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, Conflict, companionColumns } from './store';
import { requireHostedActivation } from './activation';
import { filesForThread } from './files';

export const uuid = z.string().uuid();
const active = ['queued','preparing','running','needs_input'];
const columns = `id,title,folder_id AS "folderId",direct_companion_id AS "directCompanionId",archived_at AS "archivedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class DiscussionMissing extends Error {}

export async function ownedDiscussion(ownerId:string,id:string,sql:any=db,lock=false) {
 const [row] = await sql.unsafe(`SELECT *,${columns} FROM discussions WHERE id=$1 AND owner_id=$2${lock?' FOR UPDATE':''}`,[id,ownerId]);
 if(!row) throw new DiscussionMissing('Discussion not found.');
 return row;
}
async function availableCompanion(ownerId:string,id:string,sql:any=db) {
 const [companion] = await sql.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2 AND retired_at IS NULL AND archive_requested_at IS NULL`,[id,ownerId]);
 if(!companion) throw new DiscussionMissing('Companion not found.');
 return companion;
}
async function validateCompanions(ownerId:string,ids:string[],sql:any) {
 for(const id of new Set(ids)) await availableCompanion(ownerId,id,sql);
}
function discussion(row:any) {
 return {id:row.id,title:row.title,folderId:row.folderId??row.folder_id??null,directCompanionId:row.directCompanionId??row.direct_companion_id??null,archivedAt:row.archivedAt??row.archived_at??null,createdAt:row.createdAt??row.created_at,updatedAt:row.updatedAt??row.updated_at};
}
export async function listDiscussions(ownerId:string,archived=false,companionId?:string) {
 if(companionId) await availableCompanion(ownerId,companionId);
 const discussions = await db.unsafe(`SELECT ${columns},COALESCE((SELECT jsonb_agg(p.companion_id ORDER BY p.joined_at,p.companion_id)
  FROM discussion_participants p JOIN companions c ON c.id=p.companion_id
  WHERE p.discussion_id=d.id AND p.removed_at IS NULL AND c.owner_id=d.owner_id AND c.retired_at IS NULL),'[]'::jsonb) AS "participantIds",
  last."lastMessage"
  FROM discussions d LEFT JOIN LATERAL (
   SELECT jsonb_build_object('role',m.role,'companionId',m.companion_id,'createdAt',m.created_at,'preview',left(m.content,160)) AS "lastMessage"
   FROM discussion_messages m WHERE m.discussion_id=d.id AND m.role<>'system' ORDER BY m.sequence DESC LIMIT 1
  ) last ON true
  WHERE owner_id=$1 AND (archived_at IS NOT NULL)=$2 AND ($3::uuid IS NULL OR direct_companion_id=$3) ORDER BY updated_at DESC,id LIMIT 500`,[ownerId,archived,companionId??null]);
 const folders = await db`SELECT id,name,to_jsonb(companion_ids) AS "companionIds",created_at AS "createdAt" FROM discussion_folders WHERE owner_id=${ownerId} ORDER BY created_at,id`;
 return {discussions,folders};
}
export async function createDiscussion(ownerId:string,raw:unknown,sql:any=db) {
 const input=z.object({clientCreationId:uuid,title:z.string().trim().min(1).max(160).default('New discussion'),folderId:uuid.nullable().optional(),directCompanionId:uuid.nullable().optional()}).strict().parse(raw);
 const fingerprint=digest(input);
 return sql.begin(async(tx:any)=>{
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.clientCreationId},637))`;
  const [prior]=await tx`SELECT * FROM discussions WHERE id=${input.clientCreationId}`;
  if(prior){if(prior.owner_id!==ownerId||prior.creation_fingerprint!==fingerprint)throw new Conflict('This creation identifier was already used.');return discussion(prior);}
  if(input.folderId&&!(await tx`SELECT id FROM discussion_folders WHERE id=${input.folderId} AND owner_id=${ownerId} FOR UPDATE`).length)throw new DiscussionMissing('Folder not found.');
  const companion=input.directCompanionId?await availableCompanion(ownerId,input.directCompanionId,tx):null;
  const [row]=await tx`INSERT INTO discussions(id,owner_id,title,folder_id,direct_companion_id,creation_fingerprint)
   VALUES(${input.clientCreationId},${ownerId},${companion&&input.title==='New discussion'?companion.name:input.title},${input.folderId??null},${input.directCompanionId??null},${fingerprint}) RETURNING *`;
  if(companion)await tx`INSERT INTO discussion_participants(discussion_id,companion_id) VALUES(${row.id},${companion.id})`;
  return discussion(row);
 });
}
export async function updateDiscussion(ownerId:string,id:string,raw:unknown) {
 const input=z.object({title:z.string().trim().min(1).max(160).optional(),folderId:uuid.nullable().optional(),archived:z.boolean().optional()}).strict().parse(raw);
 return db.begin(async tx=>{
  await ownedDiscussion(ownerId,id,tx,true);
  if(input.folderId&&!(await tx`SELECT id FROM discussion_folders WHERE id=${input.folderId} AND owner_id=${ownerId} FOR UPDATE`).length)throw new DiscussionMissing('Folder not found.');
  const [row]=await tx`UPDATE discussions SET title=COALESCE(${input.title??null},title),folder_id=CASE WHEN ${input.folderId!==undefined} THEN ${input.folderId??null} ELSE folder_id END,
   archived_at=CASE WHEN ${input.archived===undefined} THEN archived_at WHEN ${input.archived===true} THEN COALESCE(archived_at,now()) ELSE NULL END,updated_at=now() WHERE id=${id} RETURNING *`;
  return discussion(row);
 });
}
export async function saveFolder(ownerId:string,id:string,raw:unknown,create=false) {
 const input=z.object({clientCreationId:uuid.optional(),name:z.string().trim().min(1).max(120).optional(),companionIds:z.array(uuid).max(50).optional()}).strict().parse(raw);
 return db.begin(async tx=>{
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id},637))`;
  const [prior]=await tx`SELECT id,owner_id,name,to_jsonb(companion_ids) AS companion_ids FROM discussion_folders WHERE id=${id} FOR UPDATE`;
  if(prior&&prior.owner_id!==ownerId||!prior&&!create)throw new DiscussionMissing('Folder not found.');
  const ids=[...new Set<string>(input.companionIds??prior?.companion_ids??[])].sort();
  await validateCompanions(ownerId,ids,tx);
  if(create&&!input.name)throw new Conflict('A folder name is required.');
  if(create&&prior&&(prior.name!==input.name||JSON.stringify([...prior.companion_ids].sort())!==JSON.stringify(ids)))throw new Conflict('This folder identifier was already used.');
  if(!prior)await tx`INSERT INTO discussion_folders(id,owner_id,name,companion_ids) VALUES(${id},${ownerId},${input.name!},ARRAY(SELECT jsonb_array_elements_text(${ids}::jsonb))::uuid[])`;
  else if(!create)await tx`UPDATE discussion_folders SET name=COALESCE(${input.name??null},name),companion_ids=ARRAY(SELECT jsonb_array_elements_text(${ids}::jsonb))::uuid[] WHERE id=${id}`;
  return (await tx`SELECT id,name,to_jsonb(companion_ids) AS "companionIds",created_at AS "createdAt" FROM discussion_folders WHERE id=${id}`)[0];
 });
}
export async function deleteFolder(ownerId:string,id:string) {
 return db.begin(async tx=>{
  const [folder]=await tx`SELECT id FROM discussion_folders WHERE id=${id} AND owner_id=${ownerId} FOR UPDATE`;
  if(!folder)throw new DiscussionMissing('Folder not found.');
  await tx`UPDATE discussions SET folder_id=null WHERE folder_id=${id} AND owner_id=${ownerId}`;
  await tx`DELETE FROM discussion_folders WHERE id=${id} AND owner_id=${ownerId}`;
 });
}
export async function inviteParticipant(ownerId:string,discussionId:string,companionId:string,sql:any=db) {
 await availableCompanion(ownerId,companionId,sql);
 await sql`INSERT INTO discussion_participants(discussion_id,companion_id) VALUES(${discussionId},${companionId})
  ON CONFLICT(discussion_id,companion_id) DO UPDATE SET removed_at=null`;
}
export async function changeParticipant(ownerId:string,id:string,companionId:string,remove=false) {
 return db.begin(async tx=>{
  const d=await ownedDiscussion(ownerId,id,tx,true);
  if(d.direct_companion_id&&d.direct_companion_id!==companionId)throw new Conflict('This is a direct discussion.');
  if(remove&&d.direct_companion_id)throw new Conflict('The direct companion cannot be removed.');
  if(remove)await tx`UPDATE discussion_participants SET removed_at=now() WHERE discussion_id=${id} AND companion_id=${companionId}`;
  else await inviteParticipant(ownerId,id,companionId,tx);
 });
}
export async function participantAuthorized(d:any,companionId:string,sql:any=db) {
 const [p]=await sql`SELECT removed_at FROM discussion_participants WHERE discussion_id=${d.id} AND companion_id=${companionId}`;
 if(p)return p.removed_at===null;
 return !!d.folder_id&&(await sql`SELECT id FROM discussion_folders WHERE id=${d.folder_id} AND owner_id=${d.owner_id} AND ${companionId}::uuid=ANY(companion_ids)`).length>0;
}
export async function acceptDiscussionMessage(ownerId:string,id:string,raw:unknown,sql:any=db) {
 const input=z.object({clientMessageId:uuid,content:z.string().trim().max(50_000),targetCompanionId:uuid.nullable().optional(),attachmentCount:z.number().int().min(0).max(5).default(0)}).strict().parse(raw);
 if(!input.content&&!input.attachmentCount)throw new Conflict('Write a message or attach a file.');
 return sql.begin(async(tx:any)=>{
  const d=await ownedDiscussion(ownerId,id,tx,true);
  const target=input.targetCompanionId??d.direct_companion_id??null;
  const fingerprint=digest({content:input.content,target,attachmentCount:input.attachmentCount});
  const [prior]=await tx`SELECT * FROM discussion_sends WHERE discussion_id=${id} AND client_message_id=${input.clientMessageId}`;
  if(prior){if(prior.fingerprint!==fingerprint)throw new Conflict('This message identifier was used with different content.');return {runId:prior.run_id,discussionId:id,companionId:prior.companion_id};}
  if(d.archived_at)throw new Conflict('Restore the discussion before sending.');
  if(d.direct_companion_id&&target!==d.direct_companion_id)throw new Conflict('This is a direct discussion.');
  const runId=crypto.randomUUID(),content=input.content||'Please review the attached files.';
  if(target){
   await inviteParticipant(ownerId,id,target,tx);
   await tx`INSERT INTO runs(id,companion_id,discussion_id,client_message_id,content,attachment_count) VALUES(${runId},${target},${id},${runId},${content},${input.attachmentCount})`;
   // The existing executor projects messages using this ID; the discussion projection deduplicates it.
   const messageId=crypto.randomUUID();
   await tx`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${messageId},${target},${runId},'user',${content})`;
   await tx`INSERT INTO discussion_messages(id,discussion_id,role,content,companion_id,run_id,source_message_id) VALUES(${messageId},${id},'user',${content},${target},${runId},${messageId})`;
  }else{
   await tx`INSERT INTO discussion_runs(id,discussion_id,client_message_id,content,attachment_count) VALUES(${runId},${id},${input.clientMessageId},${content},${input.attachmentCount})`;
   await tx`INSERT INTO discussion_messages(id,discussion_id,role,content,run_id) VALUES(${crypto.randomUUID()},${id},'user',${content},${runId})`;
  }
  await tx`INSERT INTO discussion_sends(discussion_id,client_message_id,run_id,companion_id,fingerprint) VALUES(${id},${input.clientMessageId},${runId},${target},${fingerprint})`;
  await tx`UPDATE discussions SET updated_at=now(),title=CASE WHEN title='New discussion' THEN left(${content},80) ELSE title END WHERE id=${id}`;
  return {runId,discussionId:id,companionId:target};
 });
}
export async function cancelDiscussion(ownerId:string,id:string,companionId?:string) {
 return db.begin(async tx=>{
  const d=await ownedDiscussion(ownerId,id,tx,true),target=companionId??d.direct_companion_id;
  if(target){
   if(!(await tx`SELECT companion_id FROM discussion_participants WHERE discussion_id=${id} AND companion_id=${target}`).length)throw new DiscussionMissing('Participant not found.');
   await tx`UPDATE runs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END
    WHERE discussion_id=${id} AND companion_id=${target} AND status IN ('queued','preparing','running','needs_input')`;
  }else await tx`UPDATE discussion_runs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE discussion_id=${id} AND status IN ('queued','running')`;
 });
}
export async function discussionHistory(ownerId:string,id:string,before?:string|number,limit=50,sql:any=db) {
 await ownedDiscussion(ownerId,id,sql);
 const rows=await sql`SELECT id,sequence::text,role,content,companion_id AS "companionId",run_id AS "runId",created_at AS "createdAt",complete FROM discussion_messages
  WHERE discussion_id=${id} AND (${before??null}::bigint IS NULL OR sequence<${before??null}) ORDER BY discussion_messages.sequence DESC LIMIT ${limit+1}`;
 return {messages:rows.slice(0,limit).reverse(),beforeCursor:rows.length>limit?String(rows[limit-1].sequence):null};
}
export async function discussionSnapshot(ownerId:string,id:string,before?:string|number) {
 const d=await ownedDiscussion(ownerId,id);
 const [page,participants,tasks,centralRuns,proposals]=await Promise.all([
  discussionHistory(ownerId,id,before),
  db`SELECT p.companion_id AS "companionId",p.removed_at AS "removedAt",jsonb_build_object('id',c.id,'name',c.name,'instructions',c.instructions,'avatar',c.avatar,'modelId',c.model_id,'runtimeVersion',c.runtime_version,'runtimeUpdateStatus',c.runtime_update_status,'error',c.error,'status',c.status,'provider',c.provider,'retiredAt',c.retired_at,'createdAt',c.created_at,'desktopTaken',c.desktop_taken,'desktopPausedAt',c.desktop_paused_at) AS companion
   FROM discussion_participants p JOIN companions c ON c.id=p.companion_id AND c.owner_id=${ownerId} WHERE p.discussion_id=${id} ORDER BY p.joined_at,c.id`,
  db`SELECT id,companion_id AS "companionId",status,content,preview_text AS "previewText",result_text AS "resultText",error,created_at AS "createdAt",finished_at AS "finishedAt" FROM runs WHERE discussion_id=${id} ORDER BY (status IN ('queued','preparing','running','needs_input')) DESC,created_at DESC LIMIT 100`,
  db`SELECT id,status,preview_text AS "previewText",error,created_at AS "createdAt",finished_at AS "finishedAt" FROM discussion_runs WHERE discussion_id=${id} ORDER BY (status IN ('queued','running')) DESC,created_at DESC LIMIT 50`,
  db`SELECT id,companion_id AS "companionId",reason,prompt,status FROM discussion_proposals WHERE discussion_id=${id} ORDER BY (status='pending') DESC,created_at DESC,id LIMIT 100`
 ]);
 const pageRunIds=page.messages.map((m:any)=>m.runId);
 const messageRuns=pageRunIds.length?await db`SELECT id,companion_id,coordinator_run_id FROM runs WHERE discussion_id=${id} AND id IN (SELECT jsonb_array_elements_text(${pageRunIds}::jsonb)::uuid)`:[];
 const allFiles:any[]=(await Promise.all(participants.map((p:any)=>filesForThread(ownerId,p.companionId,{runIds:[...new Set([...tasks.filter((t:any)=>t.companionId===p.companionId).map((t:any)=>t.id),...messageRuns.filter((r:any)=>r.companion_id===p.companionId).map((r:any)=>r.id)])]})))).flat();
 const uploads=pageRunIds.length?await db`SELECT id,run_id AS "runId",filename AS name,content_type AS "mimeType",byte_size AS size FROM discussion_uploads WHERE discussion_id=${id} AND ready AND run_id IN (SELECT jsonb_array_elements_text(${pageRunIds}::jsonb)::uuid) ORDER BY position`:[];
 allFiles.push(...uploads.map((f:any)=>({...f,kind:'user_upload',url:`/api/discussions/${id}/files/${f.id}`})));
 const taskIds=tasks.map((t:any)=>t.id);
 const questions=taskIds.length?await db`SELECT q.id,q.run_id AS "runId",q.question,q.options,q.answer FROM task_questions q JOIN runs r ON r.id=q.run_id WHERE r.discussion_id=${id} AND r.id IN (SELECT jsonb_array_elements_text(${taskIds}::jsonb)::uuid) ORDER BY q.created_at,q.id`:[];
 return {discussion:discussion(d),participants,messages:page.messages.map((m:any)=>({...m,delegated:messageRuns.some((run:any)=>run.id===m.runId&&run.coordinator_run_id!==null),files:allFiles.filter(f=>f.runId===m.runId&&(m.role==='user'?f.kind==='user_upload':f.kind==='agent_output'))})),
  tasks:tasks.map((t:any)=>({...t,questions:questions.filter((q:any)=>q.runId===t.id),files:allFiles.filter(f=>f.runId===t.id)})),centralRuns,proposals,beforeCursor:page.beforeCursor};
}
export async function answerDiscussionQuestion(ownerId:string,id:string,questionId:string,answer:string) {
 return db.begin(async tx=>{
  await ownedDiscussion(ownerId,id,tx,true);
  const [q]=await tx`SELECT q.*,r.status FROM task_questions q JOIN runs r ON r.id=q.run_id WHERE q.id=${questionId} AND r.discussion_id=${id} FOR UPDATE OF q`;
  if(!q)throw new DiscussionMissing('Question not found.');
  if(q.answer){if(q.answer!==answer)throw new Conflict('This question already has an answer.');return;}
  if(!active.includes(q.status))throw new Conflict('This task has ended.');
  await tx`UPDATE task_questions SET answer=${answer},answered_at=now() WHERE id=${questionId}`;
  await tx`UPDATE runs SET resume_requested_at=COALESCE(resume_requested_at,now()) WHERE id=${q.run_id}`;
 });
}
export async function resolveProposal(ownerId:string,id:string,proposalId:string,accept:boolean) {
 return db.begin(async tx=>{
  await ownedDiscussion(ownerId,id,tx,true);
  const [p]=await tx`SELECT * FROM discussion_proposals WHERE id=${proposalId} AND discussion_id=${id} FOR UPDATE`;
  if(!p)throw new DiscussionMissing('Invitation not found.');
  const status=accept?'accepted':'declined';
  if(p.status!=='pending'){if(p.status!==status)throw new Conflict('This invitation was already answered.');return;}
  if(accept)await inviteParticipant(ownerId,id,p.companion_id,tx);
  await tx`UPDATE discussion_proposals SET status=${status},resolved_at=now() WHERE id=${proposalId}`;
  const runId=crypto.randomUUID();
  await tx`INSERT INTO discussion_runs(id,discussion_id,client_message_id,content) VALUES(${runId},${id},${proposalId},${accept?`The user accepted companion ${p.companion_id}. Delegate the proposed task now: ${p.prompt}`:`The user declined companion ${p.companion_id}. Continue without this companion.`})`;
 });
}

export async function handleDiscussions(request:Request,ownerId:string):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname,json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(!path.startsWith('/api/discussions')&&!path.startsWith('/api/discussion-folders')&&!/^\/api\/companions\/[^/]+\/discussions$/.test(path))return null;
 const write=request.method!=='GET';
 if(write&&path.endsWith('/messages'))await requireHostedActivation(ownerId);
 if(path==='/api/discussions'){
  if(request.method==='GET')return json(await listDiscussions(ownerId,url.searchParams.get('archived')==='true'));
  if(request.method==='POST')return json({discussion:await createDiscussion(ownerId,await request.json())},201);
 }
 const direct=path.match(/^\/api\/companions\/([^/]+)\/discussions$/);
 if(direct&&request.method==='GET')return json(await listDiscussions(ownerId,false,uuid.parse(direct[1])));
 const folder=path.match(/^\/api\/discussion-folders(?:\/([^/]+))?$/);
 if(folder){
  if(!folder[1]&&request.method==='POST'){const raw=await request.json() as any;return json({folder:await saveFolder(ownerId,uuid.parse(raw.clientCreationId),raw,true)},201);}
  if(folder[1]&&request.method==='PATCH')return json({folder:await saveFolder(ownerId,uuid.parse(folder[1]),await request.json())});
  if(folder[1]&&request.method==='DELETE'){await deleteFolder(ownerId,uuid.parse(folder[1]));return json({ok:true});}
 }
 const match=path.match(/^\/api\/discussions\/([^/]+)(?:\/(.*))?$/);
 if(match){
  const id=uuid.parse(match[1]),suffix=match[2]??'';
  if(!suffix&&request.method==='GET'){
   const raw=url.searchParams.get('before');const before=raw===null?undefined:z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n).parse(raw);
   return json(await discussionSnapshot(ownerId,id,before));
  }
  if(!suffix&&request.method==='PATCH')return json({discussion:await updateDiscussion(ownerId,id,await request.json())});
  if(suffix==='messages'&&request.method==='POST')return json(await acceptDiscussionMessage(ownerId,id,await request.json()),202);
  if(suffix==='cancel'&&request.method==='POST'){await cancelDiscussion(ownerId,id);return json({ok:true});}
  const participant=suffix.match(/^participants\/([^/]+)(\/cancel)?$/);
  if(participant){const cid=uuid.parse(participant[1]);
   if(participant[2]&&request.method==='POST'){await cancelDiscussion(ownerId,id,cid);return json({ok:true});}
   if(!participant[2]&&['PUT','DELETE'].includes(request.method)){await changeParticipant(ownerId,id,cid,request.method==='DELETE');return json({ok:true});}
  }
  const question=suffix.match(/^questions\/([^/]+)\/answer$/);
  if(question&&request.method==='POST'){const {answer}=z.object({answer:z.string().trim().min(1).max(10_000)}).parse(await request.json());await answerDiscussionQuestion(ownerId,id,uuid.parse(question[1]),answer);return json({ok:true});}
  const proposal=suffix.match(/^proposals\/([^/]+)$/);
  if(proposal&&request.method==='POST'){const {accept}=z.object({accept:z.boolean()}).parse(await request.json());await resolveProposal(ownerId,id,uuid.parse(proposal[1]),accept);return json({ok:true});}
  if(suffix.startsWith('files/')||/^runs\/[^/]+\/files$/.test(suffix))return null;
 }
 return json({error:'Not found.'},404);
}
