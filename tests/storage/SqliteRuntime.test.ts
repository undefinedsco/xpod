import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteRuntime, getSqliteRuntime, resolveDefaultSqliteRuntimeKind } from '@undefineds.co/xpod-afs/sqlite/SqliteRuntime';
import { getSqliteRuntime as serverRuntime } from '../../src/storage/SqliteRuntime';

const execFileAsync = promisify(execFile);

describe('Sqlite runtime selection through the public package boundary', () => {
  const originalRuntime = process.env.XPOD_SQLITE_RUNTIME;
  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.XPOD_SQLITE_RUNTIME;
    else process.env.XPOD_SQLITE_RUNTIME = originalRuntime;
  });

  it('resolves and opens the native Node runtime outside Bun', () => {
    delete process.env.XPOD_SQLITE_RUNTIME;
    expect(resolveDefaultSqliteRuntimeKind()).toBe('node-sqlite');
    const runtime = createSqliteRuntime();
    expect(runtime.kind).toBe('node-sqlite');
    const db = runtime.openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE proof (id INTEGER); INSERT INTO proof VALUES (7)');
      expect(db.prepare<{ id: number }>('SELECT id FROM proof').get()?.id).toBe(7);
    } finally { db.close(); }
  });

  it('resolves and opens the real Bun runtime through the same public entry', async () => {
    const { stdout } = await execFileAsync('bun', ['--no-env-file', '-e', [
      "import { createSqliteRuntime, resolveDefaultSqliteRuntimeKind } from '@undefineds.co/xpod-afs/sqlite/SqliteRuntime';",
      'delete process.env.XPOD_SQLITE_RUNTIME;',
      "const runtime = createSqliteRuntime(); const db = runtime.openDatabase(':memory:');",
      "db.exec('CREATE TABLE proof (id INTEGER); INSERT INTO proof VALUES (7)');",
      "const id = db.prepare('SELECT id FROM proof').get().id; db.close();",
      'console.log(JSON.stringify({kind: runtime.kind, selected: resolveDefaultSqliteRuntimeKind(), id}));',
    ].join('\n')], { env: { ...process.env, NODE_PATH: '' } });
    expect(JSON.parse(stdout.trim())).toEqual({ kind: 'bun-sqlite', selected: 'bun-sqlite', id: 7 });
  });

  it('respects an explicit Node runtime selection', () => {
    process.env.XPOD_SQLITE_RUNTIME = 'node-sqlite';
    expect(resolveDefaultSqliteRuntimeKind()).toBe('node-sqlite');
    expect(createSqliteRuntime().kind).toBe('node-sqlite');
  });

  it('shares its cached runtime across public and server adapter consumers', () => {
    expect(getSqliteRuntime()).toBe(getSqliteRuntime());
    expect(getSqliteRuntime).toBe(serverRuntime);
    expect(getSqliteRuntime()).toBe(serverRuntime());
  });
});
