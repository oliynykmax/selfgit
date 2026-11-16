import { DurableObject } from "cloudflare:workers";

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS repositories (name TEXT PRIMARY KEY) WITHOUT ROWID");
  }

  list(): string[] {
    return [...this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM repositories ORDER BY name")].map((row) => row.name);
  }

  exists(name: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM repositories WHERE name = ?", name).toArray().length > 0;
  }

  create(name: string): boolean {
    return this.ctx.storage.sql.exec("INSERT OR IGNORE INTO repositories (name) VALUES (?)", name).rowsWritten === 1;
  }

}
