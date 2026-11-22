/** Test helper: records every statement a database runs, with its bindings, so a test can EXPLAIN the production SQL itself. */
export interface CapturedStatement { sql: string; args: unknown[] }
type Db = { prepare: (sql: string) => any };

export function captureStatements(db: Db) {
  const calls: CapturedStatement[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    for (const method of ["get", "all", "run", "iterate"]) {
      const original = statement[method].bind(statement);
      statement[method] = (...args: unknown[]) => { calls.push({ sql, args }); return original(...args); };
    }
    return statement;
  };
  return {
    /** Statements captured since the last call to `take`; stops nothing, only clears the list. */
    take: (): CapturedStatement[] => calls.splice(0),
    restore: () => { db.prepare = prepare; },
    /** The full query plan of a captured statement, run with its own bindings (nested lines kept). */
    plan: (call: CapturedStatement): string => prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args).map((row: { detail: string }) => row.detail).join("\n"),
  };
}
