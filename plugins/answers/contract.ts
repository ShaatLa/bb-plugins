import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const ITEMS_TAG = 'answers:items', COUNTS_TAG = 'answers:counts', POOLS_TAG = 'answers:pools';
export const idSchema = z.string().regex(/^ans_[A-Za-z0-9_-]+$/);
const threadId = z.string().min(1).max(200), time = z.number().int().nonnegative();
export const itemAttachmentSchema = z.object({ type:z.enum(['localImage','localFile']), path:z.string(), name:z.string().optional(), mimeType:z.string().optional(), sizeBytes:z.number().optional(), hostId:z.string().optional(), sourceProjectId:z.string().optional() });
export const itemSchema = z.object({ id: idSchema, kind: z.enum(['mine','for_me','saved']), threadId, projectId: z.string().nullable(), threadTitle: z.string().nullable(), projectName: z.string().nullable(), status: z.enum(['waiting','deferred','answered','open','replied','saved']), question: z.string(), attachments:z.array(itemAttachmentSchema).default([]), questionSeq: time.nullable(), requestId: z.string().nullable(), turnId: z.string().nullable(), candidate: z.string().nullable(), candidateSeq: time.nullable(), interim: z.string().nullable(), interimSeq: time.nullable(), answer: z.string().nullable(), answerSeq: time.nullable(), answerSource: z.enum(['turn','agent','user']).nullable(), resolveTurnId: z.string().nullable(), note: z.string().nullable(), snoozedUntil:time.nullable(),failedAt:time.nullable(),likelyInterim:z.boolean(),options:z.array(z.string()).nullable(),recommended:z.string().nullable().default(null),recommendReason:z.string().nullable().default(null),taskKey:z.string().nullable(),readAt: time.nullable(), pinned: z.boolean(), dismissedAt: time.nullable(), threadDeleted: z.boolean(), createdAt: time, updatedAt: time });
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
export const recipientSchema = z.object({threadId,threadTitle:z.string().nullable(),projectId:z.string().nullable(),projectName:z.string().nullable(),unread:time,lastAt:time,preview:z.string()});
export const poolSchema = z.object({threadId,threadTitle:z.string().nullable(),projectId:z.string().nullable(),entries:z.array(poolEntrySchema)});
const bulkRead=z.object({ok:z.literal(true),batch:z.string().nullable(),count:time});
export const inputs = {
 undoRead:z.object({batch:z.string().min(1)}).strict(),
 keepWaiting:z.object({id:idSchema}).strict(), setInterim:z.object({id:idSchema,value:z.boolean()}).strict(),
 snooze:z.object({id:idSchema,until:time.nullable()}).strict(), retryTurn:z.object({id:idSchema}).strict(),
 workBoardProjects:z.object({}).strict(),setPreferences:z.object({groupByProject:z.boolean().optional(),usage:z.enum(['auto','always','never']).optional(),projectOrder:z.string().max(4000).optional()}).strict(),createTask:z.object({id:idSchema,projectId:z.string().min(1).max(200)}).strict(),
 recipients:z.object({selected:threadId.optional(),questions:z.boolean().optional()}).strict(), markThreadRead:z.object({threadId}).strict(),
 pools:z.object({}).strict(), poolAdd:z.object({threadId,quote:poolQuote,quoteSeq:time.optional(),itemId:idSchema.optional(),note:z.string().max(8000).optional(),attachments:attachments.optional()}).strict(),
 poolUpdate:z.object({id:poolIdSchema,note:z.string().max(8000),revision:time}).strict(), poolRemove:z.object({id:poolIdSchema}).strict(),
 poolSend:z.object({threadId,ids:z.array(poolIdSchema).min(1).optional(),send:sendOptionsSchema.optional()}).strict(), quoteReply:z.object({threadId,quote,text:z.string().max(8000),itemId:idSchema.optional(),attachments:attachments.optional(),send:sendOptionsSchema.optional()}).strict(),
 list: z.object({view: viewSchema, questions: z.boolean().optional(), threadId: threadId.optional(), projectId: z.string().min(1).max(200).optional(), query: z.string().max(4000).optional(), cursor: z.string().regex(/^\d+\|ans_[A-Za-z0-9_-]+$/).optional(), limit: z.number().int().min(1).max(50).optional()}).strict(), counts: z.object({}).strict(),
 markRead: z.union([z.object({ids: z.array(idSchema).min(1).max(1000)}).strict(), z.object({all:z.literal(true), threadId:threadId.optional()}).strict()]),
 setPinned: z.object({id:idSchema,pinned:z.boolean()}).strict(), setDismissed: z.object({id:idSchema,dismissed:z.boolean()}).strict(),
 reply: z.object({id:idSchema,text:z.string().trim().min(1).max(8000),attachments:attachments.optional(),send:sendOptionsSchema.optional()}).strict(), save: z.object({threadId,seq:time,role:z.string().min(1).max(100),text:z.string().trim().min(1).max(20000)}).strict(),
};
const ok=z.object({ok:z.literal(true)});
export const rpcContract=defineRpcContract({
 undoRead:{input:inputs.undoRead,output:z.object({ok:z.literal(true),count:time})},
 keepWaiting:{input:inputs.keepWaiting,output:ok},setInterim:{input:inputs.setInterim,output:ok},
 snooze:{input:inputs.snooze,output:ok},retryTurn:{input:inputs.retryTurn,output:ok},
 setPreferences:{input:inputs.setPreferences,output:z.object({ok:z.literal(true)})},
 workBoardProjects:{input:inputs.workBoardProjects,output:z.object({available:z.boolean(),projects:z.array(z.object({id:z.string(),name:z.string(),prefix:z.string()}))})},
 createTask:{input:inputs.createTask,output:z.object({key:z.string()})},
 recipients:{tags:()=>[ITEMS_TAG],input:inputs.recipients,output:z.object({recipients:z.array(recipientSchema)})},
 markThreadRead:{input:inputs.markThreadRead,output:bulkRead}, pools:{tags:()=>[POOLS_TAG],input:inputs.pools,output:z.object({pools:z.array(poolSchema)})},
 poolAdd:{input:inputs.poolAdd,output:z.object({id:poolIdSchema})}, poolUpdate:{input:inputs.poolUpdate,output:z.object({revision:time})}, poolRemove:{input:inputs.poolRemove,output:ok},
 poolSend:{input:inputs.poolSend,output:z.object({delivery:z.enum(['sent','queued']),sent:time,keptEdited:time})}, quoteReply:{input:inputs.quoteReply,output:z.object({delivery:z.enum(['sent','queued'])})},
 list:{tags:()=>[ITEMS_TAG],input:inputs.list,output:z.object({items:z.array(itemSchema),nextCursor:z.string().nullable()})}, counts:{tags:()=>[COUNTS_TAG],input:inputs.counts,output:z.object({unread:time,waiting:time,forMe:time,inbox:time})},
 markRead:{input:inputs.markRead,output:z.union([bulkRead,ok])},setPinned:{input:inputs.setPinned,output:ok},setDismissed:{input:inputs.setDismissed,output:ok}, reply:{input:inputs.reply,output:z.object({delivery:z.enum(['sent','queued'])})},save:{input:inputs.save,output:z.object({id:idSchema,created:z.boolean()})},
});
export type Item=z.infer<typeof itemSchema>;
export type View=z.infer<typeof viewSchema>;
export type AnswersRpcContract=typeof rpcContract;

export type ListInput = z.infer<typeof inputs.list>;
export type Counts = { unread: number; waiting: number; forMe: number; inbox: number };
export type ListResult = { items: Item[]; nextCursor: string | null };

export type PoolEntry = z.infer<typeof poolEntrySchema>;
export type Recipient = z.infer<typeof recipientSchema>;
export type Pool = z.infer<typeof poolSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type SendOptions = z.infer<typeof sendOptionsSchema>;
export type RecipientsResult = { recipients: Recipient[] };
export type PoolsResult = { pools: Pool[] };
export type PoolSendResult = { delivery: 'sent' | 'queued'; sent: number; keptEdited: number };
