import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const transferFormat = 'bb-runner-state/1';
export const chunkBytes = 262144;
const maxBytes = 268435456;
const baseline = z.object({ fingerprint: z.string().min(1), manager: z.string().optional() }).strict();
// Twin of transferDocument in plugins/work-board/checks/transfer.ts: keep the two schemas identical.
export const transferDocument = z.object({
  format: z.literal(transferFormat),
  from: z.enum(['sweep', 'work-board']),
  bbProjectId: z.string().min(1),
  handoffId: z.string().min(1),
  previous: z.string().min(1).nullable(),
  exportedAt: z.string().min(1),
  committed: z.object({ size: z.number().int().min(0).max(maxBytes), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().nullable(),
  lastReport: baseline.extend({ at: z.number(), changes: z.object({ noteworthy: z.array(z.string()), waiting: z.string() }).strict().optional() }).strict().optional(),
  lastFailure: baseline.optional(),
  reportedWorktrees: z.array(z.string()),
  lastMeasuredWorktree: z.string().optional(),
}).strict();
export type TransferDocument = z.infer<typeof transferDocument>;
export const chunkOutput = z.object({ data: z.string(), end: z.boolean() }).strict();
export const ownershipOutput = z.object({ owner: z.enum(['sweep', 'work-board']).nullable(), trackerId: z.string().nullable(), sentId: z.string().nullable(), sentConfirmed: z.boolean(), receivedId: z.string().nullable(), transferring: z.boolean() });

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** One chunk of at most chunkBytes, as base64; `end` is set when no byte follows it. */
export function readChunk(bytes: Buffer, offset: number) {
  const slice = bytes.subarray(offset, offset + chunkBytes);
  return { data: slice.toString('base64'), end: offset + slice.length >= bytes.length };
}

/** Pulls the committed bytes chunk by chunk and accepts them only when size and sha256 match the document. */
export async function pullBytes(document: TransferDocument, fetchChunk: (offset: number) => Promise<z.infer<typeof chunkOutput>>): Promise<Buffer | null> {
  if (!document.committed) return null;
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const { data, end } = await fetchChunk(offset);
    const part = Buffer.from(data, 'base64');
    parts.push(part);
    offset += part.length;
    if (offset > document.committed.size) throw new Error('The sender returned more bytes than the document declares.');
    if (end) break;
    if (!part.length) throw new Error('The sender returned an empty chunk before the end.');
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== document.committed.size || sha256(bytes) !== document.committed.sha256) throw new Error('The transferred bytes do not match the size and sha256 of the document.');
  return bytes;
}

/** The handoff pulled from Work Board and held until Work Board's row names Sweep as the owner. */
export function incomingStore(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS transfer_incoming (project TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, document TEXT NOT NULL, bytes BLOB)');
  return {
    read: (project: string) => db.prepare('SELECT handoff_id, document, bytes FROM transfer_incoming WHERE project = ?').get(project) as { handoff_id: string; document: string; bytes: Buffer | null } | undefined,
    put: (project: string, handoffId: string, document: TransferDocument, bytes: Buffer | null) => { db.prepare('INSERT INTO transfer_incoming (project, handoff_id, document, bytes) VALUES (?, ?, ?, ?)').run(project, handoffId, JSON.stringify(document), bytes); },
    /** True for exactly one caller: the one whose DELETE removed the row. */
    take: (project: string, handoffId: string) => db.prepare('DELETE FROM transfer_incoming WHERE project = ? AND handoff_id = ?').run(project, handoffId).changes === 1,
  };
}
