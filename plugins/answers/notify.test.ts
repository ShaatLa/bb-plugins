import {afterEach,it,expect,vi} from 'vitest';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {z} from 'zod';
import {migrations} from './schema';
import {createNotifier} from './notify';
import plugin from './server';
const active: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of active.splice(0))await dispose();vi.useRealTimers();});
const pushInput=z.object({title:z.string().min(1).max(4000),body:z.string().max(4000).optional(),threadId:z.string().optional()}).strict();
function setup(settings:Record<string,string>={}){
 const sent:unknown[]=[];
 const host=createFakePluginHost({pluginId:'answers',settings,sdk:{threads:{list:async()=>[makeThreadResponse({id:'t',title:'Thread title'}),makeThreadResponse({id:'u',title:'Second thread'})]},plugins:{callRpc:async({input})=>{sent.push(pushInput.parse(input));return {channels:['desktop']};}}}});
 const db=host.bb.storage.database();host.bb.storage.migrate(db,migrations);const notifier=createNotifier(host.bb,db);active.push(async()=>{await notifier.dispose();await host.harness.lifecycle.dispose();});
 const insert=(id:string,thread='t',kind='for_me',question='Question?')=>db.prepare("INSERT INTO items(id,kind,thread_id,status,question,answer,notify_state,created_at,updated_at) VALUES (?,?,?,?,?,'answer',1,1,1)").run(id,kind,thread,kind==='mine'?'answered':'open',question);
 return {host,db,notifier,insert,sent};
}
it('claims all pending rows once and coalesces across threads',async()=>{vi.useFakeTimers();const h=setup({notify:'all'});await Promise.resolve();h.insert('ans_a');h.insert('ans_b','u');await Promise.all([h.notifier.run(),h.notifier.run()]);expect(h.db.prepare('SELECT count(*) n FROM items WHERE notify_state=1').get()).toEqual({n:0});await vi.advanceTimersByTimeAsync(10000);expect(h.sent).toHaveLength(1);expect(h.sent[0]).toMatchObject({title:'2 new in Answers'});});
it('rechecks attention and truncates long body through strict push schema',async()=>{vi.useFakeTimers();const h=setup({notify:'all'});await Promise.resolve();h.insert('ans_a','t','mine');h.db.prepare('UPDATE items SET answer=? WHERE id=?').run('x'.repeat(20000),'ans_a');await h.notifier.run();await vi.advanceTimersByTimeAsync(10000);expect((h.sent[0] as {body:string}).body).toHaveLength(180);h.insert('ans_b');await h.notifier.run();h.db.prepare('UPDATE items SET read_at=1 WHERE id=?').run('ans_b');await vi.advanceTimersByTimeAsync(10000);expect(h.sent).toHaveLength(1);});
it('off consumes without backlog and settings validate quiet hours',async()=>{vi.useFakeTimers();const h=setup({notify:'off'});await Promise.resolve();h.insert('ans_a');await h.notifier.run();await h.host.harness.behavior.setSettings({notify:'all'});await vi.advanceTimersByTimeAsync(10000);expect(h.sent).toHaveLength(0);for(const quietHours of ['24:00-01:00','12:60-13:00','12:00-12:00'])await expect(h.host.harness.behavior.setSettings({quietHours})).rejects.toThrow();});
it('digest reports full totals and uses answered timestamp',async()=>{const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{list:async()=>[]},projects:{list:async()=>[]}}});plugin(host.bb);active.push(()=>host.harness.lifecycle.dispose());const db=host.bb.storage.database();for(let i=0;i<22;i++)db.prepare("INSERT INTO items(id,kind,thread_id,status,question,answer,answered_at,created_at,updated_at) VALUES (?,'mine','t','answered','old?','new',?,1,1)").run('ans_'+i,Date.now());db.prepare("UPDATE items SET answered_at=1,pinned=1 WHERE id='ans_0'").run();const result=await host.harness.behavior.runCli(['digest','--json']);const data=JSON.parse(result.stdout);expect(data.newAnswers.total).toBe(21);expect(data.newAnswers.items).toHaveLength(20);expect((await host.harness.behavior.runCli(['digest','--since','bad'])).exitCode).toBe(1);});
