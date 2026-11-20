import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { configuredManager } from "../attention/modes";
import type { TasksStore } from "../db";
import { activeExecutors } from "../plans/notice";
import { errorMessage } from "../shared/errors";
import { planDebtNotice } from "../shared/plan-debt";
import { deliverWithReceipt, searchAttentionMarker, type Receipt } from "../steer";
import { expandEvent, openPlanDebt, repairPlanDebt, setNotice, unexpandedEvents, unsentNotices, writeDueReminders, type NoticeRow } from "./store";

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

  /** Each committed event becomes one notice row per destination: the card's active executors, plus the manager for the 24 h reminder. */
  async function expand() {
    for (const event of unexpandedEvents(db)) {
      const destinations = new Set(await activeExecutors(bb, tasks, event.taskId));
      const manager = event.trigger === "24h" ? configuredManager(db, event.projectId) : null;
      if (manager) destinations.add(manager);
      expandEvent(db, event.episodeId, event.trigger, [...destinations]);
    }
  }

  const textOf = (notice: NoticeRow): string | null => {
    const task = tasks.getTask(notice.taskId), debt = openPlanDebt(db, notice.taskId);
    if (!task || !debt) return null;
    // A manager that is also an executor of the card gets the executor's text.
    const executor = tasks.listTaskThreads(task.id).some((link) => link.threadId === notice.destination);
    return planDebtNotice(task.key, debt, notice.trigger, notice.trigger === "24h" && !executor);
  };

  /** A row that may already have been written is never resent: it is searched for, and only a definite `failed` receipt is retried. */
  async function settle(notice: NoticeRow) {
    try {
      const { receipt } = await searchAttentionMarker(bb, notice.destination, notice.marker, notice.eventAt);
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
      receipt = await deliverWithReceipt(bb, notice.destination, text, notice.marker);
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
