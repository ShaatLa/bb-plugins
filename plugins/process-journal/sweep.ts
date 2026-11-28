import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isOpen, type Config, type Proposal } from "./contract";
import { proposalPath } from "./paths";
import { effectId, type Effect, type EffectKind, type EffectPhase, type Store } from "./store";
import { minute, occurrence, timeOn } from "./time";

const exec = promisify(execFile);
const command = z.object({
  file: z.string().refine(isAbsolute), cwd: z.string().refine(isAbsolute),
  args: z.array(z.string().max(2048)).max(32).default([]),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
}).strict();

export async function measureCommand(config: string, name: string) {
  const commands = z.record(z.string(), command).parse(JSON.parse(config));
  const options = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!options) throw new Error("Metric command is not configured");
  const { stdout } = await exec(options.file, options.args, {
    cwd: options.cwd, env: { PATH: "/usr/bin:/bin" }, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024,
  });
  const output = stdout.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(output) || !Number.isFinite(Number(output))) {
    throw new Error("Metric command must print one finite number");
  }
  return Number(output);
}

type Delivery = "sent" | "unreachable" | "retry" | "uncertain" | "obsolete";
export type Transport = {
  send: (project: string, manager: string, message: string, wanted: () => boolean) => Promise<Delivery>,
  notice: (input: { projectId: string; threadId: string; tickId: string; source: string; title: string; markdown: string }) => Promise<string>,
  measure: (command: string) => Promise<number>,
};
export function createSweep(store: Store, transport: Transport) {
  const actor = "Process Journal";
  function mark(p: Proposal, kind: string, message: string) {
    store.event(p.projectId, p.id, { actor, kind, message });
  }
  function enqueue(p: Proposal, kind: EffectKind, at: number, phase: EffectPhase) {
    return store.queue(p.projectId, p.id, p.obligation, kind, at, phase);
  }
  function checkPending(p: Proposal) {
    return p.state === "measuring" && p.checkAt !== null && !store.measured(p.projectId, p.id);
  }
  const stage = store.db.transaction((p: Proposal, cfg: Config, at: number) => {
    const check = checkPending(p);
    if (check && p.checkAt! <= at) enqueue(p, p.metric.command ? "metric" : "manual", p.checkAt!, "check");
    if (p.deadlineAt <= at) enqueue(p, "wake", p.deadlineAt, "decision");
    const due = check ? p.checkAt! : p.deadlineAt;
    const phase = check ? "check" : "decision";
    const grace = cfg.graceMinutes * minute;
    if (at >= due + grace) enqueue(p, "manager", due + grace, phase);
    if (at >= due + 2 * grace) {
      const pending = enqueue(p, "ownerAsk", due + 2 * grace, phase);
      if (pending.inserted) mark(p, "escalation", `Owner question pending · ${phase} · ${pending.id}`);
    }
    if (at >= due + 3 * grace) enqueue(p, "ownerNotice", due + 3 * grace, phase);
  });
  function current(item: Effect) {
    const p = store.findProposal(item.project, item.subject);
    return p && isOpen(p.state) && p.obligation === item.obligation ? p : undefined;
  }
  function applicable(p: Proposal, item: Effect, cfg: Config) {
    const now = store.now();
    if (item.phase === "review") return store.waitingForHypothesis(p);
    const check = item.phase === "check";
    if (check && !checkPending(p)) return false;
    const due = check ? p.checkAt! : p.deadlineAt;
    if (item.kind === "metric" || item.kind === "manual" || item.kind === "wake") return now >= due;
    if (item.kind === "manager" || item.kind === "ownerAsk") {
      return now >= due + cfg.graceMinutes * minute * (item.kind === "ownerAsk" ? 2 : 1);
    }
    return now >= due && !store.acknowledged(p, effectId(p.projectId, p.id, p.obligation, "ownerAsk", item.phase));
  }
  function recovery() {
    store.db.transaction(() => {
      for (const item of store.inFlight()) {
        const p = current(item);
        if (item.kind === "ownerNotice") { store.settle(item.id, "pending"); continue; }
        store.settle(item.id, "uncertain");
        if (item.kind === "run") {
          const run = store.run(item.project, item.subject);
          if (run.status === "pending") store.saveRun({ ...run, status: "uncertain", note: "Restarted during delivery" });
        }
        if (!p) continue;
        if (item.kind === "metric") enqueue(p, "manual", store.now(), "check");
        if (item.phase === "review" && store.waitingForHypothesis(p)) enqueue(p, "ownerNotice", store.now(), "review");
        mark(p, "delivery", `Interrupted ${item.kind} · ${item.id}`);
      }
    })();
  }
  const retry = (item: Effect) => store.settle(item.id, "pending", store.now() + Math.min(60, 2 ** Math.min(item.tries, 6)) * minute);
  async function dispatchProposal(item: Effect, p: Proposal, cfg: Config) {
    const card = proposalPath(p.projectId, p.id);
    const reference = `[Proposal](${card}) · ${item.id}`;
    const reviewBlock = "Every linked Work Board fix is Done or merged. The proposal is waiting in Proposed for independent hypothesis approval.";
    if (item.kind === "metric") {
      let value: number | undefined;
      try { value = z.number().parse(await transport.measure(p.metric.command!)); }
      catch { /* Output and process diagnostics can contain credentials. */ }
      store.db.transaction(() => {
        const fresh = current(item);
        if (fresh && applicable(fresh, item, cfg)) {
          if (value === undefined) {
            mark(fresh, "metric-failed", "Metric command failed or returned invalid output. A manual observation is needed.");
            enqueue(fresh, "manual", store.now(), "check");
          } else store.recordMeasurement(fresh, { value }, actor, "script");
        }
        store.settle(item.id, value === undefined ? "failed" : "sent");
      })();
      return;
    }
    if (item.kind === "ownerNotice") {
      try {
        const notice = await transport.notice({ projectId: p.projectId, threadId: p.managerId,
          tickId: item.id, source: "process-journal",
          title: item.phase === "review" ? "Linked fix is waiting for review" : "Process Journal escalation",
          markdown: `${item.phase === "review" ? reviewBlock : "This proposal still needs attention from its manager."} ${reference}` });
        store.db.transaction(() => {
          if (current(item)) mark(p, "owner-notice", `Agent Hub notice ${notice} delivered · ${item.id}`);
          store.settle(item.id, "sent");
        })();
      } catch { retry(item); }
      return;
    }
    const message = item.phase === "review" ? reviewBlock : {
      wake: "The proposal deadline has arrived. Inspect the details and advance or reschedule it.",
      manual: "The check is due. Record a manual observation and supporting evidence.",
      manager: "This proposal is overdue. Review the outstanding obligation and record the next action.",
      ownerAsk: "This proposal remains overdue. Check Agent Hub for the stable reference below before calling agent_hub_ask. Acknowledge the recorded question ID with proposal-ack using the effect ID below. Ask changes to project rules on the relevant Work Board card.",
      run: "",
    }[item.kind];
    const wanted = () => {
      const latest = current(item);
      const config = store.config(p.projectId);
      return Boolean(latest && config.enabled && applicable(latest, item, config));
    };
    const result = await transport.send(p.projectId, p.managerId, `${message}\n\n${reference}`, wanted);
    store.db.transaction(() => {
      const fresh = current(item);
      if (!fresh) { store.settle(item.id, result === "sent" ? "sent" : "failed"); return; }
      if (result === "retry") { retry(item); return; }
      if (result === "obsolete") {
        if (item.phase === "review") store.discard(item.id);
        else store.settle(item.id, "failed");
        return;
      }
      const kind = item.phase === "review" ? "review-blocked" : item.kind;
      mark(fresh, kind, item.phase === "review" ? `${reviewBlock} Delivery: ${result} · ${item.id}` : `${kind}: ${result} · ${item.id}`);
      if (result === "unreachable" || (item.phase === "review" && result === "uncertain")) {
        enqueue(fresh, "ownerNotice", store.now(), item.phase);
      }
      store.settle(item.id, result === "unreachable" ? "failed" : result);
    })();
  }
  async function dispatchRun(item: Effect, cfg: Config) {
    const run = store.run(item.project, item.subject);
    if (run.status !== "pending" || !cfg.scheduleEnabled) {
      store.db.transaction(() => {
        if (run.status === "pending") store.saveRun({ ...run, status: "failed", finishedAt: store.now(), note: "Schedule was disabled" });
        store.settle(item.id, "failed");
      })();
      return;
    }
    const digest = store.digest(run.projectId);
    const result = await transport.send(run.projectId, run.managerId,
      `Run the project skill "${run.skill}" for the scheduled Process Journal review. Run: ${run.id}.\n`
      + `Open proposals are paged with bb process-journal list --project ${run.projectId}. Weekly digest: `
      + `${digest.applied} applied, ${digest.kept} kept, ${digest.reverted} reverted, ${digest.overdue} overdue.\n`
      + "Use stable submission keys with this run ID and record the outcome with run-finish.",
      () => store.run(item.project, item.subject).status === "pending" && store.config(item.project).scheduleEnabled
        && store.config(item.project).enabled);
    if (result === "retry") { retry(item); return; }
    store.db.transaction(() => {
      const current = store.run(item.project, item.subject);
      if (current.status === "pending") {
        store.saveRun({ ...current, status: result === "unreachable" || result === "obsolete" ? "failed" : result,
          finishedAt: result === "unreachable" || result === "obsolete" ? store.now() : null,
          note: result === "unreachable" ? "Scheduled manager was unreachable" : result === "obsolete" ? "Schedule was disabled" : null });
      }
      store.settle(item.id, result === "unreachable" || result === "obsolete" ? "failed" : result);
    })();
  }
  async function sweep() {
    const at = store.now();
    for (const { projectId, config: cfg } of store.configuredProjects()) {
      if (!cfg.enabled) continue;
      for (const p of store.openProposals(projectId)) stage(p, cfg, at);
      const manager = cfg.scheduleManager ?? cfg.defaultManager;
      if (cfg.scheduleEnabled && manager && cfg.scheduleSkill) {
        const day = occurrence(at, cfg);
        if (cfg.scheduleCoveredThrough !== null && day <= cfg.scheduleCoveredThrough) continue;
        const due = timeOn(day, cfg.scheduleTime, cfg.timeZone);
        const interval = cfg.catchUpMinutes * minute;
        store.db.transaction(() => {
          if (at - due < minute || store.scanSchedule(projectId, at, interval)) {
            store.stageRun(projectId, day, manager, cfg.scheduleSkill!);
          }
        })();
      }
    }
    for (const item of store.pending(at)) {
      const cfg = store.config(item.project);
      if (!cfg.enabled) continue;
      if (!store.claim(item.id)) continue;
      const p = current(item);
      try {
        if (item.kind === "run") await dispatchRun(item, cfg);
        else if (p && applicable(p, item, cfg)) await dispatchProposal(item, p, cfg);
        else if (item.phase === "review") store.discard(item.id);
        else if (p && ["manager", "ownerAsk"].includes(item.kind) && (item.phase === "decision" || checkPending(p))) {
          const due = item.phase === "check" ? p.checkAt! : p.deadlineAt;
          store.settle(item.id, "pending", due + cfg.graceMinutes * minute * (item.kind === "ownerAsk" ? 2 : 1));
        }
        else store.settle(item.id, "failed");
      } catch {
        store.db.transaction(() => {
          if (p && current(item)) mark(p, "delivery", `Delivery uncertain · ${item.id}`);
          if (item.kind === "run") {
            const run = store.run(item.project, item.subject);
            if (run.status === "pending") store.saveRun({ ...run, status: "uncertain", note: "Delivery could not be confirmed" });
          }
          store.settle(item.id, "uncertain");
        })();
      }
    }
  }
  return { sweep, recovery };
}
