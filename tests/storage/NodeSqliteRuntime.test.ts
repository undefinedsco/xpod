import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { cleanupSqliteFiles, getTestDbPath } from '../utils/sqlite';
import { createSqliteRuntime } from '../../src/storage/SqliteRuntime';

describe('node:sqlite runtime backend', () => {
  let dbPath: string | undefined;

  afterEach(() => {
    if (dbPath) {
      cleanupSqliteFiles(dbPath);
      dbPath = undefined;
    }
  });

  it('supports direct SQL and drizzle database access', () => {
    const runtime = createSqliteRuntime('node-sqlite');
    dbPath = getTestDbPath('node-sqlite-runtime');
    const sqlite = runtime.openDatabase(dbPath);

    sqlite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    sqlite.prepare('INSERT INTO users (name) VALUES (?)').run('alice');

    const row = sqlite.prepare<{ id: number; name: string }>('SELECT id, name FROM users WHERE id = ?').get(1);
    expect(row).toEqual({ id: 1, name: 'alice' });

    const db = runtime.createDrizzleDatabase(sqlite);
    const rows = db.all<{ id: number; name: string }>(sql`SELECT id, name FROM users ORDER BY id`);
    expect(rows).toEqual([{ id: 1, name: 'alice' }]);

    db.run(sql`INSERT INTO users (name) VALUES ('bob')`);
    const values = db.all(sql`SELECT name FROM users ORDER BY id`);
    expect(values).toEqual([{ name: 'alice' }, { name: 'bob' }]);

    sqlite.close();
  });
});
