import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CONFIG_KEYS, DEFAULT_SKILLS_DIR, DOC_SKILL, GRACE_MS, ROOT_CAP, SOURCE_STATES, STATUS_TTL_MS, computeStatus, configKey, evaluateSkills, parseConfigValue, realProbes, scanSkill, skillNames, skillsRootOf, sourceGet, sourceOf, syncLinks,
  type ProjectConfig, type Probes, type Source, type Status,
} from "./core";

const projectId = z.string().min(1).max(200);
const configGet = z.object({ projectId, key: z.string().min(1).optional() }).strict();
const configSet = z.object({ projectId, key: z.string().min(1), value: z.unknown() }).strict();
const checkInput = z.object({ projectId }).strict();
const nullable = z.string().nullable();
/** The `source.get` result; callers in other plugins pass their own copy as `outputSchema`. */
export const sourceResult = z.object({
  projectId: z.string(), configured: z.boolean(), enabled: z.boolean(),
  clonePath: nullable, branch: nullable, head: nullable, originHead: nullable,
  state: z.enum(SOURCE_STATES), reason: nullable, fetchedAt: z.number().nullable(),
}).strict();
export const rpcContract = defineRpcContract({
  "config.get": { input: configGet, output: z.unknown() },
  "config.set": { input: configSet, output: z.unknown() },
  check: { input: checkInput, output: z.unknown() },
  "source.get": { input: checkInput, output: sourceResult },
});

/** The plugin's own directory (the one with its package.json), whether this runs from source or from dist/. */
function pluginDir() {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) throw new Error("plugin directory not found");
  }
}

type Env = { now?: () => number; linkedDir?: string; graceMs?: number; probes?: Probes };
const MAX_SKIPPED = 50;

export default async function plugin(bb: BbPluginApi, env: Env = {}) {
  const now = env.now ?? Date.now, graceMs = env.graceMs ?? GRACE_MS;
  const linkedDir = env.linkedDir ?? join(pluginDir(), "linked-skills");
  const configs = new Map<string, ProjectConfig>();
  const memo = new Map<string, { at: number; key: string; status: Status }>();
  const lastReason = new Map<string, string>();

  const enabledSources = () => [...configs].flatMap(([id, c]) => { const s = c.enabled ? sourceOf(c) : null; return s ? [[id, s] as const] : []; });
  /** Names this project shares with another enabled project, mapped to that project. */
  const clashesOf = (id: string, own: Source) => {
    const mine = new Set(skillNames(skillsRootOf(own))), clashes = new Map<string, string>();
    for (const [other, s] of enabledSources()) if (other !== id) for (const n of skillNames(skillsRootOf(s))) if (mine.has(n)) clashes.set(n, other);
    return clashes;
  };
  const syncAll = () => {
    const sources = enabledSources(), count = new Map<string, number>();
    for (const [, s] of sources) for (const n of skillNames(skillsRootOf(s))) count.set(n, (count.get(n) ?? 0) + 1);
    const wanted = new Map<string, string>();
    for (const [, s] of sources) for (const n of skillNames(skillsRootOf(s))) if (n !== DOC_SKILL && count.get(n) === 1 && !scanSkill(skillsRootOf(s), n).error) wanted.set(n, join(skillsRootOf(s), n));
    try { syncLinks(linkedDir, wanted); } catch (e) { bb.log.warn(`Skill link sync failed: ${e instanceof Error ? e.message : e}`); }
  };
  /** One source status per resolution, shared by the root and the skills, memoized for 2 s. */
  const statusOf = (id: string, c: ProjectConfig): Status => {
    const key = JSON.stringify(c), hit = memo.get(id);
    if (hit && hit.key === key && now() - hit.at < STATUS_TTL_MS) return hit.status;
    const status = computeStatus(c);
    memo.set(id, { at: now(), key, status });
    const reason = status.ok ? "" : status.reason;
    if (lastReason.get(id) !== reason) { lastReason.set(id, reason); if (reason) bb.log.warn(`Project ${id}: process root not injected: ${reason}`); }
    return status;
  };
  const effective = (c: ProjectConfig) => ({ clonePath: c.clonePath ?? null, branch: c.branch ?? null, rootFile: c.rootFile ?? null, skillsDir: c.skillsDir ?? DEFAULT_SKILLS_DIR, enabled: c.enabled ?? false });

  bb.agents.contributeInstructions(({ projectId: id }) => {
    const c = configs.get(id);
    if (!c?.enabled) return null;
    try {
      const st = statusOf(id, c);
      if (!st.ok) return `The project process root was not injected: ${st.reason}.`;
      return `Project process root, read from ${st.rootPath} on branch ${st.branch}. Relative links in it resolve from ${st.rootDir}.\n\n${st.text}`;
    } catch (e) { bb.log.warn(`Project ${id}: ${e instanceof Error ? e.message : e}`); return null; }
  });

  bb.agents.configure(({ project }) => {
    const base = { tools: [], skills: [DOC_SKILL] };
    const c = configs.get(project.id), source = c?.enabled ? sourceOf(c) : null;
    if (!c || !source) return base;
    try {
      if (!statusOf(project.id, c).ok) return base;
      const { selectable } = evaluateSkills(source, linkedDir, now(), clashesOf(project.id, source), graceMs);
      syncAll();
      return { tools: [], skills: [DOC_SKILL, ...selectable] };
    } catch (e) { bb.log.warn(`Project ${project.id}: ${e instanceof Error ? e.message : e}`); return base; }
  });

  const getConfig = ({ projectId: id, key }: z.infer<typeof configGet>) => {
    const value = effective(configs.get(id) ?? {});
    if (key === undefined) return value;
    if (!Object.hasOwn(value, key)) throw new Error("Unknown key. Valid keys: " + CONFIG_KEYS.join(", "));
    return value[key as keyof typeof value];
  };
  const setConfig = async ({ projectId: id, key, value: raw }: z.infer<typeof configSet>) => {
    const value = parseConfigValue(key, raw), next = { ...configs.get(id), [key]: value } as ProjectConfig;
    if (key === "enabled" && value === true) {
      const source = sourceOf(next);
      if (!source) throw new Error("Set clonePath, branch and rootFile before enabling");
      const clashes = clashesOf(id, source);
      if (clashes.size) throw new Error("Not enabled: skills also in another enabled project: " + [...clashes].map(([n, p]) => `${n} (${p})`).join(", "));
    }
    await bb.storage.kv.set(configKey(id), next);
    configs.set(id, next); memo.delete(id);
    bb.log.info(`Project ${id}: ${key} set to ${JSON.stringify(value)}`);
    syncAll();
    return value;
  };
  const check = ({ projectId: id }: z.infer<typeof checkInput>) => {
    const c = configs.get(id) ?? {}, source = sourceOf(c), st = computeStatus(c);
    const skills = source ? evaluateSkills(source, linkedDir, now(), clashesOf(id, source), graceMs) : null;
    return {
      projectId: id, config: effective(c), enabled: c.enabled ?? false,
      source: st.ok ? { ok: true, rootPath: st.rootPath, rootLength: st.text.length, cap: ROOT_CAP, branch: st.branch } : { ok: false, reason: st.reason, rootPath: st.rootPath ?? null, rootLength: st.length ?? null, cap: ROOT_CAP },
      skills: skills && { selectable: st.ok ? skills.selectable : [], skipped: skills.skipped.slice(0, MAX_SKIPPED), moreSkipped: Math.max(0, skills.skipped.length - MAX_SKIPPED) },
      note: !c.enabled ? "Not enabled: nothing is injected and no skill is linked yet." : st.ok ? null : "The source status failed, so no skill of this project is offered either.",
    };
  };
  const checkText = (r: ReturnType<typeof check>) => [
    `Project ${r.projectId}: ${r.enabled ? "enabled" : "not enabled"}`,
    r.source.ok ? `Root: ${r.source.rootPath} (${r.source.rootLength} of ${r.source.cap} characters, branch ${r.source.branch})` : `Root NOT injected: ${r.source.reason}`,
    ...(r.skills ? [`Skills selectable now: ${r.skills.selectable.join(", ") || "none"}`, ...r.skills.skipped.map(s => `  skipped ${s.name}: ${s.reason}`), ...(r.skills.moreSkipped ? [`  +${r.skills.moreSkipped} more`] : [])] : ["Skills: source not configured"]),
    ...(r.note ? [r.note] : []),
  ].join("\n");

  const source = async ({ projectId: id }: z.infer<typeof checkInput>) => {
    const r = await sourceGet(id, configs.get(id) ?? {}, env.probes ?? realProbes);
    if (r.state !== "not_configured" && r.state !== "disabled") bb.log.info(`source.get ${id}: probed, state ${r.state}`);
    return r;
  };
  bb.rpc.register(rpcContract, { "config.get": i => getConfig(configGet.parse(i)), "config.set": i => setConfig(configSet.parse(i)), check: i => check(checkInput.parse(i)), "source.get": i => source(checkInput.parse(i)) });

  const project = { type: "string", description: "Project id" } as const, json = { type: "boolean", description: "Return JSON" } as const;
  bb.cli.register(defineCli({ name: "project-instructions", summary: "Inject a project's process root and skills from one local git clone", commands: {
    config: cliCommand({ summary: "Read or change one setting of a project", positionals: [{ name: "action", description: "get or set", required: true }, { name: "key", description: "clonePath, branch, rootFile, skillsDir or enabled", required: false }, { name: "value", description: "New value", required: false }], options: { project, json }, async run(i) {
      const { action, key, value } = i.positionals, id = i.options.project;
      if (!id) throw new Error("--project is required");
      if (action !== "get" && action !== "set") throw new Error("Use config get [<key>] or config set <key> <value>");
      if (action === "get" && value !== undefined) throw new Error("config get takes at most one key");
      if (action === "set" && (key === undefined || value === undefined)) throw new Error("Use config set <key> <value>");
      const result = action === "get" ? getConfig(configGet.parse({ projectId: id, key })) : await setConfig({ projectId: id, key: key!, value });
      return { exitCode: 0, stdout: i.options.json || typeof result !== "string" ? JSON.stringify(result) : result };
    } }),
    check: cliCommand({ summary: "Show the source status, the skills selectable now and each skipped skill with its reason", options: { project, json }, run(i) {
      if (!i.options.project) throw new Error("--project is required");
      const r = check({ projectId: i.options.project });
      return { exitCode: 0, stdout: i.options.json ? JSON.stringify(r) : checkText(r) };
    } }),
    source: cliCommand({ summary: "Show the resolved launch source other plugins get from source.get: clone, branch, verified origin tip and state", options: { project, json }, async run(i) {
      if (!i.options.project) throw new Error("--project is required");
      const r = await source({ projectId: i.options.project });
      return { exitCode: 0, stdout: i.options.json ? JSON.stringify(r) : [`Project ${r.projectId}: ${r.state}${r.reason ? ` (${r.reason})` : ""}`, `Clone: ${r.clonePath ?? "-"} on ${r.branch ?? "-"}`, `HEAD: ${r.head ?? "-"}`, `Origin tip: ${r.originHead ?? "-"}`].join("\n") };
    } }),
  } }));

  for (const key of await bb.storage.kv.list("config:project:")) {
    const c = await bb.storage.kv.get<ProjectConfig>(key);
    if (c) configs.set(key.slice("config:project:".length), c);
  }
  syncAll();
}
