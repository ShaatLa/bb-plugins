import { z } from "zod";
import { prUrlSchema } from "./git-sync";

const freshness = { checkedAt: z.iso.datetime(), validUntil: z.iso.datetime() };
export const taskAdvisorySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("merged-predecessor"), ...freshness,
    predecessor: z.object({ id: z.string(), key: z.string(), title: z.string(), status: z.string() }).strict(),
    pr: z.object({ url: prUrlSchema, number: z.number().int().positive(), repository: z.string(), mergeSha: z.string().regex(/^[a-f0-9]{40}$/i), mergedAt: z.iso.datetime() }).strict(),
  }).strict(),
  z.object({ kind: z.literal("no-live-session"), ...freshness, lastActivityAt: z.string(),
    lastAttachment: z.object({ threadId: z.string(), title: z.string(), attachedAt: z.string(), updatedAt: z.string() }).strict().nullable(),
  }).strict(),
]);
export type TaskAdvisory = z.infer<typeof taskAdvisorySchema>;
export function advisoryText(item: TaskAdvisory): string {
  return item.kind === "merged-predecessor"
    ? `${item.predecessor.key} is ${item.predecessor.status}, but delivery PR ${item.pr.repository}#${item.pr.number} merged (${item.pr.mergeSha}). Check acceptance criteria or remaining work before marking it Done. Checked ${item.checkedAt}; valid until ${item.validUntil}.`
    : `In Progress without a live attached session. Last attachment: ${item.lastAttachment ? `${item.lastAttachment.title} (@thread:${item.lastAttachment.threadId}), attached ${item.lastAttachment.attachedAt}, updated ${item.lastAttachment.updatedAt}` : "none retained"}. Last task activity: ${item.lastActivityAt}. Consider reassigning or queueing. Checked ${item.checkedAt}; valid until ${item.validUntil}.`;
}
