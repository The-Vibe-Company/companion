import { afterEach, expect, test } from 'bun:test';
import { pluginTools } from './tools';
import { AgentControl } from '../control/agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachinePlugin } from './catalog';
import { getAnonymousAppDefinition } from './definitions';

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

test('Parallel search and fetch carry the project User-Agent through the Pi MCP client',async()=>{
  const definition=getAnonymousAppDefinition('ai.parallel/mcp')!;
  const requests:Array<{method:string;tool?:string;userAgent:string|null;hasCredentials:boolean}>=[];
  const streams=[Promise.withResolvers<void>(),Promise.withResolvers<void>()];
  let streamCount=0,redirectedRequests=0;
  const source='https://www.iana.org/help/example-domains';
  const results=[{url:source,excerpts:['Example domains are reserved for documentation.']}];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    if(new URL(request.url).pathname==='/redirected'){
      redirectedRequests++;
      return new Response(null,{status:500});
    }
    const headerEvidence={
      userAgent:request.headers.get('user-agent'),
      hasCredentials:['authorization','x-api-key','cookie'].some(header=>request.headers.has(header)),
    };
    if(request.method==='GET'){
      requests.push({method:'GET',...headerEvidence});
      streams[streamCount++]?.resolve();
      return Response.redirect(new URL('/redirected',request.url),307);
    }
    if(request.method!=='POST')return new Response(null,{status:405});
    const message=await request.json() as {id?:number;method:string;params?:{name?:string;arguments?:{objective?:string}}};
    const tool=message.params?.name;
    requests.push({method:message.method,tool,...headerEvidence});
    if(message.id===undefined)return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(message.method==='tools/list')result={tools:['web_search','web_fetch','other_tool'].map(schema)};
    else if(tool==='web_fetch'&&message.params?.arguments?.objective==='Fixture error')result={content:[{type:'text',text:'Rate limit reached'}],isError:true};
    else if(tool==='web_fetch'&&message.params?.arguments?.objective==='Fixture RPC error')return Response.json({
      jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'Provider response to keep out of the agent error'},
    });
    else if(tool==='web_fetch'&&message.params?.arguments?.objective==='Fixture redirect')return Response.redirect(new URL('/redirected',request.url),307);
    else if(tool==='web_search'||tool==='web_fetch')result={content:[{type:'text',text:JSON.stringify({results})}]};
    else return new Response(null,{status:400});
    return Response.json({jsonrpc:'2.0',id:message.id,result});
  }});
  cleanup.push(async()=>{await server.stop(true);});
  const dir=mkdtempSync(join(tmpdir(),'companion-parallel-mcp-'));
  const control=new AgentControl(dir);
  cleanup.push(async()=>{control.close();rmSync(dir,{recursive:true,force:true});});
  const plugin:MachinePlugin={
    id:'parallel-account',name:definition.name,provider:definition.provider,serverId:definition.id,
    ...definition.mcp,url:`http://127.0.0.1:${server.port}/mcp`,allowedTools:[...definition.capabilities.allowedTools],
  };
  const configure=(plugins:MachinePlugin[])=>control.handleRequest(new Request('http://agent/configuration',{
    method:'PUT',body:JSON.stringify({generation:'test',plugins}),
  }));
  const open=()=>control.toolsFactory({runId:crypto.randomUUID()});
  const invoke=(factory:Awaited<ReturnType<typeof open>>,name:string,input:unknown)=>
    factory.tools.find(tool=>tool.name===name)!.execute('request',input,AbortSignal.timeout(5000),undefined,{} as never);
  const call=(factory:Awaited<ReturnType<typeof open>>,tool:string,args:Record<string,unknown>)=>
    invoke(factory,'plugin_call',{connectionId:plugin.id,tool,arguments:args});
  const first=await open();
  try{
    await configure([]);
    await expect(call(first,'web_search',{})).rejects.toThrow('PLUGIN_NOT_SELECTED');
    await configure([plugin]);
    expect(requests).toHaveLength(0);
    const discovered=await invoke(first,'plugin_tools',{connectionId:plugin.id});
    await streams[0]!.promise;
    const catalog=discovered.content[0];
    expect(catalog?.type==='text'&&JSON.parse(catalog.text)).toEqual(['web_search','web_fetch'].map(schema));
    await expect(call(first,'other_tool',{})).rejects.toThrow('PLUGIN_TOOL_NOT_ALLOWED');
    const search=await call(first,'web_search',{objective:'Find the official example domains',search_queries:['IANA example domains']});
    expect(search.content).toEqual([{type:'text',text:JSON.stringify({results})}]);
    const fetched=await call(first,'web_fetch',{urls:[source]});
    expect(fetched).toMatchObject({content:[{type:'text',text:JSON.stringify({results})}],details:{isError:false}});
  }finally{await first.close();}
  const next=await open();
  try{
    // Each run reconnects. Both routes must keep the same identity in the new session.
    await call(next,'web_search',{objective:'Find IANA example domains',search_queries:['IANA example domains']});
    await streams[1]!.promise;
    await expect(call(next,'web_fetch',{urls:[source],objective:'Fixture error'})).rejects.toThrow('PLUGIN_TOOL_FAILED');
    await expect(call(next,'web_fetch',{urls:[source],objective:'Fixture RPC error'})).rejects.toThrow('PLUGIN_REQUEST_FAILED');
    await expect(call(next,'web_fetch',{urls:[source],objective:'Fixture redirect'})).rejects.toThrow('PLUGIN_REQUEST_FAILED');
  }finally{await next.close();}
  expect(requests.filter(request=>request.method==='initialize')).toHaveLength(2);
  expect(requests.filter(request=>request.method==='tools/call').map(request=>request.tool))
    .toEqual(['web_search','web_fetch','web_search','web_fetch','web_fetch','web_fetch']);
  expect(new Set(requests.map(request=>request.userAgent))).toEqual(new Set(['companions.build']));
  expect(requests.some(request=>request.hasCredentials)).toBe(false);
  expect(streamCount).toBe(2);
  expect(redirectedRequests).toBe(0);
});

test('expired App credentials refresh only when the selected account is used',async()=>{
  const fixture=railwayFixture();let plugin={...fixture.plugin,credentialExpiresAt:Date.now()-1};const refreshed:string[]=[];
  const connection=pluginTools(()=>[plugin],{refresh:async id=>{refreshed.push(id);plugin={...plugin,credentialExpiresAt:Date.now()+3600_000};}});cleanup.push(()=>connection.close());
  await execute(connection,0,{});expect(refreshed).toEqual([]);expect(fixture.requests).toBe(0);
  await execute(connection,1,{connectionId:plugin.id,tool:'whoami',arguments:{}});expect(refreshed).toEqual([plugin.id]);expect(fixture.calls).toHaveLength(1);
});

test('Slack bridge pins its endpoint and forwards only its supported message fields',async()=>{
 const originalFetch=globalThis.fetch;const requests:Array<{url:string;body:unknown}>=[];
 globalThis.fetch=(async(input:any,init:any)=>{requests.push({url:String(input),body:JSON.parse(init.body)});return Response.json({ok:true,channel:'C1',ts:'1'});}) as typeof fetch;
 const plugin:MachinePlugin={id:'slack-account',provider:'slack',name:'Slack work',transport:'slack',url:'https://untrusted.example/mcp',headers:{Authorization:'Bearer fixture'}};
 const connection=pluginTools(()=>[plugin]);
 try {
  await expect(execute(connection,1,{connectionId:plugin.id,tool:'delete_message',arguments:{channel:'C1',text:'Hello'}})).rejects.toThrow('PLUGIN_TOOL_NOT_ALLOWED');
  await execute(connection,1,{connectionId:plugin.id,tool:'chat_post_message',arguments:{channel:'C1',text:'Hello',unfurl_links:true,url:'https://untrusted.example'}});
  expect(requests).toEqual([{url:'https://slack.com/api/chat.postMessage',body:{channel:'C1',text:'Hello'}}]);
 }finally{globalThis.fetch=originalFetch;await connection.close();}
});
