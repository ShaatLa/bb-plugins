import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { preferencesSchema } from './preferences';
import { createPreferences } from './settings';
import { getProjectConfig, projectKey, projectSchema } from './project-config';
export const configGet = z.object({projectId:z.string().min(1).optional(),key:z.string().min(1).optional()}).strict();
export const configSet = configGet.extend({key:z.string().min(1),value:z.unknown()}).strict();
export function createConfig(bb:BbPluginApi,preferences:ReturnType<typeof createPreferences>) {
 function field(projectId:string|undefined,key:string) {
  const shape:Record<string,z.ZodTypeAny> = projectId ? projectSchema.shape : preferencesSchema.shape;
  if (!Object.hasOwn(shape,key)) throw new Error('Unknown key. Valid keys: '+Object.keys(shape).join(', '));
  return shape[key]!;
 }
 return {
  async get(raw:z.infer<typeof configGet>) {
   const p=configGet.parse(raw);
   if (p.key) field(p.projectId,p.key);
   const value = p.projectId ? await getProjectConfig(bb,p.projectId) : await preferences.get();
   return p.key ? value[p.key as keyof typeof value] : value;
  },
  async set(raw:z.infer<typeof configSet>) {
   const p=configSet.parse(raw),schema=field(p.projectId,p.key);
   let value=p.value;
   if (typeof value==='string') {
    if (p.projectId && p.key==='channelCommands') value=value.trim().startsWith('[') ? JSON.parse(value) : value.split(',').map(s=>s.trim());
    else if (typeof (await preferences.get())[p.key as keyof Awaited<ReturnType<typeof preferences.get>>]!=='string') {
     try {value=JSON.parse(value);} catch {}
    }
   }
   value=schema.parse(value);
   if (p.projectId) await bb.storage.kv.set(projectKey(p.projectId),{...await getProjectConfig(bb,p.projectId),[p.key]:value});
   else await preferences.experimental_set({[p.key]:value});
   return value;
  },
 };
}
