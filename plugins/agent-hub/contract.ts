import { configGet, configSet } from './config';
import { preferencesSchema, preferencesPatch, PREFERENCES_TAG } from './preferences';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const YOUR_CALL = 'Your call';
export const ITEMS_TAG = 'answers:items', COUNTS_TAG = 'answers:counts', POOLS_TAG = 'answers:pools', QUEUE_TAG = 'answers:queue', CONTEXT_TAG = 'answers:context';
export const idSchema = z.string().regex(/^ans_[A-Za-z0-9_-]+$/);
const threadId = z.string().min(1).max(200), time = z.number().int().nonnegative();
export const itemAttachmentSchema = z.object({ type:z.enum(['localImage','localFile']), path:z.string(), name:z.string().optional(), mimeType:z.string().optional(), sizeBytes:z.number().optional(), hostId:z.string().optional(), sourceProjectId:z.string().optional() });
// A question the owner answers in bb's question form: one prompt, or one part of a composite question.
export const formQuestionSchema = z.object({ id: z.string(), prompt: z.string(), shortLabel: z.string().optional(), options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional(), multiSelect: z.boolean(), allowFreeText: z.boolean(), required: z.boolean() });
export type FormQuestion = z.infer<typeof formQuestionSchema>;
export const itemSchema = z.object({ id: idSchema, kind: z.enum(['mine','for_me','saved','update']), threadId, projectId: z.string().nullable(), threadTitle: z.string().nullable(), projectName: z.string().nullable(), status: z.enum(['waiting','deferred','answered','open','replied','saved']), question: z.string(), attachments:z.array(itemAttachmentSchema).default([]), questionSeq: time.nullable(), requestId: z.string().nullable(), turnId: z.string().nullable(), candidate: z.string().nullable(), candidateSeq: time.nullable(), interim: z.string().nullable(), interimSeq: time.nullable(), answer: z.string().nullable(), answerSeq: time.nullable(), answerSource: z.enum(['turn','agent','user']).nullable(), resolveTurnId: z.string().nullable(), note: z.string().nullable(), snoozedUntil:time.nullable(),failedAt:time.nullable(),failureReason:z.string().nullable().default(null),interruptedAt:time.nullable().default(null),likelyInterim:z.boolean(),options:z.array(z.string()).nullable(),questions:z.array(formQuestionSchema).nullable().default(null),recommended:z.string().nullable().default(null),recommendReason:z.string().nullable().default(null),deadlineAt:time.nullable().default(null),urgency:z.enum(['blocking','normal','low']).nullable().default(null),taskKey:z.string().nullable(),trigger:z.object({kind:z.enum(['system','agent','plugin','other']),sourceId:z.string().nullable(),sourceTitle:z.string().nullable().default(null)}).nullable().default(null),answeredAt:time.nullable().default(null),asks:z.boolean().default(false), chatAsked:z.boolean().default(false),readAt: time.nullable(), pinned: z.boolean(), dismissedAt: time.nullable(), threadDeleted: z.boolean(), createdAt: time, updatedAt: time });
export type ItemAttachment = z.infer<typeof itemAttachmentSchema>;
export const viewSchema = z.enum(['unread','waiting','for_me','pinned','saved','all']);
export const poolIdSchema = z.string().regex(/^pool_[A-Za-z0-9_-]+$/);
const quote = z.string().min(1).max(20000, 'Quote exceeds 20,000 characters');
// Pool entries may be free messages without a quote.
const poolQuote = z.string().max(20000, 'Quote exceeds 20,000 characters');
// Files uploaded through projects.attachments.upload, sent as threads.send localFile/localImage inputs.
export const attachmentSchema = z.object({type:z.enum(['localFile','localImage']),path:z.string().min(1).max(4096),name:z.string().min(1).max(512),mimeType:z.string().max(255).optional(),sizeBytes:z.number().int().nonnegative().optional(),sourceProjectId:z.string().min(1).max(200).optional()}).strict();
const attachments = z.array(attachmentSchema).max(10, 'At most 10 attachments');
// How a reply leaves, mirroring bb's send menu: queue (default), steer the running turn, hold as a draft, or send later.
export const sendOptionsSchema = z.object({mode:z.enum(['queue','steer','draft']),sendAt:z.number().int().positive().optional()}).strict();
export const poolEntrySchema = z.object({id:poolIdSchema,threadId,quote:poolQuote,quoteSeq:time.nullable(),itemId:idSchema.nullable(),note:z.string().max(8000),attachments:z.array(attachmentSchema),revision:time,createdAt:time,updatedAt:time});
// An inline-vis page as the built-in inline-vis plugin prepares it (see inlinePreview in server.ts).
export const inlinePreviewSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('html'),url:z.string(),content:z.string()}),
  z.object({kind:z.literal('markdown'),content:z.string(),rootPath:z.string(),target:z.union([z.object({kind:z.literal('workspace'),environmentId:z.string(),path:z.string()}),z.object({kind:z.literal('thread-storage'),threadId:z.string(),path:z.string()})])}),
  z.object({kind:z.literal('not-found')}), z.object({kind:z.literal('error'),message:z.string()})]);
export type InlinePreview = z.infer<typeof inlinePreviewSchema>;
export const recipientSchema = z.object({threadId,threadTitle:z.string().nullable(),projectId:z.string().nullable(),projectName:z.string().nullable(),unread:time,lastAt:time,preview:z.string()});
export const poolSchema = z.object({threadId,threadTitle:z.string().nullable(),projectId:z.string().nullable(),entries:z.array(poolEntrySchema)});
const bulkRead=z.object({ok:z.literal(true),batch:z.string().nullable(),count:time});
const costSchema=z.object({usd:z.number().nullable(),tokens:z.object({freshIn:z.number(),cacheRead:z.number(),cacheWrite:z.number(),output:z.number()}),estimated:z.boolean(),partial:z.boolean()});
export type Cost=z.infer<typeof costSchema>;
export const tokenomosThreads=z.object({priceVersion:z.string(),threads:z.array(z.object({threadId:z.string(),own:costSchema,total:costSchema,descendantCount:z.number(),updatedAt:z.number()}))});
export const inputs = {
 owed:z.object({threadId}).strict(), settleOwed:z.object({id:idSchema,action:z.enum(['answered','dismissed'])}).strict(),
 undoRead:z.object({batch:z.string().min(1)}).strict(),
 keepWaiting:z.object({id:idSchema}).strict(), setInterim:z.object({id:idSchema,value:z.boolean()}).strict(),
 snooze:z.object({id:idSchema,until:time.nullable()}).strict(), retryTurn:z.object({id:idSchema}).strict(),
 workBoardProjects:z.object({}).strict(),threadCost:z.object({threadId}).strict(),setPreferences:z.object({groupByProject:z.boolean().optional(),projectOrder:z.string().max(4000).optional()}).strict(),createTask:z.object({id:idSchema,projectId:z.string().min(1).max(200)}).strict(),
 inlinePreview:z.object({threadId,file:z.string().min(1).max(1000),source:z.enum(['workspace','thread-storage']).default('workspace')}).strict(),
 recipients:z.object({selected:threadId.optional()}).strict(), markThreadRead:z.object({threadId}).strict(), queueStamp:z.object({threadId}).strict(), contextStamp:z.object({threadId}).strict(), logClientError:z.object({where:z.string().max(100),message:z.string().max(2000),stack:z.string().max(8000).optional()}).strict(),
 pools:z.object({}).strict(), poolAdd:z.object({threadId,quote:poolQuote,quoteSeq:time.optional(),itemId:idSchema.optional(),note:z.string().max(8000).optional(),attachments:attachments.optional()}).strict(),
 poolUpdate:z.object({id:poolIdSchema,note:z.string().max(8000),attachments:attachments.optional(),revision:time}).strict(), poolRemove:z.object({id:poolIdSchema}).strict(),
 poolSend:z.object({threadId,ids:z.array(poolIdSchema).min(1).optional(),send:sendOptionsSchema.optional()}).strict(), quoteReply:z.object({threadId,quote,text:z.string().max(8000),itemId:idSchema.optional(),attachments:attachments.optional(),send:sendOptionsSchema.optional()}).strict(),
 list: z.object({anchor:z.union([idSchema,time]).optional(),after:z.string().regex(/^\d+\|ans_[A-Za-z0-9_-]+$/).optional(),view: viewSchema, threadId: threadId.optional(), projectId: z.string().min(1).max(200).optional(), query: z.string().max(4000).optional(), cursor: z.string().regex(/^\d+\|ans_[A-Za-z0-9_-]+$/).optional(), order: z.enum(['created','activity']).optional(), limit: z.number().int().min(1).max(50).optional()}).strict(), counts: z.object({}).strict(),
 markRead: z.union([z.object({ids: z.array(idSchema).min(1).max(1000)}).strict(), z.object({all:z.literal(true), threadId:threadId.optional()}).strict()]),
 setPinned: z.object({id:idSchema,pinned:z.boolean()}).strict(), setDismissed: z.object({id:idSchema,dismissed:z.boolean()}).strict(),
 reply: z.object({id:idSchema,text:z.string().trim().max(8000),attachments:attachments.optional(),send:sendOptionsSchema.optional()}).strict().refine(p=>p.text || p.attachments?.length,{message:'Write a reply or attach a file',path:['text']}), save: z.object({threadId,seq:time,role:z.string().min(1).max(100),text:z.string().trim().min(1).max(20000)}).strict(),
};
const ok=z.object({ok:z.literal(true)});
export const rpcContract=defineRpcContract({
 'config.get':{input:configGet,output:z.unknown()},
 'config.set':{input:configSet,output:z.unknown()},
 getPreferences:{tags:()=>[PREFERENCES_TAG],input:z.object({}).strict(),output:preferencesSchema},
 updatePreferences:{input:preferencesPatch,output:preferencesSchema},
 owed:{tags:()=>[ITEMS_TAG],input:inputs.owed,output:z.object({items:z.array(z.object({id:idSchema,question:z.string(),createdAt:time,interim:z.boolean()}))})},
 settleOwed:{input:inputs.settleOwed,output:ok},
 undoRead:{input:inputs.undoRead,output:z.object({ok:z.literal(true),count:time})},
 keepWaiting:{input:inputs.keepWaiting,output:ok},setInterim:{input:inputs.setInterim,output:ok},
 snooze:{input:inputs.snooze,output:ok},retryTurn:{input:inputs.retryTurn,output:ok},
 setPreferences:{input:inputs.setPreferences,output:z.object({ok:z.literal(true)})},
 threadCost:{input:inputs.threadCost,output:z.object({available:z.boolean(),own:costSchema.nullable(),total:costSchema.nullable(),descendantCount:z.number()})},
 workBoardProjects:{input:inputs.workBoardProjects,output:z.object({available:z.boolean(),projects:z.array(z.object({id:z.string(),name:z.string(),prefix:z.string()}))})},
 createTask:{input:inputs.createTask,output:z.object({key:z.string()})},
 inlinePreview:{input:inputs.inlinePreview,output:inlinePreviewSchema},
 recipients:{tags:()=>[ITEMS_TAG],input:inputs.recipients,output:z.object({recipients:z.array(recipientSchema),asking:z.array(threadId).default([])})},
 markThreadRead:{input:inputs.markThreadRead,output:bulkRead}, queueStamp:{tags:()=>[QUEUE_TAG],input:inputs.queueStamp,output:z.object({stamp:z.number()})}, contextStamp:{tags:()=>[CONTEXT_TAG],input:inputs.contextStamp,output:z.object({stamp:z.number(),compactedAt:z.number().nullable().default(null)})}, logClientError:{input:inputs.logClientError,output:z.object({ok:z.literal(true)})}, pools:{tags:()=>[POOLS_TAG],input:inputs.pools,output:z.object({pools:z.array(poolSchema)})},
 poolAdd:{input:inputs.poolAdd,output:z.object({id:poolIdSchema})}, poolUpdate:{input:inputs.poolUpdate,output:z.object({revision:time})}, poolRemove:{input:inputs.poolRemove,output:ok},
 poolSend:{input:inputs.poolSend,output:z.object({delivery:z.enum(['sent','queued']),sent:time,keptEdited:time})}, quoteReply:{input:inputs.quoteReply,output:z.object({delivery:z.enum(['sent','queued'])})},
 list:{tags:()=>[ITEMS_TAG],input:inputs.list,output:z.object({items:z.array(itemSchema),nextCursor:z.string().nullable(),newerCursor:z.string().nullable().optional()})}, counts:{tags:()=>[COUNTS_TAG],input:inputs.counts,output:z.object({unread:time,waiting:time,forMe:time,inbox:time})},
 markRead:{input:inputs.markRead,output:z.union([bulkRead,ok])},setPinned:{input:inputs.setPinned,output:ok},setDismissed:{input:inputs.setDismissed,output:ok}, reply:{input:inputs.reply,output:z.object({delivery:z.enum(['sent','queued'])})},save:{input:inputs.save,output:z.object({id:idSchema,created:z.boolean()})},
});
export type Item=z.infer<typeof itemSchema>;
export type View=z.infer<typeof viewSchema>;
export type AgentHubRpcContract=typeof rpcContract;

export type ListInput = z.infer<typeof inputs.list>;
export type Counts = { unread: number; waiting: number; forMe: number; inbox: number };
export type ListResult = { items: Item[]; nextCursor: string | null; newerCursor?: string | null };

export type PoolEntry = z.infer<typeof poolEntrySchema>;
export type Recipient = z.infer<typeof recipientSchema>;
export type Pool = z.infer<typeof poolSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type SendOptions = z.infer<typeof sendOptionsSchema>;
export type RecipientsResult = { recipients: Recipient[] };
export type PoolsResult = { pools: Pool[] };
export type PoolSendResult = { delivery: 'sent' | 'queued'; sent: number; keptEdited: number };

export function answerText(questions: readonly FormQuestion[], answers: Record<string,{selected:string[];freeText?:string}>) {
 const value=(q:FormQuestion)=>{const a=answers[q.id], picks=a ? [...a.selected.map(v=>v===YOUR_CALL ? 'Your call (decide yourself)' : q.options?.find(o=>o.value===v)?.label ?? v),...(a.freeText ? [a.freeText] : [])] : []; return picks.length ? picks.join('; ') : 'Skipped';};
 return questions.length===1 ? value(questions[0]!) : questions.map((q,i)=>`${i+1}. ${q.shortLabel ?? q.prompt} — ${value(q)}`).join('\n');
}

export function defaultAnswer(item:{questions:FormQuestion[]|null;recommended:string|null}) {
 return item.questions ? answerText(item.questions,Object.fromEntries(item.questions.map(q=>[q.id,{selected:[q.options?.find(o=>o.description?.startsWith('Recommended'))?.value ?? YOUR_CALL]}]))) : item.recommended ?? 'Your call (decide yourself)';
}
