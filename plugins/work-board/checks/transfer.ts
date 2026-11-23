import { createHash, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { getModeRow, isPending } from "../attention/modes";
import { SWEEP_PLUGIN_ID } from "../shared/attention";
import { errorMessage } from "../shared/errors";
import { readDraft } from "./config";
import { isDraining, runs, stateMismatch } from "./ownership";
import type { State, checksStore } from "./store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type Store = ReturnType<typeof checksStore>;

export const TRANSFER_FORMAT = "bb-runner-state/1";
export const CHUNK_BYTES = 262_144;
const MAX_BYTES = 268_435_456;
const baseline = z.object({ fingerprint: z.string().min(1), manager: z.string().optional() }).strict();
// Twin of transferDocument in plugins/bb-plugin-sweep/transfer.ts: keep the two schemas identical.
export const transferDocument = z.object({
  format: z.literal(TRANSFER_FORMAT),
  from: z.enum(["sweep", "work-board"]),
  bbProjectId: z.string().min(1),
  handoffId: z.string().min(1),
  previous: z.string().min(1).nullable(),
  exportedAt: z.string().min(1),
  committed: z.object({ size: z.number().int().min(0).max(MAX_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().nullable(),
  lastReport: baseline.extend({ at: z.number(), changes: z.object({ noteworthy: z.array(z.string()), waiting: z.string() }).strict().optional() }).strict().optional(),
  lastFailure: baseline.optional(),
  reportedWorktrees: z.array(z.string()),
  lastMeasuredWorktree: z.string().optional(),
}).strict();
export type TransferDocument = z.infer<typeof transferDocument>;
const chunkOutput = z.object({ data: z.string(), end: z.boolean() }).strict();
const bbProjectId = z.string().min(1);
const handoffId = z.string().min(1).max(200);
const ownershipOutput = z.object({
  owner: z.enum(["sweep", "work-board"]).nullable(), trackerId: z.string().nullable(), sentId: z.string().nullable(), sentConfirmed: z.boolean(), receivedId: z.string().nullable(), transferring: z.boolean(),
}).strict();

/** The runner-ownership calls of Sweep's admission and transfer commands; Work Board's durable row is the one arbiter. */
export const checksRpcContract = defineRpcContract({
  "checks.claim": {
    experimental_description: "First admission of Sweep for a BB project: granted once, and only while no tracker holds the runner or its state (Sweep contract).",
    input: z.object({ bbProjectId, claimant: z.literal("sweep") }).strict(),
    output: z.object({ granted: z.boolean(), reason: z.string().optional() }).strict(),
  },
  "checks.ownership": {
    experimental_description: "Read the runner ownership row of a BB project (Sweep contract).",
    input: z.object({ bbProjectId }).strict(),
    output: ownershipOutput,
  },
  "checks.transferDocument": {
    experimental_description: "Serve the transfer document of the current unconfirmed send to Sweep (Sweep contract).",
    input: z.object({ bbProjectId, handoffId }).strict(),
    output: transferDocument,
  },
  "checks.transferChunk": {
    experimental_description: "Serve one chunk (at most 256 KB, base64) of the committed bytes of the current unconfirmed send to Sweep (Sweep contract).",
    input: z.object({ bbProjectId, handoffId, offset: z.number().int().min(0) }).strict(),
    output: chunkOutput,
  },
});

export interface OwnerRow { bb_project_id: string; owner: "sweep" | "work-board"; tracker_id: string | null; sent_id: string | null; sent_confirmed: number; received_id: string | null; updated_at: string }
export const readOwner = (db: Database, link: string): OwnerRow | undefined => db.prepare<[string], OwnerRow>("SELECT * FROM checks_runner_owner WHERE bb_project_id=?").get(link);
export const hasLineage = (row: OwnerRow) => row.received_id !== null || row.sent_id !== null;
const unconfirmedSend = (row: OwnerRow | undefined) => !!row && row.sent_id !== null && row.sent_confirmed === 0;

/** Transfers in progress by bb project, in this process: one command at a time holds a project from its first call to its last write. */
export const transfers = new Map<string, string>();

/** Why a tracker cannot run, reset, relink, delete or release right now because of a transfer; null when nothing fences it. */
export function fenceMessage(db: Database, trackerId: string, link: string | null): string | null {
  if (!link) return null;
  const running = transfers.get(link);
  if (running) return `A transfer (${running}) is running for this bb project. Wait for it to finish.`;
  const row = readOwner(db, link);
  if (row?.owner === "work-board" && row.tracker_id === trackerId && unconfirmedSend(row)) {
    return "The runner state was sent to Sweep and the send is not confirmed. Rerun bb work-board checks export-to-sweep to finish it, or bb work-board checks abort-send if Sweep keeps refusing it.";
  }
  return null;
}

/** A relink or delete of the owning tracker gives the row up when it came from a first admission; a row with lineage is never given up. */
export function assertOwnerReleasable(db: Database, trackerId: string, link: string | null, action: "relinked" | "deleted"): void {
  if (!link) return;
  const fence = fenceMessage(db, trackerId, link);
  if (fence) throw new Error(fence);
  const row = readOwner(db, link);
  if (row?.owner === "work-board" && row.tracker_id === trackerId && hasLineage(row)) {
    throw new Error(`This project owns the runner after a transfer with Sweep, so it cannot be ${action}. Hand the runner back first with bb work-board checks export-to-sweep.`);
  }
}
export function releaseOwner(db: Database, trackerId: string, link: string | null): void {
  if (link) db.prepare("DELETE FROM checks_runner_owner WHERE bb_project_id=? AND owner='work-board' AND tracker_id=? AND received_id IS NULL AND sent_id IS NULL").run(link, trackerId);
}

// A tracker that ran, staged or imported anything holds state; a settings edit alone only writes a due time.
const STATE_KEYS = ["tickId", "lastRun", "lastReport", "lastFailure", "deliveredAt", "reportedWorktrees", "pendingWorktrees", "lastMeasuredWorktree"] as const;
export function holdsState(db: Database, trackerId: string): boolean {
  const delivery = db.prepare<[string], { committed: Buffer | null; report_id: string | null }>("SELECT committed, report_id FROM checks_delivery WHERE tracker_id=?").get(trackerId);
  if (delivery?.committed || delivery?.report_id) return true;
  const state = JSON.parse(db.prepare<[string], { value: string }>("SELECT value FROM checks_state WHERE tracker_id=?").get(trackerId)?.value ?? "{}") as Record<string, unknown>;
  return STATE_KEYS.some((key) => state[key] !== undefined);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const importOutput = z.object({ staged: z.boolean(), duplicate: z.boolean().optional() }).passthrough();
const settledOutput = z.object({ settled: z.string() }).passthrough();
const sweepStatus = z.object({
  config: z.object({ enabled: z.boolean() }).passthrough().nullable(), running: z.boolean().optional(), hasState: z.boolean().optional(), importing: z.boolean().optional(),
  incoming: z.string().nullable().optional(), handoff: z.object({ granted: z.boolean().optional(), sent: z.object({ id: z.string(), confirmed: z.boolean().optional() }).passthrough().optional(), received: z.string().optional() }).passthrough().nullable().optional(),
}).passthrough();

export interface TransferDeps {
  bb: BbPluginApi;
  db: Database;
  store: Store;
  signal: AbortSignal;
  tracker: (trackerId: string) => { link: string | null; prefix: string };
  committedFor: (trackerId: string, link: string) => Buffer | null;
  changed: (trackerId: string) => void;
}

export type TransferResult = { outcome: string; message: string; handoffId?: string; warning?: string };
const done = (outcome: string, message: string, extra: { handoffId?: string; warning?: string } = {}): TransferResult => ({ outcome, message, ...extra });

export function createTransfer(deps: TransferDeps) {
  const { bb, db, store, tracker, committedFor } = deps;
  const sweepCall = <T>(method: string, input: Record<string, string | number | null>, outputSchema: z.ZodType<T>, ms = 3000) =>
    bb.sdk.plugins.callRpc({ pluginId: SWEEP_PLUGIN_ID, method, input, outputSchema, signal: AbortSignal.any([deps.signal, AbortSignal.timeout(ms)]) });
  const sweepInstalled = async () => (await bb.sdk.plugins.list({ signal: deps.signal })).plugins.some((plugin) => plugin.id === SWEEP_PLUGIN_ID);
  const now = () => new Date().toISOString();
  const label = (trackerId: string) => db.prepare<[string], { prefix: string }>("SELECT prefix FROM projects WHERE id=?").get(trackerId)?.prefix ?? trackerId;

  /** The project-wide idle rule of both directions: every linked tracker disabled, not running and drained, and no other tracker holding state. */
  function assertProjectIdle(link: string, trackerId: string) {
    for (const { id, prefix } of db.prepare<[string], { id: string; prefix: string }>("SELECT id, prefix FROM projects WHERE linked_bb_project_id=?").all(link)) {
      if (readDraft(db, id).enabled) throw new Error(`Repository checks of ${prefix} are enabled. Disable them first.`);
      if ([...runs.values()].includes(id)) throw new Error(`Repository checks of ${prefix} are running. Wait for the run to finish.`);
      if (isDraining(db, id, link)) throw new Error(`Repository checks of ${prefix} still hold a pending report. Let it deliver (enable the checks until it is delivered, then disable them) or retry it.`);
      if (id !== trackerId && holdsState(db, id)) throw new Error(`Tracker ${prefix} holds repository-checks state for this bb project. Reset it first so only one tracker's state moves.`);
    }
    const mismatch = stateMismatch(db, trackerId, link);
    if (mismatch) throw new Error(`The tracker's state belongs to ${mismatch}. Reset it first.`);
  }

  /** Live (or changing) attention may have been acknowledged by Work Board itself, which only holds while it keeps the runner. */
  function assertAttentionNotLive(trackerId: string) {
    const mode = getModeRow(db, trackerId);
    if (mode.effective_mode === "live" || isPending(mode)) throw new Error("Manager attention is live or changing for this project. Switch it off in the project settings first.");
  }

  // ---- admission ------------------------------------------------------------------------------------------------

  /** Positive evidence that Sweep neither runs nor holds state for this project; anything else, including an old Sweep, is inconclusive. */
  async function requireSweepIdle(link: string) {
    if (!(await sweepInstalled())) return;
    let status: z.infer<typeof sweepStatus>;
    try { status = await sweepCall("status", { projectId: link }, sweepStatus); } catch (error) {
      if (deps.signal.aborted) throw error;
      throw new Error(`Sweep's state for this project could not be read (${errorMessage(error)}). Retry in a moment.`);
    }
    // Positive evidence only: the 0.7.0 fields must be present even without a config, or an old Sweep could still run from its legacy setting.
    if ((status.config === null || status.config.enabled === false) && status.running === false && status.hasState === false && status.importing !== true && !status.incoming && !status.handoff) return;
    throw new Error("Sweep may run or hold state for this project (or reports a version without the transfer fields). Disable Sweep and move its state with bb work-board checks import-from-sweep, or update Sweep.");
  }

  function precheck(trackerId: string): string | null {
    const link = tracker(trackerId).link;
    if (!link) return null;
    const fence = fenceMessage(db, trackerId, link);
    if (fence) throw new Error(fence);
    const row = readOwner(db, link);
    if (row?.owner === "sweep") throw new Error("Sweep owns this project's repository checks. Disable Sweep and run bb work-board checks import-from-sweep to move them here.");
    if (row?.owner === "work-board" && row.tracker_id !== trackerId) throw new Error(`Repository checks of this bb project belong to tracker ${row.tracker_id ? label(row.tracker_id) : "?"}.`);
    return link;
  }

  /**
   * First admission of the tracker: `validate` states the caller's own conditions and `apply` takes effect (enable, or reserve the run).
   * Without a row Sweep must show it is idle, and that is awaited; everything after the await is one synchronous transaction that
   * validates again, inserts the row and applies, so overlapping admissions cannot both win.
   */
  async function claimForWorkBoard(trackerId: string, validate: (link: string | null) => void, apply: (link: string) => void): Promise<void> {
    validate(tracker(trackerId).link);
    const link = precheck(trackerId);
    if (!link) throw new Error("Link a bb project to this tracker first.");
    if (!readOwner(db, link)) await requireSweepIdle(link);
    db.transaction(() => {
      validate(tracker(trackerId).link);
      if (precheck(trackerId) !== link) throw new Error("The BB project link changed while ownership was checked. Retry.");
      if (!readOwner(db, link)) db.prepare("INSERT INTO checks_runner_owner (bb_project_id, owner, tracker_id, sent_id, sent_confirmed, received_id, updated_at) VALUES (?, 'work-board', ?, NULL, 0, NULL, ?)").run(link, trackerId, now());
      apply(link);
    })();
  }

  /** The RPC of Sweep's first admission: a synchronous check-and-insert. */
  function claimForSweep(link: string): { granted: boolean; reason?: string } {
    return db.transaction(() => {
      const running = transfers.get(link);
      if (running) return { granted: false, reason: `a transfer (${running}) is running` };
      const row = readOwner(db, link);
      if (row?.owner === "work-board") return { granted: false, reason: "Work Board owns the runner" };
      if (row?.owner === "sweep") return { granted: true };
      for (const { id, prefix } of db.prepare<[string], { id: string; prefix: string }>("SELECT id, prefix FROM projects WHERE linked_bb_project_id=?").all(link)) {
        if (readDraft(db, id).enabled || isDraining(db, id, link) || holdsState(db, id)) return { granted: false, reason: `tracker ${prefix} is enabled, draining or holds checks state` };
      }
      db.prepare("INSERT INTO checks_runner_owner (bb_project_id, owner, tracker_id, sent_id, sent_confirmed, received_id, updated_at) VALUES (?, 'sweep', NULL, NULL, 0, NULL, ?)").run(link, now());
      return { granted: true };
    })();
  }

  // ---- the document -----------------------------------------------------------------------------------------------

  function buildDocument(trackerId: string, link: string, id: string, previous: string | null, exportedAt: string): TransferDocument {
    const state = store.state(trackerId);
    const committed = committedFor(trackerId, link);
    // A JSON round trip: an absent baseline is a missing key, never an undefined one.
    return transferDocument.parse(JSON.parse(JSON.stringify({
      format: TRANSFER_FORMAT, from: "work-board", bbProjectId: link, handoffId: id, previous, exportedAt,
      committed: committed ? { size: committed.length, sha256: sha256(committed) } : null,
      lastReport: state.lastReport, lastFailure: state.lastFailure, reportedWorktrees: state.reportedWorktrees ?? [], lastMeasuredWorktree: state.lastMeasuredWorktree,
    })));
  }

  /** The unconfirmed send of a bb project: only its handoff id is ever served. */
  function served(link: string, id: string): { row: OwnerRow; trackerId: string } {
    const row = readOwner(db, link);
    if (!row || row.owner !== "work-board" || !row.tracker_id || row.sent_id !== id || row.sent_confirmed !== 0) throw new Error("No unconfirmed send with that handoff id.");
    return { row, trackerId: row.tracker_id };
  }

  async function pullBytes(document: TransferDocument, fetchChunk: (offset: number) => Promise<z.infer<typeof chunkOutput>>): Promise<Buffer | null> {
    if (!document.committed) return null;
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const { data, end } = await fetchChunk(offset);
      const part = Buffer.from(data, "base64");
      parts.push(part);
      offset += part.length;
      if (offset > document.committed.size) throw new Error("The sender returned more bytes than the document declares.");
      if (end) break;
      if (!part.length) throw new Error("The sender returned an empty chunk before the end.");
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== document.committed.size || sha256(bytes) !== document.committed.sha256) throw new Error("The transferred bytes do not match the size and sha256 of the document.");
    return bytes;
  }

  // ---- the lock -----------------------------------------------------------------------------------------------------

  async function locked<T>(trackerId: string, name: string, run: (link: string) => Promise<T>): Promise<T> {
    const { link } = tracker(trackerId);
    if (!link) throw new Error("Link a bb project to this tracker first.");
    const active = transfers.get(link);
    if (active) throw new Error(`A transfer (${active}) is already running for this bb project. Wait for it to finish, then rerun.`);
    transfers.set(link, name);
    try { return await run(link); } finally { transfers.delete(link); deps.changed(trackerId); }
  }

  // ---- Sweep → Work Board -------------------------------------------------------------------------------------------

  type Verdict = { accept: true; duplicate?: true } | { accept: false; reason: string };
  /** The receiver rule, the same on both sides: duplicate, returning owner, empty initial destination, or refusal. */
  function judge(row: OwnerRow | undefined, trackerId: string, document: TransferDocument): Verdict {
    if (row?.received_id === document.handoffId) return { accept: true, duplicate: true };
    if (row?.sent_id && document.previous === row.sent_id) {
      return row.sent_confirmed ? { accept: true } : { accept: false, reason: "The earlier send to Sweep is not confirmed. Rerun bb work-board checks export-to-sweep to finish it." };
    }
    if (!row?.sent_id && !row?.received_id && !holdsState(db, trackerId)) return { accept: true };
    return { accept: false, reason: "Newer state is held here." };
  }

  async function importFromSweep(trackerId: string): Promise<TransferResult> {
    return locked(trackerId, "import-from-sweep", async (link) => {
      const check = () => {
        const row = readOwner(db, link);
        if (tracker(trackerId).link !== link) throw new Error("The BB project link changed during the transfer. Rerun.");
        if (unconfirmedSend(row)) throw new Error("A send to Sweep is not confirmed. Rerun bb work-board checks export-to-sweep first.");
        if (row?.owner === "work-board" && row.tracker_id !== trackerId) throw new Error(`Repository checks of this bb project belong to tracker ${row.tracker_id ? label(row.tracker_id) : "?"}.`);
        assertProjectIdle(link, trackerId);
        return row;
      };
      const before = check();
      if (!(await sweepInstalled())) throw new Error("Sweep is not installed, so there is nothing to import.");
      // A rerun after a completed import: Sweep refuses a second export, so its confirmed send tells that we are done.
      if (before?.received_id) {
        const status = await sweepCall("status", { projectId: link }, sweepStatus);
        if (status.handoff?.sent?.id === before.received_id && status.handoff.sent.confirmed) return done("already-imported", "Sweep's state was imported already; nothing to do.", { handoffId: before.received_id });
      }
      let document: TransferDocument;
      try { document = await sweepCall("transfer.export", { projectId: link }, transferDocument, 30_000); } catch (error) {
        if (deps.signal.aborted) throw error;
        throw new Error(`Sweep refused the export: ${errorMessage(error)}`);
      }
      if (document.from !== "sweep" || document.bbProjectId !== link) throw new Error("The handoff document does not belong to this project and sender.");
      const bytes = await pullBytes(document, (offset) => sweepCall("transfer.chunk", { projectId: link, handoffId: document.handoffId, offset }, chunkOutput, 15_000));
      // One synchronous transaction: every precondition again, the acceptance rule, and the replacement of the tracker's state.
      const duplicate = db.transaction(() => {
        const row = check();
        const verdict = judge(row, trackerId, document);
        if (!verdict.accept) throw new Error(verdict.reason);
        if (verdict.duplicate) return true;
        const old = store.state(trackerId);
        const next: State = {
          bbProjectId: link, tickId: old.tickId, lastRun: old.lastRun, nextRun: Date.now(),
          lastReport: document.lastReport, lastFailure: document.lastFailure, reportedWorktrees: document.reportedWorktrees, lastMeasuredWorktree: document.lastMeasuredWorktree,
        };
        store.replaceCommitted(trackerId, link, bytes);
        store.save(trackerId, next);
        db.prepare(`INSERT INTO checks_runner_owner (bb_project_id, owner, tracker_id, sent_id, sent_confirmed, received_id, updated_at) VALUES (?, 'work-board', ?, NULL, 0, ?, ?)
          ON CONFLICT(bb_project_id) DO UPDATE SET owner='work-board', tracker_id=excluded.tracker_id, received_id=excluded.received_id, updated_at=excluded.updated_at`).run(link, trackerId, document.handoffId, now());
        return false;
      })();
      let warning: string | undefined;
      try { await sweepCall("transfer.confirm", { projectId: link, handoffId: document.handoffId }, z.object({ confirmed: z.literal(true) }).passthrough()); } catch (error) {
        if (deps.signal.aborted) throw error;
        warning = `Sweep could not confirm the receipt (${errorMessage(error)}). Rerun bb work-board checks import-from-sweep to confirm it.`;
      }
      bb.log.info(`repository checks for ${trackerId}: imported ${document.handoffId} from Sweep${duplicate ? " (duplicate)" : ""}`);
      return done(duplicate ? "duplicate" : "imported", `${duplicate ? "Sweep's state was imported already" : "Imported Sweep's state"}. Repository checks stay disabled; enable them when ready. The first report after a transfer may repeat once.`, { handoffId: document.handoffId, warning });
    });
  }

  // ---- Work Board → Sweep -------------------------------------------------------------------------------------------

  /** The push of a saved send: Sweep pulls and stages it, the row flips to Sweep by compare-and-set, and Sweep is told to commit. */
  async function pushToSweep(trackerId: string, link: string, id: string): Promise<TransferResult> {
    const refusal = (why: string) => new Error(`Sweep refused the handoff: ${why}. Rerun to retry it; if Sweep keeps refusing it, run bb work-board checks abort-send.`);
    let imported: z.infer<typeof importOutput>;
    try { imported = await sweepCall("transfer.import", { projectId: link, handoffId: id }, importOutput, 120_000); } catch (error) {
      if (deps.signal.aborted) throw error;
      throw refusal(errorMessage(error));
    }
    // Only a staging or a duplicate receipt is evidence; anything else leaves the same send unconfirmed and resumable.
    if (imported.staged !== true && imported.duplicate !== true) throw refusal("Sweep reported neither a staging nor a duplicate receipt");
    // Compare-and-set on the send this call started: a delayed reply cannot overwrite a later decision.
    const flipped = db.prepare("UPDATE checks_runner_owner SET sent_confirmed=1, owner='sweep', tracker_id=NULL, updated_at=? WHERE bb_project_id=? AND owner='work-board' AND tracker_id=? AND sent_id=? AND sent_confirmed=0").run(now(), link, trackerId, id).changes === 1;
    if (!flipped) {
      const row = readOwner(db, link);
      return done("stale", `The send ${id} was already decided (owner ${row?.owner ?? "none"}, send ${row?.sent_id ?? "none"}${row?.sent_confirmed ? ", confirmed" : ""}); nothing changed.`, { handoffId: id });
    }
    let warning: string | undefined;
    try {
      const { settled } = await sweepCall("transfer.commit", { projectId: link, handoffId: id }, settledOutput, 30_000);
      // The confirmed row stays whatever Sweep answers; only the report changes. "none" means another settler got there first: verify it.
      if (settled === "none") {
        const status = await sweepCall("status", { projectId: link }, sweepStatus);
        if (status.handoff?.received !== id) warning = "Sweep reports nothing to settle, yet it does not show this handoff as received. Check bb sweep status and rerun this command.";
      } else if (settled !== "applied") {
        warning = `Sweep has not applied the state yet (${settled}). It stays staged and Sweep applies it on its own at its next run or enable; rerun this command to check.`;
      }
    } catch (error) {
      if (deps.signal.aborted) throw error;
      warning = `Sweep did not answer the commit (${errorMessage(error)}). Sweep settles it on its own at its next run or enable; rerun this command to check.`;
    }
    bb.log.info(`repository checks for ${trackerId}: handed ${id} to Sweep${warning ? " (application pending)" : ""}`);
    if (warning) return done("pending-application", "Ownership moved to Sweep, but Sweep has not applied the state yet. Sweep stays disabled; enable it only once bb sweep status shows the handoff as received.", { handoffId: id, warning });
    return done("returned", "Handed the runner state to Sweep. Sweep stays disabled; enable it when ready. The first report after a transfer may repeat once.", { handoffId: id });
  }

  async function exportToSweep(trackerId: string): Promise<TransferResult> {
    return locked(trackerId, "export-to-sweep", async (link) => {
      const row = readOwner(db, link);
      // Resume: a saved, unconfirmed send skips the preflight and the id generation.
      if (row?.owner === "work-board" && row.tracker_id === trackerId && unconfirmedSend(row)) return pushToSweep(trackerId, link, row.sent_id!);
      if (row?.owner === "sweep" && row.sent_id && row.sent_confirmed) {
        const id = row.sent_id;
        await sweepCall("transfer.commit", { projectId: link, handoffId: id }, settledOutput, 30_000).catch((error) => { throw new Error(`Sweep did not answer the commit (${errorMessage(error)}). Rerun to retry.`); });
        const status = await sweepCall("status", { projectId: link }, sweepStatus);
        if (status.handoff?.received !== id) throw new Error("Sweep has not applied the handoff yet. Rerun in a moment; if it never does, check bb sweep status.");
        return done("already-returned", "The runner state is with Sweep already.", { handoffId: id });
      }
      const check = () => {
        if (tracker(trackerId).link !== link) throw new Error("The BB project link changed during the transfer. Rerun.");
        const current = readOwner(db, link);
        if (current?.owner !== "work-board" || current.tracker_id !== trackerId) throw new Error("This tracker does not own the runner of its bb project, so there is nothing to hand to Sweep.");
        if (unconfirmedSend(current)) throw new Error("A send is already unconfirmed. Rerun bb work-board checks export-to-sweep.");
        assertProjectIdle(link, trackerId);
        assertAttentionNotLive(trackerId);
        return current;
      };
      const first = check();
      if (!(await sweepInstalled())) throw new Error("Sweep is not installed, so there is nothing to hand the runner to.");
      let verdict: { accept: boolean; reason: string | null };
      try { verdict = await sweepCall("transfer.preflight", { projectId: link, previous: first.received_id }, z.object({ accept: z.boolean(), reason: z.string().nullable() }), 10_000); } catch (error) {
        if (deps.signal.aborted) throw error;
        throw new Error(`Sweep could not be asked whether it accepts the handoff (${errorMessage(error)}). Nothing was changed.`);
      }
      if (!verdict.accept) throw new Error(`Sweep would refuse the handoff: ${verdict.reason ?? "no reason given"}. Nothing was changed.`);
      // Nothing is marked before the document is built and validated; then the row is saved in the same synchronous section.
      const id = randomUUID();
      db.transaction(() => {
        const current = check();
        const at = now();
        buildDocument(trackerId, link, id, current.received_id, at);
        const saved = db.prepare("UPDATE checks_runner_owner SET sent_id=?, sent_confirmed=0, updated_at=? WHERE bb_project_id=? AND owner='work-board' AND tracker_id=? AND received_id IS ? AND (sent_id IS NULL OR sent_confirmed=1)").run(id, at, link, trackerId, current.received_id).changes === 1;
        if (!saved) throw new Error("The ownership row changed. Rerun.");
      })();
      return pushToSweep(trackerId, link, id);
    });
  }

  /** A permanent refusal after the fence: clear the unconfirmed send when Sweep positively holds nothing for it. */
  async function abortSend(trackerId: string): Promise<TransferResult> {
    return locked(trackerId, "abort-send", async (link) => {
      const row = readOwner(db, link);
      if (!(row?.owner === "work-board" && row.tracker_id === trackerId && unconfirmedSend(row))) return done("nothing-to-abort", "No unconfirmed send is saved for this tracker.");
      const id = row.sent_id!;
      // Positive evidence is required: Sweep may have staged the handoff and gone offline with the row still on disk.
      if (!(await sweepInstalled())) throw new Error("Sweep is not installed or not enabled, so it cannot be shown that it holds nothing staged for this send. Bring Sweep back, then rerun; the send stays saved meanwhile.");
      const status = await sweepCall("status", { projectId: link }, sweepStatus);
      if (status.incoming === undefined || status.importing === undefined) throw new Error("Sweep's status has no transfer fields (an older Sweep), so it cannot be shown that it holds nothing for this send.");
      if (status.incoming === id) throw new Error("Sweep holds this handoff staged. Rerun bb work-board checks export-to-sweep to finish it instead of aborting.");
      if (status.importing) throw new Error("Sweep is importing right now. Wait for it to finish, then rerun.");
      const cleared = db.prepare("UPDATE checks_runner_owner SET sent_id=NULL, sent_confirmed=0, updated_at=? WHERE bb_project_id=? AND tracker_id=? AND sent_id=? AND sent_confirmed=0").run(now(), link, trackerId, id).changes === 1;
      if (!cleared) return done("stale", "The send was already decided; nothing changed.", { handoffId: id });
      // A staging that interleaved is discarded at once; if Sweep cannot be reached it settles it on its own.
      await sweepCall("transfer.commit", { projectId: link, handoffId: id }, settledOutput, 10_000).catch(() => undefined);
      return done("aborted", "The send was aborted. Work Board keeps the runner and its state.", { handoffId: id });
    });
  }

  /** Sweep's own unconfirmed send that Work Board never committed (the pull direction): confirm it when received, otherwise cancel it. */
  async function cancelSweepSend(trackerId: string): Promise<TransferResult> {
    const { link } = tracker(trackerId);
    if (!link) throw new Error("Link a bb project to this tracker first.");
    if (!(await sweepInstalled())) throw new Error("Sweep is not installed.");
    const status = await sweepCall("status", { projectId: link }, sweepStatus);
    const sent = status.handoff?.sent;
    if (!sent) return done("nothing-to-cancel", "Sweep has no send for this project.");
    if (sent.confirmed) return done("already-confirmed", "Sweep's send is confirmed: Work Board holds the state.", { handoffId: sent.id });
    if (readOwner(db, link)?.received_id === sent.id) {
      await sweepCall("transfer.confirm", { projectId: link, handoffId: sent.id }, z.object({ confirmed: z.literal(true) }).passthrough());
      return done("confirmed", "Work Board had received Sweep's send; it is confirmed now.", { handoffId: sent.id });
    }
    // The observed id travels with the call; Sweep compares it under its write lock and reports what it actually did.
    const result = await sweepCall("transfer.cancel", { projectId: link, handoffId: sent.id }, z.object({ cancelled: z.boolean() }).passthrough());
    if (!result.cancelled) return done("changed", `Sweep's send ${sent.id} was already decided or replaced; nothing was cancelled. Check bb sweep status and rerun.`, { handoffId: sent.id });
    return done("cancelled", "Sweep's unconfirmed send was cancelled; Sweep keeps its state.", { handoffId: sent.id });
  }

  /** Ends Work Board ownership of a single-plugin setup: only a row from a first admission, for a disabled and drained tracker. */
  async function release(trackerId: string): Promise<TransferResult> {
    return locked(trackerId, "release", async (link) => {
      const row = readOwner(db, link);
      if (!row || row.owner !== "work-board" || row.tracker_id !== trackerId) return done("nothing-to-release", "This tracker does not own the runner row.");
      if (hasLineage(row)) throw new Error("The runner row has transfer lineage, so it is never deleted. Hand the runner back with bb work-board checks export-to-sweep.");
      assertAttentionNotLive(trackerId);
      assertProjectIdle(link, trackerId);
      releaseOwner(db, trackerId, link);
      return done("released", "Work Board no longer owns the runner of this bb project.");
    });
  }

  // ---- RPC and status ---------------------------------------------------------------------------------------------

  const handlers: ExperimentalPluginRpcHandlersWithContext<typeof checksRpcContract> = {
    "checks.claim"({ bbProjectId: link }, context) {
      if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== SWEEP_PLUGIN_ID) return { granted: false, reason: "only the Sweep plugin may claim" };
      return claimForSweep(link);
    },
    "checks.ownership"({ bbProjectId: link }) {
      const row = readOwner(db, link);
      return { owner: row?.owner ?? null, trackerId: row?.tracker_id ?? null, sentId: row?.sent_id ?? null, sentConfirmed: row?.sent_confirmed === 1, receivedId: row?.received_id ?? null, transferring: transfers.has(link) };
    },
    "checks.transferDocument"({ bbProjectId: link, handoffId: id }) {
      const { row, trackerId } = served(link, id);
      return buildDocument(trackerId, link, id, row.received_id, row.updated_at);
    },
    "checks.transferChunk"({ bbProjectId: link, handoffId: id, offset }) {
      const { trackerId } = served(link, id);
      const bytes = committedFor(trackerId, link) ?? Buffer.alloc(0);
      const slice = bytes.subarray(offset, offset + CHUNK_BYTES);
      return { data: slice.toString("base64"), end: offset + slice.length >= bytes.length };
    },
  };

  /** "Work Board (KEY) | Sweep | -" and the unconfirmed send, for the status of every surface. */
  function ownerStatus(link: string | null) {
    const row = link ? readOwner(db, link) : undefined;
    const owner = !row ? "-" : row.owner === "sweep" ? "Sweep" : `Work Board (${row.tracker_id ? label(row.tracker_id) : "?"})`;
    return { runnerOwner: owner, unconfirmedSend: row && unconfirmedSend(row) ? row.sent_id : null };
  }

  return {
    claimForWorkBoard, fenceMessage: (trackerId: string, link: string | null) => fenceMessage(db, trackerId, link), ownerStatus,
    importFromSweep, exportToSweep, abortSend, cancelSweepSend, release,
    registerRpc: () => bb.rpc.register(checksRpcContract, handlers),
  };
}
