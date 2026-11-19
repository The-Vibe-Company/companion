import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MachinePlugin } from './catalog';

export function httpPluginTransport(plugin:MachinePlugin) {
  return new StreamableHTTPClientTransport(new URL(plugin.url!),{
    requestInit:{headers:plugin.headers},
    // The SDK's SSE GET requests don't include requestInit.
    fetch:plugin.redirect==='error'?(input,init)=>fetch(input,{...init,redirect:'error'}):undefined,
  });
}
