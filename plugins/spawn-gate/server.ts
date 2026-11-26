import { createHash, randomBytes } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { invalidBranch, isBuilderBranch } from "./branch";
import { registerGateCli } from "./cli";
import { createMetrics, reportContract } from "./metrics";
import { migrateLegacyGate } from "./migration";
import { defaultPaceThreshold } from "./pace";
import { createProcessSourceResolver, isProcessPath, type ProcessSource } from "./process-source";
import { invalidRemote, isBuilderRemote } from "./remote";
import { briefInput, createStart, machineSetting, readProcessInstructions, startInput, startOutput } from "./start";
import { registerWorkBoardOwnerTool } from "./work-board-owners";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const admission = /^agent-admission v1 token=([a-f0-9]{64})$/;
const projectValues = z.object({
  enabled: z.boolean(), method: z.enum(["script", "instruction"]), instruction: z.string().max(20_000),
  instructionFile: z.string().max(500).refine(path => !path || isProcessPath(path), "Use a file path relative to the process clone"),
  script: z.string().min(1).max(500), remote: z.string().max(2000).refine(isBuilderRemote, invalidRemote),
  branch: z.string().max(1024).refine(isBuilderBranch, invalidBranch),
  machine: machineSetting,
  ttlMinutes: z.number().int().min(1).max(60),
}).strict();
type ProjectValues = z.infer<typeof projectValues>;
const configGetInput = z.object({ projectId: z.string(), key: projectValues.keyof().optional() }).strict();
const fieldInput = <K extends keyof ProjectValues>(key: K) =>
  z.object({ projectId: z.string(), key: z.literal(key), value: projectValues.shape[key] }).strict();
const configSetInput = z.discriminatedUnion("key", [
  fieldInput("enabled"), fieldInput("method"), fieldInput("instruction"), fieldInput("script"),
  fieldInput("instructionFile"),
  fieldInput("remote"), fieldInput("branch"), fieldInput("machine"), fieldInput("ttlMinutes"),
]);
export const rpcContract = defineRpcContract({
  "settings.read": { experimental_description: "Legacy settings read for all projects. To read one field, call config.get with projectId and key.", input: z.null(), output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), values: projectValues })) }) },
  "settings.write": { experimental_description: "Legacy partial settings write for one project. For one field, call config.set with projectId, key and value.", input: z.object({ projectId: z.string(), values: projectValues.partial() }).strict(), output: projectValues },
  "config.get": { experimental_description: 'Read a project setting, e.g. {"projectId":"proj_example","key":"enabled"}. Omit key to read all fields for that project.', input: configGetInput, output: projectValues.partial() },
  "config.set": { experimental_description: 'Change one project setting, e.g. {"projectId":"proj_example","key":"ttlMinutes","value":15}.', input: configSetInput, output: projectValues.partial() },
  start: { experimental_description: 'Run the project builder in Script mode. Set dryRun explicitly to validate without minting or launching, e.g. {"projectId":"proj_example","parentThreadId":"thr_example","args":[],"dryRun":true}.', input: startInput, output: startOutput },
  ...reportContract,
  mint: {
    experimental_description: 'After following the configured workflow, mint one admission for the same project, parent and exact brief, e.g. {"projectId":"proj_example","parentThreadId":"thr_example","brief":"Review the proposed change."}. Submit the returned prompt verbatim once. In Script mode, start handles minting.',
    input: z.object({ projectId: z.string().regex(/^proj_[a-z0-9]+$/), parentThreadId: z.string().regex(/^thr_[a-z0-9]+$/), brief: briefInput }).strict(),
    output: z.object({ token: z.string(), expiresAt: z.number(), prompt: z.string() }).strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  await migrateLegacyGate(bb);
  registerWorkBoardOwnerTool(bb);
  const settings = bb.settings.define({
    paceThreshold: {
      type: "number", label: "Weekly provider pace threshold", default: defaultPaceThreshold,
      description: "At this ratio or higher, require a reason if another provider eligible for the role is below pace and has quota remaining.",
      experimental_schema: z.number().min(1),
    },
  });
  let config = await bb.storage.kv.get<Record<string, string | number | boolean>>("project-settings-v1") ?? {};
  const resolveSource = createProcessSourceResolver(bb);
  const policy = (projectId: string) => ({
    enabled: config[`enabled_${projectId}`] === true,
    method: (config[`method_${projectId}`] ?? "instruction") === "instruction" ? "instruction" as const : "script" as const,
    instruction: String(config[`instruction_${projectId}`] ?? ""),
    instructionFile: String(config[`instructionFile_${projectId}`] ?? ""),
    script: String(config[`script_${projectId}`] ?? "spawn.py"),
    remote: String(config[`remote_${projectId}`] ?? ""),
    branch: String(config[`branch_${projectId}`] ?? ""),
    machine: String(config[`machine_${projectId}`] ?? ""),
    ttl: Number(config[`ttl_${projectId}`] ?? 10) * 60_000,
  });
  const view = (projectId: string) => { const { ttl, ...values } = policy(projectId); return { ...values, ttlMinutes: ttl / 60_000 }; };
  let writes = Promise.resolve();
  const launchInstructions = (rules: ReturnType<typeof policy>, projectId: string, parentThreadId: string | null) => {
    const parent = parentThreadId ?? "<parent-thread-id>";
    if (rules.method === "script") {
      return `Use this launch script: ${rules.script}. Run bb agent-spawn-gate start --project ${projectId} --parent-thread ${parent} -- <builder args>. The plugin resolves the project's launch source, runs the builder, and mints and submits the admission. Put --dry-run before -- to validate without minting or starting.`;
    }
    return `Read and follow the current launch instructions with bb agent-spawn-gate instructions --project ${projectId}.
Call RPC mint with {"projectId":"${projectId}","parentThreadId":"${parent}","brief":"Review the proposed change."}. Save your actual request to request.json and run bb plugin rpc call ${bb.pluginId} mint --input-file request.json --json. Save the returned prompt verbatim to prompt.txt and submit it once with bb thread spawn --project ${projectId} --parent-thread ${parent} --prompt-file prompt.txt. If the prompt changes or the admission expires, mint again.`;
  };
  bb.agents.contributeInstructions(({ projectId, threadId }) => {
    const rules = policy(projectId);
    if (!rules.enabled) return null;
    return `Spawn Gate requires an admission for every new agent or CLI start in ${projectId}.
${launchInstructions(rules, projectId, threadId)}
Use the configured workflow. Changing gate settings to get a child started changes the policy for every start in the project.`;
  });
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS admissions (thread TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS tokens (digest TEXT PRIMARY KEY, project TEXT NOT NULL, parent TEXT NOT NULL, brief TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const metrics = await createMetrics(bb, db);
  const admitted = db.prepare("SELECT 1 FROM admissions WHERE thread = ?");
  const remember = db.prepare("INSERT OR IGNORE INTO admissions VALUES (?)");
  const consume = db.transaction((token: string, project: string, parent: string, brief: string, thread: string) => {
    const result = db.prepare("DELETE FROM tokens WHERE digest = ? AND project = ? AND parent = ? AND brief = ? AND expires > ?")
      .run(hash(token), project, parent, hash(brief), Date.now());
    if (!result.changes) return false;
    remember.run(thread);
    return true;
  });
  const mint = async ({ projectId, parentThreadId, brief }: { projectId: string; parentThreadId: string; brief: string }, verifySource?: () => Promise<void>) => {
    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    if (parent.projectId !== projectId) throw new Error("Use a parent thread in the requested project, or change projectId to match the parent");
    if (verifySource) await verifySource();
    const token = randomBytes(32).toString("hex"), expiresAt = Date.now() + policy(projectId).ttl;
    db.prepare("DELETE FROM tokens WHERE expires <= ?").run(Date.now());
    db.prepare("INSERT INTO tokens VALUES (?, ?, ?, ?, ?)").run(hash(token), projectId, parentThreadId, hash(brief), expiresAt);
    const lines = brief.split("\n");
    lines.splice(1, 0, `agent-admission v1 token=${token}`);
    return { token, expiresAt, prompt: lines.join("\n") };
  };
  const requireProject = async (projectId: string) => {
    if (!(await bb.sdk.projects.list()).some(project => project.id === projectId)) throw new Error("Unknown project. Run bb project list and pass an existing project ID");
  };
  const instructionText = async (rules: ReturnType<typeof policy>, source: ProcessSource | null, signal?: AbortSignal) => {
    if (source) return readProcessInstructions(source, rules.instructionFile, signal);
    if (!rules.instruction.trim()) throw new Error("Configure launch instructions with a nonempty instruction field in Spawn Gate before minting");
    return rules.instruction;
  };
  const readInstructions = async (projectId: string, signal?: AbortSignal) => {
    await requireProject(projectId);
    const rules = policy(projectId);
    if (rules.method !== "instruction") throw new Error("Use bb agent-spawn-gate start for projects in Script mode.");
    const source = await resolveSource(projectId, { signal });
    return {
      instruction: await instructionText(rules, source, signal),
      ...(source ? { sourceBranch: source.branch, sourceCommit: source.commit } : {}),
    };
  };
  const writeProject = async (projectId: string, values: Partial<ProjectValues>) => {
    await requireProject(projectId);
    const write = writes.then(async () => {
      const next = { ...config };
      for (const [key, value] of Object.entries(values)) next[`${key === "ttlMinutes" ? "ttl" : key}_${projectId}`] = value;
      await bb.storage.kv.set("project-settings-v1", next);
      config = next;
      return view(projectId);
    });
    writes = write.then(() => {}, () => {});
    return write;
  };
  const configGet = async (input: unknown) => {
    const { projectId, key } = configGetInput.parse(input);
    await requireProject(projectId);
    const values = view(projectId);
    return key ? { [key]: values[key] } : values;
  };
  const configSet = async (input: unknown) => {
    const { projectId, key, value } = configSetInput.parse(input);
    const values = await writeProject(projectId, { [key]: value });
    return { [key]: values[key] };
  };
  const start = createStart(bb, mint, policy, token => {
    db.prepare("DELETE FROM tokens WHERE digest = ?").run(hash(token));
  }, metrics.record, resolveSource, async () => (await settings.get()).paceThreshold);
  registerGateCli(bb, { start, report: metrics.report, configGet, configSet, readInstructions });
  bb.rpc.register(rpcContract, {
    async "settings.read"() {
      return { projects: (await bb.sdk.projects.list()).map(project => ({ id: project.id, name: project.name, values: view(project.id) })) };
    },
    "settings.write": ({ projectId, values }) => writeProject(projectId, values),
    "config.get": configGet,
    "config.set": configSet,
    mint: (input, context) => mint(input, async () => {
      const rules = policy(input.projectId);
      const source = await resolveSource(input.projectId, { signal: context.experimental_signal, sync: true });
      if (rules.method === "instruction") await instructionText(rules, source, context.experimental_signal);
    }),
    start: (input, context) => start(input, context.experimental_signal),
    report: metrics.report,
  }, { experimental_discoverable: true });
  bb.experimental_hooks.on("message.dispatch", async (ctx: MessageDispatchHookContext) => {
    const rules = policy(ctx.project.id);
    if (!rules.enabled || admitted.get(ctx.thread.id)) return { action: "proceed" };
    // Existing provider sessions predate this gate; rejected starts have no thread/started event.
    if ((await bb.sdk.threads.events.list({ threadId: ctx.thread.id, types: ["thread/started"], limit: "1" })).length) {
      remember.run(ctx.thread.id);
      return { action: "proceed" };
    }
    // Core labels agent CLI starts as user/no-sender; only non-CLI human windows are exempt.
    if (ctx.initiator === "user" && ctx.senderThreadId === null && ctx.parentThreadId === null && ctx.origin !== "cli" && ctx.origin !== "mixed") {
      remember.run(ctx.thread.id);
      return { action: "proceed" };
    }
    const lines = ctx.input.text.split("\n"), parent = ctx.parentThreadId, token = admission.exec(lines[1] ?? "")?.[1];
    const hasMarker = lines[1]?.startsWith("agent-admission ");
    lines.splice(1, 1);
    if (parent && token && consume(token, ctx.project.id, parent, lines.join("\n"), ctx.thread.id))
      return { action: "proceed" };
    metrics.record(ctx.project.id, "dispatch", hasMarker ? "invalid_admission" : "missing_admission", { parentThreadId: ctx.parentThreadId });
    bb.log.info(`Rejected start ${ctx.thread.id} in ${ctx.project.id} (${ctx.thread.providerId}, ${ctx.initiator})`);
    const problem = !parent ? "Choose a parent thread in this project." : hasMarker
      ? "Admission is invalid for this start. Obtain a fresh admission for this project, parent and exact brief."
      : "This start needs a fresh admission.";
    return { action: "reject", message: `Spawn Gate: ${problem} ${launchInstructions(rules, ctx.project.id, parent)}` };
  });
}
