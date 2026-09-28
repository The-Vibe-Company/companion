import {beforeAll,beforeEach,expect,test} from 'bun:test';
import {db,migrate,createCompanion,acceptMessage} from '../src/store';
import {attachPlugin,checkPluginAccount,disconnectPlugin,handlePlugins,listPluginAccounts,machinePlugins,pluginCallbackLocation,startPluginConnection} from '../src/plugins';
import {setComposioGateway,composioUserId} from '../src/composio';
import {applyControl} from '../src/control';
import '../src/runtime-product';
import {fakeComposio} from './fixtures/composio-fake';

const owner='00000000-0000-4000-8000-000000000001';
let fake=fakeComposio();
beforeAll(async()=>{process.env.COMPOSIO_API_KEY='test-key';await migrate();});
beforeEach(()=>{fake=fakeComposio();setComposioGateway(fake.gateway);});
const stateOf=(callbackUrl:string)=>new URL(callbackUrl).searchParams.get('state')!;
async function user(){const id=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'Member',${id+'@example.test'},true)`;return id;}
async function connect(ownerId=owner,toolkit='gmail',label=''){
 const {url}=await startPluginConnection(ownerId,`composio:${toolkit}`,label);
 const [,userId,,callbackUrl]=fake.log.findLast(entry=>entry[0]==='link') as [string,string,string,string];
 expect(userId).toBe(composioUserId(ownerId));
 return {url,state:stateOf(callbackUrl),connectedAccountId:url.split('/').pop()!};
}
const callback=(state:string,ownerId=owner,extra='')=>handlePlugins(new Request(`http://local/api/plugins/callback?state=${state}${extra}`),ownerId);

test('a Composio consent becomes an owned account only after Composio confirms it is active',async()=>{
 const ownerId=await user();
 const pending=await connect(ownerId);
 expect(pending.url).toStartWith('https://connect.composio.dev/link/');
 // The redirect alone proves nothing: an unfinished consent is rejected and the state is spent.
 expect((await callback(pending.state,ownerId))?.headers.get('location')).toBe(pluginCallbackLocation('error'));
 expect(await listPluginAccounts(ownerId)).toEqual([]);

 const done=await connect(ownerId,'gmail','Work');fake.activate(done.connectedAccountId);
 expect((await callback(done.state,ownerId,'&status=success'))?.headers.get('location')).toBe(pluginCallbackLocation('connected'));
 const [account]=await listPluginAccounts(ownerId);
 expect(account).toMatchObject({provider:'composio',serverId:'composio:gmail',appName:'Gmail',appLogo:'https://logos/gmail.png',healthStatus:'ok'});
 expect(JSON.stringify(account)).not.toContain(done.connectedAccountId);
 // Replaying the callback cannot mint a second account.
 expect((await callback(done.state,ownerId))?.headers.get('location')).toBe(pluginCallbackLocation('error'));
 expect(await listPluginAccounts(ownerId)).toHaveLength(1);
});

test('callbacks are owner-scoped and cannot adopt another user or toolkit grant',async()=>{
 const ownerId=await user(),other=await user();
 const pending=await connect(ownerId);fake.activate(pending.connectedAccountId);
 expect((await callback(pending.state,other))?.headers.get('location')).toBe(pluginCallbackLocation('error'));
 expect(await listPluginAccounts(other)).toEqual([]);
 const swapped=await connect(ownerId,'slack');fake.activate(swapped.connectedAccountId);
 fake.accounts.get(swapped.connectedAccountId)!.userId=composioUserId(other);
 expect((await callback(swapped.state,ownerId))?.headers.get('location')).toBe(pluginCallbackLocation('error'));
 const cancelled=await connect(ownerId,'notion');
 expect((await callback(cancelled.state,ownerId,'&status=failed'))?.headers.get('location')).toBe(pluginCallbackLocation('cancelled'));
 expect(await listPluginAccounts(ownerId)).toEqual([]);
});

test('unknown toolkits and toolkits without managed auth are refused before any link is created',async()=>{
 await expect(startPluginConnection(owner,'composio:missing','')).rejects.toThrow('Choose an available App.');
 await expect(startPluginConnection(owner,'composio:Bad Slug','')).rejects.toThrow('Choose an available App.');
 await expect(startPluginConnection(owner,'composio:customonly','')).rejects.toThrow('auth config');
 expect(fake.log.filter(entry=>entry[0]==='link')).toEqual([]);
});

async function connected(ownerId:string,toolkit='gmail'){
 const pending=await connect(ownerId,toolkit,toolkit);fake.activate(pending.connectedAccountId);await callback(pending.state,ownerId);
 const accounts=await listPluginAccounts(ownerId);
 return {id:accounts.find((account:any)=>account.serverId===`composio:${toolkit}`)!.id as string,connectedAccountId:pending.connectedAccountId};
}

test('health follows Composio status and disconnect removes the remote grant before the row',async()=>{
 const ownerId=await user();const account=await connected(ownerId);
 fake.accounts.get(account.connectedAccountId)!.status='EXPIRED';
 expect(await checkPluginAccount(ownerId,account.id)).toMatchObject({healthStatus:'error',healthCode:'authorization_required'});
 fake.accounts.get(account.connectedAccountId)!.status='ACTIVE';
 expect(await checkPluginAccount(ownerId,account.id)).toMatchObject({healthStatus:'ok',healthCode:null});
 fake.failNext('account_delete');
 await expect(disconnectPlugin(ownerId,account.id)).rejects.toThrow('could not be removed');
 expect(await listPluginAccounts(ownerId)).toHaveLength(1);
 await disconnectPlugin(ownerId,account.id);
 expect(fake.accounts.has(account.connectedAccountId)).toBe(false);
 expect(await listPluginAccounts(ownerId)).toEqual([]);
});

test('the agent receives a credential-free projection and Composio calls stay pinned to the selected account',async()=>{
 const gmail=await connected(owner,'gmail'),github=await connected(owner,'github');
 const companion=await createCompanion(owner,{name:'Composio caller',provider:'local'});
 await attachPlugin(owner,companion.id,gmail.id,true);
 const projected=await machinePlugins(companion.id);
 expect(projected).toEqual([{id:gmail.id,name:'Default',provider:'composio',serverId:'composio:gmail',transport:'composio',toolkit:'gmail'}]);
 expect(JSON.stringify(projected)).not.toContain(gmail.connectedAccountId);

 const runId=await acceptMessage(owner,companion.id,crypto.randomUUID(),'Read my mail');
 await db`UPDATE runs SET status='running',dispatched=true WHERE id=${runId}`;
 const control=(operation:string,input:Record<string,unknown>,id:string=crypto.randomUUID())=>applyControl(companion.id,{id,runId,operation,input}) as Promise<any>;
 expect((await control('composio_tools',{connectionId:gmail.id})).tools).toEqual([{name:'GMAIL_LIST',description:'List things',inputSchema:{type:'object',properties:{}}}]);
 expect(await control('composio_tools',{connectionId:github.id})).toEqual({error:'This connection is not selected for this Companion.'});
 expect(await control('composio_call',{connectionId:gmail.id,tool:'GITHUB_DELETE_REPO',arguments:{}})).toEqual({error:'This tool does not belong to this connection.'});
 expect(fake.log.filter(entry=>entry[0]==='execute')).toEqual([]);

 const commandId=crypto.randomUUID();
 expect(await control('composio_call',{connectionId:gmail.id,tool:'GMAIL_LIST',arguments:{max:3}},commandId)).toEqual({content:[{type:'text',text:'{"ok":true,"slug":"GMAIL_LIST"}'}],isError:false});
 expect(fake.log.filter(entry=>entry[0]==='execute')).toEqual([['execute','GMAIL_LIST',{userId:composioUserId(owner),connectedAccountId:gmail.connectedAccountId,version:'20260901_00',arguments:{max:3}}]]);
 // A redelivered command returns the recorded result instead of executing the side effect twice.
 await control('composio_call',{connectionId:gmail.id,tool:'GMAIL_LIST',arguments:{max:3}},commandId);
 expect(fake.log.filter(entry=>entry[0]==='execute')).toHaveLength(1);
});

test('toolkit search and the featured catalog never expose the Composio key',async()=>{
 const response=await handlePlugins(new Request('http://local/api/plugins/toolkits?search=gm'),owner);
 expect(await response!.json()).toEqual({items:[{id:'composio:gmail',provider:'composio',kind:'composio',toolkit:'gmail',name:'Gmail',description:'Email',logo:'https://logos/gmail.png',available:true}],nextCursor:null});
 const catalog=await (await handlePlugins(new Request('http://local/api/plugins'),owner))!.json() as any;
 expect(catalog.catalog.find((entry:any)=>entry.id==='composio:gmail')).toMatchObject({kind:'composio',available:true});
 expect(catalog.catalog.find((entry:any)=>entry.kind==='native')).toMatchObject({id:'io.github.github/github-mcp-server',name:'GitHub (git access)'});
 expect(JSON.stringify(catalog)).not.toContain('test-key');
});

test('the migration removes retired curated grants but keeps git, custom and Composio accounts',async()=>{
 const ownerId=await user();
 for(const provider of ['linear','slack','github','custom','composio'])
  await db`INSERT INTO plugin_accounts(id,owner_id,provider,label,credential_secret) VALUES(${crypto.randomUUID()},${ownerId},${provider},${provider},'x')`;
 await db.unsafe(await Bun.file(new URL('../src/composio.sql',import.meta.url)).text());
 expect((await db`SELECT provider FROM plugin_accounts WHERE owner_id=${ownerId} ORDER BY provider`).map((row:any)=>row.provider)).toEqual(['composio','custom','github']);
});

test('the REST client pins Composio endpoints, sends the key only as a header and never surfaces response bodies',async()=>{
 const {createComposioGateway,ComposioError}=await import('../src/composio');
 const requests:Array<{url:string;method:string;headers:Record<string,string>;body:any}>=[];
 const responses:Response[]=[
  Response.json({connected_account_id:'ca_1',redirect_url:'https://connect.composio.dev/link/lk_1',link_token:'lk_1',expires_at:'2026-09-28T11:00:00Z'},{status:201}),
  Response.json({items:[{id:'ti_1',connected_account_id:'ca_1',trigger_name:'GITHUB_COMMIT_EVENT',trigger_config:{owner:'acme'},disabled_at:null}]}),
  Response.json({error:{message:'token=secret-provider-detail'}},{status:400}),
 ];
 const gateway=createComposioGateway({COMPOSIO_API_KEY:'project-key'},(async(input:any,init:any)=>{
  requests.push({url:String(input),method:init.method,headers:init.headers,body:init.body&&JSON.parse(init.body)});return responses.shift()!;
 }) as typeof fetch);
 expect(await gateway.link('companions:owner','ac_gmail','https://app/api/plugins/callback?state=s')).toEqual({connectedAccountId:'ca_1',redirectUrl:'https://connect.composio.dev/link/lk_1'});
 expect(await gateway.listActiveTriggers({connectedAccountIds:['ca_1','ca_2'],triggerNames:['GITHUB_COMMIT_EVENT']})).toEqual([{id:'ti_1',connectedAccountId:'ca_1',triggerName:'GITHUB_COMMIT_EVENT',triggerConfig:{owner:'acme'},disabledAt:null}]);
 const failure=await gateway.execute('GMAIL_SEND',{userId:'u',connectedAccountId:'ca_1',version:'v',arguments:{}}).catch(error=>error);
 expect(failure).toBeInstanceOf(ComposioError);expect(String(failure.message)).not.toContain('secret-provider-detail');
 expect(requests[0]).toMatchObject({url:'https://backend.composio.dev/api/v3.1/connected_accounts/link',method:'POST',headers:{'x-api-key':'project-key'},body:{auth_config_id:'ac_gmail',user_id:'companions:owner',callback_url:'https://app/api/plugins/callback?state=s'}});
 expect(requests[1]!.url).toBe('https://backend.composio.dev/api/v3.1/trigger_instances/active?connected_account_ids=ca_1%2Cca_2&trigger_names=GITHUB_COMMIT_EVENT&show_disabled=true&limit=100');
 expect(requests[2]).toMatchObject({url:'https://backend.composio.dev/api/v3.1/tools/execute/GMAIL_SEND',body:{user_id:'u',connected_account_id:'ca_1',version:'v',arguments:{}}});
 expect(requests.every(request=>!request.url.includes('project-key'))).toBe(true);
 await expect(createComposioGateway({}).getToolkit('gmail')).rejects.toThrow('not configured');
});
