import { taskDateFiltersSchema } from "./task-dates.js";
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  TASK_SORTS,
  TASKS_PAGE_DEFAULT_LIMIT,
  TASKS_PAGE_MAX_LIMIT,
} from "./pagination.js";

import { taskStatusSchema, taskStatusesSchema } from "./statuses.js";
export { TASK_STATUSES } from "./statuses.js";
export type { TaskStatusDefinition } from "./statuses.js";

export const EXECUTION_TARGETS = ["agent", "owner"] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

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
] as const;
export const evidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("review"),
      pr: z.number().int().positive(),
      head: shaSchema,
      verdict: z.enum(["approve", "changes"]),
      thread: evidenceThreadSchema,
      lens: nonBlankStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("qa"),
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
      merge: shaSchema,
      run: nonBlankStringSchema,
      env: z.enum(["development", "production"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("exemption"),
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

const questionStateSchema = z
  .object({
    prompt: nonBlankStringSchema.max(10_000),
    mode: z.enum(["single", "multiple"]),
    options: z
      .array(questionOptionInputSchema.extend({ id: idSchema }))
      .min(2)
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
      (!value.allowOther && value.answerText !== null) ||
      (value.mode === "single" &&
        value.selectedOptionIds.length + Number(value.answerText !== null) > 1)
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

export const questionSchema = questionStateSchema
  .safeExtend({
    id: idSchema,
    taskId: idSchema,
    createdAt: z.string(),
    history: z.array(questionStateSchema).default([]),
  })
  .superRefine((value, ctx) => {
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
export type TaskQuestion = z.infer<typeof questionSchema>;
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
    statuses: taskStatusesSchema.optional(),
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
    status: taskStatusSchema,
    archivedAt: z.iso.datetime({ precision: 3 }).nullable().optional(),
    priority: taskPrioritySchema,
    dueDate: dueDateSchema.nullable(),
    parentTaskId: idSchema.nullable(),
    type: z.enum(TASK_TYPES).default("task"),
    executionTarget: z.enum(EXECUTION_TARGETS).default("agent"),
    requesterThreadId: evidenceThreadSchema.nullable().default(null),
    epicId: idSchema.nullable().default(null),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    labelIds: z.array(idSchema),
  })
  .strict();

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
    ]),
    message: z.string(),
  })
  .strict();

const taskMutationResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      task: taskSchema,
      notification: z.enum(["sent", "not_sent"]).optional(),
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
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    dueDate: dueDateSchema.nullable().optional(),
    parentTaskId: idSchema.nullable().optional(),
    type: z.enum(TASK_TYPES).optional(),
    executionTarget: z.enum(EXECUTION_TARGETS).optional(),
    epicId: idSchema.nullable().optional(),
    labelIds: taskLabelsSchema.optional(),
    requesterThreadId: evidenceThreadSchema.nullable().optional(),
    authorName: nonBlankStringSchema.default("You"),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.status !== undefined ||
      input.priority !== undefined ||
      input.dueDate !== undefined ||
      input.parentTaskId !== undefined ||
      input.type !== undefined ||
      input.executionTarget !== undefined ||
      input.requesterThreadId !== undefined ||
      input.epicId !== undefined ||
      input.labelIds !== undefined,
    { message: "at least one task field must be updated" },
  );

const updateProjectInputSchema = z
  .object({
    projectId: idSchema,
    name: nonBlankStringSchema.optional(),
    statuses: taskStatusesSchema.optional(),
    color: nonBlankStringSchema.optional(),
    folderId: idSchema.nullable().optional(),
    linkedBbProjectId: z.string().startsWith("proj_").nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.statuses !== undefined ||
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

export const tasksRpcContract = {
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
        title: nonBlankStringSchema,
        description: z.string().default(""),
        status: taskStatusSchema.default("backlog"),
        priority: taskPrioritySchema.default("none"),
        dueDate: dueDateSchema.nullable().default(null),
        parentTaskId: idSchema.nullable().default(null),
        type: z.enum(TASK_TYPES).default("task"),
        executionTarget: z.enum(EXECUTION_TARGETS).default("agent"),
        requesterThreadId: evidenceThreadSchema.nullable().default(null),
        epicId: idSchema.nullable().default(null),
        labelIds: taskLabelsSchema.default([]),
        template: nonBlankStringSchema.optional(),
      })
      .strict(),
    output: taskMutationResultSchema,
  },
  listQuestions: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ questions: z.array(questionSchema) }).strict(),
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
            })
            .strict(),
        ),
      })
      .strict(),
  },
  createQuestion: {
    input: z
      .object({
        taskId: idSchema,
        prompt: nonBlankStringSchema.max(10_000),
        mode: z.enum(["single", "multiple"]).default("single"),
        allowOther: z.boolean().optional(),
        options: z
          .array(
            z.union([nonBlankStringSchema.max(500), questionOptionInputSchema]),
          )
          .min(2)
          .max(20),
      })
      .strict(),
    output: z.object({ question: questionSchema }).strict(),
  },
  answerQuestion: {
    input: z
      .object({
        questionId: idSchema,
        selectedOptionIds: z.array(idSchema).max(20),
        answerText: z.string().trim().max(10_000).nullable().optional(),
        revision: z.number().int().positive(),
        authorName: nonBlankStringSchema.default("You"),
      })
      .strict(),
    output: z
      .object({
        question: questionSchema,
        notification: z
          .enum(["sent", "failed", "none", "unchanged"])
          .optional(),
      })
      .strict(),
  },
  updateQuestion: {
    input: z
      .object({
        questionId: idSchema,
        revision: z.number().int().positive(),
        prompt: nonBlankStringSchema.max(10_000),
        mode: z.enum(["single", "multiple"]),
        options: z
          .array(questionOptionInputSchema.extend({ id: idSchema.optional() }))
          .min(2)
          .max(20),
        allowOther: z.boolean().optional(),
        reopen: z.boolean().optional(),
        authorName: nonBlankStringSchema.default("You"),
      })
      .strict(),
    output: z.object({ question: questionSchema }).strict(),
  },
  deleteQuestion: {
    input: z
      .object({ questionId: idSchema, revision: z.number().int().positive() })
      .strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
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
        parentTaskId: idSchema.nullable().optional(),
        type: z.enum(TASK_TYPES).optional(),
        executionTarget: z.enum(EXECUTION_TARGETS).optional(),
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
      })
      .strict(),
    output: z
      .object({
        tasks: z.array(taskSchema),
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
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ comments: z.array(displayCommentSchema) }).strict(),
  },
  listAttachments: {
    input: z.union([
      z.object({ taskId: idSchema }).strict(),
      z.object({ commentId: idSchema }).strict(),
      z.object({ commentsOfTaskId: idSchema }).strict(),
    ]),
    output: z.object({ attachments: z.array(attachmentSchema) }).strict(),
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
  listTaskThreads: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ taskThreads: z.array(taskThreadSchema) }).strict(),
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
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type Label = z.infer<typeof labelSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type CommentProvider = z.infer<typeof commentProviderSchema>;
export type DisplayComment = z.infer<typeof displayCommentSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type TaskThread = z.infer<typeof taskThreadSchema>;
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
