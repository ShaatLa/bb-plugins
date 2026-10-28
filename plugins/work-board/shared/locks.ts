import { z } from "zod";

export const LOCK_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const LOCK_HISTORY_LIMIT = 50;

const projectId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const lockName = z
  .string()
  .regex(LOCK_NAME_PATTERN, "lock name must match ^[a-z][a-z0-9_-]{0,63}$");
const reason = z.string().trim().min(1).max(200);
const threadId = z.string().regex(/^thr_[A-Za-z0-9_-]+$/).nullable();

export const lockSchema = z
  .object({
    name: lockName,
    holderThreadId: threadId,
    holderTitle: z.string().nullable(),
    taskKey: z.string().nullable(),
    reason,
    acquiredAt: z.string(),
    expiresAt: z.string().nullable(),
    stale: z
      .enum(["expired", "thread_failed", "thread_archived", "thread_deleted"])
      .nullable(),
  })
  .strict();

export const lockEventSchema = z
  .object({
    kind: z.enum(["acquired", "released", "taken_over", "expired"]),
    threadId,
    previousThreadId: threadId,
    taskKey: z.string().nullable(),
    reason: z.string(),
    forced: z.boolean(),
    at: z.string(),
  })
  .strict();

const lockResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), lock: lockSchema.nullable() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum(["held", "not_holder", "not_held"]),
          message: z.string(),
        })
        .strict(),
      lock: lockSchema.nullable(),
    })
    .strict(),
]);

export const lockMethods = {
  listLocks: {
    input: z.object({ projectId }).strict(),
    output: z.object({ locks: z.array(lockSchema) }).strict(),
  },
  lockHistory: {
    input: z.object({ projectId, name: lockName }).strict(),
    output: z.object({ events: z.array(lockEventSchema) }).strict(),
  },
  acquireLock: {
    input: z
      .object({
        projectId,
        name: lockName,
        reason,
        threadId,
        taskKey: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z][A-Z0-9]{0,9}-\d+$/)
          .optional(),
        ttlMinutes: z.number().int().min(1).max(1440).optional(),
        takeover: z.boolean().default(false),
      })
      .strict(),
    output: lockResultSchema,
  },
  releaseLock: {
    input: z
      .object({
        projectId,
        name: lockName,
        threadId,
        force: z.boolean().default(false),
        reason: reason.optional(),
      })
      .strict()
      .refine((value) => !value.force || value.reason !== undefined, {
        message: "a force release needs a reason",
        path: ["reason"],
      }),
    output: lockResultSchema,
  },
} as const;

export type Lock = z.infer<typeof lockSchema>;
export type LockEvent = z.infer<typeof lockEventSchema>;
