import { z } from 'zod';
export const PREFERENCES_KEY = 'preferences';
export const PREFERENCES_TAG = 'answers:preferences';
export const quietSchema = z.string().regex(/^(?:([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)?$/).refine(s => !s || s.slice(0,5) !== s.slice(6), 'Quiet hours must have different endpoints');
export const preferencesSchema = z.object({
 showMarkAllRead:z.boolean().default(false), workingAnimation:z.enum(['on','desktop','off']).default('desktop'), touchEnter:z.enum(['newline','send']).default('newline'), groupBackgroundUpdates:z.boolean().default(true), selectionActions:z.boolean().default(true),
 handoffWarnings:z.boolean().default(true), remindHours:z.number().finite().nonnegative().default(3),
 notify:z.enum(['off','asked','questions','all']).default('asked'), quietHours:quietSchema.default(''),
 groupByProject:z.boolean().default(false), projectOrder:z.string().max(4000).default(''), chatMode:z.enum(['answers','bb']).default('answers'),
}).strict();
export const preferencesPatch = z.object({showMarkAllRead:z.boolean(),workingAnimation:z.enum(['on','desktop','off']),touchEnter:z.enum(['newline','send']),groupBackgroundUpdates:z.boolean(),selectionActions:z.boolean(),handoffWarnings:z.boolean(),remindHours:z.number().finite().nonnegative(),notify:z.enum(['off','asked','questions','all']),quietHours:quietSchema,groupByProject:z.boolean(),projectOrder:z.string().max(4000),chatMode:z.enum(['answers','bb'])}).partial().strict();
export type Preferences = z.infer<typeof preferencesSchema>;
