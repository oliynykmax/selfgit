import { DurableObject } from "cloudflare:workers";

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS repositories (name TEXT PRIMARY KEY) WITHOUT ROWID",
    );
    const columns = ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(repositories)")
      .toArray();
    if (!columns.some((column) => column.name === "deleting"))
      ctx.storage.sql.exec(
        "ALTER TABLE repositories ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0",
      );
  }

  list(): string[] {
    return [
      ...this.ctx.storage.sql.exec<{ name: string }>(
        "SELECT name FROM repositories WHERE deleting = 0 ORDER BY name",
      ),
    ].map((row) => row.name);
  }

  exists(name: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM repositories WHERE name = ? AND deleting = 0",
          name,
        )
        .toArray().length > 0
    );
  }

  create(name: string): boolean {
    return (
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO repositories (name) VALUES (?)",
        name,
      ).rowsWritten === 1
    );
  }

  beginDelete(name: string): boolean {
    this.ctx.storage.sql.exec(
      "UPDATE repositories SET deleting = 1 WHERE name = ?",
      name,
    );
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM repositories WHERE name = ?", name)
        .toArray().length > 0
    );
  }
}
