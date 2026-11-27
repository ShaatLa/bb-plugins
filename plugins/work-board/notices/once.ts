import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createUlid } from "../db/store";
import { managerOf } from "../queue/store";
import { errorMessage } from "../shared/errors";
import { deliverWithReceipt, firstReachable, searchAttentionMarker, type HistoryCursor, type Receipt } from "../steer";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export type NoticeState = "pending" | "sending" | "sent" | "unknown" | "unknown_on_card" | "failed_on_card" | "on_card";
/** The columns the delivery below reads; a notice table adds its own fields and names its key and ordering columns. */
export type NoticeRow = {
  project_id: string; task_id: string; task_key: string; setter: string;
  state: NoticeState; attempts: number; recipient: string | null; attempted_at: string | null; next_at: string | null; cursor: string | null; last_error: string | null;
} & Record<string, string | number | null>;
/** A notice that cannot be confirmed this long after the attempt is also written on the card. */
export const SURFACE_AFTER_MS = 60 * 60_000;
const BACKOFF_START_MS = 60_000, BACKOFF_CAP_MS = 60 * 60_000, CARD_AFTER_FAILURES = 3;
const isConfirmed = (receipt: Receipt) => receipt.outcome === "appended" || receipt.outcome === "queued" || receipt.outcome === "inline";

/** Why this recipient and not the setter; empty when it is the setter. */
export type Why = "" | "archived" | "none" | "owner";

export interface OnceNotices<Row extends NoticeRow> {
  table: string;
  /** Primary key column of the table. */
  key: string;
  /** A timestamp column the rows are drained in order of; the search of an unattempted row starts there. */
  order: string;
  /** What the notices are called in log lines. */
  label: string;
  marker(row: Row): string;
  text(db: Database, row: Row, why: Why): string;
}

export function cardComment(db: Database, taskId: string, text: string, at: string) {
  db.prepare<[string, string, string, string]>("INSERT INTO comments(id, task_id, kind, author_name, body, created_at) VALUES (?, ?, 'system', 'Work Board', ?, ?)").run(createUlid(), taskId, text, at);
}

/**
 * At-most-once delivery of one notice per row to the setter, else its nearest live ancestor, else the project's manager, else the card.
 * A row is claimed before the write, a row that may have been written is searched for and never resent, and an unconfirmed one is
 * shown on the card after an hour.
 */
export function createOnceNotices<Row extends NoticeRow>(config: OnceNotices<Row>): (bb: BbPluginApi) => Promise<void> {
  const { table, key, order, label } = config;
  const update = (db: Database, row: Row, fields: Partial<NoticeRow>) => {
    const keys = Object.keys(fields);
    db.prepare<(string | number | null)[]>(`UPDATE ${table} SET ${keys.map(column => `${column}=?`).join(",")} WHERE ${key}=?`).run(...keys.map(column => fields[column] as string | number | null), row[key] as string);
    Object.assign(row, fields);
  };

  /** The setter, else the nearest live ancestor, else the project's manager; undefined when no thread can take it. Throws when a read fails. */
  async function resolveRecipient(bb: BbPluginApi, db: Database, row: Row): Promise<{ threadId: string; why: Why } | undefined> {
    if (row.setter !== "owner") {
      const found = await firstReachable(bb, [row.setter], {}, true);
      if (found) return { threadId: found, why: found === row.setter ? "" : "archived" };
    }
    const manager = managerOf(db, row.project_id);
    const found = manager ? await firstReachable(bb, [manager], {}, true) : undefined;
    return found ? { threadId: found, why: row.setter === "owner" ? "owner" : "none" } : undefined;
  }

  async function send(bb: BbPluginApi, db: Database, row: Row) {
    let recipient: Awaited<ReturnType<typeof resolveRecipient>>;
    try { recipient = await resolveRecipient(bb, db, row); } catch (error) {
      // A transient read failure proves nothing was sent: wait a minute and look again.
      update(db, row, { last_error: errorMessage(error), next_at: new Date(Date.now() + BACKOFF_START_MS).toISOString() });
      return;
    }
    if (!recipient) {
      // Nobody to tell: the card is the only place left, written once.
      db.transaction(() => {
        cardComment(db, row.task_id, `${config.text(db, row, "none")} No live thread could be told, so this is written here.`, new Date().toISOString());
        update(db, row, { state: "on_card", last_error: null, next_at: null });
      })();
      return;
    }
    const text = config.text(db, row, recipient.why), before = row.state, at = new Date().toISOString();
    // Claimed before the write: from here a row that may have been written is never sent again.
    update(db, row, { state: "sending", attempts: row.attempts + 1, recipient: recipient.threadId, attempted_at: at, next_at: null, last_error: null, cursor: null });
    let receipt: Receipt;
    try { receipt = await deliverWithReceipt(bb, recipient.threadId, text, config.marker(row), { fresh: true }); } catch (error) {
      receipt = { outcome: "unknown", error: errorMessage(error) };
    }
    if (isConfirmed(receipt)) { update(db, row, { state: "sent" }); return; }
    if (receipt.outcome !== "failed") { update(db, row, { state: "unknown", last_error: receipt.outcome === "unknown" ? receipt.error : "Waiting for evidence that the message was accepted" }); return; }
    const wait = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** (row.attempts - 1));
    db.transaction(() => {
      const surface = row.attempts >= CARD_AFTER_FAILURES && before !== "failed_on_card";
      if (surface) {
        bb.log.warn(`${label} for ${row.task_key} failed ${row.attempts} times: ${receipt.error}`);
        cardComment(db, row.task_id, `${text} Delivery to ${recipient.threadId} failed ${row.attempts} times (${receipt.error}); it is still being retried.`, new Date().toISOString());
      }
      update(db, row, { state: surface || before === "failed_on_card" ? "failed_on_card" : "pending", last_error: receipt.error, next_at: new Date(Date.now() + wait).toISOString() });
    })();
  }

  /** A row that may have been written is searched for, never resent; a row nobody can confirm after an hour is shown on the card. */
  async function reconcile(bb: BbPluginApi, db: Database, row: Row) {
    try {
      const cursor = row.cursor ? (JSON.parse(row.cursor) as HistoryCursor) : {};
      const { receipt, cursor: next } = await searchAttentionMarker(bb, row.recipient!, config.marker(row), row.attempted_at ?? (row[order] as string), cursor);
      update(db, row, { cursor: JSON.stringify(next) });
      if (receipt && isConfirmed(receipt)) { update(db, row, { state: "sent" }); return; }
    } catch (error) {
      update(db, row, { last_error: errorMessage(error) });
    }
    if (row.state === "sending") update(db, row, { state: "unknown", last_error: row.last_error ?? "Interrupted before the outcome was known" });
    if (row.state === "unknown" && Date.now() - Date.parse(row.attempted_at ?? (row[order] as string)) >= SURFACE_AFTER_MS) {
      db.transaction(() => {
        cardComment(db, row.task_id, `${config.text(db, row, "")} Sent to ${row.recipient}. Delivery could not be confirmed; check that thread.`, new Date().toISOString());
        update(db, row, { state: "unknown_on_card" });
      })();
    }
  }

  const queues = new WeakMap<BbPluginApi, Promise<unknown>>();
  /** Sends what the table owes. One pass at a time, so a row is never claimed twice; failures are logged, never thrown. */
  return (bb) => {
    const db = bb.storage.database();
    const run = (queues.get(bb) ?? Promise.resolve()).then(async () => {
      const rows = db.prepare<[], Row>(`SELECT * FROM ${table} WHERE state IN ('pending','failed_on_card','sending','unknown','unknown_on_card') ORDER BY ${order}, ${key}`).all();
      for (const row of rows) {
        try {
          // Nothing runs concurrently, so a `sending` row is one a restart interrupted.
          if (row.state === "pending" || row.state === "failed_on_card") { if (!row.next_at || row.next_at <= new Date().toISOString()) await send(bb, db, row); }
          else await reconcile(bb, db, row);
        } catch (error) {
          bb.log.warn(`${label} ${String(row[key])} failed: ${errorMessage(error)}`);
        }
      }
    }).catch((error: unknown) => bb.log.warn(`${label}s failed: ${errorMessage(error)}`));
    queues.set(bb, run);
    return run;
  };
}
