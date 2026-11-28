import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createDriver } from './driver';
import { migrations } from './schema';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const f of cleanup.splice(0)) await f();});
// The text Agent Hub used to queue for a question asked in chat; a turn it started may still arrive.
const oldWarning = '[agent-hub] Your last reply asks the owner a question in chat. Call `agent_hub_ask` now with that question (add options and recommended if you have them), then end the turn without waiting; the answer arrives as a new message.';
function setup() {
 const send=vi.fn(async () => ({ok:true,delivery:'sent'}));
 let events:any[]=[], seq=0;
 const host=createFakePluginHost({pluginId:'agent-hub',sdk:{threads:{get:async ({threadId}) => makeThreadResponse({id:threadId,projectId:'proj_example'}),events:{list:async (a:any) => a.order==='desc' ? [...events].reverse() : events.filter(e => e.seq>Number(a.afterSeq ?? 0))},send}}});
 const db=host.bb.storage.database(); db.exec(migrations.join('\n'));
 const driver=createDriver(host.bb,db,() => {});
 cleanup.push(async () => {await driver.dispose(); await host.harness.lifecycle.dispose();});
 async function turn(text:string,extra:Record<string,unknown>={originPluginId:'example'}) {
  const turnId='turn_example_'+seq, requestId='request_example_'+seq;
  const e=(type:string,data:object) => ({seq:++seq,type,scope:{kind:'turn',turnId},createdAt:Date.now(),data});
  events.push(e('client/turn/requested',{initiator:'user',requestId,input:[{type:'text',text:'Continue'}],...extra}),e('turn/started',{}),e('turn/input/accepted',{clientRequestId:requestId}));
  events.push(e('item/completed',{item:{type:'agentMessage',text}}),e('turn/completed',{status:'completed'}));
  await driver.schedule('thr_example');
 }
 return {db,send,turn};
}
// Agent Hub no longer queues nudges to agents: they were guessed from the reply's text and waited in the owner's queue.
it.each(['Ready for your review.','EXA-1 awaits your decision.','Deploy done, nothing needed from you.','Shall I continue?'])('sends the agent no message after a reply: %s',async text => {
 const s=setup(); await s.turn(text); await s.turn(text,{}); expect(s.send).not.toHaveBeenCalled();
});
it('still files a question asked in chat for the owner',async () => {
 const s=setup(); await s.turn('Shall I continue?');
 expect(s.db.prepare("SELECT question,chat_asked FROM items WHERE kind='for_me' AND status='open'").all()).toEqual([{question:'Shall I continue?',chat_asked:1}]);
});
it.each(['agent-hub','answers'])('keeps a reply to a warning queued earlier by %s quiet',async origin => {
 const s=setup(); await s.turn('Ready for your review.'); s.db.prepare('UPDATE items SET read_at=1,notify_state=0').run();
 await s.turn('Shall I continue?',{originPluginId:origin,input:[{type:'text',text:oldWarning.replace('[agent-hub]',`[${origin}]`)}]});
 expect(s.db.prepare('SELECT count(*) AS n FROM items WHERE read_at IS NULL OR notify_state<>0').get()).toEqual({n:0});
 expect(s.db.prepare("SELECT count(*) AS n FROM items WHERE kind='for_me'").get()).toEqual({n:0});
});
