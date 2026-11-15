// Append-only: never reorder or edit shipped statements (bb.storage.migrate hashes them).
// Dimension columns are NOT NULL DEFAULT '' / 0 so composite primary keys never hold NULL.
const rollupTokens = `
  calls INTEGER NOT NULL DEFAULT 0,
  fresh_in INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write_short INTEGER NOT NULL DEFAULT 0,
  cache_write_long INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0`;

const rawColumns = `
  key TEXT NOT NULL PRIMARY KEY,
  ts INTEGER NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'unknown',
  tier TEXT NOT NULL DEFAULT 'standard',
  tier_raw TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  band INTEGER NOT NULL DEFAULT 0,
  conv TEXT NOT NULL DEFAULT '',
  fresh_in INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write_short INTEGER NOT NULL DEFAULT 0,
  cache_write_long INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  turn_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  flags INTEGER NOT NULL DEFAULT 0`;

export const MIGRATIONS: string[] = [
  `CREATE TABLE usage_raw (${rawColumns}) STRICT`,
  `CREATE INDEX usage_raw_ts ON usage_raw(ts)`,
  `CREATE INDEX usage_raw_thread_ts ON usage_raw(thread_id, ts)`,

  `CREATE TABLE usage_hourly (
  hour INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'unknown',
  tier TEXT NOT NULL DEFAULT 'standard',
  band INTEGER NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',${rollupTokens},
  PRIMARY KEY (hour, provider, model, tier, band, project_id, thread_id)
) STRICT`,
  `CREATE INDEX usage_hourly_hour ON usage_hourly(hour)`,
  `CREATE INDEX usage_hourly_thread ON usage_hourly(thread_id)`,

  `CREATE TABLE thread_tokens (
  thread_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'unknown',
  tier TEXT NOT NULL DEFAULT 'standard',
  band INTEGER NOT NULL DEFAULT 0,${rollupTokens},
  first_ts INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, provider, model, tier, band)
) STRICT`,
  `CREATE TABLE thread_cov (
  thread_id TEXT NOT NULL PRIMARY KEY,
  complete INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0
) STRICT`,

  `CREATE TABLE threads (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT NOT NULL DEFAULT '',
  lifecycle_owner_id TEXT NOT NULL DEFAULT '',
  source_thread_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER NOT NULL DEFAULT 0
) STRICT`,
  `CREATE INDEX threads_parent ON threads(parent_id)`,
  `CREATE INDEX threads_lifecycle_owner ON threads(lifecycle_owner_id)`,

  `CREATE TABLE provider_session (
  provider_thread_id TEXT NOT NULL PRIMARY KEY,
  thread_id TEXT NOT NULL
) STRICT`,

  `CREATE TABLE turns (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT '',
  compaction_only INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, turn_id)
) STRICT`,
  `CREATE TABLE requests (
  request_id TEXT NOT NULL PRIMARY KEY,
  thread_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE context_last (
  thread_id TEXT NOT NULL PRIMARY KEY,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL DEFAULT 0
) STRICT`,

  `CREATE TABLE compactions (
  id TEXT NOT NULL PRIMARY KEY,
  thread_id TEXT NOT NULL DEFAULT '',
  turn_id TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  before_tokens INTEGER NOT NULL DEFAULT 0,
  after_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  ttl_ms INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'bb',
  own_cost_known INTEGER NOT NULL DEFAULT 0
) STRICT`,
  `CREATE INDEX compactions_thread_at ON compactions(thread_id, at)`,
  `CREATE TABLE compaction_effect (
  compaction_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'standard',
  band INTEGER NOT NULL DEFAULT 0,
  calls_hit INTEGER NOT NULL DEFAULT 0,
  calls_miss INTEGER NOT NULL DEFAULT 0,
  calls_cross INTEGER NOT NULL DEFAULT 0,
  first_gap_hit INTEGER NOT NULL DEFAULT 0,
  overhead_fresh_in INTEGER NOT NULL DEFAULT 0,
  overhead_cache_read INTEGER NOT NULL DEFAULT 0,
  overhead_cache_write INTEGER NOT NULL DEFAULT 0,
  overhead_output INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (compaction_id, model, tier, band)
) STRICT`,

  `CREATE TABLE file_cursor (
  path TEXT NOT NULL PRIMARY KEY,
  inode INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  "offset" INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT NOT NULL DEFAULT '',
  watermark_ts INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT NOT NULL DEFAULT '',
  root_session TEXT NOT NULL DEFAULT ''
) STRICT`,
  `CREATE TABLE codex_index (
  rollout_path TEXT NOT NULL PRIMARY KEY,
  id TEXT NOT NULL DEFAULT '',
  root_session TEXT NOT NULL DEFAULT '',
  parent_id TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL DEFAULT 0
) STRICT`,
  `CREATE TABLE ext_cursor (
  source TEXT NOT NULL PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT ''
) STRICT`,
  `CREATE TABLE ext_pending (
  id TEXT NOT NULL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  entry TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL
) STRICT`,

  `CREATE TABLE thread_source (
  thread_id TEXT NOT NULL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  since_ts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ok'
) STRICT`,
  `CREATE TABLE source_interval (
  thread_id TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (thread_id, from_ts)
) STRICT`,
  `CREATE TABLE bb_candidate (${rawColumns}) STRICT`,
  `CREATE TABLE bb_cursor (
  thread_id TEXT NOT NULL PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
) STRICT`,
  `CREATE TABLE bb_counter (
  thread_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  prev_total TEXT NOT NULL DEFAULT 'null',
  PRIMARY KEY (thread_id, provider_thread_id, scope)
) STRICT`,

  `CREATE TABLE cursor (
  name TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL DEFAULT 'null'
) STRICT`,

  // WP3: Codex turn_id → model/tier, kept so a later read of a file can price records whose turn_context came earlier.
  `CREATE TABLE codex_turn_context (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL, PRIMARY KEY (session_id, turn_id)) STRICT`,
  // WP4: context snapshots, request/turn tier and compaction bookkeeping.
  `CREATE TABLE context_snap(thread_id TEXT NOT NULL,seq INTEGER NOT NULL,used_tokens INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(thread_id,seq)) STRICT`,
  `ALTER TABLE requests ADD COLUMN compact INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE requests ADD COLUMN tier_raw TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE turns ADD COLUMN request_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE turns ADD COLUMN tier_raw TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE turns ADD COLUMN reported_usage INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE compactions ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE compactions ADD COLUMN before_known INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE compactions ADD COLUMN after_known INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE compactions ADD COLUMN expired INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE compaction_seen(key TEXT NOT NULL PRIMARY KEY,at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE source_status(source TEXT PRIMARY KEY, last_ingest_at INTEGER, rows INTEGER NOT NULL DEFAULT 0, last_error TEXT, state TEXT NOT NULL DEFAULT 'no-data') STRICT`,
];
