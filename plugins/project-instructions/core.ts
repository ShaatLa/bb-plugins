import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
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
} as const;
export type ConfigKey = keyof typeof KEY_SCHEMAS;
export const CONFIG_KEYS = Object.keys(KEY_SCHEMAS) as ConfigKey[];
export type ProjectConfig = { clonePath?: string; branch?: string; rootFile?: string; skillsDir?: string; enabled?: boolean };
export const configKey = (projectId: string) => "config:project:" + projectId;

export function parseConfigValue(key: string, raw: unknown): unknown {
  if (!Object.hasOwn(KEY_SCHEMAS, key)) throw new Error("Unknown key. Valid keys: " + CONFIG_KEYS.join(", "));
  const value = key === "enabled" && typeof raw === "string" ? (raw === "true" ? true : raw === "false" ? false : raw) : raw;
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

function git(clone: string, args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status?: number | null; code?: string; signal?: string | null; stderr?: string };
    const err = x.code === "ENOENT" ? "git is not installed" : x.signal || x.code === "ETIMEDOUT" ? "git timed out" : String(x.stderr ?? "").trim().split("\n")[0]!.slice(0, 200);
    return { code: typeof x.status === "number" ? x.status : -1, out: "", err };
  }
}

/** Attached HEAD must be exactly the branch; a detached HEAD must be at or behind origin/<branch>. */
function branchIdentity(clone: string, branch: string): string | null {
  const head = git(clone, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  if (head.code !== 0) return `git failed in ${clone}: ${head.err || "exit " + head.code}`;
  const ref = head.out.trim();
  if (ref === "HEAD") {
    const anc = git(clone, ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/" + branch]);
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
