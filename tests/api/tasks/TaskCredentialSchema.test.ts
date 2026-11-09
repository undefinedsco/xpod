import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { ensureTaskCredentialTables } from '../../../src/api/tasks/TaskCredentialSchema';
import { getSqliteRuntime } from '../../../src/storage/SqliteRuntime';

/** Render a Drizzle SQL object to its text so the fake executor can assert on statements. */
function sqlText(query: any): string {
  const chunks = query?.queryChunks ?? [];
  return chunks
    .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join('') : String(chunk)))
    .join('');
}

describe('ensureTaskCredentialTables', () => {
  it('creates the SQLite table and index idempotently', () => {
    const runtime = getSqliteRuntime();
    const sqlite = runtime.openDatabase(':memory:');
    const db = runtime.createDrizzleDatabase(sqlite);
    try {
      // The initializer is synchronous on SQLite; two calls must not throw or duplicate objects.
      expect(() => {
        void ensureTaskCredentialTables(db);
        void ensureTaskCredentialTables(db);
      }).not.toThrow();
      expect(sqlite.prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_credential'",
      ).all()).toHaveLength(1);
      expect(sqlite.prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'task_credential_owner'",
      ).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it('runs PostgreSQL table and index DDL inside one advisory-locked transaction', async () => {
    const executed: string[] = [];
    const transaction = async (callback: (tx: any) => Promise<void>): Promise<void> => {
      const tx = { execute: async (query: any) => { executed.push(sqlText(query)); } };
      await callback(tx);
    };

    await ensureTaskCredentialTables({ transaction });

    expect(executed).toHaveLength(3);
    expect(executed[0]).toContain('pg_advisory_xact_lock');
    expect(executed[0]).toContain('xpod_task_credential_schema');
    expect(executed[1]).toContain('CREATE TABLE IF NOT EXISTS task_credential');
    expect(executed[2]).toContain('CREATE INDEX IF NOT EXISTS task_credential_owner');
  });

  it('rolls the PostgreSQL transaction back and propagates when DDL fails', async () => {
    const events: string[] = [];
    let committed = false;
    let rolledBack = false;
    const transaction = async (callback: (tx: any) => Promise<void>): Promise<void> => {
      const tx = {
        execute: async (query: any) => {
          const text = sqlText(query);
          events.push(text);
          if (text.includes('CREATE INDEX')) {
            throw new Error('index_bootstrap_failed');
          }
        },
      };
      try {
        await callback(tx);
        committed = true;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    };

    await expect(ensureTaskCredentialTables({ transaction })).rejects.toThrow('index_bootstrap_failed');

    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
    // The advisory lock and table DDL ran before the failure, but nothing committed.
    expect(events[0]).toContain('pg_advisory_xact_lock');
    expect(events.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS task_credential'))).toBe(true);
  });
});
