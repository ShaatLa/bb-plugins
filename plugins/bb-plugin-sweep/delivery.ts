import type Database from "better-sqlite3";

// Pending message and snapshot share one durable row; promotion is atomic.
export function deliveryStore(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery (project TEXT PRIMARY KEY, committed BLOB, pending_message TEXT, pending_snapshot BLOB)`);
  return {
    read(project: string) {
      return db.prepare("SELECT committed, pending_message, pending_snapshot FROM delivery WHERE project = ?").get(project) as { committed: Buffer | null; pending_message: string | null; pending_snapshot: Buffer | null } | undefined;
    },
    stage(project: string, message: string, snapshot: Buffer | null) {
      const result = db.prepare(`INSERT INTO delivery (project, pending_message, pending_snapshot) VALUES (?, ?, ?)
        ON CONFLICT(project) DO UPDATE SET pending_message = excluded.pending_message, pending_snapshot = excluded.pending_snapshot
        WHERE delivery.pending_message IS NULL`).run(project, message, snapshot);
      if (!result.changes) throw new Error("A delivery is already pending");
    },
    seed(project: string, snapshot: Buffer) {
      const result = db.prepare(`INSERT INTO delivery (project, committed) VALUES (?, ?)
        ON CONFLICT(project) DO UPDATE SET committed = excluded.committed
        WHERE delivery.committed IS NULL AND delivery.pending_message IS NULL`).run(project, snapshot);
      if (!result.changes) throw new Error("Committed state or a pending report already exists. Skip the import and use the existing state. Check bb sweep status for a pending report.");
    },
    /** Replaces the committed bytes (or clears them) for a transfer; refused while a report is pending. */
    replace(project: string, snapshot: Buffer | null) {
      const result = db.prepare(`INSERT INTO delivery (project, committed) VALUES (?, ?)
        ON CONFLICT(project) DO UPDATE SET committed = excluded.committed WHERE delivery.pending_message IS NULL`).run(project, snapshot);
      if (!result.changes) throw new Error("A report is pending. Let it deliver before replacing committed state.");
    },
    acknowledge(project: string) {
      const result = db.prepare(`UPDATE delivery SET committed = COALESCE(pending_snapshot, committed), pending_message = NULL, pending_snapshot = NULL
        WHERE project = ? AND pending_message IS NOT NULL`).run(project);
      if (!result.changes) throw new Error("No delivery is pending");
    },
  };
}
