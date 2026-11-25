import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { registeredValidator } from "../checks/receipt-registry";
import { command } from "../checks/runner";
import { receiptInScope } from "../shared/check-receipt";
import { questionLinks } from "../shared/questions";
import type { TaskQuestion } from "../shared/contract";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
type Action = "add" | "supersede" | "reopen" | "update";
type Check = Pick<TaskQuestion, "taskId" | "kind" | "prompt" | "steps">;
const stale = "the card changed while the receipt was validated; repeat the command";
type Revision = Pick<TaskQuestion, "id" | "revision" | "prompt" | "steps">;
const revision = ({ id, revision, prompt, steps }: Revision) => ({ id, revision, prompt, steps: steps ?? [] });

async function worktree(bb: BbPluginApi, threadId: string) {
  const { environmentId } = await bb.sdk.threads.get({ threadId });
  if (!environmentId) return null;
  const [environment, config] = await Promise.all([bb.sdk.environments.get({ environmentId }), bb.sdk.system.config()]);
  return config.primaryHostId && environment.hostId === config.primaryHostId ? environment.path || null : null;
}

export function receiptGate(bb: BbPluginApi, store: TasksApiStore) {
  const db = bb.storage.database();
  function snapshot(taskId: string, previous?: Revision) {
    const task = store.tasks.getTask(taskId);
    if (!task) return null;
    const project = store.tasks.getProject(task.projectId)!;
    const setting = project.checkReceipt ?? null;
    const rows = db.prepare<[string], { id: string; payload: string }>("SELECT id, payload FROM task_questions WHERE task_id=? ORDER BY id").all(taskId);
    const target = previous && rows.find(row => row.id === previous.id);
    return {
      target: target && revision(JSON.parse(target.payload)),
      projectId: project.id, prefix: project.prefix, key: task.key, setting,
      questions: hash(JSON.stringify(rows)),
      records: db.prepare<[string], { count: number; last: string | null }>("SELECT count(*) AS count, max(comment_id) AS last FROM check_receipt_verdicts WHERE task_id=?").get(taskId),
    };
  }
  return async (action: Action | null, check: Check, input: { askedByThread?: string | null; receipt?: string }, previous?: Revision) => {
    const unused = (reason: string) => input.receipt === undefined ? [] : [`receipt not checked: ${reason}`];
    if (!action || check.kind !== "check" || !input.askedByThread)
      return { warnings: unused("this write does not ask an agent's check") };
    const currentSetting = () => {
      const task = store.tasks.getTask(check.taskId);
      return task && store.tasks.getProject(task.projectId)?.checkReceipt;
    };
    const setting = currentSetting();
    if (!receiptInScope(setting, check.prompt, check.steps) || !setting)
      return {
        warnings: unused(setting ? "link outside receipt scope" : "project validator is off"),
        verify() {
          if (receiptInScope(currentSetting(), check.prompt, check.steps))
            throw new Error(stale);
        },
      };
    const state = store.transaction(() => snapshot(check.taskId, previous));
    if (!state || JSON.stringify(setting) !== JSON.stringify(state.setting) ||
        JSON.stringify(previous && revision(previous)) !== JSON.stringify(state.target)) throw new Error(stale);
    const { receipt } = input;
    const fix = `Produce a fresh receipt with \`${setting.hint}\` and repeat the command with \`--receipt <file>\`.`;
    if (receipt === undefined)
      throw new Error(`${state.key} requires a UI receipt for this check. Produce one with \`${setting.hint}\`, then repeat the command with \`--receipt <file>\`.`);
    const registration = registeredValidator(setting.validatorId);
    const verifyState = () => {
      if (JSON.stringify(state) !== JSON.stringify(snapshot(check.taskId, previous)))
        throw new Error(stale);
      let current;
      try { current = registeredValidator(setting.validatorId); }
      catch (cause) { throw new Error(stale, { cause }); }
      if (JSON.stringify(registration) !== JSON.stringify(current)) throw new Error(stale);
    };
    const binding = previous && { id: previous.id, revision: previous.revision };
    const existing = action === "update" || action === "reopen" ? binding : null;
    const envelope = {
      version: 1, action, project: state.prefix, task: state.key,
      question: { id: existing?.id ?? null, revision: existing?.revision ?? null, prompt: check.prompt, steps: check.steps, links: questionLinks(check.prompt, check.steps) },
      ...(action === "supersede" ? { predecessor: binding } : {}),
      callerThreadId: input.askedByThread, callerWorktree: await worktree(bb, input.askedByThread), receipt,
    };
    const refuse = (reason: string, output = "") => new Error(
      `${state.key}: the check receipt was not accepted (${reason}): ${output.slice(0, 2000)}. ${fix}`
    );
    const { argv, cwd } = registration;
    const result = await command(argv[0], argv.slice(1), cwd, new AbortController().signal, {
      input: JSON.stringify(envelope), separateStdout: true, timeoutMs: setting.timeoutSeconds * 1000,
    }).catch(error => { throw refuse(error instanceof Error ? error.message : String(error), error.output); });
    if (result.code !== 0) throw refuse(`exit ${result.code}`, result.output);
    const verdict = result.stdout?.split(/\r?\n/).find(value => value.trim().length);
    if (!verdict || [...verdict].length > 500) throw refuse("invalid stdout verdict", "Expected a non-empty line of up to 500 characters");
    const digest = hash(receipt);
    return {
      warnings: [],
      verify() {
        const used = db.prepare<[string, string], { task_id: string; question_id: string; revision: number }>(
          "SELECT task_id, question_id, revision FROM check_receipt_verdicts WHERE project_id=? AND verdict=?",
        ).get(state.projectId, verdict);
        if (used) throw new Error(`this receipt was already used for check ${used.question_id} rev ${used.revision} on ${store.tasks.getTask(used.task_id)?.key ?? used.task_id}; produce a fresh receipt`);
        verifyState();
      },
      record(question: TaskQuestion) {
        const comment = store.tasks.createComment({
          taskId: check.taskId, kind: "system", authorName: "Work Board",
          body: `Receipt for check ${question.id} rev ${question.revision} (${action}, validated against rev ${previous?.revision ?? "new"}): sha256 ${digest}\n${verdict}`,
        });
        db.prepare<[string, string, string, string, number, string]>(
          "INSERT INTO check_receipt_verdicts(project_id,verdict,task_id,question_id,revision,comment_id) VALUES(?,?,?,?,?,?)",
        ).run(state.projectId, verdict, check.taskId, question.id, question.revision, comment.id);
      },
    };
  };
}
