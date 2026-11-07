import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const ITEMS_TAG = 'answers:items', COUNTS_TAG = 'answers:counts';
export const idSchema = z.string().regex(/^ans_[A-Za-z0-9_-]+$/);
const threadId = z.string().min(1).max(200), time = z.number().int().nonnegative();
export const itemSchema = z.object({ id: idSchema, kind: z.enum(['mine','for_me','saved']), threadId, projectId: z.string().nullable(), threadTitle: z.string().nullable(), projectName: z.string().nullable(), status: z.enum(['waiting','deferred','answered','open','replied','saved']), question: z.string(), questionSeq: time.nullable(), requestId: z.string().nullable(), turnId: z.string().nullable(), candidate: z.string().nullable(), candidateSeq: time.nullable(), interim: z.string().nullable(), interimSeq: time.nullable(), answer: z.string().nullable(), answerSeq: time.nullable(), answerSource: z.enum(['turn','agent','user']).nullable(), resolveTurnId: z.string().nullable(), note: z.string().nullable(), readAt: time.nullable(), pinned: z.boolean(), dismissedAt: time.nullable(), threadDeleted: z.boolean(), createdAt: time, updatedAt: time });
export const viewSchema = z.enum(['unread','waiting','for_me','pinned','saved','all']);
export const inputs = {
 list: z.object({view: viewSchema, threadId: threadId.optional(), projectId: z.string().min(1).max(200).optional(), query: z.string().max(4000).optional(), cursor: z.string().regex(/^\d+\|ans_[A-Za-z0-9_-]+$/).optional(), limit: z.number().int().min(1).max(50).optional()}).strict(), counts: z.object({}).strict(),
 markRead: z.union([z.object({ids: z.array(idSchema).min(1).max(1000)}).strict(), z.object({all:z.literal(true), threadId:threadId.optional()}).strict()]),
 setPinned: z.object({id:idSchema,pinned:z.boolean()}).strict(), setDismissed: z.object({id:idSchema,dismissed:z.boolean()}).strict(),
 reply: z.object({id:idSchema,text:z.string().trim().min(1).max(8000)}).strict(), save: z.object({threadId,seq:time,role:z.string().min(1).max(100),text:z.string().trim().min(1).max(20000)}).strict(),
};
const ok=z.object({ok:z.literal(true)});
export const rpcContract=defineRpcContract({
 list:{tags:()=>[ITEMS_TAG],input:inputs.list,output:z.object({items:z.array(itemSchema),nextCursor:z.string().nullable()})}, counts:{tags:()=>[COUNTS_TAG],input:inputs.counts,output:z.object({unread:time,waiting:time,forMe:time})},
 markRead:{input:inputs.markRead,output:ok},setPinned:{input:inputs.setPinned,output:ok},setDismissed:{input:inputs.setDismissed,output:ok}, reply:{input:inputs.reply,output:z.object({delivery:z.enum(['sent','queued'])})},save:{input:inputs.save,output:z.object({id:idSchema})},
});
export type Item=z.infer<typeof itemSchema>;
export type View=z.infer<typeof viewSchema>;
export type AnswersRpcContract=typeof rpcContract;

export type ListInput = z.infer<typeof inputs.list>;
export type Counts = { unread: number; waiting: number; forMe: number };
export type ListResult = { items: Item[]; nextCursor: string | null };
