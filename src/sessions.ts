import { DurableObject } from "cloudflare:workers";

export interface SessionUser {
  userId: number;
  login: string;
  avatarUrl: string;
}

/** What the OAuth code needs from session storage, so tests can supply an in-memory one. */
export interface SessionStore {
  create(idHash: string, user: SessionUser, expiresAt: number): Promise<void>;
  get(idHash: string, now: number): Promise<SessionUser | null>;
  delete(idHash: string): Promise<void>;
}

/** Browser sessions, keyed by the SHA-256 of the cookie value so a storage read never reveals a usable cookie. */
export class Sessions extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      login TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
  }

  async create(idHash: string, user: SessionUser, expiresAt: number): Promise<void> {
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
    this.sql.exec(
      "INSERT INTO sessions (id_hash, user_id, login, avatar_url, expires_at) VALUES (?, ?, ?, ?, ?)",
      idHash,
      user.userId,
      user.login,
      user.avatarUrl,
      expiresAt,
    );
  }

  async get(idHash: string, now: number): Promise<SessionUser | null> {
    const row = this.sql
      .exec<{ user_id: number; login: string; avatar_url: string }>(
        "SELECT user_id, login, avatar_url FROM sessions WHERE id_hash = ? AND expires_at > ?",
        idHash,
        now,
      )
      .toArray()[0];
    return row ? { userId: row.user_id, login: row.login, avatarUrl: row.avatar_url } : null;
  }

  async delete(idHash: string): Promise<void> {
    this.sql.exec("DELETE FROM sessions WHERE id_hash = ?", idHash);
  }
}
