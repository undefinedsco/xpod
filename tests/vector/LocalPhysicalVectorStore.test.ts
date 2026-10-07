import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

const embedding = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
const model = 'own-vector';
const methods: Array<[string, (store: SqliteVectorStore) => Promise<unknown>]> = [
  ['initialize', store => store.initialize()], ['finalize', store => store.finalize()],
  ['open', store => store.open()], ['close', store => store.close()],
  ['ensure', store => store.ensureVectorTable(model)], ['drop', store => store.dropVectorTable(model)],
  ['has', store => store.hasVectorTable(model)], ['list', store => store.listVectorTables()],
  ['upsert', store => store.upsertVector(model, 42, embedding)],
  ['batch-upsert', store => store.batchUpsertVectors(model, [{ id: 42, embedding }])],
  ['get', store => store.getVector(model, 41)], ['delete', store => store.deleteVector(model, 41)],
  ['batch-delete', store => store.batchDeleteVectors(model, [41])],
  ['search', store => store.search(model, embedding)], ['count', store => store.countVectors(model)],
  ['ids', store => store.getVectorIds(model)],
];
async function fixture() {
  await mkdir('.test-data/local-vector-store', { recursive: true });
  const directory = await mkdtemp(path.resolve('.test-data/local-vector-store/own-'));
  const service = new LocalPhysicalOperationService(path.join(directory, 'authority'));
  const store = new SqliteVectorStore({ connectionString: path.join(directory, 'separate-index', 'vector.sqlite'), operationService: service });
  return { directory, service, store, cleanup: async () => { await store.close().catch(() => undefined); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

it.each(['bun', 'node'] as const)('all public vector SQL/lifecycle entries wait for an actual %s canonical peer', async runtime => {
  for (const [name, invoke] of methods) {
    const context = await fixture();
    await context.store.ensureVectorTable(model);
    await context.store.upsertVector(model, 41, embedding);
    const open = runtime === 'bun' ? "new(require('bun:sqlite').Database)(process.argv[1])" : "new(require('node:sqlite').DatabaseSync)(process.argv[1])";
    const owner = spawn(runtime, ['-e', `const db=${open}; db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready'); process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0)});`, context.service.databasePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<number | null>((resolve, reject) => { owner.once('close', resolve); owner.once('error', reject); });
    let work: Promise<unknown> | undefined;
    try {
      await new Promise<void>((resolve, reject) => { owner.stdout.once('data', () => resolve()); owner.once('error', reject); });
      let settled = false;
      work = invoke(context.store).finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled, name).toBe(false);
      owner.stdin.write('release');
      expect(await closed).toBe(0);
      await work;
      expect(authoritySqlitePeerAdmission(runtime, context.service.databasePath), name).toBe(true);
    } finally {
      if (owner.exitCode === null) { owner.stdin.write('release'); }
      await closed; await work; await context.cleanup();
    }
  }
}, 30_000);

it('healthy real vectors preserve CRUD, batch/search/id selection and terminal protected close', async () => {
  const { service, store, cleanup } = await fixture();
  try {
    await store.initialize(); await store.ensureVectorTable(model);
    await store.batchUpsertVectors(model, [{ id: 41, embedding }, { id: 42, embedding }]);
    expect(await store.countVectors(model)).toBe(2);
    expect((await store.getVector(model, 41))?.embedding).toEqual(embedding);
    expect(await store.getVectorIds(model, { afterId: 41 })).toEqual([42]);
    expect((await store.search(model, embedding, { excludeIds: new Set([42]) }))[0].id).toBe(41);
    await store.batchDeleteVectors(model, [42]); await store.deleteVector(model, 41);
    expect(await store.countVectors(model)).toBe(0);
    expect(await store.hasVectorTable(model)).toBe(true); expect(await store.listVectorTables()).toHaveLength(1);
    await store.dropVectorTable(model); expect(await store.hasVectorTable(model)).toBe(false);
    await store.close(); await store.finalize();
    await expect(store.open()).rejects.toMatchObject({ statusCode: 503 });
    await expect(store.countVectors(model)).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.run(() => 'other-owner')).resolves.toBe('other-owner');
  } finally { await cleanup(); }
});

it('stopped owner refuses empty batches before no-op success', async () => {
  const { service, store, cleanup } = await fixture();
  try {
    await service.close();
    await expect(store.batchUpsertVectors(model, [])).rejects.toMatchObject({ statusCode: 503 });
    await expect(store.batchDeleteVectors(model, [])).rejects.toMatchObject({ statusCode: 503 });
  } finally { await cleanup(); }
});

it('standalone memory store retains its original reopen contract', async () => {
  const store = new SqliteVectorStore({ connectionString: ':memory:' });
  try { await store.ensureVectorTable(model); await store.close(); await store.ensureVectorTable(model); expect(await store.countVectors(model)).toBe(0); }
  finally { await store.close(); }
});

it.each(['node', 'bun'] as const)('actual %s runtime qualifies vector resources with explicit fixture-only SQLite choice', async runtime => {
  const { directory, service, cleanup } = await fixture();
  try {
    let preload = '';
    if (runtime === 'bun' && process.platform === 'darwin') {
      // Discover an existing test library; this is explicit fixture setup, never product fallback/configuration.
      const prefix = spawnSync('brew', ['--prefix', 'sqlite'], { encoding: 'utf8' });
      expect(prefix.status, prefix.stderr).toBe(0);
      const library = path.join(prefix.stdout.trim(), 'lib', 'libsqlite3.dylib');
      preload = `if(!require('bun:sqlite').Database.setCustomSQLite(${JSON.stringify(library)}))throw Error('explicit fixture SQLite failed');`;
    }
    const code = `${preload}const {SqliteVectorStore}=require('./dist/storage/vector/SqliteVectorStore.js');
      const {LocalPhysicalOperationService}=require('./dist/storage/LocalPhysicalOperationService.js');
      const assert=require('node:assert/strict');
      (async()=>{const service=new LocalPhysicalOperationService(process.argv[1]);const store=new SqliteVectorStore({connectionString:process.argv[2],operationService:service});
        const v=Array.from({length:768},(_,i)=>i===0?1:0);await store.ensureVectorTable('real');await store.upsertVector('real',41,v);
        assert.equal(await store.countVectors('real'),1);assert.deepEqual((await store.getVector('real',41)).embedding,v);assert.equal((await store.search('real',v))[0].id,41);
        await service.close();await assert.rejects(store.countVectors('real'),e=>e.statusCode===503);console.log('actual-vec-qualified');})().catch(e=>{console.error(e);process.exitCode=1});`;
    const child = spawnSync(runtime, ['-e', code, path.join(directory, 'child-authority'), path.join(directory, 'child-index.sqlite')], { encoding: 'utf8', timeout: 10000 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0); expect(child.stdout).toContain('actual-vec-qualified');
    expect(authoritySqlitePeerAdmission(runtime, service.databasePath)).toBe(true);
  } finally { await cleanup(); }
}, 15_000);

it.each(['public', 'owner'] as const)('actual owned process keeps a failed %s vector close unconfirmed until real process exit', async phase => {
  const { directory, service, cleanup } = await fixture();
  const filename = path.join(directory, 'failed-close.sqlite');
  const code = `const {SqliteVectorStore}=require('./dist/storage/vector/SqliteVectorStore.js');
    const {LocalPhysicalOperationService}=require('./dist/storage/LocalPhysicalOperationService.js');
    const runtime=require('./dist/storage/SqliteRuntime.js').getSqliteRuntime();const open=runtime.openDatabase.bind(runtime);let actual;
    runtime.openDatabase=(file,...args)=>{const db=open(file,...args);if(file===process.argv[2]){actual=db;db.close=()=>{throw Error('OWN actual vector close failure')}}return db};
    (async()=>{const service=new LocalPhysicalOperationService(process.argv[1]);const store=new SqliteVectorStore({connectionString:process.argv[2],operationService:service});
      await store.ensureVectorTable('real');let success=false;
      if(process.argv[3]==='public'){try{await store.close();success=true}catch(e){if(!/OWN actual vector close failure/.test(e.message))throw e}}
      else{void service.close().then(()=>success=true);await new Promise(r=>setTimeout(r,30))}
      if(success)throw Error('unconfirmed close succeeded');try{await store.countVectors('real');throw Error('next SQL admitted')}catch(e){if(e.statusCode!==503)throw e}
      setInterval(()=>{actual.prepare('SELECT COUNT(*) FROM sqlite_master').get()},20);process.stdout.write('owned-close-unconfirmed');
    })().catch(e=>{console.error(e);process.exitCode=1});`;
  const owner = spawn('node', ['-e', code, path.join(directory, 'authority'), filename, phase], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<number | null>((resolve, reject) => { owner.once('close', resolve); owner.once('error', reject); });
  let diagnostic = '';
  owner.stderr.on('data', data => { diagnostic += String(data); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      owner.stdout.on('data', data => { output += String(data); if (output.includes('owned-close-unconfirmed')) { resolve(); } });
      owner.once('error', reject); owner.once('close', () => reject(new Error(diagnostic || 'Owner closed before readiness')));
    });
    expect(authoritySqlitePeerAdmission('bun', service.databasePath)).toBe(false);
    expect(authoritySqlitePeerAdmission('node', service.databasePath)).toBe(false);
    owner.kill('SIGKILL'); await closed;
    expect(authoritySqlitePeerAdmission('node', service.databasePath)).toBe(true);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); }
    await closed; await cleanup();
  }
}, 15_000);
