import { TASK_DATE_FIELDS } from "../shared/task-dates.js";
import { DEFAULT_TASK_STATUSES, taskStatusesSchema } from "../shared/statuses.js";
import { resolve } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  createComment,
  publishProjectsChanged,
  registerHandlers,
  type TasksApiStore,
} from "../api";
import {
  publishAttachmentChanged,
  readAttachmentContent,
  saveAttachmentFromBytes,
} from "../attachments";
import { delegationRpcContract } from "../delegate/contract";
import { handlers as delegationHandlers } from "../delegate";
import {
  presetReasoningLevelSchema,
  tasksRpcContract,
  PRESET_PERMISSION_MODES,
  TASK_PRIORITIES,
  TASK_TYPES,
  EXECUTION_TARGETS,
  ULID_PATTERN,
  EVIDENCE_KINDS,
  evidenceSchema,
  type Attachment,
  type Folder,
  type Label,
  type Project,
  type Preset,
  type Task,
  type TaskMutationResult,
} from "../shared/contract";
import { attachmentDownloadUrl } from "../shared/attachments";
import { errorMessage } from "../shared/errors";
import {
  TASK_SORTS,
  TASKS_PAGE_DEFAULT_LIMIT,
  TASKS_PAGE_MAX_LIMIT,
} from "../shared/pagination";
import { bytes, detail, oneLine, table } from "./format";
import { allocatePrefix } from "./prefix";
import { seedDemo } from "./seed";
import { exportProject, importProject } from "../archive";
import { evidenceIndex, evidenceText } from "../structured/evidence";

const TASK_KEY_PATTERN = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/;
const BB_PROJECT_ID_PATTERN = /^proj_[A-Za-z0-9_-]+$/;
const ACTIVE_THREAD_STATUSES = new Set(["starting", "working"]);
const DEFAULT_PROJECT_COLOR = "blue";
const DEFAULT_LABEL_COLOR = "gray";

const PRESET_ENVIRONMENTS = ["project-default", "worktree"] as const;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const MACHINE_OPTION = {
  type: "string",
  placeholder: "id-or-name",
  description:
    "Enrolled machine that owns the file paths; defaults to the invoking thread's machine, otherwise the server's",
} as const;

const PROJECT_OPTION = {
  type: "string",
  placeholder: "prefix-or-id",
  description:
    "Tracker project prefix or id such as ABC, never a bb project id (proj_...); run bb tasks project list",
} as const;

const REQUIRED_PROJECT_OPTION = {
  ...PROJECT_OPTION,
  description: `${PROJECT_OPTION.description} (required)`,
} as const;

const KEY_POSITIONAL = {
  name: "key-or-id",
  description: "Task key such as ABC-12 (case-insensitive) or its ULID",
  required: true,
} as const;

interface PluginStatus {
  name: string;
  version: string;
}

type TasksDomain = ReturnType<typeof registerHandlers>;
type ListTasksInput = Parameters<TasksDomain["listTasks"]>[0];

class CliError extends PluginCliError {
  constructor(
    message: string,
    options?: { code?: string; hint?: string; exitCode?: number },
  ) {
    super(oneLine(message), options);
  }
}

function friendlyError(error: unknown): string {
  if (error instanceof PluginCliError) return error.message;
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue?.message ?? "invalid input"}`;
  }
  const message = errorMessage(error);
  if (message.includes("UNIQUE constraint failed: projects.prefix")) {
    return "project prefix is already in use";
  }
  if (
    message.includes("UNIQUE constraint failed: labels.project_id, labels.name")
  ) {
    return "label name is already in use in this project";
  }
  return message;
}

async function guard(
  action: () => Promise<string | PluginCliResult>,
): Promise<PluginCliResult> {
  try {
    const result = await action();
    return typeof result === "string"
      ? { exitCode: 0, stdout: result }
      : result;
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new CliError(friendlyError(error));
  }
}

function normalizePrefix(value: string): string {
  return value.trim().toUpperCase();
}

function unwrapTask(result: TaskMutationResult): Task {
  if (!result.ok) throw new CliError(result.error.message);
  return result.task;
}

async function resolveClientHostId(
  bb: BbPluginApi,
  domain: TasksDomain,
  machine: string | undefined,
  ctx: PluginCliContext,
): Promise<string | undefined> {
  if (machine !== undefined) return resolveMachineId(domain, machine);
  if (!ctx.threadId) return undefined;
  const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
  if (!thread.environmentId) return undefined;
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  return environment.hostId;
}

function isMissingClientFileError(error: unknown): boolean {
  const message = errorMessage(error);
  return /\bENOENT\b|does not exist|not found|is a directory/i.test(message);
}

async function readClientFile(
  bb: BbPluginApi,
  hostId: string | undefined,
  path: string,
): Promise<{ bytes: Buffer; text: string | null }> {
  const file = await bb.sdk.files.read({
    ...(hostId ? { hostId } : {}),
    path,
  });
  return {
    bytes: Buffer.from(
      file.content,
      file.contentEncoding === "base64" ? "base64" : "utf8",
    ),
    text: file.contentEncoding === "utf8" ? file.content : null,
  };
}

async function readAttachmentSource(
  bb: BbPluginApi,
  hostId: string | undefined,
  path: string,
): Promise<Buffer> {
  try {
    return (await readClientFile(bb, hostId, path)).bytes;
  } catch (error) {
    if (isMissingClientFileError(error)) {
      throw new CliError(`attachment source is not a file: ${path}`, {
        code: "attachment_source_missing",
      });
    }
    throw error;
  }
}

async function writeClientFile(
  bb: BbPluginApi,
  hostId: string | undefined,
  path: string,
  content: Buffer,
): Promise<void> {
  await bb.sdk.files.write({
    ...(hostId ? { hostId } : {}),
    path,
    content: content.toString("base64"),
    contentEncoding: "base64",
    createParents: true,
  });
}

function attachmentFileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || "attachment";
}

async function readTextOption(
  bb: BbPluginApi,
  ctx: PluginCliContext,
  hostId: string | undefined,
  inline: string | undefined,
  file: string | undefined,
): Promise<string | undefined> {
  if (file === undefined) return inline;
  const path = resolve(ctx.cwd ?? process.cwd(), file);
  try {
    const { text } = await readClientFile(bb, hostId, path);
    if (text === null) {
      throw new CliError(`could not read ${file}: file is not UTF-8 text`);
    }
    return text;
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new CliError(`could not read ${file}: ${errorMessage(error)}`);
  }
}

function derivePrefix(name: string, projects: readonly Project[]): string {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  if (!base || !/^[A-Z]/u.test(base)) base = `P${base}`;
  base = base.slice(0, 10);
  const prefix = allocatePrefix(
    base,
    new Set(projects.map((project) => project.prefix)),
  );
  if (prefix === null) {
    throw new CliError(`could not derive a unique prefix from ${name}`);
  }
  return prefix;
}

async function listProjects(domain: TasksDomain): Promise<Project[]> {
  return tasksRpcContract.listProjects.output.parse(
    await domain.listProjects(tasksRpcContract.listProjects.input.parse({})),
  ).projects;
}

function bbProjectIdHint(
  address: string,
  projects: readonly Project[],
): string {
  const linked = projects.filter(
    (project) => project.linkedBbProjectId === address,
  );
  const first = linked[0];
  if (linked.length === 1 && first) {
    return `${address} is a bb project id; its tracker project is ${first.prefix} — re-run with --project ${first.prefix}`;
  }
  return `${address} is a bb project id, but --project takes a tracker project prefix or id; run bb tasks project list`;
}

async function resolveProject(
  domain: TasksDomain,
  address: string,
): Promise<Project> {
  const normalized = address.trim().toUpperCase();
  const projects = await listProjects(domain);
  const project = projects.find(
    (candidate) =>
      candidate.id === normalized || candidate.prefix === normalized,
  );
  if (!project) {
    const trimmed = address.trim();
    throw new CliError(`project not found: ${address}`, {
      code: "project_not_found",
      ...(BB_PROJECT_ID_PATTERN.test(trimmed)
        ? { hint: bbProjectIdHint(trimmed, projects) }
        : {}),
    });
  }
  return project;
}

async function defaultProject(
  domain: TasksDomain,
  ctx: PluginCliContext,
  required: boolean,
): Promise<Project | undefined> {
  if (!ctx.projectId) {
    if (required) {
      throw new CliError(
        "missing --project and no BB project context is available",
        { code: "missing_required" },
      );
    }
    return undefined;
  }
  const matches = (await listProjects(domain)).filter(
    (project) => project.linkedBbProjectId === ctx.projectId,
  );
  if (matches.length === 0) {
    throw new CliError(
      `no tracker project is linked to BB project ${ctx.projectId}; pass --project or link one with bb tasks project update`,
      { code: "project_not_linked" },
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      `multiple tracker projects are linked to BB project ${ctx.projectId}; pass --project explicitly`,
      { code: "project_ambiguous" },
    );
  }
  return matches[0];
}

async function selectedProject(
  domain: TasksDomain,
  ctx: PluginCliContext,
  address: string | undefined,
  required: boolean,
): Promise<Project | undefined> {
  return address
    ? resolveProject(domain, address)
    : defaultProject(domain, ctx, required);
}

async function requiredProject(
  domain: TasksDomain,
  ctx: PluginCliContext,
  address: string | undefined,
): Promise<Project> {
  if (address) return resolveProject(domain, address);
  const linked = ctx.projectId
    ? (await listProjects(domain)).filter(
        (project) => project.linkedBbProjectId === ctx.projectId,
      )
    : [];
  const suggestion = linked.length === 1 ? linked[0] : undefined;
  throw new CliError("missing required option --project", {
    code: "missing_required",
    hint: suggestion
      ? `this thread's bb project ${ctx.projectId} is linked to tracker project ${suggestion.prefix}; re-run with --project ${suggestion.prefix}`
      : "pass a tracker project prefix or id; run bb tasks project list to see them",
  });
}

async function resolveFolder(
  domain: TasksDomain,
  address: string,
): Promise<Folder> {
  const folders = tasksRpcContract.listFolders.output.parse(
    await domain.listFolders(tasksRpcContract.listFolders.input.parse(null)),
  ).folders;
  const normalizedId = address.trim().toUpperCase();
  const byId = folders.find((folder) => folder.id === normalizedId);
  if (byId) return byId;
  const byName = folders.filter(
    (folder) => folder.name.toLowerCase() === address.trim().toLowerCase(),
  );
  if (byName.length === 0) {
    throw new CliError(`folder not found: ${address}`, {
      code: "folder_not_found",
    });
  }
  if (byName.length > 1) {
    throw new CliError(`folder name is ambiguous; use its id: ${address}`, {
      code: "folder_ambiguous",
    });
  }
  return byName[0]!;
}

async function resolveTask(
  domain: TasksDomain,
  address: string,
): Promise<Task> {
  const normalized = address.trim().toUpperCase();
  if (ULID_PATTERN.test(normalized)) {
    const result = tasksRpcContract.getTask.output.parse(
      await domain.getTask(
        tasksRpcContract.getTask.input.parse({ taskId: normalized }),
      ),
    );
    if (!result.task) throw taskNotFound(address);
    return result.task;
  }
  if (!TASK_KEY_PATTERN.test(normalized)) throw taskNotFound(address);
  const result = tasksRpcContract.getTaskByKey.output.parse(
    await domain.getTaskByKey(
      tasksRpcContract.getTaskByKey.input.parse({ taskKey: normalized }),
    ),
  );
  if (!result.task) throw taskNotFound(address);
  return result.task;
}

function taskNotFound(address: string): CliError {
  return new CliError(`task not found: ${address}`, { code: "task_not_found" });
}

async function listAllTasks(
  domain: TasksDomain,
  input: ListTasksInput,
): Promise<Task[]> {
  const tasks: Task[] = [];
  let cursor = input.cursor;
  do {
    const page = tasksRpcContract.listTasks.output.parse(
      await domain.listTasks(
        tasksRpcContract.listTasks.input.parse({
          ...input,
          limit: TASKS_PAGE_MAX_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
    );
    tasks.push(...page.tasks);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return tasks;
}

function resolvePreset(presets: readonly Preset[], address: string): Preset {
  const normalized = address.trim().toLowerCase();
  const matches = presets.filter(
    (preset) =>
      preset.id.toLowerCase() === normalized ||
      preset.name.toLowerCase() === normalized,
  );
  if (matches.length === 0) {
    throw new CliError(`preset not found: ${address}`, {
      code: "preset_not_found",
    });
  }
  if (matches.length > 1) {
    throw new CliError(`preset name is ambiguous; use its id: ${address}`, {
      code: "preset_ambiguous",
    });
  }
  return matches[0]!;
}

async function listTaskAttachments(
  domain: TasksDomain,
  taskId: string,
  comments: readonly { id: string }[],
): Promise<Attachment[]> {
  const attachments = [
    ...tasksRpcContract.listAttachments.output.parse(
      await domain.listAttachments(
        tasksRpcContract.listAttachments.input.parse({ taskId }),
      ),
    ).attachments,
  ];
  for (const comment of comments) {
    attachments.push(
      ...tasksRpcContract.listAttachments.output.parse(
        await domain.listAttachments(
          tasksRpcContract.listAttachments.input.parse({
            commentId: comment.id,
          }),
        ),
      ).attachments,
    );
  }
  return attachments;
}

async function listPresets(domain: TasksDomain): Promise<Preset[]> {
  return tasksRpcContract.listPresets.output.parse(
    await domain.listPresets(tasksRpcContract.listPresets.input.parse(null)),
  ).presets;
}

function presetEnvironmentLabel(preset: Preset): string {
  return preset.environmentKind === "new-worktree"
    ? "worktree"
    : "project-default";
}

function presetEnvironmentKind(
  value: (typeof PRESET_ENVIRONMENTS)[number] | undefined,
  fallback: Preset["environmentKind"],
): Preset["environmentKind"] {
  if (value === undefined) return fallback;
  return value === "worktree" ? "new-worktree" : "project-default";
}

function presetServiceTier(
  value: string | undefined,
  clear: boolean | undefined,
): string | null | undefined {
  if (clear && value !== undefined) {
    throw new CliError(
      "Cannot combine --service-tier and --clear-service-tier.",
    );
  }
  return clear ? null : value;
}

async function resolveMachineId(
  domain: TasksDomain,
  address: string,
): Promise<string> {
  const machines = tasksRpcContract.listMachines.output.parse(
    await domain.listMachines(tasksRpcContract.listMachines.input.parse({})),
  ).machines;
  const normalized = address.trim().toLocaleLowerCase();
  const matches = machines.filter(
    (machine) =>
      machine.id === address.trim() ||
      machine.name.toLocaleLowerCase() === normalized,
  );
  if (matches.length === 0) {
    throw new CliError(`machine not found: ${address}`, {
      code: "machine_not_found",
    });
  }
  if (matches.length > 1) {
    throw new CliError(`machine name is ambiguous; use its id: ${address}`, {
      code: "machine_ambiguous",
    });
  }
  return matches[0]!.id;
}

function validatePresetTargetOptions(input: {
  environmentKind: Preset["environmentKind"];
  baseBranch: string | undefined;
  machine: string | undefined;
}): void {
  if (input.environmentKind === "new-worktree") return;
  if (input.baseBranch !== undefined) {
    throw new CliError("--base-branch requires --environment worktree");
  }
  if (input.machine !== undefined) {
    throw new CliError("--machine requires --environment worktree");
  }
}

async function projectLabels(
  domain: TasksDomain,
  projectId: string,
): Promise<Label[]> {
  return tasksRpcContract.listLabels.output.parse(
    await domain.listLabels(
      tasksRpcContract.listLabels.input.parse({ projectId }),
    ),
  ).labels;
}

function resolveLabel(labels: readonly Label[], address: string): Label {
  const normalizedId = address.trim().toUpperCase();
  const label = labels.find(
    (candidate) =>
      candidate.id === normalizedId ||
      candidate.name.toLowerCase() === address.trim().toLowerCase(),
  );
  if (!label) {
    throw new CliError(`label not found: ${address}`, {
      code: "label_not_found",
    });
  }
  return label;
}

function projectTable(
  projects: readonly Project[],
  folders: readonly Folder[],
) {
  const folderNames = new Map(
    folders.map((folder) => [folder.id, folder.name]),
  );
  return table(
    ["PREFIX", "NAME", "FOLDER", "BB PROJECT", "ID"],
    projects.map((project) => [
      project.prefix,
      project.name,
      project.folderId
        ? (folderNames.get(project.folderId) ?? project.folderId)
        : "-",
      project.linkedBbProjectId ?? "-",
      project.id,
    ]),
    "No projects.",
  );
}

function taskAuthor(ctx: PluginCliContext): string {
  return ctx.threadId ? `agent (${ctx.threadId})` : "cli";
}

async function labelsForTaskList(
  domain: TasksDomain,
  projects: readonly Project[],
): Promise<Map<string, Label>> {
  const labels = new Map<string, Label>();
  for (const project of projects) {
    for (const label of await projectLabels(domain, project.id)) {
      labels.set(label.id, label);
    }
  }
  return labels;
}

function resolveInvokingThreadId(
  thread: string | undefined,
  ctx: PluginCliContext,
): string {
  const threadId = thread ?? process.env.BB_THREAD_ID ?? ctx.threadId;
  if (!threadId) {
    throw new CliError("missing --thread and BB_THREAD_ID is not set", {
      code: "missing_required",
    });
  }
  return threadId;
}

function groupCommand(
  group: string,
  summary: string,
  subcommands: readonly (readonly [string, string])[],
) {
  const width = Math.max(...subcommands.map(([name]) => name.length));
  return cliCommand({
    summary,
    hidden: true,
    description: [
      "Subcommands:",
      ...subcommands.map(
        ([name, text]) => `  bb tasks ${group} ${name.padEnd(width)}  ${text}`,
      ),
    ].join("\n"),
    positionals: [
      {
        name: "subcommand",
        description: `One of: ${subcommands.map(([name]) => name).join(", ")}`,
        variadic: true,
      },
    ],
    options: { json: JSON_OPTION },
    run(input) {
      const [subcommand] = input.positionals.subcommand;
      if (subcommand === undefined) return { exitCode: 1, stdout: input.help };
      throw new CliError(`unknown command: ${group} ${subcommand}`, {
        code: "unknown_command",
        hint: `run bb tasks ${group} --help for its subcommands`,
      });
    },
  });
}

export function registerTasksCli(
  bb: BbPluginApi,
  store: TasksApiStore,
  status: PluginStatus,
): void {
  const domain = registerHandlers(bb, store);
  const templateReadCommands = Object.fromEntries(
    (["list", "show", "delete"] as const).map((action) => [
      `template ${action}`,
      cliCommand({
        summary: `${action} project description templates`,
        options: {
          project: REQUIRED_PROJECT_OPTION,
          name: {
            type: "string",
            required: action !== "list",
            description: "Template name",
          },
          json: JSON_OPTION,
        },
        run(input, ctx) {
          return guard(async () => {
            const project = await requiredProject(
              domain,
              ctx,
              input.options.project,
            );
            const { templates } = await domain.listTemplates({
              projectId: project.id,
            });
            if (action === "list")
              return input.options.json
                ? JSON.stringify({ templates })
                : table(
                    ["ID", "NAME", "LABEL"],
                    templates.map((template) => [
                      template.id,
                      template.name,
                      template.labelId ?? "-",
                    ]),
                    "(none)",
                  );
            const template = templates.find(
              (item) =>
                item.name.toLowerCase() === input.options.name?.toLowerCase(),
            );
            if (!template) throw new CliError("Template not found");
            if (action === "show")
              return input.options.json
                ? JSON.stringify({ template })
                : template.body;
            const result = await domain.deleteTemplate({
              templateId: template.id,
            });
            return input.options.json
              ? JSON.stringify(result)
              : `Deleted template ${template.name}`;
          });
        },
      }),
    ]),
  );
  bb.cli.register(
    defineCli({
      name: "tasks",
      summary:
        "Create and manage task-tracker projects, tasks, labels, and comments",
      description:
        "Tasks are addressed by key (ABC-12) or ULID. --project takes a tracker project prefix or id, never a bb project id (proj_...).",
      commands: {
        ...Object.fromEntries(["archive", "restore"].map(action => [action, cliCommand({
          summary: action === "archive" ? "Archive a completed task and its children" : "Restore a task and its children from the archive",
          positionals: [KEY_POSITIONAL],
          options: { json: JSON_OPTION },
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(domain, input.positionals["key-or-id"]);
              const result = tasksRpcContract.archiveTask.output.parse(await domain.archiveTask({ taskId: task.id, archived: action === "archive", authorName: taskAuthor(ctx) }));
              const updated = unwrapTask(result);
              return input.options.json ? JSON.stringify({ task: updated }) : `${updated.key} ${action === "archive" ? "archived" : "restored"}`;
            });
          },
        })])),
        "archive-completed": cliCommand({
          summary: "Archive completed tasks in a project",
          options: { project: REQUIRED_PROJECT_OPTION, json: JSON_OPTION },
          run(input, ctx) { return guard(async () => {
            const project = await requiredProject(domain, ctx, input.options.project);
            const result = await domain.archiveCompleted({ projectId: project.id, authorName: taskAuthor(ctx) });
            return input.options.json ? JSON.stringify(result) : `Archived ${result.archivedCount} tasks`;
          }); },
        }),
        ...templateReadCommands,
        template: groupCommand(
          "template",
          "Manage project description templates",
          [
            ["set", "Save a Markdown template"],
            ["show", "Show a template"],
            ["list", "List templates"],
            ["delete", "Delete a template"],
          ],
        ),
        "template set": cliCommand({
          summary: "Save a project description template from a Markdown file",
          options: {
            project: REQUIRED_PROJECT_OPTION,
            name: {
              type: "string",
              required: true,
              description: "Template name",
            },
            "body-file": {
              type: "string",
              required: true,
              description: "Markdown file on the invoking machine",
            },
            label: {
              type: "string",
              description: "Bind to this project label",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const project = await requiredProject(
                domain,
                ctx,
                input.options.project,
              );
              const hostId = await resolveClientHostId(
                bb,
                domain,
                input.options.machine,
                ctx,
              );
              const body = await readTextOption(
                bb,
                ctx,
                hostId,
                undefined,
                input.options["body-file"],
              );
              const templates = (
                await domain.listTemplates({ projectId: project.id })
              ).templates;
              const current = templates.find(
                (template) =>
                  template.name.toLowerCase() ===
                  input.options.name.toLowerCase(),
              );
              const labelId = input.options.label
                ? resolveLabel(
                    await projectLabels(domain, project.id),
                    input.options.label,
                  ).id
                : (current?.labelId ?? null);
              const result = await domain.setTemplate(
                tasksRpcContract.setTemplate.input.parse({
                  projectId: project.id,
                  name: input.options.name,
                  body,
                  labelId,
                }),
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Saved template ${result.template.name}  ${result.template.id}`;
            });
          },
        }),
        question: groupCommand(
          "question",
          "Ask and answer questions on a task",
          [
            ["add", "Add a single or multiple choice question"],
            ["list", "List questions and answer IDs"],
            ["answer", "Save or clear an answer"],
            [
              "update",
              "Edit a question; answered questions require explicit reopen",
            ],
            ["delete", "Delete a question"],
          ],
        ),
        "question add": cliCommand({
          summary: "Add a question with stable option IDs",
          positionals: [KEY_POSITIONAL],
          options: {
            prompt: {
              type: "string",
              required: true,
              description: "Question text",
            },
            option: {
              type: "string",
              repeatable: true,
              description: "Option text; repeat at least twice",
            },
            multiple: {
              type: "boolean",
              description: "Allow multiple answers",
            },
            "allow-other": {
              type: "boolean",
              description: "Allow a free-text answer",
            },
            recommend: {
              type: "string",
              repeatable: true,
              description:
                "Recommend this option number (1-based); repeat for multiple choice",
            },
            "recommendation-reason": {
              type: "string",
              description: "Optional reason for the recommended option(s)",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const recommended = input.options.recommend.map((value) =>
                z.coerce.number().int().min(1).max(20).parse(value),
              );
              if (
                recommended.some(
                  (number) => number > input.options.option.length,
                )
              )
                throw new CliError(
                  "Recommended option number is outside the supplied options",
                );
              if (
                input.options["recommendation-reason"] &&
                recommended.length === 0
              )
                throw new CliError(
                  "--recommendation-reason requires --recommend",
                );
              const result = await domain.createQuestion(
                tasksRpcContract.createQuestion.input.parse({
                  taskId: task.id,
                  prompt: input.options.prompt,
                  options: input.options.option.map((label, index) =>
                    recommended.includes(index + 1)
                      ? {
                          label,
                          recommended: true,
                          recommendationReason:
                            input.options["recommendation-reason"],
                        }
                      : label,
                  ),
                  mode: input.options.multiple ? "multiple" : "single",
                  allowOther: input.options["allow-other"],
                }),
              );
              return input.options.json
                ? JSON.stringify(result)
                : JSON.stringify(result.question, null, 2);
            });
          },
        }),
        "question list": cliCommand({
          summary: "List a task's questions, option IDs and saved answers",
          positionals: [KEY_POSITIONAL],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const result = await domain.listQuestions({ taskId: task.id });
              return JSON.stringify(
                result,
                null,
                input.options.json ? undefined : 2,
              );
            });
          },
        }),
        "question answer": cliCommand({
          summary: "Save a question answer; revision protects concurrent edits",
          positionals: [KEY_POSITIONAL],
          options: {
            question: {
              type: "string",
              required: true,
              description: "Question ID",
            },
            answer: {
              type: "string",
              repeatable: true,
              description: "Selected option ID; repeat for multiple choice",
            },
            clear: { type: "boolean", description: "Clear the answer" },
            text: {
              type: "string",
              description: "Free-text answer when the creator allows it",
            },
            revision: {
              type: "integer",
              min: 1,
              max: Number.MAX_SAFE_INTEGER,
              required: true,
              description: "Question revision returned by list",
            },
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              if (
                !(
                  await domain.listQuestions({ taskId: task.id })
                ).questions.some(
                  (question) => question.id === input.options.question,
                )
              )
                throw new CliError("Question does not belong to this task");
              if (
                Boolean(input.options.clear) ===
                (input.options.answer.length > 0 ||
                  Boolean(input.options.text?.trim()))
              )
                throw new CliError(
                  "Use --answer/--text or --clear, exclusively",
                );
              const result = await domain.answerQuestion(
                tasksRpcContract.answerQuestion.input.parse({
                  questionId: input.options.question,
                  selectedOptionIds: input.options.clear
                    ? []
                    : input.options.answer,
                  answerText: input.options.clear ? null : input.options.text,
                  revision: input.options.revision,
                  authorName: taskAuthor(ctx),
                }),
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Saved answer to ${result.question.id}`;
            });
          },
        }),
        "question update": cliCommand({
          summary: "Edit question content at its current revision",
          positionals: [KEY_POSITIONAL],
          options: {
            question: {
              type: "string",
              required: true,
              description: "Question ID",
            },
            revision: {
              type: "integer",
              min: 1,
              max: Number.MAX_SAFE_INTEGER,
              required: true,
              description: "Current question revision",
            },
            prompt: {
              type: "string",
              description: "Replacement question text",
            },
            mode: {
              type: "enum",
              values: ["single", "multiple"],
              description: "Answer selection mode",
            },
            "options-file": {
              type: "string",
              description:
                "JSON array of {id?, label, recommended?, recommendationReason?}; retain existing IDs",
            },
            recommend: {
              type: "string",
              repeatable: true,
              description:
                "Recommend this existing option ID; replaces current recommendations",
            },
            "no-recommendation": {
              type: "boolean",
              description: "Clear all recommendations",
            },
            "recommendation-reason": {
              type: "string",
              description: "Optional reason; requires --recommend",
            },
            "allow-other": {
              type: "boolean",
              description: "Allow a free-text answer",
            },
            "no-other": {
              type: "boolean",
              description: "Disallow a free-text answer",
            },
            reopen: {
              type: "boolean",
              description:
                "Clear the existing answer and require a new decision",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const current = (
                await domain.listQuestions({ taskId: task.id })
              ).questions.find(
                (question) => question.id === input.options.question,
              );
              if (!current)
                throw new CliError("Question does not belong to this task");
              if (input.options["allow-other"] && input.options["no-other"])
                throw new CliError(
                  "Use --allow-other or --no-other, exclusively",
                );
              let options: unknown = current.options;
              if (input.options["options-file"]) {
                const hostId = await resolveClientHostId(
                  bb,
                  domain,
                  input.options.machine,
                  ctx,
                );
                const text = await readTextOption(
                  bb,
                  ctx,
                  hostId,
                  undefined,
                  input.options["options-file"],
                );
                try {
                  options = JSON.parse(text!);
                } catch {
                  throw new CliError(
                    "Options file must contain a JSON array of {id?, label}",
                  );
                }
              }
              const update = tasksRpcContract.updateQuestion.input.parse({
                questionId: current.id,
                revision: input.options.revision,
                prompt: input.options.prompt ?? current.prompt,
                mode: input.options.mode ?? current.mode,
                options,
                allowOther: input.options["no-other"]
                  ? false
                  : input.options["allow-other"]
                    ? true
                    : current.allowOther,
                reopen: input.options.reopen,
                authorName: taskAuthor(ctx),
              });
              const recommended = input.options.recommend;
              if (
                input.options["no-recommendation"] &&
                (recommended.length || input.options["recommendation-reason"])
              )
                throw new CliError(
                  "Use --no-recommendation or --recommend, exclusively",
                );
              if (
                input.options["recommendation-reason"] &&
                recommended.length === 0
              )
                throw new CliError(
                  "--recommendation-reason requires --recommend",
                );
              if (
                recommended.some(
                  (id) => !update.options.some((option) => option.id === id),
                )
              )
                throw new CliError(
                  "Recommended option ID does not belong to this question's options",
                );
              if (recommended.length || input.options["no-recommendation"]) {
                update.options = update.options.map((option) => ({
                  ...option,
                  recommended:
                    recommended.includes(option.id ?? "") || undefined,
                  recommendationReason: recommended.includes(option.id ?? "")
                    ? input.options["recommendation-reason"]
                    : undefined,
                }));
              }
              const result = await domain.updateQuestion(update);
              return input.options.json
                ? JSON.stringify(result)
                : `Saved question ${result.question.id} (revision ${result.question.revision})`;
            });
          },
        }),
        "question delete": cliCommand({
          summary: "Delete a question at its current revision",
          positionals: [KEY_POSITIONAL],
          options: {
            question: {
              type: "string",
              required: true,
              description: "Question ID",
            },
            revision: {
              type: "integer",
              min: 1,
              max: Number.MAX_SAFE_INTEGER,
              required: true,
              description: "Current question revision",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              if (
                !(
                  await domain.listQuestions({ taskId: task.id })
                ).questions.some(
                  (question) => question.id === input.options.question,
                )
              )
                throw new CliError("Question does not belong to this task");
              const result = await domain.deleteQuestion({
                questionId: input.options.question,
                revision: input.options.revision,
              });
              return input.options.json
                ? JSON.stringify(result)
                : "Deleted question";
            });
          },
        }),
        evidence: cliCommand({
          summary: "List structured evidence without deciding completeness",
          positionals: [KEY_POSITIONAL],
          options: {
            pr: {
              type: "integer",
              min: 1,
              max: Number.MAX_SAFE_INTEGER,
              description: "PR number",
            },
            head: { type: "string", description: "Full git head SHA" },
            kind: {
              type: "enum",
              values: EVIDENCE_KINDS,
              repeatable: true,
              description: "Evidence kind; repeat to include several",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const { comments } = await domain.listComments({
                taskId: task.id,
              });
              if (
                input.options.head &&
                !/^[a-fA-F0-9]{40}$/.test(input.options.head)
              )
                throw new CliError("head must be a full 40-character git SHA");
              const index = evidenceIndex(comments);
              const records = index.records.filter(
                (record) =>
                  (input.options.pr === undefined ||
                    record.indexedPr === input.options.pr) &&
                  (input.options.head === undefined ||
                    record.indexedHead === input.options.head.toLowerCase()) &&
                  (input.options.kind.length === 0 ||
                    input.options.kind.includes(record.kind)),
              );
              const filtered = {
                records,
                summary: index.summary.filter(
                  (entry) =>
                    input.options.pr === undefined ||
                    entry.pr === input.options.pr,
                ),
              };
              return input.options.json
                ? JSON.stringify(filtered)
                : evidenceText(filtered);
            });
          },
        }),
        export: cliCommand({
          summary:
            "Export a project, task records and attachment files by immutable ID",
          options: {
            project: REQUIRED_PROJECT_OPTION,
            out: {
              type: "string",
              required: true,
              description: "Dedicated export directory on the invoking machine",
              placeholder: "directory",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const project = await selectedProject(
                domain,
                ctx,
                input.options.project,
                true,
              );
              if (!project) throw new CliError("project is required");
              const hostId = await resolveClientHostId(
                bb,
                domain,
                input.options.machine,
                ctx,
              );
              const result = await exportProject(
                bb,
                store,
                project.id,
                resolve(ctx.cwd ?? process.cwd(), input.options.out),
                hostId,
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Exported ${result.tasks} tasks and ${result.attachments} attachments to ${result.out}`;
            });
          },
        }),
        import: cliCommand({
          summary: "Import a project snapshot without deleting omitted records",
          options: {
            from: {
              type: "string",
              required: true,
              description: "Project export directory on the invoking machine",
              placeholder: "directory",
            },
            overwrite: {
              type: "boolean",
              description:
                "Replace conflicting records with imported values; omitted records are retained",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const hostId = await resolveClientHostId(
                bb,
                domain,
                input.options.machine,
                ctx,
              );
              const result = await importProject(
                bb,
                store,
                resolve(ctx.cwd ?? process.cwd(), input.options.from),
                input.options.overwrite,
                hostId,
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Imported ${result.tasks} tasks and ${result.attachments} attachments into project ${result.projectId}`;
            });
          },
        }),
        status: cliCommand({
          summary: "Show the Tasks plugin name and version",
          description:
            "Plugin health only. To filter tasks by workflow status run bb tasks list --status <status>; to change one run bb tasks update <key-or-id> --status <status>.",
          options: { json: JSON_OPTION },
          run(input) {
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(status)
                : `${status.name} ${status.version}`,
            };
          },
        }),

        project: groupCommand(
          "project",
          "Create, list, show, or update tracker projects",
          [
            ["create", "Create a tracker project"],
            ["list", "List tracker projects"],
            ["show", "Show one tracker project"],
            ["update", "Rename, recolor, refile, or relink a project"],
          ],
        ),
        "project create": cliCommand({
          summary: "Create a tracker project",
          options: {
            name: {
              type: "string",
              required: true,
              description: "Human-readable project name",
            },
            prefix: {
              type: "string",
              placeholder: "PREFIX",
              description:
                "Task key prefix: uppercase letters and digits, starts with a letter, at most 10 characters (derived from --name when omitted)",
            },
            folder: {
              type: "string",
              placeholder: "id-or-name",
              description: "Folder that holds the project",
            },
            "link-bb-project": {
              type: "string",
              placeholder: "proj_id",
              aliases: ["bb-project", "link-project"],
              description:
                "bb project id (proj_...) whose threads track this tracker project",
            },
            color: {
              type: "string",
              default: DEFAULT_PROJECT_COLOR,
              description: "Accent color name",
            },
            json: JSON_OPTION,
          },
          unexpectedPositionalHint:
            "the project name belongs in --name <name>.",
          run(input) {
            return guard(async () => {
              const name = input.options.name;
              const projects = await listProjects(domain);
              const folderAddress = input.options.folder;
              const folder = folderAddress
                ? await resolveFolder(domain, folderAddress)
                : undefined;
              const result = tasksRpcContract.createProject.output.parse(
                await domain.createProject(
                  tasksRpcContract.createProject.input.parse({
                    name,
                    prefix: input.options.prefix
                      ? normalizePrefix(input.options.prefix)
                      : derivePrefix(name, projects),
                    color: input.options.color,
                    folderId: folder?.id ?? null,
                    linkedBbProjectId: input.options["link-bb-project"] ?? null,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Created project ${result.project.prefix}  ${result.project.name}`;
            });
          },
        }),
        "project list": cliCommand({
          summary: "List tracker projects",
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const projects = await listProjects(domain);
              const folders = tasksRpcContract.listFolders.output.parse(
                await domain.listFolders(
                  tasksRpcContract.listFolders.input.parse(null),
                ),
              ).folders;
              return input.options.json
                ? JSON.stringify({ projects })
                : projectTable(projects, folders);
            });
          },
        }),
        "project show": cliCommand({
          summary: "Show one tracker project",
          positionals: [
            {
              name: "prefix-or-id",
              description: "Tracker project prefix such as ABC, or its ULID",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const project = await resolveProject(
                domain,
                input.positionals["prefix-or-id"],
              );
              const folder = project.folderId
                ? await resolveFolder(domain, project.folderId)
                : null;
              if (input.options.json) {
                return JSON.stringify({ project, folder });
              }
              return detail([
                ["Project", `${project.prefix} — ${project.name}`],
                ["ID", project.id],
                ["Color", project.color],
                ["Folder", folder?.name ?? "-"],
                ["BB project", project.linkedBbProjectId ?? "-"],
                ["Next task", `${project.prefix}-${project.nextTaskNumber}`],
                ["Created", project.createdAt],
              ]);
            });
          },
        }),
        "project update": cliCommand({
          summary: "Rename, recolor, refile, or relink a tracker project",
          positionals: [
            {
              name: "prefix-or-id",
              description: "Tracker project prefix such as ABC, or its ULID",
              required: true,
            },
          ],
          options: {
            "statuses-file": { type: "string", description: "JSON array of project statuses [{id,name}] from the invoking machine" },
            machine: MACHINE_OPTION,
            name: { type: "string", description: "New project name" },
            color: { type: "string", description: "New accent color name" },
            folder: {
              type: "string",
              placeholder: "id-or-name",
              description: "Folder that holds the project",
            },
            "no-folder": {
              type: "boolean",
              description: "Move the project to the top level",
            },
            "link-bb-project": {
              type: "string",
              placeholder: "proj_id",
              aliases: ["bb-project", "link-project"],
              description: "bb project id (proj_...) to link",
            },
            "unlink-bb-project": {
              type: "boolean",
              description: "Remove the bb project link",
            },
            "rename-prefix": {
              type: "string",
              placeholder: "PREFIX",
              description:
                "New task key prefix; existing task keys are rewritten",
            },
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["folder", "no-folder"] },
            {
              kind: "at-most-one",
              options: ["link-bb-project", "unlink-bb-project"],
            },
          ],
          run(input, ctx) {
            return guard(async () => {
              const project = await resolveProject(
                domain,
                input.positionals["prefix-or-id"],
              );
              const folderAddress = input.options.folder;
              const folder = folderAddress
                ? await resolveFolder(domain, folderAddress)
                : undefined;
              let statuses;
              if (input.options["statuses-file"]) {
                const hostId = await resolveClientHostId(bb, domain, input.options.machine, ctx);
                const text = await readTextOption(bb, ctx, hostId, undefined, input.options["statuses-file"]);
                try { statuses = taskStatusesSchema.parse(JSON.parse(text!)); }
                catch { throw new CliError("Invalid statuses file: expected unique [{id,name}] definitions retaining the six system IDs"); }
              } else if (input.options.machine) throw new CliError("--machine requires --statuses-file");
              const changes = {
                statuses,
                name: input.options.name,
                color: input.options.color,
                folderId: input.options["no-folder"] ? null : folder?.id,
                linkedBbProjectId: input.options["unlink-bb-project"]
                  ? null
                  : input.options["link-bb-project"],
              };
              const renamePrefix = input.options["rename-prefix"];
              if (
                renamePrefix === undefined &&
                changes.name === undefined &&
                changes.color === undefined &&
                changes.folderId === undefined &&
                changes.statuses === undefined &&
                changes.linkedBbProjectId === undefined
              ) {
                throw new CliError("no project changes were provided", {
                  code: "no_changes",
                });
              }
              const renameInput =
                renamePrefix === undefined
                  ? undefined
                  : tasksRpcContract.renameProjectPrefix.input.parse({
                      projectId: project.id,
                      prefix: normalizePrefix(renamePrefix),
                    });
              const hasFieldChanges =
                changes.name !== undefined ||
                changes.color !== undefined ||
                changes.folderId !== undefined ||
                changes.statuses !== undefined ||
                changes.linkedBbProjectId !== undefined;
              const updateInput = hasFieldChanges
                ? tasksRpcContract.updateProject.input.parse({
                    projectId: project.id,
                    ...changes,
                  })
                : undefined;
              if (
                renameInput &&
                store.projectPrefixExists(renameInput.prefix, project.id)
              ) {
                throw new CliError(
                  `Project prefix is already in use: ${renameInput.prefix}`,
                );
              }
              const updated = store.transaction(() =>
                store.tasks.updateProject(project.id, {
                  prefix: renameInput?.prefix,
                  statuses: updateInput?.statuses,
                  name: updateInput?.name,
                  color: updateInput?.color,
                  folderId: updateInput?.folderId,
                  linkedBbProjectId: updateInput?.linkedBbProjectId,
                }),
              );
              publishProjectsChanged(bb, updated.id);
              return input.options.json
                ? JSON.stringify({ project: updated })
                : `Updated project ${updated.prefix}  ${updated.name}`;
            });
          },
        }),

        folder: groupCommand(
          "folder",
          "Create, list, update, or delete project folders",
          [
            ["create", "Create a folder"],
            ["list", "List folders"],
            ["update", "Rename or move a folder"],
            ["delete", "Delete a folder, keeping its contents"],
          ],
        ),
        "folder create": cliCommand({
          summary: "Create a project folder",
          options: {
            name: {
              type: "string",
              required: true,
              description: "Folder name",
            },
            parent: {
              type: "string",
              placeholder: "id-or-name",
              description: "Parent folder id or name",
            },
            json: JSON_OPTION,
          },
          unexpectedPositionalHint: "the folder name belongs in --name <name>.",
          run(input) {
            return guard(async () => {
              const parentAddress = input.options.parent;
              const parent = parentAddress
                ? await resolveFolder(domain, parentAddress)
                : undefined;
              const result = tasksRpcContract.createFolder.output.parse(
                await domain.createFolder(
                  tasksRpcContract.createFolder.input.parse({
                    name: input.options.name,
                    parentFolderId: parent?.id ?? null,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Created folder ${result.folder.name}  ${result.folder.id}`;
            });
          },
        }),
        "folder list": cliCommand({
          summary: "List project folders",
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const result = tasksRpcContract.listFolders.output.parse(
                await domain.listFolders(
                  tasksRpcContract.listFolders.input.parse(null),
                ),
              );
              const names = new Map(
                result.folders.map((folder) => [folder.id, folder.name]),
              );
              return input.options.json
                ? JSON.stringify(result)
                : table(
                    ["NAME", "PARENT", "ID"],
                    result.folders.map((folder) => [
                      folder.name,
                      folder.parentFolderId
                        ? (names.get(folder.parentFolderId) ??
                          folder.parentFolderId)
                        : "-",
                      folder.id,
                    ]),
                    "No folders.",
                  );
            });
          },
        }),
        "folder update": cliCommand({
          summary: "Rename or move a project folder",
          positionals: [
            {
              name: "id-or-name",
              description: "Folder id or its unique name",
              required: true,
            },
          ],
          options: {
            name: { type: "string", description: "New folder name" },
            parent: {
              type: "string",
              placeholder: "id-or-name",
              description: "New parent folder id or name",
            },
            "no-parent": {
              type: "boolean",
              description: "Move the folder to the top level",
            },
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["parent", "no-parent"] },
          ],
          run(input) {
            return guard(async () => {
              const folder = await resolveFolder(
                domain,
                input.positionals["id-or-name"],
              );
              const parentAddress = input.options.parent;
              const noParent = input.options["no-parent"];
              const name = input.options.name;
              if (
                name === undefined &&
                parentAddress === undefined &&
                !noParent
              ) {
                throw new CliError("no folder changes were provided", {
                  code: "no_changes",
                });
              }
              const parent = parentAddress
                ? await resolveFolder(domain, parentAddress)
                : null;
              const renameInput =
                name === undefined
                  ? undefined
                  : tasksRpcContract.renameFolder.input.parse({
                      folderId: folder.id,
                      name,
                    });
              const moveInput =
                parentAddress === undefined && !noParent
                  ? undefined
                  : tasksRpcContract.moveFolder.input.parse({
                      folderId: folder.id,
                      parentFolderId: parent?.id ?? null,
                    });
              const updated = store.transaction(() =>
                store.tasks.updateFolder(folder.id, {
                  name: renameInput?.name,
                  parentFolderId: moveInput?.parentFolderId,
                }),
              );
              publishProjectsChanged(bb, null);
              return input.options.json
                ? JSON.stringify({ folder: updated })
                : `Updated folder ${updated.name}  ${updated.id}`;
            });
          },
        }),
        "folder delete": cliCommand({
          summary: "Delete a folder and unfile its contents",
          description:
            "Deleting a folder moves its projects and subfolders to the top level. No tasks are deleted.",
          positionals: [
            {
              name: "id-or-name",
              description: "Folder id or its unique name",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const address = input.positionals["id-or-name"];
              const folder = await resolveFolder(domain, address);
              const result = tasksRpcContract.deleteFolder.output.parse(
                await domain.deleteFolder(
                  tasksRpcContract.deleteFolder.input.parse({
                    folderId: folder.id,
                  }),
                ),
              );
              if (!result.deleted) {
                throw new CliError(
                  `folder not found: ${address} (it was deleted by another client)`,
                  { code: "folder_not_found" },
                );
              }
              if (input.options.json) {
                return JSON.stringify({ ...result, folder });
              }
              const projectCount = result.movedProjectIds.length;
              const folderCount = result.movedFolderIds.length;
              const moved = [
                projectCount > 0
                  ? `${projectCount} project${projectCount > 1 ? "s" : ""}`
                  : null,
                folderCount > 0
                  ? `${folderCount} subfolder${folderCount > 1 ? "s" : ""}`
                  : null,
              ].filter((part) => part !== null);
              return moved.length === 0
                ? `Deleted folder ${folder.name}`
                : `Deleted folder ${folder.name}; ${moved.join(" and ")} moved to the top level. No tasks were deleted.`;
            });
          },
        }),

        create: cliCommand({
          summary: "Create a task",
          unexpectedPositionalHint:
            "the task title belongs in --title <title>.",
          options: {
            "requester-thread": {
              type: "string",
              description: "BB thread to notify when an Owner action is done",
            },
            executor: {
              type: "enum",
              values: EXECUTION_TARGETS,
              description: "Who performs the action: agent or owner",
            },
            type: {
              type: "enum",
              values: TASK_TYPES,
              default: "task",
              description: "Task or epic",
            },
            epic: {
              type: "string",
              placeholder: "key-or-id",
              description: "Epic from the same project",
            },
            project: PROJECT_OPTION,
            template: {
              type: "string",
              description:
                "Project description template; --description is appended",
            },
            title: {
              type: "string",
              required: true,
              aliases: ["name", "subject"],
              description: "Task title",
            },
            description: {
              type: "string",
              placeholder: "markdown",
              aliases: ["body", "details", "text", "content"],
              description:
                "Markdown description; use --description-file for long text",
            },
            "description-file": {
              type: "string",
              placeholder: "path",
              description:
                "Read the description from this UTF-8 file on the invoking machine",
            },
            status: { type: "string", placeholder: "status-id", description: "Project workflow status ID (default: backlog)" },
            priority: {
              type: "enum",
              values: TASK_PRIORITIES,
              default: "none",
              description: "Task priority",
            },
            label: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "name",
              aliases: ["labels"],
              description:
                "Existing label name; repeat the flag or pass a comma-separated list",
            },
            due: {
              type: "string",
              placeholder: "YYYY-MM-DD",
              aliases: ["due-date"],
              description: "Due date as a calendar date, YYYY-MM-DD",
            },
            parent: {
              type: "string",
              placeholder: "key-or-id",
              description:
                "Parent task key or id; tasks support at most one level of sub-tasks",
            },
            attach: {
              type: "string",
              repeatable: true,
              placeholder: "path",
              aliases: ["file", "attachment"],
              description:
                "File to attach, repeatable; read from the invoking machine, at most 25 MB each",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          constraints: [
            {
              kind: "at-most-one",
              options: ["description", "description-file"],
            },
          ],
          run(input, ctx) {
            return guard(async () => {
              const attachPaths = input.options.attach.map((path) =>
                resolve(ctx.cwd ?? process.cwd(), path),
              );
              const descriptionFile = input.options["description-file"];
              const usesClientFiles =
                attachPaths.length > 0 || descriptionFile !== undefined;
              if (input.options.machine !== undefined && !usesClientFiles) {
                throw new CliError(
                  "--machine requires --attach or --description-file",
                );
              }
              const clientHostId = usesClientFiles
                ? await resolveClientHostId(
                    bb,
                    domain,
                    input.options.machine,
                    ctx,
                  )
                : undefined;
              const attachSources: Array<{ path: string; bytes: Buffer }> = [];
              for (const path of attachPaths) {
                attachSources.push({
                  path,
                  bytes: await readAttachmentSource(bb, clientHostId, path),
                });
              }
              const project = await selectedProject(
                domain,
                ctx,
                input.options.project,
                true,
              );
              if (!project) throw new CliError("project is required");
              const labels = await projectLabels(domain, project.id);
              const labelIds = input.options.label.map(
                (name) => resolveLabel(labels, name).id,
              );
              const parentAddress = input.options.parent;
              const parent = parentAddress
                ? await resolveTask(domain, parentAddress)
                : undefined;
              const created = tasksRpcContract.createTask.input.parse({
                projectId: project.id,
                title: input.options.title,
                status: input.options.status,
                template: input.options.template,
                requesterThreadId:
                  input.options["requester-thread"] ??
                  (input.options.executor === "owner"
                    ? (ctx.threadId ?? process.env.BB_THREAD_ID ?? null)
                    : null),
                type: input.options.type,
                executionTarget: input.options.executor,
                epicId: input.options.epic
                  ? (await resolveTask(domain, input.options.epic)).id
                  : null,
                description:
                  (await readTextOption(
                    bb,
                    ctx,
                    clientHostId,
                    input.options.description,
                    descriptionFile,
                  )) ?? "",
                priority: input.options.priority,
                dueDate: input.options.due ?? null,
                parentTaskId: parent?.id ?? null,
                labelIds,
              });
              const task = unwrapTask(
                tasksRpcContract.createTask.output.parse(
                  await domain.createTask(created),
                ),
              );
              const attachments: Attachment[] = [];
              const failedAttachments: Array<{ path: string; error: string }> =
                [];
              for (const source of attachSources) {
                try {
                  const attachment = await saveAttachmentFromBytes(
                    store.tasks,
                    source.bytes,
                    {
                      taskId: task.id,
                      fileName: attachmentFileName(source.path),
                    },
                  );
                  publishAttachmentChanged(bb, store.tasks, attachment);
                  attachments.push(attachment);
                } catch (error) {
                  failedAttachments.push({
                    path: source.path,
                    error: errorMessage(error),
                  });
                }
              }
              const stdout = input.options.json
                ? JSON.stringify({ task, attachments, failedAttachments })
                : [
                    `Created ${task.key}  ${task.title}`,
                    ...attachments.map(
                      (attachment) =>
                        `Attached ${attachment.fileName}  ${attachment.id}`,
                    ),
                    ...failedAttachments.map(
                      (entry) =>
                        `Failed to attach ${entry.path}: ${entry.error}`,
                    ),
                    ...failedAttachments.map(
                      (entry) =>
                        `Retry with: bb tasks attachment add ${task.key} --file ${entry.path}`,
                    ),
                  ].join("\n");
              if (failedAttachments.length === 0) return stdout;
              return {
                exitCode: 1,
                stdout,
                stderr: `created ${task.key}, but ${failedAttachments.length} of ${attachPaths.length} attachments failed; see stdout for per-file recovery commands`,
              };
            });
          },
        }),

        list: cliCommand({
          summary: "List and filter tasks",
          options: {
            "date-field": { type: "enum", values: TASK_DATE_FIELDS, description: "Date used for filtering and newest order: archived by default with --archived, otherwise created" },
            from: { type: "string", description: "Inclusive start date (YYYY-MM-DD, UTC)" },
            to: { type: "string", description: "Inclusive end date (YYYY-MM-DD, UTC)" },
            on: { type: "string", description: "One UTC calendar date; cannot combine with --from/--to" },
            latest: { type: "integer", min: 1, max: TASKS_PAGE_MAX_LIMIT, description: "Return the latest N matching tasks (newest first, up to 500 per page)" },
            archived: { type: "boolean", description: "List only archived tasks" },
            "include-archived": { type: "boolean", description: "Include archived and unarchived tasks" },
            executor: {
              type: "enum",
              values: EXECUTION_TARGETS,
              description: "Who performs the action: agent or owner",
            },
            type: {
              type: "enum",
              values: TASK_TYPES,
              description: "Task or epic",
            },
            epic: {
              type: "string",
              placeholder: "key-or-id",
              description: "Epic from the same project",
            },
            project: PROJECT_OPTION,
            status: {
              type: "string",
              placeholder: "status-id",
              repeatable: true,
              split: ",",
              aliases: ["statuses", "state"],
              description:
                "Keep only these workflow statuses; repeat the flag or pass a comma-separated list",
            },
            "exclude-status": {
              type: "string",
              placeholder: "status-id",
              repeatable: true,
              split: ",",
              description:
                "Exclude these workflow statuses, including from --status; repeat or comma-separate",
            },
            priority: {
              type: "enum",
              values: TASK_PRIORITIES,
              repeatable: true,
              split: ",",
              aliases: ["priorities"],
              description:
                "Keep only these priorities; repeat the flag or pass a comma-separated list",
            },
            label: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "name",
              aliases: ["labels"],
              description:
                "Keep only tasks carrying these label names; repeat or comma-separate",
            },
            active: {
              type: "boolean",
              description: "Keep only tasks with a live agent thread",
            },
            search: {
              type: "string",
              placeholder: "query",
              aliases: ["query", "q"],
              description: "Match task key, title and description text",
            },
            sort: {
              type: "enum",
              values: TASK_SORTS,
              default: "manual",
              description: "Row order",
            },
            limit: {
              type: "integer",
              min: 1,
              max: TASKS_PAGE_MAX_LIMIT,
              default: TASKS_PAGE_DEFAULT_LIMIT,
              description: "Rows per page",
            },
            cursor: {
              type: "string",
              placeholder: "opaque",
              description:
                "Continue from a previous page's nextCursor with identical filters",
            },
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const project = await selectedProject(
                domain,
                ctx,
                input.options.project,
                false,
              );
              const projects = project ? [project] : await listProjects(domain);
              const labelById = await labelsForTaskList(domain, projects);
              const labelIds = input.options.label.map((name) => {
                const matches = [...labelById.values()].filter(
                  (label) =>
                    label.name.toLowerCase() === name.trim().toLowerCase(),
                );
                if (matches.length === 0) {
                  throw new CliError(`label not found: ${name}`, {
                    code: "label_not_found",
                  });
                }
                if (matches.length > 1 && !project) {
                  throw new CliError(
                    `label name exists in multiple projects; pass --project: ${name}`,
                    { code: "label_ambiguous" },
                  );
                }
                return matches[0]!.id;
              });
              if (input.options.archived && input.options["include-archived"]) throw new CliError("Use only one of --archived or --include-archived", { code: "invalid_value" });
              const excludedStatuses = new Set(input.options["exclude-status"]);
              const knownStatuses = new Set([...DEFAULT_TASK_STATUSES.map((status) => status.id), ...projects.flatMap((entry) => (entry.statuses ?? DEFAULT_TASK_STATUSES).map((status) => status.id))]);
              for (const value of [...input.options.status, ...excludedStatuses]) if (!knownStatuses.has(value)) throw new CliError(`Unknown task status: ${value}`, { code: "invalid_value" });
              const statuses = (
                input.options.status.length > 0
                  ? input.options.status
                  : [...new Set(projects.flatMap((entry) => (entry.statuses ?? DEFAULT_TASK_STATUSES).map((status) => status.id)))]
              ).filter((status) => !excludedStatuses.has(status));
              if (input.options.on && (input.options.from || input.options.to)) throw new CliError("Use --on or --from/--to", { code: "invalid_value" });
              if (input.options.latest !== undefined && input.options.sort !== "manual" && input.options.sort !== "newest") throw new CliError("--latest requires newest order", { code: "invalid_value" });
              const limit = input.options.latest ?? input.options.limit;
              const result = tasksRpcContract.listTasks.output.parse(
                await domain.listTasks(
                  tasksRpcContract.listTasks.input.parse({
                    dateField: input.options["date-field"],
                    dateFrom: input.options.on ?? input.options.from,
                    dateTo: input.options.on ?? input.options.to,
                    archive: input.options.archived ? "archived" : input.options["include-archived"] ? "all" : "active",
                    projectId: project?.id,
                    type: input.options.type,
                    executionTarget: input.options.executor,
                    epicId: input.options.epic
                      ? (await resolveTask(domain, input.options.epic)).id
                      : undefined,
                    statuses:
                      input.options.status.length > 0 ||
                      excludedStatuses.size > 0
                        ? statuses
                        : undefined,
                    priorities:
                      input.options.priority.length > 0
                        ? input.options.priority
                        : undefined,
                    labelIds: labelIds.length > 0 ? labelIds : undefined,
                    activeOnly: input.options.active,
                    search: input.options.search,
                    sort: input.options.latest !== undefined ? "newest" : input.options.sort,
                    limit,
                    cursor: input.options.cursor,
                  }),
                ),
              );
              const tasks = [];
              for (const task of result.tasks) {
                const threadResult =
                  tasksRpcContract.listTaskThreads.output.parse(
                    await domain.listTaskThreads(
                      tasksRpcContract.listTaskThreads.input.parse({
                        taskId: task.id,
                      }),
                    ),
                  );
                tasks.push({
                  ...task,
                  labels: task.labelIds.map(
                    (id) => labelById.get(id)?.name ?? id,
                  ),
                  agentsWorking: threadResult.taskThreads.filter((thread) =>
                    ACTIVE_THREAD_STATUSES.has(thread.liveStatus),
                  ).length,
                });
              }
              if (input.options.json) {
                return JSON.stringify({
                  tasks,
                  nextCursor: result.nextCursor,
                  limit,
                });
              }
              const output = table(
                [
                  "KEY",
                  "STATUS",
                  "EXECUTOR",
                  "PRIORITY",
                  "DUE",
                  "TITLE",
                  "LABELS",
                  "AGENTS",
                ],
                tasks.map((task) => [
                  task.key,
                  task.status,
                  task.executionTarget,
                  task.priority,
                  task.dueDate ?? "-",
                  task.title,
                  task.labels.join(", ") || "-",
                  task.agentsWorking,
                ]),
                "No tasks.",
              );
              return result.nextCursor === null
                ? output
                : `${output}\n\nMore results are available. Re-run with the same filters and add: --limit ${limit} --cursor ${result.nextCursor}`;
            });
          },
        }),

        show: cliCommand({
          summary: "Show full task details",
          aliases: ["get"],
          suggestFor: ["view", "read", "info", "detail", "details", "describe"],
          positionals: [KEY_POSITIONAL],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const project = await resolveProject(domain, task.projectId);
              const allLabels = await projectLabels(domain, project.id);
              const labelById = new Map(
                allLabels.map((label) => [label.id, label]),
              );
              const labels = task.labelIds
                .map((id) => labelById.get(id)!)
                .filter(Boolean);
              const subtasks = await listAllTasks(
                domain,
                tasksRpcContract.listTasks.input.parse({
                  archive: "all",
                  ...(task.type === "epic"
                    ? { epicId: task.id }
                    : { parentTaskId: task.id }),
                }),
              );
              const comments = tasksRpcContract.listComments.output.parse(
                await domain.listComments(
                  tasksRpcContract.listComments.input.parse({
                    taskId: task.id,
                  }),
                ),
              ).comments;
              const { questions } = await domain.listQuestions({
                taskId: task.id,
              });
              const evidence = evidenceIndex(comments);
              const attachments = await listTaskAttachments(
                domain,
                task.id,
                comments,
              );
              const taskThreads = tasksRpcContract.listTaskThreads.output.parse(
                await domain.listTaskThreads(
                  tasksRpcContract.listTaskThreads.input.parse({
                    taskId: task.id,
                  }),
                ),
              ).taskThreads;
              const { pullRequests, unavailableThreadIds } =
                tasksRpcContract.listTaskPullRequests.output.parse(
                  await domain.listTaskPullRequests(
                    tasksRpcContract.listTaskPullRequests.input.parse({
                      taskId: task.id,
                    }),
                  ),
                );
              if (input.options.json) {
                return JSON.stringify({
                  task,
                  project,
                  labels,
                  subtasks: task.type === "epic" ? [] : subtasks,
                  ...(task.type === "epic" ? { epicTasks: subtasks } : {}),
                  attachments,
                  taskThreads,
                  pullRequests,
                  pullRequestUnavailableThreadIds: unavailableThreadIds,
                  comments,
                  questions,
                  evidence: evidence.records,
                  evidenceSummary: evidence.summary,
                });
              }
              return [
                detail([
                  ["Task", `${task.key} — ${task.title}`],
                  ["Type", task.type],
                  [
                    "Epic",
                    task.epicId
                      ? (await resolveTask(domain, task.epicId)).key
                      : "-",
                  ],
                  ["Executor", task.executionTarget],
                  [
                    "Requester",
                    task.requesterThreadId
                      ? `@thread:${task.requesterThreadId}`
                      : "-",
                  ],
                  ["ID", task.id],
                  ["Project", `${project.prefix} — ${project.name}`],
                  ["Status", task.status],
                  ...(task.archivedAt ? [["Archived", task.archivedAt] as const] : []),
                  ["Priority", task.priority],
                  ["Due", task.dueDate ?? "-"],
                  ["Parent", task.parentTaskId ?? "-"],
                  [
                    "Labels",
                    labels.map((label) => label.name).join(", ") || "-",
                  ],
                  ["Created", task.createdAt],
                  ["Updated", task.updatedAt],
                ]),
                `Description\n${task.description || "(none)"}`,
                `${task.type === "epic" ? "Tasks in epic" : "Sub-tasks"}\n${table(
                  ["KEY", "STATUS", "PRIORITY", "TITLE"],
                  subtasks.map((subtask) => [
                    subtask.key,
                    subtask.status,
                    subtask.priority,
                    subtask.title,
                  ]),
                  "(none)",
                )}`,
                `Attachments\n${table(
                  ["ID", "NAME", "SIZE"],
                  attachments.map((attachment) => [
                    attachment.id,
                    attachment.fileName,
                    bytes(attachment.sizeBytes),
                  ]),
                  "(none)",
                )}`,
                `Attached threads\n${table(
                  ["THREAD", "STATUS", "PRESET", "TITLE"],
                  taskThreads.map((thread) => [
                    thread.threadId,
                    thread.liveStatus,
                    thread.presetName,
                    thread.title,
                  ]),
                  "(none)",
                )}`,
                `Pull requests\n${table(
                  ["PR", "STATE", "TITLE", "URL"],
                  pullRequests.map((pullRequest) => [
                    `#${pullRequest.number}`,
                    pullRequest.state,
                    pullRequest.title,
                    pullRequest.url,
                  ]),
                  "(none)",
                )}${
                  unavailableThreadIds.length > 0
                    ? `\nPR lookup unavailable for: ${unavailableThreadIds.join(", ")}`
                    : ""
                }`,
                `Questions\n${JSON.stringify(questions, null, 2)}`,
                `Evidence\n${evidenceText(evidence)}`,
                `Comments\n${table(
                  ["TIME", "KIND", "AUTHOR", "PROVIDER", "BODY"],
                  comments.map((comment) => [
                    comment.createdAt,
                    comment.kind,
                    comment.threadTitle ?? comment.authorName,
                    comment.provider?.name ?? "-",
                    comment.body,
                  ]),
                  "(none)",
                )}`,
              ].join("\n\n");
            });
          },
        }),

        update: cliCommand({
          summary: "Update task fields and labels",
          positionals: [KEY_POSITIONAL],
          options: {
            "requester-thread": {
              type: "string",
              description: "BB thread to notify when an Owner action is done",
            },
            executor: {
              type: "enum",
              values: EXECUTION_TARGETS,
              description: "Who performs the action: agent or owner",
            },
            type: {
              type: "enum",
              values: TASK_TYPES,
              description: "Task or epic",
            },
            epic: {
              type: "string",
              placeholder: "key-or-id",
              description: "Epic from the same project",
            },
            status: {
              type: "string",
              placeholder: "status-id",
              aliases: ["state"],
              description:
                "New workflow status; in_review when implementation needs review, done when the criteria are met",
            },
            priority: {
              type: "enum",
              values: TASK_PRIORITIES,
              description: "New priority",
            },
            title: {
              type: "string",
              aliases: ["name", "subject"],
              description: "New title",
            },
            description: {
              type: "string",
              placeholder: "markdown",
              aliases: ["body", "details", "text", "content"],
              description:
                "Replacement markdown description; use --description-file for long text",
            },
            "description-file": {
              type: "string",
              placeholder: "path",
              description:
                "Read the replacement description from this UTF-8 file on the invoking machine",
            },
            due: {
              type: "string",
              placeholder: "YYYY-MM-DD",
              aliases: ["due-date"],
              description: "New due date as a calendar date, YYYY-MM-DD",
            },
            "no-due": { type: "boolean", description: "Clear the due date" },
            parent: {
              type: "string",
              placeholder: "key-or-id",
              description:
                "New parent task key or id; tasks support at most one level of sub-tasks",
            },
            "no-epic": {
              type: "boolean",
              description: "Remove the task from its epic",
            },
            "no-parent": {
              type: "boolean",
              description: "Promote the task to the top level",
            },
            "add-label": {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "name",
              description:
                "Existing label name to add; repeat or comma-separate",
            },
            "remove-label": {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "name",
              description: "Label name to remove; repeat or comma-separate",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          constraints: [
            {
              kind: "at-most-one",
              options: ["description", "description-file"],
            },
            { kind: "at-most-one", options: ["due", "no-due"] },
            { kind: "at-most-one", options: ["parent", "no-parent"] },
            { kind: "at-most-one", options: ["epic", "no-epic"] },
            {
              kind: "requires",
              option: "machine",
              needs: ["description-file"],
            },
          ],
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const dueDate = input.options.due;
              const noDue = input.options["no-due"];
              const parentAddress = input.options.parent;
              const noParent = input.options["no-parent"];
              const parent =
                parentAddress === undefined
                  ? undefined
                  : await resolveTask(domain, parentAddress);
              const descriptionFile = input.options["description-file"];
              const clientHostId =
                descriptionFile !== undefined
                  ? await resolveClientHostId(
                      bb,
                      domain,
                      input.options.machine,
                      ctx,
                    )
                  : undefined;
              const description = await readTextOption(
                bb,
                ctx,
                clientHostId,
                input.options.description,
                descriptionFile,
              );
              const labels = await projectLabels(domain, task.projectId);
              const nextLabels = new Set(task.labelIds);
              for (const name of input.options["add-label"]) {
                nextLabels.add(resolveLabel(labels, name).id);
              }
              for (const name of input.options["remove-label"]) {
                nextLabels.delete(resolveLabel(labels, name).id);
              }
              const labelsChanged =
                input.options["add-label"].length > 0 ||
                input.options["remove-label"].length > 0;
              if (
                input.options.status === undefined &&
                input.options.priority === undefined &&
                input.options.title === undefined &&
                description === undefined &&
                dueDate === undefined &&
                !noDue &&
                parentAddress === undefined &&
                !noParent &&
                !labelsChanged &&
                input.options.executor === undefined &&
                input.options["requester-thread"] === undefined &&
                input.options.type === undefined &&
                input.options.epic === undefined &&
                !input.options["no-epic"]
              ) {
                throw new CliError("no task changes were provided", {
                  code: "no_changes",
                });
              }
              const result = tasksRpcContract.updateTask.output.parse(
                await domain.updateTask(
                  tasksRpcContract.updateTask.input.parse({
                    taskId: task.id,
                    requesterThreadId:
                      input.options["requester-thread"] ??
                      (input.options.executor === "owner" &&
                      !task.requesterThreadId
                        ? (ctx.threadId ?? process.env.BB_THREAD_ID)
                        : undefined),
                    type: input.options.type,
                    executionTarget: input.options.executor,
                    epicId: input.options["no-epic"]
                      ? null
                      : input.options.epic
                        ? (await resolveTask(domain, input.options.epic)).id
                        : undefined,
                    status: input.options.status,
                    priority: input.options.priority,
                    title: input.options.title,
                    description,
                    dueDate: noDue ? null : dueDate,
                    parentTaskId:
                      parentAddress === undefined && !noParent
                        ? undefined
                        : (parent?.id ?? null),
                    labelIds: labelsChanged ? [...nextLabels] : undefined,
                    authorName: taskAuthor(ctx),
                  }),
                ),
              );
              const updated = unwrapTask(result);
              return input.options.json
                ? JSON.stringify({
                    task: updated,
                    ...(result.ok && result.notification
                      ? { notification: result.notification }
                      : {}),
                  })
                : `Updated ${updated.key}  ${updated.title}${result.ok && result.notification === "not_sent" ? "\nWarning: requester thread could not be notified; notify it manually." : ""}`;
            });
          },
        }),

        move: cliCommand({
          summary: "Move a task and its sub-tasks to another project",
          description:
            "Moved tasks get new keys in the target project; their old keys keep resolving. Labels are matched by name in the target project and created there when missing. A sub-task moved on its own is detached from its parent.",
          positionals: [KEY_POSITIONAL],
          options: {
            project: REQUIRED_PROJECT_OPTION,
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const project = await requiredProject(
                domain,
                ctx,
                input.options.project,
              );
              const result = tasksRpcContract.moveTaskToProject.output.parse(
                await domain.moveTaskToProject(
                  tasksRpcContract.moveTaskToProject.input.parse({
                    taskId: task.id,
                    projectId: project.id,
                    authorName: taskAuthor(ctx),
                  }),
                ),
              );
              const moved = unwrapTask(result);
              if (input.options.json) {
                return JSON.stringify({ task: moved, previousKey: task.key });
              }
              return moved.key === task.key
                ? `${task.key} is already in ${project.prefix}`
                : `Moved ${task.key} to ${moved.key}  ${moved.title}`;
            });
          },
        }),

        comment: cliCommand({
          summary: "Add a markdown comment to a task",
          positionals: [KEY_POSITIONAL],
          options: {
            kind: {
              type: "enum",
              values: EVIDENCE_KINDS,
              description:
                "Structured evidence kind; omitted for an ordinary comment",
            },
            pr: {
              type: "integer",
              min: 1,
              max: Number.MAX_SAFE_INTEGER,
              description: "Pull request number",
            },
            head: { type: "string", description: "Full git head SHA" },
            merge: { type: "string", description: "Full trunk merge SHA" },
            verdict: { type: "string", description: "Review or QA verdict" },
            thread: {
              type: "string",
              description: "bb thread id for review or QA",
            },
            lens: { type: "string", description: "Review lens" },
            target: {
              type: "string",
              description: "QA target: local, development or localenv",
            },
            note: {
              type: "string",
              description: "Repository-relative findings note",
            },
            part: { type: "string", description: "Delivery part k/m" },
            run: { type: "string", description: "CI run id or URL" },
            env: { type: "string", description: "Deploy environment" },
            row: { type: "string", description: "Exempt obligation" },
            reason: { type: "string", description: "Exemption reason" },
            "owner-quote": {
              type: "string",
              description: "Owner waiver quote; requires --date",
            },
            date: {
              type: "string",
              description: "Owner waiver date YYYY-MM-DD",
            },
            body: {
              type: "string",
              placeholder: "markdown",
              aliases: ["message", "text", "content"],
              description:
                "Comment markdown; use --body-file for long text (exactly one of the two)",
            },
            "body-file": {
              type: "string",
              placeholder: "path",
              description:
                "Read the comment from this UTF-8 file on the invoking machine",
            },
            author: {
              type: "string",
              placeholder: "name",
              description:
                "Display name for the comment; defaults to the invoking thread or cli",
            },
            notify: {
              type: "boolean",
              description:
                "Deliver the comment to the thread that wrote the task's latest agent reply",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "exactly-one", options: ["body", "body-file"] },
            { kind: "requires", option: "machine", needs: ["body-file"] },
          ],
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const bodyFile = input.options["body-file"];
              const clientHostId =
                bodyFile !== undefined
                  ? await resolveClientHostId(
                      bb,
                      domain,
                      input.options.machine,
                      ctx,
                    )
                  : undefined;
              const body = await readTextOption(
                bb,
                ctx,
                clientHostId,
                input.options.body,
                bodyFile,
              );
              if (body === undefined) {
                throw new CliError("missing required --body or --body-file", {
                  code: "missing_required",
                });
              }
              if (!body.trim()) {
                throw new CliError("comment body must not be blank");
              }
              const evidenceFields = Object.fromEntries(
                [
                  "pr",
                  "head",
                  "merge",
                  "verdict",
                  "thread",
                  "lens",
                  "target",
                  "note",
                  "part",
                  "run",
                  "env",
                  "row",
                  "reason",
                  "date",
                ].flatMap((key) => {
                  const value =
                    input.options[key as keyof typeof input.options];
                  return value === undefined ? [] : [[key, value]];
                }),
              );
              if (input.options["owner-quote"] !== undefined)
                evidenceFields.ownerQuote = input.options["owner-quote"];
              if (!input.options.kind && Object.keys(evidenceFields).length > 0)
                throw new CliError("Evidence fields require --kind");
              const evidence = input.options.kind
                ? evidenceSchema.parse({
                    kind: input.options.kind,
                    ...evidenceFields,
                  })
                : undefined;
              const comment = await createComment(bb, store, {
                taskId: task.id,
                kind: ctx.threadId ? "agent" : "user",
                authorName: input.options.author ?? taskAuthor(ctx),
                presetName: null,
                threadId: ctx.threadId ?? null,
                body,
                ...(evidence ? { evidence } : {}),
                notify: input.options.notify,
                awaitDelivery: true,
              });
              return input.options.json
                ? JSON.stringify({ comment })
                : `Commented on ${task.key}  ${comment.id}`;
            });
          },
        }),

        label: groupCommand("label", "Create, list, or delete project labels", [
          ["create", "Create a label in a project"],
          ["list", "List a project's labels"],
          ["delete", "Delete a label"],
        ]),
        "label create": cliCommand({
          summary: "Create a project label",
          options: {
            project: REQUIRED_PROJECT_OPTION,
            name: { type: "string", required: true, description: "Label name" },
            color: {
              type: "string",
              default: DEFAULT_LABEL_COLOR,
              description: "Label color name",
            },
            json: JSON_OPTION,
          },
          unexpectedPositionalHint: "the label name belongs in --name <name>.",
          run(input, ctx) {
            return guard(async () => {
              const project = await requiredProject(
                domain,
                ctx,
                input.options.project,
              );
              const result = tasksRpcContract.createLabel.output.parse(
                await domain.createLabel(
                  tasksRpcContract.createLabel.input.parse({
                    projectId: project.id,
                    name: input.options.name,
                    color: input.options.color,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Created label ${result.label.name}  ${result.label.id}`;
            });
          },
        }),
        "label list": cliCommand({
          summary: "List a project's labels",
          options: { project: REQUIRED_PROJECT_OPTION, json: JSON_OPTION },
          run(input, ctx) {
            return guard(async () => {
              const project = await requiredProject(
                domain,
                ctx,
                input.options.project,
              );
              const labels = await projectLabels(domain, project.id);
              return input.options.json
                ? JSON.stringify({ labels })
                : table(
                    ["NAME", "COLOR", "ID"],
                    labels.map((label) => [label.name, label.color, label.id]),
                    "No labels.",
                  );
            });
          },
        }),
        "label delete": cliCommand({
          summary: "Delete a project label",
          positionals: [
            {
              name: "name-or-id",
              description: "Label name or its ULID",
              required: true,
            },
          ],
          options: { project: REQUIRED_PROJECT_OPTION, json: JSON_OPTION },
          run(input, ctx) {
            return guard(async () => {
              const project = await requiredProject(
                domain,
                ctx,
                input.options.project,
              );
              const label = resolveLabel(
                await projectLabels(domain, project.id),
                input.positionals["name-or-id"],
              );
              const result = tasksRpcContract.deleteLabel.output.parse(
                await domain.deleteLabel(
                  tasksRpcContract.deleteLabel.input.parse({
                    labelId: label.id,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify({ ...result, label })
                : `Deleted label ${label.name}`;
            });
          },
        }),

        attachment: groupCommand(
          "attachment",
          "Add, download, list, or remove task attachments",
          [
            ["add", "Attach a file to a task or comment"],
            ["get", "Download an attachment to a path"],
            ["list", "List a task's attachments"],
            ["remove", "Remove an attachment"],
          ],
        ),
        "attachment add": cliCommand({
          summary: "Attach a file to a task or comment",
          description:
            "File paths are read from the invoking machine: the thread's machine inside an agent thread, otherwise the server's.",
          positionals: [
            {
              name: "key-or-comment-id",
              description:
                "Task key such as ABC-12, a task ULID, or a comment ULID",
              required: true,
            },
          ],
          options: {
            file: {
              type: "string",
              required: true,
              placeholder: "path",
              aliases: ["path", "attach"],
              description: "Source file to upload, at most 25 MB",
            },
            name: {
              type: "string",
              description: "Stored file name; defaults to the source basename",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const ownerAddress = input.positionals["key-or-comment-id"];
              const sourcePath = resolve(
                ctx.cwd ?? process.cwd(),
                input.options.file,
              );
              const normalizedOwner = ownerAddress.trim().toUpperCase();
              const comment = ULID_PATTERN.test(normalizedOwner)
                ? store.tasks.getComment(normalizedOwner)
                : undefined;
              if (ULID_PATTERN.test(normalizedOwner) && !comment) {
                throw new CliError(`comment not found: ${ownerAddress}`, {
                  code: "comment_not_found",
                });
              }
              const owner = comment
                ? { commentId: comment.id }
                : { taskId: (await resolveTask(domain, ownerAddress)).id };
              const clientHostId = await resolveClientHostId(
                bb,
                domain,
                input.options.machine,
                ctx,
              );
              const content = await readAttachmentSource(
                bb,
                clientHostId,
                sourcePath,
              );
              const attachment = await saveAttachmentFromBytes(
                store.tasks,
                content,
                {
                  ...owner,
                  fileName:
                    input.options.name ?? attachmentFileName(sourcePath),
                },
              );
              publishAttachmentChanged(bb, store.tasks, attachment);
              return input.options.json
                ? JSON.stringify({
                    attachment,
                    url: attachmentDownloadUrl(attachment.id),
                  })
                : `Added attachment ${attachment.fileName}  ${attachment.id}`;
            });
          },
        }),
        "attachment get": cliCommand({
          summary: "Download an attachment to a path",
          description:
            "The file is written on the invoking machine: the thread's machine inside an agent thread, otherwise the server's.",
          positionals: [
            {
              name: "attachment-id",
              description: "Attachment ULID from bb tasks attachment list",
              required: true,
            },
          ],
          options: {
            out: {
              type: "string",
              required: true,
              placeholder: "path",
              short: "o",
              aliases: ["output", "to"],
              description:
                "Destination path; missing parent directories are created",
            },
            machine: MACHINE_OPTION,
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const outPath = resolve(
                ctx.cwd ?? process.cwd(),
                input.options.out,
              );
              const clientHostId = await resolveClientHostId(
                bb,
                domain,
                input.options.machine,
                ctx,
              );
              const { attachment, content } = await readAttachmentContent(
                store.tasks,
                input.positionals["attachment-id"],
              );
              await writeClientFile(bb, clientHostId, outPath, content);
              return input.options.json
                ? JSON.stringify({ attachment, out: outPath })
                : `Saved ${attachment.fileName}  ${outPath}`;
            });
          },
        }),
        "attachment list": cliCommand({
          summary: "List a task's attachments",
          positionals: [KEY_POSITIONAL],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const comments = tasksRpcContract.listComments.output.parse(
                await domain.listComments(
                  tasksRpcContract.listComments.input.parse({
                    taskId: task.id,
                  }),
                ),
              ).comments;
              const attachments = await listTaskAttachments(
                domain,
                task.id,
                comments,
              );
              return input.options.json
                ? JSON.stringify({ task, attachments })
                : table(
                    ["ID", "NAME", "TYPE", "SIZE"],
                    attachments.map((attachment) => [
                      attachment.id,
                      attachment.fileName,
                      attachment.mime,
                      bytes(attachment.sizeBytes),
                    ]),
                    "No attachments.",
                  );
            });
          },
        }),
        "attachment remove": cliCommand({
          summary: "Remove an attachment",
          positionals: [
            {
              name: "attachment-id",
              description: "Attachment ULID from bb tasks attachment list",
              required: true,
            },
          ],
          options: {
            "remove-references": {
              type: "boolean",
              description:
                "Also strip the attachment's links from the task description",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return guard(async () => {
              const attachmentId = input.positionals["attachment-id"];
              const result = tasksRpcContract.deleteAttachment.output.parse(
                await domain.deleteAttachment(
                  tasksRpcContract.deleteAttachment.input.parse({
                    attachmentId: attachmentId.trim(),
                    removeDescriptionReferences:
                      input.options["remove-references"],
                  }),
                ),
              );
              if (!result.ok) throw new CliError(result.error.message);
              if (!result.deleted) {
                throw new CliError(`attachment not found: ${attachmentId}`, {
                  code: "attachment_not_found",
                });
              }
              return input.options.json
                ? JSON.stringify({
                    deleted: true,
                    attachment: result.attachment,
                  })
                : `Removed attachment ${result.attachment.fileName}  ${result.attachment.id}`;
            });
          },
        }),

        preset: groupCommand(
          "preset",
          "List, show, create, update, or delete dispatch presets",
          [
            ["list", "List dispatch presets"],
            ["show", "Show one preset"],
            ["create", "Create a preset"],
            ["update", "Update a preset"],
            ["delete", "Delete a preset"],
          ],
        ),
        "preset list": cliCommand({
          summary: "List dispatch presets",
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const presets = await listPresets(domain);
              return input.options.json
                ? JSON.stringify({ presets })
                : table(
                    [
                      "NAME",
                      "PROVIDER",
                      "MODEL",
                      "REASONING",
                      "SERVICE TIER",
                      "PERMISSION",
                      "ENVIRONMENT",
                      "BASE BRANCH",
                      "MACHINE",
                      "BUILTIN",
                      "ID",
                    ],
                    presets.map((preset) => [
                      preset.name,
                      preset.providerId,
                      preset.modelId,
                      preset.reasoningLevel,
                      preset.serviceTier ?? "-",
                      preset.permissionMode,
                      presetEnvironmentLabel(preset),
                      preset.baseBranch ?? "-",
                      preset.machineId ?? "-",
                      preset.builtin ? "yes" : "no",
                      preset.id,
                    ]),
                    "No presets.",
                  );
            });
          },
        }),
        "preset show": cliCommand({
          summary: "Show one dispatch preset",
          positionals: [
            {
              name: "name-or-id",
              description: "Preset name (case-insensitive) or its ULID",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const preset = resolvePreset(
                await listPresets(domain),
                input.positionals["name-or-id"],
              );
              return input.options.json
                ? JSON.stringify({ preset })
                : detail([
                    ["Name", preset.name],
                    ["Provider", preset.providerId],
                    ["Model", preset.modelId],
                    ["Reasoning", preset.reasoningLevel],
                    ["Service tier", preset.serviceTier ?? "-"],
                    ["Permission", preset.permissionMode],
                    ["Environment", presetEnvironmentLabel(preset)],
                    ["Base branch", preset.baseBranch ?? "-"],
                    ["Machine", preset.machineId ?? "-"],
                    ["Instructions", preset.instructions || "-"],
                    ["Built in", preset.builtin ? "yes" : "no"],
                    ["ID", preset.id],
                  ]);
            });
          },
        }),
        "preset create": cliCommand({
          summary: "Create a dispatch preset",
          options: {
            name: {
              type: "string",
              required: true,
              description: "Preset name shown in dispatch menus",
            },
            provider: {
              type: "string",
              required: true,
              placeholder: "id",
              description: "Provider id such as codex or claude-code",
            },
            model: {
              type: "string",
              required: true,
              placeholder: "id",
              description: "Model id as the provider spells it",
            },
            reasoning: {
              type: "string",
              required: true,
              placeholder: "level",
              description: "Reasoning level id the model lists",
            },
            permission: {
              type: "enum",
              values: PRESET_PERMISSION_MODES,
              required: true,
              description: "Permission mode for the dispatched thread",
            },
            "service-tier": {
              type: "string",
              placeholder: "tier",
              description:
                "Service tier id the provider lists for the model, such as default or fast",
            },
            "clear-service-tier": {
              type: "boolean",
              description: "Leave the preset without a service tier",
            },
            environment: {
              type: "enum",
              values: PRESET_ENVIRONMENTS,
              default: "project-default",
              description:
                "Where the thread runs; --base-branch and --machine require worktree",
            },
            "base-branch": {
              type: "string",
              placeholder: "branch",
              description: "Branch new worktrees start from",
            },
            machine: {
              type: "string",
              placeholder: "id-or-name",
              description: "Enrolled machine that hosts the worktree",
            },
            instructions: {
              type: "string",
              placeholder: "text",
              description: "Extra instructions prepended to every dispatch",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return guard(async () => {
              const environmentKind = presetEnvironmentKind(
                input.options.environment,
                "project-default",
              );
              const baseBranch = input.options["base-branch"];
              const machine = input.options.machine;
              validatePresetTargetOptions({
                environmentKind,
                baseBranch,
                machine,
              });
              const result = tasksRpcContract.createPreset.output.parse(
                await domain.createPreset(
                  tasksRpcContract.createPreset.input.parse({
                    name: input.options.name,
                    providerId: input.options.provider,
                    modelId: input.options.model,
                    reasoningLevel: input.options.reasoning,
                    serviceTier:
                      presetServiceTier(
                        input.options["service-tier"],
                        input.options["clear-service-tier"],
                      ) ?? null,
                    permissionMode: input.options.permission,
                    environmentKind,
                    baseBranch: baseBranch ?? null,
                    machineId:
                      machine === undefined
                        ? null
                        : await resolveMachineId(domain, machine),
                    instructions: input.options.instructions ?? "",
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Created preset ${result.preset.name}  ${result.preset.id}`;
            });
          },
        }),
        "preset update": cliCommand({
          summary: "Update a dispatch preset",
          positionals: [
            {
              name: "name-or-id",
              description: "Preset name (case-insensitive) or its ULID",
              required: true,
            },
          ],
          options: {
            name: { type: "string", description: "New preset name" },
            provider: {
              type: "string",
              placeholder: "id",
              description: "Provider id such as codex or claude-code",
            },
            model: {
              type: "string",
              placeholder: "id",
              description: "Model id as the provider spells it",
            },
            reasoning: {
              type: "string",
              placeholder: "level",
              description: "Reasoning level id the model lists",
            },
            permission: {
              type: "enum",
              values: PRESET_PERMISSION_MODES,
              description: "Permission mode for the dispatched thread",
            },
            "service-tier": {
              type: "string",
              placeholder: "tier",
              description:
                "Service tier id the provider lists for the model, such as default or fast",
            },
            "clear-service-tier": {
              type: "boolean",
              description: "Leave the preset without a service tier",
            },
            environment: {
              type: "enum",
              values: PRESET_ENVIRONMENTS,
              description:
                "Where the thread runs; switching to project-default clears --base-branch and --machine",
            },
            "base-branch": {
              type: "string",
              placeholder: "branch",
              description: "Branch new worktrees start from",
            },
            machine: {
              type: "string",
              placeholder: "id-or-name",
              description: "Enrolled machine that hosts the worktree",
            },
            instructions: {
              type: "string",
              placeholder: "text",
              description: "Extra instructions prepended to every dispatch",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return guard(async () => {
              const preset = resolvePreset(
                await listPresets(domain),
                input.positionals["name-or-id"],
              );
              const environmentOption = input.options.environment;
              const environmentKind = presetEnvironmentKind(
                environmentOption,
                preset.environmentKind,
              );
              const baseBranch = input.options["base-branch"];
              const machine = input.options.machine;
              validatePresetTargetOptions({
                environmentKind,
                baseBranch,
                machine,
              });
              const result = tasksRpcContract.updatePreset.output.parse(
                await domain.updatePreset(
                  tasksRpcContract.updatePreset.input.parse({
                    presetId: preset.id,
                    name: input.options.name,
                    providerId: input.options.provider,
                    modelId: input.options.model,
                    reasoningLevel: input.options.reasoning,
                    serviceTier: presetServiceTier(
                      input.options["service-tier"],
                      input.options["clear-service-tier"],
                    ),
                    permissionMode: input.options.permission,
                    environmentKind:
                      environmentOption === undefined
                        ? undefined
                        : environmentKind,
                    baseBranch:
                      environmentOption !== undefined &&
                      environmentKind === "project-default"
                        ? null
                        : baseBranch,
                    machineId:
                      environmentOption !== undefined &&
                      environmentKind === "project-default"
                        ? null
                        : machine === undefined
                          ? undefined
                          : await resolveMachineId(domain, machine),
                    instructions: input.options.instructions,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify(result)
                : `Updated preset ${result.preset.name}  ${result.preset.id}`;
            });
          },
        }),
        "preset delete": cliCommand({
          summary: "Delete a dispatch preset",
          positionals: [
            {
              name: "name-or-id",
              description: "Preset name (case-insensitive) or its ULID",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const preset = resolvePreset(
                await listPresets(domain),
                input.positionals["name-or-id"],
              );
              const result = tasksRpcContract.deletePreset.output.parse(
                await domain.deletePreset(
                  tasksRpcContract.deletePreset.input.parse({
                    presetId: preset.id,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify({ ...result, preset })
                : `Deleted preset ${preset.name}`;
            });
          },
        }),

        dispatch: cliCommand({
          summary: "Dispatch a task using a preset or to an existing thread",
          aliases: ["delegate"],
          suggestFor: ["start", "run", "spawn"],
          positionals: [KEY_POSITIONAL],
          options: {
            preset: {
              type: "string",
              placeholder: "name-or-id",
              description:
                "Dispatch preset name or id; run bb tasks preset list to see them",
            },
            thread: {
              type: "string",
              placeholder: "thread-id",
              description:
                "Existing thread to receive the task; use instead of --preset",
            },
            instructions: {
              type: "string",
              placeholder: "text",
              aliases: ["extra-instructions"],
              description: "Extra instructions for this dispatch only",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              if (
                Boolean(input.options.thread) === Boolean(input.options.preset)
              ) {
                throw new CliError(
                  "Specify exactly one of --preset or --thread",
                );
              }
              if (input.options.thread) {
                const result = await delegationHandlers(
                  bb,
                  store,
                ).delegateToThread(
                  delegationRpcContract.delegateToThread.input.parse({
                    taskId: task.id,
                    threadId: input.options.thread,
                    extraInstructions: input.options.instructions,
                  }),
                );
                return input.options.json
                  ? JSON.stringify({ task, ...result })
                  : result.threadId;
              }
              const preset = resolvePreset(
                await listPresets(domain),
                input.options.preset!,
              );
              const result = delegationRpcContract.delegate.output.parse(
                await delegationHandlers(bb, store).delegate(
                  delegationRpcContract.delegate.input.parse({
                    taskId: task.id,
                    presetId: preset.id,
                    extraInstructions: input.options.instructions,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify({ task, preset, ...result })
                : result.threadId;
            });
          },
        }),

        attach: cliCommand({
          summary: "Attach an existing agent thread to a task",
          positionals: [KEY_POSITIONAL],
          options: {
            thread: {
              type: "string",
              placeholder: "thread-id",
              aliases: ["thread-id"],
              description:
                "Thread to attach; defaults to BB_THREAD_ID or the invoking thread",
            },
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const threadId = resolveInvokingThreadId(
                input.options.thread,
                ctx,
              );
              const result =
                delegationRpcContract.taskThreadsAttach.output.parse(
                  await delegationHandlers(bb, store).taskThreadsAttach(
                    delegationRpcContract.taskThreadsAttach.input.parse({
                      taskId: task.id,
                      threadId,
                    }),
                  ),
                );
              return input.options.json
                ? JSON.stringify({ task, ...result })
                : `Attached ${result.threadId} to ${task.key}`;
            });
          },
        }),

        detach: cliCommand({
          summary: "Detach an agent thread from a task",
          positionals: [KEY_POSITIONAL],
          options: {
            thread: {
              type: "string",
              placeholder: "thread-id",
              aliases: ["thread-id"],
              description:
                "Thread to detach; defaults to BB_THREAD_ID or the invoking thread",
            },
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const threadId = resolveInvokingThreadId(
                input.options.thread,
                ctx,
              );
              const result =
                delegationRpcContract.taskThreadsDetach.output.parse(
                  await delegationHandlers(bb, store).taskThreadsDetach(
                    delegationRpcContract.taskThreadsDetach.input.parse({
                      taskId: task.id,
                      threadId,
                    }),
                  ),
                );
              return input.options.json
                ? JSON.stringify({ task, ...result })
                : `Detached ${result.threadId} from ${task.key}`;
            });
          },
        }),

        threads: cliCommand({
          summary: "List agent threads attached to a task",
          positionals: [KEY_POSITIONAL],
          options: { json: JSON_OPTION },
          run(input) {
            return guard(async () => {
              const task = await resolveTask(
                domain,
                input.positionals["key-or-id"],
              );
              const result = tasksRpcContract.listTaskThreads.output.parse(
                await domain.listTaskThreads(
                  tasksRpcContract.listTaskThreads.input.parse({
                    taskId: task.id,
                  }),
                ),
              );
              return input.options.json
                ? JSON.stringify({ task, taskThreads: result.taskThreads })
                : table(
                    ["THREAD", "STATUS", "PRESET", "TITLE"],
                    result.taskThreads.map((thread) => [
                      thread.threadId,
                      thread.liveStatus,
                      thread.presetName,
                      thread.title,
                    ]),
                    "No attached threads.",
                  );
            });
          },
        }),

        "seed-demo": cliCommand({
          summary:
            "Create sample folders, projects, labels, tasks, and comments",
          options: {
            yes: {
              type: "boolean",
              description: "Confirm writing sample data into this workspace",
            },
            json: JSON_OPTION,
          },
          run(input, ctx) {
            return guard(async () => {
              if (!input.options.yes) {
                throw new CliError(
                  "seed-demo creates sample data; re-run with --yes",
                  { code: "confirmation_required" },
                );
              }
              const result = await seedDemo(domain, ctx.projectId);
              return input.options.json
                ? JSON.stringify(result)
                : detail([
                    ["Folders", result.foldersCreated],
                    ["Projects", result.projectsCreated],
                    ["Labels", result.labelsCreated],
                    ["Tasks", result.tasksCreated],
                    ["Comments", result.commentsCreated],
                    ["BB project", result.linkedBbProjectId ?? "-"],
                  ]);
            });
          },
        }),
      },
    }),
  );
}
