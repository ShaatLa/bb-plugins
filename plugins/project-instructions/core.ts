import { execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { z } from "zod";

export const ROOT_CAP = 4096;
export const GRACE_MS = 10_000;
export const STATUS_TTL_MS = 2000;
export const GIT_TIMEOUT_MS = 2000;
export const DOC_SKILL = "project-instructions";
export const DEFAULT_SKILLS_DIR = ".bb/skills";
const MAX_SKILL_ENTRIES = 2000;
// The server's own skill-name rule, so a skill it would reject is never linked or selected.
const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const relPath = z.string().min(1).max(500).refine(p => !isAbsolute(p) && !p.split(/[\\/]/).includes(".."), "must be a relative path without ..");
export const KEY_SCHEMAS = {
  clonePath: z.string().min(1).max(1000).refine(p => isAbsolute(p), "must be an absolute path"),
  branch: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,200}$/, "must be a plain branch name"),
  rootFile: relPath,
  skillsDir: relPath,
  enabled: z.boolean(),
  allowSync: z.boolean(),
} as const;
export type ConfigKey = keyof typeof KEY_SCHEMAS;
export const CONFIG_KEYS = Object.keys(KEY_SCHEMAS) as ConfigKey[];
export type ProjectConfig = { clonePath?: string; branch?: string; rootFile?: string; skillsDir?: string; enabled?: boolean; allowSync?: boolean };
export const configKey = (projectId: string) => "config:project:" + projectId;

export function parseConfigValue(key: string, raw: unknown): unknown {
  if (!Object.hasOwn(KEY_SCHEMAS, key)) throw new Error("Unknown key. Valid keys: " + CONFIG_KEYS.join(", "));
  const value = (key === "enabled" || key === "allowSync") && typeof raw === "string" ? (raw === "true" ? true : raw === "false" ? false : raw) : raw;
  const parsed = KEY_SCHEMAS[key as ConfigKey].safeParse(value);
  if (!parsed.success) throw new Error(`${key} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
  return parsed.data;
}

export type Source = { clonePath: string; branch: string; rootFile: string; skillsDir: string };
export const sourceOf = (c: ProjectConfig): Source | null =>
  c.clonePath && c.branch && c.rootFile ? { clonePath: c.clonePath, branch: c.branch, rootFile: c.rootFile, skillsDir: c.skillsDir ?? DEFAULT_SKILLS_DIR } : null;
export const skillsRootOf = (s: Source) => resolve(s.clonePath, s.skillsDir);

export type Status =
  | { ok: true; rootPath: string; rootDir: string; branch: string; text: string }
  | { ok: false; reason: string; rootPath?: string; length?: number };

export type GitResult = { code: number; out: string; err: string };
const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
/** A failed git run, from execFileSync (`status`) or execFile (numeric `code`). */
function gitFailure(e: unknown, stderr?: string): GitResult {
  const x = e as { status?: number | null; code?: string | number; signal?: string | null; killed?: boolean; stderr?: string };
  const err = x.code === "ENOENT" ? "git is not installed" : x.signal || x.killed || x.code === "ETIMEDOUT" ? "git timed out" : String(stderr ?? x.stderr ?? "").trim().split("\n")[0]!.slice(0, 200);
  return { code: typeof x.status === "number" ? x.status : typeof x.code === "number" ? x.code : -1, out: "", err };
}

export function git(clone: string, args: string[]): GitResult {
  try {
    return { code: 0, out: execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }), err: "" };
  } catch (e) { return gitFailure(e); }
}

/** Attached HEAD must be exactly the branch; a detached HEAD must be at or behind origin/<branch>. */
function branchIdentity(clone: string, branch: string, run = git): string | null {
  const head = run(clone, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  if (head.code !== 0) return `git failed in ${clone}: ${head.err || "exit " + head.code}`;
  const ref = head.out.trim();
  if (ref === "HEAD") {
    const anc = run(clone, ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/" + branch]);
    if (anc.code === 0) return null;
    return anc.code === 1 ? `the clone ${clone} is detached at a commit that is not on origin/${branch}` : `git failed in ${clone}: ${anc.err || "exit " + anc.code}`;
  }
  return ref === "refs/heads/" + branch ? null : `the clone ${clone} is on ${ref}, not ${branch}`;
}

/** One status for the root and the skills: configuration, the root file and its size, then the branch. */
export function computeStatus(c: ProjectConfig): Status {
  const s = sourceOf(c);
  if (!s) return { ok: false, reason: "clonePath, branch and rootFile are not all set" };
  const rootPath = resolve(s.clonePath, s.rootFile);
  if (relative(resolve(s.clonePath), rootPath).startsWith("..")) return { ok: false, reason: `${rootPath} is outside the clone`, rootPath };
  let text: string;
  try { text = readFileSync(rootPath, "utf8"); } catch { return { ok: false, reason: `${rootPath} cannot be read`, rootPath }; }
  if (text.length > ROOT_CAP) return { ok: false, reason: `${rootPath} is ${text.length.toLocaleString("en-US")} characters, over the ${ROOT_CAP.toLocaleString("en-US")} limit`, rootPath, length: text.length };
  const bad = branchIdentity(s.clonePath, s.branch);
  if (bad) return { ok: false, reason: bad, rootPath, length: text.length };
  return { ok: true, rootPath, rootDir: resolve(rootPath, ".."), branch: s.branch, text };
}

/** Time limits of source.get, in ms; tests pass smaller ones. */
export const LIMITS = { local: 2000, lsRemote: 10_000, fetch: 20_000, move: 20_000, cleanup: 1000, deadline: 50_000, fetchInterval: 10_000 };
export type Limits = typeof LIMITS;

/**
 * Runs git as the leader of its own process group, so ssh, credential and remote helpers it starts share it.
 * On timeout the whole group is killed; a helper still holding git's pipes after git exits gets `cleanupMs`,
 * then the group is killed and the pipes are dropped. Resolves only after that, never earlier.
 */
export function runGit(clone: string, args: string[], timeoutMs: number, cleanupMs = LIMITS.cleanup): Promise<GitResult> {
  return new Promise(done => {
    if (timeoutMs <= 0) return done({ code: -1, out: "", err: "git timed out" });
    const child = spawn("git", ["-C", clone, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });
    let out = "", err = "", timedOut = false, settled = false, grace: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* the group is already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace);
      done(timedOut ? { code: -1, out: "", err: "git timed out" } : code === 0 ? { code: 0, out, err: "" } : { code: code ?? -1, out: "", err: err.trim().split("\n")[0]!.slice(0, 200) });
    };
    child.stdout!.setEncoding("utf8").on("data", d => { out += d; });
    child.stderr!.setEncoding("utf8").on("data", d => { err += d; });
    child.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); done(gitFailure(e)); } });
    child.on("exit", code => { grace = setTimeout(() => { killGroup(); child.stdout!.destroy(); child.stderr!.destroy(); finish(code); }, cleanupMs); });
    child.on("close", code => finish(code));
  });
}

/** Every filesystem, git and clock access of sourceGet, so tests can count and steer them. */
export type Probes = {
  realpath(path: string): string;
  run(clone: string, args: string[], timeoutMs: number, cleanupMs: number): Promise<GitResult>;
  mtime(path: string): number | null;
  now(): number;
};
export const realProbes: Probes = {
  realpath: p => realpathSync(p),
  run: (clone, args, timeoutMs, cleanupMs) => runGit(clone, args, timeoutMs, cleanupMs),
  mtime: p => { try { return Math.round(statSync(p).mtimeMs); } catch { return null; } },
  now: () => Date.now(),
};

/** In-process state of syncs: one at a time per clone, and when each clone was last fetched. */
export type SyncState = { locks: Map<string, Promise<void>>; lastFetch: Map<string, number> };
export const newSyncState = (): SyncState => ({ locks: new Map(), lastFetch: new Map() });

export const SOURCE_STATES = ["not_configured", "disabled", "missing", "wrong_branch", "dirty", "unreachable", "stale", "fresh", "error"] as const;
export type SourceResult = {
  projectId: string; configured: boolean; enabled: boolean;
  clonePath: string | null; branch: string | null; head: string | null; originHead: string | null;
  state: (typeof SOURCE_STATES)[number]; reason: string | null; fetchedAt: number | null;
  synced: { from: string; to: string } | null;
};
export type SourceOptions = { sync?: boolean; state?: SyncState; limits?: Partial<Limits>; log?: (line: string) => void };

/** Waits for the clone's previous sync, at most `waitMs`; false when the wait ran out (our turn still passes on in order). */
async function withLock<T>(locks: Map<string, Promise<void>>, key: string, waitMs: number, fn: () => Promise<T>): Promise<T | typeof LOCK_TIMEOUT> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = prev.then(() => new Promise<void>(r => { release = r; }));
  locks.set(key, mine);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const got = await Promise.race([prev.then(() => true), new Promise<false>(r => { timer = setTimeout(() => r(false), Math.max(0, waitMs)); })]);
  clearTimeout(timer);
  const free = () => { void prev.then(() => { release(); if (locks.get(key) === mine) locks.delete(key); }); };
  if (!got) { free(); return LOCK_TIMEOUT; }
  try { return await fn(); } finally { free(); }
}
const LOCK_TIMEOUT = Symbol("lock timeout");

/**
 * The resolved process source for launch material, strict: `fresh` only when HEAD is the origin tip read live
 * by ls-remote; the first failing check sets the state. Read-only unless `sync` is asked and the project
 * allows it: then a clean clone on its branch that is strictly behind is fetched and moved to that tip.
 */
export async function sourceGet(projectId: string, c: ProjectConfig, p: Probes = realProbes, o: SourceOptions = {}): Promise<SourceResult> {
  const L = { ...LIMITS, ...o.limits }, configured = Boolean(c.clonePath && c.branch), enabled = c.enabled ?? false;
  const r: SourceResult = { projectId, configured, enabled, clonePath: c.clonePath ?? null, branch: c.branch ?? null, head: null, originHead: null, state: "not_configured", reason: "clonePath and branch are not both set", fetchedAt: null, synced: null };
  if (!configured) return r;
  // Disabled projects keep their legacy launch source: answer before any filesystem or git probe.
  if (!enabled) return { ...r, state: "disabled", reason: "Project Instructions is not enabled for this project" };
  const branch = c.branch!, ref = "refs/heads/" + branch, deadline = p.now() + L.deadline, log = o.log ?? (() => {});
  const done = (state: SourceResult["state"], reason: string | null): SourceResult => ({ ...r, state, reason });
  try {
    let clone: string;
    try { clone = p.realpath(c.clonePath!); } catch { return done("missing", `${c.clonePath} does not exist`); }
    // Every git process gets the smaller of its own limit and what is left of this call's deadline once its own
    // cleanup is set aside, so timeout plus cleanup of every step stays inside the deadline.
    const budget = (limit: number, reserve = 0) => Math.min(limit, deadline - p.now() - L.cleanup - reserve);
    const git = (args: string[], limit = L.local) => p.run(clone, args, budget(limit), L.cleanup);
    const must = async (args: string[]) => {
      const g = await git(args);
      if (g.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${clone}: ${g.err || "exit " + g.code}`);
      return g.out.trim();
    };
    // Exit 0 is yes and 1 is no; any other exit (timeout, broken repository) is an error, never a diagnosis.
    const yes = async (args: string[]) => {
      const g = await git(args);
      if (g.code === 0 || g.code === 1) return g.code === 0;
      throw new Error(`git ${args[0]} failed in ${clone}: ${g.err || "exit " + g.code}`);
    };
    const identity = async (): Promise<{ form: string } | { wrong: string }> => {
      const form = await must(["rev-parse", "--symbolic-full-name", "HEAD"]);
      if (form === "HEAD") return (await yes(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/" + branch])) ? { form } : { wrong: `the clone ${clone} is detached at a commit that is not on origin/${branch}` };
      return form === ref ? { form } : { wrong: `the clone ${clone} is on ${form}, not ${branch}` };
    };
    const changedFiles = async () => (await must(["status", "--porcelain", "--untracked-files=no"])).split("\n").filter(Boolean).length;

    const evaluate = async (): Promise<SourceResult> => {
      const inside = await git(["rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0 || inside.out.trim() !== "true") return done("missing", `${clone} is not a git work tree`);
      r.clonePath = clone;
      const head = await must(["rev-parse", "HEAD"]);
      r.head = head;
      const common = await git(["rev-parse", "--git-common-dir"]);
      if (common.code === 0) r.fetchedAt = p.mtime(resolve(clone, common.out.trim(), "FETCH_HEAD"));
      const id = await identity();
      if ("wrong" in id) return done("wrong_branch", id.wrong);
      const changed = await changedFiles();
      if (changed) return done("dirty", `${changed} tracked file${changed === 1 ? "" : "s"} changed in ${clone}`);
      const ls = await git(["ls-remote", "--exit-code", "origin", ref], L.lsRemote);
      const tip = ls.code === 0 ? ls.out.split("\n").map(l => l.split("\t")).find(([, name]) => name === ref)?.[0] : undefined;
      if (!tip) return done("unreachable", ls.code === 2 || ls.code === 0 ? `branch ${branch} does not exist on origin` : `git ls-remote origin failed: ${ls.err || "exit " + ls.code}`);
      r.originHead = tip;
      if (tip === head) return done("fresh", null);
      const short = tip.slice(0, 12);
      let present = await yes(["rev-parse", "--verify", "--quiet", tip + "^{commit}"]);
      const why = async () => !present ? `the origin tip ${short} of ${branch} is not fetched yet`
        : (await yes(["merge-base", "--is-ancestor", "HEAD", tip])) ? `HEAD is behind the origin tip ${short} of ${branch}`
        : (await yes(["merge-base", "--is-ancestor", tip, "HEAD"])) ? `HEAD is ahead of the origin tip ${short} of ${branch}`
        : `HEAD has diverged from the origin tip ${short} of ${branch}`;
      if (!o.sync) return done("stale", await why());
      if (!c.allowSync) return done("stale", `${await why()}; sync not allowed for this project (allowSync is false)`);
      // Every sync attempt logs one line; the answer stays stale with the reason.
      const note = (kind: "skipped" | "failed", reason: string, text = `sync ${kind}: ${reason}`) => { log(`source.get ${projectId}: sync ${kind}: ${reason}`); return done("stale", text); };
      // 1-2. Fetch unless the tracking ref already is the tip (the identity rule of a detached clone reads that ref,
      // so a tip that is merely local is not enough), at most once per interval; fail closed if origin moved meanwhile.
      const tracking = (await git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/" + branch])).out.trim();
      if (tracking !== tip) {
        const last = o.state?.lastFetch.get(clone);
        if (last !== undefined && p.now() - last < L.fetchInterval) return note("skipped", `last fetch ${Math.round((p.now() - last) / 1000)} s ago`);
        o.state?.lastFetch.set(clone, p.now());
        // An explicit forced refspec, so a narrowed remote.origin.fetch or a force-push still lands in the tracking ref.
        const f = await git(["fetch", "--no-tags", "origin", `+${ref}:refs/remotes/origin/${branch}`], L.fetch);
        if (f.code !== 0) return note("failed", f.err || "git fetch exit " + f.code);
        const fetched = await git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/" + branch]);
        if (fetched.out.trim() !== tip) { const why = `origin moved during sync (ls-remote ${tip}, fetched ${fetched.out.trim() || "nothing"})`; return note("skipped", why, why); }
        present = true;
      }
      // 3. Only a strict fast-forward.
      if (!(await yes(["merge-base", "--is-ancestor", "HEAD", tip]))) return done("stale", await why());
      // 4. Re-validate right before moving, so a clone changed meanwhile is never moved, least of all backward.
      if ((await must(["rev-parse", "HEAD"])) !== head) return note("skipped", "aborted, HEAD moved", "sync aborted: HEAD moved");
      const again = await identity();
      if ("wrong" in again || again.form !== id.form) return note("skipped", "aborted, the branch changed", "sync aborted: the branch changed");
      if (await changedFiles()) return note("skipped", "aborted, tracked files changed", "sync aborted: tracked files changed");
      // 5. Move, keeping the detached or attached form.
      // The move leaves a reserved slot (a local call and its cleanup), so its result can always be read and logged.
      const moveBudget = budget(L.move, L.local + L.cleanup);
      if (moveBudget <= 0) return note("skipped", "not enough time left to move");
      const mv = await p.run(clone, id.form === "HEAD" ? ["checkout", "-q", "--detach", tip] : ["merge", "--ff-only", "-q", tip], moveBudget, L.cleanup);
      const read = await p.run(clone, ["rev-parse", "HEAD"], budget(L.local), L.cleanup);
      if (read.code !== 0) {
        const why = `the move ran but HEAD could not be read: ${read.err || "exit " + read.code}`;
        log(`source.get ${projectId}: sync failed: ${why} (from ${head}, target ${tip})`);
        return { ...r, head: null, state: "error", reason: why };
      }
      const after = read.out.trim();
      r.head = after;
      if (after !== tip) return note("failed", mv.err || `HEAD is ${after.slice(0, 12)} after the move`);
      r.synced = { from: head, to: tip };
      log(`source.get ${projectId}: synced ${head} -> ${tip}`);
      return done("fresh", null);
    };

    if (!o.sync || !c.allowSync || !o.state) return await evaluate();
    const result = await withLock(o.state.locks, clone, deadline - p.now(), evaluate);
    if (result === LOCK_TIMEOUT) { log(`source.get ${projectId}: sync skipped: deadline reached while another sync was running`); return done("stale", "sync skipped: deadline reached while another sync was running"); }
    return result;
  } catch (e) {
    return { ...r, clonePath: c.clonePath!, head: null, originHead: null, fetchedAt: null, synced: null, state: "error", reason: (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300) };
  }
}

export type Scan = { name: string; error?: string; ctimeMs: number };

/** The server's own checks on one skill, plus the newest ctime of the directory tree. */
export function scanSkill(skillsRoot: string, name: string): Scan {
  let newest = 0;
  try {
    if (!SKILL_NAME.test(name)) throw new Error("name is not a valid skill name");
    const dir = join(skillsRoot, name), top = lstatSync(dir);
    if (!top.isDirectory()) throw new Error("not a directory");
    newest = top.ctimeMs;
    let count = 0;
    const walk = (d: string, root: boolean) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (++count > MAX_SKILL_ENTRIES) throw new Error("too many files");
        const p = join(d, e.name), st = lstatSync(p);
        newest = Math.max(newest, st.ctimeMs);
        if (st.isSymbolicLink()) {
          if (!root || e.name !== "SKILL.md") throw new Error(`symlink ${relative(dir, p)}`);
          newest = Math.max(newest, statSync(p).ctimeMs);
        } else if (st.isDirectory()) walk(p, false);
        else if (!st.isFile()) throw new Error(`not a regular file: ${relative(dir, p)}`);
      }
    };
    walk(dir, true);
    const fm = matter(readFileSync(join(dir, "SKILL.md"), "utf8")).data as { name?: unknown; description?: unknown };
    if (fm.name !== name) throw new Error("frontmatter name differs from the directory name");
    if (typeof fm.description !== "string" || !fm.description.trim() || fm.description.length > 1024) throw new Error("description is missing or over 1,024 characters");
    return { name, ctimeMs: newest };
  } catch (e) {
    return { name, ctimeMs: newest, error: e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : "unreadable" };
  }
}

/** Names of the entries that look like skills: directories, or links, not dotfiles or plain files. */
export function skillNames(skillsRoot: string): string[] {
  try { return readdirSync(skillsRoot, { withFileTypes: true }).filter(e => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink())).map(e => e.name).sort(); } catch { return []; }
}

export type Skipped = { name: string; reason: string };
export type Evaluation = { selectable: string[]; skipped: Skipped[] };

/** The reconciliation rule: a name is selectable only if linked here, valid, quiet for the grace period and clash-free. */
export function evaluateSkills(source: Source, linkedDir: string, now: number, clashes: ReadonlyMap<string, string>, graceMs = GRACE_MS): Evaluation {
  const root = skillsRootOf(source), selectable: string[] = [], skipped: Skipped[] = [];
  for (const name of skillNames(root)) {
    if (name === DOC_SKILL) { skipped.push({ name, reason: "reserved for the plugin's own skill" }); continue; }
    const clash = clashes.get(name);
    if (clash) { skipped.push({ name, reason: `also a skill of another enabled project (${clash})` }); continue; }
    const scan = scanSkill(root, name);
    if (scan.error) { skipped.push({ name, reason: "invalid: " + scan.error }); continue; }
    const link = join(linkedDir, name);
    let linkCtime: number;
    try {
      const st = lstatSync(link);
      if (!st.isSymbolicLink() || resolve(linkedDir, readlinkSync(link)) !== join(root, name)) throw new Error();
      linkCtime = st.ctimeMs;
    } catch { skipped.push({ name, reason: "not linked yet" }); continue; }
    const age = now - Math.max(scan.ctimeMs, linkCtime);
    if (age <= graceMs) { skipped.push({ name, reason: `changed ${Math.max(0, Math.round(age / 1000))} s ago, waits ${graceMs / 1000} s` }); continue; }
    selectable.push(name);
  }
  return { selectable, skipped };
}

/** Make linkedDir hold exactly the wanted symlinks (name -> target). Only symlinks are ever removed. */
export function syncLinks(linkedDir: string, wanted: ReadonlyMap<string, string>) {
  mkdirSync(linkedDir, { recursive: true });
  for (const entry of readdirSync(linkedDir)) {
    const path = join(linkedDir, entry);
    try {
      if (!lstatSync(path).isSymbolicLink()) continue;
      if (wanted.get(entry) === readlinkSync(path)) continue;
      unlinkSync(path);
    } catch { /* another resolution removed it first */ }
  }
  for (const [name, target] of wanted) {
    try { lstatSync(join(linkedDir, name)); } catch {
      try { symlinkSync(target, join(linkedDir, name), "dir"); } catch (e) { if ((e as { code?: string }).code !== "EEXIST") throw e; }
    }
  }
}
