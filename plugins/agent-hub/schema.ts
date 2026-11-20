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
  `ALTER TABLE pool_entries ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';`,
  // One-off: apply the short-acknowledgement rule (QUIET_SQL in ingest.ts) to answers already waiting in the Inbox.
  `UPDATE items SET read_at=updated_at WHERE kind='mine' AND status='answered' AND read_at IS NULL AND length(trim(question))<=60 AND instr(question,'?')=0 AND instr(question,'？')=0 AND length(trim(answer))<=160;`,
  `ALTER TABLE items ADD COLUMN snoozed_until INTEGER;                       -- F8
ALTER TABLE items ADD COLUMN failed_at INTEGER;                           -- F11
ALTER TABLE items ADD COLUMN attempt_request_id TEXT;                     -- F11: latest attempt's request id
ALTER TABLE items ADD COLUMN likely_interim INTEGER NOT NULL DEFAULT 0;   -- F4
ALTER TABLE items ADD COLUMN options TEXT;                                -- F7: JSON string[] or NULL
ALTER TABLE items ADD COLUMN notify_state INTEGER NOT NULL DEFAULT 0;    -- F5: 0 none, 1 pending, 2 held for quiet summary
ALTER TABLE items ADD COLUMN answered_at INTEGER;                         -- F13: when it became answered
ALTER TABLE items ADD COLUMN read_batch TEXT;                             -- F2
ALTER TABLE items ADD COLUMN task_key TEXT;                               -- F12
UPDATE items SET answered_at=CASE WHEN status='answered' THEN updated_at END, attempt_request_id=request_id;
CREATE INDEX items_thread_recent ON items(thread_id, updated_at);
CREATE TABLE notify_meta (key TEXT PRIMARY KEY, value INTEGER);       -- F5: 'held_for' = quiet window end`,
  `ALTER TABLE items ADD COLUMN recommended TEXT;                         -- answers_ask: recommended option text
ALTER TABLE items ADD COLUMN recommend_reason TEXT;`,
  `CREATE TABLE archived_threads (thread_id TEXT PRIMARY KEY);              -- threads archived in bb drop out of the Inbox`,
  `ALTER TABLE items ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';`,
  `ALTER TABLE threads_state ADD COLUMN ingested_thread_updated_at INTEGER;
CREATE INDEX items_snoozed_until ON items(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX items_notify_pending ON items(notify_state) WHERE notify_state=1;`,
  // 'update' items: a top-level turn that answered nothing of the owner's still reports its final message.
  `ALTER TABLE items ADD COLUMN trigger_kind TEXT;                         -- 'update': system | agent | plugin | other
ALTER TABLE items ADD COLUMN trigger_source TEXT;                         -- 'update': child / sender thread id or plugin id
CREATE TABLE request_triggers (thread_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT, text TEXT NOT NULL, PRIMARY KEY (thread_id, request_id));
CREATE TABLE turn_updates (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT, source_id TEXT, question TEXT NOT NULL DEFAULT '', answer TEXT, answer_seq INTEGER, PRIMARY KEY (thread_id, turn_id));`,
  // Conversation order (list order:'activity'): an item sits at its latest activity, the answer time when answered.
  `CREATE INDEX items_thread_activity ON items(thread_id, coalesce(answered_at,created_at), id);`,
  // Updates that ask nothing collapse into one group and are never pushed; existing rows stay 0 (SQL cannot run asksOwner).
  `ALTER TABLE items ADD COLUMN asks INTEGER NOT NULL DEFAULT 0;            -- 'update': the agent seemingly asks the owner something`,
  // Updates that ask nothing carry no read state: they are read on arrival.
  `UPDATE items SET read_at=coalesce(answered_at,created_at) WHERE kind='update' AND asks=0 AND read_at IS NULL;`,
  // A steer accepted into a running turn is seen by the agent only after its next tool result; until then steer_seq holds
  // the acceptance and the turn's reply is not its answer. turn_updates.busy: the turn already produced an item.
  `ALTER TABLE items ADD COLUMN steer_seq INTEGER;
ALTER TABLE turn_updates ADD COLUMN busy INTEGER NOT NULL DEFAULT 0;`,
  // Auto-defer safety net: JSON string[] of child thread ids a deferred question still waits for (NULL: none).
  `ALTER TABLE items ADD COLUMN wait_children TEXT;`,
  // Auto-defer scope: JSON [start,end][] of the turns working on the question (the answering turn and the turns its
  // children woke); only children created inside them count. turn_updates.started_at: when the turn started.
  `ALTER TABLE items ADD COLUMN wait_windows TEXT;
ALTER TABLE turn_updates ADD COLUMN started_at INTEGER;`,
  // Legacy rows use updated_at because their earlier movement timestamps were not recorded.
  // Track answer movement independently of reads, pins and other presentation metadata.
  `ALTER TABLE items ADD COLUMN moved_at INTEGER;
UPDATE items SET moved_at=updated_at;
CREATE TRIGGER items_movement AFTER UPDATE OF status,interim,interim_seq,answer,answer_seq ON items
WHEN NEW.status IS NOT OLD.status OR NEW.interim IS NOT OLD.interim OR NEW.interim_seq IS NOT OLD.interim_seq OR NEW.answer IS NOT OLD.answer OR NEW.answer_seq IS NOT OLD.answer_seq
BEGIN
  UPDATE items SET moved_at=NEW.updated_at WHERE id=NEW.id;
END;`,
  // The auto-defer safety net is gone (only answers_defer defers): questions it deferred get their turn's reply back as the answer.
  `UPDATE items SET status='answered',answer=interim,answer_seq=interim_seq,answer_source='turn',answered_at=coalesce(moved_at,updated_at),read_at=coalesce(moved_at,updated_at),interim=NULL,interim_seq=NULL,wait_children=NULL,wait_windows=NULL
WHERE kind='mine' AND status='deferred' AND wait_children IS NOT NULL AND interim IS NOT NULL AND dismissed_at IS NULL;
UPDATE items SET wait_children=NULL,wait_windows=NULL WHERE wait_children IS NOT NULL;`,
  // turn_updates.report: the agent called answers_report, so the turn's reply is a report for the owner, not a quiet update.
  `ALTER TABLE turn_updates ADD COLUMN report INTEGER NOT NULL DEFAULT 0;`,
  // turn_updates.asked: the turn asked the owner through a channel (answers_ask, a Work Board card question), so a '?' in
  // its reply is not filed again. items.chat_asked: a 'for_me' question filed from an agent's plain-text reply.
  `ALTER TABLE turn_updates ADD COLUMN asked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN chat_asked INTEGER NOT NULL DEFAULT 0;`,
  // items.questions: the bb question form (JSON) of an answers_ask with multiSelect or with several questions in one.
  `ALTER TABLE items ADD COLUMN questions TEXT;`,
  `ALTER TABLE items ADD COLUMN deadline_at INTEGER;`,
  `ALTER TABLE items ADD COLUMN urgency TEXT;`,
  `ALTER TABLE items ADD COLUMN reminded_at INTEGER;
ALTER TABLE items ADD COLUMN reminders INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE sub_threads(thread_id TEXT PRIMARY KEY);
CREATE TRIGGER sub_items_read_insert AFTER INSERT ON items
WHEN NEW.thread_id IN (SELECT thread_id FROM sub_threads) AND NOT (NEW.kind='for_me' AND NEW.chat_asked=0)
BEGIN
  UPDATE items SET read_at=coalesce(NEW.read_at,NEW.updated_at),notify_state=0,asks=0 WHERE id=NEW.id;
END;
CREATE TRIGGER sub_items_read_update AFTER UPDATE OF read_at,notify_state,asks ON items
WHEN NEW.thread_id IN (SELECT thread_id FROM sub_threads) AND NOT (NEW.kind='for_me' AND NEW.chat_asked=0) AND (NEW.read_at IS NULL OR NEW.notify_state<>0 OR NEW.asks<>0)
BEGIN
  UPDATE items SET read_at=coalesce(NEW.read_at,NEW.updated_at),notify_state=0,asks=0 WHERE id=NEW.id;
END;`,
  `ALTER TABLE items ADD COLUMN failure_reason TEXT;
ALTER TABLE items ADD COLUMN interrupted_at INTEGER;`,
  // A steer from another thread or a plugin seen mid-turn: candidate holds what the agent had written for the owner by then, steer_tools the tool results since.
  `ALTER TABLE items ADD COLUMN steer_tools INTEGER NOT NULL DEFAULT 0;`,
  // Unused since the echo pairing was dropped; bb checks a ran migration's text, so this statement must stay byte for byte.
  `ALTER TABLE turn_updates ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turn_updates ADD COLUMN echoes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turn_updates ADD COLUMN echoing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN steer_n INTEGER;
ALTER TABLE items ADD COLUMN snap TEXT;
ALTER TABLE items ADD COLUMN snap_seq INTEGER;`,
  // turn_updates.tail: the last top-level item of the turn was an assistant message, so the next one continues the reply as one run.
  `ALTER TABLE turn_updates ADD COLUMN tail INTEGER NOT NULL DEFAULT 0;`,
  // declined_at: Won't reply quiets an open question without closing it; old owner dismissals of agent questions close as withdrawn.
  `ALTER TABLE items ADD COLUMN declined_at INTEGER;
UPDATE items SET answer_source='agent',note='Closed without an answer: the owner chose Won’t reply.' WHERE kind='for_me' AND status='open' AND dismissed_at IS NOT NULL AND answer_source IS NULL AND chat_asked=0;`,
];
