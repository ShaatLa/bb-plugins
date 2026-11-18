import { expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createPreferences } from './settings';
import { PREFERENCES_KEY } from './preferences';
it('migrates all legacy preferences once and preserves later writes on reload',async()=>{
 const h=createFakePluginHost({pluginId:'answers',settings:{notify:'all',quietHours:'23:00-07:00',remindHours:7,handoffWarnings:false,groupByProject:true,projectOrder:'proj_example',chatMode:'bb'}});
 const store=createPreferences(h.bb);
 expect(await store.get()).toEqual({notify:'all',quietHours:'23:00-07:00',remindHours:7,handoffWarnings:false,groupByProject:true,projectOrder:'proj_example',chatMode:'bb'});
 await store.experimental_set({notify:'off',remindHours:1});
 expect(await createPreferences(h.bb).get()).toEqual(await h.bb.storage.kv.get(PREFERENCES_KEY));
 expect((await createPreferences(h.bb).get()).notify).toBe('off');
 await h.harness.lifecycle.dispose();
});
it('serializes patches, notifies readers and rejects invalid quiet hours',async()=>{
 const h=createFakePluginHost({pluginId:'answers'}),store=createPreferences(h.bb),seen:unknown[]=[];
 store.onChange(p=>seen.push(p));
 await Promise.all([store.experimental_set({notify:'off'}),store.experimental_set({quietHours:'22:00-08:00',remindHours:6,handoffWarnings:false})]);
 expect(await store.get()).toMatchObject({notify:'off',quietHours:'22:00-08:00',remindHours:6,handoffWarnings:false});
 expect(seen).toHaveLength(2);
 for(const quietHours of ['24:00-01:00','12:00-12:00']) expect(()=>store.experimental_set({quietHours})).toThrow();
 await h.harness.lifecycle.dispose();
});
