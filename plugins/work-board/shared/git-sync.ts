import { z } from "zod";

export const repositorySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(
    (value) => ![".", ".."].includes(value.split("/")[1]!),
    "Invalid repository",
  )
  .transform((value) => value.toLowerCase());
export const prUrlSchema = z
  .string()
  .url()
  .refine(
    (value) =>
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(
        value,
      ),
    "Use a full https://github.com/owner/repo/pull/number URL",
  )
  .refine((value) => {
    const match = value.match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)$/,
    );
    return Boolean(
      match &&
        repositorySchema.safeParse(match[1]).success &&
        Number.isSafeInteger(Number(match[2])),
    );
  }, "Invalid repository or PR number");
const names = z
  .array(z.string().trim().min(1).max(200))
  .max(50)
  .refine(
    (values) => new Set(values).size === values.length,
    "Duplicate names",
  );
export const overlapRuleSchema = z.object({ pattern: z.string().trim().min(1).max(500), match: z.enum(["added", "changed"]) }).strict();
export const overlapSchema = z.object({ pr: z.object({ repository: repositorySchema, number: z.number().int().positive() }).strict(), otherTaskKey: z.string(), otherPr: z.object({ repository: repositorySchema, number: z.number().int().positive() }).strict(), rule: overlapRuleSchema.nullable(), files: z.array(z.string()) }).strict();
export type Overlap = z.infer<typeof overlapSchema>;
export const gitSyncConfigSchema = z
  .object({
    overlapRules: z.array(overlapRuleSchema).max(50).optional(),
    enabled: z.boolean().default(false),
    repositories: z.array(repositorySchema).max(30).default([]),
    pollMinutes: z.number().int().min(1).max(60).default(5),
    lookbackDays: z.number().int().min(1).max(365).default(30),
    titleDiscovery: z.boolean().default(true),
    requiredChecks: names.default([]),
    postMergeWorkflows: names.max(10).default([]),
    postMergeDays: z.number().int().min(1).max(90).default(7),
  })
  .strict()
  .refine(
    (value) => new Set(value.repositories).size === value.repositories.length,
    "Duplicate repositories",
  );
export const prLinkSchema = z
  .object({
    taskId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    provider: z.literal("github").default("github"),
    host: z.literal("github.com").default("github.com"),
    repository: repositorySchema,
    number: z.number().int().positive(),
    url: prUrlSchema,
    remoteId: z.string().nullable().default(null),
    role: z.enum(["delivers", "design", "related"]).default("related"),
    part: z
      .string()
      .regex(/^[1-9][0-9]*\/[1-9][0-9]*$/)
      .nullable()
      .default(null),
    source: z.enum(["manual", "title", "environment", "evidence"]),
    confirmed: z.boolean(),
    excluded: z.boolean().default(false),
    createdAt: z.iso.datetime({ precision: 3 }),
    updatedAt: z.iso.datetime({ precision: 3 }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = parsePrUrl(value.url);
    if (
      parsed.repository !== value.repository ||
      parsed.number !== value.number
    )
      ctx.addIssue({
        code: "custom",
        message: "PR URL does not match repository/number",
      });
    if (value.part) {
      const [part, count] = value.part.split("/").map(Number);
      if (value.role !== "delivers" || part! > count! || count! > 1000)
        ctx.addIssue({
          code: "custom",
          message: "Part k/m requires delivers, 1 <= k <= m <= 1000",
        });
    }
  });
export function parsePrUrl(value: string) {
  const url = prUrlSchema.parse(value);
  const [, owner, repo, , number] = new URL(url).pathname.split("/");
  return {
    repository: `${owner}/${repo}`.toLowerCase(),
    number: Number(number),
  };
}
export function prIdentity(value: { repository: string; number: number }) {
  return `github:github.com:${value.repository.toLowerCase()}#${value.number}`;
}
const webUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Expected a public HTTPS link");
export const checkSchema = z
  .object({
    name: z.string(),
    app: z.string(),
    appId: z.number().nullable(),
    sha: z.string(),
    url: webUrl.nullable(),
    state: z.enum([
      "passed",
      "failed",
      "pending",
      "skipped",
      "neutral",
      "cancelled",
      "unknown",
    ]),
    required: z.boolean().nullable(),
  })
  .strict();
export const coverageSchema = z
  .object({
    workflow: z.string(),
    state: z.enum(["pending", "passed", "failed", "skipped", "unknown"]),
    runId: z.number().nullable(),
    sha: z.string().nullable(),
    url: webUrl.nullable(),
    superseded: z.boolean(),
    originalRunId: z.number().nullable(),
  })
  .strict();
export const prSnapshotSchema = z
  .object({
    files: z.object({ entries: z.array(z.object({ filename: z.string(), status: z.enum(["added", "modified", "removed", "renamed"]), previous_filename: z.string().optional() }).strict()), truncated: z.boolean() }).optional(),
    repository: repositorySchema,
    number: z.number().int().positive(),
    remoteId: z.string(),
    url: prUrlSchema,
    title: z.string(),
    state: z.enum(["open", "draft", "merged", "closed"]),
    headSha: z.string().regex(/^[a-f0-9]{40}$/i),
    mergeSha: z.string().nullable(),
    mergedAt: z.string().nullable(),
    baseBranch: z.string(),
    updatedAt: z.string(),
    observedAt: z.iso.datetime({ precision: 3 }),
    checks: z.array(checkSchema),
    requirementsKnown: z.boolean(),
    ci: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
    inMergeQueue: z.boolean().nullable().default(null),
    autoMerge: z.boolean().nullable().default(null),
    mergeState: z.string().nullable(),
    mergeable: z.boolean().nullable(),
    review: z.string().nullable(),
    unresolvedThreads: z.number().int().nonnegative().nullable(),
    coverage: z.array(coverageSchema),
  })
  .strict();
export const prLinkStateSchema = z
  .object({
    link: prLinkSchema,
    snapshot: prSnapshotSchema.nullable(),
    stale: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type GitSyncConfig = z.infer<typeof gitSyncConfigSchema>;
export type PrLink = z.infer<typeof prLinkSchema>;
export type PrSnapshot = z.infer<typeof prSnapshotSchema>;
export type PrLinkState = z.infer<typeof prLinkStateSchema>;
export const gitSyncMethods = {
  prSummaries: {
    input: z.object({ taskIds: z.array(z.string()).max(500) }).strict(),
    output: z
      .object({
        summaries: z.array(
          z
            .object({
              taskId: z.string(),
              total: z.number(),
              merged: z.number(),
              failing: z.number(),
              pending: z.number(),
              stale: z.boolean(),
              overlaps: z.array(overlapSchema).default([]),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  getGitSyncConfig: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z
      .object({
        config: gitSyncConfigSchema,
        suggestedRepository: repositorySchema.nullable(),
        availableRepositories: z.array(repositorySchema).default([]),
      })
      .strict(),
  },
  setGitSyncConfig: {
    input: z
      .object({ projectId: z.string(), config: gitSyncConfigSchema })
      .strict(),
    output: z.object({ config: gitSyncConfigSchema }).strict(),
  },
  listPrLinks: {
    input: z.object({ taskId: z.string() }).strict(),
    output: z.object({ links: z.array(prLinkStateSchema), overlaps: z.array(overlapSchema).default([]) }).strict(),
  },
  linkPr: {
    input: z
      .object({
        taskId: z.string(),
        url: prUrlSchema,
        role: z.enum(["delivers", "design", "related"]).default("delivers"),
        part: z.string().nullable().default(null),
      })
      .strict(),
    output: z.object({ link: prLinkSchema }).strict(),
  },
  unlinkPr: {
    input: z.object({ taskId: z.string(), url: prUrlSchema }).strict(),
    output: z.object({ excluded: z.literal(true) }).strict(),
  },
  syncGit: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z
      .object({ checked: z.number(), errors: z.array(z.string()) })
      .strict(),
  },
} as const;
