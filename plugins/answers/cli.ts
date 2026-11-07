import { cliCommand, defineCli, type BbPluginApi } from '@get-bb/plugin-sdk';
import { inputs, viewSchema, type ListInput, type ListResult } from './contract';
import type { z } from 'zod';
type Api = {
  list(input: ListInput): Promise<ListResult>;
  markRead(input: z.infer<typeof inputs.markRead>): {ok:true};
  status(): unknown;
};
export function registerCli(bb: BbPluginApi, api: Api) {
  const thread={type:'string',description:'Filter by thread'} as const;
  bb.cli.register(defineCli({name:'answers',summary:'Questions, answers and saved messages',commands:{
    list:cliCommand({summary:'List up to 50 items',options:{view:{type:'enum',values:viewSchema.options,description:'Inbox view'},thread,json:{type:'boolean',description:'Return JSON'}},async run(i){
      const result=await api.list(inputs.list.parse({view:i.options.view ?? 'unread',threadId:i.options.thread}));
      return {exitCode:0,stdout:i.options.json ? JSON.stringify(result) : result.items.map(r=>`${r.id} ${r.status} ${r.threadTitle ?? r.threadId} ${r.question.replace(/\s+/g,' ').slice(0,160)}`).join('\n') || 'No items.'};
    }}),
    read:cliCommand({summary:'Mark items read',positionals:[{name:'ids',description:'Item ids',variadic:true}],options:{all:{type:'boolean',description:'Mark all answers read'},thread},run(i){
      if (i.options.all && i.positionals.ids.length) throw new Error('Choose ids or --all');
      if (!i.options.all && i.options.thread) throw new Error('--thread requires --all');
      api.markRead(inputs.markRead.parse(i.options.all ? {all:true,threadId:i.options.thread} : {ids:i.positionals.ids})); return {exitCode:0,stdout:'Marked read.'};
    }}),
    status:cliCommand({summary:'Show counts, tracked threads and ingestion errors',run(){return {exitCode:0,stdout:JSON.stringify(api.status())};}}),
  }}));
}
