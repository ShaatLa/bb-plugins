import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { historyDays, projectInput } from './overview-contract.ts';
import { summaryLine } from './reports.ts';

const modeOutput = z.object({ projectId: z.string(), trackerId: z.string().min(1).nullish(), kinds: z.object({
  'stale-status': z.object({ effective: z.object({ mode: z.enum(['off', 'shadow', 'live']), generation: z.number().int().nonnegative() }) }).optional(),
}) });
export type ShadowRun = { trackerId: string; generation: number };
const keyOutput = z.object({ resolved: z.record(z.string(), z.string().min(1)), unknown: z.array(z.string()) });
const flagLine = /^ACTION stale-status ([A-Z][A-Z0-9_-]*-\d+): [\w-]+, board flags ([\w-]+(?:, [\w-]+)*)$/;
const findingSchema = z.object({ taskKey: z.string(), taskId: z.string().nullable(), signal: z.string() });
const receiptSchema = z.object({ mode: z.enum(['inline', 'queued', 'appended', 'notice']), destination: z.string(), id: z.string().optional() });
type Receipt = z.infer<typeof receiptSchema>;
const rowSchema = z.object({
  tickId: z.string(), at: z.number(), scanStartedAt: z.number().nullable(), trackerId: z.string(), generation: z.number(),
  issues: z.array(z.string()), findings: z.array(findingSchema),
  stagedAt: z.number().nullable(), acceptedAt: z.number().nullable(), receipt: receiptSchema.nullable(),
});

export const attentionObservations = {
  experimental_description: 'Read scheduled stale-status shadow observations, data gaps and accepted report receipts. Pass since as Unix milliseconds and reuse nextCursor to advance one page.',
  input: projectInput.extend({ since: z.number().int().nonnegative(), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(25) }),
  output: z.object({ observations: z.array(rowSchema), nextCursor: z.number().nullable() }),
};

export function attentionStore(db: Database.Database, bb: BbPluginApi, signal: AbortSignal) {
  db.exec(`CREATE TABLE IF NOT EXISTS sweep_attention_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, tick TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL, scan_started_at INTEGER, tracker_id TEXT NOT NULL, generation INTEGER NOT NULL,
    issues TEXT NOT NULL, findings TEXT NOT NULL,
    staged_at INTEGER, accepted_at INTEGER, receipt TEXT
  );
  CREATE INDEX IF NOT EXISTS sweep_attention_project ON sweep_attention_observations (project, sequence);
  CREATE INDEX IF NOT EXISTS sweep_attention_time ON sweep_attention_observations (at);`);
  const record = db.prepare('INSERT INTO sweep_attention_observations (project, tick, at, scan_started_at, tracker_id, generation, issues, findings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const stage = db.prepare('UPDATE sweep_attention_observations SET staged_at = ? WHERE tick = ?');
  const accept = db.prepare('UPDATE sweep_attention_observations SET accepted_at = ?, receipt = ? WHERE tick = ? AND staged_at IS NOT NULL');
  const page = db.prepare<[string, number, number, number], Omit<z.infer<typeof rowSchema>, 'issues' | 'findings' | 'receipt'> & { sequence: number; issues: string; findings: string; receipt: string | null }>(`
    SELECT sequence, tick AS tickId, at, scan_started_at AS scanStartedAt, tracker_id AS trackerId, generation,
      issues, findings, staged_at AS stagedAt, accepted_at AS acceptedAt, receipt
    FROM sweep_attention_observations WHERE project = ? AND at >= ? AND sequence > ? ORDER BY sequence LIMIT ?`);
  const prune = db.prepare('DELETE FROM sweep_attention_observations WHERE at < ? AND (staged_at IS NULL OR accepted_at IS NOT NULL)');
  const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(3000)]);

  function capture(projectId: string, tickId: string, shadow: ShadowRun, at: number, scanStartedAt: number | null, issues: string[], findings: z.infer<typeof findingSchema>[]) {
    record.run(projectId, tickId, at, scanStartedAt, shadow.trackerId, shadow.generation, JSON.stringify(issues), JSON.stringify(findings));
  }

  return {
    async shadowMode(projectId: string): Promise<ShadowRun | null | undefined> {
      try {
        const result = await bb.sdk.plugins.callRpc({ pluginId: 'work-board', method: 'attention.modes', input: { projectId }, outputSchema: modeOutput, signal: deadline() });
        if (result.projectId !== projectId) return undefined;
        const effective = result.kinds['stale-status']?.effective;
        if (effective?.mode !== 'shadow') return null;
        return result.trackerId ? { trackerId: result.trackerId, generation: effective.generation } : undefined;
      } catch { return undefined; }
    },
    async observe(projectId: string, tickId: string, shadow: ShadowRun, scanStartedAt: number, output: string, issues: string[]) {
      const at = Date.now();
      const findings = new Map<string, z.infer<typeof findingSchema>>();
      const errors = new Set(issues);
      const lines = output.split(/\r?\n/);
      if (!lines.some(line => summaryLine.test(line))) errors.add('missing-sweep-summary');
      for (const line of lines) {
        if (!/^ACTION stale-status(?:\s|$)/.test(line)) continue;
        const parsed = flagLine.exec(line);
        if (!parsed) { errors.add('malformed-stale-status'); continue; }
        const [, taskKey, flags] = parsed;
        for (const flag of flags.split(', ')) findings.set(`${taskKey}:${flag}`, { taskKey, taskId: null, signal: flag });
      }
      const keys = [...new Set([...findings.values()].map(({ taskKey }) => taskKey))];
      if (keys.length) {
        try {
          const { resolved, unknown } = await bb.sdk.plugins.callRpc({ pluginId: 'work-board', method: 'attention.resolveKeys', input: { projectId, keys }, outputSchema: keyOutput, signal: deadline() });
          const unknownKeys = new Set(unknown);
          for (const finding of findings.values()) {
            const { taskKey } = finding;
            if (!unknownKeys.has(taskKey) && Object.hasOwn(resolved, taskKey)) finding.taskId = resolved[taskKey];
            else errors.add('unresolved-task-key');
          }
        } catch { errors.add('key-resolution-unavailable'); }
      }
      capture(projectId, tickId, shadow, at, scanStartedAt, [...errors], [...findings.values()]);
    },
    gap(projectId: string, tickId: string, shadow: ShadowRun, issues: string[]) { capture(projectId, tickId, shadow, Date.now(), null, issues, []); },
    stage(tickId: string, at: number) { stage.run(at, tickId); },
    accept(tickId: string, at: number, receipt: Receipt) { accept.run(at, JSON.stringify(receipt), tickId); },
    prune(now: number) { prune.run(now - historyDays * 86400000); },
    read({ projectId, since, cursor, limit }: z.infer<typeof attentionObservations.input>) {
      const rows = page.all(projectId, since, cursor, limit + 1);
      return {
        observations: rows.slice(0, limit).map(({ sequence: _, issues, findings, receipt, ...row }) => ({
          ...row, issues: JSON.parse(issues), findings: JSON.parse(findings), receipt: receipt === null ? null : JSON.parse(receipt),
        })),
        nextCursor: rows.length > limit ? rows[limit - 1].sequence : null,
      };
    },
  };
}
