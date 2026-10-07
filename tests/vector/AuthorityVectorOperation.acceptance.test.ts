// Root-owned actual SQLite/vector public behavior. Fixture peers are not a production Gateway qualification.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([ promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned vector fixture exceeded 5s')), 5000);
    }) ]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const parent = path.resolve('.test-data/authority-vector-operation');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const operations = new LocalPhysicalOperationService(path.join(directory, 'authority'));
  // An index location different from the authority root must use the injected canonical domain.
  const index = path.join(directory, 'separate-index-location', 'vectors.sqlite');
  const options = { connectionString: index, operationService: operations };
  const store = new SqliteVectorStore(options);
  return { directory, operations, index, store, cleanup: async () => {
    await store.close().catch(() => undefined);
    await operations.close();
    await rm(directory, { recursive: true, force: true });
    for (const suffix of [ '', '-wal', '-shm' ]) {
      await rm(operations.databasePath + suffix, { force: true });
    }
  } };
}

const embedding = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);

it.each([ 'bun', 'node' ] as const)('actual %s peer excludes fresh vector database creation, then healthy CRUD/search succeeds', async runtime => {
  const context = await fixture();
  const open = runtime === 'bun'
    ? "new (require('bun:sqlite').Database)(process.argv[1])"
    : "new (require('node:sqlite').DatabaseSync)(process.argv[1])";
  const owner = spawn(runtime, [ '-e', `const db = ${open};
    db.exec('PRAGMA busy_timeout=0'); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready');
    process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });`,
  context.operations.databasePath ], { stdio: [ 'pipe', 'pipe', 'pipe' ] });
  const closed = new Promise<number | null>((resolve, reject) => {
    owner.once('error', reject); owner.once('close', resolve);
  });
  const ready = new Promise<void>((resolve, reject) => {
    owner.stdout.once('data', data => String(data) === 'ready' ? resolve() : reject(new Error('Bad peer handshake')));
    owner.once('error', reject); owner.once('close', () => reject(new Error('Peer closed before readiness')));
  });
  let observation: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
  try {
    await within(ready);
    expect(existsSync(context.index)).toBe(false);
    let settled = false;
    observation = context.store.getVector('root-vector', 41).then(
      value => { settled = true; return { ok: true as const, value }; },
      error => { settled = true; return { ok: false as const, error }; },
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled, 'read cannot resolve or reject through SQL before canonical admission').toBe(false);
    expect(existsSync(context.index), 'no lazy database producer before canonical admission').toBe(false);
    owner.stdin.write('release');
    expect(await within(closed)).toBe(0);
    expect(await within(observation)).toEqual({ ok: true, value: null });
    await context.store.ensureVectorTable('root-vector');
    await context.store.upsertVector('root-vector', 41, embedding);
    expect((await context.store.getVector('root-vector', 41))?.embedding).toEqual(embedding);
    expect(await context.store.countVectors('root-vector')).toBe(1);
    expect((await context.store.search('root-vector', embedding, { limit: 1 }))[0]?.id).toBe(41);
    await context.store.deleteVector('root-vector', 41);
    expect(await context.store.countVectors('root-vector')).toBe(0);
    expect(authoritySqlitePeerAdmission(runtime, context.operations.databasePath)).toBe(true);
  } finally {
    if (owner.exitCode === null) { owner.stdin.write('release'); }
    expect(await within(closed)).toBe(0);
    await observation;
    await context.cleanup();
  }
}, 20_000);

it('stopped physical owner cannot become successful empty vector results or lazily open another SQL incarnation', async () => {
  const context = await fixture();
  try {
    await context.operations.close();
    const publicReads = [
      () => context.store.getVector('root-vector', 41),
      () => context.store.countVectors('root-vector'),
      () => context.store.listVectorTables(),
      () => context.store.getVectorIds('root-vector'),
      () => context.store.hasVectorTable('root-vector'),
    ];
    for (const read of publicReads) {
      await expect(read()).rejects.toMatchObject({ statusCode: 503 });
      expect(existsSync(context.index)).toBe(false);
    }
  } finally { await context.cleanup(); }
}, 20_000);

it('vector component close preserves another genuine operation on the shared owner', async () => {
  const context = await fixture();
  try {
    await context.store.ensureVectorTable('root-vector');
    await context.store.upsertVector('root-vector', 41, embedding);
    await context.store.close();
    await expect(context.operations.run(() => {
      expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(false);
      return 'other-component-healthy';
    })).resolves.toBe('other-component-healthy');
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(true);
  } finally { await context.cleanup(); }
}, 20_000);
