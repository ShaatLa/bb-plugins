import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const projectSchema = z.object({channelCommands:z.array(z.string().trim().min(1)).default(['work-board question add'])}).strict();
export const projectKey = (projectId:string) => 'config:project:'+projectId;
export async function getProjectConfig(bb:BbPluginApi,projectId?:string|null) {
 return projectSchema.parse(projectId ? (await bb.storage.kv.get(projectKey(projectId))) ?? {} : {});
}
