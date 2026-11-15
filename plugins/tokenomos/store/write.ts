import type { Database } from "better-sqlite3";
import type { ApplyResult, SourceId, ThreadDtoLike, UsageRow } from "../contract";

export interface Store {
  applyRows(rows: UsageRow[]): ApplyResult;
  deleteContribution(threadId: string, source: SourceId, fromTs?: number): void;
  getCursor<T>(name: string): T | null;
  setCursor(name: string, value: unknown): void;
  noteThread(dto: ThreadDtoLike): void;
  dataVersion(): number;
}

const HOUR_MS = 3_600_000;
// Token components that roll up; `reasoning` is informational but tracked like the rest.
const COMPONENTS = ["fresh_in", "cache_read", "cache_write_short", "cache_write_long", "output", "reasoning"] as const;
type Component = (typeof COMPONENTS)[number];
type Tokens = Record<Component, number>;

const ROLLUP_ADD = COMPONENTS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ");
const COMPONENT_COLUMNS = COMPONENTS.join(", ");
const COMPONENT_PARAMS = COMPONENTS.map((c) => `@${c}`).join(", ");

const toMs = (value: string | number | null | undefined): number => {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const rowTokens = (row: UsageRow): Tokens => ({
  fresh_in: row.freshIn, cache_read: row.cacheRead, cache_write_short: row.cacheWriteShort,
  cache_write_long: row.cacheWriteLong, output: row.output, reasoning: row.reasoning,
});

export function createStore(db: Database): Store {
  let version = 0;

  const getRaw = db.prepare<[string], Tokens & { ts: number; thread_id: string; project_id: string; provider: string; model: string; tier: string; band: number }>(
    `SELECT ts, thread_id, project_id, provider, model, tier, band, ${COMPONENT_COLUMNS} FROM usage_raw WHERE key = ?`,
  );
  const insertRaw = db.prepare(
    `INSERT INTO usage_raw (key, ts, thread_id, project_id, provider, model, tier, tier_raw, prompt_tokens, band, conv,
       ${COMPONENT_COLUMNS}, turn_id, source, flags)
     VALUES (@key, @ts, @threadId, @projectId, @provider, @model, @tier, @tierRaw, @promptTokens, @band, @conv,
       ${COMPONENT_PARAMS}, @turnId, @source, @flags)`,
  );
  const updateRaw = db.prepare(
    `UPDATE usage_raw SET ${COMPONENTS.map((c) => `${c} = @${c}`).join(", ")},
       prompt_tokens = @fresh_in + @cache_read + @cache_write_short + @cache_write_long WHERE key = @key`,
  );
  const addHourly = db.prepare(
    `INSERT INTO usage_hourly (hour, provider, model, tier, band, project_id, thread_id, calls, ${COMPONENT_COLUMNS})
     VALUES (@hour, @provider, @model, @tier, @band, @projectId, @threadId, @calls, ${COMPONENT_PARAMS})
     ON CONFLICT (hour, provider, model, tier, band, project_id, thread_id)
     DO UPDATE SET calls = calls + excluded.calls, ${ROLLUP_ADD}`,
  );
  const addThread = db.prepare(
    `INSERT INTO thread_tokens (thread_id, model, tier, band, calls, ${COMPONENT_COLUMNS}, first_ts, last_ts)
     VALUES (@threadId, @model, @tier, @band, @calls, ${COMPONENT_PARAMS}, @ts, @ts)
     ON CONFLICT (thread_id, model, tier, band)
     DO UPDATE SET calls = calls + excluded.calls, ${ROLLUP_ADD},
       first_ts = MIN(first_ts, excluded.first_ts), last_ts = MAX(last_ts, excluded.last_ts)`,
  );
  const selectContribution = db.prepare<[string, string, number], Tokens & { key: string; ts: number; project_id: string; provider: string; model: string; tier: string; band: number }>(
    `SELECT key, ts, project_id, provider, model, tier, band, ${COMPONENT_COLUMNS}
     FROM usage_raw WHERE thread_id = ? AND source = ? AND ts >= ?`,
  );
  const deleteRaw = db.prepare(`DELETE FROM usage_raw WHERE key = ?`);

  /** Adds (or, with a negative sign, removes) one row's tokens to both rollups. */
  const roll = (
    dims: { ts: number; threadId: string; projectId: string; provider: string; model: string; tier: string; band: number },
    tokens: Tokens,
    calls: number,
  ) => {
    const params = { ...dims, ...tokens, calls, hour: Math.floor(dims.ts / HOUR_MS) * HOUR_MS };
    addHourly.run(params);
    if (dims.threadId !== "") addThread.run(params);
  };

  const apply = db.transaction((rows: UsageRow[]): ApplyResult => {
    const touched = new Set<string>();
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const old = getRaw.get(row.key);
      if (!old) {
        insertRaw.run({ ...row, ...rowTokens(row), turnId: row.turnId ?? "" });
        roll(row, rowTokens(row), 1);
        inserted++;
        if (row.threadId !== "") touched.add(row.threadId);
        continue;
      }
      // Last snapshot wins, but a component never decreases: a smaller snapshot changes nothing.
      const next = rowTokens(row);
      const delta = {} as Tokens;
      const merged = {} as Tokens;
      let changed = false;
      for (const c of COMPONENTS) {
        merged[c] = Math.max(old[c], next[c]);
        delta[c] = merged[c] - old[c];
        if (delta[c] > 0) changed = true;
      }
      if (!changed) continue;
      updateRaw.run({ key: row.key, ...merged });
      // Rollups use the stored row's dimensions so they stay consistent with usage_raw.
      roll({ ts: old.ts, threadId: old.thread_id, projectId: old.project_id, provider: old.provider, model: old.model, tier: old.tier, band: old.band }, delta, 0);
      updated++;
      if (old.thread_id !== "") touched.add(old.thread_id);
    }
    return { inserted, updated, touchedThreads: [...touched] };
  });

  const deleteTx = db.transaction((threadId: string, source: SourceId, fromTs: number): number => {
    const rows = selectContribution.all(threadId, source, fromTs);
    for (const r of rows) {
      const negated = {} as Tokens;
      for (const c of COMPONENTS) negated[c] = -r[c];
      roll({ ts: r.ts, threadId, projectId: r.project_id, provider: r.provider, model: r.model, tier: r.tier, band: r.band }, negated, -1);
      deleteRaw.run(r.key);
    }
    return rows.length;
  });

  const readCursor = db.prepare<[string], { value: string }>(`SELECT value FROM cursor WHERE name = ?`);
  const writeCursor = db.prepare(
    `INSERT INTO cursor (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
  );
  const upsertThread = db.prepare(
    `INSERT INTO threads (id, project_id, provider_id, parent_id, lifecycle_owner_id, source_thread_id, title, created_at, archived_at, deleted_at)
     VALUES (@id, @projectId, @providerId, @parentId, @lifecycleOwnerId, @sourceThreadId, @title, @createdAt, @archivedAt, @deletedAt)
     ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, provider_id = excluded.provider_id,
       parent_id = excluded.parent_id, lifecycle_owner_id = excluded.lifecycle_owner_id,
       source_thread_id = excluded.source_thread_id, title = excluded.title, created_at = excluded.created_at,
       archived_at = excluded.archived_at, deleted_at = excluded.deleted_at`,
  );

  return {
    applyRows(rows) {
      const result = apply(rows);
      if (result.inserted || result.updated) version++;
      return result;
    },
    deleteContribution(threadId, source, fromTs = 0) {
      if (deleteTx(threadId, source, fromTs)) version++;
    },
    getCursor<T>(name: string): T | null {
      const row = readCursor.get(name);
      return row ? (JSON.parse(row.value) as T) : null;
    },
    setCursor(name, value) {
      writeCursor.run(name, JSON.stringify(value ?? null));
    },
    noteThread(dto) {
      upsertThread.run({
        id: dto.id,
        projectId: dto.projectId ?? "",
        providerId: dto.providerId ?? "",
        parentId: dto.parentThreadId ?? "",
        lifecycleOwnerId: dto.lifecycleOwnerThreadId ?? "",
        sourceThreadId: dto.sourceThreadId ?? "",
        title: dto.title || dto.titleFallback || "",
        createdAt: toMs(dto.createdAt),
        archivedAt: toMs(dto.archivedAt),
        deletedAt: toMs(dto.deletedAt),
      });
      version++;
    },
    dataVersion: () => version,
  };
}
