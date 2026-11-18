// Test-only: 200,000 calls (10 per active thread-hour), 120 days, 3,000 threads.
import type { Database } from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';
export function fixture(db: Database, now: number) {
  for (const sql of MIGRATIONS) db.exec(sql);
  const thread = db.prepare('INSERT INTO threads(id,parent_id,lifecycle_owner_id) VALUES (?,?,?)');
  const hourly = db.prepare(`INSERT INTO usage_hourly(hour,provider,model,thread_id,calls,fresh_in,cache_read,output) VALUES (?,?,?,?,1,1000,2000,100) ON CONFLICT DO UPDATE SET calls=calls+1,fresh_in=fresh_in+1000,cache_read=cache_read+2000,output=output+100`);
  const end = Math.floor(now/3_600_000)*3_600_000;
  db.transaction(() => {
    for (let i=0;i<3000;i++) thread.run(`t${i}`,i%15 ? `t${i-i%15}` : '', i%15===2 ? `t${i-1}` : '');
    for (let i=0;i<200_000;i++) {
      const j=Math.floor(i/10);
      hourly.run(end-(j%2880)*3_600_000,j%2 ? 'claude-code' : 'codex',j%2 ? 'claude-sonnet-5-5' : 'gpt-6.1-sol',`t${(j*17+Math.floor(j/2880))%3000}`);
    }
    db.exec(`INSERT INTO thread_tokens(thread_id,provider,model,tier,band,calls,fresh_in,cache_read,output,first_ts,last_ts)
      SELECT thread_id,provider,model,tier,band,SUM(calls),SUM(fresh_in),SUM(cache_read),SUM(output),MIN(hour),MAX(hour) FROM usage_hourly GROUP BY thread_id,provider,model,tier,band`);
  })();
}
