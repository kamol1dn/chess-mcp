import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GameRecord } from './game-record.js';

/** Durable storage for games: one row per game, the record kept as JSON. */
export class GameStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_updated ON games(updated_at DESC);
      CREATE INDEX IF NOT EXISTS games_status ON games(status);
    `);
  }

  save(game: GameRecord): void {
    this.db
      .prepare(
        `INSERT INTO games (id, created_at, updated_at, status, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status, data = excluded.data`,
      )
      .run(game.id, game.createdAt, game.updatedAt, game.status, JSON.stringify(game));
  }

  get(id: string): GameRecord | null {
    const row = this.db.prepare('SELECT data FROM games WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as GameRecord) : null;
  }

  listActive(): GameRecord[] {
    const rows = this.db.prepare("SELECT data FROM games WHERE status = 'active'").all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as GameRecord);
  }

  list(opts: { status?: 'active' | 'finished'; limit: number; offset: number }): GameRecord[] {
    const where = opts.status ? 'WHERE status = ?' : '';
    const params: Array<string | number> = opts.status ? [opts.status] : [];
    const rows = this.db
      .prepare(`SELECT data FROM games ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit, opts.offset) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as GameRecord);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes > 0;
  }

  ping(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  close(): void {
    this.db.close();
  }
}
