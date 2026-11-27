import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createUlid } from "../db/store";
import { managerOf } from "../queue/store";
import { errorMessage } from "../shared/errors";
import { taskMarkdownLink } from "../shared/task-link";
import { deliverWithReceipt, firstReachable, searchAttentionMarker, type HistoryCursor, type Receipt } from "../steer";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type State = "pending" | "sending" | "sent" | "unknown" | "unknown_on_card" | "failed_on_card" | "on_card";
interface NoticeRow {
  pause_id: string; project_id: string; task_id: string; task_key: string; setter: string; reason: string; started_at: string; until: string; expired_at: string;
  state: State; attempts: number; recipient: string | null; attempted_at: string | null; next_at: string | null; cursor: string | null; last_error: string | null;
}
/** A notice that cannot be confirmed this long after the attempt is also written on the card. */
export const SURFACE_AFTER_MS = 60 * 60_000;
const BACKOFF_START_MS = 60_000, BACKOFF_CAP_MS = 60 * 60_000, CARD_AFTER_FAILURES = 3;
const markerOf = (pauseId: string) => `<!-- work-board-pause-expiry:${pauseId} -->`;
const isConfirmed = (receipt: Receipt) => receipt.outcome === "appended" || receipt.outcome === "queued" || receipt.outcome === "inline";

function cardComment(db: Database, row: NoticeRow, text: string, at: string) {
  db.prepare<[string, string, string, string]>("INSERT INTO comments(id, task_id, kind, author_name, body, created_at) VALUES (?, ?, 'system', 'Work Board', ?, ?)").run(createUlid(), row.task_id, text, at);
}
function update(db: Database, row: NoticeRow, fields: Partial<NoticeRow>) {
  const keys = Object.keys(fields) as (keyof NoticeRow)[];
  db.prepare<(string | number | null)[]>(`UPDATE pause_expiry_notices SET ${keys.map(key => `${key}=?`).join(",")} WHERE pause_id=?`).run(...keys.map(key => fields[key] as string | number | null), row.pause_id);
  Object.assign(row, fields);
}

/** Why this recipient and not the setter; empty when it is the setter. */
type Why = "" | "archived" | "none" | "owner";
function noticeText(db: Database, row: NoticeRow, why: Why): string {
  const others = [...new Set(db.prepare<[string], { signal: string }>("SELECT signal FROM task_pauses WHERE task_id=? AND applied=1").all(row.task_id).map(other => other.signal))];
  return [
    `The manual pause on ${taskMarkdownLink(row.task_key)} expired at ${row.until}. It waited for: ${row.reason}. Set by ${row.setter} at ${row.started_at}.`,
    others.length ? `Other pauses on the card are still active: ${others.join(", ")}.` : "",
    why === "archived" ? `You get this because ${row.setter} is archived or gone.` : why === "none" ? `You get this because ${row.setter} is archived or gone and no live parent was found.` : why === "owner" ? "You get this because the pause was set by the owner, not by a thread." : "",
  ].filter(Boolean).join(" ");
}

/** The setter, else the nearest live ancestor, else the project's manager; undefined when no thread can take it. Throws when a read fails. */
async function resolveRecipient(bb: BbPluginApi, db: Database, row: NoticeRow): Promise<{ threadId: string; why: Why } | undefined> {
  if (row.setter !== "owner") {
    const found = await firstReachable(bb, [row.setter], {}, true);
    if (found) return { threadId: found, why: found === row.setter ? "" : "archived" };
  }
  const manager = managerOf(db, row.project_id);
  const found = manager ? await firstReachable(bb, [manager], {}, true) : undefined;
  return found ? { threadId: found, why: row.setter === "owner" ? "owner" : "none" } : undefined;
}

async function send(bb: BbPluginApi, db: Database, row: NoticeRow) {
  let recipient: Awaited<ReturnType<typeof resolveRecipient>>;
  try { recipient = await resolveRecipient(bb, db, row); } catch (error) {
    // A transient read failure proves nothing was sent: wait a minute and look again.
    update(db, row, { last_error: errorMessage(error), next_at: new Date(Date.now() + BACKOFF_START_MS).toISOString() });
    return;
  }
  if (!recipient) {
    // Nobody to tell: the card is the only place left, written once.
    db.transaction(() => {
      cardComment(db, row, `${noticeText(db, row, "none")} No live thread could be told, so this is written here.`, new Date().toISOString());
      update(db, row, { state: "on_card", last_error: null, next_at: null });
    })();
    return;
  }
  const text = noticeText(db, row, recipient.why), before = row.state, at = new Date().toISOString();
  // Claimed before the write: from here a row that may have been written is never sent again.
  update(db, row, { state: "sending", attempts: row.attempts + 1, recipient: recipient.threadId, attempted_at: at, next_at: null, last_error: null, cursor: null });
  let receipt: Receipt;
  try { receipt = await deliverWithReceipt(bb, recipient.threadId, text, markerOf(row.pause_id), { fresh: true }); } catch (error) {
    receipt = { outcome: "unknown", error: errorMessage(error) };
  }
  if (isConfirmed(receipt)) { update(db, row, { state: "sent" }); return; }
  if (receipt.outcome !== "failed") { update(db, row, { state: "unknown", last_error: receipt.outcome === "unknown" ? receipt.error : "Waiting for evidence that the message was accepted" }); return; }
  const wait = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** (row.attempts - 1));
  db.transaction(() => {
    const surface = row.attempts >= CARD_AFTER_FAILURES && before !== "failed_on_card";
    if (surface) {
      bb.log.warn(`Pause expiry notice for ${row.task_key} failed ${row.attempts} times: ${receipt.error}`);
      cardComment(db, row, `${text} Delivery to ${recipient.threadId} failed ${row.attempts} times (${receipt.error}); it is still being retried.`, new Date().toISOString());
    }
    update(db, row, { state: surface || before === "failed_on_card" ? "failed_on_card" : "pending", last_error: receipt.error, next_at: new Date(Date.now() + wait).toISOString() });
  })();
}

/** A row that may have been written is searched for, never resent; a row nobody can confirm after an hour is shown on the card. */
async function reconcile(bb: BbPluginApi, db: Database, row: NoticeRow) {
  try {
    const cursor = row.cursor ? (JSON.parse(row.cursor) as HistoryCursor) : {};
    const { receipt, cursor: next } = await searchAttentionMarker(bb, row.recipient!, markerOf(row.pause_id), row.attempted_at ?? row.expired_at, cursor);
    update(db, row, { cursor: JSON.stringify(next) });
    if (receipt && isConfirmed(receipt)) { update(db, row, { state: "sent" }); return; }
  } catch (error) {
    update(db, row, { last_error: errorMessage(error) });
  }
  if (row.state === "sending") update(db, row, { state: "unknown", last_error: row.last_error ?? "Interrupted before the outcome was known" });
  if (row.state === "unknown" && Date.now() - Date.parse(row.attempted_at ?? row.expired_at) >= SURFACE_AFTER_MS) {
    db.transaction(() => {
      cardComment(db, row, `${noticeText(db, row, "")} Sent to ${row.recipient}. Delivery could not be confirmed; check that thread.`, new Date().toISOString());
      update(db, row, { state: "unknown_on_card" });
    })();
  }
}

const queues = new WeakMap<BbPluginApi, Promise<unknown>>();
/** Sends what the expired manual pauses owe. One pass at a time, so a row is never claimed twice; failures are logged, never thrown. */
export function drainPauseExpiryNotices(bb: BbPluginApi): Promise<void> {
  const db = bb.storage.database();
  const run = (queues.get(bb) ?? Promise.resolve()).then(async () => {
    const rows = db.prepare<[], NoticeRow>("SELECT * FROM pause_expiry_notices WHERE state IN ('pending','failed_on_card','sending','unknown','unknown_on_card') ORDER BY expired_at, pause_id").all();
    for (const row of rows) {
      try {
        // Nothing runs concurrently, so a `sending` row is one a restart interrupted.
        if (row.state === "pending" || row.state === "failed_on_card") { if (!row.next_at || row.next_at <= new Date().toISOString()) await send(bb, db, row); }
        else await reconcile(bb, db, row);
      } catch (error) {
        bb.log.warn(`Pause expiry notice ${row.pause_id} failed: ${errorMessage(error)}`);
      }
    }
  }).catch((error: unknown) => bb.log.warn(`Pause expiry notices failed: ${errorMessage(error)}`));
  queues.set(bb, run);
  return run;
}
