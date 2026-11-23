import type { CommitDetail } from "./api-types";

/**
 * Parsed commits kept in the repository's SQLite storage. Reading one from R2 costs a round trip (and often
 * a delta chain), and walking history needs them one after another, so a cold history page took seconds.
 * Commits are immutable, so an entry never goes stale.
 */
export class CommitCache {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS commit_cache (oid TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }

  get(oid: string): CommitDetail | undefined {
    const row = this.sql
      .exec<{ data: string }>(
        "SELECT data FROM commit_cache WHERE oid = ?",
        oid,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.data) as CommitDetail) : undefined;
  }

  put(commit: CommitDetail): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO commit_cache (oid, data) VALUES (?, ?)",
      commit.oid,
      JSON.stringify(commit),
    );
  }

  clear(): void {
    this.sql.exec("DELETE FROM commit_cache");
  }
}
