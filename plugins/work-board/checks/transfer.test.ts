import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { writeEnabled } from "./config";
import { runs } from "./ownership";
import { reportContents } from "./reports";
import { transferDocument, transfers } from "./transfer";
import { BB_PROJECT, cleanTempDirs, MANAGER, setup, type Fixture } from "./fixtures";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const SWEEP = { kind: "plugin", pluginId: "sweep" } as const;
const deferred = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };

// The same literal document is pinned in the Sweep suite (server.test.mjs).
const pinnedDocument = {"format":"bb-runner-state/1","from":"sweep","bbProjectId":"proj_example","handoffId":"handoff_example","previous":null,"exportedAt":"2026-01-01T00:00:00.000Z","committed":{"size":7,"sha256":"50fb9ee7a50fd1c8e2a0b35c9a2e9d5dbb9ee5b2cd8a98d7d2b02a9fb3b3a8c1"},"lastReport":{"fingerprint":"fingerprint_example","manager":"thr_example","at":1767225600000,"changes":{"noteworthy":["item_example"],"waiting":"waiting_example"}},"lastFailure":{"fingerprint":"failure_example","manager":"thr_example"},"reportedWorktrees":["/example/tree"],"lastMeasuredWorktree":"/example/tree"};

type Handoff = { granted?: true; sent?: { id: string; confirmed?: true }; received?: string };
/** A Sweep with the rules of Sweep 0.7.0 as far as Work Board can see them; its pulls go through Work Board's RPC transport. */
function fakeSweep(f: Fixture) {
  let target = f.harness;
  const wb = (method: string, input: unknown) => target.callRpc(method, input, { experimental_caller: SWEEP }) as Promise<any>;
  let counter = 0;
  const s = {
    config: { enabled: false } as { enabled: boolean } | null, running: false, importing: false, pendingReport: false, hasStateFlag: false,
    handoff: undefined as Handoff | undefined, incoming: null as null | { id: string; document: any; bytes: Buffer | null },
    committed: null as Buffer | null, baselines: {} as Record<string, unknown>, worktrees: [] as string[],
    calls: [] as string[], chunkCalls: 0, applied: 0, importReply: undefined as undefined | Record<string, unknown>, commitReply: undefined as undefined | Record<string, unknown>, afterStatus: undefined as undefined | (() => void), statusShape: "new" as "new" | "old",
    /** Methods whose reply is lost after they executed, and methods refused before they ran. */
    lost: new Set<string>(), refuse: new Map<string, string>(), gateMethod: "", gate: undefined as Promise<void> | undefined, tamperPrevious: undefined as string | null | undefined,
    /** Both services restart: Work Board's harness is replaced, and Sweep's state is rebuilt from its persisted form only. */
    restart(harness: typeof f.harness) {
      target = harness;
      const persisted = JSON.stringify({ config: s.config, hasStateFlag: s.hasStateFlag, handoff: s.handoff, baselines: s.baselines, worktrees: s.worktrees, committed: s.committed?.toString("base64") ?? null,
        incoming: s.incoming ? { ...s.incoming, bytes: s.incoming.bytes?.toString("base64") ?? null } : null });
      s.config = null; s.hasStateFlag = false; s.handoff = undefined; s.baselines = {}; s.worktrees = []; s.committed = null; s.incoming = null; s.importing = false; s.running = false;
      const loaded = JSON.parse(persisted);
      Object.assign(s, { config: loaded.config, hasStateFlag: loaded.hasStateFlag, handoff: loaded.handoff, baselines: loaded.baselines, worktrees: loaded.worktrees,
        committed: loaded.committed === null ? null : Buffer.from(loaded.committed, "base64"),
        incoming: loaded.incoming ? { ...loaded.incoming, bytes: loaded.incoming.bytes === null ? null : Buffer.from(loaded.incoming.bytes, "base64") } : null });
    },
    seed(committed: string | null = '{"n":1}', extra: Record<string, unknown> = {}) {
      s.committed = committed === null ? null : Buffer.from(committed);
      s.hasStateFlag = true;
      s.baselines = { lastReport: { fingerprint: "fp_sweep", manager: MANAGER, at: 1, changes: { noteworthy: [], waiting: "" } }, lastFailure: { fingerprint: "fail_sweep", manager: MANAGER }, lastMeasuredWorktree: "/example/tree", ...extra };
      s.worktrees = ["/example/tree"];
    },
  };
  const hasState = () => s.committed !== null || s.hasStateFlag;
  const notIdle = () => !s.config ? "Set branch and script first." : s.config.enabled ? "Disable Sweep first." : s.running ? "A check is running." : s.pendingReport ? "A report is pending." : s.incoming ? "A handoff from Work Board is already staged here." : null;
  const doc = (id: string) => transferDocument.parse(JSON.parse(JSON.stringify({
    format: "bb-runner-state/1", from: "sweep", bbProjectId: BB_PROJECT, handoffId: id, previous: s.tamperPrevious !== undefined ? s.tamperPrevious : s.handoff?.received ?? null, exportedAt: "2026-01-01T00:00:00.000Z",
    committed: s.committed ? { size: s.committed.length, sha256: sha(s.committed) } : null, reportedWorktrees: s.worktrees, ...s.baselines,
  })));
  const judge = (previous: string | null, handoffId: string | null): { accept: true; duplicate?: true } | { accept: false; reason: string } => {
    if (handoffId !== null && s.handoff?.received === handoffId) return { accept: true, duplicate: true };
    if (s.handoff?.sent && previous === s.handoff.sent.id) return s.handoff.sent.confirmed ? { accept: true } : { accept: false, reason: "The earlier send is not confirmed." };
    if (!s.handoff?.sent && !s.handoff?.received && !hasState()) return { accept: true };
    return { accept: false, reason: "Newer state is held here." };
  };
  async function settle(id: string) {
    if (s.incoming?.id !== id) return "none";
    const own = await wb("checks.ownership", { bbProjectId: BB_PROJECT });
    const confirmed = own.owner === "sweep" && own.sentId === id && own.sentConfirmed;
    if (!confirmed && own.sentId === id) return "waiting";
    const staged = s.incoming; s.incoming = null;
    if (!confirmed) return "discarded";
    s.committed = staged.bytes; s.baselines = { lastReport: staged.document.lastReport, lastFailure: staged.document.lastFailure, lastMeasuredWorktree: staged.document.lastMeasuredWorktree };
    s.worktrees = staged.document.reportedWorktrees; s.hasStateFlag = true;
    s.handoff = { granted: true, received: id };
    s.applied++;
    return "applied";
  }
  async function run(method: string, input: any): Promise<unknown> {
    switch (method) {
      case "status": s.afterStatus && queueMicrotask(s.afterStatus); return s.statusShape === "old" ? { config: s.config } : { config: s.config, running: s.running, hasState: hasState(), importing: s.importing, incoming: s.incoming?.id ?? null, handoff: s.handoff };
      case "transfer.export": {
        const refusal = notIdle(); if (refusal) throw new Error(refusal);
        const sent = s.handoff?.sent;
        if (sent?.confirmed) throw new Error("Work Board already holds this project's state.");
        if (sent) return doc(sent.id);
        const id = `sweep_handoff_${++counter}`;
        const result = doc(id);
        s.handoff = { ...s.handoff, sent: { id } };
        return result;
      }
      case "transfer.chunk": {
        s.chunkCalls++;
        const sent = s.handoff?.sent;
        if (!sent || sent.confirmed || sent.id !== input.handoffId) throw new Error("No unconfirmed send with that handoff id.");
        const bytes = s.committed ?? Buffer.alloc(0), slice = bytes.subarray(input.offset, input.offset + 262144);
        return { data: slice.toString("base64"), end: input.offset + slice.length >= bytes.length };
      }
      case "transfer.confirm": {
        const sent = s.handoff?.sent;
        if (!sent || sent.id !== input.handoffId) throw new Error("No send with that handoff id is recorded here.");
        if (sent.confirmed) return { confirmed: true, duplicate: true };
        const own = await wb("checks.ownership", { bbProjectId: BB_PROJECT });
        if (own.owner !== "work-board" || own.receivedId !== input.handoffId) throw new Error("Work Board has not recorded the receipt of that handoff.");
        s.handoff = { ...s.handoff, sent: { ...sent, confirmed: true } };
        return { confirmed: true };
      }
      case "transfer.preflight": {
        const refusal = notIdle() ?? (s.importing ? "An import is in progress." : null);
        if (refusal) return { accept: false, reason: refusal };
        const verdict = judge(input.previous, null);
        return { accept: verdict.accept, reason: verdict.accept ? null : verdict.reason };
      }
      case "transfer.import": {
        if (s.importReply) return s.importReply;
        if (s.incoming?.id === input.handoffId) return { staged: true, duplicate: true };
        if (s.handoff?.received === input.handoffId) return { staged: false, duplicate: true };
        const refusal = notIdle(); if (refusal) throw new Error(refusal);
        s.importing = true;
        try {
          const own = await wb("checks.ownership", { bbProjectId: BB_PROJECT });
          if (own.sentId !== input.handoffId || own.sentConfirmed) throw new Error("Work Board is not sending that handoff.");
          const document = transferDocument.parse(await wb("checks.transferDocument", { bbProjectId: BB_PROJECT, handoffId: input.handoffId }));
          const parts: Buffer[] = [];
          if (document.committed) for (let offset = 0;;) {
            s.chunkCalls++;
            const chunk = await wb("checks.transferChunk", { bbProjectId: BB_PROJECT, handoffId: input.handoffId, offset });
            parts.push(Buffer.from(chunk.data, "base64")); offset += parts.at(-1)!.length;
            if (chunk.end) break;
          }
          const bytes = document.committed ? Buffer.concat(parts) : null;
          if (bytes && (bytes.length !== document.committed!.size || sha(bytes) !== document.committed!.sha256)) throw new Error("The transferred bytes do not match the document.");
          const verdict = judge(document.previous, input.handoffId);
          if (!verdict.accept) throw new Error(verdict.reason);
          s.incoming = { id: input.handoffId, document, bytes };
          return { staged: true };
        } finally { s.importing = false; }
      }
      case "transfer.commit": if (s.commitReply) return s.commitReply; return { settled: await settle(input.handoffId) };
      case "transfer.cancel": {
        const sent = s.handoff?.sent;
        if (!sent || sent.id !== input.handoffId) return { cancelled: false, current: sent?.id ?? null };
        if (sent.confirmed) throw new Error("The send is confirmed.");
        const own = await wb("checks.ownership", { bbProjectId: BB_PROJECT });
        if (own.transferring || own.receivedId === sent.id) throw new Error("Work Board is transferring or has received that handoff.");
        s.handoff = { ...s.handoff, sent: undefined };
        return { cancelled: true };
      }
    }
    throw new Error(`unexpected ${method}`);
  }
  const handle = async (method: string, input: unknown) => {
    s.calls.push(method);
    if (s.refuse.has(method)) throw new Error(s.refuse.get(method));
    const result = await run(method, input);
    // The reply is held back after the call executed, as a slow network would.
    if (s.gateMethod === method && s.gate) await s.gate;
    if (s.lost.has(method)) { s.lost.delete(method); throw new Error("reply lost"); }
    return JSON.parse(JSON.stringify(result ?? null));
  };
  f.control.sweep = handle;
  return Object.assign(s, { handle, claim: () => wb("checks.claim", { bbProjectId: BB_PROJECT, claimant: "sweep" }), settle, wb });
}
type Sweep = ReturnType<typeof fakeSweep>;

const fixtures: Fixture[] = [];
const make = async () => {
  const f = await setup(); fixtures.push(f); f.configure();
  // Prints the committed bytes it was given as its input and advances the candidate.
  f.script(`echo run >> "${f.io}/runs.log"\necho "STATE input=$(tr -dc 0-9 < "$BB_SWEEP_COMMITTED_STATE")"\nprintf '{"n":2}' > "$BB_SWEEP_CANDIDATE_SNAPSHOT"\nexit 0`);
  f.service.setField(f.tracker.id, "snapshots", true);
  return { f, sweep: fakeSweep(f) };
};
afterEach(async () => { transfers.clear(); runs.clear(); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

const row = (f: Fixture) => f.db.prepare<[string], any>("SELECT * FROM checks_runner_owner WHERE bb_project_id=?").get(BB_PROJECT);
/** Work Board owns the runner after an import of Sweep's state. */
const imported = async (f: Fixture, sweep: Sweep, committed: string | null = '{"n":1}') => { sweep.seed(committed); return f.service.transfer.importFromSweep(f.tracker.id); };
const importFrom = (f: Fixture) => f.service.transfer.importFromSweep(f.tracker.id);
const exportTo = (f: Fixture) => f.service.transfer.exportToSweep(f.tracker.id);
/** Direct write of `enabled`, as a legacy or restored database can hold it. */
const forceEnabled = (f: Fixture) => writeEnabled(f.db, f.tracker.id, true);
const committed = (f: Fixture) => (f.delivery()?.committed as Buffer | null | undefined)?.toString() ?? null;

describe("the transfer document", () => {
  it("pins one literal document, and the schema is strict", () => {
    expect(transferDocument.parse(pinnedDocument)).toEqual(pinnedDocument);
    expect(() => transferDocument.parse({ ...pinnedDocument, extra: 1 })).toThrow();
    expect(() => transferDocument.parse({ ...pinnedDocument, format: "bb-runner-state/2" })).toThrow();
    expect(() => transferDocument.parse({ ...pinnedDocument, committed: { size: 1, sha256: "x" } })).toThrow();
  });
});

describe("a report delivered as a notice", () => {
  it("leaves a baseline without a manager when none was set, then drains, disables and exports under the handoff schema", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    await f.enable();
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick(); // the report is staged and stays pending: the manager is unusable and Agent Hub is off
    expect(f.delivery()?.report_id).toBeTruthy();
    f.control.hub.enabled = true;
    f.setManager(null);
    await f.tick(); // delivered as a notice, with no manager to attribute the baseline to
    expect(f.delivery()?.report_id).toBeNull();
    expect(f.state().lastReport).toMatchObject({ fingerprint: expect.any(String) });
    expect("manager" in f.state().lastReport).toBe(false);
    await f.service.setEnabled(f.tracker.id, false);
    const returned = await exportTo(f);
    expect(returned).toMatchObject({ outcome: "returned" });
    expect(sweep.committed?.toString()).toBe('{"n":2}');
    expect("manager" in (sweep.baselines.lastReport as object)).toBe(false);
    expect(row(f)).toMatchObject({ owner: "sweep" });
  });
});

describe("both directions", () => {
  it("imports Sweep's state, runs from it, hands the advanced bytes back, and refuses a replayed older handoff", async () => {
    const { f, sweep } = await make();
    const result = await imported(f, sweep);
    expect(result).toMatchObject({ outcome: "imported" });
    expect(result.warning).toBeUndefined();
    expect(committed(f)).toBe('{"n":1}');
    expect(f.delivery()).toMatchObject({ committed_project: BB_PROJECT, report_id: null });
    expect(f.state()).toMatchObject({ bbProjectId: BB_PROJECT, lastReport: { fingerprint: "fp_sweep" }, lastFailure: { fingerprint: "fail_sweep" }, reportedWorktrees: ["/example/tree"], lastMeasuredWorktree: "/example/tree" });
    expect(row(f)).toMatchObject({ owner: "work-board", tracker_id: f.tracker.id, received_id: result.handoffId, sent_id: null });
    expect(sweep.handoff?.sent).toMatchObject({ id: result.handoffId, confirmed: true });
    expect(f.service.status(f.tracker.id)).toMatchObject({ runnerOwner: "Work Board (CHK)", unconfirmedSend: null, config: { enabled: false } });
    // The receiver stays disabled: enabling is the owner's action, and the first tick runs from the imported bytes.
    await expect(importFrom(f)).resolves.toMatchObject({ outcome: "already-imported" });
    await f.enable();
    await f.tick();
    expect(f.sent()).toContain("input=1");
    expect(committed(f)).toBe('{"n":2}');
    // Rolling back: the advanced bytes reach Sweep, and it applies them once.
    f.service.setEnabled(f.tracker.id, false);
    const returned = await exportTo(f);
    expect(returned).toMatchObject({ outcome: "returned" });
    expect(returned.warning).toBeUndefined();
    expect(sweep.committed?.toString()).toBe('{"n":2}');
    expect(sweep.handoff).toMatchObject({ granted: true, received: returned.handoffId });
    expect(row(f)).toMatchObject({ owner: "sweep", tracker_id: null, sent_id: returned.handoffId, sent_confirmed: 1, received_id: result.handoffId });
    expect(sweep.baselines).toMatchObject({ lastMeasuredWorktree: "/example/tree" });
    expect(sweep.worktrees).toEqual(["/example/tree"]);
    expect(f.service.status(f.tracker.id)).toMatchObject({ runnerOwner: "Sweep" });
    await expect(exportTo(f)).resolves.toMatchObject({ outcome: "already-returned" });
    await expect(f.service.setEnabled(f.tracker.id, true)).rejects.toThrow(/import-from-sweep/);
    // Sweep runs and exports again; the return reaches Work Board. A replayed older handoff is refused.
    sweep.committed = Buffer.from('{"n":9}');
    sweep.tamperPrevious = result.handoffId;
    await expect(importFrom(f)).rejects.toThrow(/Newer state is held here/);
    sweep.tamperPrevious = undefined; sweep.handoff = { ...sweep.handoff, sent: undefined };
    const back = await importFrom(f);
    expect(back).toMatchObject({ outcome: "imported" });
    expect(committed(f)).toBe('{"n":9}');
    expect(row(f)).toMatchObject({ owner: "work-board", tracker_id: f.tracker.id, received_id: back.handoffId, sent_id: returned.handoffId, sent_confirmed: 1 });
  });

  it("keeps the scan cursor and the acknowledged paths in both directions", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    f.db.prepare("UPDATE checks_state SET value=json_set(value, '$.reportedWorktrees', json('[\"/example/tree\",\"/example/other\"]'), '$.lastMeasuredWorktree', '/example/other')").run();
    await exportTo(f);
    expect(sweep.worktrees).toEqual(["/example/tree", "/example/other"]);
    expect(sweep.baselines).toMatchObject({ lastMeasuredWorktree: "/example/other" });
  });

  it("sends and receives a large checkpoint over the RPC transport in chunks of at most 256 KB", async () => {
    const { f, sweep } = await make();
    const big = JSON.stringify({ pad: "Пример ✓ ".repeat(300_000), n: 1 });
    const bytes = Buffer.from(big);
    expect(bytes.length).toBeGreaterThan(2_000_000);
    await imported(f, sweep, big);
    expect(sweep.chunkCalls).toBe(Math.ceil(bytes.length / 262144));
    expect(f.delivery()?.committed).toEqual(bytes);
    sweep.chunkCalls = 0;
    await exportTo(f);
    expect(sweep.chunkCalls).toBe(Math.ceil(bytes.length / 262144));
    expect(sweep.committed?.equals(bytes)).toBe(true);
    // An unknown size or hash is refused by the receiver of the chunks.
    const refused = await make();
    refused.sweep.seed(big);
    const original = refused.sweep.handle;
    refused.f.control.sweep = async (method, input) => {
      const result: any = await original(method, input);
      return method === "transfer.chunk" && (input as any).offset === 0 ? { ...result, data: Buffer.from("tampered").toString("base64") } : result;
    };
    await expect(importFrom(refused.f)).rejects.toThrow(/do not match|more bytes|empty chunk/);
    expect(refused.f.delivery()).toBeUndefined();
  }, 90_000);
});

describe("preconditions", () => {
  it("refuses an import while any linked tracker is enabled, running or pending, or another holds state, naming the way out", async () => {
    const { f, sweep } = await make();
    sweep.seed();
    forceEnabled(f);
    await expect(importFrom(f)).rejects.toThrow(/CHK are enabled/);
    writeEnabled(f.db, f.tracker.id, false);
    runs.set(BB_PROJECT, f.tracker.id);
    await expect(importFrom(f)).rejects.toThrow(/running/);
    runs.clear();
    f.db.prepare("INSERT INTO checks_delivery (tracker_id, report_id, pending_project, pending_exit, pending_tick, pending_body, pending_at) VALUES (?, 'rpt', ?, 1, 't', 'x', ?)").run(f.tracker.id, BB_PROJECT, new Date().toISOString());
    await expect(importFrom(f)).rejects.toThrow(/pending report/);
    f.db.prepare("DELETE FROM checks_delivery WHERE tracker_id=?").run(f.tracker.id);
    const other = f.other();
    f.db.prepare("INSERT INTO checks_state VALUES (?, ?)").run(other.id, JSON.stringify({ tickId: "t:1", lastRun: 1 }));
    await expect(importFrom(f)).rejects.toThrow(/OTH holds repository-checks state/);
    f.db.prepare("DELETE FROM checks_state WHERE tracker_id=?").run(other.id);
    forceEnabled(f); writeEnabled(f.db, f.tracker.id, false);
    writeEnabled(f.db, other.id, true);
    await expect(importFrom(f)).rejects.toThrow(/OTH are enabled/);
    writeEnabled(f.db, other.id, false);
    f.db.prepare("INSERT INTO checks_runner_owner VALUES (?, 'work-board', ?, NULL, 0, NULL, ?)").run(BB_PROJECT, other.id, new Date().toISOString());
    await expect(importFrom(f)).rejects.toThrow(/belong to tracker OTH/);
    f.db.prepare("UPDATE checks_runner_owner SET tracker_id=?, sent_id='unconfirmed'", ).run(f.tracker.id);
    await expect(importFrom(f)).rejects.toThrow(/not confirmed/);
    f.db.prepare("DELETE FROM checks_runner_owner").run();
    f.control.sweep = undefined;
    await expect(importFrom(f)).rejects.toThrow(/not installed/);
    f.control.sweep = sweep.handle;
    sweep.config = { enabled: true };
    await expect(importFrom(f)).rejects.toThrow(/Sweep refused the export: Disable Sweep first/);
    expect(row(f)).toBeUndefined();
    expect(f.delivery()).toBeUndefined();
  });

  it("refuses a rollback while the checks are not idle, another tracker holds state, a kind is live or a transition is pending, or Sweep refuses", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    const attempt = () => exportTo(f);
    await f.enable();
    await expect(attempt()).rejects.toThrow(/are enabled/);
    f.service.setEnabled(f.tracker.id, false);
    runs.set(BB_PROJECT, f.tracker.id);
    await expect(attempt()).rejects.toThrow(/running/);
    runs.clear();
    f.db.prepare("INSERT INTO checks_delivery (tracker_id, report_id, pending_project, pending_exit, pending_tick, pending_body, pending_at) VALUES (?, 'rpt', ?, 1, 't', 'x', ?) ON CONFLICT(tracker_id) DO UPDATE SET report_id='rpt', pending_project=excluded.pending_project, pending_exit=1, pending_tick='t', pending_body='x'").run(f.tracker.id, BB_PROJECT, new Date().toISOString());
    // An unresolved unknown attempt belongs to the pending report and fences the transfer until it is accepted or retried.
    f.db.prepare("INSERT INTO checks_attempts (attempt_id, tracker_id, report_id, tick_id, bb_project_id, manager_thread_id, marker, started_at, outcome) VALUES ('a1', ?, 'rpt', 't', ?, ?, 'm1', ?, 'unknown')").run(f.tracker.id, BB_PROJECT, MANAGER, new Date().toISOString());
    await expect(attempt()).rejects.toThrow(/pending report/);
    f.db.prepare("UPDATE checks_delivery SET report_id=NULL, pending_project=NULL, pending_exit=NULL, pending_tick=NULL, pending_body=NULL").run();
    const other = f.other();
    f.db.prepare("INSERT INTO checks_state VALUES (?, ?)").run(other.id, JSON.stringify({ tickId: "t:1" }));
    await expect(attempt()).rejects.toThrow(/OTH holds/);
    f.db.prepare("DELETE FROM checks_state WHERE tracker_id=?").run(other.id);
    f.db.prepare("INSERT INTO attention_modes (tracker_id, kind, effective_mode) VALUES (?, 'stale-status', 'live')").run(f.tracker.id);
    await expect(attempt()).rejects.toThrow(/attention is live or changing/);
    f.db.prepare("UPDATE attention_modes SET effective_mode='shadow', requested_mode='live', transition_token='tok' WHERE tracker_id=?").run(f.tracker.id);
    await expect(attempt()).rejects.toThrow(/attention is live or changing/);
    f.db.prepare("DELETE FROM attention_modes").run();
    sweep.config = { enabled: true };
    await expect(attempt()).rejects.toThrow(/Sweep would refuse the handoff: Disable Sweep first.*Nothing was changed/);
    expect(row(f)).toMatchObject({ owner: "work-board", sent_id: null, sent_confirmed: 0 });
    expect(sweep.calls).not.toContain("transfer.import");
    sweep.config = { enabled: false };
    await expect(attempt()).resolves.toMatchObject({ outcome: "returned" });
  });
});

describe("admission", () => {
  it("answers Sweep's claim: once per project, refused while any tracker is enabled, draining, holds state or a transfer runs, and only for Sweep", async () => {
    const { f, sweep } = await make();
    await expect(f.harness.callRpc("checks.claim", { bbProjectId: BB_PROJECT, claimant: "sweep" })).resolves.toMatchObject({ granted: false, reason: expect.stringMatching(/only the Sweep plugin/) });
    f.db.prepare("INSERT INTO checks_delivery (tracker_id, committed, committed_project) VALUES (?, ?, ?)").run(f.tracker.id, Buffer.from("{}"), BB_PROJECT);
    await expect(sweep.claim()).resolves.toMatchObject({ granted: false, reason: expect.stringMatching(/holds checks state/) });
    expect(row(f)).toBeUndefined();
    f.db.prepare("DELETE FROM checks_delivery").run();
    forceEnabled(f);
    await expect(sweep.claim()).resolves.toMatchObject({ granted: false });
    writeEnabled(f.db, f.tracker.id, false);
    transfers.set(BB_PROJECT, "import-from-sweep");
    await expect(sweep.claim()).resolves.toMatchObject({ granted: false, reason: expect.stringMatching(/transfer/) });
    transfers.clear();
    await expect(sweep.claim()).resolves.toEqual({ granted: true });
    expect(row(f)).toMatchObject({ owner: "sweep", tracker_id: null });
    await expect(sweep.claim()).resolves.toEqual({ granted: true });
    await expect(f.service.setEnabled(f.tracker.id, true)).rejects.toThrow(/import-from-sweep/);
    expect(await sweep.wb("checks.ownership", { bbProjectId: BB_PROJECT })).toEqual({ owner: "sweep", trackerId: null, sentId: null, sentConfirmed: false, receivedId: null, transferring: false });
  });

  it("refuses Sweep's claim once Work Board owns the runner, and a Work Board enable whose lookup lost the race to a claim", async () => {
    const { f, sweep } = await make();
    await f.enable();
    expect(row(f)).toMatchObject({ owner: "work-board", tracker_id: f.tracker.id });
    await expect(sweep.claim()).resolves.toMatchObject({ granted: false, reason: expect.stringMatching(/Work Board owns/) });
    // The other order: the enable awaits Sweep's status, Sweep claims in the meantime, and the enable then refuses.
    f.service.setEnabled(f.tracker.id, false);
    f.db.prepare("DELETE FROM checks_runner_owner").run();
    const gate = deferred();
    sweep.gateMethod = "status"; sweep.gate = gate.promise; sweep.config = null;
    const enabling = f.service.setEnabled(f.tracker.id, true);
    const settled = enabling.then(() => "enabled", (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(sweep.claim()).resolves.toEqual({ granted: true });
    gate.release();
    expect(await settled).toMatch(/Sweep owns/);
    expect(f.service.status(f.tracker.id).config.enabled).toBe(false);
    expect(row(f)).toMatchObject({ owner: "sweep" });
  });

  it("lets only one of an overlapping manual run and scheduled tick start while Sweep's status is read", async () => {
    const { f, sweep } = await make();
    f.standard(); f.output("", 0);
    forceEnabled(f);
    const gate = deferred();
    sweep.gateMethod = "status"; sweep.gate = gate.promise; sweep.config = null;
    const outcomes = Promise.allSettled([f.service.manualRun(f.tracker.id), f.tick()]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sweep.calls.filter((call) => call === "status")).toHaveLength(2);
    gate.release();
    const [manual] = await outcomes;
    expect(f.runs()).toBe(1);
    expect(["fulfilled", "rejected"]).toContain(manual.status);
    expect(row(f)).toMatchObject({ owner: "work-board", tracker_id: f.tracker.id });
    expect(runs.size).toBe(0);
  });

  it("refuses an enable whose bb project was relinked, and a run whose tracker was disabled, during the lookup of Sweep", async () => {
    const { f, sweep } = await make();
    const gate = deferred();
    sweep.gateMethod = "status"; sweep.gate = gate.promise; sweep.config = null;
    const enabling = f.service.setEnabled(f.tracker.id, true).then(() => "enabled", (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" });
    gate.release();
    expect(await enabling).toMatch(/link changed/);
    expect(f.service.status(f.tracker.id).config.enabled).toBe(false);
    expect(row(f)).toBeUndefined();
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: BB_PROJECT });
    const second = deferred();
    sweep.gate = second.promise;
    forceEnabled(f);
    const ticking = f.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.service.setEnabled(f.tracker.id, false);
    second.release();
    await ticking;
    expect(f.runs()).toBe(0);
    expect(row(f)).toBeUndefined();
  });

  it("refuses a manual run and a scheduled tick with state recorded for another bb project before claiming the new one", async () => {
    const { f } = await make();
    await f.enable(); await f.tick();
    f.service.setEnabled(f.tracker.id, false);
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" });
    expect(f.service.status(f.tracker.id).stateMismatch).toMatch(/State belongs to proj_example/);
    const runsBefore = f.runs();
    await expect(f.service.manualRun(f.tracker.id)).rejects.toThrow(/State belongs to/);
    forceEnabled(f);
    await f.service.scheduledTick(f.tracker.id);
    expect(f.service.status(f.tracker.id).error).toMatch(/State belongs to/);
    expect(f.runs()).toBe(runsBefore);
    expect(f.db.prepare("SELECT * FROM checks_runner_owner WHERE bb_project_id='proj_other'").get()).toBeUndefined();
  });

  it("voids an enable that waited for Sweep's status once a disable has happened", async () => {
    const { f, sweep } = await make();
    const gate = deferred();
    sweep.gateMethod = "status"; sweep.gate = gate.promise; sweep.config = null;
    const enabling = f.service.setEnabled(f.tracker.id, true).then(() => "enabled", (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.service.setEnabled(f.tracker.id, false);
    gate.release();
    expect(await enabling).toMatch(/disabled while this enable waited/);
    expect(f.service.status(f.tracker.id).config.enabled).toBe(false);
    expect(row(f)).toBeUndefined();
  });

  it("treats an old, unreadable or unclear status of Sweep as inconclusive, and only a positive one as evidence", async () => {
    const { f, sweep } = await make();
    const attempt = async (setup: () => void, expected: RegExp | null) => {
      sweep.config = { enabled: false }; sweep.running = false; sweep.hasStateFlag = false; sweep.committed = null; sweep.handoff = undefined; sweep.statusShape = "new"; sweep.refuse.clear();
      setup();
      if (expected) {
        await expect(f.service.setEnabled(f.tracker.id, true)).rejects.toThrow(expected);
        expect(row(f)).toBeUndefined();
        expect(f.service.status(f.tracker.id).config.enabled).toBe(false);
      } else {
        await expect(f.service.setEnabled(f.tracker.id, true)).resolves.toEqual({ enabled: true });
        expect(row(f)).toMatchObject({ owner: "work-board" });
        f.service.setEnabled(f.tracker.id, false);
        f.db.prepare("DELETE FROM checks_runner_owner").run();
      }
    };
    await attempt(() => { sweep.statusShape = "old"; }, /could not|version|may run/);
    await attempt(() => { sweep.refuse.set("status", "unreadable"); }, /could not be read/);
    await attempt(() => { sweep.running = true; }, /may run or hold state/);
    await attempt(() => { sweep.hasStateFlag = true; }, /may run or hold state/);
    await attempt(() => { sweep.config = { enabled: true }; }, /may run or hold state/);
    await attempt(() => { sweep.handoff = { granted: true }; }, /may run or hold state/);
    // Without the 0.7.0 fields even "no config" is not evidence: an old Sweep could still run from its legacy setting.
    await attempt(() => { sweep.statusShape = "old"; sweep.config = null; }, /may run or hold state/);
    await attempt(() => { sweep.config = null; }, null);
    await attempt(() => {}, null);
    f.control.sweep = undefined;
    await attempt(() => {}, null);
  });
});

describe("release, relink and delete", () => {
  it("releases a row without lineage only for a disabled, drained tracker, and relink and delete release it the same way", async () => {
    const { f } = await make();
    await f.enable();
    await expect(f.service.transfer.release(f.tracker.id)).rejects.toThrow(/are enabled/);
    f.service.setEnabled(f.tracker.id, false);
    await expect(f.service.transfer.release(f.tracker.id)).resolves.toMatchObject({ outcome: "released" });
    expect(row(f)).toBeUndefined();
    await expect(f.service.transfer.release(f.tracker.id)).resolves.toMatchObject({ outcome: "nothing-to-release" });
    // Relink gives the row up; delete does too.
    await f.enable(); f.service.setEnabled(f.tracker.id, false);
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" });
    expect(row(f)).toBeUndefined();
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: BB_PROJECT });
    await f.enable(); f.service.setEnabled(f.tracker.id, false);
    expect(f.store.tasks.deleteProject(f.tracker.id)).toBe(true);
    expect(row(f)).toBeUndefined();
  });

  it("never gives up a row with lineage: release, relink and delete of the owner are refused, and after a rollback the tracker is free", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    await expect(f.service.transfer.release(f.tracker.id)).rejects.toThrow(/lineage/);
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" })).toThrow(/owns the runner after a transfer/);
    expect(() => f.store.tasks.deleteProject(f.tracker.id)).toThrow(/owns the runner after a transfer/);
    await exportTo(f);
    expect(row(f)).toMatchObject({ owner: "sweep", tracker_id: null });
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" });
    expect(row(f)).toMatchObject({ owner: "sweep" });
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: BB_PROJECT });
    expect(f.store.tasks.deleteProject(f.tracker.id)).toBe(true);
    expect(row(f)).toMatchObject({ owner: "sweep" });
  });

  it("refuses a Sweep claim after a release while the tracker still holds state for the project", async () => {
    const { f, sweep } = await make();
    await f.enable();
    await f.tick();
    f.service.setEnabled(f.tracker.id, false);
    await f.service.transfer.release(f.tracker.id);
    await expect(sweep.claim()).resolves.toMatchObject({ granted: false, reason: expect.stringMatching(/holds checks state/) });
  });
});

describe("the unconfirmed send", () => {
  it("fences the sender durably across a restart until the rerun completes, and the rerun of a completed rollback is a no-op", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    sweep.refuse.set("transfer.import", "Newer state is held here.");
    await expect(exportTo(f)).rejects.toThrow(/Sweep refused the handoff.*abort-send/);
    const saved = row(f);
    expect(saved).toMatchObject({ owner: "work-board", sent_confirmed: 0, sent_id: expect.any(String) });
    expect(f.service.status(f.tracker.id)).toMatchObject({ unconfirmedSend: saved.sent_id });
    // A service restart: the in-process lock is gone, the row is not.
    transfers.clear(); runs.clear();
    await expect(f.service.setEnabled(f.tracker.id, true)).rejects.toThrow(/not confirmed/);
    forceEnabled(f);
    await f.tick();
    await expect(f.service.manualRun(f.tracker.id)).rejects.toThrow(/not confirmed/);
    expect(f.runs()).toBe(0);
    expect(f.service.status(f.tracker.id).error).toMatch(/not confirmed/);
    writeEnabled(f.db, f.tracker.id, false);
    expect(() => f.service.reset(f.tracker.id)).toThrow(/not confirmed/);
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" })).toThrow(/not confirmed/);
    expect(() => f.store.tasks.deleteProject(f.tracker.id)).toThrow(/not confirmed/);
    await expect(f.service.transfer.release(f.tracker.id)).rejects.toThrow(/lineage|not confirmed/);
    await expect(importFrom(f)).rejects.toThrow(/not confirmed/);
    expect(row(f)).toEqual(saved);
    // Only the rerun proceeds, with the same id and without a new preflight.
    sweep.refuse.clear();
    const preflights = sweep.calls.filter((call) => call === "transfer.preflight").length;
    const done = await exportTo(f);
    expect(done).toMatchObject({ outcome: "returned", handoffId: saved.sent_id });
    expect(sweep.calls.filter((call) => call === "transfer.preflight")).toHaveLength(preflights);
    expect(row(f)).toMatchObject({ owner: "sweep", sent_confirmed: 1 });
    await expect(exportTo(f)).resolves.toMatchObject({ outcome: "already-returned" });
  });

  it("ends a lost reply in each direction as a duplicate", async () => {
    const { f, sweep } = await make();
    sweep.seed();
    // Pull: the confirmation did not reach Sweep; the rerun finds the receipt and confirms.
    sweep.refuse.set("transfer.confirm", "offline");
    const first = await importFrom(f);
    expect(first).toMatchObject({ outcome: "imported", warning: expect.stringMatching(/rerun/i) });
    expect(sweep.handoff?.sent?.confirmed).toBeUndefined();
    sweep.refuse.clear();
    await expect(importFrom(f)).resolves.toMatchObject({ outcome: "duplicate", handoffId: first.handoffId });
    expect(sweep.handoff?.sent?.confirmed).toBe(true);
    // Pull: the confirmation landed but its reply was lost; the rerun reports it as imported already.
    const lost = await make();
    lost.sweep.seed();
    lost.sweep.lost.add("transfer.confirm");
    const warned = await importFrom(lost.f);
    expect(warned.warning).toBeTruthy();
    expect(lost.sweep.handoff?.sent?.confirmed).toBe(true);
    await expect(importFrom(lost.f)).resolves.toMatchObject({ outcome: "already-imported" });
    // Push: Sweep staged the handoff and the reply was lost; the rerun resumes the same id, confirms once and commits once.
    const { f: g, sweep: pushed } = await make();
    await imported(g, pushed);
    pushed.lost.add("transfer.import");
    await expect(exportTo(g)).rejects.toThrow(/refused the handoff/);
    const id = row(g).sent_id as string;
    expect(pushed.incoming?.id).toBe(id);
    const preflights = pushed.calls.filter((call) => call === "transfer.preflight").length;
    const commits = () => pushed.calls.filter((call) => call === "transfer.commit").length;
    const done = await exportTo(g);
    expect(done).toMatchObject({ outcome: "returned", handoffId: id });
    expect(pushed.calls.filter((call) => call === "transfer.preflight")).toHaveLength(preflights);
    expect(commits()).toBe(1);
    expect(pushed.handoff).toMatchObject({ received: id });
    expect(pushed.incoming).toBeNull();
    // Push: the commit reply is lost; Sweep settles the staged handoff on its own.
    const { f: h, sweep: settled } = await make();
    await imported(h, settled);
    settled.refuse.set("transfer.commit", "offline");
    const warning = await exportTo(h);
    expect(warning).toMatchObject({ outcome: "pending-application", warning: expect.stringMatching(/settles it on its own/) });
    expect(settled.incoming?.id).toBe(warning.handoffId);
    settled.refuse.clear();
    expect(await settled.settle(warning.handoffId!)).toBe("applied");
    expect(await settled.settle(warning.handoffId!)).toBe("none");
  });

  it("resumes a send staged before both services restarted, with the same id, skipping the preflight, and commits exactly once", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    sweep.lost.add("transfer.import");
    await expect(exportTo(f)).rejects.toThrow();
    const id = row(f).sent_id as string;
    const staged = sweep.incoming!;
    expect(staged.id).toBe(id);
    // Both services restart: Work Board is reloaded on its persisted database, Sweep is rebuilt from its persisted form.
    transfers.clear(); runs.clear();
    const next = await f.harness.lifecycle.reload(async (bb) => {
      const { createStore, registerTasksApi } = await import("../api");
      const { registerChecks } = await import("./rpc");
      registerTasksApi(bb, createStore(bb)); registerChecks(bb);
    });
    fixtures.splice(fixtures.indexOf(f), 1, { ...f, dispose: () => next.harness.dispose() } as Fixture);
    sweep.restart(next.harness);
    expect(sweep.incoming).not.toBe(staged);
    expect(sweep.incoming).toMatchObject({ id });
    expect(sweep.incoming?.bytes?.toString()).toBe('{"n":1}');
    const { checksService } = await import("./service");
    const before = sweep.calls.length;
    await expect(checksService(next.bb).transfer.exportToSweep(f.tracker.id)).resolves.toMatchObject({ outcome: "returned", handoffId: id });
    expect(sweep.calls.slice(before)).toEqual(["transfer.import", "transfer.commit"]);
    expect(sweep.committed?.toString()).toBe('{"n":1}');
    expect(sweep.applied).toBe(1);
    expect(sweep.incoming).toBeNull();
  });

  it("reports the application as pending, and keeps the confirmed row, when Sweep answers the commit with waiting", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    sweep.commitReply = { settled: "waiting" };
    const result = await exportTo(f);
    expect(result).toMatchObject({ outcome: "pending-application", warning: expect.stringMatching(/not applied the state yet \(waiting\)/) });
    expect(row(f)).toMatchObject({ owner: "sweep", sent_id: result.handoffId, sent_confirmed: 1 });
    expect(sweep.incoming?.id).toBe(result.handoffId);
    // "none" is completion only when Sweep shows the handoff as received.
    sweep.commitReply = { settled: "none" };
    const { f: g, sweep: other } = await make();
    await imported(g, other);
    other.commitReply = { settled: "none" };
    await expect(exportTo(g)).resolves.toMatchObject({ outcome: "pending-application", warning: expect.stringMatching(/does not show this handoff as received/) });
    sweep.commitReply = undefined;
    await expect(exportTo(f)).resolves.toMatchObject({ outcome: "already-returned" });
    expect(sweep.applied).toBe(1);
  });

  it("does not take a reply that proves no staging as a receipt: the same send stays unconfirmed and resumable", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    sweep.importReply = { staged: false };
    await expect(exportTo(f)).rejects.toThrow(/neither a staging nor a duplicate receipt/);
    const saved = row(f);
    expect(saved).toMatchObject({ owner: "work-board", sent_confirmed: 0, sent_id: expect.any(String) });
    expect(sweep.calls).not.toContain("transfer.commit");
    sweep.importReply = undefined;
    await expect(exportTo(f)).resolves.toMatchObject({ outcome: "returned", handoffId: saved.sent_id });
  });

  it("freezes manager-attention transitions while a transfer runs or a send is unconfirmed", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    const start = () => f.harness.callRpc("updateAttentionMode", { projectId: f.tracker.id, mode: "shadow" });
    transfers.set(BB_PROJECT, "export-to-sweep");
    await expect(start()).rejects.toThrow(/transfer \(export-to-sweep\) is running/);
    transfers.clear();
    sweep.refuse.set("transfer.import", "offline");
    await expect(exportTo(f)).rejects.toThrow();
    await expect(start()).rejects.toThrow(/not confirmed/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM attention_modes WHERE requested_mode IS NOT NULL OR effective_mode<>'off'").get()).toEqual({ n: 0 });
    sweep.refuse.clear();
    await exportTo(f);
  });

  it("serializes concurrent commands on the lock, and a stale completion changes nothing", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    sweep.refuse.set("transfer.import", "Newer state is held here.");
    await expect(exportTo(f)).rejects.toThrow();
    sweep.refuse.clear();
    // Two resumes: the second is refused while the first holds the lock, and Sweep sees one import and one commit.
    const gate = deferred();
    sweep.gateMethod = "transfer.import"; sweep.gate = gate.promise;
    const first = exportTo(f);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(exportTo(f)).rejects.toThrow(/already running/);
    await expect(f.service.transfer.abortSend(f.tracker.id)).rejects.toThrow(/already running/);
    // The first reply arrives after the row moved on: owner Sweep and back with a later handoff B. The compare-and-set changes nothing.
    f.db.prepare("UPDATE checks_runner_owner SET sent_id='handoff_b', sent_confirmed=1, owner='work-board', tracker_id=?").run(f.tracker.id);
    const moved = row(f);
    gate.release();
    await expect(first).resolves.toMatchObject({ outcome: "stale" });
    expect(row(f)).toEqual(moved);
    expect(sweep.calls.filter((call) => call === "transfer.commit")).toHaveLength(0);
  });

  it("aborts a send that Sweep refuses for good with both checkpoints intact, and discards an interleaved staging", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    const bytes = committed(f);
    const state = f.state();
    sweep.refuse.set("transfer.import", "Newer state is held here.");
    await expect(exportTo(f)).rejects.toThrow(/abort-send/);
    const id = row(f).sent_id as string;
    // Sweep holds it staged: that is resumed, not aborted.
    sweep.refuse.clear();
    sweep.refuse.set("status", "unreadable");
    await expect(f.service.transfer.abortSend(f.tracker.id)).rejects.toThrow();
    sweep.refuse.clear();
    sweep.incoming = { id, document: {}, bytes: null };
    await expect(f.service.transfer.abortSend(f.tracker.id)).rejects.toThrow(/staged/);
    sweep.incoming = null;
    sweep.importing = true;
    await expect(f.service.transfer.abortSend(f.tracker.id)).rejects.toThrow(/importing/);
    sweep.importing = false;
    await expect(f.service.transfer.abortSend(f.tracker.id)).resolves.toMatchObject({ outcome: "aborted", handoffId: id });
    expect(row(f)).toMatchObject({ owner: "work-board", sent_id: null, sent_confirmed: 0 });
    expect(committed(f)).toBe(bytes);
    expect(f.state()).toEqual(state);
    expect(sweep.committed?.toString()).toBe('{"n":1}');
    await expect(f.service.transfer.abortSend(f.tracker.id)).resolves.toMatchObject({ outcome: "nothing-to-abort" });
    // A fresh send gets a new id and now succeeds; the abort cleared a staging that had interleaved.
    const again = await exportTo(f);
    expect(again.handoffId).not.toBe(id);
  });

  it("does not abort a send without positive evidence from Sweep, even when Sweep is gone", async () => {
    const { f, sweep } = await make();
    await imported(f, sweep);
    sweep.refuse.set("transfer.import", "offline");
    await expect(exportTo(f)).rejects.toThrow();
    const saved = row(f);
    f.control.sweep = undefined;
    await expect(f.service.transfer.abortSend(f.tracker.id)).rejects.toThrow(/not installed or not enabled/);
    expect(row(f)).toEqual(saved);
  });

  it("cancels only the send it observed, and reports what Sweep actually did", async () => {
    const { f, sweep } = await make();
    sweep.seed();
    const first = await sweep.handle("transfer.export", {}) as { handoffId: string };
    sweep.afterStatus = () => { sweep.handoff = { ...sweep.handoff, sent: { id: "sweep_handoff_replaced" } }; };
    await expect(f.service.transfer.cancelSweepSend(f.tracker.id)).resolves.toMatchObject({ outcome: "changed", handoffId: first.handoffId });
    expect(sweep.handoff?.sent?.id).toBe("sweep_handoff_replaced");
    sweep.afterStatus = undefined;
    await expect(f.service.transfer.cancelSweepSend(f.tracker.id)).resolves.toMatchObject({ outcome: "cancelled", handoffId: "sweep_handoff_replaced" });
  });

  it("confirms, after a lost confirmation and a restart, instead of cancelling a send Work Board received, and cancels one it never received", async () => {
    const { f, sweep } = await make();
    sweep.seed();
    sweep.refuse.set("transfer.confirm", "offline");
    const first = await importFrom(f);
    expect(first.warning).toBeTruthy();
    transfers.clear(); runs.clear();
    // The row has lineage: nothing deletes it, relinks it or takes it over.
    await expect(f.service.transfer.release(f.tracker.id)).rejects.toThrow(/lineage/);
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" })).toThrow(/owns the runner after a transfer/);
    expect(() => f.store.tasks.deleteProject(f.tracker.id)).toThrow(/owns the runner after a transfer/);
    sweep.refuse.clear();
    await expect(f.service.transfer.cancelSweepSend(f.tracker.id)).resolves.toMatchObject({ outcome: "confirmed", handoffId: first.handoffId });
    expect(sweep.handoff?.sent?.confirmed).toBe(true);
    await expect(f.service.transfer.cancelSweepSend(f.tracker.id)).resolves.toMatchObject({ outcome: "already-confirmed" });
    // A send Work Board never received is cancelled, and refused while Work Board is transferring.
    const fresh = await make();
    fresh.sweep.seed();
    await fresh.sweep.handle("transfer.export", {});
    transfers.set(BB_PROJECT, "import-from-sweep");
    await expect(fresh.f.service.transfer.cancelSweepSend(fresh.f.tracker.id)).rejects.toThrow(/transferring/);
    transfers.clear();
    await expect(fresh.f.service.transfer.cancelSweepSend(fresh.f.tracker.id)).resolves.toMatchObject({ outcome: "cancelled" });
    expect(fresh.sweep.handoff?.sent).toBeUndefined();
    await expect(fresh.f.service.transfer.cancelSweepSend(fresh.f.tracker.id)).resolves.toMatchObject({ outcome: "nothing-to-cancel" });
  });
});

describe("an unknown baseline", () => {
  const run = async (baseline: string, output: string, code = 0, baselineCode = 0, candidate = '{"seen":1}') => {
    const { f, sweep } = await make();
    f.standard();
    sweep.seed('{"seen":1}', { lastReport: { fingerprint: reportContents(baselineCode, baseline).fingerprint, manager: MANAGER, at: 1 } });
    await importFrom(f);
    f.output(output, code, candidate);
    await f.enable({ snapshots: true });
    await f.tick();
    return f;
  };
  it("sends a cleared Waiting list from an unknown baseline, with the clear line", async () => {
    const f = await run("WAIT EXA-3: blocker EXA-9\n", "");
    expect(f.sent()).toContain("Waiting list is clear");
  });
  it("stays quiet when the fingerprint is unchanged", async () => {
    const f = await run("STATE same\n", "STATE same");
    expect(f.sent()).toBe("");
    expect(f.threads.sends).toBe(0);
  });
  it("stays quiet when the fingerprint is unchanged, whatever Waiting and action items it holds", async () => {
    const text = "WAIT EXA-3: blocker EXA-9\nACTION idle-no-link EXA-1: idle 5 min\n";
    const f = await run(text, text.trim(), 1, 1);
    expect(f.threads.sends).toBe(0);
    expect(f.sent()).toBe("");
  });
  it("says the Waiting list is clear when a changed candidate sends a report with an unchanged fingerprint", async () => {
    const f = await run("STATE same\n", "STATE same", 0, 0, '{"seen":2}');
    expect(f.threads.sends).toBe(1);
    expect(f.sent()).toContain("Waiting list is clear");
  });
  it("sends changed items", async () => {
    const f = await run("STATE same\n", "ACTION idle-no-link EXA-1: idle 5 min", 1);
    expect(f.sent()).toContain("EXA-1");
  });
});

describe("the commands", () => {
  it("run from the CLI with --project and --json, and the status shows the runner owner", async () => {
    const { f, sweep } = await make();
    sweep.seed();
    // Explicit commands keep the wide channel and never use the settings-only one.
    const channels = (from: number) => f.harness.realtimeSignals.slice(from).map((signal: { channel: string }) => signal.channel);
    let mark = f.harness.realtimeSignals.length;
    const imported = await f.harness.runCli(["checks", "import-from-sweep", "--project", "CHK", "--json"]);
    expect(imported.exitCode).toBe(0);
    expect(channels(mark)).toEqual(["projects:changed"]);
    expect(JSON.parse(imported.stdout)).toMatchObject({ outcome: "imported" });
    const status = await f.harness.runCli(["checks", "status", "--project", "CHK"]);
    expect(status.stdout).toMatch(/Runner owner\s+Work Board \(CHK\)/);
    const again = await f.harness.runCli(["checks", "import-from-sweep", "--project", "CHK"]);
    expect(again.exitCode).toBe(0);
    const returned = await f.harness.runCli(["checks", "export-to-sweep", "--project", "CHK", "--json"]);
    expect(JSON.parse(returned.stdout)).toMatchObject({ outcome: "returned" });
    mark = f.harness.realtimeSignals.length;
    expect((await f.harness.runCli(["checks", "release", "--project", "CHK"])).exitCode).toBe(0);
    expect(channels(mark)).toEqual(["projects:changed"]);
    expect((await f.harness.runCli(["checks", "abort-send", "--project", "CHK"])).stdout).toMatch(/No unconfirmed send/);
    expect((await f.harness.runCli(["checks", "cancel-sweep-send", "--project", "CHK"])).exitCode).toBe(0);
    expect(await f.harness.callRpc("getChecksStatus", { projectId: f.tracker.id })).toMatchObject({ runnerOwner: "Sweep", unconfirmedSend: null });
  });
});
