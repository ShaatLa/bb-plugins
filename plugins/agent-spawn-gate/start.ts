import { spawn } from "node:child_process";
import { access, constants, mkdir, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const text = z.string().min(1).max(1000);
const projectId = z.string().regex(/^proj_[a-z0-9]+$/);
const parentThreadId = z.string().regex(/^thr_[a-z0-9]+$/);
const baseBranch = z.discriminatedUnion("kind", [z.object({ kind: z.literal("named"), name: text }).strict(), z.object({ kind: z.literal("default") }).strict()]);
const environment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({ type: z.literal("reuse"), environmentId: text }).strict(),
  z.object({ type: z.literal("host"), hostId: text.optional(), workspace: z.discriminatedUnion("type", [
    z.object({ type: z.literal("managed-worktree"), baseBranch }).strict(),
    z.object({ type: z.literal("personal") }).strict(),
    z.object({ type: z.literal("unmanaged"), path: text.refine(isAbsolute, "Workspace path must be absolute") }).strict(),
  ]) }).strict(),
]);
export const buildSchema = z.object({
  version: z.literal(1), brief: z.string().min(1).max(1_000_000),
  spawn: z.object({
    parentThreadId, title: text.optional(), providerId: text.optional(), model: text.optional(), reasoningLevel: text.optional(), serviceTier: text.optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(), parentNotifications: z.enum(["auto", "stuck", "off"]).optional(), environment: environment.optional(),
  }).strict(),
}).strict();
export const startInput = z.object({ projectId, parentThreadId, args: z.array(z.string().max(100_000)).max(256), dryRun: z.boolean().optional() }).strict();
const resultFields = { projectId, parentThreadId, sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/) };
export const startOutput = z.discriminatedUnion("dryRun", [
  z.object({ dryRun: z.literal(true), ...resultFields, build: buildSchema }).strict(),
  z.object({ dryRun: z.literal(false), ...resultFields, threadId: text }).strict(),
]);
type Request = z.infer<typeof startInput>;

async function executable(name: string, env: NodeJS.ProcessEnv, candidates: (string | undefined)[] = []) {
  for (const candidate of [...candidates, ...(env.PATH ?? "").split(delimiter).filter(isAbsolute).map(dir => join(dir, name))]) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installed executable. */ }
  }
  throw new Error(`Cannot resolve ${name} in the bb server environment`);
}

export async function builderEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const cli = await executable("bb", env, [env.BB_CLI, env.BB_CLI_LAUNCHER, env.BB_CLI_DIR ? join(env.BB_CLI_DIR, "bb") : undefined]);
  return { ...env, BB_CLI: cli, PATH: [dirname(cli), env.PATH].filter(Boolean).join(delimiter) };
}

// All paths here belong to this plugin's server-local checkout, never the caller's cwd.
function run(command: string, args: string[], cwd: string, signal: AbortSignal, input = "", env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", bytes = 0;
    const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out after 60 seconds`)); }, 60_000);
    const collect = (chunk: string, output: boolean) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > 1_048_576) { child.kill("SIGKILL"); reject(new Error(`${command} output exceeds 1 MiB`)); return; }
      if (output) stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.stdin.on("error", () => {}); // Early builder exit is reported by close, including stderr.
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-16_000)}`));
    });
    child.stdin.end(input);
  });
}

export function createStart(bb: BbPluginApi, mint: (request: { projectId: string; parentThreadId: string; brief: string }) => Promise<{ prompt: string; token: string }>, policy: (id: string) => { method: string; script: string }, revoke: (token: string) => void) {
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  const queues = new Map<string, Promise<unknown>>();
  return async (raw: Request, signal = controller.signal) => {
    signal = AbortSignal.any([controller.signal, signal]);
    const request = startInput.parse(raw);
    const operation = async () => {
      signal.throwIfAborted();
      const parent = await bb.sdk.threads.get({ threadId: request.parentThreadId });
      if (parent.projectId !== request.projectId) throw new Error("Parent belongs to another project");
      const rules = policy(request.projectId);
      if (rules.method !== "script") throw new Error("start requires Script mode; Instruction mode still uses mint");
      const project = await bb.sdk.projects.get({ projectId: request.projectId });
      const remote = project.gitRemoteUrl;
      if (!remote || remote.startsWith("-")) throw new Error("Project needs a Git remote");
      const root = join(dirname(bb.storage.database().name), "checkouts", request.projectId);
      await mkdir(root, { recursive: true });
      const git = (args: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", ...args], root, signal, "", { ...process.env, GIT_TERMINAL_PROMPT: "0" });
      try { await stat(join(root, ".git")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await git(["init"]);
        await git(["remote", "add", "origin", remote]);
      }
      await git(["remote", "set-url", "origin", remote]);
      const head = await git(["ls-remote", "--symref", "origin", "HEAD"]);
      const branch = /^ref: (refs\/heads\/[^\s]+)\s+HEAD$/m.exec(head)?.[1];
      if (!branch) throw new Error("Remote HEAD must identify a default branch");
      await git(["fetch", "--depth=1", "origin", branch]);
      const sourceCommit = (await git(["rev-parse", "FETCH_HEAD"])).trim();
      await git(["checkout", "--force", "--detach", sourceCommit]);
      await git(["clean", "-ffdx"]);
      const candidate = join(root, rules.script), lexical = relative(root, candidate);
      if (isAbsolute(rules.script) || lexical === ".." || lexical.startsWith("../") || isAbsolute(lexical)) throw new Error("Launch script must stay inside the checkout");
      const script = await realpath(candidate);
      const inside = relative(await realpath(root), script);
      if (isAbsolute(rules.script) || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) throw new Error("Launch script must stay inside the checkout");
      const env = { ...await builderEnvironment(), BB_PROJECT_ID: request.projectId, BB_THREAD_ID: request.parentThreadId };
      const python = script.endsWith(".py") ? await executable("python3", env) : undefined;
      bb.log.info(`Builder runtime: BB_CLI=${env.BB_CLI}; python3=${python ?? "not used"}`);
      const stdout = await run(python ?? script, [...(python ? [script] : []), ...request.args], root, signal,
        JSON.stringify({ version: 1, projectId: request.projectId, parentThreadId: request.parentThreadId }) + "\n", env);
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { throw new Error("Builder stdout must be one JSON object (v1); send logs to stderr"); }
      const build = buildSchema.parse(parsed);
      if (build.spawn.parentThreadId !== request.parentThreadId) throw new Error("Builder parent must match the requested parent");
      const target = build.spawn.environment;
      if (target?.type === "host" && !target.hostId && target.workspace.type !== "personal") {
        const parentEnvironment = parent.environmentId ? await bb.sdk.environments.get({ environmentId: parent.environmentId }) : null;
        const hostId = parentEnvironment?.hostId ?? project.sources.find(source => source.isDefault)?.hostId;
        if (!hostId) throw new Error("Cannot resolve execution host: set hostId or configure a project default source");
        target.hostId = hostId;
      }
      const common = { projectId: request.projectId, parentThreadId: request.parentThreadId, sourceCommit };
      if (request.dryRun) return { dryRun: true as const, ...common, build };
      signal.throwIfAborted();
      const admission = await mint({ projectId: request.projectId, parentThreadId: request.parentThreadId, brief: build.brief });
      try {
        signal.throwIfAborted();
        const thread = await bb.sdk.threads.spawn({ ...build.spawn, projectId: request.projectId, prompt: admission.prompt,
          environment: build.spawn.environment ?? { type: "project-default" }, senderThreadId: request.parentThreadId });
        return { dryRun: false as const, ...common, threadId: thread.id };
      } catch (error) {
        revoke(admission.token);
        throw error;
      }
    };
    const next = (queues.get(request.projectId) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(request.projectId, next);
    try { return await next; } finally { if (queues.get(request.projectId) === next) queues.delete(request.projectId); }
  };
}

export function registerStartCli(bb: BbPluginApi, start: ReturnType<typeof createStart>) {
  const usage = "bb agent-spawn-gate start [--project <id>] [--parent-thread <id>] [--dry-run] -- <builder args...>";
  bb.cli.register({ name: "agent-spawn-gate", summary: "Build a child task from the project's current default branch and start it with admission", rendersHelp: true,
    commands: [{ name: "start", summary: "Refresh the builder, validate its JSON, mint and start", usage }],
    async run(argv, ctx) {
      try {
        if (!argv.length || argv[0] === "--help" || argv.includes("--help") && !argv.includes("--")) return { exitCode: 0, stdout: usage };
        if (argv[0] !== "start") throw new Error(`Unknown command. ${usage}`);
        let projectId = ctx.projectId, parentThreadId = ctx.threadId, dryRun = false, args: string[] = [];
        for (let i = 1; i < argv.length; i++) {
          const flag = argv[i];
          if (flag === "--") { args = argv.slice(i + 1); break; }
          if (flag === "--dry-run") dryRun = true;
          else if (flag === "--json") continue;
          else if (flag === "--project" || flag === "--parent-thread") {
            const value = argv[++i];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
            if (flag === "--project") projectId = value; else parentThreadId = value;
          } else throw new Error(`Unknown option ${flag}; builder arguments must follow --`);
        }
        if (!projectId || !parentThreadId) throw new Error("Supply --project and --parent-thread when no bb thread context is available");
        const result = await start({ projectId, parentThreadId, args, dryRun }, ctx.signal);
        return { exitCode: 0, stdout: JSON.stringify(result) };
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
    },
  });
}
