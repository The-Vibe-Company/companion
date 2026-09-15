import {beforeAll,afterEach,expect,test,spyOn} from 'bun:test';
import {db,migrate,createCompanion} from '../src/store';
import {acquireExecutor} from '../src/executor';
import {createDiscussion,acceptDiscussionMessage,listDiscussions,saveFolder,changeParticipant,cancelDiscussion,resolveProposal,discussionSnapshot,updateDiscussion,discussionHistory} from '../src/discussions';
import {claimDiscussionRuns,discussionTool,executeDiscussion,projectDiscussionResults} from '../src/discussion-executor';
import {scriptedDiscussionModel} from '../src/discussion-model';
import {storeDiscussionUpload,resolveDiscussionFile} from '../src/discussion-files';
const owner='00000000-0000-4000-8000-000000000001';
const ids:string[]=[];
beforeAll(()=>migrate());
afterEach(async()=>{for(const id of ids.splice(0)){await db`UPDATE discussion_runs SET status='cancelled',cancel_requested=true,finished_at=now() WHERE discussion_id=${id} AND status IN ('queued','running')`;await db`UPDATE runs SET status='cancelled',cancel_requested=true,finished_at=now() WHERE discussion_id=${id} AND status IN ('queued','preparing','running','needs_input')`;}});
async function discussion(extra:any={}){const d=await createDiscussion(owner,{clientCreationId:crypto.randomUUID(),...extra});ids.push(d.id);return d;}
async function companion(){return createCompanion(owner,{name:'Designer',provider:'local'});}
async function leader(){const sql=await acquireExecutor();if(!sql)throw Error('No leader');const [p]=await sql`SELECT pg_backend_pid() AS pid`;return {sql,pid:p.pid,async close(){await sql`SELECT pg_advisory_unlock(721440139)`;sql.release();}};}
const send=(id:string,content='hello',extra:any={})=>acceptDiscussionMessage(owner,id,{clientMessageId:crypto.randomUUID(),content,...extra});

test('independent discussions use stable request identity across concurrent retries and recipients',async()=>{
 const a=await discussion(),b=await discussion(),c=await companion(),clientMessageId=crypto.randomUUID();
 const body={clientMessageId,content:'hello'};
 const accepted=await Promise.all(Array.from({length:8},()=>acceptDiscussionMessage(owner,a.id,body)));
 expect(new Set(accepted.map(r=>r.runId)).size).toBe(1);
 await expect(acceptDiscussionMessage(owner,a.id,{...body,targetCompanionId:c.id})).rejects.toThrow('different content');
 const other=await acceptDiscussionMessage(owner,b.id,body);expect(other.runId).not.toBe(accepted[0].runId);
 expect((await discussionSnapshot(owner,a.id)).messages).toHaveLength(1);
 await expect(discussionSnapshot('other-user',a.id)).rejects.toThrow('not found');
 await expect(acceptDiscussionMessage('other-user',a.id,body)).rejects.toThrow('not found');
});

test('folder defaults authorize delegation; removals preserve accepted work and require another invitation',async()=>{
 const c=await companion(),folderId=crypto.randomUUID();
 await saveFolder(owner,folderId,{name:'Project',companionIds:[c.id]},true);
 const d=await discussion({folderId});await send(d.id);const l=await leader();
 try{
  const [run]=await claimDiscussionRuns(l.pid);const input={companionId:c.id,prompt:'Make design',reason:'Design needed',fileIds:[]};
  const results=await Promise.all(Array.from({length:5},()=>discussionTool(run,'delegate',input,'call1')));
  expect(new Set(results.map(r=>r.runId)).size).toBe(1);expect(results[0].status).toBe('queued');
  await changeParticipant(owner,d.id,c.id,true);
  expect((await db`SELECT status FROM runs WHERE id=${results[0].runId}`)[0].status).toBe('queued');
  const p=await discussionTool(run,'delegate',input,'call2');expect(p.requiresUserApproval).toBe(true);
  await resolveProposal(owner,d.id,p.invitation,true);await resolveProposal(owner,d.id,p.invitation,true);
  expect((await db`SELECT id FROM discussion_runs WHERE client_message_id=${p.invitation}`)).toHaveLength(1);
  const foreign=await discussion();await send(foreign.id,'other');
  expect(await discussionTool(run,'cancel_task',{runId:(await db`SELECT id FROM discussion_runs WHERE discussion_id=${foreign.id}`)[0].id},'bad-cancel')).toMatchObject({error:expect.any(String)});
 }finally{await l.close();}
});

test('chat cancellation is independent of companion work and other discussions; archive preserves work',async()=>{
 const c=await companion(),a=await discussion(),b=await discussion();
 const central=await send(a.id),ta=await send(a.id,'a',{targetCompanionId:c.id}),tb=await send(b.id,'b',{targetCompanionId:c.id});
 await cancelDiscussion(owner,a.id);
 expect((await db`SELECT status FROM discussion_runs WHERE id=${central.runId}`)[0].status).toBe('cancelled');
 expect((await db`SELECT status FROM runs WHERE id=${ta.runId}`)[0].status).toBe('queued');
 await cancelDiscussion(owner,a.id,c.id);
 expect((await db`SELECT status FROM runs WHERE id=${ta.runId}`)[0].status).toBe('cancelled');
 expect((await db`SELECT status FROM runs WHERE id=${tb.runId}`)[0].status).toBe('queued');
 await updateDiscussion(owner,b.id,{archived:true});
 expect((await db`SELECT status FROM runs WHERE id=${tb.runId}`)[0].status).toBe('queued');
 await expect(send(b.id)).rejects.toThrow('Restore');
});

test('central claims serialize one discussion and do not replay an interrupted model turn',async()=>{
 const a=await discussion(),b=await discussion();await send(a.id);await send(a.id,'second');await send(b.id);
 const l=await leader();try{
  const claimed=await claimDiscussionRuns(l.pid);expect(claimed).toHaveLength(2);
  expect(new Set(claimed.map(r=>r.discussion_id)).size).toBe(2);expect(await claimDiscussionRuns(l.pid)).toHaveLength(0);
  const run=claimed.find(r=>r.discussion_id===a.id)!;
  await db`UPDATE discussion_runs SET leader_pid=-1 WHERE id=${run.id}`;
  const next=await claimDiscussionRuns(l.pid);
  expect(next).toHaveLength(1);expect(next[0].id).not.toBe(run.id);
  expect((await db`SELECT status FROM discussion_runs WHERE id=${run.id}`)[0].status).toBe('interrupted');
 }finally{await l.close();}
});

test('real AI SDK streaming loop persists the answer and can recover it from a fresh snapshot',async()=>{
 const d=await discussion();const accepted=await send(d.id,'Bonjour');const l=await leader();
 try{const [run]=await claimDiscussionRuns(l.pid);await executeDiscussion(run,new AbortController().signal,scriptedDiscussionModel);
  const snapshot=await discussionSnapshot(owner,d.id);expect(snapshot.centralRuns[0].status).toBe('succeeded');
  expect(snapshot.messages.at(-1)).toMatchObject({role:'assistant',runId:accepted.runId,content:'Discussion test response: Bonjour'});
 }finally{await l.close();}
});

test('repeated native results yield one timeline message and one central continuation',async()=>{
 const c=await companion(),d=await discussion();await changeParticipant(owner,d.id,c.id);await send(d.id);const l=await leader();
 try{
  const [run]=await claimDiscussionRuns(l.pid);const task=await discussionTool(run,'delegate',{companionId:c.id,prompt:'Design',reason:'needed',fileIds:[]},'call');
  await db`UPDATE runs SET status='succeeded',result_text='Result',finished_at=now() WHERE id=${task.runId}`;
  await db`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${crypto.randomUUID()},${c.id},${task.runId},'assistant','Result')`;
  await db.begin(projectDiscussionResults);await db.begin(projectDiscussionResults);
  expect((await db`SELECT id FROM discussion_runs WHERE source_run_id=${task.runId}`)).toHaveLength(1);
  expect((await discussionSnapshot(owner,d.id)).messages.filter((m:any)=>m.content==='Result')).toHaveLength(1);
  expect((await discussionSnapshot(owner,d.id)).messages.find((m:any)=>m.content==='Result').delegated).toBe(true);
 }finally{await l.close();}
});

test('central uploads remain queued until durable bytes and deduplicate after an upload failure',async()=>{
 const d=await discussion();const accepted=await send(d.id,'file',{attachmentCount:1});const l=await leader();let puts=0;const blobs=new Map<string,Blob>();
 const storage={async put(key:string,bytes:Uint8Array,type:string){puts++;if(puts===1)throw Error('unavailable');blobs.set(key,new Blob([new Uint8Array(bytes)],{type}));},async get(key:string){return blobs.get(key)!;},async delete(){}};
 const input={clientFileId:crypto.randomUUID(),position:0,filename:'note.txt',contentType:'text/plain',bytes:new TextEncoder().encode('hello')};
 try{
  await expect(storeDiscussionUpload(owner,d.id,accepted.runId,input,storage)).rejects.toThrow('unavailable');
  expect(await claimDiscussionRuns(l.pid)).toHaveLength(0);
  await storeDiscussionUpload(owner,d.id,accepted.runId,input,storage);await storeDiscussionUpload(owner,d.id,accepted.runId,input,storage);
  expect(puts).toBe(2);expect(await claimDiscussionRuns(l.pid)).toHaveLength(1);
  await expect(storeDiscussionUpload(owner,d.id,accepted.runId,{...input,bytes:new TextEncoder().encode('changed')},storage)).rejects.toThrow('already used');
 }finally{await l.close();}
});

test('pagination is exclusive and cannot leak a neighboring discussion',async()=>{
 const a=await discussion(),b=await discussion();await send(b.id,'PRIVATE');
 for(let i=0;i<56;i++)await send(a.id,String(i));
 const page=await discussionHistory(owner,a.id);expect(page.messages).toHaveLength(50);
 const older=await discussionHistory(owner,a.id,Number(page.beforeCursor));expect(older.messages).toHaveLength(6);
 expect(new Set([...page.messages,...older.messages].map((m:any)=>m.id)).size).toBe(56);
 expect([...page.messages,...older.messages].some((m:any)=>m.content==='PRIVATE')).toBe(false);
});

test('the real Google SDK uses the scoped gateway and records usage without a companion machine',async()=>{
 const {gatewayDiscussionModel}=await import('../src/discussion-model');const {createModelGateway}=await import('../src/model-gateway');
 const d=await discussion();await send(d.id,'hello');const l=await leader();let calls=0;
 try{
  const [run]=await claimDiscussionRuns(l.pid);run.model_provider='google';run.model_id='gemini-2.5-flash';
  await db`UPDATE discussion_runs SET model_provider=${run.model_provider},model_id=${run.model_id} WHERE id=${run.id}`;
  const gateway=createModelGateway({modelApi:async()=> 'google-generative-ai',key:()=> 'synthetic-key',authorize:async()=>{},fetch:Object.assign(async(_input:any,init:any)=>{
   calls++;const [claim]=await db`SELECT * FROM model_gateway_requests WHERE discussion_run_id=${run.id}`;
   expect(claim.status).toBe('forwarding');expect(claim.companion_id).toBeNull();expect(claim.run_id).toBeNull();
   expect(new Headers(init.headers).get('x-companions-model-token')).toBeNull();
   return new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'Gateway verified'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:3,totalTokenCount:13}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  },{preconnect:fetch.preconnect})});
  const transport=Object.assign(async(input:any,init:any)=>{const response=await gateway.handle(new Request(String(input),init));if(!response)throw Error('Wrong route');expect(response.status).toBe(200);return response;},{preconnect:fetch.preconnect});
  await executeDiscussion(run,new AbortController().signal,gatewayDiscussionModel(run,transport));await gateway.drain();
  expect(calls).toBe(1);expect((await discussionSnapshot(owner,d.id)).messages.at(-1).content).toBe('Gateway verified');
  const [usage]=await db`SELECT usage,usage_verified FROM model_gateway_requests WHERE discussion_run_id=${run.id}`;expect(usage.usage_verified).toBe(true);expect(usage.usage.totalTokens).toBe(13);
 }finally{await l.close();}
});

test('direct discussion attachment route stages only its own accepted native request',async()=>{
 const {handleDiscussionFiles}=await import('../src/discussion-files');
 const c=await companion(),a=await discussion({directCompanionId:c.id}),b=await discussion();
 const accepted=await send(a.id,'Read file',{attachmentCount:1});const clientFileId=crypto.randomUUID();
 const request=(id:string)=>{const form=new FormData();form.set('file',new File(['attachment content'],'note.txt',{type:'text/plain'}));form.set('clientFileId',clientFileId);form.set('position','0');return new Request(`http://localhost/api/discussions/${id}/runs/${accepted.runId}/files`,{method:'POST',body:form});};
 await expect(handleDiscussionFiles(request(b.id),owner)).rejects.toThrow('not found');
 const response=await handleDiscussionFiles(request(a.id),owner);expect(response?.status).toBe(201);
 const duplicate=await handleDiscussionFiles(request(a.id),owner);expect(duplicate?.status).toBe(201);
 const files=await db`SELECT id,filename FROM attachments WHERE run_id=${accepted.runId}`;expect(files).toHaveLength(1);
 expect((await discussionSnapshot(owner,a.id)).messages[0].files).toHaveLength(1);
});

test('timeline ordering compares numeric sequence values across different digit lengths',async()=>{
 const d=await discussion(),runId=crypto.randomUUID();
 await db`INSERT INTO discussion_messages(id,sequence,discussion_id,role,content,run_id) VALUES(${crypto.randomUUID()},9000000001,${d.id},'user','First',${runId}),(${crypto.randomUUID()},10000000002,${d.id},'assistant','Second',${runId})`;
 expect((await discussionHistory(owner,d.id)).messages.map((m:any)=>m.content)).toEqual(['First','Second']);
});

test('invitations preserve attachment references and older file discovery stays discussion scoped',async()=>{
 const c=await companion(),a=await discussion(),b=await discussion();
 const upload=async(id:string)=>{
  const accepted=await send(id,'Use this document',{attachmentCount:1});
  const input={clientFileId:crypto.randomUUID(),position:0,filename:'brief.txt',contentType:'text/plain',bytes:new TextEncoder().encode('A design brief')};
  const file=await storeDiscussionUpload(owner,id,accepted.runId,input,{async put(){},async get(){return new Blob();},async delete(){}});
  return file;
 };
 const fileA=await upload(a.id),fileB=await upload(b.id),l=await leader();
 try{
  const run=(await claimDiscussionRuns(l.pid)).find(r=>r.discussion_id===a.id)!;
  const files=await discussionTool(run,'files',{},'files');expect(files.map((f:any)=>f.id)).toContain(fileA.id);expect(files.map((f:any)=>f.id)).not.toContain(fileB.id);
  await expect(discussionTool(run,'delegate',{companionId:c.id,prompt:'Use brief',reason:'Design',fileIds:[fileB.id]},'foreign')).rejects.toThrow('FILE_NOT_IN_DISCUSSION');
  const proposal=await discussionTool(run,'delegate',{companionId:c.id,prompt:'Use brief',reason:'Design',fileIds:[fileA.id]},'invite');
  await resolveProposal(owner,a.id,proposal.invitation,true);
  const [continuation]=await db`SELECT content FROM discussion_runs WHERE client_message_id=${proposal.invitation}`;
  expect(continuation.content).toContain(fileA.id);
 }finally{await l.close();}
});


test('explicit user file references permit reuse without exposing unrelated history or another owner files',async()=>{
 const a=await discussion(),b=await discussion(),c=await companion();
 const original=await send(a.id,'Source attachment',{attachmentCount:1});
 const file=await storeDiscussionUpload(owner,a.id,original.runId,{clientFileId:crypto.randomUUID(),position:0,filename:'reference.txt',contentType:'text/plain',bytes:new TextEncoder().encode('Reference')},{async put(){},async get(){return new Blob();},async delete(){}});
 expect(await resolveDiscussionFile(owner,b.id,file.id)).toBeNull();
 await db`INSERT INTO discussion_messages(id,discussion_id,role,content,run_id) VALUES(${crypto.randomUUID()},${b.id},'assistant',${'Suggested file '+file.id},${crypto.randomUUID()})`;
 expect(await resolveDiscussionFile(owner,b.id,file.id)).toBeNull();
 await send(b.id,'Use this reference: '+file.url);
 expect(await resolveDiscussionFile(owner,b.id,file.id)).toMatchObject({id:file.id,filename:'reference.txt'});
 await expect(resolveDiscussionFile('other-owner',b.id,file.id)).rejects.toThrow('not found');
 await changeParticipant(owner,b.id,c.id);const l=await leader();
 try{const run=(await claimDiscussionRuns(l.pid)).find(r=>r.discussion_id===b.id)!;
  expect(await discussionTool(run,'files',{fileId:file.id},'reference')).toEqual([{id:file.id,name:'reference.txt',mimeType:'text/plain',size:9}]);
  const task=await discussionTool(run,'delegate',{companionId:c.id,prompt:'Use the explicit reference',reason:'Needed',fileIds:[file.id]},'delegate-reference');
  expect((await db`SELECT file_id FROM discussion_task_files WHERE run_id=${task.runId}`)[0].file_id).toBe(file.id);
 }finally{await l.close();}
});


test('a full companion configuration plus a bounded arrival briefing fits the real daemon protocol',async()=>{
 const {prepareDiscussionContext}=await import('../src/runtime-product');
 const {AgentDaemon}=await import('../../../packages/agent/src/daemon');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const c=await companion(),d=await discussion();
 for(let i=0;i<30;i++)await db`INSERT INTO discussion_messages(id,discussion_id,role,content,run_id) VALUES(${crypto.randomUUID()},${d.id},'user',${String(i)+' '+('quoted \"context\" '.repeat(500))},${crypto.randomUUID()})`;
 const accepted=await send(d.id,'Keep the actual user prompt',{targetCompanionId:c.id});
 const [run]=await db`SELECT * FROM runs WHERE id=${accepted.runId}`;
 await prepareDiscussionContext(run,'http://unused','fixture');
 const instructions='I'.repeat(20000)+'\n\n'+run.discussion_context;
 expect(instructions.length).toBeLessThan(40000);expect(run.content).toBe('Keep the actual user prompt');
 const dir=mkdtempSync(join(tmpdir(),'discussion-briefing-'));let called=false;
 const daemon=new AgentDaemon(dir,'fixture',{async execute(_id,input){called=true;expect(input.content).toBe(run.content);expect(input.instructions).toContain('discussion_history');return{text:'done'};},async cancel(){}});
 try{const response=await daemon.fetch(new Request('http://agent/runs/'+run.id,{method:'PUT',headers:{authorization:'Bearer fixture'},body:JSON.stringify({content:run.content,instructions,conversationId:d.id})}));
  expect(response.status).toBe(202);await Bun.sleep(0);expect(called).toBe(true);
 }finally{daemon.close();rmSync(dir,{recursive:true,force:true});}
});


test('OpenAI Responses tool steps and later turns replay local content through the gateway',async()=>{
 const {gatewayDiscussionModel}=await import('../src/discussion-model');const {createModelGateway}=await import('../src/model-gateway');
 const d=await discussion();await send(d.id,'Discover companions');const l=await leader();let calls=0;
 try{
  const gateway=createModelGateway({modelApi:async()=> 'openai-responses',key:()=> 'synthetic-key',authorize:async()=>{},fetch:Object.assign(async(_input:any,init:any)=>{
   calls++;const body=JSON.parse(init.body);expect(body.store).toBe(false);
   expect(body.input.some((item:any)=>item.type==='item_reference')).toBe(false);
   if(calls===2)expect(body.input.some((item:any)=>item.type==='function_call_output')).toBe(true);
   const item={type:'message',id:`msg_${calls}`,role:'assistant',content:[]};
   const events:any[]=[{type:'response.output_item.added',output_index:0,item},{type:'response.output_text.delta',item_id:item.id,delta:'Gateway verified'},{type:'response.output_item.done',output_index:0,item}];
   if(calls===1){const fn={type:'function_call',id:'fc_test',call_id:'call_test',name:'companions',arguments:'{}',status:'completed'};events.push({type:'response.output_item.added',output_index:1,item:fn},{type:'response.output_item.done',output_index:1,item:fn});}
   events.push({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:3,total_tokens:13}}});
   return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  },{preconnect:fetch.preconnect})});
  const transport=Object.assign(async(input:any,init:any)=>{const response=await gateway.handle(new Request(String(input),init));if(!response)throw Error('Wrong route');return response;},{preconnect:fetch.preconnect});
  for(let turn=0;turn<2;turn++){
   if(turn)await send(d.id,'Continue from the previous answer');
   const [run]=await claimDiscussionRuns(l.pid);run.model_provider='openai';run.model_id='gpt-4.1';
   await db`UPDATE discussion_runs SET model_provider=${run.model_provider},model_id=${run.model_id} WHERE id=${run.id}`;
   await executeDiscussion(run,new AbortController().signal,gatewayDiscussionModel(run,transport));await gateway.drain();
   expect((await db`SELECT status FROM discussion_runs WHERE id=${run.id}`)[0].status).toBe('succeeded');
  }
  expect(calls).toBe(3);
 }finally{await l.close();}
});


test('discussion provider errors never log request payloads or persist their details',async()=>{
 const d=await discussion();await send(d.id);const l=await leader();const log=spyOn(console,'error').mockImplementation(()=>{});
 try{
  const [run]=await claimDiscussionRuns(l.pid);
  if(typeof scriptedDiscussionModel==='string')throw Error('Expected test model');
  const model={...scriptedDiscussionModel,async doStream(){throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'),{requestBodyValues:{secret:'PRIVATE_PROVIDER_BODY'}});}};
  await executeDiscussion(run,new AbortController().signal,model);
  expect(log).not.toHaveBeenCalled();
  const [saved]=await db`SELECT status,error FROM discussion_runs WHERE id=${run.id}`;
  expect(saved.status).toBe('failed');expect(saved.error).not.toContain('PRIVATE_PROVIDER_BODY');
 }finally{log.mockRestore();await l.close();}
});


test('folder companion defaults are JSON arrays across creation, listing, rename and retry',async()=>{
 const c=await companion(),id=crypto.randomUUID(),input={name:'Defaults',companionIds:[c.id]};
 const created=await saveFolder(owner,id,input,true);
 expect(created.companionIds).toEqual([c.id]);
 expect((await listDiscussions(owner)).folders.find((folder:any)=>folder.id===id).companionIds).toEqual([c.id]);
 expect((await saveFolder(owner,id,input,true)).companionIds).toEqual([c.id]);
 expect((await saveFolder(owner,id,{name:'Renamed'})).companionIds).toEqual([c.id]);
});


test('discussion list exposes only current owned participant ids as JSON arrays',async()=>{
 const a=await companion(),b=await companion(),d=await discussion();
 const listed=async()=> (await listDiscussions(owner)).discussions.find((item:any)=>item.id===d.id);
 expect((await listed()).participantIds).toEqual([]);
 await changeParticipant(owner,d.id,a.id);await changeParticipant(owner,d.id,b.id);
 expect((await listed()).participantIds).toEqual([a.id,b.id]);
 await changeParticipant(owner,d.id,a.id,true);
 expect((await listed()).participantIds).toEqual([b.id]);
 await db`UPDATE companions SET retired_at=now() WHERE id=${b.id}`;
 expect((await listed()).participantIds).toEqual([]);
 expect((await listDiscussions('other-user')).discussions.some((item:any)=>item.id===d.id)).toBe(false);
});


test('discussion list previews the newest visible message and stays null while empty',async()=>{
 const c=await companion(),d=await discussion();
 const listed=async()=> (await listDiscussions(owner)).discussions.find((item:any)=>item.id===d.id);
 expect((await listed()).lastMessage).toBeNull();
 await send(d.id,'First question');
 expect((await listed()).lastMessage).toMatchObject({role:'user',companionId:null,preview:'First question'});
 await db`INSERT INTO discussion_messages(id,discussion_id,role,content,companion_id,run_id) VALUES(${crypto.randomUUID()},${d.id},'assistant',${'x'.repeat(400)},${c.id},${crypto.randomUUID()})`;
 const preview=(await listed()).lastMessage;
 expect(preview.companionId).toBe(c.id);
 expect(preview.preview).toHaveLength(160);
 await db`INSERT INTO discussion_messages(id,discussion_id,role,content,run_id) VALUES(${crypto.randomUUID()},${d.id},'system','Housekeeping',${crypto.randomUUID()})`;
 expect((await listed()).lastMessage.companionId).toBe(c.id);
});


test('direct companion replies remain distinct from coordinator delegation in paged snapshots',async()=>{
 const c=await companion(),d=await discussion();
 const direct=await send(d.id,'Direct question',{targetCompanionId:c.id});
 await db`INSERT INTO messages(id,companion_id,run_id,role,content) VALUES(${crypto.randomUUID()},${c.id},${direct.runId},'assistant','Direct reply')`;
 await db.begin(projectDiscussionResults);
 const page=await discussionSnapshot(owner,d.id);
 expect(page.messages.find((m:any)=>m.content==='Direct reply').delegated).toBe(false);
 expect(page.messages.find((m:any)=>m.content==='Direct question').delegated).toBe(false);
});
