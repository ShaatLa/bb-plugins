import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { configuredManager } from "../attention/modes";
import type { TasksStore } from "../db";
import { linkedThreads, threadActivity } from "../plans/notice";
import { errorMessage } from "../shared/errors";
import { planDebtNotice } from "../shared/plan-debt";
import { deliverWithReceipt, searchAttentionMarker, type Receipt } from "../steer";
import { expandEvent, openEpisodeDebt, repairPlanDebt, setNotice, setNoticeCursor, unexpandedEvents, unsentNotices, writeDueReminders, type NoticeRow } from "./store";
import type { HistoryCursor } from "../steer";

const instances = new WeakMap<BbPluginApi, ReturnType<typeof createService>>();
export function planDebtService(bb: BbPluginApi, tasks: TasksStore): ReturnType<typeof createService> {
  const found = instances.get(bb);
  if (found) return found;
  const created = createService(bb, tasks);
  instances.set(bb, created);
  return created;
}

const isConfirmed = (receipt: Receipt) => receipt.outcome === "appended" || receipt.outcome === "queued" || receipt.outcome === "inline";

function createService(bb: BbPluginApi, tasks: TasksStore) {
  const db = bb.storage.database();
  bb.onDispose(() => { instances.delete(bb); });

  // The scan and every drain run one at a time, so a row is never sent twice concurrently.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };

  /**
   * Each committed event becomes one notice row per destination: the card's active executors, plus the manager for the 24 h reminder. The
   * first expansion fixes the candidates (the linked threads and the manager at that time); a thread whose state cannot be read stays
   * pending and is the only thing a later drain looks up again, so nobody is added or replaced after the fact.
   */
  async function expand() {
    for (const event of unexpandedEvents(db)) {
      const first = event.candidates === null;
      const candidates = first ? linkedThreads(tasks, event.taskId) : event.candidates!;
      const manager = first && event.trigger === "24h" ? configuredManager(db, event.projectId) : null;
      const destinations = new Set<string>();
      const pending: string[] = [];
      for (const threadId of candidates) {
        const state = await threadActivity(bb, threadId);
        if (state === "active") destinations.add(threadId);
        else if (state === "unknown") pending.push(threadId);
      }
      if (manager) destinations.add(manager);
      // A thread already chosen for delivery (a linked manager whose lookup failed) is not also an outstanding lookup.
      const outstanding = pending.filter((threadId) => !destinations.has(threadId));
      if (outstanding.length) bb.log.warn(`Plan debt ${event.trigger} reminder of ${event.taskId}: could not read ${outstanding.join(", ")}; it will be retried`);
      expandEvent(db, event.episodeId, event.trigger, [...destinations], outstanding);
    }
  }

  const textOf = (notice: NoticeRow): string | null => {
    // The notice's own episode: a later episode of the same card never lends its details to an older row.
    const task = tasks.getTask(notice.taskId), debt = openEpisodeDebt(db, notice.episodeId);
    if (!task || !debt) return null;
    return planDebtNotice(task.key, debt, notice.trigger);
  };

  /** A row that may already have been written is never resent: it is searched for, and only a definite `failed` receipt is retried. */
  async function settle(notice: NoticeRow) {
    try {
      const cursor = notice.cursor ? (JSON.parse(notice.cursor) as HistoryCursor) : {};
      const { receipt, cursor: next } = await searchAttentionMarker(bb, notice.destination, notice.marker, notice.eventAt, cursor);
      // The pass is bounded: its progress is kept, so the next drain reads on instead of rereading the newest pages.
      setNoticeCursor(db, notice, JSON.stringify(next));
      if (receipt && isConfirmed(receipt)) setNotice(db, notice, "sent");
      // A miss, complete or not, stays unknown: the send may have succeeded inline and its marker may show up later.
      else if (notice.state === "sending") setNotice(db, notice, "unknown", { error: "Interrupted before the outcome was known" });
    } catch (error) {
      if (notice.state === "sending") setNotice(db, notice, "unknown", { error: errorMessage(error) });
    }
  }

  async function send(notice: NoticeRow) {
    const text = textOf(notice);
    if (text === null) return;
    setNotice(db, notice, "sending", { attempt: true });
    let receipt: Receipt;
    try {
      // Its own queue row, never appended to a notice (an answer, say) that is still queued; and only while this episode is still the one that is open.
      receipt = await deliverWithReceipt(bb, notice.destination, text, notice.marker, { fresh: true, guard: () => openEpisodeDebt(db, notice.episodeId) !== null });
    } catch (error) {
      // An exception after a possible write is never a failure: the marker search decides later.
      receipt = { outcome: "unknown", error: errorMessage(error) };
    }
    if (isConfirmed(receipt)) setNotice(db, notice, "sent");
    else if (receipt.outcome === "failed") setNotice(db, notice, "failed", { error: receipt.error });
    else setNotice(db, notice, "unknown", { error: receipt.outcome === "unknown" ? receipt.error : "Waiting for evidence that the message was accepted" });
  }

  const drainNow = async () => {
    await expand();
    // A row left in `sending` by a restart is treated as unknown.
    for (const notice of unsentNotices(db)) {
      if (notice.state === "unknown" || notice.state === "sending") await settle(notice);
      else await send(notice);
    }
  };

  /** Sends what the committed events and the 24 h due points owe; failures are logged, never thrown. */
  const drain = (): Promise<void> => exclusive(drainNow).catch((error) => bb.log.warn(`Plan debt reminders failed: ${errorMessage(error)}`));
  /** Repairs missed syncs, writes the 24 h due points and drains. Unresolved notices are logged on every pass. */
  const scan = (): Promise<void> =>
    exclusive(async () => {
      repairPlanDebt(db);
      writeDueReminders(db);
      await drainNow();
      for (const notice of unsentNotices(db)) if (notice.state !== "pending") bb.log.warn(`Plan debt notice ${notice.trigger} to ${notice.destination} is ${notice.state}${notice.lastError ? `: ${notice.lastError}` : ""}`);
    }).catch((error) => bb.log.warn(`Plan debt scan failed: ${errorMessage(error)}`));

  return { drain, scan, register: () => bb.background.schedule("plan-debt", "*/10 * * * *", scan) };
}
