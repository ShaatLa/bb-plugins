import { checkReceiptSchema, RECEIPT_LIMIT } from "./check-receipt";
import { workflowPolicySchema } from "./workflow-policy.js";
import { taskAdvisorySchema } from "./task-advisories";
import { taskActivitySchema } from "./task-activity.js";
import { storageMethods } from "./storage";
import { gitSyncMethods } from "./git-sync";
import { lockMethods } from "./locks";
import { attentionUiMethods } from "./attention";
import { checksUiMethods } from "./checks";
import { taskDateFiltersSchema } from "./task-dates.js";
import { PLAN_FORMATS, PLAN_OPS, PLAN_STATES } from "./plan";
import { PLAN_NOTE_BODY_MAX, PLAN_NOTE_CONTEXT_MAX, PLAN_NOTE_HEADING_MAX, PLAN_NOTE_KINDS, PLAN_NOTE_QUOTE_MAX, PLAN_NOTE_STATES } from "./plan-notes";
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { archiveSettingSchema, autoArchiveAfterDaysSchema, planningSchema, staleIdleThresholdSchema, statusNotificationsSchema, boardPreferencesSchema } from "./project-settings";
import {
  TASK_SORTS,
  TASKS_PAGE_DEFAULT_LIMIT,
  TASKS_PAGE_MAX_LIMIT,
} from "./pagination.js";

import { taskStatusSchema, taskStatusesSchema } from "./statuses.js";
import { BADGE_CRITERIA } from "./badge.js";
import { globalSettingsPatchSchema } from "./global-settings";
import { cardPauseSchema } from "./pause";
export { TASK_STATUSES } from "./statuses.js";
export type { TaskStatusDefinition } from "./statuses.js";


export const TASK_TYPES = ["task", "epic"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

export const TASK_THREAD_LIVE_STATUSES = [
  "starting",
  "working",
  "idle",
  "completed",
  "failed",
] as const;

export const PRESET_ENVIRONMENT_KINDS = [
  "project-default",
  "new-worktree",
] as const;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const idSchema = z.string().regex(ULID_PATTERN, "must be a ULID");
const nonBlankStringSchema = z.string().trim().min(1, "must not be blank");
export const presetReasoningLevelSchema = nonBlankStringSchema;
export type PresetReasoningLevel = z.infer<typeof presetReasoningLevelSchema>;
export const presetServiceTierSchema = nonBlankStringSchema;
export type PresetServiceTier = z.infer<typeof presetServiceTierSchema>;
export const PRESET_PERMISSION_MODES = [
  "accept-edits",
  "auto",
  "full",
] as const;
export const presetPermissionModeSchema = z.enum(PRESET_PERMISSION_MODES);
export type PresetPermissionMode = z.infer<typeof presetPermissionModeSchema>;
const presetEnvironmentKindSchema = z.enum(PRESET_ENVIRONMENT_KINDS);
const nullablePresetTargetSchema = nonBlankStringSchema.nullable();
const projectPrefixSchema = z
  .string()
  .regex(
    PROJECT_PREFIX_PATTERN,
    "must be uppercase alphanumeric, start with a letter, and contain at most 10 characters",
  );
const dueDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "must be a valid calendar date in YYYY-MM-DD format");
const shaSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{40}$/, "must be a full 40-character git SHA")
  .transform((value) => value.toLowerCase());
const evidenceThreadSchema = z
  .string()
  .regex(/^thr_[A-Za-z0-9_-]+$/, "must be a bb thread id");
export const EVIDENCE_KINDS = [
  "review",
  "qa",
  "merge",
  "deploy",
  "exemption",
  "outcome",
] as const;
export const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("outcome"), recordedByThread: evidenceThreadSchema.nullable().optional() }).strict(),
  z
    .object({
      kind: z.literal("review"),
      recordedByThread: evidenceThreadSchema.nullable().optional(),
      // Optional: sessions review a frozen head before its PR exists; the index then associates the head with a PR.
      pr: z.number().int().positive().optional(),
      head: shaSchema,
      verdict: z.enum(["approve", "changes"]),
      thread: evidenceThreadSchema,
      lens: nonBlankStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("qa"),
      recordedByThread: evidenceThreadSchema.nullable().optional(),
      head: shaSchema,
      verdict: z.enum(["pass", "fail", "partial"]),
      thread: evidenceThreadSchema,
      pr: z.number().int().positive().optional(),
      target: z.enum(["local", "development", "localenv"]).optional(),
      note: nonBlankStringSchema
        .refine(
          (value) =>
            !value.startsWith("/") &&
            !value.split(/[\\/]/).includes("..") &&
            !value.includes("://"),
          "must be a repository-relative path",
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge"),
      recordedByThread: evidenceThreadSchema.nullable().optional(),
      pr: z.number().int().positive(),
      head: shaSchema,
      merge: shaSchema,
      part: z
        .string()
        .regex(/^[1-9]\d*\/[1-9]\d*$/)
        .refine((value) => {
          const [part, total] = value.split("/").map(Number);
          return part! <= total!;
        }, "part must not exceed total")
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deploy"),
      recordedByThread: evidenceThreadSchema.nullable().optional(),
      pr: z.number().int().positive().optional(),
      merge: shaSchema,
      run: nonBlankStringSchema,
      env: z.enum(["development", "production"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("exemption"),
      recordedByThread: evidenceThreadSchema.nullable().optional(),
      row: nonBlankStringSchema,
      reason: nonBlankStringSchema,
      ownerQuote: nonBlankStringSchema.optional(),
      date: dueDateSchema.optional(),
    })
    .strict()
    .refine(
      (value) => Boolean(value.ownerQuote) === Boolean(value.date),
      "owner quote and date must be supplied together",
    ),
]);
export type Evidence = z.infer<typeof evidenceSchema>;

const questionOptionInputSchema = z
  .object({
    label: nonBlankStringSchema.max(500),
    recommended: z.boolean().optional(),
    recommendationReason: nonBlankStringSchema.max(2000).optional(),
  })
  .strict();

const beyondDesignSchema = z.string().trim().min(1).max(500);
export const smokeSchema = z.string().trim().min(20).max(2000);
const readinessInputs = {
  receipt: z.string().refine(s => Buffer.byteLength(s) <= RECEIPT_LIMIT, "Receipt exceeds 256 KB").optional(),
  smoke: smokeSchema.optional(),
  beyondDesign: beyondDesignSchema.optional(),
};

const questionStateSchema = z
  .object({
    kind: z.enum(["decision", "check"]).default("decision"),
    askedByThread: evidenceThreadSchema.nullable().default(null),
    prompt: nonBlankStringSchema.max(10_000),
    beyondDesign: beyondDesignSchema.optional(),
    /** "How to check": short ordered steps shown under the prompt. */
    steps: z.array(nonBlankStringSchema.max(500)).max(10).default([]),
    mode: z.enum(["single", "multiple"]),
    options: z
      .array(questionOptionInputSchema.extend({ id: idSchema }))
      .min(1)
      .max(20),
    allowOther: z.boolean().default(false),
    selectedOptionIds: z.array(idSchema),
    answerText: nonBlankStringSchema.max(10_000).nullable().default(null),
    answeredBy: nonBlankStringSchema.nullable(),
    revision: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.options.map((option) => option.id);
    if (
      value.options.some(
        (option) => option.recommendationReason && !option.recommended,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "A recommendation reason requires recommended=true",
      });
    if (
      value.mode === "single" &&
      value.options.filter((option) => option.recommended).length > 1
    )
      ctx.addIssue({
        code: "custom",
        message: "Single-choice questions allow only one recommended option",
      });
    if (
      new Set(ids).size !== ids.length ||
      new Set(value.options.map((option) => option.label)).size !== ids.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Question options must have unique IDs and labels",
      });
    if (
      new Set(value.selectedOptionIds).size !==
        value.selectedOptionIds.length ||
      value.selectedOptionIds.some((id) => !ids.includes(id)) ||
      // A check answer is a verdict plus an optional comment; a single-choice decision is one option or text.
      (value.mode === "single" &&
        (value.kind === "check" ? value.selectedOptionIds.length > 1 : value.selectedOptionIds.length + Number(value.answerText !== null) > 1))
    )
      ctx.addIssue({ code: "custom", message: "Invalid question answer" });
    if (
      Boolean(value.answeredBy) !==
      (value.selectedOptionIds.length > 0 || value.answerText !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Answer author must match the saved answer",
      });
  });

/** The wake a question write sent the plan reviewer: `failed` lists the threads that could not be told, `hint` says what to do by hand. */
export const planWakeSchema = z
  .object({ event: z.enum(["paused", "resumed"]), delivered: z.enum(["sent", "failed"]), failed: z.array(z.string()), hint: z.string().nullable() })
  .strict();
export type PlanWake = z.infer<typeof planWakeSchema>;
export const questionSchema = questionStateSchema
  .safeExtend({
    id: idSchema,
    taskId: idSchema,
    createdAt: z.string(),
    history: z.array(questionStateSchema).default([]),
    /** Supersession links live outside the revision history: replacing a check keeps its revision and answer. */
    supersedes: idSchema.optional(),
    supersededBy: idSchema.optional(),
    supersededAt: z.iso.datetime().optional(),
    withdrawnAt: z.iso.datetime().optional(),
    withdrawnBy: nonBlankStringSchema.optional(),
    withdrawReason: nonBlankStringSchema.max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.supersededBy === undefined) !== (value.supersededAt === undefined))
      ctx.addIssue({ code: "custom", message: "supersededBy and supersededAt go together" });
    const withdrawn = value.withdrawnAt !== undefined;
    if (withdrawn !== (value.withdrawnBy !== undefined) || withdrawn !== (value.withdrawReason !== undefined))
      ctx.addIssue({ code: "custom", message: "withdrawnAt, withdrawnBy and withdrawReason go together" });
    if (withdrawn && (value.answeredBy || value.supersededBy))
      ctx.addIssue({ code: "custom", message: "An answered or superseded question cannot be withdrawn" });
    let previous = 0;
    for (const entry of value.history) {
      if (entry.revision <= previous || entry.revision >= value.revision)
        ctx.addIssue({
          code: "custom",
          message:
            "Question history revisions must increase before the current revision",
        });
      previous = entry.revision;
    }
  });
export type TaskQuestion = z.infer<typeof questionSchema> & {
  answerCommentId?: string | null;
  answerAttachments?: { id: string; fileName: string; mime: string; sizeBytes: number }[];
};
export const templateSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    name: nonBlankStringSchema.max(100),
    body: z.string(),
    labelId: idSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type DescriptionTemplate = z.infer<typeof templateSchema>;
const taskPrioritySchema = z.enum(TASK_PRIORITIES);
const taskSortSchema = z.enum(TASK_SORTS);
const threadSearchStatusSchema = z.enum([
  "pending",
  "idle",
  "starting",
  "active",
  "stopping",
  "error",
]);

export const folderSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    parentFolderId: idSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();

export const projectSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    prefix: projectPrefixSchema,
    nextTaskNumber: z.number().int().positive(),
    workflowPolicy: workflowPolicySchema.optional(),
    statuses: taskStatusesSchema.optional(),
    autoArchiveAfterDays: autoArchiveAfterDaysSchema.optional(),
    staleIdleMinutes: staleIdleThresholdSchema.optional(),
    statusNotifications: statusNotificationsSchema.optional(),
    /** v21: archive the sessions Work Board created for a card when it closes (default on). */
    archiveThreadsOnClose: archiveSettingSchema.optional(),
    /** v21: archive a dedicated plan reviewer after it approved the plan (default on). */
    checkReceipt: checkReceiptSchema.optional(),
    checkReadiness: archiveSettingSchema.optional(),
    doneRequiresReview: archiveSettingSchema.optional(),
    archiveReviewerOnApproval: archiveSettingSchema.optional(),
    planning: planningSchema.optional(),
    /** False until the "only with an approved plan" flags were set up (by the owner, or by the first switch to required). */
    planFlagsInitialized: z.boolean().optional(),
    /** When planning last changed and what it was before; null until the first change. */
    planningChangedAt: z.string().nullable().optional(),
    planningPrevious: planningSchema.nullable().optional(),
    color: z.string(),
    folderId: idSchema.nullable(),
    linkedBbProjectId: z.string().startsWith("proj_").nullable(),
    createdAt: z.string(),
  })
  .strict();

export const taskSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    number: z.number().int().positive(),
    key: z.string(),
    title: z.string(),
    description: z.string(),
    progressNote: z.string().nullable().default(null),
    progressUpdatedAt: z.string().nullable().default(null),
    progressUpdatedBy: z.string().nullable().default(null),
    status: taskStatusSchema,
    archivedAt: z.iso.datetime({ precision: 3 }).nullable().optional(),
    priority: taskPrioritySchema,
    dueDate: dueDateSchema.nullable(),
    parentTaskId: idSchema.nullable(),
    type: z.enum(TASK_TYPES).default("task"),
    epicId: idSchema.nullable().default(null),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    labelIds: z.array(idSchema),
  })
  .strict();

export const dependencyTaskSchema = taskSchema.pick({
  id: true, projectId: true, key: true, title: true, status: true,
});
export type DependencyTask = z.infer<typeof dependencyTaskSchema>;
export const taskDependenciesSchema = z.object({
  blockedBy: z.array(dependencyTaskSchema),
  blocks: z.array(dependencyTaskSchema),
  related: z.array(dependencyTaskSchema),
}).strict();

export const labelSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    color: z.string(),
  })
  .strict();

export const commentSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    kind: z.enum(["user", "agent", "system"]),
    authorName: z.string(),
    presetName: z.string().nullable(),
    threadId: z.string().startsWith("thr_").nullable(),
    body: z.string(),
    evidence: evidenceSchema.optional(),
    notifiedCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();

const commentProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    icon: z.object({ glyph: z.string() }).strict().nullable(),
    strings: z
      .object({
        iconTint: z
          .object({ light: z.string(), dark: z.string() })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

const displayCommentSchema = commentSchema
  .extend({
    threadTitle: z.string().nullable(),
    provider: commentProviderSchema.nullable(),
  })
  .strict();

export const attachmentSchema = z
  .object({
    id: idSchema,
    taskId: idSchema.nullable(),
    commentId: idSchema.nullable(),
    fileName: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    isImage: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

export const taskThreadSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    threadId: z.string().startsWith("thr_"),
    presetName: z.string(),
    title: z.string(),
    liveStatus: z.enum(TASK_THREAD_LIVE_STATUSES),
    attachedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const costSpanSchema = z
  .object({ threadId: z.string(), from: z.number(), to: z.number().nullable() })
  .strict();

export const threadHealthSchema = z
  .object({
    failed: z.array(z.object({ threadId: z.string().startsWith("thr_"), title: z.string(), failedAt: z.string() }).strict()),
    // Armed idle state: the UI compares `since` with its own clock so the marker appears without a server push.
    idle: z.object({ threadId: z.string().startsWith("thr_"), since: z.string(), thresholdMinutes: z.number().int().positive() }).strict().nullable(),
  })
  .strict();

const taskPullRequestSchema = z
  .object({
    url: z.string().url(),
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["open", "draft", "merged", "closed"]),
    updatedAt: z.string(),
    threadIds: z.array(z.string().startsWith("thr_")).min(1),
  })
  .strict();

const presetSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    reasoningLevel: presetReasoningLevelSchema,
    serviceTier: presetServiceTierSchema.nullable(),
    permissionMode: presetPermissionModeSchema,
    environmentKind: presetEnvironmentKindSchema,
    baseBranch: nullablePresetTargetSchema,
    machineId: nullablePresetTargetSchema,
    instructions: z.string(),
    builtin: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

const tasksDomainErrorSchema = z
  .object({
    code: z.enum([
      "task_parent_invalid",
      "task_epic_invalid",
      "task_execution_invalid",
      "secret_detected",
      "subtask_depth_exceeded",
      "subtask_project_mismatch",
      "label_project_mismatch",
      "project_not_empty",
      "project_prefix_conflict",
      "attachment_referenced",
      "idempotency_target_gone",
      "due_date_conflict",
    ]),
    message: z.string(),
    currentDueDate: dueDateSchema.nullable().optional(),
  })
  .strict();

/** What happened to one session linked to a card that this change closed. */
export const closedThreadSchema = z
  .object({ threadId: z.string(), action: z.enum(["archived", "on_idle", "kept"]), reason: z.string().nullable() })
  .strict();
export type ClosedThread = z.infer<typeof closedThreadSchema>;

const taskMutationResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      task: taskSchema,
      /** Only when the change closed the card: the fate of every linked session. */
      closedThreads: z.array(closedThreadSchema).optional(),
      /** Only when the call asked to attach its own thread: whether that link was made, and why not. */
      attached: z.boolean().optional(),
      attachWarning: z.string().optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

const projectMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), project: projectSchema }).strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

const projectDeleteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), deleted: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

const attachmentDeleteResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      deleted: z.literal(true),
      attachment: attachmentSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      deleted: z.literal(false),
      attachment: z.null(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

const taskLabelsSchema = z
  .array(idSchema)
  .max(100)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "must not contain duplicates",
  );

const updateTaskInputSchema = z
  .object({
    taskId: idSchema,
    title: nonBlankStringSchema.optional(),
    description: z.string().optional(),
    progressNote: z.string().nullable().optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    dueDate: dueDateSchema.nullable().optional(),
    expectedDueDate: dueDateSchema.nullable().optional(),
    parentTaskId: idSchema.nullable().optional(),
    type: z.enum(TASK_TYPES).optional(),
    epicId: idSchema.nullable().optional(),
    labelIds: taskLabelsSchema.optional(),
    agentThreadId: evidenceThreadSchema.nullable().optional(),
    /** Attach the calling thread (`agentThreadId`) to the card in the same write; only with a progress note, as `update --progress` does. */
    attachCaller: z.boolean().optional(),
    authorName: nonBlankStringSchema.default("You"),
  })
  .strict()
  .refine((input) => input.expectedDueDate === undefined || input.dueDate !== undefined, { message: "expectedDueDate requires dueDate" })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.progressNote !== undefined ||
      input.status !== undefined ||
      input.priority !== undefined ||
      input.dueDate !== undefined ||
      input.parentTaskId !== undefined ||
      input.type !== undefined ||
      input.epicId !== undefined ||
      input.labelIds !== undefined,
    { message: "at least one task field must be updated" },
  );

const updateProjectInputSchema = z
  .object({
    projectId: idSchema,
    name: nonBlankStringSchema.optional(),
    workflowPolicy: workflowPolicySchema.optional(),
    statuses: taskStatusesSchema.optional(),
    // The stored statuses `statuses` was built on: the write is refused when they changed meanwhile.
    baseStatuses: taskStatusesSchema.optional(),
    autoArchiveAfterDays: autoArchiveAfterDaysSchema.optional(),
    staleIdleMinutes: staleIdleThresholdSchema.optional(),
    statusNotifications: statusNotificationsSchema.optional(),
    archiveThreadsOnClose: archiveSettingSchema.optional(),
    checkReceipt: checkReceiptSchema.optional(),
    checkReadiness: archiveSettingSchema.optional(),
    doneRequiresReview: archiveSettingSchema.optional(),
    archiveReviewerOnApproval: archiveSettingSchema.optional(),
    planning: planningSchema.optional(),
    color: nonBlankStringSchema.optional(),
    folderId: idSchema.nullable().optional(),
    linkedBbProjectId: z.string().startsWith("proj_").nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.workflowPolicy !== undefined ||
      input.statuses !== undefined ||
      input.autoArchiveAfterDays !== undefined ||
      input.staleIdleMinutes !== undefined ||
      input.statusNotifications !== undefined ||
      input.archiveThreadsOnClose !== undefined ||
      input.checkReceipt !== undefined ||
      input.checkReadiness !== undefined ||
      input.doneRequiresReview !== undefined ||
      input.archiveReviewerOnApproval !== undefined ||
      input.planning !== undefined ||
      input.name !== undefined ||
      input.color !== undefined ||
      input.folderId !== undefined ||
      input.linkedBbProjectId !== undefined,
    { message: "at least one project field must be updated" },
  );

const updateLabelInputSchema = z
  .object({
    labelId: idSchema,
    name: nonBlankStringSchema.optional(),
    color: nonBlankStringSchema.optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.color !== undefined, {
    message: "at least one label field must be updated",
  });

const updatePresetInputSchema = z
  .object({
    presetId: idSchema,
    name: nonBlankStringSchema.optional(),
    providerId: nonBlankStringSchema.optional(),
    modelId: nonBlankStringSchema.optional(),
    reasoningLevel: presetReasoningLevelSchema.optional(),
    serviceTier: presetServiceTierSchema.nullable().optional(),
    permissionMode: presetPermissionModeSchema.optional(),
    environmentKind: presetEnvironmentKindSchema.optional(),
    baseBranch: nullablePresetTargetSchema.optional(),
    machineId: nullablePresetTargetSchema.optional(),
    instructions: z.string().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.providerId !== undefined ||
      input.modelId !== undefined ||
      input.reasoningLevel !== undefined ||
      input.serviceTier !== undefined ||
      input.permissionMode !== undefined ||
      input.environmentKind !== undefined ||
      input.baseBranch !== undefined ||
      input.machineId !== undefined ||
      input.instructions !== undefined,
    { message: "at least one preset field must be updated" },
  )
  .superRefine((input, ctx) => {
    if (
      input.environmentKind === "project-default" &&
      input.baseBranch !== undefined &&
      input.baseBranch !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["baseBranch"],
        message: "requires environmentKind new-worktree",
      });
    }
    if (
      input.environmentKind === "project-default" &&
      input.machineId !== undefined &&
      input.machineId !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["machineId"],
        message: "requires environmentKind new-worktree",
      });
    }
  });

const sequenceNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const sequenceNumberSchema = z.number().int().nonnegative().safe();
const sequenceSchema = z.object({ projectId: idSchema, name: sequenceNameSchema, next: sequenceNumberSchema, format: z.string() }).strict();
const sequenceClaimSchema = z.object({ id: z.number().int(), projectId: idSchema, name: sequenceNameSchema, value: sequenceNumberSchema, rendered: z.string(), taskId: idSchema.nullable(), taskKey: z.string(), prUrl: z.string().nullable(), threadId: z.string().nullable(), claimedAt: z.string(), state: z.enum(["active", "released"]), releasedAt: z.string().nullable(), reason: z.string().nullable() }).strict();
const sequenceKeySchema = z.object({ projectId: idSchema, name: sequenceNameSchema }).strict();

export const planAuthorSchema = z
  .object({
    kind: z.enum(["agent", "person"]),
    threadId: z.string().regex(/^thr_/).nullable().default(null),
    name: nonBlankStringSchema,
  })
  .strict();
export const planStateSchema = z.enum(PLAN_STATES);
/** Version metadata; bodies are read one version at a time. */
export const planVersionSchema = z
  .object({
    version: z.number().int().min(1),
    baseVersion: z.number().int().min(0),
    op: z.enum(PLAN_OPS),
    target: z.string().nullable(),
    summary: z.string(),
    author: planAuthorSchema,
    createdAt: z.string(),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
  })
  .strict();
/** Who approves the plan: the owner, or a reviewer thread. A plan stored before reviewers existed has the owner. */
export const planReviewerSchema = z
  .object({ kind: z.enum(["owner", "thread"]), threadId: z.string().regex(/^thr_/).nullable().default(null) })
  .strict();
export const taskPlanHeadSchema = z
  .object({
    taskId: idSchema,
    format: z.enum(PLAN_FORMATS),
    version: z.number().int().min(1),
    state: planStateSchema,
    updatedAt: z.string(),
    updatedBy: planAuthorSchema,
    reviewer: planReviewerSchema,
    /** The version that was submitted for review; null when the plan was never submitted with a reviewer. */
    reviewVersion: z.number().int().min(1).nullable(),
  })
  .strict();
export const PLAN_REVIEW_OUTCOMES = ["pending", "changes_requested", "approved", "superseded", "reassigned"] as const;
/** One review attempt: a plan version, the reviewer it went to and how that attempt ended. */
export const planReviewSchema = z
  .object({
    version: z.number().int().min(1),
    reviewer: planReviewerSchema,
    submittedByThread: z.string().regex(/^thr_/).nullable(),
    submittedAt: z.string(),
    outcome: z.enum(PLAN_REVIEW_OUTCOMES),
    decidedAt: z.string().nullable(),
    decidedBy: z.string().nullable(),
  })
  .strict();
const planErrorCodes = ["planning_off", "plan_conflict", "plan_no_change", "plan_invalid", "plan_archived", "plan_state", "secret_detected"] as const;
const planErrorSchema = z
  .object({
    code: z.enum(planErrorCodes),
    message: z.string(),
  })
  .strict();
const planMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), plan: taskPlanHeadSchema, version: planVersionSchema.nullable() }).strict(),
  z.object({ ok: z.literal(false), error: planErrorSchema }).strict(),
]);
/** `owner` or a thread id; the plan author picks it on submit. */
export const planReviewerInputSchema = z.string().regex(/^(owner|thr_[A-Za-z0-9_-]+)$/, "use owner or a thread id such as thr_example");
const planSubmitResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      plan: taskPlanHeadSchema,
      version: z.null(),
      /** `submitted` is a new review, `resent` a repeat to the same reviewer (no new event), `reassigned` a change of reviewer. */
      outcome: z.enum(["submitted", "resent", "reassigned"]),
      /** The wake of the reviewer thread; null when the owner reviews. */
      delivered: z.enum(["sent", "failed"]).nullable(),
      /** What to do when the wake failed. */
      deliveryHint: z.string().nullable(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: planErrorSchema }).strict(),
]);
const planDeliverySchema = z.enum(["sent", "failed", "no_thread"]);
/** An owner's state change; `deliveries` lists who was told about an approval or a request for changes (empty when nothing was sent). */
const planStateResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      plan: taskPlanHeadSchema,
      version: planVersionSchema.nullable(),
      deliveries: z.array(z.object({ role: z.enum(["actor", "copy"]), delivered: planDeliverySchema, threadId: z.string().nullable() }).strict()).default([]),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: planErrorSchema }).strict(),
]);
const planWriteBase = { taskId: idSchema, baseVersion: z.number().int().min(0), summary: z.string(), author: planAuthorSchema };
const savePlanInputSchema = z.discriminatedUnion("op", [
  z.object({ ...planWriteBase, op: z.literal("replace"), body: z.string() }).strict(),
  z.object({ ...planWriteBase, op: z.literal("section"), section: z.string(), body: z.string() }).strict(),
  z.object({ ...planWriteBase, op: z.literal("fragment"), find: z.string(), replace: z.string() }).strict(),
  z.object({ ...planWriteBase, op: z.literal("restore"), restoreVersion: z.number().int().min(1) }).strict(),
]);
export const SETTABLE_PLAN_STATES = ["in_review", "approved", "changes_requested"] as const;

export const planNoteKindSchema = z.enum(PLAN_NOTE_KINDS);
export const planNoteStateSchema = z.enum(PLAN_NOTE_STATES);
/** An owner's note on the plan; the anchor (exact, prefix, suffix) is null for a general note. */
export const planNoteSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    number: z.number().int().min(1),
    kind: planNoteKindSchema,
    exact: z.string().max(PLAN_NOTE_QUOTE_MAX).nullable(),
    prefix: z.string().max(PLAN_NOTE_CONTEXT_MAX).nullable(),
    suffix: z.string().max(PLAN_NOTE_CONTEXT_MAX).nullable(),
    headingPath: z.string().max(PLAN_NOTE_HEADING_MAX).nullable(),
    madeOnVersion: z.number().int().min(1),
    body: z.string().max(PLAN_NOTE_BODY_MAX),
    state: planNoteStateSchema,
    sentInVersion: z.number().int().min(1).nullable(),
    sentAt: z.string().nullable(),
    reply: z.string().max(PLAN_NOTE_BODY_MAX).nullable(),
    replyBy: z.string().nullable(),
    repliedAt: z.string().nullable(),
    addressedInVersion: z.number().int().min(1).nullable(),
    authorName: nonBlankStringSchema,
    /** `person` is the owner; `thread` is a reviewer thread. Older notes are the owner's. */
    authorKind: z.enum(["person", "thread"]).default("person"),
    authorThread: z.string().regex(/^thr_/).nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
/** Notes per state; `open` are the sent ones the agent has not answered yet. */
export const planNoteCountsSchema = z
  .object({ draft: z.number().int().min(0), open: z.number().int().min(0), addressed: z.number().int().min(0), resolved: z.number().int().min(0) })
  .strict();
const planNoteErrorSchema = z
  .object({ code: z.enum(planErrorCodes), message: z.string() })
  .strict();
const planNoteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), note: planNoteSchema }).strict(),
  z.object({ ok: z.literal(false), error: planNoteErrorSchema }).strict(),
]);
const createPlanNoteInputSchema = z
  .object({
    taskId: idSchema,
    kind: planNoteKindSchema,
    exact: z.string().max(PLAN_NOTE_QUOTE_MAX).nullish(),
    prefix: z.string().max(PLAN_NOTE_CONTEXT_MAX).nullish(),
    suffix: z.string().max(PLAN_NOTE_CONTEXT_MAX).nullish(),
    headingPath: z.string().max(PLAN_NOTE_HEADING_MAX).nullish(),
    /** The version the selection was made on; defaults to the current one. */
    madeOnVersion: z.number().int().min(1).optional(),
    body: z.string().max(PLAN_NOTE_BODY_MAX).default(""),
    authorName: nonBlankStringSchema.default("You"),
  })
  .strict();
const planReviewResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      plan: taskPlanHeadSchema,
      delivered: planDeliverySchema,
      threadId: z.string().nullable(),
      /** One entry per recipient: the actor, who gets the actionable message, and an informational copy for the other thread. */
      deliveries: z.array(z.object({ role: z.enum(["actor", "copy"]), delivered: planDeliverySchema, threadId: z.string().nullable() }).strict()),
      notes: z.number().int().min(0),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: planNoteErrorSchema }).strict(),
]);

const queueEntrySchema = z.object({ taskId: idSchema, key: z.string(), title: z.string(), status: z.string(), position: z.number().int().positive(), addedBy: z.string(), addedAt: z.string() }).strict();
const queueSchema = z.object({ projectId: idSchema, threadId: z.string(), entries: z.array(queueEntrySchema) }).strict();
const queueResultSchema = z.object({ changeId: z.string(), taskId: idSchema, threadId: z.string(), projectId: idSchema, position: z.number().int().positive() }).strict();
/** Where a card stands in an executor's work queue; 1 is the current card. */
export const cardQueueSchema = z.object({ threadId: z.string(), position: z.number().int().positive() }).strict();

export const tasksRpcContract = {
  pauseReport: {
    input: z.object({ projectId: idSchema, since: z.string().datetime().optional(), until: z.string().datetime().optional() }).strict(),
    output: z.record(z.string(), z.unknown()),
  },
  updatePauseMode: {
    input: z.object({ projectId: idSchema, mode: z.enum(["off", "ab", "on"]) }).strict(),
    output: z.object({ mode: z.enum(["off", "ab", "on"]) }).strict(),
  },
  // The manual work queue of an executor thread: an ordered list of cards; the first is current.
  queueList: {
    input: z.object({ threadId: z.string().startsWith("thr_").optional(), projectId: idSchema.optional() }).strict().refine((value) => value.threadId || value.projectId, "threadId or projectId is required"),
    output: z.object({ queues: z.array(queueSchema) }).strict(),
  },
  queueAdd: {
    input: z.object({ taskId: idSchema, threadId: z.string().startsWith("thr_"), position: z.number().int().min(1).optional(), actor: z.string().min(1) }).strict(),
    output: queueResultSchema,
  },
  queueMove: {
    input: z.object({ taskId: idSchema, position: z.number().int().min(1), actor: z.string().min(1) }).strict(),
    output: queueResultSchema,
  },
  queueRemove: {
    input: z.object({ taskId: idSchema, actor: z.string().min(1) }).strict(),
    output: queueResultSchema,
  },
  queueReport: {
    input: z.object({ projectId: idSchema, since: z.string().datetime().optional() }).strict(),
    output: z.record(z.string(), z.unknown()),
  },
  updateQueueMode: {
    input: z.object({ projectId: idSchema, mode: z.enum(["off", "trial", "on"]) }).strict(),
    output: z.object({ mode: z.enum(["off", "trial", "on"]) }).strict(),
  },
  pauseTask: {
    input: z.object({ taskId: idSchema, reason: z.string().trim().min(1).max(300), durationMs: z.number().int().min(60000).max(28800000), actor: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true), until: z.string() }).strict(),
  },
  resumeTask: {
    input: z.object({ taskId: idSchema, actor: z.string().min(1) }).strict(),
    output: z.object({ ended: z.number().int().nonnegative() }).strict(),
  },
  listPauses: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ pauses: z.array(z.object({ id: z.string(), source: z.string(), signal: z.string(), threadId: z.string(), reason: z.string(), startedAt: z.string(), until: z.string().nullable() }).strict()), automatic: z.string() }).strict(),
  },
  listPauseLog: {
    input: z.object({ taskId: idSchema.optional(), projectId: idSchema.optional(), since: z.string().datetime().optional(), cursor: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(50) }).strict(),
    output: z.object({ entries: z.array(z.record(z.string(), z.unknown())), nextCursor: z.number().nullable() }).strict(),
  },
  // One per-project setting at a time; without a key, get lists them all.
  "config.get": {
    input: z.object({ projectId: z.string(), key: z.string().optional() }).strict(),
    output: z.object({ projectId: z.string(), values: z.record(z.string(), z.unknown()) }).strict(),
  },
  // `expected` (git.* keys): the stored value the change was built on; the write is refused when it differs.
  "config.set": {
    input: z.object({ projectId: z.string(), key: z.string(), value: z.unknown(), expected: z.unknown().optional() }).strict(),
    output: z.object({ projectId: z.string(), key: z.string(), value: z.unknown() }).strict(),
  },
  // The native global fields Work Board owns, written only for the keys given; the settings page's General group.
  // `expected`: the stored values the change was built on; a write over values changed meanwhile is refused.
  "globalSettings.set": {
    input: z.object({ values: globalSettingsPatchSchema, expected: globalSettingsPatchSchema.optional() }).strict(),
    output: z.object({ values: globalSettingsPatchSchema }).strict(),
  },
  // The stored native fields with their defaults, for a page that has to reread them after a refused write.
  "globalSettings.get": {
    input: z.object({}).strict(),
    output: z.object({ values: globalSettingsPatchSchema }).strict(),
  },
  ...storageMethods,
  listTaskDependencies: {
    input: z.object({ taskId: idSchema }).strict(),
    output: taskDependenciesSchema,
  },
  addTaskDependency: {
    input: z.object({ taskId: idSchema, blockingTaskId: idSchema, authorName: nonBlankStringSchema.default("Owner") }).strict(),
    output: z.object({ changed: z.boolean() }).strict(),
  },
  removeTaskDependency: {
    input: z.object({ taskId: idSchema, blockingTaskId: idSchema, authorName: nonBlankStringSchema.default("Owner") }).strict(),
    output: z.object({ changed: z.boolean() }).strict(),
  },
  addTaskRelation: {
    input: z.object({ taskId: idSchema, relatedTaskId: idSchema, authorName: nonBlankStringSchema.default("Owner") }).strict(),
    output: z.object({ changed: z.boolean() }).strict(),
  },
  removeTaskRelation: {
    input: z.object({ taskId: idSchema, relatedTaskId: idSchema, authorName: nonBlankStringSchema.default("Owner") }).strict(),
    output: z.object({ changed: z.boolean() }).strict(),
  },
  ...gitSyncMethods,
  createSequence: { input: sequenceKeySchema.extend({ next: sequenceNumberSchema, format: z.string().max(40).default("{n}") }), output: z.object({ sequence: sequenceSchema }).strict() },
  listSequences: { input: z.object({ projectId: idSchema }).strict(), output: z.object({ sequences: z.array(sequenceSchema) }).strict() },
  showSequence: { input: sequenceKeySchema, output: z.object({ sequence: sequenceSchema, claims: z.array(sequenceClaimSchema) }).strict() },
  setSequenceNext: { input: sequenceKeySchema.extend({ next: sequenceNumberSchema, force: z.boolean().default(false) }), output: z.object({ sequence: sequenceSchema }).strict() },
  deleteSequence: { input: sequenceKeySchema, output: z.object({ deleted: z.boolean() }).strict() },
  claimSequence: { input: sequenceKeySchema.extend({ taskId: idSchema, prUrl: z.string().url().nullable().default(null), threadId: z.string().nullable().default(null), another: z.boolean().default(false) }), output: z.object({ claim: sequenceClaimSchema }).strict() },
  releaseClaim: { input: sequenceKeySchema.extend({ value: sequenceNumberSchema, reason: nonBlankStringSchema }), output: z.object({ claim: sequenceClaimSchema }).strict() },
  listTaskClaims: { input: z.object({ taskId: idSchema }).strict(), output: z.object({ claims: z.array(sequenceClaimSchema) }).strict() },

  ...lockMethods,
  ...attentionUiMethods,
  ...checksUiMethods,
  createFolder: {
    input: z
      .object({
        name: nonBlankStringSchema,
        parentFolderId: idSchema.nullable().default(null),
      })
      .strict(),
    output: z.object({ folder: folderSchema }).strict(),
  },
  renameFolder: {
    input: z
      .object({ folderId: idSchema, name: nonBlankStringSchema })
      .strict(),
    output: z.object({ folder: folderSchema }).strict(),
  },
  moveFolder: {
    input: z
      .object({ folderId: idSchema, parentFolderId: idSchema.nullable() })
      .strict(),
    output: z.object({ folder: folderSchema }).strict(),
  },
  deleteFolder: {
    input: z.object({ folderId: idSchema }).strict(),
    output: z
      .object({
        deleted: z.boolean(),
        movedProjectIds: z.array(idSchema),
        movedFolderIds: z.array(idSchema),
      })
      .strict(),
  },
  listFolders: {
    input: z.null(),
    output: z.object({ folders: z.array(folderSchema) }).strict(),
  },
  getBoardPreferences: {
    input: z.null(),
    output: boardPreferencesSchema,
  },
  setBoardPreferences: {
    input: boardPreferencesSchema,
    output: boardPreferencesSchema,
  },
  createProject: {
    input: z
      .object({
        name: nonBlankStringSchema,
        prefix: projectPrefixSchema,
        color: nonBlankStringSchema,
        folderId: idSchema.nullable().default(null),
        linkedBbProjectId: z
          .string()
          .startsWith("proj_")
          .nullable()
          .default(null),
      })
      .strict(),
    output: z.object({ project: projectSchema }).strict(),
  },
  updateProject: {
    input: updateProjectInputSchema,
    output: z.object({ project: projectSchema }).strict(),
  },
  renameProjectPrefix: {
    input: z
      .object({ projectId: idSchema, prefix: projectPrefixSchema })
      .strict(),
    output: projectMutationResultSchema,
  },
  deleteProject: {
    input: z
      .object({ projectId: idSchema, force: z.boolean().default(false) })
      .strict(),
    output: projectDeleteResultSchema,
  },
  listProjects: {
    input: z.object({ folderId: idSchema.nullable().optional() }).strict(),
    output: z.object({ projects: z.array(projectSchema) }).strict(),
  },
  createTask: {
    input: z
      .object({
        projectId: idSchema,
        idempotencyKey: z.string().min(1).max(200).optional(),
        agentThreadId: evidenceThreadSchema.nullable().optional(),
        title: nonBlankStringSchema,
        description: z.string().default(""),
        status: taskStatusSchema.default("backlog"),
        priority: taskPrioritySchema.default("none"),
        dueDate: dueDateSchema.nullable().default(null),
        parentTaskId: idSchema.nullable().default(null),
        type: z.enum(TASK_TYPES).default("task"),
        epicId: idSchema.nullable().default(null),
        labelIds: taskLabelsSchema.default([]),
        template: nonBlankStringSchema.optional(),
        // Ignored since executors were removed (0.33); still accepted because Answers sends it.
        requesterThreadId: z.string().nullable().optional(),
      })
      .strict(),
    output: taskMutationResultSchema,
  },
  listQuestions: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ questions: z.array(questionSchema.safeExtend({
      answerCommentId: idSchema.nullable().optional(),
      answerAttachments: z.array(z.object({ id: idSchema, fileName: z.string(), mime: z.string(), sizeBytes: z.number().int().nonnegative() }).strict()).optional(),
    })) }).strict(),
  },
  questionCounts: {
    input: z.object({ taskIds: z.array(idSchema).max(500) }).strict(),
    output: z
      .object({
        counts: z.array(
          z
            .object({
              taskId: idSchema,
              unanswered: z.number().int().nonnegative(),
              decisions: z.number().int().nonnegative().default(0),
              checks: z.number().int().nonnegative().default(0),
              waitingOnOwner: z.boolean().default(false),
              newestUnansweredAt: z.string().nullable().default(null),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  createQuestion: {
    input: z
      .object({
        ...readinessInputs,
        authorName: nonBlankStringSchema.optional(),
        taskId: idSchema,
        kind: z.enum(["decision", "check"]).default("decision"),
        askedByThread: evidenceThreadSchema.nullable().default(null),
        prompt: nonBlankStringSchema.max(10_000),
        steps: z.array(nonBlankStringSchema.max(500)).max(10).optional(),
        mode: z.enum(["single", "multiple"]).default("single"),
        allowOther: z.boolean().optional(),
        options: z
          .array(
            z.union([nonBlankStringSchema.max(500), questionOptionInputSchema]),
          )
          .min(0)
          .max(20).default([]),
        /** A check whose state changed replaces this check at the named revision; the old one closes. */
        supersedes: z.object({ questionId: idSchema, revision: z.number().int().positive() }).strict().optional(),
      })
      .strict(),
    output: z.object({ question: questionSchema, planWake: planWakeSchema.optional(), warnings: z.array(z.string()).optional() }).strict(),
  },
  answerQuestion: {
    input: z
      .object({
        questionId: idSchema,
        attachmentIds: z.array(idSchema).optional(),
        selectedOptionIds: z.array(idSchema).max(20).default([]),
        answerText: z.string().trim().max(10_000).nullable().optional(),
        revision: z.number().int().positive(),
        authorName: nonBlankStringSchema.default("You"),
        /** Set by the CLI: a clear of a check in a project that checks readiness is refused, read inside the answer write. */
        refuseReadinessClear: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        question: questionSchema,
        commentId: idSchema.nullable(),
        attachmentIds: z.array(idSchema),
        notification: z
          .enum(["sent", "failed", "none", "unchanged", "held"])
          .optional(),
        planWake: planWakeSchema.optional(),
      })
      .strict(),
  },
  updateQuestion: {
    input: z
      .object({
        ...readinessInputs,
        questionId: idSchema,
        revision: z.number().int().positive(),
        prompt: nonBlankStringSchema.max(10_000),
        /** Omitted keeps the current steps; [] clears them. */
        steps: z.array(nonBlankStringSchema.max(500)).max(10).optional(),
        mode: z.enum(["single", "multiple"]),
        options: z
          .array(questionOptionInputSchema.extend({ id: idSchema.optional() }))
          .min(1)
          .max(20),
        allowOther: z.boolean().optional(),
        reopen: z.boolean().optional(),
        /** The thread reopening an answered question becomes its asker. */
        askedByThread: evidenceThreadSchema.optional(),
        authorName: nonBlankStringSchema.default("You"),
      })
      .strict(),
    output: z.object({ question: questionSchema, planWake: planWakeSchema.optional(), warnings: z.array(z.string()).optional() }).strict(),
  },
  withdrawQuestion: {
    input: z.object({
      taskId: idSchema, questionId: idSchema, revision: z.number().int().positive(),
      reason: nonBlankStringSchema.max(500), authorName: nonBlankStringSchema.default("You"),
    }).strict(),
    output: z.object({ question: questionSchema, planWake: planWakeSchema.optional() }).strict(),
  },
  deleteQuestion: {
    input: z
      .object({ questionId: idSchema, revision: z.number().int().positive() })
      .strict(),
    output: z.object({ deleted: z.boolean(), planWake: planWakeSchema.optional() }).strict(),
  },
  listTemplates: {
    input: z.object({ projectId: idSchema }).strict(),
    output: z.object({ templates: z.array(templateSchema) }).strict(),
  },
  setTemplate: {
    input: z
      .object({
        projectId: idSchema,
        name: nonBlankStringSchema.max(100),
        body: z.string(),
        labelId: idSchema.nullable().default(null),
      })
      .strict(),
    output: z.object({ template: templateSchema }).strict(),
  },
  deleteTemplate: {
    input: z.object({ templateId: idSchema }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  getTask: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ task: taskSchema.nullable() }).strict(),
  },
  getTaskByKey: {
    input: z.object({ taskKey: nonBlankStringSchema }).strict(),
    output: z.object({ task: taskSchema.nullable() }).strict(),
  },
  // Which of these keys are cards, current or old (an alias kept after a project move): one batched read for text rendering.
  resolveTaskKeys: {
    input: z.object({ keys: z.array(nonBlankStringSchema).max(500) }).strict(),
    output: z
      .object({
        tasks: z.array(
          z
            .object({
              key: z.string(),
              currentKey: z.string(),
              title: z.string(),
              status: z.string(),
              statusName: z.string(),
              archived: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  updateTask: {
    input: updateTaskInputSchema,
    output: taskMutationResultSchema,
  },
  deleteTask: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  archiveTask: {
    input: z.object({ taskId: idSchema, archived: z.boolean(), authorName: nonBlankStringSchema.default("You") }).strict(),
    output: taskMutationResultSchema,
  },
  archiveCompleted: {
    input: z.object({ projectId: idSchema, authorName: nonBlankStringSchema.default("You") }).strict(),
    output: z.object({ archivedCount: z.number().int().nonnegative() }).strict(),
  },
  getTaskPlan: {
    input: z.object({ taskId: idSchema, version: z.number().int().min(1).optional() }).strict(),
    output: z.object({ plan: taskPlanHeadSchema.extend({ requested: planVersionSchema.extend({ body: z.string() }).strict(), noteCounts: planNoteCountsSchema, /** Derived: in review while the card has an open owner decision. */ paused: z.boolean().default(false) }).strict().nullable() }).strict(),
  },
  listTaskPlanVersions: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ plan: taskPlanHeadSchema.nullable(), versions: z.array(planVersionSchema), noteCounts: planNoteCountsSchema, paused: z.boolean().default(false) }).strict(),
  },
  listPlanNotes: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ notes: z.array(planNoteSchema) }).strict(),
  },
  createPlanNote: { input: createPlanNoteInputSchema, output: planNoteResultSchema },
  // Only a draft note can be edited or deleted; once sent it is the record of what the agent was told.
  updatePlanNote: {
    input: z.object({ noteId: idSchema, body: z.string().max(PLAN_NOTE_BODY_MAX) }).strict(),
    output: planNoteResultSchema,
  },
  deletePlanNote: {
    input: z.object({ noteId: idSchema }).strict(),
    output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), error: planNoteErrorSchema }).strict()]),
  },
  // The owner closes an answered note ("resolved") or reopens it ("draft": it goes out again with the next send).
  setPlanNoteState: {
    input: z.object({ noteId: idSchema, state: z.enum(["resolved", "draft"]) }).strict(),
    output: planNoteResultSchema,
  },
  // The agent answers a sent note; `addressed` marks it done in the current plan version.
  replyPlanNote: {
    input: z.object({ taskId: idSchema, number: z.number().int().min(1), body: z.string().max(PLAN_NOTE_BODY_MAX), addressed: z.boolean().default(false), author: planAuthorSchema }).strict(),
    output: planNoteResultSchema,
  },
  sendPlanFeedback: {
    input: z.object({ taskId: idSchema, author: planAuthorSchema }).strict(),
    output: planReviewResultSchema,
  },
  approvePlan: {
    input: z.object({ taskId: idSchema, author: planAuthorSchema, note: z.string().max(PLAN_NOTE_BODY_MAX).optional() }).strict(),
    output: planReviewResultSchema,
  },
  saveTaskPlan: {
    input: savePlanInputSchema,
    output: z.discriminatedUnion("ok", [
      z
        .object({
          ok: z.literal(true),
          plan: taskPlanHeadSchema,
          version: planVersionSchema.nullable(),
          /** Set when the first version moved the card into the planning status in the same write: its id and name. */
          movedTo: z.object({ status: z.string(), label: z.string() }).strict().nullable().default(null),
        })
        .strict(),
      z.object({ ok: z.literal(false), error: planErrorSchema }).strict(),
    ]),
  },
  diffTaskPlan: {
    input: z.object({ taskId: idSchema, from: z.number().int().min(0).optional(), to: z.number().int().min(1).optional() }).strict(),
    output: z.object({ from: z.number().int().min(0), to: z.number().int().min(1), patch: z.string(), added: z.number().int().min(0), removed: z.number().int().min(0) }).strict(),
  },
  submitTaskPlan: {
    input: z.object({ taskId: idSchema, author: planAuthorSchema, reviewer: planReviewerInputSchema.optional(), dedicatedReviewer: z.boolean().optional() }).strict(),
    output: planSubmitResultSchema,
  },
  listPlanReviews: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ reviews: z.array(planReviewSchema), paused: z.boolean().default(false) }).strict(),
  },
  setTaskPlanState: {
    input: z.object({ taskId: idSchema, state: z.enum(SETTABLE_PLAN_STATES), author: planAuthorSchema }).strict(),
    output: planStateResultSchema,
  },
  listTasks: {
    input: z
      .object({
        ...taskDateFiltersSchema.shape,
        archive: z.enum(["active", "archived", "all"]).default("active"),
        projectId: idSchema.optional(),
        statuses: z.array(taskStatusSchema).optional(),
        excludeStatuses: z.array(taskStatusSchema).optional(),
        priorities: z.array(taskPrioritySchema).optional(),
        labelIds: z.array(idSchema).optional(),
        activeOnly: z.boolean().default(false),
        staleStatus: z.boolean().default(false),
        waitingOnOwner: z.boolean().default(false),
        planDebt: z.boolean().default(false),
        parentTaskId: idSchema.nullable().optional(),
        type: z.enum(TASK_TYPES).optional(),
        epicId: idSchema.nullable().optional(),
        search: z.string().optional(),
        sort: taskSortSchema.default("manual"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TASKS_PAGE_MAX_LIMIT)
          .default(TASKS_PAGE_DEFAULT_LIMIT),
        cursor: nonBlankStringSchema.optional(),
        allowStaleCursor: z.boolean().default(false),
        // List projection: rows come back with description "" and progressNote null (full text stays on getTask*).
        omitBodies: z.boolean().default(false),
      })
      .strict(),
    output: z
      .object({
        tasks: z.array(taskSchema),
        staleStatusFlags: z.array(z.object({ taskId: idSchema, flags: z.array(z.string()) }).strict()).default([]),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  },
  boardMove: {
    input: z
      .object({
        taskId: idSchema,
        status: taskStatusSchema,
        beforeTaskId: idSchema.nullable().optional(),
        afterTaskId: idSchema.nullable().optional(),
        agentThreadId: evidenceThreadSchema.nullable().optional(),
        authorName: nonBlankStringSchema.default("You"),
      })
      .strict(),
    output: taskMutationResultSchema,
  },
  moveTaskToProject: {
    input: z
      .object({
        taskId: idSchema,
        projectId: idSchema,
        agentThreadId: evidenceThreadSchema.nullable().optional(),
        authorName: nonBlankStringSchema.default("You"),
      })
      .strict(),
    output: taskMutationResultSchema,
  },
  createLabel: {
    input: z
      .object({
        projectId: idSchema,
        name: nonBlankStringSchema,
        color: nonBlankStringSchema,
      })
      .strict(),
    output: z.object({ label: labelSchema }).strict(),
  },
  updateLabel: {
    input: updateLabelInputSchema,
    output: z.object({ label: labelSchema }).strict(),
  },
  deleteLabel: {
    input: z.object({ labelId: idSchema }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  listLabels: {
    input: z.object({ projectId: idSchema }).strict(),
    output: z.object({ labels: z.array(labelSchema) }).strict(),
  },
  createComment: {
    input: z
      .object({
        taskId: idSchema,
        body: z.string(),
        evidence: evidenceSchema.optional(),
        notify: z.boolean(),
        allowEmptyBody: z.boolean().default(false),
      })
      .strict()
      .refine((input) => input.allowEmptyBody || input.body.trim().length > 0, {
        path: ["body"],
        message: "Comment body cannot be empty",
      }),
    output: z.object({ comment: commentSchema }).strict(),
  },
  listComments: {
    // `withRevision` is opt-in: legacy callers get the exact old response (no `revision` key, no extra query).
    input: z.object({ taskId: idSchema, resolveMetadata: z.boolean().optional(), withRevision: z.boolean().optional() }).strict(),
    output: z.object({ comments: z.array(displayCommentSchema), revision: z.string().optional() }).strict(),
  },
  /** Cheap change token of a task's comments and their attachments: `<comments part>|<attachments part>`. */
  commentsRevision: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ revision: z.string() }).strict(),
  },
  /** Thread title/provider of the agent comments of a task; `complete: false` when a lookup failed (retry later). */
  listCommentThreads: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z
      .object({
        threads: z.array(
          z
            .object({ threadId: z.string(), threadTitle: z.string().nullable(), provider: commentProviderSchema.nullable() })
            .strict(),
        ),
        complete: z.boolean(),
      })
      .strict(),
  },
  listAttachments: {
    input: z.union([
      z.object({ taskId: idSchema }).strict(),
      z.object({ commentId: idSchema }).strict(),
      z.object({ commentsOfTaskId: idSchema, withRevision: z.boolean().optional() }).strict(),
    ]),
    output: z.object({ attachments: z.array(attachmentSchema), revision: z.string().optional() }).strict(),
  },
  deleteAttachment: {
    input: z
      .object({
        attachmentId: idSchema,
        removeDescriptionReferences: z.boolean().default(false),
      })
      .strict(),
    output: attachmentDeleteResultSchema,
  },
  getTaskCostSpans: {
    input: z.object({ taskId: idSchema }).strict(),
    /** Time windows of the threads that worked on the task tree, newest first; truncated past 2000. */
    output: z.object({ spans: z.array(costSpanSchema).max(2000), truncated: z.boolean(), taskCount: z.number() }).strict(),
  },
  listTaskThreads: {
    input: z.object({ taskId: idSchema, reconcile: z.boolean().optional() }).strict(),
    output: z.object({ taskThreads: z.array(taskThreadSchema) }).strict(),
  },
  setTaskActivity: {
    input: z.object({ taskId: idSchema, threadId: z.string().startsWith("thr_"), active: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listTaskCardMeta: {
    // A caller that already has the flags of its page skips them here, so they are not computed again at another instant.
    input: z.object({ taskIds: z.array(idSchema).max(500), skipStaleStatusFlags: z.boolean().optional() }).strict(),
    output: z.object({ metadata: z.array(z.object({
      taskId: idSchema,
      attachmentCount: z.number().int().nonnegative(),
      taskThreads: z.array(taskThreadSchema),
      activity: taskActivitySchema.optional(),
      blockedBy: z.array(dependencyTaskSchema).optional(),
      pauses: z.array(cardPauseSchema).optional(),
      advisories: z.array(taskAdvisorySchema).optional(),
      threadHealth: threadHealthSchema,
      staleStatusFlags: z.array(z.string()).default([]),
      queue: cardQueueSchema.optional(),
    }).strict()) }).strict(),
  },
  listTaskPullRequests: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z
      .object({
        pullRequests: z.array(taskPullRequestSchema),
        unavailableThreadIds: z.array(z.string().startsWith("thr_")),
      })
      .strict(),
  },
  createPreset: {
    input: z
      .object({
        name: nonBlankStringSchema,
        providerId: nonBlankStringSchema,
        modelId: nonBlankStringSchema,
        reasoningLevel: presetReasoningLevelSchema,
        serviceTier: presetServiceTierSchema.nullable().default(null),
        permissionMode: presetPermissionModeSchema,
        environmentKind: presetEnvironmentKindSchema.default("project-default"),
        baseBranch: nullablePresetTargetSchema.default(null),
        machineId: nullablePresetTargetSchema.default(null),
        instructions: z.string().default(""),
      })
      .strict()
      .superRefine((input, ctx) => {
        if (
          input.environmentKind === "project-default" &&
          input.baseBranch !== null
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["baseBranch"],
            message: "requires environmentKind new-worktree",
          });
        }
        if (
          input.environmentKind === "project-default" &&
          input.machineId !== null
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["machineId"],
            message: "requires environmentKind new-worktree",
          });
        }
      }),
    output: z.object({ preset: presetSchema }).strict(),
  },
  updatePreset: {
    input: updatePresetInputSchema,
    output: z.object({ preset: presetSchema }).strict(),
  },
  deletePreset: {
    input: z.object({ presetId: idSchema }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  listPresets: {
    input: z.null(),
    output: z.object({ presets: z.array(presetSchema) }).strict(),
  },
  listMachines: {
    input: z.object({}).strict(),
    output: z
      .object({
        machines: z.array(
          z.object({ id: z.string(), name: z.string() }).strict(),
        ),
      })
      .strict(),
  },
  searchThreads: {
    input: z
      .object({
        query: z.string(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    output: z
      .object({
        threads: z.array(
          z
            .object({
              id: z.string(),
              title: z.string(),
              status: threadSearchStatusSchema,
            })
            .strict(),
        ),
      })
      .strict(),
  },
  listBbProjects: {
    input: z.null(),
    output: z
      .object({
        bbProjects: z.array(
          z
            .object({ id: z.string().startsWith("proj_"), name: z.string() })
            .strict(),
        ),
      })
      .strict(),
  },
  getNavigationBadgeCriteria: {
    input: z.null(),
    output: z.object({ criteria: z.array(z.enum(BADGE_CRITERIA)) }).strict(),
  },
  setNavigationBadgeCriteria: {
    input: z.object({ criteria: z.array(z.enum(BADGE_CRITERIA)).max(BADGE_CRITERIA.length) }).strict(),
    output: z.object({ criteria: z.array(z.enum(BADGE_CRITERIA)) }).strict(),
  },
  navigationBadge: {
    input: z.null(),
    output: z
      .object({
        count: z.number().int().nonnegative(),
        counts: z.partialRecord(z.enum(BADGE_CRITERIA), z.number().int().nonnegative()),
        criteria: z.array(z.enum(BADGE_CRITERIA)),
        timeBased: z.boolean(),
      })
      .strict(),
  },
  sidebarOpenTaskCount: {
    input: z.null(),
    output: z
      .object({ openTaskCount: z.number().int().nonnegative() })
      .strict(),
  },
  sidebarSummary: {
    input: z.null(),
    output: z
      .object({
        projects: z.array(
          z
            .object({
              projectId: idSchema,
              taskCount: z.number().int().nonnegative(),
              activeAgentCount: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
} as const satisfies PluginRpcContract;

export type TasksRpcContract = typeof tasksRpcContract;
export type Folder = z.infer<typeof folderSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type CardQueue = z.infer<typeof cardQueueSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type Label = z.infer<typeof labelSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type CommentProvider = z.infer<typeof commentProviderSchema>;
export type DisplayComment = z.infer<typeof displayCommentSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type PlanAuthor = z.infer<typeof planAuthorSchema>;
export type PlanVersion = z.infer<typeof planVersionSchema>;
export type TaskPlanHead = z.infer<typeof taskPlanHeadSchema>;
export type PlanReviewer = z.infer<typeof planReviewerSchema>;
export type PlanReview = z.infer<typeof planReviewSchema>;
export type PlanNote = z.infer<typeof planNoteSchema>;
export type PlanNoteCounts = z.infer<typeof planNoteCountsSchema>;
export type CreatePlanNoteInput = z.input<typeof createPlanNoteInputSchema>;
export type SaveTaskPlanInput = z.infer<typeof savePlanInputSchema>;
export type TaskThread = z.infer<typeof taskThreadSchema>;
export type ThreadHealth = z.infer<typeof threadHealthSchema>;
export type TaskPullRequest = z.infer<typeof taskPullRequestSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type TasksDomainError = z.infer<typeof tasksDomainErrorSchema>;
export type TaskMutationResult = z.infer<typeof taskMutationResultSchema>;
export type BbProjectOption = z.infer<
  (typeof tasksRpcContract)["listBbProjects"]["output"]
>["bbProjects"][number];
export type SidebarProjectSummary = z.infer<
  (typeof tasksRpcContract)["sidebarSummary"]["output"]
>["projects"][number];

export interface TasksChangedEvent {
  taskId: string;
  projectId: string;
}

export interface ProjectsChangedEvent {
  projectId: string | null;
}

export interface CommentsChangedEvent {
  taskId: string;
}

export interface ThreadsChangedEvent {
  taskId: string;
}
