// Call commit() in the same transaction immediately after applying the returned rows.
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type { Database } from "better-sqlite3";
import type { UsageRow } from "../contract";

export type ThreadInfo = { threadId: string; providerThreadId: string | null; provider: string; projectId: string; createdAt: number; isFork: boolean; cwd: string | null };
export type Batch = { rows: UsageRow[]; parseErrors: number; commit(): void };
export interface FileSource {
  locate(t: ThreadInfo): Promise<boolean>;
  flushThread(t: ThreadInfo): Promise<Batch>;
  scanOutside(knownSessions: Set<string>, sinceTs: number): Promise<{ rows: UsageRow[]; commit(): void }>;
}
type Cursor = { path: string; inode: number; size: number; mtime: number; offset: number; head_hash: string; watermark_ts: number; thread_id: string; root_session: string };
export function readFile(db: Database, path: string, t: ThreadInfo, parse: (line: any) => UsageRow | null, move = false): Batch {
  const st = statSync(path);
  let old = db.prepare('SELECT *, "offset" AS offset FROM file_cursor WHERE path = ?').get(path) as Cursor | undefined;
  if (!old && move) {
    const candidates = db.prepare('SELECT *, "offset" AS offset FROM file_cursor WHERE root_session = ?').all(t.providerThreadId ?? "") as Cursor[];
    old = candidates.find(c => basename(c.path) === basename(path) && !existsSync(c.path));
  }
  if (old?.path === path && old.inode === st.ino && old.size === st.size && old.mtime === Math.trunc(st.mtimeMs * 1000)) {
    return { rows: [], parseErrors: 0, commit() {} };
  }
  const fd = openSync(path, "r");
  try {
    const hash = (length: number) => {
      const b = Buffer.alloc(Math.min(length, 4096));
      const n = readSync(fd, b, 0, b.length, 0);
      return createHash("sha1").update(b.subarray(0, n)).digest("hex");
    };
    const sameHead = !old || hash(old.size) === old.head_hash;
    const moved = old && old.path !== path && st.size >= old.offset && sameHead;
    const reset = !!old && (st.size < old.offset || (!moved && old.inode !== st.ino) || !sameHead);
    const offset = old && !reset ? old.offset : 0;
    const bytes = Buffer.alloc(Math.max(0, st.size - offset));
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    const end = bytes.subarray(0, count).lastIndexOf(10) + 1;
    const lines = bytes.subarray(0, end).toString("utf8").split("\n");
    const watermark = old?.watermark_ts ?? 0;
    let max = watermark, parseErrors = 0;
    const rows = new Map<string, UsageRow>();
    const exists = db.prepare('SELECT 1 FROM usage_raw WHERE key = ?');
    for (const text of lines.slice(0, -1)) {
      let line: any;
      try { line = JSON.parse(text); } catch { parseErrors++; continue; }
      const row = parse(line);
      if (!row || !Number.isFinite(row.ts) || (t.isFork && row.ts < t.createdAt)) continue;
      if (row.ts <= watermark && !exists.get(row.key) && !rows.has(row.key)) continue;
      rows.set(row.key, row); max = Math.max(max, row.ts);
    }
    const head = hash(st.size);
    return { rows: [...rows.values()], parseErrors, commit() {
      if (old && moved) db.prepare('DELETE FROM file_cursor WHERE path = ?').run(old.path);
      db.prepare(`INSERT INTO file_cursor (path,inode,size,mtime,"offset",head_hash,watermark_ts,thread_id,root_session)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET inode=excluded.inode,size=excluded.size,mtime=excluded.mtime,
        "offset"=excluded."offset",head_hash=excluded.head_hash,watermark_ts=excluded.watermark_ts,thread_id=excluded.thread_id,root_session=excluded.root_session`)
        .run(path, st.ino, st.size, Math.trunc(st.mtimeMs * 1000), offset + end, head, max, t.threadId, t.providerThreadId ?? "");
    } };
  } finally { closeSync(fd); }
}
export function combine(batches: Batch[]): Batch {
  return { rows: batches.flatMap(b => b.rows), parseErrors: batches.reduce((n, b) => n + b.parseErrors, 0), commit() { for (const b of batches) b.commit(); } };
}
export const outsideThread = (id: string, provider: string): ThreadInfo => ({ threadId: "", providerThreadId: id, provider, projectId: "~outside", createdAt: 0, isFork: false, cwd: null });
