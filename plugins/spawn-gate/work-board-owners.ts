import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadId = z.string().regex(/^thr_[a-z0-9]+$/);
const projectId = z.string().regex(/^proj_[a-z0-9]+$/);
const toolName = "spawn_gate_owner";
const parameters = z.object({
  operation: z.enum(["set", "remove"]),
  plugin: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "Use a directory name such as example-plugin, without plugins/ or slashes"),
  ownerThreadId: threadId.optional(),
}).strict();
const localConfig = z.looseObject({
  managerThreadId: threadId,
  owners: z.record(z.string(), threadId),
  roles: z.record(z.string(), z.unknown()),
  ownerAudit: z.array(z.unknown()).optional(),
});

function configPath(project: string) {
  return process.env.BB_SPAWN_GATE_WORK_BOARD_CONFIG ??
    join(homedir(), ".bb", "spawn-gate", "work-board", `${project}.json`);
}

function readConfig(path: string) {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Use a project with readable Work Board builder JSON on the BB server.");
  }
  const parsed = localConfig.safeParse(value);
  if (!parsed.success) throw new Error("Have the owner repair the server-local Work Board builder config.");
  return parsed.data;
}

function replaceConfig(path: string, config: z.infer<typeof localConfig>) {
  const staging = mkdtempSync(join(dirname(path), ".owner-update-"));
  try {
    const file = join(staging, "config.json");
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    renameSync(file, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function registerWorkBoardOwnerTool(bb: BbPluginApi) {
  bb.agents.registerTool({
    name: toolName,
    description: 'Manage one Work Board builder owner from the configured manager thread. Set or replace with {"operation":"set","plugin":"example-plugin","ownerThreadId":"thr_example"}. Remove with {"operation":"remove","plugin":"example-plugin"}.',
    parameters,
    async execute({ operation, plugin, ownerThreadId }, ctx) {
      const project = projectId.safeParse(ctx.projectId);
      const actor = threadId.safeParse(ctx.threadId);
      const error = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
      if (!project.success || !actor.success) return error("Run this tool from the configured manager thread in the target BB project.");
      const path = configPath(project.data);
      if (!isAbsolute(path)) return error("Use an absolute path for the server-local builder config.");
      const readAuthorized = () => {
        const config = readConfig(path);
        if (config.managerThreadId !== actor.data) {
          bb.log.warn(`Work Board owner change refused in ${project.data} for ${actor.data}`);
          throw new Error("Only the configured manager thread can change Work Board builder owners.");
        }
        return config;
      };
      try {
        let config = readAuthorized();
        if (operation === "set") {
          if (!ownerThreadId) return error("Supply ownerThreadId for set.");
          const target = await bb.sdk.threads.get({ threadId: ownerThreadId }).catch(() => null);
          if (!target || target.archivedAt != null || target.deletedAt != null || target.projectId !== project.data) {
            return error("Choose an existing, unarchived owner thread in this BB project.");
          }
          config = readAuthorized();
        } else if (ownerThreadId !== undefined) {
          return error("Omit ownerThreadId for remove.");
        }
        if (ctx.signal.aborted) return error("The owner change was cancelled. Call the tool again to retry.");

        const oldOwner = Object.hasOwn(config.owners, plugin) ? config.owners[plugin] : null;
        const newOwner = ownerThreadId ?? null;
        if (oldOwner === newOwner) return JSON.stringify({ changed: false, plugin, ownerThreadId: newOwner });
        const change = { time: new Date().toISOString(), projectId: project.data, actorThreadId: actor.data, plugin, oldOwner, newOwner };
        if (newOwner === null) delete config.owners[plugin];
        else config.owners[plugin] = newOwner;
        (config.ownerAudit ??= []).push(change);
        replaceConfig(path, config);
        bb.log.info(`Work Board owner changed ${JSON.stringify(change)}`);
        return JSON.stringify({ changed: true, ...change });
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : "Could not save the Work Board builder owner.");
      }
    },
  });
  bb.agents.configure(({ project, thread }) => {
    const tools: string[] = [];
    const selection = { skills: ["spawn-gate"], tools };
    const id = projectId.safeParse(project.id);
    if (!id.success) return selection;
    const path = configPath(id.data);
    if (!isAbsolute(path)) return selection;
    try {
      if (readConfig(path).managerThreadId === thread.id) tools.push(toolName);
    } catch {
      // Builder configuration is optional for projects.
    }
    return selection;
  });
}
