import {recordCompletedUsage} from './usage';
import {migrateForService} from './store';
import {progressDeliveryInvites} from './delivery';
import {purgeTriggerEvents} from './composio-triggers';
await migrateForService();
console.log('Worker ready');
let lastUsage=0;
let lastDeliveries=0;
let lastTriggerPurge=0;
let triggerPurge:Promise<unknown>|null=null;
let deliveryWork:Promise<unknown>|null=null;
for(;;){
 try{if(Date.now()-lastUsage>30_000){await recordCompletedUsage();lastUsage=Date.now();}if(!triggerPurge&&Date.now()-lastTriggerPurge>60_000){lastTriggerPurge=Date.now();triggerPurge=purgeTriggerEvents().catch(()=>console.error('trigger_event_purge_failed')).finally(()=>{triggerPurge=null;});}if(!deliveryWork&&Date.now()-lastDeliveries>5_000){lastDeliveries=Date.now();deliveryWork=progressDeliveryInvites().catch(()=>console.error('delivery_progress_failed')).finally(()=>{deliveryWork=null;});}await Bun.sleep(500);}
 catch{console.error('worker_progress_failed');await Bun.sleep(1000);}
}
