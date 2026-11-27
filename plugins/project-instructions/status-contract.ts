import { z } from "zod";

export const projectId = z.string().min(1).max(200);
export const fieldValues = {
  clonePath: z.string().nullable(),
  branch: z.string().nullable(),
  rootFile: z.string().nullable(),
  skillsDir: z.string(),
  enabled: z.boolean(),
  allowSync: z.boolean(),
};
export type ConfigValues = { [Key in keyof typeof fieldValues]: z.infer<(typeof fieldValues)[Key]> };

const project = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  configured: z.boolean(),
  enabled: z.boolean(),
  allowSync: z.boolean(),
});
const source = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), rootPath: z.string(), rootLength: z.number(), cap: z.number(), branch: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string(), rootPath: z.string().nullable(), rootLength: z.number().nullable(), cap: z.number() }),
]);
const syncHistory = z.object({
  lastAttempt: z.object({
    at: z.number(),
    outcome: z.enum(["updated", "up_to_date", "blocked", "failed"]),
    reason: z.string().nullable(),
  }),
  lastUpdate: z.object({ at: z.number(), from: z.string(), to: z.string() }).nullable(),
});
export const storedSyncHistory = syncHistory.extend({ clonePath: z.string(), branch: z.string() });
export type StoredSyncHistory = z.infer<typeof storedSyncHistory>;

export const statusMethods = {
  "status.projects": { input: z.object({}).strict(), output: z.array(project) },
  "status.detail": {
    input: z.object({ projectId }).strict(),
    output: z.object({
      enabled: z.boolean(),
      allowSync: z.boolean(),
      rootFile: z.string().nullable(),
      source,
      preview: z.string().nullable(),
      skills: z.object({
        selectable: z.array(z.string()),
        skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
        moreSkipped: z.number(),
      }).nullable(),
      sync: syncHistory.nullable(),
    }),
  },
};
export type StatusProject = z.infer<typeof project>;
export type ProjectStatus = z.infer<typeof statusMethods["status.detail"]["output"]>;
