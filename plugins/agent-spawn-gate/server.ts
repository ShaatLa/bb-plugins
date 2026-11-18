import { createHash, randomBytes } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerGateCli } from "./cli";
import { createMetrics, reportInput, reportOutput } from "./metrics";
import { createStart, startInput, startOutput } from "./start";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const admission = /^agent-admission v1 token=([a-f0-9]{64})$/;
const projectValues = z.object({ enabled: z.boolean(), method: z.enum(["script", "instruction"]), instruction: z.string().max(20_000), script: z.string().min(1).max(500), ttlMinutes: z.number().int().min(1).max(60) }).strict();
type ProjectValues = z.infer<typeof projectValues>;
const configGetInput = z.object({ projectId: z.string(), key: projectValues.keyof().optional() }).strict();
const fieldInput = <K extends keyof ProjectValues>(key: K) =>
  z.object({ projectId: z.string(), key: z.literal(key), value: projectValues.shape[key] }).strict();
const configSetInput = z.discriminatedUnion("key", [
  fieldInput("enabled"), fieldInput("method"), fieldInput("instruction"), fieldInput("script"), fieldInput("ttlMinutes"),
]);
export const rpcContract = defineRpcContract({
  "settings.read": { input: z.null(), output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), values: projectValues })) }) },
  "settings.write": { input: z.object({ projectId: z.string(), values: projectValues.partial() }).strict(), output: projectValues },
  "config.get": { input: configGetInput, output: projectValues.partial() },
  "config.set": { input: configSetInput, output: projectValues.partial() },
  start: { input: startInput, output: startOutput },
  report: { input: reportInput, output: reportOutput },
  mint: {
    input: z.object({ projectId: z.string().regex(/^proj_[a-z0-9]+$/), parentThreadId: z.string().regex(/^thr_[a-z0-9]+$/), brief: z.string().min(1).max(1_000_000) }).strict(),
    output: z.object({ token: z.string(), expiresAt: z.number(), prompt: z.string() }).strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  let config = await bb.storage.kv.get<Record<string, string | number | boolean>>("project-settings-v1") ?? {};
  const policy = (projectId: string) => ({
    enabled: config[`enabled_${projectId}`] === true,
    method: (config[`method_${projectId}`] ?? "instruction") === "instruction" ? "instruction" as const : "script" as const,
    instruction: String(config[`instruction_${projectId}`] ?? ""),
    script: String(config[`script_${projectId}`] ?? "spawn.py"),
    ttl: Number(config[`ttl_${projectId}`] ?? 10) * 60_000,
  });
  const view = (projectId: string) => { const { ttl, ...values } = policy(projectId); return { ...values, ttlMinutes: ttl / 60_000 }; };
  let writes = Promise.resolve();
  bb.agents.contributeInstructions(({ projectId, threadId }) => {
    const rules = policy(projectId);
    if (!rules.enabled) return null;
    const workflow = rules.method === "script" ? `Use this launch script: ${rules.script}. Run bb agent-spawn-gate start -- <builder args> to use its current remote-default-branch version` : `Follow these launch instructions:
${rules.instruction || "Launch instructions are empty. Ask the owner to configure Agent Spawn Gate before starting children."}`;
    const launch = rules.method === "script"
      ? `Run bb agent-spawn-gate start --project ${projectId} --parent-thread ${threadId} -- <builder args>. The plugin refreshes the remote default branch, runs the builder, mints and starts the child. Use --dry-run before -- to validate without starting. RPC start takes {projectId, parentThreadId, args, dryRun?}.`
      : `Call plugin agent-spawn-gate RPC mint with {projectId: "${projectId}", parentThreadId: "${threadId}", brief: <complete child task>}. CLI: bb plugin rpc call agent-spawn-gate mint --input-file <request.json> --json. Submit its prompt verbatim with bb thread spawn --project ${projectId} --parent-thread ${threadId} --prompt-file <prompt.txt>. Do not modify or reuse tokens.`;
    return `Agent Spawn Gate — child sessions in project ${projectId}:
${workflow}
${launch}
The brief may be plain task text; no Work Board card or marker is required.`;
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
  const mint = async ({ projectId, parentThreadId, brief }: { projectId: string; parentThreadId: string; brief: string }) => {
      const rules = policy(projectId);
      if (rules.method === "instruction" && !rules.instruction.trim()) throw new Error("Configure launch instructions before minting an admission");
      if (brief.split("\n").some(line => line.startsWith("agent-admission ")))
        throw new Error("Embedded admission is not allowed");
      const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
      if (parent.projectId !== projectId) throw new Error("Parent belongs to another project");
      const token = randomBytes(32).toString("hex"), expiresAt = Date.now() + rules.ttl;
      db.prepare("DELETE FROM tokens WHERE expires <= ?").run(Date.now());
      db.prepare("INSERT INTO tokens VALUES (?, ?, ?, ?, ?)").run(hash(token), projectId, parentThreadId, hash(brief), expiresAt);
      const lines = brief.split("\n");
      lines.splice(1, 0, `agent-admission v1 token=${token}`);
      return { token, expiresAt, prompt: lines.join("\n") };
    };
  const requireProject = async (projectId: string) => {
    if (!(await bb.sdk.projects.list()).some(project => project.id === projectId)) throw new Error("Unknown project");
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
  }, metrics.record);
  registerGateCli(bb, { start, report: metrics.report, configGet, configSet });
  bb.rpc.register(rpcContract, {
    async "settings.read"() {
      return { projects: (await bb.sdk.projects.list()).map(project => ({ id: project.id, name: project.name, values: view(project.id) })) };
    },
    "settings.write": ({ projectId, values }) => writeProject(projectId, values),
    "config.get": configGet,
    "config.set": configSet,
    mint,
    start: (input, context) => start(input, context.experimental_signal),
    report: metrics.report,
  });
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
    if (parent && token && parent === ctx.parentThreadId && consume(token, ctx.project.id, parent, lines.join("\n"), ctx.thread.id))
      return { action: "proceed" };
    metrics.record(ctx.project.id, "dispatch", hasMarker ? "invalid_admission" : "missing_admission");
    bb.log.info(`Rejected start ${ctx.thread.id} in ${ctx.project.id} (${ctx.thread.providerId}, ${ctx.initiator})`);
    return { action: "reject", message: `Agent Spawn Gate: starts in ${ctx.project.name} require ${rules.method === "script" ? `bb agent-spawn-gate start -- (${rules.script})` : `these launch instructions: ${rules.instruction || "(not configured)"}`} and a fresh agent-spawn-gate mint admission for this project, parent and exact brief.` };
  });
}
