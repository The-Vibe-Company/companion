import {ComposioError,type ComposioGateway,type ComposioTriggerInstance} from '../../src/composio';

/** In-memory Composio project: records every remote effect so tests can assert none is duplicated. */
export function fakeComposio(){
 const accounts=new Map<string,{id:string;status:string;userId:string;toolkit:string;authConfigId:string}>();
 const triggers=new Map<string,ComposioTriggerInstance&{userId:string}>();
 const log:Array<[string,...unknown[]]>=[];
 // Composio ids are project-global; tests share one database, so never reuse them.
 const nextId=()=>crypto.randomUUID().slice(0,8);
 const failures=new Set<string>();
 const fail=(operation:string)=>{if(failures.has(operation)){failures.delete(operation);throw new ComposioError(503,operation);}};
 const gateway:ComposioGateway={
  async listToolkits({search}){return {items:[{slug:'gmail',name:'Gmail',description:'Email',logo:'https://logos/gmail.png',available:true}].filter(item=>!search||item.slug.includes(search)),nextCursor:null};},
  async getToolkit(slug){
   if(slug==='missing')throw new ComposioError(404,'toolkit');
   return {slug,name:slug[0]!.toUpperCase()+slug.slice(1),description:`${slug} app`,logo:`https://logos/${slug}.png`,available:slug!=='customonly'};
  },
  async authConfigFor(toolkit){return `ac_${toolkit}`;},
  async link(userId,authConfigId,callbackUrl){
   const id=`ca_${nextId()}`;log.push(['link',userId,authConfigId,callbackUrl]);
   accounts.set(id,{id,status:'INITIATED',userId,toolkit:authConfigId.slice(3),authConfigId});
   return {connectedAccountId:id,redirectUrl:`https://connect.composio.dev/link/${id}`};
  },
  async getAccount(id){const account=accounts.get(id);if(!account)throw new ComposioError(404,'account');return {...account};},
  async deleteAccount(id){fail('account_delete');log.push(['deleteAccount',id]);accounts.delete(id);},
  async listTools(toolkit,search){log.push(['listTools',toolkit,search]);return [{slug:`${toolkit.toUpperCase()}_LIST`,name:'List',description:'List things',inputSchema:{type:'object',properties:{}},toolkit,version:'20260901_00'}];},
  async getTool(slug){
   const toolkit=slug.split('_')[0]!.toLowerCase();
   if(slug.endsWith('_MISSING'))throw new ComposioError(404,'tool');
   return {slug,name:slug,description:'',inputSchema:{},toolkit,version:'20260901_00'};
  },
  async execute(slug,input){log.push(['execute',slug,input]);return {successful:true,data:{ok:true,slug},error:null};},
  async listTriggerTypes(toolkit){return [{slug:`${toolkit.toUpperCase()}_NEW_EVENT`,name:'New event',description:'Fires on new events',instructions:'',type:'webhook',config:{type:'object',properties:{repo:{type:'string'}},required:['repo']},toolkit}];},
  async getTriggerType(slug){
   if(slug.endsWith('_UNKNOWN'))throw new ComposioError(404,'trigger_type');
   const toolkit=slug.split('_')[0]!.toLowerCase();
   return {slug,name:'New event',description:'',instructions:'',type:'webhook',config:{type:'object',properties:{repo:{type:'string'}},required:['repo']},toolkit};
  },
  async createTrigger(userId,slug,input){
   fail('trigger_create');
   const id=`ti_${nextId()}`;log.push(['createTrigger',userId,slug,input]);
   triggers.set(id,{id,userId,connectedAccountId:input.connectedAccountId,triggerName:slug,triggerConfig:input.triggerConfig,disabledAt:null});
   return {triggerId:id};
  },
  async listActiveTriggers({connectedAccountIds,triggerNames}){
   return [...triggers.values()].filter(t=>connectedAccountIds.includes(t.connectedAccountId)&&(!triggerNames||triggerNames.includes(t.triggerName))).map(({userId:_,...t})=>t);
  },
  async setTriggerEnabled(id,enabled){log.push(['setTriggerEnabled',id,enabled]);const t=triggers.get(id);if(t)t.disabledAt=enabled?null:new Date().toISOString();},
  async deleteTrigger(id){fail('trigger_delete');log.push(['deleteTrigger',id]);triggers.delete(id);},
 };
 return {gateway,accounts,triggers,log,failNext:(operation:string)=>failures.add(operation),
  /** Simulates the member finishing Composio's hosted consent page. */
  activate(id:string){accounts.get(id)!.status='ACTIVE';}};
}
