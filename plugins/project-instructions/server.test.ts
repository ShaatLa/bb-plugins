import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { DOC_SKILL, GRACE_MS, ROOT_CAP, realProbes, runGit, scanSkill, type Limits, type Probes } from "./core.js";

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

async function setup(probes?: Probes, limits?: Partial<Limits>) {
  const linkedDir = join(tmp(), "linked-skills");
  let clock = Date.now();
  const host = createFakePluginHost({ pluginId: "project-instructions" });
  await plugin(host.bb, { now: () => clock, linkedDir, probes, limits });
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
  const h = await setup({ realpath: count(realProbes.realpath), run: count(realProbes.run), mtime: count(realProbes.mtime), now: count(realProbes.now) });
  const { clone } = makeOrigin();
  await h.set("proj_half", "clonePath", clone);
  await h.configure("proj_off", { clonePath: clone, enabled: false });
  expect(await source(h, "proj_none")).toMatchObject({ state: "not_configured", configured: false, enabled: false, clonePath: null, branch: null, head: null });
  expect(await source(h, "proj_half")).toMatchObject({ state: "not_configured", configured: false, clonePath: clone, branch: null });
  expect(await source(h, "proj_off")).toEqual({ projectId: "proj_off", configured: true, enabled: false, clonePath: clone, branch: "main", head: null, originHead: null, state: "disabled", reason: "Project Instructions is not enabled for this project", fetchedAt: null, synced: null });
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
  const h = await setup({ ...realProbes, run: () => { throw new Error("probe exploded\nsecond line"); } });
  const { clone } = makeOrigin();
  await h.configure("proj_example", { clonePath: clone });
  expect(await source(h)).toEqual({ projectId: "proj_example", configured: true, enabled: true, clonePath: clone, branch: "main", head: null, originHead: null, state: "error", reason: "probe exploded", fetchedAt: null, synced: null });
});

it("reports a failing stale probe as an error, not as a stale diagnosis", async () => {
  for (const [failing, fetch] of [["rev-parse", false], ["merge-base", true]] as const) {
    const h = await setup({ ...realProbes, run: (clone, args, t, c) => (failing === "rev-parse" ? args.includes("--verify") : args[0] === "merge-base" && args[3] !== "refs/remotes/origin/main")
      ? Promise.resolve({ code: 128, out: "", err: "fatal: broken" }) : realProbes.run(clone, args, t, c) });
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

// ---- sync (opt-in fast-forward) ----

/** Probes that record every git call and can run a hook after a matching one. */
function recording(hook?: { when: (args: string[]) => boolean; run: () => void | Promise<void> }, base: Probes = realProbes) {
  const calls: { args: string[]; timeoutMs: number; at: number }[] = [];
  let hooked = false;
  const probes: Probes = { ...base, run: async (clone, args, timeoutMs, cleanupMs) => {
    calls.push({ args, timeoutMs, at: base.now() });
    const res = await base.run(clone, args, timeoutMs, cleanupMs);
    if (hook && !hooked && hook.when(args)) { hooked = true; await hook.run(); }
    return res;
  } };
  return { probes, calls, fetches: () => calls.filter(c => c.args[0] === "fetch").length };
}
async function syncSetup(probes?: Probes, limits?: Partial<Limits>, allowSync = true) {
  const h = await setup(probes, limits), o = makeOrigin();
  await h.configure("proj_example", { clonePath: o.clone });
  if (allowSync) await h.set("proj_example", "allowSync", true);
  const sync = () => h.rpc("source.get", { projectId: "proj_example", sync: true });
  return { h, o, sync, head: () => git(o.clone, "rev-parse", "HEAD"), form: () => git(o.clone, "rev-parse", "--symbolic-full-name", "HEAD"), tip: () => git(o.origin, "rev-parse", "main") };
}
const syncLines = (h: Awaited<ReturnType<typeof setup>>) => h.host.harness.logEntries.map(e => e.message).filter(m => m.includes(": sync") || m.includes(": synced"));
const isTipStep = (args: string[]) => args[0] === "merge-base" && args[3] !== undefined && args[3] !== "refs/remotes/origin/main";

it("sync fast-forwards a detached clone that is behind, keeps it detached and logs both commits", async () => {
  const rec = recording(), s = await syncSetup(rec.probes), old = s.head();
  s.o.push("2\n");
  const r = await s.sync();
  expect(r).toMatchObject({ state: "fresh", reason: null, head: s.tip(), originHead: s.tip(), synced: { from: old, to: s.tip() } });
  expect(s.form()).toBe("HEAD");
  expect(rec.fetches()).toBe(1);
  expect(syncLines(s.h)).toEqual([`source.get proj_example: synced ${old} -> ${s.tip()}`]);
});

it("sync fast-forwards an attached clone and keeps it on its branch", async () => {
  const s = await syncSetup();
  git(s.o.clone, "checkout", "-q", "-B", "main", "origin/main");
  s.o.push("2\n");
  expect(await s.sync()).toMatchObject({ state: "fresh", head: s.tip() });
  expect(s.form()).toBe("refs/heads/main");
});

it("sync never touches a dirty clone or another branch, and never runs without sync or allowSync", async () => {
  const rec = recording(), s = await syncSetup(rec.probes), old = s.head(), trackingRef = () => git(s.o.clone, "rev-parse", "refs/remotes/origin/main");
  s.o.push("2\n");
  const tracking = trackingRef();
  writeFileSync(join(s.o.clone, "a.txt"), "dirty\n");
  expect((await s.sync()).state).toBe("dirty");
  git(s.o.clone, "checkout", "-q", "--", "a.txt");
  git(s.o.clone, "checkout", "-q", "-b", "other");
  expect((await s.sync()).state).toBe("wrong_branch");
  git(s.o.clone, "checkout", "-q", "--detach", old);
  expect(await source(s.h)).toMatchObject({ state: "stale", synced: null });
  await s.h.set("proj_example", "allowSync", false);
  expect(await s.sync()).toMatchObject({ state: "stale", reason: expect.stringContaining("sync not allowed for this project (allowSync is false)"), synced: null });
  expect(rec.fetches()).toBe(0);
  expect(s.head()).toBe(old);
  expect(trackingRef()).toBe(tracking);
  expect(syncLines(s.h)).toEqual([]);
});

it("sync fetches a diverged clone but never moves it", async () => {
  const rec = recording(), s = await syncSetup(rec.probes);
  git(s.o.clone, "checkout", "-q", "-B", "main", "origin/main");
  writeFileSync(join(s.o.clone, "a.txt"), "local\n"); git(s.o.clone, "commit", "-qam", "local");
  const local = s.head();
  s.o.push("2\n");
  expect(await s.sync()).toMatchObject({ state: "stale", reason: expect.stringContaining("diverged"), synced: null });
  expect(rec.fetches()).toBe(1);
  expect(s.head()).toBe(local);
});

it("sync fetches at most once per interval per clone", async () => {
  let clock = Date.now();
  const rec = recording(undefined, { ...realProbes, now: () => clock }), s = await syncSetup(rec.probes);
  s.o.push("2\n");
  expect((await s.sync()).state).toBe("fresh");
  s.o.push("3\n");
  clock += 5000;
  expect(await s.sync()).toMatchObject({ state: "stale", reason: "sync skipped: last fetch 5 s ago" });
  clock += 6000;
  expect(await s.sync()).toMatchObject({ state: "fresh", head: s.tip() });
  expect(rec.fetches()).toBe(2);
});

it("runs one sync at a time per clone, and a call queued past its deadline touches nothing", async () => {
  const rec = recording(), s = await syncSetup(rec.probes);
  s.o.push("2\n");
  const both = await Promise.all([s.sync(), s.sync()]);
  expect(both.map(r => r.state)).toEqual(["fresh", "fresh"]);
  expect(rec.fetches()).toBe(1);

  let unblock!: () => void;
  const hang: Probes = { ...realProbes, run: (clone, args, t, c) => args[0] === "fetch" ? new Promise(r => { unblock = () => r({ code: -1, out: "", err: "git timed out" }); }) : realProbes.run(clone, args, t, c) };
  const rec2 = recording(undefined, hang), q = await syncSetup(rec2.probes, { deadline: 3000 });
  q.o.push("2\n");
  const first = q.sync();
  await vi.waitFor(() => expect(rec2.fetches()).toBe(1));
  const before = rec2.calls.length;
  expect(await q.sync()).toMatchObject({ state: "stale", reason: "sync skipped: deadline reached while another sync was running" });
  expect(rec2.calls.length).toBe(before);
  unblock();
  expect(await first).toMatchObject({ state: "stale", reason: "sync failed: git timed out" });
});

it("gives every git call at most the time left of the call's deadline", async () => {
  const rec = recording(), s = await syncSetup(rec.probes), start = Date.now();
  s.o.push("2\n");
  expect((await s.sync()).state).toBe("fresh");
  for (const c of rec.calls.filter(c => c.at >= start)) {
    expect(c.timeoutMs).toBeGreaterThan(0);
    expect(c.timeoutMs).toBeLessThanOrEqual(50_000 - 1000 - (c.at - start) + 50);
    expect(c.timeoutMs).toBeLessThanOrEqual(c.args[0] === "fetch" || c.args[0] === "checkout" || c.args[0] === "merge" ? 20_000 : c.args[0] === "ls-remote" ? 10_000 : 2000);
  }
});

it("reports a failed fetch or a refused move as sync failed and leaves HEAD alone", async () => {
  const timeout: Probes = { ...realProbes, run: (clone, args, t, c) => args[0] === "fetch" ? Promise.resolve({ code: -1, out: "", err: "git timed out" }) : realProbes.run(clone, args, t, c) };
  const a = await syncSetup(timeout), oldA = a.head();
  a.o.push("2\n");
  expect(await a.sync()).toMatchObject({ state: "stale", reason: "sync failed: git timed out" });
  expect(a.head()).toBe(oldA);
  const b = await syncSetup(), oldB = b.head();
  writeFileSync(join(b.o.work, "b.txt"), "tracked\n"); git(b.o.work, "add", "b.txt"); git(b.o.work, "commit", "-qm", "b"); git(b.o.work, "push", "-q", b.o.origin, "main");
  writeFileSync(join(b.o.clone, "b.txt"), "untracked in the way\n");
  expect(await b.sync()).toMatchObject({ state: "stale", reason: expect.stringMatching(/^sync failed: /), synced: null });
  expect(b.head()).toBe(oldB);
  expect(syncLines(b.h)).toEqual([expect.stringMatching(/^source.get proj_example: sync failed: /)]);
});

it("fails closed when origin moves or is force-pushed between ls-remote and fetch", async () => {
  for (const force of [false, true]) {
    let clock = Date.now(), o!: ReturnType<typeof makeOrigin>;
    const rec = recording({ when: args => args[0] === "ls-remote", run: () => {
      if (!force) return o.push("3\n");
      git(o.work, "reset", "-q", "--hard", "HEAD~1"); writeFileSync(join(o.work, "a.txt"), "rewritten\n"); git(o.work, "commit", "-qam", "rewritten"); git(o.work, "push", "-q", "-f", o.origin, "main");
    } }, { ...realProbes, now: () => clock });
    const s = await syncSetup(rec.probes); o = s.o;
    const old = s.head();
    s.o.push("2\n");
    expect(await s.sync()).toMatchObject({ state: "stale", reason: expect.stringContaining("origin moved during sync"), synced: null });
    expect(s.head()).toBe(old);
    clock += 11_000;
    expect(await s.sync()).toMatchObject({ state: "fresh", head: s.tip() });
  }
});

it("aborts without moving backward when HEAD or a tracked file changes before the move", async () => {
  let s!: Awaited<ReturnType<typeof syncSetup>>, ahead = "";
  const advance = recording({ when: isTipStep, run: () => { s.o.push("3\n"); git(s.o.clone, "fetch", "-q"); git(s.o.clone, "checkout", "-q", "--detach", "origin/main"); ahead = git(s.o.clone, "rev-parse", "HEAD"); } });
  s = await syncSetup(advance.probes);
  s.o.push("2\n");
  expect(await s.sync()).toMatchObject({ state: "stale", reason: "sync aborted: HEAD moved", synced: null });
  expect(s.head()).toBe(ahead);
  let t!: Awaited<ReturnType<typeof syncSetup>>;
  const edit = recording({ when: isTipStep, run: () => writeFileSync(join(t.o.clone, "a.txt"), "edited\n") });
  t = await syncSetup(edit.probes);
  const old = t.head();
  t.o.push("2\n");
  expect(await t.sync()).toMatchObject({ state: "stale", reason: "sync aborted: tracked files changed" });
  expect(t.head()).toBe(old);
});

it("kills git's whole process group on timeout, including a helper that holds its pipes", async () => {
  const base = tmp(), repo = join(base, "repo"), alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  git(base, "init", "-q", repo);
  git(repo, "config", "protocol.ext.allow", "always");
  // "hangs": the helper keeps a sleep on git's pipes and hangs; "exits": it leaves a sleep holding git's stderr (our pipe) and exits, so git exits too.
  for (const [name, script] of [["hangs", "sleep 300 & echo $! > PIDFILE; sleep 300"], ["exits", "(sleep 300 >/dev/null </dev/null & echo $! > PIDFILE); exit 1"]] as const) {
    const pidFile = join(base, name + ".pid");
    const url = "ext::sh -c " + script.replace("PIDFILE", pidFile).replaceAll("%", "%%").replaceAll(" ", "% ");
    git(repo, "config", "remote.origin.url", url);
    const started = Date.now(), r = await runGit(repo, ["ls-remote", "origin"], name === "hangs" ? 500 : 5000, 300);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.code).not.toBe(0);
    if (name === "hangs") expect(r.err).toBe("git timed out");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000 });
  }
}, 20_000);

it("sync fetches into the tracking ref even when remote.origin.fetch leaves the branch out", async () => {
  const s = await syncSetup();
  git(s.o.clone, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
  s.o.push("2\n");
  expect(await s.sync()).toMatchObject({ state: "fresh", head: s.tip() });
});

it("keeps time to read and log the move, and logs a move whose result cannot be read", async () => {
  let clock = Date.now();
  // The clock jumps when the re-validation starts, so less than the local slot is left for the move.
  // 3.5 s left: enough for the re-validation (2 s + 1 s cleanup), not for the move plus its reserved read slot.
  const late = recording({ when: isTipStep, run: () => { clock += 46_500; } }, { ...realProbes, now: () => clock });
  const a = await syncSetup(late.probes), oldA = a.head();
  a.o.push("2\n");
  expect(await a.sync()).toMatchObject({ state: "stale", reason: "sync skipped: not enough time left to move" });
  expect(a.head()).toBe(oldA);

  let moved = false;
  const blind: Probes = { ...realProbes, run: (clone, args, t, c) => {
    if (args[0] === "checkout") moved = true;
    else if (moved && args[0] === "rev-parse" && args[1] === "HEAD") return Promise.resolve({ code: -1, out: "", err: "git timed out" });
    return realProbes.run(clone, args, t, c);
  } };
  const b = await syncSetup(blind), oldB = b.head();
  b.o.push("2\n");
  expect(await b.sync()).toMatchObject({ state: "error", reason: "the move ran but HEAD could not be read: git timed out", head: null });
  expect(b.head()).toBe(b.tip());
  expect(syncLines(b.h)).toEqual([`source.get proj_example: sync failed: the move ran but HEAD could not be read: git timed out (from ${oldB}, target ${b.tip()})`]);
});

it("keeps the whole sync inside its deadline when the move and the read both use their full cleanup", async () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)));
  // Worst case for the move and the read: each runs to its timeout and then spends its whole cleanup.
  const worst: Probes = { ...realProbes, run: async (clone, args, t, c) => {
    if (args[0] !== "checkout" && !(args[0] === "rev-parse" && args[1] === "HEAD")) return realProbes.run(clone, args, t, c);
    if (t <= 0) return { code: -1, out: "", err: "git timed out" };
    const res = await realProbes.run(clone, args, t, c);
    await sleep(t + c);
    return res;
  } };
  const limits = { deadline: 3000, move: 1000, local: 400, cleanup: 300 };
  const s = await syncSetup(worst, limits);
  s.o.push("2\n");
  const started = Date.now(), r = await s.sync();
  expect(Date.now() - started).toBeLessThanOrEqual(limits.deadline + 100);
  expect(r.state).toBe("fresh");
});

it("kills a hook's leftover process after a real move and still answers inside the deadline", async () => {
  const s = await syncSetup(undefined, { deadline: 6000 }), pidFile = join(tmp(), "hook.pid");
  // A post-checkout hook leaves a sleep holding git's stderr after git exits.
  writeFileSync(join(s.o.clone, ".git/hooks/post-checkout"), `#!/bin/sh\n(sleep 300 >/dev/null </dev/null & echo $! > ${pidFile})\nexit 0\n`, { mode: 0o755 });
  s.o.push("2\n");
  const started = Date.now(), r = await s.sync();
  expect(Date.now() - started).toBeLessThanOrEqual(6000);
  expect(r).toMatchObject({ state: "fresh", head: s.tip() });
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1000 });
}, 20_000);

it("updates the tracking ref when the tip is already local, so the synced clone stays valid", async () => {
  const rec = recording(), s = await syncSetup(rec.probes);
  s.o.push("2\n");
  git(s.o.clone, "fetch", "-q", s.o.origin, "main:refs/other/main"); // by URL: the tip object arrives through another ref, the tracking ref stays
  expect(git(s.o.clone, "rev-parse", "refs/remotes/origin/main")).not.toBe(s.tip());
  expect(await s.sync()).toMatchObject({ state: "fresh", head: s.tip() });
  expect(rec.fetches()).toBe(1);
  expect(git(s.o.clone, "rev-parse", "refs/remotes/origin/main")).toBe(s.tip());
  expect(await source(s.h)).toMatchObject({ state: "fresh", head: s.tip() });
});

it("keeps concurrent writes to separate fields and continues after a rejected edit", async () => {
  const h = await setup();
  const projectId = "proj_example";
  const clonePath = makeClone();
  const results = await Promise.allSettled([
    h.set(projectId, "clonePath", clonePath),
    h.set(projectId, "enabled", true),
    h.set(projectId, "branch", "main"),
  ]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(await h.rpc("config.get", { projectId })).toMatchObject({ clonePath, branch: "main", enabled: false });
  expect(await h.host.bb.storage.kv.get("config:project:" + projectId)).toMatchObject({ clonePath, branch: "main" });
});

const registry = [
  { id: "proj_example", name: "Example" },
  { id: "proj_disabled", name: "Disabled example" },
  { id: "proj_empty", name: "New example" },
];

it("reports configured projects, root preview, and skills from the CLI checks", async () => {
  const rec = recording(), h = await setup(rec.probes);
  h.host.harness.sdk.stub("projects.list", async () => registry);
  const clone = makeClone("<b>Instructions</b>", ["example-check"]);
  writeSkill(clone, "example-invalid", fm("example-invalid", null));
  await h.configure("proj_example", { clonePath: clone });
  await h.configure("proj_disabled", { clonePath: makeClone("x".repeat(ROOT_CAP + 1)), enabled: false });
  await h.set("proj_orphan", "branch", "main");
  h.old();

  expect(await h.rpc("status.projects", {})).toEqual([
    { ...registry[1], available: true, configured: true, enabled: false, allowSync: false },
    { ...registry[0], available: true, configured: true, enabled: true, allowSync: false },
    { ...registry[2], available: true, configured: false, enabled: false, allowSync: false },
    { id: "proj_orphan", name: "proj_orphan", available: false, configured: true, enabled: false, allowSync: false },
  ]);

  const projectId = "proj_example";
  const cli = await h.host.harness.behavior.runCli(["check", "--project", projectId, "--json"]);
  const report = JSON.parse(cli.stdout!);
  const detail = await h.rpc("status.detail", { projectId });
  expect(detail).toMatchObject({
    source: report.source,
    skills: report.skills,
    preview: "<b>Instructions</b>",
    rootFile: "ROOT.md",
    sync: null,
  });
  expect(detail.skills.selectable).toEqual(["example-check"]);
  expect(detail.skills.skipped).toEqual([expect.objectContaining({ name: "example-invalid" })]);

  expect(await h.rpc("status.detail", { projectId: "proj_disabled" })).toMatchObject({
    enabled: false, preview: null, source: { ok: false, rootLength: ROOT_CAP + 1, cap: ROOT_CAP },
  });
  await h.set("proj_example", "enabled", false);
  expect(await h.rpc("status.detail", { projectId })).toMatchObject({
    enabled: false, preview: "<b>Instructions</b>", skills: { selectable: [] },
  });
  expect(await h.rpc("status.detail", { projectId: "proj_empty" })).toMatchObject({
    enabled: false, rootFile: null, source: { ok: false }, preview: null, skills: null, sync: null,
  });
  await expect(h.rpc("status.detail", { projectId: "proj_orphan" })).rejects.toThrow(/unavailable/i);
  expect(rec.calls).toEqual([]);
});

it("persists the latest sync result and the last fast-forward separately", async () => {
  const s = await syncSetup();
  s.h.host.harness.sdk.stub("projects.list", async () => registry);
  const projectId = "proj_example", detail = () => s.h.rpc("status.detail", { projectId });
  const before = s.head();
  s.o.push("2\n");
  const updated = await s.sync();
  const after = s.tip();
  expect(updated).toMatchObject({ state: "fresh", synced: { from: before, to: after } });
  const historyAfterUpdate = (await detail()).sync;
  expect(historyAfterUpdate).toMatchObject({
    lastAttempt: { outcome: "updated", reason: null },
    lastUpdate: { from: before, to: after },
  });

  s.h.advance(1_000);
  expect(await source(s.h)).toMatchObject({ state: "fresh", synced: null });
  expect((await detail()).sync).toEqual(historyAfterUpdate);
  expect(await s.sync()).toMatchObject({ state: "fresh", synced: null });
  expect((await detail()).sync).toMatchObject({
    lastAttempt: { outcome: "up_to_date", at: historyAfterUpdate.lastAttempt.at + 1_000 },
    lastUpdate: historyAfterUpdate.lastUpdate,
  });

  s.h.advance(1_000);
  git(s.o.clone, "remote", "set-url", "origin", join(tmp(), "missing.git"));
  const failed = await s.sync();
  expect(failed).toMatchObject({ state: "unreachable", synced: null });
  const history = (await detail()).sync;
  expect(history).toMatchObject({
    lastAttempt: { outcome: "failed", reason: failed.reason },
    lastUpdate: historyAfterUpdate.lastUpdate,
  });

  const next = await s.h.host.harness.lifecycle.reload(bb => plugin(bb, { linkedDir: s.h.linkedDir }));
  next.harness.sdk.stub("projects.list", async () => registry);
  expect(await next.harness.behavior.callRpc("status.detail", { projectId })).toMatchObject({ sync: history });
  await next.harness.behavior.callRpc("config.set", { projectId, key: "clonePath", value: makeClone() });
  expect(await next.harness.behavior.callRpc("status.detail", { projectId })).toMatchObject({ sync: null });
});

it("ignores a completed sync for a source changed while the call was in flight", async () => {
  let pause!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { pause = resolve; });
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const rec = recording({ when: args => args[0] === "ls-remote", run: () => { pause(); return waiting; } });
  const s = await syncSetup(rec.probes);
  s.h.host.harness.sdk.stub("projects.list", async () => registry);
  const sync = s.sync();
  await started;
  try {
    await s.h.set("proj_example", "branch", "example/other");
    await s.h.set("proj_example", "branch", "main");
  } finally {
    resume();
  }
  expect(await sync).toMatchObject({ state: "fresh" });
  expect(await s.h.rpc("status.detail", { projectId: "proj_example" })).toMatchObject({ sync: null });
});
