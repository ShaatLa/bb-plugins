import { useState, type ReactNode } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { rpcContract } from './contract';
import { usePreferences } from './use-preferences';
import { preferencesPatch, type Preferences } from './preferences';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './components/ui/select';
import { Switch } from './components/ui/switch';
import { Input } from './components/ui/input';
import { Button } from './components/ui/button';
function Row({label,description,children}:{label:string;description:string;children:ReactNode}) {
 return <div className="flex flex-wrap items-center justify-between gap-4 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{description}</p></div>{children}</div>;
}
function Choice({label,value,options,disabled,onChange}:{label:string;value:string;options:[string,string][];disabled:boolean;onChange:(value:string)=>void}) {
 return <Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger aria-label={label} className="h-8 w-48"><SelectValue /></SelectTrigger><SelectContent>{options.map(([value,text])=><SelectItem key={value} value={value}>{text}</SelectItem>)}</SelectContent></Select>;
}
export function AnswersSettings() {
 const query=usePreferences(), rpc=useRpc(), [busy,setBusy]=useState(false), [error,setError]=useState('');
 const p=query.data;
 const [from,setFrom]=useState<string|null>(null), [to,setTo]=useState<string|null>(null);
 const save=async(patch:Partial<Preferences>)=>{setBusy(true);setError('');try{await rpc.call('updatePreferences',preferencesPatch.parse(patch));}catch(e){setError(String(e));}finally{setBusy(false);}};
 if(!p) return <p role={query.error?'alert':'status'}>{query.error?String(query.error):'Loading preferences…'}</p>;
 const disabled=busy, start=from??p.quietHours.slice(0,5), end=to??p.quietHours.slice(6);
 const times=(a:string,b:string)=>{if(a && b) void save({quietHours:`${a}-${b}`});};
 const reminders:[string,string][]=[['0','Off'],['1','Every hour'],['3','Every 3 hours'],['6','Every 6 hours'],['12','Every 12 hours'],['24','Once a day']];
 if(!reminders.some(([n])=>Number(n)===p.remindHours)) reminders.push([String(p.remindHours),`Every ${p.remindHours} hours`]);
 return <div className="space-y-6">
 <section><h3 className="text-sm font-medium">Notifications</h3><div className="divide-y divide-border">
 <Row label="Push notifications" description="Choose which Answers activity sends a push notification."><Choice label="Push notifications" value={p.notify} disabled={disabled} options={[["off","Off"],["asked","Only questions to me"],["questions","All questions"],["all","Everything"]]} onChange={notify=>void save({notify:notify as Preferences['notify']})}/></Row>
 <Row label="Quiet hours" description="Hold notifications until this local time window ends."><div className="flex items-center gap-2"><Switch aria-label="Quiet hours" checked={!!p.quietHours} disabled={disabled} onCheckedChange={checked=>{setFrom(null);setTo(null);void save({quietHours:checked?'22:00-08:00':''});}}/>{p.quietHours && <><label className="text-xs">From<Input aria-label="From" type="time" value={start} disabled={disabled} onChange={e=>{setFrom(e.target.value);times(e.target.value,end);}}/></label><label className="text-xs">To<Input aria-label="To" type="time" value={end} disabled={disabled} onChange={e=>{setTo(e.target.value);times(start,e.target.value);}}/></label></>}</div></Row>
 <Row label="Blocking question reminders" description="Remind you about unanswered blocking questions, up to three times."><Choice label="Blocking question reminders" value={String(p.remindHours)} options={reminders} disabled={disabled} onChange={n=>void save({remindHours:Number(n)})}/></Row></div></section>
 <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">Chat</h3><Row label="Conversation view" description="Choose the chat opened from Answers contacts."><Choice label="Conversation view" value={p.chatMode} options={[["answers","Answers"],["bb","bb chat"]]} disabled={disabled} onChange={chatMode=>void save({chatMode:chatMode as Preferences['chatMode']})}/></Row></section>
 <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">Contacts</h3><Row label="Group conversations by project" description="Show project headings in the contacts list."><Switch aria-label="Group conversations by project" checked={p.groupByProject} disabled={disabled} onCheckedChange={groupByProject=>void save({groupByProject})}/></Row>{p.groupByProject && <Row label="Project order" description="Restore the default project order."><Button variant="outline" size="sm" disabled={disabled} onClick={()=>void save({projectOrder:''})}>Reset project order</Button></Row>}</section>
 <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">Agents</h3><Row label="Warn agents who hand work over or ask in chat without the Answers tools" description="Prompt agents to record handoffs and questions with the Answers tools."><Switch aria-label="Warn agents who hand work over or ask in chat without the Answers tools" checked={p.handoffWarnings} disabled={disabled} onCheckedChange={handoffWarnings=>void save({handoffWarnings})}/></Row></section>
 {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
 </div>;
}
