import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MachinePlugin } from './catalog';

type RemoteTool=Awaited<ReturnType<Client['listTools']>>['tools'][number];
export type ServerTool={name:string;description?:string;inputSchema:Record<string,unknown>};
export interface AppToolOptions {
  refresh?:(connectionId:string,signal?:AbortSignal)=>Promise<void>;
  /** Composio tools run on the server, which alone holds the Composio key. */
  composio?:{
    tools(connectionId:string,search:string|undefined,signal?:AbortSignal):Promise<ServerTool[]>;
    call(connectionId:string,tool:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<{content:Array<{type:'text';text:string}>;isError:boolean}>;
  };
}
/** Connections and credential refresh happen on first use, never while listing accounts. */
export function pluginTools(getPlugins:()=>MachinePlugin[],options:AppToolOptions={}) {
  const clients=new Map<string,Promise<Client>>();
  // Git-only connections serve the credential broker, never agent tools.
  const visible=()=>getPlugins().filter(p=>!p.capabilities?.gitCredentials);
  const selected=(id:string)=>{const plugin=visible().find(p=>p.id===id);if(!plugin)throw Error('PLUGIN_NOT_SELECTED');return plugin;};
  async function ready(id:string,signal?:AbortSignal) {
    let plugin=selected(id);
    if(plugin.credentialExpiresAt!==undefined&&plugin.credentialExpiresAt<Date.now()+60_000) {
      if(!options.refresh)throw Error('PLUGIN_REFRESH_REQUIRED');
      await options.refresh(id,signal);plugin=selected(id);
      if(plugin.credentialExpiresAt!==undefined&&plugin.credentialExpiresAt<Date.now()+60_000)throw Error('PLUGIN_REFRESH_FAILED');
    }
    return plugin;
  }
  async function client(plugin:MachinePlugin) {
    const key=JSON.stringify(plugin);
    let pending=clients.get(key);
    if(!pending) {
      pending=(async()=>{
        const c=new Client({name:'companions.build',version:'0.2.0'});
        const transport=plugin.transport==='stdio'
          ? new StdioClientTransport({command:plugin.command!,args:plugin.args??[],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME??'/home/user',...plugin.env},stderr:'ignore'})
          : new StreamableHTTPClientTransport(new URL(plugin.url!),{requestInit:{headers:plugin.headers}});
        try {await c.connect(transport,{timeout:15_000});return c;}catch{await c.close();throw new Error('PLUGIN_CONNECTION_FAILED');}
      })();clients.set(key,pending);pending.catch(()=>clients.delete(key));
    }
    return pending;
  }
  async function discover(plugin:MachinePlugin,signal?:AbortSignal,search?:string):Promise<Array<RemoteTool|ServerTool>> {
    if(plugin.transport==='composio'){
      if(!options.composio)throw Error('PLUGIN_CONNECTION_FAILED');
      return (await options.composio.tools(plugin.id,search,signal)).filter(tool=>!plugin.allowedTools||plugin.allowedTools.includes(tool.name));
    }
    const bounded=AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(30_000)]);
    const c=await client(plugin),discovered=new Map<string,RemoteTool>(),cursors=new Set<string>();
    let cursor:string|undefined;
    for(let page=0;page<100;page++) {
      const catalog=await c.listTools(cursor===undefined?undefined:{cursor},{signal:bounded,timeout:15_000});
      for(const tool of catalog.tools)if(!plugin.allowedTools||plugin.allowedTools.includes(tool.name))discovered.set(tool.name,tool);
      if(catalog.nextCursor===undefined)return [...discovered.values()];
      if(cursors.has(catalog.nextCursor))throw Error('PLUGIN_CATALOG_PAGINATION_FAILED');
      cursors.add(catalog.nextCursor);cursor=catalog.nextCursor;
    }
    throw Error('PLUGIN_CATALOG_PAGINATION_FAILED');
  }
  const tools:ToolDefinition[]=[{
    name:'plugin_tools',label:'Connected tools',description:'List connected Apps; pass a connection ID to discover its tools, schemas and annotations. Connections are independent accounts. Composio connections list their main tools; pass search (for example "create issue") to find others.',
    parameters:Type.Object({connectionId:Type.Optional(Type.String()),search:Type.Optional(Type.String())}),
    async execute(_id,raw,signal) {
      const input=z.object({connectionId:z.string().optional(),search:z.string().trim().min(1).max(200).optional()}).parse(raw);
      if(!input.connectionId)return text(visible().map(p=>({id:p.id,name:p.name,provider:p.provider,...(p.toolkit?{toolkit:p.toolkit}:{})})));
      return text(await discover(await ready(input.connectionId,signal),signal,input.search));
    },
  },{
    name:'plugin_call',label:'Use connected tool',description:'Call a tool discovered with plugin_tools. Calls execute directly without an additional approval step. Respect the user’s authority before sending messages or publishing changes.',
    parameters:Type.Object({connectionId:Type.String(),tool:Type.String(),arguments:Type.Record(Type.String(),Type.Unknown())}),
    async execute(_id,raw,signal) {
      // Own the argument snapshot across asynchronous discovery.
      const input=z.object({connectionId:z.string(),tool:z.string(),arguments:z.record(z.string(),z.unknown())}).parse(JSON.parse(JSON.stringify(raw)));
      const plugin=await ready(input.connectionId,signal),snapshot=JSON.stringify(plugin);
      if(plugin.allowedTools&&!plugin.allowedTools.includes(input.tool))throw Error('PLUGIN_TOOL_NOT_ALLOWED');
      if(plugin.transport==='composio'){
        // The server checks that the tool belongs to this connection's toolkit before executing it.
        if(!options.composio)throw Error('PLUGIN_CONNECTION_FAILED');
        const result=await options.composio.call(plugin.id,input.tool,input.arguments,signal);
        return {content:result.content,details:{isError:result.isError}};
      }
      const tool=(await discover(plugin,signal)).find(t=>t.name===input.tool);
      if(!tool)throw Error('PLUGIN_TOOL_NOT_ALLOWED');
      signal?.throwIfAborted();
      if(JSON.stringify(selected(plugin.id))!==snapshot)throw Error('PLUGIN_CONFIGURATION_CHANGED');
      const result=await (await client(plugin)).callTool({name:input.tool,arguments:input.arguments},undefined,{signal,timeout:60_000});
      const content=(result.content as any[]).filter(c=>c.type==='text'||c.type==='image');
      return {content:content.length?content:[{type:'text' as const,text:JSON.stringify(result.structuredContent??{})}],details:{isError:!!result.isError}};
    },
  }];
  return {tools,async close(){await Promise.all([...clients.values()].map(async p=>{await(await p.catch(()=>null))?.close();}));}};
}
function text(value:unknown) {return {content:[{type:'text' as const,text:JSON.stringify(value)}],details:{}};}
