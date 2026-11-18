import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { PREFERENCES_KEY, PREFERENCES_TAG, preferencesSchema, preferencesPatch, quietSchema, type Preferences } from './preferences';
export function createPreferences(bb:BbPluginApi) {
 const listeners = new Set<(value:Preferences)=>void>();
 const ready = (async () => {
  const saved = await bb.storage.kv.get(PREFERENCES_KEY);
  if (saved !== undefined && saved !== null) return preferencesSchema.parse(saved);
  // shortcut: legacy controls stay visible for the migration load; reload once to remove them.
  const legacy = bb.settings.define({handoffWarnings:{type:'boolean',label:'Warn agents who hand work over or ask in chat without the Answers tools',default:true},remindHours:{type:'number',label:'Blocking reminder interval (hours; 0 disables)',default:3,experimental_schema:z.number().finite().nonnegative()},notify:{type:'select',label:'Push notifications',options:['off','asked','questions','all'],default:'asked'},quietHours:{type:'string',label:'Quiet hours (HH:MM-HH:MM)',default:'',experimental_schema:quietSchema},groupByProject:{type:'boolean',label:'Group conversations by project',default:false},projectOrder:{type:'string',label:'Project order in contacts (set by dragging project headers)',default:''},chatMode:{type:'select',label:'Conversation view',options:['answers','bb'],default:'answers'}});
  const value = preferencesSchema.parse(await legacy.get());
  await bb.storage.kv.set(PREFERENCES_KEY,value);
  return value;
 })();
 let chain = ready;
 return {
  get: () => chain,
  onChange: (listener:(value:Preferences)=>void) => {listeners.add(listener); return () => listeners.delete(listener);},
  experimental_set: (raw:unknown) => {
   const patch = preferencesPatch.parse(raw);
   const previous = chain;
   const update = previous.then(async current => {
    const next = preferencesSchema.parse({...current,...patch});
    await bb.storage.kv.set(PREFERENCES_KEY,next);
    for (const listener of listeners) listener(next);
    bb.rpc.experimental_invalidate([PREFERENCES_TAG]);
    return next;
   });
   chain = update.catch(() => previous);
   return update;
  },
 };
}
