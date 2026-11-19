import {beforeAll,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {handler} from '../src/api';
import {applyControl} from '../src/control';
import {productHooks} from '../src/runtime-product';
import {attachPlugin,machinePlugins,addCustomPlugin,checkPluginAccount,handlePlugins,listPluginAccounts,newPluginAccountLabel,pluginCallbackLocation,pluginConnectionAvailable,renamePluginAccount,startPluginConnection} from '../src/plugins';
import {decrypt,encrypt} from '../src/config';
import {CompanionPluginOAuthRevokedError,type CompanionPluginStoredOAuthCredential} from '../../../packages/plugins/oauth';

const owner='00000000-0000-4000-8000-000000000001';
beforeAll(async()=>{await migrate();});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

test('catalog availability is truthful for deployment-configured and dynamic OAuth',async()=>{
 expect(pluginConnectionAvailable('app.linear/linear',{})).toBe(true);
 expect(pluginConnectionAvailable('io.github.github/github-mcp-server',{})).toBe(false);
 expect(pluginConnectionAvailable('io.github.github/github-mcp-server',{COMPANION_MCP_GITHUB_CLIENT_ID:'id',COMPANION_MCP_GITHUB_CLIENT_SECRET:'secret'})).toBe(true);
 await expect(startPluginConnection(owner,'io.github.github/github-mcp-server','GitHub',{})).rejects.toThrow('unavailable in this deployment');
});

test('Parallel requires an explicit owner connection and a per-Companion grant',async()=>{
 const serverId='ai.parallel/mcp';
 const request=()=>new Request('http://local/api/plugins/connect',{method:'POST',body:JSON.stringify({serverId})});
 const catalog=await handlePlugins(new Request('http://local/api/plugins'),owner);
 const {catalog:apps}=await catalog!.json();
 expect(apps.find((app:{id:string})=>app.id===serverId)).toMatchObject({kind:'remote',available:true,provider:'parallel'});
 expect((await handler(request())).status).toBe(401);
 await expect(startPluginConnection(owner,serverId,'',{})).rejects.toThrow('Connect Parallel Search in Applications.');

 const connections=await Promise.all(Array.from({length:4},()=>handlePlugins(request(),owner)));
 expect(connections.map(response=>response!.status).sort()).toEqual([200,200,200,201]);
 const [{account},...retries]=await Promise.all(connections.map(response=>response!.json()));
 expect(retries.map(retry=>retry.account.id)).toEqual(Array(3).fill(account.id));
 expect(account).toMatchObject({serverId,provider:'parallel',label:'Default',healthStatus:'unchecked'});
 const [stored]=await db`SELECT credential_secret FROM plugin_accounts WHERE id=${account.id}`;
 expect(JSON.parse(decrypt(stored.credential_secret))).toEqual({kind:'anonymous'});

 const companion=await createCompanion(owner,{name:'Parallel research',provider:'local'});
 const runId=await acceptMessage(owner,companion.id,crypto.randomUUID(),'Search public documentation');
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${runId}`;
 const selectFromAgent=(accountId:string)=>applyControl(companion.id,{
  id:crypto.randomUUID(),runId,operation:'plugin_select',input:{accountId,enabled:true},
 });
 const checkFromAgent=()=>applyControl(companion.id,{
  id:crypto.randomUUID(),runId,operation:'plugin_check',input:{accountId:account.id},
 });
 expect(await selectFromAgent(account.id)).toMatchObject({error:expect.stringContaining('grant this connection')});
 expect(await machinePlugins(companion.id)).toEqual([]);
 await expect(attachPlugin(crypto.randomUUID(),companion.id,account.id,true)).rejects.toThrow('not found');
 let healthRequests=0;
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  expect(String(input)).toBe('https://mcp.parallel.ai/mcp');
  expect(new Headers(init?.headers).get('user-agent')).toBe('companions.build');
  healthRequests++;
  return new Response(null,{status:503});
 }) as typeof fetch;
 try{
  expect(await checkFromAgent()).toEqual({account:null});
  expect(healthRequests).toBe(0);
  await attachPlugin(owner,companion.id,account.id,true);
  expect(await checkFromAgent()).toMatchObject({account:{healthStatus:'error',healthCode:'connection_failed'}});
  expect(healthRequests).toBe(1);
 }finally{globalThis.fetch=originalFetch;}
 const [plugin]=await machinePlugins(companion.id,{async refresh(){throw Error('Unexpected OAuth refresh');}});
 expect(plugin).toEqual({
  id:account.id,name:'Default',provider:'parallel',serverId,transport:'http',url:'https://mcp.parallel.ai/mcp',
  headers:{'User-Agent':'companions.build'},redirect:'error',allowedTools:['web_search','web_fetch'],
 });
 expect(await checkPluginAccount(owner,account.id,{async check(projected){expect(projected).toEqual(plugin);}})).toMatchObject({healthStatus:'ok'});
 expect(await checkPluginAccount(owner,account.id,{async check(){throw Error('provider failure');}})).toMatchObject({healthStatus:'error',healthCode:'connection_failed'});
 await attachPlugin(owner,companion.id,account.id,false);
 expect(await machinePlugins(companion.id)).toEqual([]);
 const custom=await addCustomPlugin(owner,{label:'Existing custom route',url:'https://example.com/mcp'});
 expect(await selectFromAgent(custom.id)).toEqual({ok:true});
 expect((await machinePlugins(companion.id)).map(item=>item.id)).toEqual([custom.id]);
});

test('the first provider account is Default and later accounts require a chosen name',async()=>{
 const ownerId=crypto.randomUUID(),serverId='app.linear/linear';
 expect(await newPluginAccountLabel(ownerId,serverId,'Ignored first name')).toBe('Default');
 const account=await addCustomPlugin(ownerId,{label:'unrelated custom account',transport:'http',url:'https://example.com/mcp'});
 await db`UPDATE plugin_accounts SET provider='linear',server_id=${serverId} WHERE id=${account.id}`;
 await expect(newPluginAccountLabel(ownerId,serverId,'')).rejects.toThrow('Name this account');
 await expect(newPluginAccountLabel(ownerId,serverId,' '.repeat(2))).rejects.toThrow('Name this account');
 await expect(newPluginAccountLabel(ownerId,serverId,'x'.repeat(81))).rejects.toThrow('Name this account');
 expect(await newPluginAccountLabel(ownerId,serverId,'  Client workspace  ')).toBe('Client workspace');
 expect(await newPluginAccountLabel(ownerId,'io.sentry/mcp','')).toBe('Default');
});

test('account rename is owner-scoped and updates the public label only',async()=>{
 const ownerId=crypto.randomUUID(),other=crypto.randomUUID();
 const account=await addCustomPlugin(ownerId,{label:'Default',transport:'http',url:'https://example.com/mcp'});
 const renamed=await renamePluginAccount(ownerId,account.id,'  Client workspace  ');
 expect(renamed).toMatchObject({id:account.id,label:'Client workspace',provider:'custom'});
 expect(await renamePluginAccount(other,account.id,'Stolen')).toBeNull();
 expect((await listPluginAccounts(ownerId))[0].label).toBe('Client workspace');
 await expect(renamePluginAccount(ownerId,account.id,' ')).rejects.toThrow('between 1 and 80');
 const foreign=await handlePlugins(new Request(`http://local/api/plugins/${account.id}`,{method:'PATCH',body:JSON.stringify({label:'Stolen'})}),other);
 expect(foreign?.status).toBe(404);
 expect((await listPluginAccounts(ownerId))[0].label).toBe('Client workspace');
});

test('OAuth cancellation consumes only its owner state and stale callbacks return a safe connection route',async()=>{
 const state=crypto.randomUUID()+crypto.randomUUID(),other=crypto.randomUUID();
 await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${other},'Other',${other+'@example.test'},true)`;
 await db`INSERT INTO plugin_oauth_flows(state_hash,owner_id,label,flow_secret,expires_at) VALUES(${digest(state)},${owner},'Linear','unused',now()+interval '10 minutes')`;
 const crossOwner=await handlePlugins(new Request(`http://local/api/plugins/callback?state=${state}&error=access_denied`),other);
 expect(crossOwner?.status).toBe(303);expect(crossOwner?.headers.get('location')).toBe(pluginCallbackLocation('error'));
 expect((await db`SELECT consumed_at FROM plugin_oauth_flows WHERE state_hash=${digest(state)}`)[0].consumed_at).toBeNull();
 const cancelled=await handlePlugins(new Request(`http://local/api/plugins/callback?state=${state}&error=access_denied`),owner);
 expect(cancelled?.headers.get('location')).toBe(pluginCallbackLocation('cancelled'));
 expect((await db`SELECT consumed_at FROM plugin_oauth_flows WHERE state_hash=${digest(state)}`)[0].consumed_at).not.toBeNull();
 const replay=await handlePlugins(new Request(`http://local/api/plugins/callback?state=${state}&error=access_denied`),owner);
 expect(replay?.headers.get('location')).toBe(pluginCallbackLocation('error'));
});

function oauthCredential(expiresAt:string|null=new Date(Date.now()+3600_000).toISOString()):CompanionPluginStoredOAuthCredential{return{
 kind:'oauth',version:1,serverName:'app.linear/linear',accessToken:'private-access',refreshToken:'private-refresh',accessExpiresAt:expiresAt,scope:'read write',tokenType:'Bearer',
 tokenEndpoint:'https://mcp.linear.app/token',resource:'https://mcp.linear.app/mcp',client:{clientId:'client',clientSecret:null,tokenEndpointAuthMethod:'none'},
};}
async function oauthAccount(ownerId=owner,credential=oauthCredential()){
 const id=crypto.randomUUID();await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,server_id,credential_secret) VALUES(${id},${ownerId},'linear','Linear','app.linear/linear',${encrypt(JSON.stringify(credential))})`;return id;
}

test('owned OAuth health performs discovery only and persists a secret-free projection',async()=>{
 const id=await oauthAccount();const checkedAt=new Date('2026-09-07T12:00:00.000Z');let calls=0;
 const result=await checkPluginAccount(owner,id,{now:()=>checkedAt,async check(plugin){calls++;expect(plugin).toMatchObject({id,provider:'linear',transport:'http',url:'https://mcp.linear.app/mcp'});expect(plugin.headers?.Authorization).toBe('Bearer private-access');}});
 expect(calls).toBe(1);expect(result).toEqual({id,healthStatus:'ok',healthCode:null,checkedAt});
 const listed=(await listPluginAccounts(owner)).find((account:any)=>account.id===id);
 expect(listed).toMatchObject({healthStatus:'ok',healthCode:null});expect(new Date(listed.checkedAt).toISOString()).toBe(checkedAt.toISOString());expect(JSON.stringify(listed)).not.toContain('private-access');
});

test('expired OAuth refreshes before discovery and a revoked grant asks for authorization without raw errors',async()=>{
 const refreshedId=await oauthAccount(owner,oauthCredential(new Date(Date.now()-60_000).toISOString()));let discovered='';
 const refreshed=await checkPluginAccount(owner,refreshedId,{async refresh({credential}){return{...credential,accessToken:'rotated-private',accessExpiresAt:new Date(Date.now()+3600_000).toISOString()};},async check(plugin){discovered=plugin.headers?.Authorization??'';}});
 expect(refreshed).toMatchObject({healthStatus:'ok',healthCode:null});expect(discovered).toBe('Bearer rotated-private');
 const [stored]=await db`SELECT credential_secret FROM plugin_accounts WHERE id=${refreshedId}`;expect(decrypt(stored.credential_secret)).toContain('rotated-private');

 const revokedId=await oauthAccount(owner,oauthCredential(new Date(Date.now()-60_000).toISOString()));
 const revoked=await checkPluginAccount(owner,revokedId,{async refresh(){throw new CompanionPluginOAuthRevokedError();},async check(){throw Error('must not discover');}});
 expect(revoked).toMatchObject({healthStatus:'error',healthCode:'authorization_required'});expect(JSON.stringify(revoked)).not.toContain('private');
});

test('connection failures are expurgated, cross-owner checks do nothing, and custom MCP stays agent-only',async()=>{
 const id=await oauthAccount();let checks=0;
 const failed=await checkPluginAccount(owner,id,{async check(){checks++;throw Error('provider raw token private-access');}});
 expect(failed).toMatchObject({healthStatus:'error',healthCode:'connection_failed'});expect(JSON.stringify(failed)).not.toContain('provider raw');
 expect(await checkPluginAccount(crypto.randomUUID(),id,{async check(){checks++;}})).toBeNull();expect(checks).toBe(1);

 const custom=await addCustomPlugin(owner,{label:'Local private',transport:'stdio',command:'/usr/bin/private-mcp',env:{TOKEN:'private'}});
 const endpoint=await handlePlugins(new Request(`http://local/api/plugins/accounts/${custom.id}/check`,{method:'POST'}),owner);
 expect(endpoint?.status).toBe(200);expect(await endpoint?.json()).toMatchObject({account:{id:custom.id,healthStatus:'requires_agent',healthCode:'agent_check_required'}});
});


test('a later provider refresh failure preserves an earlier rotated grant and still fails closed',async()=>{
 const companion=await createCompanion(owner,{name:'Refresh isolation',provider:'local'});
 const expired=oauthCredential(new Date(Date.now()-60_000).toISOString());
 const accounts=[await oauthAccount(owner,expired),await oauthAccount(owner,expired)].sort();
 for(const id of accounts)await attachPlugin(owner,companion.id,id,true);
 let attempts=0;
 await expect(machinePlugins(companion.id,{async refresh({credential}){
  attempts++;
  if(attempts===2)throw new CompanionPluginOAuthRevokedError();
  return {...credential,accessToken:'rotated-access',refreshToken:'rotated-refresh',accessExpiresAt:new Date(Date.now()+3600_000).toISOString()};
 }})).rejects.toThrow('revoked');
 expect(attempts).toBe(2);
 const rows=await db`SELECT id,credential_secret FROM plugin_accounts WHERE id IN ${db(accounts)} ORDER BY id`;
 expect(JSON.parse(decrypt(rows[0].credential_secret))).toMatchObject({accessToken:'rotated-access',refreshToken:'rotated-refresh'});
 expect(JSON.parse(decrypt(rows[1].credential_secret))).toMatchObject({accessToken:'private-access',refreshToken:'private-refresh'});
 let retried=0;
 const projected=await machinePlugins(companion.id,{async refresh({credential}){
  retried++;expect(credential.refreshToken).toBe('private-refresh');
  return {...credential,accessToken:'recovered-access',accessExpiresAt:new Date(Date.now()+3600_000).toISOString()};
 }});
 expect(retried).toBe(1);
 expect(projected.map(plugin=>plugin.headers?.Authorization)).toEqual(['Bearer rotated-access','Bearer recovered-access']);
});

test('active configuration publishes current grants even when an OAuth refresh fails',async()=>{
 const companion=await createCompanion(owner,{name:'Current app grants',provider:'local'});
 const connected=await handlePlugins(new Request('http://local/api/plugins/connect',{
  method:'POST',body:JSON.stringify({serverId:'ai.parallel/mcp'}),
 }),owner);
 const {account:parallel}=await connected!.json();
 const custom=await addCustomPlugin(owner,{label:'Still selected',url:'https://example.com/mcp'});
 const githubId=crypto.randomUUID(),serverId='io.github.github/github-mcp-server';
 const expired={...oauthCredential(new Date(0).toISOString()),serverName:serverId,refreshToken:null};
 await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,server_id,credential_secret)
  VALUES(${githubId},${owner},'github','GitHub',${serverId},${encrypt(JSON.stringify(expired))})`;
 for(const id of [parallel.id,custom.id,githubId])await attachPlugin(owner,companion.id,id,true);
 await attachPlugin(owner,companion.id,parallel.id,false);

 const updates:Array<{plugins:Array<{id:string}>}>=[],paths:string[]=[];
 const runId=crypto.randomUUID(),outbox=`/files/outbox?runId=${runId}`;
 await productHooks.observeRun!({companion_id:companion.id,id:runId},companion.id,'test',{
  async assertActive(){},
  async checkpoint(body){return body(db);},
  async requestAgent(_endpoint,_token,path,method,body){
   paths.push(path);
   if(path==='/control')return {generation:'previous',requests:[]};
   if(path===outbox)return {files:[]};
   expect([path,method]).toEqual(['/configuration','PUT']);
   updates.push(body as (typeof updates)[number]);
   return {};
  },
 });
 expect(updates.map(update=>update.plugins.map(plugin=>plugin.id))).toEqual([[custom.id]]);
 expect(paths).toEqual(['/control','/configuration',outbox]);
});


test('account cards list only owned active companion grants and follow revocation',async()=>{
 const ownerId=crypto.randomUUID(),other=crypto.randomUUID();
 for (const id of [ownerId,other]) await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'Test owner',${id+'@example.test'},true)`;
 const account=await addCustomPlugin(ownerId,{label:'Card tools',transport:'http',url:'https://example.com/mcp'});
 const nova=await createCompanion(ownerId,{name:'Nova',provider:'local',avatar:{shape:1,color:2,face:0}});
 const retired=await createCompanion(ownerId,{name:'Retired',provider:'local'});
 const foreign=await createCompanion(other,{name:'Foreign',provider:'local'});
 await attachPlugin(ownerId,nova.id,account.id,true);
 await attachPlugin(ownerId,retired.id,account.id,true);
 await db`UPDATE companions SET retired_at=now() WHERE id=${retired.id}`;
 // Even an inconsistent cross-owner grant must not expose another owner's companion.
 await db`INSERT INTO companion_plugins VALUES (${foreign.id},${account.id})`;
 const [listed]=await listPluginAccounts(ownerId);
 expect(listed.usedBy).toEqual([{id:nova.id,name:'Nova',avatar:{shape:1,color:2,face:0}}]);
 expect(await listPluginAccounts(other)).toEqual([]);
 await attachPlugin(ownerId,nova.id,account.id,false);
 expect((await listPluginAccounts(ownerId))[0].usedBy).toEqual([]);
});

test('labelled Railway accounts attach independently and unused OAuth accounts do not refresh',async()=>{
 const first=await createCompanion(owner,{name:'Railway first',instructions:'',provider:'local'}),second=await createCompanion(owner,{name:'Railway second',instructions:'',provider:'local'});
 const ids:string[]=[];
 for(const label of ['Production','Sandbox']){
  const id=crypto.randomUUID();ids.push(id);
  const credential={...oauthCredential(new Date(0).toISOString()),serverName:'com.railway/mcp',resource:'https://mcp.railway.com',tokenEndpoint:'https://backboard.railway.com/token'};
  await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,server_id,credential_secret) VALUES(${id},${owner},'railway',${label},'com.railway/mcp',${encrypt(JSON.stringify(credential))})`;
 }
 await attachPlugin(owner,first.id,ids[0]!,true);await attachPlugin(owner,first.id,ids[1]!,true);await attachPlugin(owner,second.id,ids[1]!,true);
 let refreshes=0;const refresh=async({credential}:{credential:CompanionPluginStoredOAuthCredential})=>{refreshes++;return {...credential,accessToken:'rotated',accessExpiresAt:new Date(Date.now()+3600_000).toISOString()};};
 const lazy=await machinePlugins(first.id,{refreshCredentials:false,refresh});expect(refreshes).toBe(0);
 expect(lazy.map(p=>p.name).sort()).toEqual(['Production','Sandbox']);expect(lazy.every(p=>p.url==='https://mcp.railway.com'&&!p.allowedTools)).toBe(true);
 await machinePlugins(first.id,{accountId:ids[0],refresh});expect(refreshes).toBe(1);
 const [unrefreshed]=await db`SELECT credential_secret FROM plugin_accounts WHERE id=${ids[1]!}`;expect(JSON.parse(decrypt(unrefreshed.credential_secret)).accessToken).toBe('private-access');
 await attachPlugin(owner,first.id,ids[1]!,false);
 expect((await machinePlugins(first.id,{refreshCredentials:false})).map(p=>p.id)).toEqual([ids[0]!]);
 expect((await machinePlugins(second.id,{refreshCredentials:false})).map(p=>p.id)).toEqual([ids[1]!]);
});
