import {mkdirSync,renameSync,writeFileSync} from 'node:fs';
/** One-time project setup: point Composio trigger deliveries at this deployment and store the signing secret without printing it. */
const key=process.env.COMPOSIO_API_KEY?.trim();
const appUrl=process.env.APP_URL?.trim();
if(!key||!appUrl)throw new Error('Set COMPOSIO_API_KEY and APP_URL (the public HTTPS origin Composio can reach).');
const base=(process.env.COMPOSIO_BASE_URL??'https://backend.composio.dev').replace(/\/$/,'');
const webhookUrl=new URL('/api/composio/webhook',appUrl).href;
const body={webhook_url:webhookUrl,enabled_events:['composio.trigger.message','composio.connected_account.expired'],version:'V3'};
const headers={'x-api-key':key,'content-type':'application/json'};
// Composio allows one subscription per project: update it in place when it exists.
const existing=await fetch(`${base}/api/v3.1/webhook_subscriptions?limit=1`,{headers});
if(!existing.ok)throw new Error(`Listing webhook subscriptions failed with HTTP ${existing.status}.`);
const current=((await existing.json()) as any).items?.[0]?.id as string|undefined;
const response=await fetch(current?`${base}/api/v3.1/webhook_subscriptions/${encodeURIComponent(current)}`:`${base}/api/v3.1/webhook_subscriptions`,
 {method:current?'PATCH':'POST',headers,body:JSON.stringify(body)});
if(!response.ok)throw new Error(`Saving the webhook subscription failed with HTTP ${response.status}.`);
const subscription=await response.json() as any;
console.log(`Composio deliveries now go to ${webhookUrl}.`);
if(subscription.secret){
 // Never print the signing secret: terminal and CI output is often retained.
 const file='.local/composio-webhook-secret';
 mkdirSync('.local',{recursive:true,mode:0o700});
 // A fresh owner-only file replaces the destination atomically, so no looser existing file ever holds the secret.
 const temporary=`${file}.${process.pid}.tmp`;writeFileSync(temporary,`${subscription.secret}\n`,{mode:0o600,flag:'wx'});renameSync(temporary,file);
 console.log(`Wrote the signing secret to ${file} (owner-only). Set it as COMPOSIO_WEBHOOK_SECRET on the API service, redeploy, then delete the file.`);
}
else console.log('Composio did not return the signing secret; copy it from the Composio dashboard into COMPOSIO_WEBHOOK_SECRET.');
