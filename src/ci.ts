export const PIPELINE_REPO = "selfgit";
export const MAIN = "refs/heads/main";
export type JobKind = "ci" | "backup";
export type Job = { id: number; kind: JobKind; commit_oid: string; state: string; lease_token: string | null; lease_until: number | null; log: string; created_at: number; finished_at: number | null };

export class CiQueue {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ci_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, commit_oid TEXT NOT NULL,
      state TEXT NOT NULL, lease_token TEXT, lease_until INTEGER, log TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, finished_at INTEGER
    )`);
  }
  enqueue(oid: string) {
    this.sql.exec("UPDATE ci_jobs SET state = 'superseded', finished_at = ?, lease_token = NULL, lease_until = NULL WHERE kind = 'ci' AND state IN ('queued', 'leased')", Date.now());
    for (const kind of ["ci", "backup"]) this.sql.exec("INSERT INTO ci_jobs (kind, commit_oid, state, created_at) VALUES (?, ?, 'queued', ?)", kind, oid, Date.now());
  }
  claim(kind: JobKind, now: number) {
    this.sql.exec("UPDATE ci_jobs SET state = 'queued', lease_token = NULL, lease_until = NULL WHERE kind = ? AND state = 'leased' AND lease_until <= ?", kind, now);
    if (kind === "ci") this.sql.exec("UPDATE ci_jobs SET state = 'superseded', finished_at = ?, lease_token = NULL, lease_until = NULL WHERE kind = 'ci' AND state IN ('queued', 'leased') AND commit_oid != coalesce((SELECT oid FROM refs WHERE name = 'refs/heads/main'), '')", now);
    if (this.sql.exec("SELECT id FROM ci_jobs WHERE kind = ? AND state = 'leased' LIMIT 1", kind).toArray().length) return null;
    const job = this.sql.exec<Job>("SELECT * FROM ci_jobs WHERE kind = ? AND state = 'queued' ORDER BY id LIMIT 1", kind).toArray()[0];
    if (!job) return null;
    const token = crypto.randomUUID();
    this.sql.exec("UPDATE ci_jobs SET state = 'leased', lease_token = ?, lease_until = ? WHERE id = ?", token, now + 15 * 60_000, job.id);
    return { id: job.id, kind: job.kind, commit: job.commit_oid, leaseToken: token, leaseUntil: now + 15 * 60_000, ...(job.kind === "backup" ? { target: "oliynykmax/selfgit" } : {}) };
  }
  log(id: number, token: string, text: string, now: number) {
    this.sql.exec("UPDATE ci_jobs SET log = substr(log || ?, -65536) WHERE id = ? AND state = 'leased' AND lease_token = ? AND lease_until > ?", text, id, token, now);
    return this.sql.exec<{ n: number }>("SELECT changes() AS n").one().n === 1;
  }
  heartbeat(id: number, token: string, now: number) {
    this.sql.exec("UPDATE ci_jobs SET lease_until = ? WHERE id = ? AND state = 'leased' AND lease_token = ? AND lease_until > ?", now + 15 * 60_000, id, token, now);
    return this.sql.exec<{ n: number }>("SELECT changes() AS n").one().n === 1;
  }
  finish(id: number, token: string, success: boolean, now: number) {
    this.sql.exec("UPDATE ci_jobs SET state = CASE WHEN kind = 'ci' AND commit_oid != coalesce((SELECT oid FROM refs WHERE name = 'refs/heads/main'), '') THEN 'superseded' WHEN ? THEN 'succeeded' ELSE 'failed' END, finished_at = ?, lease_token = NULL, lease_until = NULL WHERE id = ? AND state = 'leased' AND lease_token = ? AND lease_until > ?", success ? 1 : 0, now, id, token, now);
    return this.sql.exec<{ n: number }>("SELECT changes() AS n").one().n === 1;
  }
  runs() {
    return this.sql.exec("SELECT id, kind, commit_oid, state, created_at, finished_at FROM ci_jobs ORDER BY id DESC LIMIT 100").toArray();
  }
}
