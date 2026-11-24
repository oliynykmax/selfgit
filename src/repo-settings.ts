export interface StoredSettings {
  /** Full ref of the configured default branch, like "refs/heads/trunk", or null to follow the fallback. */
  defaultBranch: string | null;
  description: string;
}

export const NO_SETTINGS: StoredSettings = {
  defaultBranch: null,
  description: "",
};

/** Per-repository settings in the Repository Durable Object's SQLite storage: one row, absent until first saved. */
export class RepoSettingsStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_settings (id INTEGER PRIMARY KEY CHECK (id = 1), default_branch TEXT, description TEXT NOT NULL DEFAULT '')",
    );
  }

  get(): StoredSettings {
    const row = this.sql
      .exec<{ default_branch: string | null; description: string }>(
        "SELECT default_branch, description FROM repo_settings WHERE id = 1",
      )
      .toArray()[0];
    return row
      ? { defaultBranch: row.default_branch, description: row.description }
      : NO_SETTINGS;
  }

  set(settings: StoredSettings): void {
    this.sql.exec(
      "INSERT INTO repo_settings (id, default_branch, description) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET default_branch = excluded.default_branch, description = excluded.description",
      settings.defaultBranch,
      settings.description,
    );
  }

  clear(): void {
    this.sql.exec("DELETE FROM repo_settings");
  }
}
