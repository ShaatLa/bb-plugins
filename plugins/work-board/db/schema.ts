import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_TASK_STATUSES, taskStatusesSchema } from "../shared/statuses.js";
import { ensurePlanningStatus, withPlanningStatus, workflowPolicySchema } from "../shared/workflow-policy.js";
import type { PlanState } from "../shared/plan";
import { hasPlanDebt } from "../shared/plan-debt";
import { CREATE_HOLDS_TABLE, rebuildCheckFlow } from "./check-flow";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
type Log = (message: string) => void;

/** 0.62.0: a project that already plans gets its planning status settled; one bad board is logged and skipped. */
function settlePlanningStatuses(db: PluginDatabase, log: Log): void {
  const rows = db.prepare<[], { id: string; prefix: string; statuses: string | null; workflow_policy: string | null }>("SELECT id, prefix, statuses, workflow_policy FROM projects WHERE planning IN ('optional', 'required')").all();
  for (const row of rows) {
    try {
      const statuses = row.statuses == null ? null : taskStatusesSchema.parse(JSON.parse(row.statuses));
      const policy = row.workflow_policy == null ? null : workflowPolicySchema.parse(JSON.parse(row.workflow_policy));
      const ensured = ensurePlanningStatus({ statuses, workflowPolicy: policy });
      if (ensured.planningStatus === null) {
        log(`planning status not set for ${row.prefix}: ${ensured.reason}`);
        continue;
      }
      const next = withPlanningStatus(policy, ensured.planningStatus);
      const inserted = ensured.statuses.length !== (statuses ?? DEFAULT_TASK_STATUSES).length;
      db.prepare("UPDATE projects SET statuses = CASE WHEN ? THEN ? ELSE statuses END, workflow_policy = ? WHERE id = ?").run(inserted ? 1 : 0, JSON.stringify(ensured.statuses), next ? JSON.stringify(next) : null, row.id);
    } catch (error) {
      log(`planning status not set for ${row.prefix}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE COLLATE NOCASE,
      next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
      color TEXT NOT NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      linked_bb_project_id TEXT,
      created_at TEXT NOT NULL,
      CHECK (prefix = upper(prefix)),
      CHECK (linked_bb_project_id IS NULL OR linked_bb_project_id GLOB 'proj_*')
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL CHECK (number >= 1),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled')),
      priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
      due_date TEXT,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      position REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, number),
      CHECK (parent_task_id IS NULL OR parent_task_id <> id),
      CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    );

    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL,
      UNIQUE (project_id, name)
    );

    CREATE TABLE IF NOT EXISTS task_labels (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'system')),
      author_name TEXT NOT NULL,
      preset_name TEXT,
      thread_id TEXT,
      body TEXT NOT NULL,
      notified_count INTEGER NOT NULL DEFAULT 0 CHECK (notified_count >= 0),
      created_at TEXT NOT NULL,
      CHECK (thread_id IS NULL OR thread_id GLOB 'thr_*')
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      blob_path TEXT NOT NULL,
      is_image INTEGER NOT NULL CHECK (is_image IN (0, 1)),
      created_at TEXT NOT NULL,
      CHECK ((task_id IS NOT NULL AND comment_id IS NULL) OR (task_id IS NULL AND comment_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS task_threads (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      preset_name TEXT NOT NULL,
      title TEXT NOT NULL,
      live_status TEXT NOT NULL CHECK (live_status IN ('starting', 'working', 'idle', 'completed', 'failed')),
      attached_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, thread_id),
      CHECK (thread_id GLOB 'thr_*')
    );

    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      instructions TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);
    CREATE INDEX IF NOT EXISTS idx_projects_folder ON projects(folder_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(project_id, status, position);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, position);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_comments_task_order ON comments(task_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);
    CREATE INDEX IF NOT EXISTS idx_task_threads_task_status ON task_threads(task_id, live_status);
    CREATE INDEX IF NOT EXISTS idx_task_threads_thread ON task_threads(thread_id);
  `,
  "",
  `
    ALTER TABLE presets
      ADD COLUMN environment_kind TEXT NOT NULL DEFAULT 'project-default'
      CHECK (environment_kind IN ('project-default', 'new-worktree'));
    ALTER TABLE presets ADD COLUMN base_branch TEXT;
    ALTER TABLE presets ADD COLUMN machine_id TEXT;
  `,
  `
    CREATE TABLE task_list_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
    INSERT INTO task_list_revision (id, revision) VALUES (1, 0);

    CREATE TRIGGER task_list_revision_tasks_insert
    AFTER INSERT ON tasks BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_tasks_update
    AFTER UPDATE ON tasks BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_tasks_delete
    AFTER DELETE ON tasks BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER task_list_revision_labels_insert
    AFTER INSERT ON task_labels BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_labels_delete
    AFTER DELETE ON task_labels BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_label_names
    AFTER UPDATE OF name ON labels
    WHEN OLD.name <> NEW.name BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER task_list_revision_threads_insert
    AFTER INSERT ON task_threads BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_threads_update
    AFTER UPDATE ON task_threads BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_list_revision_threads_delete
    AFTER DELETE ON task_threads BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER task_list_revision_project_prefix
    AFTER UPDATE OF prefix ON projects
    WHEN OLD.prefix <> NEW.prefix BEGIN
      UPDATE task_list_revision SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE INDEX idx_tasks_manual_page
      ON tasks(project_id, status, position, id);
    CREATE INDEX idx_tasks_priority_page ON tasks(
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        WHEN 'none' THEN 4
        ELSE 5
      END,
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
      due_date,
      project_id,
      status,
      position,
      id
    );
    CREATE INDEX idx_tasks_due_page ON tasks(
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
      due_date,
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        WHEN 'none' THEN 4
        ELSE 5
      END,
      project_id,
      status,
      position,
      id
    );
  `,
  `
    UPDATE presets
    SET permission_mode = CASE permission_mode
      WHEN 'workspace-write' THEN 'accept-edits'
      WHEN 'readonly' THEN 'accept-edits'
    END
    WHERE permission_mode IN ('workspace-write', 'readonly');
  `,
  `
    ALTER TABLE presets ADD COLUMN service_tier TEXT
      CHECK (service_tier IN ('default', 'fast'));
  `,
  `
    CREATE TABLE task_key_aliases (
      prefix TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL CHECK (number >= 1),
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (prefix, number)
    );
    CREATE INDEX idx_task_key_aliases_task ON task_key_aliases(task_id);
  `,
  `
    ALTER TABLE presets ADD COLUMN service_tier_open TEXT;
    UPDATE presets SET service_tier_open = service_tier;
    ALTER TABLE presets DROP COLUMN service_tier;
    ALTER TABLE presets RENAME COLUMN service_tier_open TO service_tier;
  `,
  `
    ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'task'
      CHECK (type IN ('task', 'epic'));
    ALTER TABLE tasks ADD COLUMN epic_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
    CREATE INDEX idx_tasks_epic ON tasks(epic_id, position);
  `,
  `
    ALTER TABLE comments ADD COLUMN evidence TEXT;
    CREATE TABLE task_questions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      payload TEXT NOT NULL
    );
    CREATE INDEX idx_task_questions_task ON task_questions(task_id, id);
    CREATE TABLE description_templates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      body TEXT NOT NULL,
      label_id TEXT REFERENCES labels(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, name),
      UNIQUE(label_id)
    );
  `,
  `
    ALTER TABLE tasks ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'agent'
      CHECK (execution_target IN ('agent', 'owner'));
    ALTER TABLE tasks ADD COLUMN requester_thread_id TEXT
      CHECK (requester_thread_id IS NULL OR requester_thread_id GLOB 'thr_*');
  `,
  (db: PluginDatabase) => {
    db.exec("ALTER TABLE projects ADD COLUMN statuses TEXT");
    const table = db
      .prepare<
        [],
        { sql: string }
      >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get()!;
    const objects = db
      .prepare<
        [],
        { sql: string }
      >("SELECT sql FROM sqlite_master WHERE tbl_name = 'tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
      .all();
    const sql = table.sql.replace(
      "CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'))",
      "CHECK (length(status) BETWEEN 1 AND 64)",
    );
    if (sql === table.sql)
      throw new Error("Could not migrate the task status constraint");
    db.exec("CREATE TEMP TABLE tasks_status_backup AS SELECT * FROM tasks");
    db.exec("DROP TABLE tasks");
    db.exec(sql);
    db.exec("INSERT INTO tasks SELECT * FROM tasks_status_backup");
    db.exec("DROP TABLE tasks_status_backup");
    for (const object of objects) db.exec(object.sql);
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Foreign key check failed during status migration");
  },
  `ALTER TABLE tasks ADD COLUMN archived_at TEXT;
   CREATE INDEX idx_tasks_archive ON tasks(project_id, archived_at, status);`,
  `CREATE TABLE git_sync_projects (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL, last_attempt_at INTEGER
  );
  CREATE TABLE task_pr_links (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, identity TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(task_id, identity)
  );
  CREATE TABLE git_pr_snapshots (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, identity TEXT NOT NULL, payload TEXT, error TEXT, PRIMARY KEY(project_id, identity));`,
  `CREATE TABLE sequences (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, next INTEGER NOT NULL, format TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, name));
  CREATE TABLE sequence_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, rendered TEXT NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, task_key TEXT NOT NULL, pr_url TEXT, thread_id TEXT, claimed_at TEXT NOT NULL, state TEXT NOT NULL, released_at TEXT, reason TEXT, FOREIGN KEY(project_id, name) REFERENCES sequences(project_id, name) ON DELETE CASCADE, UNIQUE(project_id, name, value));
  CREATE INDEX idx_sequence_claims_task ON sequence_claims(task_id, state);`,

  `CREATE TABLE resource_locks (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    holder_thread_id TEXT,
    task_key TEXT,
    reason TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (project_id, name)
  );
  CREATE TABLE resource_lock_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('acquired', 'released', 'taken_over', 'expired')),
    thread_id TEXT,
    previous_thread_id TEXT,
    task_key TEXT,
    reason TEXT NOT NULL,
    forced INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
  );
  CREATE INDEX idx_resource_lock_events ON resource_lock_events(project_id, name, id);`,
  `CREATE TABLE task_activity_history (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE);
   INSERT INTO task_activity_history(task_id) SELECT DISTINCT task_id FROM comments WHERE kind='agent' AND thread_id IS NOT NULL;
   CREATE TRIGGER task_activity_agent_comment AFTER INSERT ON comments
   WHEN NEW.kind='agent' AND NEW.thread_id IS NOT NULL
   BEGIN INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (NEW.task_id); END;
   CREATE TABLE task_activity_claims (thread_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, turn_id TEXT NOT NULL);
   CREATE TABLE task_activity_queue (thread_id TEXT NOT NULL, queue_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, PRIMARY KEY(thread_id, queue_id));`,
  `ALTER TABLE projects ADD COLUMN auto_archive_after_days TEXT
     CHECK (auto_archive_after_days IN ('off', '7', '14', '30'));
   ALTER TABLE projects ADD COLUMN stale_idle_minutes TEXT
     CHECK (stale_idle_minutes IN ('off', '30', '45', '60', '120'));`,
  `CREATE TABLE task_dependencies (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     blocking_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     PRIMARY KEY (task_id, blocking_task_id),
     CHECK (task_id <> blocking_task_id)
   );
   CREATE INDEX idx_task_dependencies_blocker ON task_dependencies(blocking_task_id, task_id);`,
  `CREATE TABLE task_schedules (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    template_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), rule TEXT NOT NULL, target TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), next_due_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_task_schedules_due ON task_schedules(enabled,next_due_at);
  CREATE TABLE task_scheduled_sources (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    schedule_id TEXT NOT NULL, schedule_title TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('template','recurring_run','one_time_run')),
    scheduled_for TEXT, started_at TEXT, run_id TEXT, occurrence_key TEXT
  );
  CREATE UNIQUE INDEX idx_task_scheduled_source_occurrence ON task_scheduled_sources(schedule_id,occurrence_key) WHERE occurrence_key IS NOT NULL;
  CREATE INDEX idx_task_scheduled_sources_schedule ON task_scheduled_sources(schedule_id,role,task_id);
  CREATE TABLE task_schedule_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    occurrence_key TEXT NOT NULL, state TEXT NOT NULL, resolved_at TEXT, finished_at TEXT,
    thread_id TEXT, payload TEXT NOT NULL,
    UNIQUE(schedule_id,occurrence_key)
  );
  CREATE INDEX idx_task_schedule_runs_pending ON task_schedule_runs(state,thread_id);
  CREATE INDEX idx_task_schedule_runs_history ON task_schedule_runs(project_id,schedule_id,id);
  CREATE INDEX idx_task_schedule_runs_retention ON task_schedule_runs(state,resolved_at,finished_at);
  CREATE INDEX idx_task_schedule_runs_queue ON task_schedule_runs(json_extract(payload,'$.queueId'));
  CREATE INDEX idx_task_schedule_runs_request ON task_schedule_runs(thread_id,json_extract(payload,'$.requestId'));
  CREATE TRIGGER task_scheduled_status AFTER UPDATE OF status ON tasks
  WHEN NEW.status<>OLD.status AND EXISTS(SELECT 1 FROM task_scheduled_sources WHERE task_id=NEW.id AND started_at IS NOT NULL)
  BEGIN
    UPDATE task_schedule_runs SET
      state=CASE NEW.status WHEN 'done' THEN 'completed' WHEN 'canceled' THEN 'canceled' ELSE 'running' END,
      resolved_at=CASE WHEN NEW.status='canceled' THEN NEW.updated_at WHEN NEW.status='done' THEN resolved_at ELSE NULL END,
      finished_at=CASE WHEN NEW.status IN ('done','canceled') THEN NEW.updated_at ELSE NULL END,
      payload=json_set(payload,'$.state',CASE NEW.status WHEN 'done' THEN 'completed' WHEN 'canceled' THEN 'canceled' ELSE 'running' END,
        '$.finishedAt',CASE WHEN NEW.status IN ('done','canceled') THEN NEW.updated_at ELSE NULL END,'$.resolvedAt',CASE WHEN NEW.status='canceled' THEN NEW.updated_at WHEN NEW.status='done' THEN resolved_at ELSE NULL END,'$.updatedAt',NEW.updated_at)
    WHERE id=(SELECT run_id FROM task_scheduled_sources WHERE task_id=NEW.id) AND COALESCE(json_extract(payload,'$.historical'),0)=0;
  END;`,
  `ALTER TABLE projects ADD COLUMN status_notifications TEXT CHECK(status_notifications IN ('off','all','done'));`,
  `DROP TRIGGER task_scheduled_status;
  CREATE TRIGGER task_scheduled_status AFTER UPDATE OF status ON tasks
  WHEN NEW.status<>OLD.status AND EXISTS(SELECT 1 FROM task_scheduled_sources WHERE task_id=NEW.id AND started_at IS NOT NULL)
  BEGIN
    UPDATE task_schedule_runs SET
      state=CASE NEW.status WHEN 'done' THEN 'completed' WHEN 'canceled' THEN 'canceled' ELSE 'running' END,
      resolved_at=CASE WHEN NEW.status='canceled' THEN NEW.updated_at WHEN NEW.status='done' THEN resolved_at ELSE NULL END,
      finished_at=CASE WHEN NEW.status IN ('done','canceled') THEN NEW.updated_at ELSE NULL END,
      payload=json_set(payload,'$.state',CASE NEW.status WHEN 'done' THEN 'completed' WHEN 'canceled' THEN 'canceled' ELSE 'running' END,
        '$.finishedAt',CASE WHEN NEW.status IN ('done','canceled') THEN NEW.updated_at ELSE NULL END,'$.resolvedAt',CASE WHEN NEW.status='canceled' THEN NEW.updated_at WHEN NEW.status='done' THEN resolved_at ELSE NULL END,'$.updatedAt',NEW.updated_at)
    WHERE project_id=NEW.project_id AND json_extract(payload,'$.taskId')=NEW.id AND id=(SELECT run_id FROM task_scheduled_sources WHERE task_id=NEW.id) AND COALESCE(json_extract(payload,'$.historical'),0)=0;
  END;`,
  `ALTER TABLE projects ADD COLUMN workflow_policy TEXT`,
  `CREATE TABLE legacy_done_tasks (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE);
   INSERT INTO legacy_done_tasks SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id
   WHERE t.status = CASE WHEN json_type(p.workflow_policy, '$.doneStatus') IS NULL THEN 'done' ELSE json_extract(p.workflow_policy, '$.doneStatus') END;
   CREATE TRIGGER legacy_done_tasks_leave AFTER UPDATE OF status ON tasks
   WHEN OLD.status != NEW.status BEGIN DELETE FROM legacy_done_tasks WHERE task_id=NEW.id; END;`,
  `CREATE TABLE task_relations (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     related_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     PRIMARY KEY (task_id, related_task_id),
     CHECK (task_id < related_task_id)
   );
   CREATE INDEX idx_task_relations_related ON task_relations(related_task_id, task_id);`,
  `ALTER TABLE git_pr_snapshots ADD COLUMN last_attempt_at INTEGER;
   ALTER TABLE git_pr_snapshots ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;`,
  // Parent-fallback links only keep unfinished work accountable; finishing a task releases them on every path.
  `DELETE FROM task_threads WHERE preset_name='Parent thread'
     AND task_id IN (SELECT id FROM tasks WHERE status IN ('done','canceled'));
   CREATE TRIGGER task_parent_fallback_release AFTER UPDATE OF status ON tasks
   WHEN NEW.status IN ('done','canceled') AND OLD.status <> NEW.status
   BEGIN DELETE FROM task_threads WHERE task_id=NEW.id AND preset_name='Parent thread'; END;`,
  `ALTER TABLE tasks ADD COLUMN progress_note TEXT;
   ALTER TABLE tasks ADD COLUMN progress_updated_at TEXT;
   ALTER TABLE tasks ADD COLUMN progress_updated_by TEXT;`,
  // Adds the 3-day auto-archive interval; SQLite can only change a CHECK by rebuilding the table (as in version 12).
  (db: PluginDatabase) => {
    const table = db.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()!;
    const objects = db.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE tbl_name = 'projects' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all();
    const sql = table.sql.replace("CHECK (auto_archive_after_days IN ('off', '7', '14', '30'))", "CHECK (auto_archive_after_days IN ('off', '3', '7', '14', '30'))");
    if (sql === table.sql) throw new Error("Could not migrate the auto-archive constraint");
    db.exec("CREATE TEMP TABLE projects_archive_backup AS SELECT * FROM projects");
    db.exec("DROP TABLE projects");
    db.exec(sql);
    db.exec("INSERT INTO projects SELECT * FROM projects_archive_backup");
    db.exec("DROP TABLE projects_archive_backup");
    for (const object of objects) db.exec(object.sql);
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Foreign key check failed during auto-archive migration");
  },
  (db: PluginDatabase) => {
    db.exec("ALTER TABLE tasks DROP COLUMN execution_target; ALTER TABLE tasks DROP COLUMN requester_thread_id;");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Foreign key check failed during executor removal");
  },
  `ALTER TABLE projects ADD COLUMN question_link_hosts TEXT;`,
  // 0.43.0 shipped question link hosts and 0.43.1 withdrew them; the column goes with the setting.
  `ALTER TABLE projects DROP COLUMN question_link_hosts;`,
  // 0.47.0 changed the default owner-decision label to "owner decision"; existing projects keep the label they had.
  `UPDATE projects SET workflow_policy = json_set(COALESCE(workflow_policy, '{}'), '$.ownerDecisionLabel', 'решение владельца')
   WHERE workflow_policy IS NULL OR json_type(workflow_policy, '$.ownerDecisionLabel') IS NULL;`,
  // 0.56.0: one numbered, versioned plan per task. Every version keeps its full body; format stays open for later kinds.
  `CREATE TABLE task_plans (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
     format TEXT NOT NULL DEFAULT 'markdown',
     version INTEGER NOT NULL CHECK (version >= 1),
     body TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('draft', 'in_review', 'changes_requested', 'approved')),
     updated_at TEXT NOT NULL,
     author_kind TEXT NOT NULL CHECK (author_kind IN ('agent', 'person')),
     author_thread TEXT CHECK (author_thread IS NULL OR author_thread GLOB 'thr_*'),
     author_name TEXT NOT NULL
   );
   CREATE TABLE task_plan_versions (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     version INTEGER NOT NULL CHECK (version >= 1),
     body TEXT NOT NULL,
     base_version INTEGER NOT NULL CHECK (base_version >= 0),
     op TEXT NOT NULL CHECK (op IN ('create', 'replace', 'section', 'fragment', 'restore')),
     target TEXT,
     summary TEXT NOT NULL,
     author_kind TEXT NOT NULL CHECK (author_kind IN ('agent', 'person')),
     author_thread TEXT CHECK (author_thread IS NULL OR author_thread GLOB 'thr_*'),
     author_name TEXT NOT NULL,
     added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
     removed INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0),
     created_at TEXT NOT NULL,
     PRIMARY KEY (task_id, version)
   );`,
  // 0.58.0: the owner's notes on a plan, anchored by quote and context; they outlive plan versions and re-anchor at render time.
  `CREATE TABLE task_plan_notes (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     number INTEGER NOT NULL CHECK (number >= 1),
     kind TEXT NOT NULL CHECK (kind IN ('comment', 'remove', 'general')),
     exact TEXT,
     prefix TEXT,
     suffix TEXT,
     heading_path TEXT,
     made_on_version INTEGER NOT NULL CHECK (made_on_version >= 1),
     body TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL CHECK (state IN ('draft', 'sent', 'addressed', 'resolved')),
     sent_in_version INTEGER,
     sent_at TEXT,
     reply TEXT,
     reply_by TEXT,
     replied_at TEXT,
     addressed_in_version INTEGER,
     author_name TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (task_id, number)
   );`,
  // 0.59.0: planning is a project setting (optional only where plans already exist); a plan names its approver (null = the owner, so existing plans stay reviewable by the owner), and every
  // review attempt is kept. Notes remember whether the owner or a reviewer thread wrote them.
  `ALTER TABLE task_plans ADD COLUMN reviewer_kind TEXT CHECK (reviewer_kind IS NULL OR reviewer_kind IN ('owner', 'thread'));
   ALTER TABLE task_plans ADD COLUMN reviewer_thread TEXT;
   ALTER TABLE task_plans ADD COLUMN review_version INTEGER;
   ALTER TABLE task_plan_notes ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'person' CHECK (author_kind IN ('person', 'thread'));
   ALTER TABLE task_plan_notes ADD COLUMN author_thread TEXT;
   CREATE TABLE task_plan_reviews (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     version INTEGER NOT NULL CHECK (version >= 1),
     reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('owner', 'thread')),
     reviewer_thread TEXT,
     submitted_by_thread TEXT,
     submitted_at TEXT NOT NULL,
     outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'changes_requested', 'approved', 'superseded', 'reassigned')),
     decided_at TEXT,
     decided_by TEXT
   );
   CREATE INDEX idx_task_plan_reviews_task ON task_plan_reviews(task_id, id);
   ALTER TABLE projects ADD COLUMN planning TEXT CHECK (planning IN ('off', 'optional', 'required'));
   ALTER TABLE projects ADD COLUMN plan_flags_initialized INTEGER NOT NULL DEFAULT 0 CHECK (plan_flags_initialized IN (0, 1));
   ALTER TABLE projects ADD COLUMN planning_changed_at TEXT;
   ALTER TABLE projects ADD COLUMN planning_previous TEXT CHECK (planning_previous IS NULL OR planning_previous IN ('off', 'optional', 'required'));
   UPDATE projects SET planning = 'optional' WHERE id IN (SELECT t.project_id FROM tasks t JOIN task_plans p ON p.task_id = t.id);`,
  // 0.60.0: threads of closed cards. A link records whether Work Board spawned its session and who wrote it; a closure
  // records each open -> closed change with a snapshot of the card's links, the archive action and the notice state of each.
  `ALTER TABLE task_threads ADD COLUMN created_for_task INTEGER NOT NULL DEFAULT 0 CHECK (created_for_task IN (0, 1));
   ALTER TABLE task_threads ADD COLUMN link_origin TEXT CHECK (link_origin IS NULL OR link_origin IN
     ('delegate_spawn', 'delegate_existing', 'scheduled_spawn', 'scheduled_existing', 'discovery', 'parent', 'manual'));
   CREATE TABLE task_closures (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     closed_at TEXT NOT NULL,
     closed_by_thread TEXT,
     reopened_at TEXT
   );
   CREATE INDEX idx_task_closures_task ON task_closures(task_id);
   CREATE TABLE closure_threads (
     closure_id TEXT NOT NULL REFERENCES task_closures(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     link_id TEXT,
     live_status TEXT NOT NULL,
     link_origin TEXT,
     link_created INTEGER NOT NULL DEFAULT 0,
     action TEXT NOT NULL CHECK (action IN ('candidate', 'on_idle', 'evaluating', 'archiving', 'archived', 'kept')),
     reason TEXT,
     attempt_id TEXT,
     seen_active INTEGER NOT NULL DEFAULT 0 CHECK (seen_active IN (0, 1)),
     self_notice TEXT NOT NULL DEFAULT 'none' CHECK (self_notice IN ('none', 'sending', 'sent', 'failed', 'unknown')),
     parent_notice TEXT NOT NULL DEFAULT 'none' CHECK (parent_notice IN ('none', 'sending', 'sent', 'failed', 'unknown')),
     self_attempts INTEGER NOT NULL DEFAULT 0,
     parent_attempts INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (closure_id, thread_id)
   );
   CREATE INDEX idx_closure_threads_thread ON closure_threads(thread_id);
   ALTER TABLE projects ADD COLUMN archive_threads_on_close TEXT NOT NULL DEFAULT 'on' CHECK (archive_threads_on_close IN ('on', 'off'));
   ALTER TABLE projects ADD COLUMN archive_reviewer_on_approval TEXT NOT NULL DEFAULT 'on' CHECK (archive_reviewer_on_approval IN ('on', 'off'));
   ALTER TABLE task_plan_reviews ADD COLUMN dedicated_reviewer INTEGER NOT NULL DEFAULT 0 CHECK (dedicated_reviewer IN (0, 1));
   ALTER TABLE task_plan_reviews ADD COLUMN archive_state TEXT CHECK (archive_state IS NULL OR archive_state IN ('pending', 'archiving', 'archived', 'kept'));
   ALTER TABLE task_plan_reviews ADD COLUMN archive_seen_active INTEGER NOT NULL DEFAULT 0;`,
  // 0.61.0: the attention ledger for manager notices. Local state only (never exported): per-tracker revision counter, the
  // off/shadow/live selector with its transition, handback and ack records, occurrences, delivery attempts and observations.
  `CREATE TABLE IF NOT EXISTS attention_rev (tracker_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, rev INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS attention_modes (
     tracker_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     bound_tracker_id TEXT,
     bound_bb_project_id TEXT,
     effective_mode TEXT NOT NULL DEFAULT 'off' CHECK (effective_mode IN ('off', 'shadow', 'live')),
     effective_generation INTEGER NOT NULL DEFAULT 0,
     requested_mode TEXT CHECK (requested_mode IS NULL OR requested_mode IN ('shadow', 'live')),
     requested_generation INTEGER,
     transition_token TEXT,
     transition_direction TEXT CHECK (transition_direction IS NULL OR transition_direction IN ('to_live', 'to_shadow')),
     transition_state TEXT CHECK (transition_state IS NULL OR transition_state IN ('preparing', 'ready')),
     ready_at TEXT,
     ready_rev INTEGER,
     parity_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (parity_reviewed IN (0, 1)),
     shadow_started_at TEXT,
     changed_at TEXT,
     previous_mode TEXT,
     PRIMARY KEY (tracker_id, kind)
   );
   CREATE TABLE IF NOT EXISTS attention_handback (
     tracker_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL, occurrence_id TEXT NOT NULL,
     -- The key the card had when the handback became ready: a published handback never changes under its token.
     task_key TEXT NOT NULL,
     PRIMARY KEY (tracker_id, kind, generation, occurrence_id)
   );
   CREATE TABLE IF NOT EXISTS attention_acks (
     tracker_id TEXT NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL, generation INTEGER NOT NULL, direction TEXT NOT NULL,
     fence_id TEXT NOT NULL, ids_hash TEXT NOT NULL, result_json TEXT NOT NULL,
     PRIMARY KEY (tracker_id, kind, token)
   );
   CREATE TABLE IF NOT EXISTS manager_attention (
     id TEXT PRIMARY KEY,
     tracker_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL,
     task_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     signal TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     eligible_at TEXT NOT NULL,
     cleared_at TEXT,
     retired_reason TEXT,
     sweep_baselined_generation INTEGER,
     created_rev INTEGER NOT NULL,
     rev INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_manager_attention_rev ON manager_attention(tracker_id, kind, rev);
   CREATE INDEX IF NOT EXISTS idx_manager_attention_task ON manager_attention(task_id, kind, signal, cleared_at);
   CREATE TABLE IF NOT EXISTS attention_attempts (
     attempt_id TEXT PRIMARY KEY,
     tracker_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     generation INTEGER NOT NULL,
     batch_id TEXT NOT NULL UNIQUE,
     recipient_thread_id TEXT NOT NULL,
     recipient_source TEXT NOT NULL CHECK (recipient_source IN ('manager', 'sweep_fallback', 'parent')),
     started_at TEXT NOT NULL,
     transport_started_at TEXT,
     outcome TEXT NOT NULL CHECK (outcome IN ('claimed', 'sending', 'appended', 'queued', 'inline', 'failed', 'unknown')),
     queued_message_id TEXT,
     inline_event_ref TEXT,
     accepted_at TEXT,
     disposition TEXT CHECK (disposition IS NULL OR disposition IN ('waived_loss', 'retry')),
     disposition_at TEXT,
     error TEXT,
     -- Where the history search for this attempt's marker got to, so passes continue instead of restarting.
     recovery_cursor TEXT,
     rev INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_attention_attempts_rev ON attention_attempts(tracker_id, kind, rev);
   CREATE TABLE IF NOT EXISTS attention_attempt_items (
     attempt_id TEXT NOT NULL REFERENCES attention_attempts(attempt_id) ON DELETE CASCADE,
     occurrence_id TEXT NOT NULL,
     PRIMARY KEY (attempt_id, occurrence_id)
   );
   CREATE INDEX IF NOT EXISTS idx_attention_attempt_items_occurrence ON attention_attempt_items(occurrence_id);
   CREATE TABLE IF NOT EXISTS attention_observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     tracker_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL, at TEXT NOT NULL, task_id TEXT NOT NULL, signal TEXT NOT NULL,
     validity TEXT NOT NULL CHECK (validity IN ('valid', 'unknown')), rev INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_attention_observations_rev ON attention_observations(tracker_id, kind, rev);
   CREATE TABLE IF NOT EXISTS attention_unknown (tracker_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT NOT NULL, signal TEXT NOT NULL, PRIMARY KEY (tracker_id, kind, task_id, signal));
   CREATE TABLE IF NOT EXISTS attention_manager (
     tracker_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     manager TEXT, changed_at TEXT, previous TEXT
   );`,
  // 0.62.0: a project that already plans gets a Planning status (see settlePlanningStatuses). The log is bound per run.
  (db: PluginDatabase, log: Log) => settlePlanningStatuses(db, log),
  // 0.64.0: the repository-check runner (checks/). Local state only (never exported), keyed by tracker. Every staged report and
  // committed snapshot records the bb project it belongs to, so a relink never applies state recorded for another project; history rows are keyed by it too.
  `CREATE TABLE IF NOT EXISTS checks_config (
     tracker_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
     enabled_changed_at TEXT,
     enabled_previous INTEGER,
     branch TEXT, script TEXT, args TEXT, interval_minutes INTEGER, timeout_seconds INTEGER, snapshots INTEGER
   );
   CREATE TABLE IF NOT EXISTS checks_state (
     tracker_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     value TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS checks_delivery (
     tracker_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     committed BLOB,
     committed_project TEXT,
     report_id TEXT,
     pending_project TEXT,
     pending_exit INTEGER,
     pending_tick TEXT,
     pending_body TEXT,
     pending_snapshot BLOB,
     pending_at TEXT
   );
   CREATE TABLE IF NOT EXISTS checks_attempts (
     attempt_id TEXT PRIMARY KEY,
     tracker_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     report_id TEXT NOT NULL,
     tick_id TEXT NOT NULL,
     bb_project_id TEXT NOT NULL,
     manager_thread_id TEXT NOT NULL,
     marker TEXT NOT NULL UNIQUE,
     started_at TEXT NOT NULL,
     transport_started_at TEXT,
     pending_since TEXT,
     outcome TEXT NOT NULL CHECK (outcome IN ('sending', 'appended', 'queued', 'inline', 'failed', 'unknown', 'superseded')),
     queued_message_id TEXT,
     inline_event_ref TEXT,
     accepted_at TEXT,
     error TEXT,
     recovery_cursor TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_checks_attempts_report ON checks_attempts(tracker_id, report_id, started_at);
   CREATE TABLE IF NOT EXISTS checks_ticks (
     tick TEXT PRIMARY KEY, tracker_id TEXT NOT NULL, project TEXT NOT NULL, at INTEGER NOT NULL,
     executed INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0, repeated INTEGER NOT NULL DEFAULT 0,
     suppressed INTEGER NOT NULL DEFAULT 0, refresh_failed INTEGER NOT NULL DEFAULT 0, script_failed INTEGER NOT NULL DEFAULT 0,
     delivery_failed INTEGER NOT NULL DEFAULT 0, delivery_unknown INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS idx_checks_ticks_tracker_at ON checks_ticks(tracker_id, project, at);
   CREATE TABLE IF NOT EXISTS checks_items (
     tracker_id TEXT NOT NULL, project TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
     PRIMARY KEY (tracker_id, project, fingerprint)
   );
   CREATE INDEX IF NOT EXISTS idx_checks_items_tracker_first ON checks_items(tracker_id, project, first_at);`,
  // 0.70.0: plan debt. An episode is one stretch of a card working without an approved plan; its events and notices form the reminder outbox.
  // The backfill opens an episode for each card already in debt, dated at install: history cannot prove when it entered the zone.
  (db: PluginDatabase) => {
    db.exec(`CREATE TABLE plan_debt_episodes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
       since TEXT NOT NULL,
       ended_at TEXT
     );
     CREATE UNIQUE INDEX idx_plan_debt_open ON plan_debt_episodes(task_id) WHERE ended_at IS NULL;
     CREATE TABLE plan_debt_events (
       episode_id INTEGER NOT NULL REFERENCES plan_debt_episodes(id) ON DELETE CASCADE,
       trigger TEXT NOT NULL,
       created_at TEXT NOT NULL,
       expanded INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (episode_id, trigger)
     );
     CREATE TABLE plan_debt_notices (
       episode_id INTEGER NOT NULL REFERENCES plan_debt_episodes(id) ON DELETE CASCADE,
       trigger TEXT NOT NULL,
       destination TEXT NOT NULL,
       marker TEXT NOT NULL UNIQUE,
       state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
       attempts INTEGER NOT NULL DEFAULT 0,
       last_error TEXT,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (episode_id, trigger, destination)
     );`);
    const now = new Date().toISOString();
    const open = db.prepare("INSERT INTO plan_debt_episodes (task_id, since) VALUES (?, ?)");
    const cards = db.prepare<[], { id: string; type: string; status: string; archived_at: string | null; planning: string | null; statuses: string | null; workflow_policy: string | null; plan_state: PlanState | null }>(
      `SELECT t.id, t.type, t.status, t.archived_at, p.planning, p.statuses, p.workflow_policy, pl.state AS plan_state FROM tasks t JOIN projects p ON p.id = t.project_id
       LEFT JOIN task_plans pl ON pl.task_id = t.id WHERE p.planning = 'required'`,
    ).all();
    for (const card of cards)
      if (hasPlanDebt({ planning: card.planning, workflowPolicy: card.workflow_policy ? JSON.parse(card.workflow_policy) : null, statuses: card.statuses ? JSON.parse(card.statuses) : null }, { type: card.type, status: card.status, archivedAt: card.archived_at }, card.plan_state)) open.run(card.id, now);
  },
  // 0.70.0: the marker search of an unresolved plan-debt notice resumes from its cursor on the next drain.
  `ALTER TABLE plan_debt_notices ADD COLUMN cursor TEXT;`,
  // 0.70.0: the recipients of an event are fixed when it is first expanded; `candidates` holds the executor threads whose state is still unread.
  `ALTER TABLE plan_debt_events ADD COLUMN candidates TEXT;`,
  // 0.71.0: the runner-ownership row of a bb project and the handoff ids of a transfer with Sweep. No longer read or written since Sweep was retired; rows stay as history.
  `CREATE TABLE IF NOT EXISTS checks_runner_owner (
     bb_project_id TEXT PRIMARY KEY,
     owner TEXT NOT NULL CHECK (owner IN ('sweep', 'work-board')),
     tracker_id TEXT,
     sent_id TEXT,
     sent_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (sent_confirmed IN (0, 1)),
     received_id TEXT,
     updated_at TEXT NOT NULL
   );`,
  // Repository checks: a notice is a second delivery route for the staged report, recorded like a manager attempt (checks/notice.ts).
  // `tick_id` is the original staged tick and the idempotency key at the receiver; `ticks.notices` counts reports delivered as a notice.
  (db: PluginDatabase) => {
    db.exec(`CREATE TABLE IF NOT EXISTS checks_notice_attempts (
     attempt_id TEXT PRIMARY KEY,
     tracker_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     report_id TEXT NOT NULL,
     tick_id TEXT NOT NULL,
     bb_project_id TEXT NOT NULL,
     manager_thread_id TEXT,
     started_at TEXT NOT NULL,
     outcome TEXT NOT NULL CHECK (outcome IN ('sending', 'accepted', 'refused', 'unavailable', 'unknown', 'superseded')),
     notice_id TEXT,
     accepted_at TEXT,
     error TEXT,
     passes INTEGER NOT NULL DEFAULT 0,
     first_error_at TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_checks_notice_attempts_report ON checks_notice_attempts(tracker_id, report_id, started_at);
   `);
    // Guarded so a re-run of the migrations (a partly reset version table) stays harmless.
    if (!db.prepare<[], { name: string }>("PRAGMA table_info(checks_ticks)").all().some((column) => column.name === "notices")) db.exec("ALTER TABLE checks_ticks ADD COLUMN notices INTEGER NOT NULL DEFAULT 0");
  },
  // Reverse PR-link lookups (snapshot writes, orphan cleanup) start from the identity; the primary key starts with task_id.
  `CREATE INDEX IF NOT EXISTS idx_task_pr_links_identity ON task_pr_links(identity, task_id);`,
  // 0.74.0: the latest return from live to shadow (a `to_shadow` acknowledgement) whose stale-status lines the checks runner has resent
  // (checks/service.ts). Local only, never exported. Seeded with every existing return, so the upgrade alone resends nothing. Acknowledgements
  // that no current mode row has reached go first: a deleted tracker (restored or not) starts its generations over and must not inherit them.
  `CREATE TABLE IF NOT EXISTS checks_stale_rollback (tracker_id TEXT PRIMARY KEY, consumed_generation INTEGER NOT NULL);
   DELETE FROM attention_acks WHERE NOT EXISTS (SELECT 1 FROM attention_modes m WHERE m.tracker_id=attention_acks.tracker_id AND m.kind=attention_acks.kind AND m.effective_generation >= attention_acks.generation);
   INSERT OR IGNORE INTO checks_stale_rollback (tracker_id, consumed_generation)
   SELECT tracker_id, MAX(generation) FROM attention_acks WHERE kind='stale-status' AND direction='to_shadow' GROUP BY tracker_id;`,
  // A closed card's notice goes out only when a turn changed the session's files (closure/service.ts): each turn start
  // reserves a generation and stores the environment's Git fingerprint; its idle compares and records the work fact.
  `ALTER TABLE closure_threads ADD COLUMN turn_generation INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE closure_threads ADD COLUMN turn_baseline TEXT;
   ALTER TABLE closure_threads ADD COLUMN turn_baseline_at TEXT;
   ALTER TABLE closure_threads ADD COLUMN work_seen INTEGER NOT NULL DEFAULT 0 CHECK (work_seen IN (0, 1));`,
  // Linked-PR lifecycle events (git-sync/events.ts). State, once-keys and waits are keyed by the PR's immutable remote id, so a
  // repository rename keeps them; a state row exists only after the first successful observation, which baselines without sending.
  `CREATE TABLE IF NOT EXISTS pr_event_settings (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     events TEXT NOT NULL DEFAULT 'on' CHECK (events IN ('on', 'off')),
     manager TEXT NOT NULL DEFAULT 'off' CHECK (manager IN ('on', 'off'))
   );
   CREATE TABLE IF NOT EXISTS pr_event_state (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     remote_id TEXT NOT NULL,
     initialized_at TEXT NOT NULL,
     verdict_key TEXT,
     queue_entry TEXT,
     queue_seen_at TEXT,
     merge_sha TEXT,
     merge_seen_at TEXT,
     unlinked_at TEXT,
     PRIMARY KEY (project_id, remote_id)
   );
   CREATE TABLE IF NOT EXISTS pr_events (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     remote_id TEXT NOT NULL,
     identity TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('ci', 'queue_removed', 'merged', 'deployed', 'deploy_wait_ended')),
     once_key TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (project_id, remote_id, kind, once_key)
   );
   CREATE TABLE IF NOT EXISTS pr_event_deliveries (
     id TEXT PRIMARY KEY,
     event_id TEXT NOT NULL REFERENCES pr_events(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('session', 'manager')),
     state TEXT NOT NULL,
     thread_id TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     claimed_at TEXT,
     claim_owner TEXT,
     transport_started_at TEXT,
     marker TEXT,
     cursor TEXT,
     searched_at TEXT,
     lookup_failures INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (event_id, task_id, role)
   );
   CREATE INDEX IF NOT EXISTS idx_pr_event_deliveries_state ON pr_event_deliveries(state, created_at);
   CREATE INDEX IF NOT EXISTS idx_pr_event_deliveries_task ON pr_event_deliveries(task_id, created_at);
   CREATE TABLE IF NOT EXISTS pr_deploy_waits (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     remote_id TEXT NOT NULL,
     identity TEXT NOT NULL,
     repository TEXT NOT NULL,
     number INTEGER NOT NULL,
     base_branch TEXT NOT NULL,
     merge_sha TEXT NOT NULL,
     merged_at TEXT NOT NULL,
     deadline TEXT NOT NULL,
     workflows TEXT NOT NULL,
     days INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('waiting', 'satisfied', 'deployed', 'expired', 'unverifiable')),
     baseline_at TEXT,
     walk TEXT,
     kept TEXT NOT NULL DEFAULT '[]',
     found TEXT,
     final_passes INTEGER NOT NULL DEFAULT 0,
     next_sweep_at TEXT,
     settled_at TEXT,
     PRIMARY KEY (project_id, remote_id)
   );`,
  // Orders deployment waits least recently swept first, so a capped sweep gives every wait a turn.
  `ALTER TABLE pr_deploy_waits ADD COLUMN swept_at TEXT;`,
  // A PR message held for an owner keeps its deadline through retries and recovery; an owner designation marks it woken.
  `ALTER TABLE pr_event_deliveries ADD COLUMN held_until TEXT;
   ALTER TABLE pr_event_deliveries ADD COLUMN woken_at TEXT;`,
  // The known queue entry's enqueue time pairs its departure with its own add and removal on the timeline.
  `ALTER TABLE pr_event_state ADD COLUMN queue_enqueued_at TEXT;`,
  `ALTER TABLE projects ADD COLUMN check_readiness TEXT NOT NULL DEFAULT 'off' CHECK (check_readiness IN ('off', 'on'));`,
  `DROP TRIGGER IF EXISTS task_scheduled_status;`,
  `ALTER TABLE projects ADD COLUMN done_requires_review TEXT NOT NULL DEFAULT 'off' CHECK (done_requires_review IN ('off','on'));
   CREATE TABLE task_review_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('status','approval')),
     status TEXT
   );
   CREATE INDEX task_review_log_order ON task_review_log(task_id, id);
   INSERT INTO task_review_log(task_id, kind)
     SELECT task_id, 'approval' FROM comments
     WHERE json_extract(evidence,'$.kind')='review' AND json_extract(evidence,'$.verdict')='approve' ORDER BY rowid;
   INSERT INTO task_review_log(task_id, kind, status) SELECT id, 'status', status FROM tasks;
   CREATE TRIGGER task_review_initial AFTER INSERT ON tasks BEGIN
     INSERT INTO task_review_log(task_id, kind, status) VALUES (NEW.id, 'status', NEW.status);
   END;
   CREATE TRIGGER task_review_status AFTER UPDATE OF status ON tasks WHEN NEW.status <> OLD.status BEGIN
     INSERT INTO task_review_log(task_id, kind, status) VALUES (NEW.id, 'status', NEW.status);
   END;
   CREATE TRIGGER task_review_approval AFTER INSERT ON comments
   WHEN json_extract(NEW.evidence,'$.kind')='review' AND json_extract(NEW.evidence,'$.verdict')='approve' BEGIN
     INSERT INTO task_review_log(task_id, kind) VALUES (NEW.task_id, 'approval');
   END;`,
  `ALTER TABLE projects ADD COLUMN check_receipt TEXT;
   CREATE TABLE check_receipt_verdicts (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     verdict TEXT NOT NULL, task_id TEXT NOT NULL, question_id TEXT NOT NULL,
     revision INTEGER NOT NULL, comment_id TEXT NOT NULL,
     PRIMARY KEY(project_id, verdict)
   );
   CREATE INDEX receipt_verdicts_card ON check_receipt_verdicts(task_id, comment_id);`,
  `ALTER TABLE checks_config ADD COLUMN remote TEXT;`,
  // Pause state and experiment data are local and deliberately excluded from archives.
  `CREATE TABLE task_pauses (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     source TEXT NOT NULL CHECK(source IN ('manual','auto')), signal TEXT NOT NULL,
     thread_id TEXT NOT NULL, reason TEXT NOT NULL, started_at TEXT NOT NULL,
     until TEXT, applied INTEGER NOT NULL CHECK(applied IN (0,1)),
     UNIQUE(task_id, signal, thread_id)
   );
   CREATE UNIQUE INDEX task_pauses_manual ON task_pauses(task_id) WHERE signal='manual';
   CREATE TABLE pause_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT,
     task_key TEXT, at TEXT NOT NULL, event TEXT NOT NULL, source TEXT, signal TEXT,
     end_reason TEXT, thread_id TEXT, previous_threads TEXT, arm TEXT, applied INTEGER,
     until TEXT, detail TEXT
   );
   CREATE INDEX pause_log_project_at ON pause_log(project_id, at);
   CREATE TABLE pause_latches (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, thread_id TEXT NOT NULL,
     release_on TEXT NOT NULL CHECK(release_on IN ('idle','cleared')),
     PRIMARY KEY(task_id, thread_id)
   );
   CREATE TABLE pause_modes (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     mode TEXT NOT NULL CHECK(mode IN ('off','ab','on')), changed_at TEXT NOT NULL
   );
   CREATE TABLE pause_samples (
     at TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, arm TEXT NOT NULL,
     status TEXT NOT NULL, in_scope INTEGER NOT NULL, held INTEGER NOT NULL,
     waiting_owner INTEGER NOT NULL, paused INTEGER NOT NULL, worked INTEGER NOT NULL,
     PRIMARY KEY(project_id, task_id, at)
   );
   CREATE INDEX pause_samples_project_at ON pause_samples(project_id, at);
   ALTER TABLE task_threads ADD COLUMN last_working_at TEXT;
   ALTER TABLE manager_attention ADD COLUMN executor_state TEXT CHECK(executor_state IS NULL OR executor_state IN ('pending','sending','sent','none','failed','unknown'));
   ALTER TABLE manager_attention ADD COLUMN executor_at TEXT;
   CREATE TRIGGER task_pause_status_guard BEFORE UPDATE OF status ON tasks
   WHEN NEW.status <> OLD.status AND EXISTS (
     SELECT 1 FROM task_pauses WHERE task_id=OLD.id AND applied=1 AND signal IN ('manual','background')
   ) BEGIN SELECT RAISE(ABORT, 'end applied pauses before changing status'); END;`,
  `CREATE TABLE pause_sample_runs (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     at TEXT NOT NULL, PRIMARY KEY(project_id,at)
   );`,
  `ALTER TABLE pause_log ADD COLUMN signal_thread_id TEXT;`,
  `CREATE TABLE project_pr_history (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     first_linked_at TEXT NOT NULL
   );
   INSERT OR IGNORE INTO project_pr_history(project_id, first_linked_at)
     SELECT t.project_id, COALESCE(MIN(json_extract(l.payload,'$.createdAt')), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     FROM task_pr_links l JOIN tasks t ON t.id=l.task_id GROUP BY t.project_id;
   CREATE TRIGGER project_pr_history_insert AFTER INSERT ON task_pr_links BEGIN
     INSERT OR IGNORE INTO project_pr_history(project_id, first_linked_at)
       SELECT project_id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks WHERE id=NEW.task_id;
   END;
   CREATE TRIGGER project_pr_history_move AFTER UPDATE OF project_id ON tasks
   WHEN NEW.project_id <> OLD.project_id AND EXISTS(SELECT 1 FROM task_pr_links WHERE task_id=NEW.id) BEGIN
     INSERT OR IGNORE INTO project_pr_history(project_id, first_linked_at)
       VALUES (NEW.project_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
   END;`,
  // Review evidence for Done (local, never exported like task_review_log): author threads, the automatic-review marker,
  // the gate's decision record and an append-only history of PR link roles. The review log learns which comment an approval is.
  (db: PluginDatabase) => {
    db.exec(`
      ALTER TABLE task_review_log ADD COLUMN comment_id TEXT;
      ALTER TABLE task_review_log ADD COLUMN at TEXT;
      DROP TRIGGER task_review_initial;
      DROP TRIGGER task_review_status;
      DROP TRIGGER task_review_approval;
      CREATE TRIGGER task_review_initial AFTER INSERT ON tasks BEGIN
        INSERT INTO task_review_log(task_id, kind, status, at) VALUES (NEW.id, 'status', NEW.status, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER task_review_status AFTER UPDATE OF status ON tasks WHEN NEW.status <> OLD.status BEGIN
        INSERT INTO task_review_log(task_id, kind, status, at) VALUES (NEW.id, 'status', NEW.status, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER task_review_approval AFTER INSERT ON comments
      WHEN (json_extract(NEW.evidence,'$.kind')='review' AND json_extract(NEW.evidence,'$.verdict')='approve')
        OR (json_extract(NEW.evidence,'$.kind')='qa' AND json_extract(NEW.evidence,'$.verdict')='pass') BEGIN
        INSERT INTO task_review_log(task_id, kind, comment_id, at) VALUES (NEW.task_id, 'approval', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TABLE pr_author_threads (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        identity TEXT NOT NULL, thread_id TEXT NOT NULL, first_seen_at TEXT NOT NULL,
        PRIMARY KEY(project_id, identity, thread_id)
      );
      CREATE TABLE pr_review_moves (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        identity TEXT NOT NULL, reviewed_head TEXT, state TEXT NOT NULL CHECK (state IN ('open','not_open')),
        PRIMARY KEY(task_id, identity)
      );
      CREATE TABLE review_gate_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task_id TEXT NOT NULL, mover TEXT NOT NULL,
        path TEXT NOT NULL CHECK (path IN ('A','B')), result TEXT NOT NULL CHECK (result IN ('passed','refused')), detail TEXT NOT NULL
      );
      CREATE INDEX review_gate_decisions_task ON review_gate_decisions(task_id, id);
      CREATE TABLE pr_link_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, identity TEXT NOT NULL, at TEXT NOT NULL,
        role TEXT, confirmed INTEGER NOT NULL, excluded INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX pr_link_history_link ON pr_link_history(task_id, identity, id);
      INSERT INTO pr_link_history(task_id, identity, at, role, confirmed, excluded)
        SELECT task_id, identity, strftime('%Y-%m-%dT%H:%M:%fZ','now'), json_extract(payload,'$.role'),
          COALESCE(json_extract(payload,'$.confirmed'),0), COALESCE(json_extract(payload,'$.excluded'),0) FROM task_pr_links;
      CREATE TRIGGER pr_link_history_insert AFTER INSERT ON task_pr_links BEGIN
        INSERT INTO pr_link_history(task_id, identity, at, role, confirmed, excluded)
        VALUES (NEW.task_id, NEW.identity, strftime('%Y-%m-%dT%H:%M:%fZ','now'), json_extract(NEW.payload,'$.role'),
          COALESCE(json_extract(NEW.payload,'$.confirmed'),0), COALESCE(json_extract(NEW.payload,'$.excluded'),0));
      END;
      CREATE TRIGGER pr_link_history_update AFTER UPDATE ON task_pr_links
      WHEN json_extract(NEW.payload,'$.role') IS NOT json_extract(OLD.payload,'$.role')
        OR COALESCE(json_extract(NEW.payload,'$.confirmed'),0) <> COALESCE(json_extract(OLD.payload,'$.confirmed'),0)
        OR COALESCE(json_extract(NEW.payload,'$.excluded'),0) <> COALESCE(json_extract(OLD.payload,'$.excluded'),0) BEGIN
        INSERT INTO pr_link_history(task_id, identity, at, role, confirmed, excluded)
        VALUES (NEW.task_id, NEW.identity, strftime('%Y-%m-%dT%H:%M:%fZ','now'), json_extract(NEW.payload,'$.role'),
          COALESCE(json_extract(NEW.payload,'$.confirmed'),0), COALESCE(json_extract(NEW.payload,'$.excluded'),0));
      END;
      CREATE TRIGGER pr_link_history_delete AFTER DELETE ON task_pr_links BEGIN
        INSERT INTO pr_link_history(task_id, identity, at, role, confirmed, excluded, deleted)
        VALUES (OLD.task_id, OLD.identity, strftime('%Y-%m-%dT%H:%M:%fZ','now'), json_extract(OLD.payload,'$.role'),
          COALESCE(json_extract(OLD.payload,'$.confirmed'),0), COALESCE(json_extract(OLD.payload,'$.excluded'),0), 1);
      END;
    `);
    backfillApprovalComments(db);
  },
  // Derived: the open checks held back by an earlier failed check of their card (shared/check-flow.ts), so SQL readers can skip them.
  (db: PluginDatabase) => {
    db.exec(CREATE_HOLDS_TABLE);
    rebuildCheckFlow(db);
  },
  // The manual work queue of an executor thread, its change log, the next-card notices, and the queue trial's coverage and samples.
  `CREATE TABLE task_queue (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     position INTEGER NOT NULL CHECK(position >= 1),
     added_by TEXT NOT NULL,
     added_at TEXT NOT NULL
   );
   CREATE INDEX idx_task_queue_thread ON task_queue(project_id, thread_id, position);
   CREATE TABLE task_queue_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     change_id TEXT NOT NULL,
     at TEXT NOT NULL,
     project_id TEXT NOT NULL,
     thread_id TEXT,
     task_id TEXT,
     action TEXT NOT NULL CHECK(action IN ('add','move','remove','advance','mode')),
     actor TEXT NOT NULL,
     cause TEXT,
     old_position INTEGER,
     new_position INTEGER
   );
   CREATE INDEX idx_task_queue_log_project ON task_queue_log(project_id, at);
   CREATE TABLE task_queue_notices (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     from_task TEXT NOT NULL,
     to_task TEXT NOT NULL,
     created_at TEXT NOT NULL,
     state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','unknown')),
     attempts INTEGER NOT NULL DEFAULT 0,
     from_key TEXT NOT NULL,
     reason TEXT NOT NULL
   );
   CREATE TABLE queue_modes (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     mode TEXT NOT NULL CHECK(mode IN ('off','trial','on')),
     changed_at TEXT NOT NULL
   );
   CREATE TABLE queue_trial_coverage (
     at TEXT NOT NULL,
     project_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     arm TEXT NOT NULL,
     interval_ms INTEGER NOT NULL,
     PRIMARY KEY(project_id, thread_id, at)
   );
   CREATE TABLE queue_trial_samples (
     at TEXT NOT NULL,
     project_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     status TEXT NOT NULL,
     linked INTEGER NOT NULL,
     queue_position INTEGER,
     PRIMARY KEY(project_id, thread_id, task_id, at)
   );
   CREATE INDEX idx_queue_trial_samples_task ON queue_trial_samples(task_id, at);
   ALTER TABLE task_dependencies ADD COLUMN created_at TEXT;
   -- When the queue shipped: the trial window and its pre-release baseline are anchored here (a later project starts at its creation).
   CREATE TABLE queue_rollout (id INTEGER PRIMARY KEY CHECK(id=1), at TEXT NOT NULL);
   INSERT INTO queue_rollout(id, at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
   CREATE TABLE queue_trial_scans (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, at TEXT NOT NULL);`,
] as const;

/** Approval rows written before the comment id existed: the N-th row is the N-th approving review comment, only where the counts agree. */
export function backfillApprovalComments(db: PluginDatabase): void {
  const cards = db.prepare<[], { task_id: string }>("SELECT DISTINCT task_id FROM task_review_log WHERE kind='approval' AND comment_id IS NULL").all();
  const rows = db.prepare<[string], { id: number }>("SELECT id FROM task_review_log WHERE task_id=? AND kind='approval' ORDER BY id");
  const comments = db.prepare<[string], { id: string }>(
    "SELECT id FROM comments WHERE task_id=? AND json_extract(evidence,'$.kind')='review' AND json_extract(evidence,'$.verdict')='approve' ORDER BY rowid");
  const set = db.prepare<[string, number]>("UPDATE task_review_log SET comment_id=? WHERE id=?");
  for (const { task_id } of cards) {
    const log = rows.all(task_id), found = comments.all(task_id);
    if (log.length === found.length) log.forEach((row, index) => set.run(found[index]!.id, row.id));
  }
}

export function initializeTasksSchema(db: PluginDatabase, log: Log = () => {}): void {
  db.pragma("foreign_keys = ON");
  // A large transaction must not retain its peak WAL allocation after checkpoints can reset it.
  db.pragma("journal_size_limit = 4194304");
  // Fresh databases can reclaim pages incrementally without a blocking rebuild during startup.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) db.pragma("auto_vacuum = INCREMENTAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const hasVersion = db.prepare<[number], { found: number }>(
    "SELECT 1 AS found FROM schema_version WHERE version = ?",
  );
  const recordVersion = db.prepare<[number, string]>(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
  );

  const migrate = db.transaction(() => {
    for (const [index, sql] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (hasVersion.get(version)) continue;
      if (typeof sql === "string") db.exec(sql);
      else sql(db, log);
      recordVersion.run(version, new Date().toISOString());
    }
  });

  // Rebuilding tasks (12) or projects (29) must preserve the rows that reference them.
  const rebuilding = !hasVersion.get(12) || !hasVersion.get(29);
  if (rebuilding) db.pragma("foreign_keys = OFF");
  try {
    migrate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
