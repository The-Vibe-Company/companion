import { afterEach, expect, test } from 'bun:test';
import { pluginTools } from './tools';
import { AgentControl } from '../control/agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachinePlugin } from './catalog';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});
const schema=(name:string)=>({name,annotations:{readOnlyHint:true},inputSchema:{type:'object' as const,properties:{}}});

function fixture(list:(cursor:string|undefined)=>unknown,allowedTools?:string[]) {
  const cursors:Array<string|undefined>=[];
  let calls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    if(request.method!=='POST') return new Response(null,{status:405});
    const message=await request.json() as {id?:number;method:string;params?:{cursor?:string}};
    if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(message.method==='tools/list') {cursors.push(message.params?.cursor);result=list(message.params?.cursor);}
    else if(message.method==='tools/call') {
      calls++;
      // An ambiguous remote failure must not cause plugin_call to retry.
      return new Response(null,{status:503});
    } else return new Response(null,{status:400});
    return Response.json({jsonrpc:'2.0',id:message.id,result});
  }});
  cleanup.push(async()=>{await server.stop(true);});
  const plugin:MachinePlugin={id:'account',name:'Gmail',provider:'gmail',transport:'http',url:`http://127.0.0.1:${server.port}/mcp`,allowedTools};
  const connection=pluginTools(()=>[plugin]);
  cleanup.push(()=>connection.close());
  return {cursors,get calls(){return calls;},
    discover:(signal?:AbortSignal)=>connection.tools[0]!.execute('discover',{connectionId:'account'},signal,undefined,{} as never),
    call:(tool:string)=>connection.tools[1]!.execute('call',{connectionId:'account',tool,arguments:{}},undefined,undefined,{} as never)};
}

test('discovers later pages even when a Gmail allowlist removes the entire first page',async()=>{
  const remote=fixture(cursor=>cursor===undefined
    ? {tools:[schema('send_email')],nextCursor:'second'}
    : {tools:[schema('read_email'),schema('delete_email')]},['read_email']);
  const result=await remote.discover();
  expect(JSON.parse((result.content[0] as any).text)).toEqual([schema('read_email')]);
  expect(remote.cursors).toEqual([undefined,'second']);
  await expect(remote.call('delete_email')).rejects.toThrow('PLUGIN_TOOL_NOT_ALLOWED');
  expect(remote.calls).toBe(0);
});

test('follows opaque empty cursors and returns each tool once',async()=>{
  const remote=fixture(cursor=>cursor===undefined
    ? {tools:[schema('one')],nextCursor:''}
    : {tools:[schema('one'),schema('two')]});
  const result=await remote.discover();
  expect(JSON.parse((result.content[0] as any).text)).toEqual([schema('one'),schema('two')]);
  expect(remote.cursors).toEqual([undefined,'']);
});

test('rejects repeated cursors instead of hanging or returning an incomplete catalog',async()=>{
  const remote=fixture(()=>({tools:[schema('one')],nextCursor:'repeat'}));
  await expect(remote.discover()).rejects.toThrow('PLUGIN_CATALOG_PAGINATION_FAILED');
  expect(remote.cursors).toEqual([undefined,'repeat']);
});

test('bounds providers that produce endlessly unique cursors',async()=>{
  let page=0;
  const remote=fixture(()=>({tools:[],nextCursor:String(++page)}));
  await expect(remote.discover()).rejects.toThrow('PLUGIN_CATALOG_PAGINATION_FAILED');
  expect(remote.cursors).toHaveLength(100);
});

test('never retries an ambiguous tool call failure',async()=>{
  const remote=fixture(()=>({tools:[schema('read_email')]}));
  await remote.discover();
  await expect(remote.call('read_email')).rejects.toThrow();
  expect(remote.calls).toBe(1);
});

function railwayFixture(beforeList?:()=>void) {
  const calls:Array<unknown>=[];let requests=0;
  const tools=[schema('whoami'),schema('list-projects'),schema('list-services'),{...schema('redeploy'),annotations:{destructiveHint:true,readOnlyHint:true,title:'Redeploy service'}},{...schema('railway-agent'),annotations:{destructiveHint:true,openWorldHint:true}},schema('create-project'),schema('accept-deploy'),schema('list-feature-flags'),{name:'create_workspace',inputSchema:{type:'object' as const,properties:{}}}];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    requests++;if(request.method!=='POST')return new Response(null,{status:405});
    const message=await request.json() as any;if(message.id===undefined)return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Railway fixture',version:'1'}};
    else if(message.method==='tools/list'){beforeList?.();result=message.params?.cursor?{tools:tools.slice(3)}:{tools:tools.slice(0,3),nextCursor:'next'};}
    else if(message.method==='tools/call'){calls.push(message.params);result={content:[{type:'text',text:'done'}]};}
    else return new Response(null,{status:400});
    return Response.json({jsonrpc:'2.0',id:message.id,result});
  }});
  cleanup.push(async()=>{await server.stop(true);});
  const plugin:MachinePlugin={id:'railway-account',name:'Production workspace',provider:'railway',transport:'http',url:`http://127.0.0.1:${server.port}/mcp`};
  return {plugin,tools,calls,get requests(){return requests;}};
}
const execute=(connection:ReturnType<typeof pluginTools>,index:number,input:unknown)=>connection.tools[index]!.execute('request',input,undefined,undefined,{} as never);

test('Railway lists every paginated tool including railway-agent and connects only on use',async()=>{
  const fixture=railwayFixture(),connection=pluginTools(()=>[fixture.plugin]);cleanup.push(()=>connection.close());
  const accounts=await execute(connection,0,{});expect(JSON.stringify(accounts)).toContain('Production workspace');expect(fixture.requests).toBe(0);
  const result=await execute(connection,0,{connectionId:fixture.plugin.id});
  expect(JSON.parse((result.content[0] as any).text)).toEqual(fixture.tools);
  await execute(connection,1,{connectionId:fixture.plugin.id,tool:'whoami',arguments:{}});expect(fixture.calls).toHaveLength(1);
});

test('MCP calls execute directly regardless of destructive, contradictory or missing annotations',async()=>{
  const fixture=railwayFixture(),connection=pluginTools(()=>[fixture.plugin]);cleanup.push(()=>connection.close());
  for(const tool of ['whoami','redeploy','railway-agent','create_workspace']) {
    const args={projectId:'project-1',options:{force:true},brief:'x'.repeat(21_000)};
    const result=await execute(connection,1,{connectionId:fixture.plugin.id,tool,arguments:args});
    expect(result.content).toEqual([{type:'text',text:'done'}]);
    expect(fixture.calls.at(-1)).toEqual({name:tool,arguments:args});
  }
  expect(fixture.calls).toHaveLength(4);
});

test('direct calls preserve original arguments across asynchronous discovery',async()=>{
  const args={projectId:'project-1',options:{force:true}};
  const fixture=railwayFixture(()=>{args.options.force=false;});
  const connection=pluginTools(()=>[fixture.plugin]);cleanup.push(()=>connection.close());
  await execute(connection,1,{connectionId:fixture.plugin.id,tool:'railway-agent',arguments:args});
  expect(args.options.force).toBe(false);
  expect(fixture.calls).toEqual([{name:'railway-agent',arguments:{projectId:'project-1',options:{force:true}}}]);
});

for(const change of ['detach','reconfigure','cancel'] as const) {
  test(`direct calls stop before dispatch on ${change} during discovery`,async()=>{
    const controller=new AbortController();let selected:MachinePlugin[]=[];
    const fixture=railwayFixture(()=>{
      if(change==='detach')selected=[];
      if(change==='reconfigure')selected=[{...fixture.plugin,name:'Changed account'}];
      if(change==='cancel')controller.abort();
    });
    selected=[fixture.plugin];
    const connection=pluginTools(()=>selected);cleanup.push(()=>connection.close());
    await expect(connection.tools[1]!.execute('request',{connectionId:fixture.plugin.id,tool:'redeploy',arguments:{}},controller.signal,undefined,{} as never)).rejects.toThrow();
    expect(fixture.calls).toHaveLength(0);
  });
}

test('Pi control calls Conductor create_workspace without queuing an approval request',async()=>{
  const fixture=railwayFixture(),dir=mkdtempSync(join(tmpdir(),'companion-direct-mcp-'));
  const control=new AgentControl(dir);
  cleanup.push(async()=>{control.close();rmSync(dir,{recursive:true,force:true});});
  await control.handleRequest(new Request('http://agent/configuration',{method:'PUT',body:JSON.stringify({generation:'1',plugins:[{...fixture.plugin,provider:'conductor'}]})}));
  const factory=await control.toolsFactory({runId:crypto.randomUUID()});cleanup.push(()=>factory.close());
  const result=await factory.tools.find(tool=>tool.name==='plugin_call')!.execute('create',{connectionId:fixture.plugin.id,tool:'create_workspace',arguments:{name:'Fix MCP calls'}},AbortSignal.timeout(5000),undefined,{} as never);
  expect(result.content).toEqual([{type:'text',text:'done'}]);
  expect(fixture.calls).toEqual([{name:'create_workspace',arguments:{name:'Fix MCP calls'}}]);
  const queued=await control.handleRequest(new Request('http://agent/control'));
  expect((await queued!.json() as any).requests).toEqual([]);
});

test('expired App credentials refresh only when the selected account is used',async()=>{
  const fixture=railwayFixture();let plugin={...fixture.plugin,credentialExpiresAt:Date.now()-1};const refreshed:string[]=[];
  const connection=pluginTools(()=>[plugin],{refresh:async id=>{refreshed.push(id);plugin={...plugin,credentialExpiresAt:Date.now()+3600_000};}});cleanup.push(()=>connection.close());
  await execute(connection,0,{});expect(refreshed).toEqual([]);expect(fixture.requests).toBe(0);
  await execute(connection,1,{connectionId:plugin.id,tool:'whoami',arguments:{}});expect(refreshed).toEqual([plugin.id]);expect(fixture.calls).toHaveLength(1);
});

test('Composio connections discover and call through the server, never an MCP endpoint',async()=>{
  const listed:Array<[string,string|undefined]>=[],called:unknown[]=[];
  const plugin:MachinePlugin={id:'composio-account',provider:'composio',name:'Work Gmail',transport:'composio',toolkit:'gmail'};
  const connection=pluginTools(()=>[plugin],{composio:{
    async tools(id,search){listed.push([id,search]);return [{name:'GMAIL_FETCH_EMAILS',description:'Fetch',inputSchema:{type:'object'}}];},
    async call(id,tool,args){called.push({id,tool,args});return {content:[{type:'text',text:'{"messages":[]}'}],isError:false};},
  }});cleanup.push(()=>connection.close());
  expect(JSON.parse(((await execute(connection,0,{})).content[0] as any).text)).toEqual([{id:'composio-account',name:'Work Gmail',provider:'composio',toolkit:'gmail'}]);
  expect(JSON.parse(((await execute(connection,0,{connectionId:plugin.id,search:'send email'})).content[0] as any).text)).toEqual([{name:'GMAIL_FETCH_EMAILS',description:'Fetch',inputSchema:{type:'object'}}]);
  expect(listed).toEqual([['composio-account','send email']]);
  const result=await execute(connection,1,{connectionId:plugin.id,tool:'GMAIL_FETCH_EMAILS',arguments:{max_results:3}});
  expect(result.content).toEqual([{type:'text',text:'{"messages":[]}'}]);
  expect(called).toEqual([{id:'composio-account',tool:'GMAIL_FETCH_EMAILS',args:{max_results:3}}]);
  await expect(execute(pluginTools(()=>[plugin]),1,{connectionId:plugin.id,tool:'GMAIL_FETCH_EMAILS',arguments:{}})).rejects.toThrow('PLUGIN_CONNECTION_FAILED');
});

test('git-only connections serve credentials but are never listed or callable as tools',async()=>{
  const git:MachinePlugin={id:'git-account',provider:'github',name:'GitHub (git access)',transport:'http',url:'https://api.githubcopilot.com/mcp/',headers:{Authorization:'Bearer private'},capabilities:{gitCredentials:true}};
  const connection=pluginTools(()=>[git]);cleanup.push(()=>connection.close());
  expect(JSON.parse(((await execute(connection,0,{})).content[0] as any).text)).toEqual([]);
  await expect(execute(connection,1,{connectionId:git.id,tool:'get_me',arguments:{}})).rejects.toThrow('PLUGIN_NOT_SELECTED');
});
