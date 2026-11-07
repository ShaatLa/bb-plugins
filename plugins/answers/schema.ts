export const migrations = [
  `CREATE TABLE items (
  id               TEXT PRIMARY KEY,          -- "ans_" + random
  kind             TEXT NOT NULL,             -- 'mine' | 'for_me' | 'saved'
  thread_id        TEXT NOT NULL,
  project_id       TEXT,
  status           TEXT NOT NULL,             -- see state machine
  question         TEXT NOT NULL,             -- ≤ 4,000 chars
  question_seq     INTEGER,                   -- anchor of the question message
  request_id       TEXT,                      -- 'mine': client requestId
  turn_id          TEXT,                      -- 'mine': turn that accepted the question
  candidate        TEXT,                      -- latest root agentMessage seen for the bound turn
  candidate_seq    INTEGER,
  interim          TEXT,                      -- reply of a deferred / unsuccessful turn
  interim_seq      INTEGER,
  answer           TEXT,                      -- ≤ 20,000 chars
  answer_seq       INTEGER,
  answer_source    TEXT,                      -- 'turn' | 'agent' | 'user'
  resolve_turn_id  TEXT,                      -- set by answers_resolve
  note             TEXT,                      -- agent note for deferred
  read_at          INTEGER,
  pinned           INTEGER NOT NULL DEFAULT 0,
  dismissed_at     INTEGER,                   -- user "Done": hides from inbox, keeps status
  thread_deleted   INTEGER NOT NULL DEFAULT 0,
  dedupe_key       TEXT,                      -- 'saved': sha256(thread_id|seq|text)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX items_mine_q ON items(thread_id, question_seq) WHERE kind = 'mine';
CREATE UNIQUE INDEX items_saved ON items(dedupe_key) WHERE kind = 'saved';
CREATE INDEX items_turn ON items(thread_id, turn_id);
CREATE INDEX items_resolve ON items(thread_id, resolve_turn_id);
CREATE INDEX items_request ON items(thread_id, request_id);
CREATE INDEX items_inbox ON items(dismissed_at, kind, status, created_at);
CREATE TABLE request_aliases (
  thread_id        TEXT NOT NULL,
  alias_request_id TEXT NOT NULL,
  item_id          TEXT NOT NULL,
  PRIMARY KEY (thread_id, alias_request_id)
);
CREATE TABLE threads_state (
  thread_id      TEXT PRIMARY KEY,
  last_seq       INTEGER NOT NULL,
  active_turn_id TEXT,                        -- last turn/started without turn/completed
  last_error     TEXT,
  updated_at     INTEGER NOT NULL
);`,
  `CREATE TABLE pool_entries (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, quote TEXT NOT NULL,
    quote_seq INTEGER, item_id TEXT, note TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX pool_thread ON pool_entries(thread_id, created_at);`,
];
