import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import * as runner from "../checks/runner";
import type { TaskQuestion } from "../shared/contract";
import { receiptInScope } from "../shared/check-receipt";
import { createStructuredStore } from "./store";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dispose of disposals.splice(0)) await dispose();
});
const setting = { validatorId: "preview", hint: "make receipt", timeoutSeconds: 5 };
const scoped = { ...setting, linkPathPattern: "^/canvas/", linkWrappers: ["/_frame?src"] };
const caller = "thr_example";
function setup(callerHost = "host_other") {
  const dir = mkdtempSync(join(os.tmpdir(), "receipt-"));
  vi.spyOn(os, "homedir").mockReturnValue(dir);
  mkdirSync(join(dir, ".bb"));
  const registryPath = join(dir, ".bb", "work-board-receipt-validators.json");
  const log = join(dir, "envelope.json");
  const register = (mode: string) => writeFileSync(registryPath, JSON.stringify({
    preview: { cwd: dir, argv: mode === "missing" ? [join(dir, "missing")] : [process.execPath, join(import.meta.dirname, "../checks/fixtures/receipt-validator.mjs"), mode, log] },
  }));
  register("accept");
  const host = createFakePluginHost({ pluginId: "work-board", sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env_example" }) },
    environments: { get: async () => ({ hostId: callerHost, path: "/work/example" }) },
    system: { config: async () => ({ primaryHostId: "host_example" }) },
    files: { read: async ({ path }) => ({ path, content: basename(path) === "large" ? "界".repeat(90000) : "  é\n", contentEncoding: "utf8" }) },
  } });
  disposals.push(async () => { await host.harness.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const { bb, harness } = host;
  const store = createStore(bb);
  registerTasksApi(bb, store); registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const structured = createStructuredStore(bb, store);
  const set = (checkReceipt: unknown) => harness.callRpc("updateProject", { projectId: project.id, checkReceipt });
  const add = async (extra = {}) => (await harness.callRpc("createQuestion", {
    kind: "check", askedByThread: caller, taskId: task.id, prompt: "Inspect [preview](/canvas/example)", steps: ["Press Save"], ...extra,
  }) as { question: TaskQuestion }).question;
  const edit = async (q: TaskQuestion, extra = {}) => (await harness.callRpc("updateQuestion", {
    questionId: q.id, prompt: q.prompt, mode: q.mode, options: q.options, revision: q.revision, askedByThread: caller, ...extra,
  }) as { question: TaskQuestion }).question;
  const records = () => bb.storage.database().prepare("SELECT * FROM check_receipt_verdicts").all();
  const comments = () => store.tasks.listComments(task.id).map(c => c.body);
  return { bb, harness, project, task, store, structured, register, registryPath, set, add, edit, records, comments, envelope: () => JSON.parse(readFileSync(log, "utf8")) };
}

it("restricts project writes and validates project settings and host registrations", async () => {
  const f = setup();
  for (const threadId of [undefined, caller]) {
    for (const args of [["project", "update", "EXA", "--check-receipt", "null"], ["config", "set", "checkReceipt", "null", "--project", "EXA"]]) {
      const result = await f.harness.runCli(args, { threadId });
      expect(result.stderr).toContain("changed by the owner");
    }
  }
  for (const extra of [{argv:["program"]}, { cwd:"/" }, {validatorId:"missing"}, {hint:""}, {hint:"x".repeat(1001)}, {timeoutSeconds:4}, {timeoutSeconds:301}, {linkPathPattern:"["}, {linkPathPattern:"x".repeat(501)}, {linkWrappers:Array(6).fill("/_frame?src")}, {linkWrappers:["invalid"]}])
    await expect(f.set({...setting,...extra})).rejects.toThrow();
  await f.set({validatorId:"preview",hint:"make receipt"});
  expect(f.harness.logEntries.some(e => e.message.includes("check receipt for EXA") && e.message.includes(process.execPath))).toBe(true);
  expect(await f.harness.callRpc("config.get", {projectId:f.project.id,key:"checkReceipt"})).toMatchObject({ values:{checkReceipt:{...setting,timeoutSeconds:60}}});
  for (const argv of [[], Array(33).fill("x"), [""], ["x".repeat(1001)]]) {
    writeFileSync(f.registryPath, JSON.stringify({preview:{argv,cwd:"/"}}));
    await expect(f.set(setting)).rejects.toThrow();
  }
  writeFileSync(f.registryPath, JSON.stringify({preview:{argv:["example"],cwd:"relative"}}));
  await expect(f.set(setting)).rejects.toThrow();
  await f.set(null);
});

it("reads the current host file on each validation and fails closed until it is repaired", async () => {
  const f = setup();
  await f.set(setting);
  const validate = () => f.add({ receipt: "packet" });
  const before = f.comments();
  rmSync(f.registryPath);
  await expect(f.add()).rejects.toThrow(/requires a UI receipt.*make receipt/);
  await expect(validate()).rejects.toThrow(/no receipt validators are registered.*missing/i);
  mkdirSync(f.registryPath);
  await expect(validate()).rejects.toThrow(/cannot read receipt validator registry/i);
  rmSync(f.registryPath, { recursive: true });
  writeFileSync(f.registryPath, "{");
  await expect(validate()).rejects.toThrow(/invalid JSON in receipt validator registry/i);
  writeFileSync(f.registryPath, '{"preview":{"argv":[],"cwd":"/"}}');
  await expect(validate()).rejects.toThrow(/invalid receipt validator registry/i);
  expect(f.comments()).toEqual(before);
  expect(f.structured.listQuestions(f.task.id)).toEqual([]);
  expect(f.records()).toEqual([]);
  f.register("accept");
  await validate();
  expect(f.records()).toHaveLength(1);
});

it("binds each accepted action and revision to the effective question and exact receipt bytes", async () => {
  const f = setup();
  await f.set(setting);
  await expect(f.add()).rejects.toThrow(/EXA-1 requires.*make receipt.*--receipt/);
  const receipt = "  é\n";
  const q = await f.add({receipt});
  const hash = createHash("sha256").update(receipt).digest("hex");
  expect(f.comments()).toContain(`Receipt for check ${q.id} rev 1 (add, validated against rev new): sha256 ${hash}\n  verified é  `);
  expect(f.envelope()).toEqual({version:1, action:"add", project:"EXA", task:"EXA-1", question:{id:null,revision:null,prompt:q.prompt,steps:q.steps,links:["/canvas/example"]},callerThreadId:caller,callerWorktree:null,receipt});
  const supersedes = {questionId:q.id,revision:1};
  await expect(f.add({supersedes})).rejects.toThrow(/requires a UI receipt/);
  const replacement = await f.add({supersedes,receipt:"second"});
  expect(f.envelope()).toMatchObject({action:"supersede",predecessor:{id:q.id,revision:1},question:{id:null,revision:null}});
  for (const changes of [{steps:["Press Reload"]},{prompt:"Inspect again"},{reopen:true}])
    await expect(f.edit(replacement,changes)).rejects.toThrow(/requires a UI receipt/);
  const updated = await f.edit(replacement,{prompt:"Inspect again",receipt:"third"});
  expect(f.envelope()).toMatchObject({action:"update",question:{id:replacement.id,revision:1,prompt:updated.prompt,steps:q.steps}});
  const reopened = await f.edit(updated,{reopen:true,receipt:"fourth"});
  expect(f.envelope()).toMatchObject({action:"reopen",question:{id:updated.id,revision:2}});
  expect(f.comments().some(body=>body.startsWith(`Receipt for check ${reopened.id} rev 3 (reopen, validated against rev 2)`))).toBe(true);
  await f.edit(reopened,{options:[{label:"Confirmed"}]});
  await f.add({askedByThread:null}); await f.add({kind:"decision",options:["Yes"]});
  expect(f.records()).toHaveLength(4);
});

it("accepts only direct paths and one same-origin wrapper hop", () => {
  for (const [link, expected] of [
    ["/canvas/example",true], ["/?next=/canvas/example",false], ["/#/canvas/example",false], ["/_frame?src=/canvas/example",true],
    ["/_frame?src=/product",false], ["/_frame?src=https://other.example/canvas/example",false], ["/_frame?src=/canvas/example&src=/canvas/other",false],
    ["/_frame?src=/_frame%3Fsrc%3D/canvas/example",false], ["/_frame?src=/canvas/example&extra=value",false],
  ] as const) expect(receiptInScope(scoped, `Inspect [preview](${link})`, [])).toBe(expected);
});

it("reads a client file on add and update and reports exactly one unused-receipt note", async () => {
  const f = setup();
  const cli = (args: string[]) => f.harness.runCli(["question", ...args], {threadId:caller});
  const flags = ["add","EXA-1","--kind","check","--prompt","Check [product](/product)","--receipt"];
  const off = await cli([...flags,"packet"]);
  expect(off.exitCode,off.stderr).toBe(0);
  expect(off.stderr.match(/receipt not checked/g)).toHaveLength(1);
  await f.set(scoped);
  expect((await cli([...flags,"packet"])).stderr).toContain("receipt not checked: link outside receipt scope");
  expect(f.records()).toEqual([]);
  const q = JSON.parse(off.stdout);
  const update = await cli(["update","EXA-1","--question",q.id,"--revision","1","--prompt","Inspect [preview](/canvas/example)","--receipt","packet"]);
  expect(update.exitCode,update.stderr).toBe(0);
  expect(f.envelope().receipt).toBe("  é\n");
  expect((await cli([...flags,"large"])).stderr).toMatch(/256 KB/);
  await expect(f.add({receipt:"界".repeat(90000)})).rejects.toThrow(/rpc input validation/);
});

it.each(["host_example", "host_other"])("resolves the receipt path and caller worktree for %s from the effective thread", async hostId => {
  const f = setup(hostId);
  await f.set(setting);
  vi.stubEnv("BB_THREAD_ID", caller);
  const result = await f.harness.runCli(["question", "add", f.task.key, "--kind", "check", "--prompt", "Inspect preview", "--receipt", "packet"], { cwd: "/work/example/subdir" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(f.harness.sdk.callsTo("files.read").at(-1)?.[0]).toMatchObject({ hostId, path: "/work/example/subdir/packet" });
  expect(f.envelope()).toMatchObject({ callerThreadId: caller, callerWorktree: hostId === "host_example" ? "/work/example" : null });
});

it("ignores whitespace-only lines and binds each verdict with its original padding", async () => {
  const f = setup();
  f.register("verbatim");
  await f.set(setting);
  for (const receipt of [" verified ", "verified"]) await f.add({ receipt });
  expect(f.records()).toHaveLength(2);
  expect(f.comments().map(body => body.split("\n").at(-1))).toEqual(expect.arrayContaining([" verified ", "verified"]));
  await expect(f.add({ receipt: " verified " })).rejects.toThrow(/already used/);
});

it.each(["reject","missing","never-read","empty","long","overflow","whitespace","invalid-utf8","signal"])("refuses %s without recording a check or comment", async mode => {
  const f=setup(); f.register(mode); await f.set(setting);
  const before = f.comments();
  const reasons: Record<string, RegExp> = {
    reject: /exit 1.*validator diagnostic/s, "never-read": /timed out/, "invalid-utf8": /not valid UTF-8/,
    whitespace: /invalid stdout verdict/, signal: /SIGTERM.*validator diagnostic/s,
  };
  const error = reasons[mode] ?? /not accepted/;
  await expect(f.add({receipt:"packet"})).rejects.toThrow(error);
  expect(f.structured.listQuestions(f.task.id)).toEqual([]); expect(f.records()).toEqual([]); expect(f.comments()).toEqual(before);
});

it("reserves the verdict across cards in the project", async () => {
  const f=setup(); await f.set(setting);
  const q=await f.add({receipt:"one"});
  const other=f.store.tasks.createTask({projectId:f.project.id,title:"Second"});
  for (const id of [f.task.id,other.id])
    await expect(f.add({taskId:id,receipt:"one"})).rejects.toThrow(`already used for check ${q.id} rev 1 on EXA-1`);
  expect(f.structured.listQuestions(other.id)).toEqual([]);
  await f.add({taskId:other.id,receipt:"two"});
  expect(f.records()).toHaveLength(2);
});

it("allows identical verdicts in different projects", async () => {
  const f = setup();
  await f.set(setting);
  const project = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "blue" });
  await f.harness.callRpc("updateProject", { projectId: project.id, checkReceipt: setting });
  const task = f.store.tasks.createTask({ projectId: project.id, title: "Other check" });
  await f.add({ receipt: "same" });
  await f.add({ taskId: task.id, receipt: "same" });
  expect(f.records()).toHaveLength(2);
});

it("lets the owner reopen an answered check without a receipt", async () => {
  const f = setup();
  await f.set(setting);
  const q = await f.add({ receipt: "first" });
  await f.harness.callRpc("answerQuestion", { questionId: q.id, revision: q.revision, answerText: "Confirmed" });
  const reopened = await f.edit(q, { askedByThread: undefined, revision: 2, reopen: true });
  expect(reopened).toMatchObject({ revision: 3, answeredBy: null, answerText: null });
  expect(f.records()).toHaveLength(1);
});

it.each(["setting","registration","removed registration","receipt records","move","withdraw","question","concurrent add"])("rejects stale validation after %s", async change => {
  const f=setup(); await f.set(setting);
  const q=await f.add({askedByThread:null});
  const realCommand=runner.command;
  vi.spyOn(runner,"command").mockImplementationOnce(async (...args) => {
    const result=await realCommand(...args);
    if(change==="setting") await f.set(null);
    if(change==="registration") f.register("reject");
    if(change==="removed registration") writeFileSync(f.registryPath, "{}");
    if(change==="receipt records") {
      f.bb.storage.database().prepare<[string, string, string]>(
        "INSERT INTO check_receipt_verdicts(project_id, verdict, task_id, question_id, revision, comment_id) VALUES (?, 'independent', ?, ?, 1, 'comment_example')",
      ).run(f.project.id, f.task.id, q.id);
    }
    if(change==="move") {
      const other=f.store.tasks.createProject({name:"Other",prefix:"OTH",color:"red"});
      f.store.tasks.moveTaskToProject(f.task.id,other.id);
    }
    if(change==="withdraw") await f.structured.handlers.withdrawQuestion({taskId:f.task.id,questionId:q.id,revision:1,reason:"Closed",authorName:"You"});
    if(change==="question") await f.edit(q,{askedByThread:undefined,prompt:"Changed"});
    if(change==="concurrent add") await f.add({receipt:"another"});
    return result;
  });
  await expect(change==="question" ? f.edit(q,{prompt:"Edit",receipt:"first"}) : f.add({receipt:"first"})).rejects.toThrow(/card changed while the receipt was validated/);
  expect(f.structured.listQuestions(f.task.id)).toHaveLength(change==="concurrent add"?2:1);
  expect(f.comments().filter(body=>body.startsWith("Receipt for check"))).toHaveLength(change==="concurrent add"?1:0);
});

it("uses receipt scope for answer clears and destination family moves", async () => {
  const f=setup(); await f.set(scoped);
  for(const [prompt,gated] of [["Inspect [frame](/_frame?src=/canvas/example)",true],["Inspect [product](/product)",false]] as const){
    const q=await f.add({askedByThread:null,prompt});
    await f.harness.callRpc("answerQuestion",{questionId:q.id,revision:1,answerText:"Confirmed"});
    const args=["question","answer","EXA-1","--question",q.id,"--revision","2","--clear"];
    const result=await f.harness.runCli(args,{threadId:caller});
    if(gated){
      expect(result.stderr).toMatch(/--reopen.*--receipt/);
      await expect(f.harness.callRpc("answerQuestion",{questionId:q.id,revision:2,refuseReadinessClear:true})).rejects.toThrow(/--receipt/);
    } else expect(result.exitCode,result.stderr).toBe(0);
  }
  const source=f.store.tasks.createProject({name:"Source",prefix:"SRC",color:"blue"});
  const root=f.store.tasks.createTask({projectId:source.id,title:"Family",type:"epic"});
  const member=f.store.tasks.createTask({projectId:source.id,title:"Member",epicId:root.id});
  const child=f.store.tasks.createTask({projectId:source.id,title:"Child",parentTaskId:member.id});
  await f.add({taskId:child.id,prompt:"Inspect [frame](/_frame?src=/canvas/example)"});
  const move=(agentThreadId?:string)=>f.harness.callRpc("moveTaskToProject",{projectId:f.project.id,taskId:root.id,agentThreadId});
  await expect(move(caller)).rejects.toThrow(/withdraw the open checks/);
  await move();
  const product=f.store.tasks.createTask({projectId:source.id,title:"Product"});
  await f.add({taskId:product.id,prompt:"Inspect [product](/product)"});
  await f.harness.callRpc("moveTaskToProject",{projectId:f.project.id,taskId:product.id,agentThreadId:caller});
});
