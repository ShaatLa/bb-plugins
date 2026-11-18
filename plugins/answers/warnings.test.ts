import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createDriver } from './driver';
import { createNotifier } from './notify';
import { migrations } from './schema';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const f of cleanup.splice(0)) await f();});
const handoff = '[answers] Your last reply hands work to the owner but did not call `answers_report`; call it now so the owner sees it as needing them.';
const question = '[answers] Your last reply asks the owner a question in chat; ask it with `answers_ask` and end the turn.';
function setup() {
 const send=vi.fn(async () => ({ok:true,delivery:'sent'}));
 let events:any[]=[], seq=0;
 const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{get:async ({threadId}) => makeThreadResponse({id:threadId,projectId:'proj_example'}),events:{list:async (a:any) => a.order==='desc' ? [...events].reverse() : events.filter(e => e.seq>Number(a.afterSeq ?? 0))},send}}});
 const db=host.bb.storage.database(); db.exec(migrations.join('\n'));
 const notifier=createNotifier(host.bb,db);
 const driver=createDriver(host.bb,db,() => {},undefined,async () => (await notifier.settings.get()).handoffWarnings);
 cleanup.push(async () => {await driver.dispose(); await notifier.dispose(); await host.harness.lifecycle.dispose();});
 async function turn(text='Ready for your review.',extra:Record<string,unknown>={originPluginId:'example'},tool?:string,old=false) {
  const turnId='turn_example_'+seq, requestId='request_example_'+seq;
  const e=(type:string,data:object) => ({seq:++seq,type,scope:{turnId},createdAt:old ? 1 : Date.now(),data});
  events.push(e('client/turn/requested',{initiator:'user',requestId,input:[{type:'text',text:'Continue'}],...extra}),e('turn/started',{}),e('turn/input/accepted',{clientRequestId:requestId}));
  if(tool) events.push(e('item/completed',{item:{type:'mcpToolCall',tool,command:tool}}));
  if(tool==='answers_report') {await driver.schedule('thr_example'); db.prepare('UPDATE turn_updates SET report=1 WHERE thread_id=? AND turn_id=?').run('thr_example',turnId);}
  events.push(e('item/completed',{item:{type:'agentMessage',text}}),e('turn/completed',{status:'completed'}));
  await driver.schedule('thr_example');
 }
 async function control() {await turn(); expect(send).toHaveBeenCalledExactlyOnceWith({threadId:'thr_example',originPluginId:'answers',mode:'queue-if-active',input:[{type:'text',text:handoff,mentions:[]}]}); send.mockClear();}
 return {...host,db,send,driver,turn,control,notifier};
}
it.each([{originPluginId:'example'}, {senderThreadId:'thr_sender'}, {initiator:'agent',input:[{type:'text',text:'[example] Continue'}]}, {input:[{type:'text',text:'[example] Continue'}]}])('warns once for live handoff trigger %j, including first discovery',async trigger => {
 const s=setup(); await s.turn(undefined,trigger); expect(s.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({input:[{type:'text',text:handoff,mentions:[]}]}));
 s.send.mockClear(); await s.driver.schedule('thr_example'); expect(s.send).not.toHaveBeenCalled();
});
it.each(['answers_report','answers_ask','bb work-board question add EXA-1 --kind check'])('honors explicit handoff channel %s',async tool => {const s=setup(); await s.control(); await s.turn(undefined,undefined,tool); expect(s.send).not.toHaveBeenCalled();});
it.each([{}, {originPluginId:'example'}])('warns about a chat question for trigger %j',async trigger => {const s=setup(); await s.control(); await s.turn('Shall I continue?',trigger); expect(s.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({input:[{type:'text',text:question,mentions:[]}]}));});
it.each(['answers_ask','bb work-board question add EXA-1 --kind decision'])('honors explicit question channel %s',async tool => {const s=setup(); await s.control(); await s.turn('Shall I continue?',undefined,tool); expect(s.send).not.toHaveBeenCalled();});
it.each(['Ready for your review.','Shall I continue?'])('keeps warning replies quiet without looping: %s',async text => {
 const s=setup(); await s.control(); s.db.prepare('UPDATE items SET read_at=1,notify_state=0').run();
 await s.turn(text,{originPluginId:'answers',input:[{type:'text',text:handoff}]});
 expect(s.send).not.toHaveBeenCalled(); expect(s.db.prepare('SELECT count(*) AS n FROM items WHERE read_at IS NULL OR notify_state<>0').get()).toEqual({n:0});
});
it('allows an explicit report from a warning reply',async () => {
 const s=setup(); await s.control(); s.db.prepare('UPDATE items SET read_at=1,notify_state=0').run();
 await s.turn(undefined,{originPluginId:'answers',input:[{type:'text',text:handoff}]},'answers_report');
 expect(s.send).not.toHaveBeenCalled(); expect(s.db.prepare('SELECT count(*) AS n FROM items WHERE read_at IS NULL AND notify_state=1').get()).toEqual({n:1});
});
it.each(['sub-thread','archived','backfill','disabled','owner-handoff'])('does not warn for %s',async mode => {
 const s=setup(); await s.control();
 if(mode==='sub-thread') s.harness.sdk.stub('threads.get',async ({threadId}) => makeThreadResponse({id:threadId,parentThreadId:'thr_parent'}));
 if(mode==='archived') {s.db.prepare('INSERT INTO archived_threads VALUES (?)').run('thr_example'); s.harness.sdk.stub('threads.get',async ({threadId}) => makeThreadResponse({id:threadId,archivedAt:1}));}
 if(mode==='disabled') await s.notifier.settings.experimental_set({handoffWarnings:false});
 await s.turn(undefined,mode==='owner-handoff' ? {} : undefined,undefined,mode==='backfill'); expect(s.send).not.toHaveBeenCalled();
});

it.each([['bb work-board question add EXA-1',true],['example-tracker ask',false],['answers_ask',false]])('uses project channel fragments for %s',async (tool,warn) => {
 const s=setup(); await s.bb.storage.kv.set('config:project:proj_example',{channelCommands:['example-tracker ask']});
 await s.control(); await s.turn('Shall I continue?',undefined,tool);
 expect(s.send.mock.calls.length).toBe(warn ? 1 : 0);
});
