import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {createHash} from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { pluginTools } from '../plugins/tools';
import type { MachinePlugin } from '../plugins/catalog';
import {GitCredentialBroker} from './git-credentials';
import {AgentSkills,type SkillMutationCheckpoint} from './skills';

const localSkillOperations=['skills','skill_install','skill_update','skill_remove'] as const;
const operations=['discussion_history','request_help','history_search','identity','companion_create','models','configure','companions','plugins','plugin_select','plugin_catalog','plugin_connect','plugin_custom','plugin_check','plugin_disconnect','delegate','task_status','task_answer','task_cancel','deliveries','delivery_prepare','maintenance','maintenance_inspect','maintenance_configure','maintenance_prepare','maintenance_task','maintenance_history','ask_user','app_refresh','composio_tools','composio_call','triggers','trigger_types','trigger_save','trigger_delete','prepare','desktop_takeover','desktop_release',...localSkillOperations] as const;
export type ControlOperation=typeof operations[number];
/** Durable local MCP outbox. The executor visits Box; Box need not reach a local web server. */
export class AgentControl {
  private readonly db:Database;
  private plugins:MachinePlugin[]=[];
  private generation='';
  readonly gitCredentials:GitCredentialBroker;
  constructor(stateDir:string,private readonly skills=new AgentSkills(stateDir),private readonly afterLocalSkillControl?:()=>void) {
    mkdirSync(stateDir,{recursive:true});
    this.db=new Database(join(stateDir,'control.sqlite'));
    this.gitCredentials=new GitCredentialBroker(stateDir);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,operation TEXT NOT NULL,input TEXT NOT NULL,result TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,operation TEXT NOT NULL,input TEXT NOT NULL,result TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
      UPDATE requests SET status='interrupted',result='{"error":"Agent restarted; this request was not replayed."}' WHERE status='pending';`);
  }
  async handleRequest(request:Request):Promise<Response|null> {
    const url=new URL(request.url);
    if(url.pathname==='/configuration'&&request.method==='PUT') {
      const body=await request.json() as any;
      if(!Array.isArray(body.plugins)||body.plugins.length>30||typeof body.generation!=='string') return Response.json({error:'INVALID_CONFIGURATION'},{status:400});
      this.plugins=body.plugins;this.gitCredentials.update(this.plugins);this.generation=body.generation;return Response.json({generation:this.generation});
    }
    if(url.pathname==='/control'&&request.method==='GET') return Response.json({generation:this.generation,requests:this.db.query(`SELECT id,run_id AS runId,operation,input FROM requests WHERE status='pending' ORDER BY created_at LIMIT 20`).all().map((r:any)=>({...r,input:JSON.parse(r.input)}))});
    const match=url.pathname.match(/^\/control\/([a-f0-9-]+)\/result$/);
    if(match&&request.method==='POST') {
      const result=await request.json();
      if(JSON.stringify(result).length>100_000) return Response.json({error:'RESULT_TOO_LARGE'},{status:400});
      this.db.query(`UPDATE requests SET result=?,status='resolved' WHERE id=? AND status='pending'`).run(JSON.stringify(result),match[1]);
      return Response.json({ok:true});
    }
    return null;
  }
  async call(runId:string,operation:ControlOperation,input:unknown,signal?:AbortSignal) {
    if(operation==='skills')return this.skills.control('skills',input);
    if((localSkillOperations as readonly string[]).includes(operation))return this.callLocalSkill(runId,operation as Exclude<typeof localSkillOperations[number],'skills'>,input);
    const id=crypto.randomUUID();
    this.db.query('INSERT INTO requests(id,run_id,operation,input,created_at) VALUES(?,?,?,?,?)').run(id,runId,operation,JSON.stringify(input),Date.now());
    const deadline=Date.now()+((operation==='ask_user')?2*3600_000:120_000);
    while(Date.now()<deadline&&!signal?.aborted) {
      const row=this.db.query('SELECT status,result FROM requests WHERE id=?').get(id) as any;
      if(row.status!=='pending') {
        const result=JSON.parse(row.result);
        if(operation==='identity'&&Array.isArray(result?.operations)){
          result.operations=[...new Set([...result.operations,...localSkillOperations])];
          result.examples={...result.examples,skills:{},skill_install:{clientOperationId:'UUID',skill:{name:'writer',files:[{path:'SKILL.md',data:'base64',sha256:'lowercase SHA-256'}]}},skill_update:{clientOperationId:'UUID',expectedHash:'hash returned by skills',skill:{name:'writer',files:[{path:'SKILL.md',data:'base64',sha256:'lowercase SHA-256'}]}},skill_remove:{clientOperationId:'UUID',name:'writer',expectedHash:'hash returned by skills'}};
          result.instructions=`${result.instructions??''} Manage local Pi skills with skills, skill_install, skill_update and skill_remove; keep clientOperationId stable when retrying a mutation.`.trim();
        }
        return result;
      }
      await Bun.sleep(150);
    }
    this.db.query(`UPDATE requests SET status='interrupted',result='{"error":"Control request timed out; inspect its state before retrying."}' WHERE id=? AND status='pending'`).run(id);
    throw new Error(signal?.aborted?'CONTROL_CANCELLED':'CONTROL_TIMEOUT');
  }
  private callLocalSkill(runId:string,operation:'skill_install'|'skill_update'|'skill_remove',input:unknown){
    const id=typeof input==='object'&&input!==null&&'clientOperationId' in input?(input as any).clientOperationId:null;
    if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))return {error:'INVALID_SKILL_OPERATION'};
    const serialized=JSON.stringify(input),fingerprint=createHash('sha256').update(serialized).digest('hex');
    const checkpoint=operation==='skill_remove'?null:this.skills.mutationCheckpoint(operation,input);
    const storedInput=JSON.stringify({fingerprint,checkpoint});
    const created=this.db.query('INSERT INTO local_requests(id,run_id,operation,input,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(id,runId,operation,storedInput,Date.now());
    const row=this.db.query('SELECT run_id AS runId,operation,input,result,status FROM local_requests WHERE id=?').get(id) as any;
    const prior=localRequestInput(row?.input,fingerprint);
    if(!row||row.runId!==runId||row.operation!==operation||!prior)return {error:'SKILL_OPERATION_CONFLICT'};
    if(!created.changes&&row.status==='done')return JSON.parse(row.result);
    const result=!created.changes&&operation!=='skill_remove'&&prior.checkpoint
      ?this.skills.reconcileMutation(operation,input,prior.checkpoint)
      :this.skills.control(operation,input);
    this.afterLocalSkillControl?.();
    this.db.query("UPDATE local_requests SET result=?,status='done' WHERE id=? AND status='pending'").run(JSON.stringify(result),id);
    // Retain a bounded recent idempotency window. Removal has its own independent
    // 500-entry filesystem journal so a SQLite cleanup cannot delete a reinstallation.
    this.db.exec("DELETE FROM local_requests WHERE id IN (SELECT id FROM local_requests WHERE status='done' ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 500)");
    return result;
  }
  async toolsFactory({runId}:{runId:string}) {
    const server=new McpServer({name:'companion-control',version:'0.2.0'});
    server.registerTool('companion_control',{description:'Configure companions.build and delegate work. Read identity first for available operations and their inputs.',inputSchema:{operation:z.enum(operations),input:z.record(z.string(),z.unknown()).default({})}},async({operation,input},extra)=>({content:[{type:'text',text:JSON.stringify(await this.call(runId,operation,input,extra.signal))}]}));
    const client=new Client({name:'companion-agent',version:'0.2.0'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
    const plugins=pluginTools(()=>this.plugins,{
      refresh:async(connectionId,signal)=>{const result=await this.call(runId,'app_refresh',{connectionId},signal);if(result?.refreshed!==true)throw Error('PLUGIN_REFRESH_FAILED');},
      composio:{
        tools:async(connectionId,search,signal)=>{const result=await this.call(runId,'composio_tools',{connectionId,...(search?{search}:{})},signal);if(!Array.isArray(result?.tools))throw Error(result?.error??'PLUGIN_CONNECTION_FAILED');return result.tools;},
        call:async(connectionId,tool,args,signal)=>{const result=await this.call(runId,'composio_call',{connectionId,tool,arguments:args},signal);if(!Array.isArray(result?.content))throw Error(result?.error??'PLUGIN_CALL_FAILED');return result;},
      },
    });
    const tool:ToolDefinition={name:'companion_control',label:'Companion control',description:'Use the companion-control MCP to configure this product: identity, skills, instructions, plugins, delegation and delivery. Call identity with empty input to discover schemas. Never claim a configuration changed before this tool confirms it.',parameters:Type.Object({operation:Type.Union(operations.map(x=>Type.Literal(x))),input:Type.Record(Type.String(),Type.Unknown())}),async execute(_id,params,signal){
      const result=await client.callTool({name:'companion_control',arguments:params as Record<string,unknown>},undefined,{signal,timeout:(params as any).operation==='ask_user'?2*3600_000+5000:125_000});
      return {content:result.content as any,details:{}};
    }};
    return {tools:[tool,...plugins.tools],async close(){await plugins.close();await client.close();await server.close();}};
  }
  close(){this.gitCredentials.close();this.db.close();}
}

function localRequestInput(raw:unknown,fingerprint:string):{checkpoint:SkillMutationCheckpoint|null}|null{
  // The scalar form was written briefly by the first release. It has no recoverable checkpoint,
  // but accepting it preserves completed request compatibility across an agent upgrade.
  if(raw===fingerprint)return {checkpoint:null};
  if(typeof raw!=='string')return null;
  try{
    const value=JSON.parse(raw);
    if(value?.fingerprint!==fingerprint)return null;
    const checkpoint=value.checkpoint;
    if(checkpoint===null)return {checkpoint:null};
    if(typeof checkpoint?.name!=='string'||(checkpoint.currentHash!==null&&typeof checkpoint.currentHash!=='string')||typeof checkpoint.targetHash!=='string'||typeof checkpoint.bundleHash!=='string')return null;
    return {checkpoint};
  }catch{return null;}
}
