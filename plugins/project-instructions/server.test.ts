import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { DOC_SKILL, GRACE_MS, ROOT_CAP, realProbes, scanSkill, type Probes } from "./core.js";

const dirs: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pi-test-")); dirs.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SETTLE = 50; // real gap so that a later change has a measurably later ctime
const fm = (name: string, description: string | null = "A test skill.") => `---\nname: ${name}\n${description === null ? "" : `description: ${description}\n`}---\n\nBody.\n`;
const skillDir = (clone: string, name: string) => join(clone, ".bb/skills", name);
function writeSkill(clone: string, name: string, content = fm(name)) { mkdirSync(skillDir(clone, name), { recursive: true }); writeFileSync(join(skillDir(clone, name), "SKILL.md"), content); }
/** A git clone on `main` with a root file, `origin/main` at the same commit, and the given skills. */
function makeClone(root = "Root marker A. See [more](docs/more.md).\n", skills: string[] = []) {
  const clone = tmp();
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "ROOT.md"), root);
  for (const s of skills) writeSkill(clone, s);
  git(clone, "add", "-A"); git(clone, "commit", "-q", "-m", "init");
  git(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
  return clone;
}

async function setup(probes?: Probes) {
  const linkedDir = join(tmp(), "linked-skills");
  let clock = Date.now();
  const host = createFakePluginHost({ pluginId: "project-instructions" });
  await plugin(host.bb, { now: () => clock, linkedDir, probes });
  cleanups.push(() => host.harness.lifecycle.dispose());
  const reg = host.harness.registrations;
  const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<any>;
  const set = (projectId: string, key: string, value: unknown) => rpc("config.set", { projectId, key, value });
  const configure = async (projectId: string, c: { clonePath: string; enabled?: boolean; rootFile?: string }) => {
    await set(projectId, "clonePath", c.clonePath); await set(projectId, "branch", "main"); await set(projectId, "rootFile", c.rootFile ?? "ROOT.md");
    if (c.enabled !== false) await set(projectId, "enabled", true);
  };
  return {
    host, linkedDir, rpc, set, configure,
    setClock: (ms: number) => { clock = ms; },
    old: () => { clock = Date.now() + 60_000; },
    /** The clock where `ctime` has aged GRACE - 1 ms: anything changed at or after it is still inside the grace period. */
    justInside: (ctimeMs: number) => { clock = ctimeMs + GRACE_MS - 1; },
    advance: (ms: number) => { clock += ms; },
    instructions: (projectId: string) => reg.instructionProvider!({ threadId: "thr_example", projectId }),
    skills: (projectId: string) => reg.agentConfigurationProvider!({ project: { id: projectId } } as never).skills,
  };
}

it("injects the header and the root for an enabled project only", async () => {
  const h = await setup(), clone = makeClone();
  await h.configure("proj_example", { clonePath: clone });
  await h.configure("proj_disabled", { clonePath: clone, enabled: false });
  const text = h.instructions("proj_example")!;
  expect(text).toBe(`Project process root, read from ${join(clone, "ROOT.md")} on branch main. Relative links in it resolve from ${clone}.\n\nRoot marker A. See [more](docs/more.md).\n`);
  expect(h.instructions("proj_other")).toBeNull();
  expect(h.instructions("proj_disabled")).toBeNull();
});

it("injects a root of exactly 4,096 characters and refuses one of 4,097 without cutting it", async () => {
  const h = await setup(), exact = makeClone("x".repeat(ROOT_CAP)), over = makeClone("y".repeat(ROOT_CAP + 1)), missing = makeClone();
  await h.configure("proj_exact", { clonePath: exact });
  await h.configure("proj_over", { clonePath: over });
  await h.configure("proj_missing", { clonePath: missing, rootFile: "NOPE.md" });
  expect(h.instructions("proj_exact")).toContain("x".repeat(ROOT_CAP));
  const notice = h.instructions("proj_over")!;
  expect(notice).toBe(`The project process root was not injected: ${join(over, "ROOT.md")} is 4,097 characters, over the 4,096 limit.`);
  expect(notice).not.toContain("yyy");
  expect(h.instructions("proj_missing")).toMatch(/^The project process root was not injected: .*NOPE\.md cannot be read\.$/);
});

it("checks the branch identity against real git repositories", async () => {
  const h = await setup(), base = makeClone();
  const state = async (clone: string, id: string) => { await h.configure(id, { clonePath: clone }); return h.instructions(id)!.startsWith("Project process root"); };
  expect(await state(base, "p_attached")).toBe(true);

  const other = makeClone(); git(other, "checkout", "-q", "-b", "other"); // same commit, an ancestor of main
  expect(await state(other, "p_other")).toBe(false);
  expect(h.instructions("p_other")).toContain("refs/heads/other, not main");

  const atOrigin = makeClone(); git(atOrigin, "checkout", "-q", "--detach", "origin/main");
  expect(await state(atOrigin, "p_detached")).toBe(true);

  const behind = makeClone(); git(behind, "checkout", "-q", "--detach", "HEAD");
  writeFileSync(join(behind, "more.txt"), "more"); git(behind, "add", "-A"); git(behind, "commit", "-q", "-m", "two");
  git(behind, "update-ref", "refs/remotes/origin/main", "HEAD"); git(behind, "checkout", "-q", "--detach", "HEAD~1");
  expect(await state(behind, "p_behind")).toBe(true);

  const unrelated = makeClone(); git(unrelated, "checkout", "-q", "--orphan", "lone"); writeFileSync(join(unrelated, "ROOT.md"), "lone");
  git(unrelated, "add", "-A"); git(unrelated, "commit", "-q", "-m", "lone"); git(unrelated, "checkout", "-q", "--detach", "HEAD");
  expect(await state(unrelated, "p_unrelated")).toBe(false);
  expect(h.instructions("p_unrelated")).toContain("not on origin/main");

  const linked = join(tmp(), "wt"); git(base, "worktree", "add", "-q", "--detach", linked, "origin/main");
  expect(await state(linked, "p_linked")).toBe(true);
});

it("selects only the plugin's own skill when the source status fails", async () => {
  const h = await setup();
  const wrong = makeClone("r", ["alpha"]); git(wrong, "checkout", "-q", "-b", "other");
  const over = makeClone("z".repeat(ROOT_CAP + 1), ["beta"]), missing = makeClone("r", ["gamma"]);
  await h.configure("p_wrong", { clonePath: wrong }); await h.configure("p_over", { clonePath: over }); await h.configure("p_missing", { clonePath: missing, rootFile: "NOPE.md" });
  h.old();
  for (const id of ["p_wrong", "p_over", "p_missing", "p_unconfigured"]) expect(h.skills(id)).toEqual([DOC_SKILL]);
  expect((await h.rpc("check", { projectId: "p_over" })).skills.selectable).toEqual([]);
});

it("selects a valid skill of the configured project after the grace period, never for another project", async () => {
  const h = await setup(), clone = makeClone("r", ["alpha"]);
  await h.configure("proj_example", { clonePath: clone });
  expect(h.skills("proj_example")).toEqual([DOC_SKILL]); // linked just now
  expect(lstatSync(join(h.linkedDir, "alpha")).isSymbolicLink()).toBe(true);
  h.old();
  expect(h.skills("proj_example")).toEqual([DOC_SKILL, "alpha"]);
  expect(h.skills("proj_other")).toEqual([DOC_SKILL]);
});

it("keeps a skill restored with backdated mtimes waiting until its ctime is older than the grace period", async () => {
  const h = await setup(), clone = makeClone("r", ["alpha"]);
  await h.configure("proj_example", { clonePath: clone });
  h.old(); expect(h.skills("proj_example")).toContain("alpha");
  writeSkill(clone, "beta"); const hour = new Date(Date.now() - 3_600_000);
  utimesSync(join(skillDir(clone, "beta"), "SKILL.md"), hour, hour); utimesSync(skillDir(clone, "beta"), hour, hour);
  h.skills("proj_example"); // links beta
  h.setClock(Date.now());
  expect(h.skills("proj_example")).toEqual([DOC_SKILL]); // alpha's tree and link are also fresh now only because the clock was reset
  h.old();
  expect(h.skills("proj_example")).toEqual([DOC_SKILL, "alpha", "beta"]);
});

it("links and selects no invalid skill", async () => {
  const h = await setup(), clone = makeClone("r", ["good"]);
  writeSkill(clone, "mismatch", fm("other-name"));
  writeSkill(clone, "nodesc", fm("nodesc", null));
  writeSkill(clone, "badyaml", "---\nname: badyaml\ndescription: ok\nextra: [unclosed\n---\n");
  writeSkill(clone, "inner"); symlinkSync("SKILL.md", join(skillDir(clone, "inner"), "alias.md"));
  writeSkill(clone, "Bad_Name", fm("Bad_Name"));
  await h.configure("proj_example", { clonePath: clone });
  h.old(); h.skills("proj_example"); h.old();
  expect(h.skills("proj_example")).toEqual([DOC_SKILL, "good"]);
  expect(readdirSync(h.linkedDir)).toEqual(["good"]);
  const check = await h.rpc("check", { projectId: "proj_example" });
  expect(check.skills.skipped.map((s: { name: string }) => s.name).sort()).toEqual(["Bad_Name", "badyaml", "inner", "mismatch", "nodesc"]);
});

it("drops a stale skill without hiding the others, and skips one rewritten inside the grace period", async () => {
  const h = await setup(), clone = makeClone("r", ["a", "b", "c"]);
  await h.configure("proj_example", { clonePath: clone });
  h.old(); expect(h.skills("proj_example")).toEqual([DOC_SKILL, "a", "b", "c"]);
  rmSync(skillDir(clone, "b"), { recursive: true });
  expect(h.skills("proj_example")).toEqual([DOC_SKILL, "a", "c"]);
  writeFileSync(join(skillDir(clone, "c"), "SKILL.md"), fm("c", "")); // now invalid
  expect(h.skills("proj_example")).toEqual([DOC_SKILL, "a"]);
  writeFileSync(join(skillDir(clone, "c"), "SKILL.md"), fm("c"));
  await sleep(SETTLE);
  const t0 = Date.now(); writeFileSync(join(skillDir(clone, "a"), "SKILL.md"), fm("a", "Rewritten."));
  h.setClock(t0 + GRACE_MS - 11);
  expect(h.skills("proj_example")).toEqual([DOC_SKILL]); // a rewritten just now, c rewritten before it but still inside too
  h.old();
  expect(h.skills("proj_example")).toEqual([DOC_SKILL, "a", "c"]);
});

it("never selects a name the server could not have listed when the resolution began", async () => {
  const h = await setup(), clone = makeClone("r", ["keep", "gone"]);
  writeSkill(clone, "bad", fm("bad", null));
  await h.configure("proj_example", { clonePath: clone });
  h.old(); h.skills("proj_example");
  await sleep(SETTLE);
  const t0 = Date.now();
  // What the server lists for resolution B: linked skills whose SKILL.md names itself.
  const listing = new Set(readdirSync(h.linkedDir).filter(n => { try { return matter(readFileSync(join(h.linkedDir, n, "SKILL.md"), "utf8")).data.name === n; } catch { return false; } }));
  expect([...listing]).toEqual(["gone", "keep"]);
  // Resolution A runs between B's listing and B's configure.
  writeSkill(clone, "fresh");                                     // (a) a new link is created ...
  rmSync(skillDir(clone, "gone"), { recursive: true });           //     ... and a stale one removed
  writeSkill(clone, "bad", fm("bad"));                            // (b) an invalid skill becomes valid
  writeSkill(clone, "restored"); const hour = new Date(t0 - 3_600_000);
  utimesSync(join(skillDir(clone, "restored"), "SKILL.md"), hour, hour); // (c) restored with old mtimes
  h.setClock(t0 + GRACE_MS - 11); h.skills("proj_example");        // A
  h.setClock(t0 + GRACE_MS - 11);
  const selected = h.skills("proj_example").filter(n => n !== DOC_SKILL);                     // B
  expect(selected).toEqual(["keep"]);
  for (const n of selected) expect(listing.has(n)).toBe(true);
});

it("selects a clashing name for neither project, whatever the order, and refuses to enable into a clash", async () => {
  for (const order of [["proj_one", "proj_two"], ["proj_two", "proj_one"]]) {
    const h = await setup(), clones: Record<string, string> = { proj_one: makeClone("r", ["only-one"]), proj_two: makeClone("r", ["only-two"]) };
    for (const id of order) await h.configure(id, { clonePath: clones[id]! });
    writeSkill(clones.proj_one!, "review", fm("review", "First.")); writeSkill(clones.proj_two!, "review", fm("review", "Second."));
    await h.set("proj_one", "skillsDir", ".bb/skills"); // any config set re-syncs the links
    h.old(); h.skills("proj_one"); h.skills("proj_two"); h.old();
    expect(h.skills("proj_one")).toEqual([DOC_SKILL, "only-one"]);
    expect(h.skills("proj_two")).toEqual([DOC_SKILL, "only-two"]);
    expect(existsSync(join(h.linkedDir, "review"))).toBe(false);
    for (const id of order) expect((await h.rpc("check", { projectId: id })).skills.skipped).toEqual([{ name: "review", reason: expect.stringContaining("another enabled project") }]);
    const third = makeClone("r", ["review"]);
    await h.set("proj_three", "clonePath", third); await h.set("proj_three", "branch", "main"); await h.set("proj_three", "rootFile", "ROOT.md");
    await expect(h.set("proj_three", "enabled", true)).rejects.toThrow(/review/);
  }
});

it("validates one config field at a time", async () => {
  const h = await setup();
  await expect(h.set("proj_example", "clonePath", "relative/clone")).rejects.toThrow(/absolute/);
  await expect(h.set("proj_example", "rootFile", "../ROOT.md")).rejects.toThrow(/relative/);
  await expect(h.set("proj_example", "skillsDir", "/abs")).rejects.toThrow(/relative/);
  await expect(h.set("proj_example", "nope", "x")).rejects.toThrow(/Unknown key/);
  await expect(h.set("proj_example", "enabled", true)).rejects.toThrow(/before enabling/);
  await h.set("proj_example", "branch", "main");
  expect(await h.rpc("config.get", { projectId: "proj_example", key: "branch" })).toBe("main");
  expect(await h.rpc("config.get", { projectId: "proj_example", key: "skillsDir" })).toBe(".bb/skills");
  expect(await h.rpc("config.get", { projectId: "proj_example", key: "enabled" })).toBe(false);
  await expect(h.rpc("config.get", { projectId: "proj_example", key: "nope" })).rejects.toThrow(/Unknown key/);
  const cli = await h.host.harness.behavior.runCli(["config", "set", "enabled", "false", "--project", "proj_example"]);
  expect(cli.exitCode).toBe(0);
});

it("keeps the configuration across a reload and reports it from the CLI", async () => {
  const h = await setup(), clone = makeClone("r", ["alpha"]);
  await h.configure("proj_example", { clonePath: clone });
  const next = await h.host.harness.lifecycle.reload(bb => plugin(bb, { linkedDir: h.linkedDir }));
  const out = await next.harness.behavior.runCli(["check", "--project", "proj_example"]);
  expect(out.stdout).toContain("Project proj_example: enabled");
  expect(out.stdout).toContain(`Root: ${join(clone, "ROOT.md")}`);
});

it("ships a doc skill that passes the same checks as the process skills", () => {
  expect(scanSkill(join(import.meta.dirname, "skills"), DOC_SKILL).error).toBeUndefined();
});

/** A bare origin with one commit on main, a work repo that pushes to it, and a clone of the origin detached at origin/main. */
function makeOrigin() {
  const base = tmp(), origin = join(base, "origin.git"), work = join(base, "work"), clone = join(base, "clone");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "a.txt"), "1\n"); git(work, "add", "-A"); git(work, "commit", "-q", "-m", "1"); git(work, "push", "-q", origin, "main");
  git(base, "clone", "-q", origin, clone); git(clone, "checkout", "-q", "--detach", "origin/main");
  const push = (text: string) => { writeFileSync(join(work, "a.txt"), text); git(work, "commit", "-qam", text); git(work, "push", "-q", origin, "main"); };
  return { origin, work, clone, push };
}
const source = (h: Awaited<ReturnType<typeof setup>>, projectId = "proj_example") => h.rpc("source.get", { projectId });
const probedLines = (h: Awaited<ReturnType<typeof setup>>) => h.host.harness.logEntries.filter(e => e.message.includes("probed"));

it("answers not_configured and disabled without any filesystem or git probe", async () => {
  let calls = 0;
  const count = <T,>(f: T) => ((...a: unknown[]) => { calls++; return (f as (...x: unknown[]) => unknown)(...a); }) as T;
  const h = await setup({ realpath: count(realProbes.realpath), git: count(realProbes.git), gitAsync: count(realProbes.gitAsync), mtime: count(realProbes.mtime) });
  const { clone } = makeOrigin();
  await h.set("proj_half", "clonePath", clone);
  await h.configure("proj_off", { clonePath: clone, enabled: false });
  expect(await source(h, "proj_none")).toMatchObject({ state: "not_configured", configured: false, enabled: false, clonePath: null, branch: null, head: null });
  expect(await source(h, "proj_half")).toMatchObject({ state: "not_configured", configured: false, clonePath: clone, branch: null });
  expect(await source(h, "proj_off")).toEqual({ projectId: "proj_off", configured: true, enabled: false, clonePath: clone, branch: "main", head: null, originHead: null, state: "disabled", reason: "Project Instructions is not enabled for this project", fetchedAt: null });
  expect(calls).toBe(0);
  expect(probedLines(h)).toEqual([]);
});

it("reports a missing clone and a directory that is not a repository", async () => {
  const h = await setup(), plain = tmp();
  await h.configure("proj_gone", { clonePath: join(plain, "nope") });
  await h.configure("proj_plain", { clonePath: plain });
  expect(await source(h, "proj_gone")).toMatchObject({ state: "missing", clonePath: join(plain, "nope"), head: null });
  expect(await source(h, "proj_plain")).toMatchObject({ state: "missing", head: null, reason: expect.stringContaining("not a git work tree") });
});

it("is fresh only at the live origin tip, detached or attached, with no root file", async () => {
  const h = await setup(), o = makeOrigin();
  await h.configure("proj_example", { clonePath: o.clone });
  const tip = git(o.origin, "rev-parse", "main");
  expect(await source(h)).toMatchObject({ state: "fresh", reason: null, head: tip, originHead: tip, clonePath: realpathSync(o.clone), branch: "main" });
  git(o.clone, "checkout", "-q", "-B", "main", "origin/main");
  expect(await source(h)).toMatchObject({ state: "fresh", head: tip });
  expect(probedLines(h).map(e => e.message)).toEqual(["source.get proj_example: probed, state fresh", "source.get proj_example: probed, state fresh"]);
});

it("reports wrong_branch and dirty, but ignores untracked files", async () => {
  const h = await setup(), o = makeOrigin();
  await h.configure("proj_example", { clonePath: o.clone });
  writeFileSync(join(o.clone, "untracked.txt"), "x");
  expect((await source(h)).state).toBe("fresh");
  writeFileSync(join(o.clone, "a.txt"), "changed\n");
  expect(await source(h)).toMatchObject({ state: "dirty", reason: expect.stringContaining("1 tracked file changed") });
  git(o.clone, "checkout", "-q", "--", "a.txt");
  git(o.clone, "checkout", "-q", "-b", "other");
  expect(await source(h)).toMatchObject({ state: "wrong_branch", reason: expect.stringContaining("refs/heads/other") });
});

it("reports an unreachable origin and a branch missing on origin", async () => {
  const h = await setup(), o = makeOrigin(), gone = makeOrigin();
  await h.configure("proj_example", { clonePath: o.clone });
  await h.configure("proj_deleted", { clonePath: gone.clone });
  git(o.clone, "remote", "set-url", "origin", join(tmp(), "no-such-origin.git"));
  expect(await source(h)).toMatchObject({ state: "unreachable", originHead: null, reason: expect.stringContaining("ls-remote origin failed") });
  git(gone.origin, "update-ref", "-d", "refs/heads/main");
  expect(await source(h, "proj_deleted")).toMatchObject({ state: "unreachable", reason: "branch main does not exist on origin" });
});

it("is stale after a push until the clone is at the new tip, and says why", async () => {
  const h = await setup(), o = makeOrigin();
  await h.configure("proj_example", { clonePath: o.clone });
  o.push("2\n");
  const tip = git(o.origin, "rev-parse", "main");
  expect(await source(h)).toMatchObject({ state: "stale", originHead: tip, reason: `the origin tip ${tip.slice(0, 12)} of main is not fetched yet` });
  git(o.clone, "fetch", "-q");
  expect(await source(h)).toMatchObject({ state: "stale", reason: expect.stringContaining("behind"), fetchedAt: expect.any(Number) });
  git(o.clone, "checkout", "-q", "--detach", "origin/main");
  expect((await source(h)).state).toBe("fresh");
  git(o.clone, "checkout", "-q", "-B", "main", "origin/main");
  writeFileSync(join(o.clone, "a.txt"), "local\n"); git(o.clone, "commit", "-qam", "local");
  expect(await source(h)).toMatchObject({ state: "stale", reason: expect.stringContaining("ahead") });
});

it("turns an unexpected probe failure into an error result", async () => {
  const h = await setup({ ...realProbes, git: () => { throw new Error("probe exploded\nsecond line"); } });
  const { clone } = makeOrigin();
  await h.configure("proj_example", { clonePath: clone });
  expect(await source(h)).toEqual({ projectId: "proj_example", configured: true, enabled: true, clonePath: clone, branch: "main", head: null, originHead: null, state: "error", reason: "probe exploded", fetchedAt: null });
});

it("reports a failing stale probe as an error, not as a stale diagnosis", async () => {
  for (const [failing, fetch] of [["rev-parse", false], ["merge-base", true]] as const) {
    const h = await setup({ ...realProbes, git: (clone, args) => (failing === "rev-parse" ? args.includes("--verify") : args[0] === "merge-base" && args[3] !== "refs/remotes/origin/main")
      ? { code: 128, out: "", err: "fatal: broken" } : realProbes.git(clone, args) });
    const o = makeOrigin();
    await h.configure("proj_example", { clonePath: o.clone });
    o.push("2\n");
    if (fetch) git(o.clone, "fetch", "-q");
    expect(await source(h)).toMatchObject({ state: "error", reason: expect.stringContaining(`git ${failing} failed`), head: null, originHead: null });
  }
});

it("logs every config change", async () => {
  const h = await setup();
  await h.set("proj_example", "branch", "main");
  expect(h.host.harness.logEntries.map(e => e.message)).toContain('Project proj_example: branch set to "main"');
});
