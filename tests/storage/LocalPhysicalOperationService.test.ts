// Own Local operation/Engine qualification; controlled owned producers are not production QLever.
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ComponentsManager, ConstructionStrategyCommonJs, type ICreationStrategyInstanceOptions } from 'componentsjs';
import { RdfTextIndex } from '../../src/storage/rdf/RdfTextIndex';
import { RdfVectorIndex } from '../../src/storage/rdf/RdfVectorIndex';
import * as sqliteRuntimeModule from '../../src/storage/SqliteRuntime';
import type { SqliteDatabase } from '../../src/storage/SqliteRuntime';
import { DataFactory } from 'n3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPhysicalOperationService, type LocalPhysicalOperationSession } from '../../src/storage/LocalPhysicalOperationService';
import { authorityCoordinationDatabasePath } from '../../src/storage/AuthorityExclusionGate';
import { RootedSolidFsSyncJournal } from '../../src/solidfs/SolidFsSyncJournal';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { LocalQleverNativeSparqlClient } from '../../src/storage/rdf/LocalQleverNativeSparqlClient';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function peer(database: string, runtime: 'bun' | 'node' = 'bun'): boolean {
  const constructor = runtime === 'bun' ? "require('bun:sqlite').Database" : "require('node:sqlite').DatabaseSync";
  const child = spawnSync(runtime, ['-e', `const db=new (${constructor})(process.argv[1]);
  let admitted=false;try {db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');admitted=true;db.exec('ROLLBACK');}
  catch(e){if(!/busy|locked/i.test(e.message))throw e;}}finally{db.close();}process.stdout.write(JSON.stringify(admitted));`, database],
  { encoding: 'utf8', timeout: 5000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as boolean;
}
async function barrier(file: string): Promise<string> {
  for (let i = 0; i < 1000; i += 1) {
    try { return await readFile(file, 'utf8'); } catch { await delay(5); }
  }
  throw new Error(`owned barrier absent: ${file}`);
}
function closed(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`owned child exit ${code}`)));
  });
}

describe('Local physical operation admission', () => {
  let parent: string;
  let root: string;
  beforeEach(async () => {
    const base = path.resolve('.test-data/local-physical-operation');
    await mkdir(base, { recursive: true });
    parent = await mkdtemp(path.join(base, 'own-'));
    root = path.join(parent, 'source');
    await mkdir(root);
  });
  afterEach(async () => { await rm(parent, { recursive: true, force: true }); });

  it('uses one canonical sibling domain for aliases outside the copied source root', async () => {
    const alias = path.join(parent, 'alias');
    await symlink(root, alias);
    const first = new LocalPhysicalOperationService(root);
    const second = new LocalPhysicalOperationService(alias);
    try {
      expect(first.canonicalRoot).toBe(root);
      expect(second.databasePath).toBe(first.databasePath);
      expect(first.databasePath.startsWith(`${root}${path.sep}`)).toBe(false);
      expect(authorityCoordinationDatabasePath(`${root}/../source`)).toBe(first.databasePath);
      first.runSync(() => {
        expect(() => second.runSync(() => 'unreachable')).toThrow();
        expect(peer(first.databasePath, 'node')).toBe(false);
      });
      expect(peer(first.databasePath)).toBe(true);
    } finally { await first.close(); await second.close(); }
  });

  it('reuses active opaque nesting and refuses stale, detached and foreign sessions', async () => {
    const service = new LocalPhysicalOperationService(root);
    const foreign = new LocalPhysicalOperationService(path.join(parent, 'foreign'));
    let session!: LocalPhysicalOperationSession;
    const resume = deferred();
    let detached!: Promise<void>;
    try {
      expect(await service.run(async admitted => {
        session = admitted;
        detached = (async () => {
          await resume.promise;
          await expect(service.run(() => 'unreachable')).rejects.toMatchObject({ statusCode: 503 });
        })();
        expect(service.runSync(() => 7, admitted)).toBe(7);
        await expect(foreign.run(() => 'unreachable', admitted)).rejects.toMatchObject({ statusCode: 503 });
        return service.run(() => 11, admitted);
      })).toBe(11);
      await expect(service.run(() => 'unreachable', session)).rejects.toMatchObject({ statusCode: 503 });
      resume.resolve();
      await detached;
    } finally { resume.resolve(); await service.close(); await foreign.close(); }
  });

  it('does not bypass a queued async operation with synchronous admission', async () => {
    const service = new LocalPhysicalOperationService(root);
    const release = deferred();
    const entered = deferred();
    const order: number[] = [];
    try {
      const first = service.run(async () => { entered.resolve(); await release.promise; order.push(1); });
      await entered.promise;
      const second = service.run(() => { order.push(2); });
      expect(() => service.runSync(() => order.push(3))).toThrow();
      release.resolve();
      await first; await second;
      await service.close();
      expect(order).toEqual([1, 2]);
      expect(() => service.runSync(() => order.push(4))).toThrow();
    } finally { release.resolve(); await service.close(); }
  });

  it('keeps healthy seeded sync Engine results and journal startup inside the same gate', async () => {
    const service = new LocalPhysicalOperationService(root);
    const journal = new RootedSolidFsSyncJournal(root, process.cwd(), service);
    const engine = new SolidRdfEngine({ index: { path: path.join(parent, 'facts.sqlite') }, operationService: service });
    const graph = DataFactory.namedNode('https://own.invalid/a.ttl');
    const subject = DataFactory.namedNode(`${graph.value}#s`);
    const predicate = DataFactory.namedNode('urn:own:p');
    try {
      await engine.open();
      service.runSync(() => engine.replaceSource([DataFactory.quad(subject, predicate, DataFactory.literal('retained'), graph)], {
        source: graph.value, workspace: 'https://own.invalid/',
      }));
      engine.setAuthorityFreshnessProvider({ assertFresh: () => undefined, assertFreshSync: () => {
        expect(peer(service.databasePath)).toBe(false);
      } });
      expect(engine.query({ patterns: [{ graph, subject, predicate }] }).bindings).toHaveLength(1);
      await engine.close();
      expect(peer(service.databasePath)).toBe(true);
      expect(() => journal.listOperations()).toThrow();
      journal.close(); // lifecycle idempotency after the service's protected finalizer
    } finally { await engine.close(); }
  });

  it.each(['bun', 'node'] as const)('holds actual Engine admission after native caller timeout against a real %s peer', async runtime => {
    const release = path.join(parent, 'release');
    const received = path.join(parent, 'received');
    const producer = path.join(parent, 'producer.cjs');
    await writeFile(producer, `const fs=require('node:fs');const rl=require('node:readline');
      let id;let shutdown=false;process.on('SIGTERM',()=>{});
      process.stdout.write(JSON.stringify({type:'ready',abiVersion:1,physicalBackendAbiVersion:7,backend:'sqlite'})+'\\n');
      rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
        if(m.type==='query'){id=m.id;fs.writeFileSync(${JSON.stringify(received)},String(process.pid));}
        if(m.type==='shutdown')shutdown=true;});
      setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){
        if(id){process.stdout.write(JSON.stringify({type:'result',id,result:{status:'ok',mediaType:'application/sparql-results+json',body:'{"boolean":true}'}})+'\\n');id=undefined;}
        if(shutdown)process.exit(0);}},5);`);
    const service = new LocalPhysicalOperationService(root);
    const native = new LocalQleverNativeSparqlClient({ command: process.execPath, args: [producer] });
    const facts = path.join(parent, 'facts.sqlite');
    const opened: SqliteDatabase[] = [];
    const runtimeSpies: Array<() => void> = [];
    const actualCreate = sqliteRuntimeModule.createSqliteRuntime;
    const openSpy = vi.spyOn(sqliteRuntimeModule, 'createSqliteRuntime').mockImplementation(kind => {
      const runtime = actualCreate(kind);
      const actualOpen = runtime.openDatabase.bind(runtime);
      const spy = vi.spyOn(runtime, 'openDatabase').mockImplementation((filename, options) => {
        const db = actualOpen(filename, options);
        if (filename === facts) { opened.push(db); }
        return db;
      });
      runtimeSpies.push(() => spy.mockRestore());
      return runtime;
    });
    const text = new RdfTextIndex({ path: facts });
    const vector = new RdfVectorIndex({ path: facts });
    const engine = new SolidRdfEngine({ index: { path: facts }, textIndex: text, vectorIndex: vector,
      operationService: service, nativeSparqlClient: native });
    const restoreCloses: Array<() => void> = [];
    try {
      await engine.open();
      openSpy.mockRestore();
      for (const restore of runtimeSpies) { restore(); }
      expect(opened).toHaveLength(3); // real facts, FTS and vector SQLite handles
      let pid: number | undefined;
      const closes = opened.map(db => {
        const actualClose = db.close.bind(db);
        const spy = vi.spyOn(db, 'close').mockImplementation(() => {
          expect(peer(service.databasePath, runtime), 'teardown remains physically admitted').toBe(false);
          if (pid !== undefined) { expect(() => process.kill(pid!, 0), 'native actual exit precedes index teardown').toThrow(); }
          actualClose();
        });
        restoreCloses.push(() => spy.mockRestore());
        return spy;
      });
      let asyncFreshnessCalls = 0;
      engine.setAuthorityFreshnessProvider({ assertFresh: () => { asyncFreshnessCalls += 1; } });
      await expect(engine.sparqlQuery('ASK {}', { basePath: 'https://own.invalid/' }))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(asyncFreshnessCalls).toBe(0);
      engine.setAuthorityFreshnessProvider({
        assertFresh: () => { asyncFreshnessCalls += 1; },
        assertFreshSync: () => { expect(peer(service.databasePath, runtime)).toBe(false); },
      });
      const result = engine.sparqlQuery('ASK {}', { basePath: 'https://own.invalid/', timeoutMs: 25 });
      await expect(result).rejects.toMatchObject({ code: 'qlever_request_timeout' });
      expect(asyncFreshnessCalls).toBe(0);
      pid = Number(await barrier(received));
      expect(peer(service.databasePath, runtime)).toBe(false);
      let done = false;
      const closing = engine.close().then(() => { done = true; });
      await delay(30);
      expect(done).toBe(false);
      await writeFile(release, 'release');
      await closing;
      await engine.close(); // the same lifecycle result; no additional resource close
      for (const db of opened) { expect(() => db.exec('SELECT 1'), 'real SQLite connection is closed').toThrow(); }
      for (const spy of closes) { expect(spy).toHaveBeenCalledTimes(1); }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(peer(service.databasePath, runtime)).toBe(true);
    } finally {
      openSpy.mockRestore();
      for (const restore of runtimeSpies) { restore(); }
      await writeFile(release, 'release'); await engine.close();
      for (const restore of restoreCloses) { restore(); }
    }
  });

  it('resolves mandatory configured Engine and journal to the same actual Components service', async () => {
    const constructors: Record<string, Function> = {
      LocalPhysicalOperationService, SolidRdfEngine, RootedSolidFsSyncJournal,
      LocalQleverNativeSparqlClient, RdfTextIndex, RdfVectorIndex,
    };
    class OwnConstruction extends ConstructionStrategyCommonJs {
      public override createInstance(options: ICreationStrategyInstanceOptions<unknown>): unknown {
        const constructor = options.requireElement && constructors[options.requireElement];
        if (!constructor) { throw new Error(`Unexpected component: ${options.requireElement}`); }
        return options.callConstructor ? Reflect.construct(constructor, options.args) : constructor;
      }
    }
    const manager = await ComponentsManager.build({ mainModulePath: process.cwd(),
      typeChecking: false, dumpErrorState: false, constructionStrategy: new OwnConstruction() });
    await manager.configRegistry.register(path.resolve('config/local.json'));
    const variables = {
      'urn:solid-server:default:variable:rootFilePath': root,
      'urn:solid-server:default:variable:rdfIndexPath': path.join(parent, 'configured.sqlite'),
    };
    const service = await manager.instantiate<LocalPhysicalOperationService>('urn:undefineds:xpod:LocalPhysicalOperationService', { variables });
    const journal = await manager.instantiate<RootedSolidFsSyncJournal>('urn:undefineds:xpod:LocalRdfAuthorityJournal', { variables });
    const engine = await manager.instantiate<SolidRdfEngine>('urn:undefineds:xpod:SolidRdfEngine', { variables });
    try {
      expect(service.canonicalRoot).toBe(root);
      const clone = new LocalPhysicalOperationService(root);
      try {
        clone.runSync(() => {
          expect(() => engine.query({ patterns: [] })).toThrow();
        });
      } finally { await clone.close(); }
      await engine.close(); // autoOpen=false must not start the packaged producer during construction
      expect(() => journal.listOperations()).toThrow();
      expect(peer(service.databasePath)).toBe(true);
    } finally { await engine.close(); }
  });

  it('retains a nested unawaited callback registered drain and refuses queued callbacks on close', async () => {
    const service = new LocalPhysicalOperationService(root);
    const release = deferred();
    let nestedFailure!: Promise<unknown>;
    try {
      const result = service.run(() => {
        nestedFailure = service.run(() => {
          service.registerDrain(release.promise);
          throw new Error('nested caller outcome');
        }).catch(error => error);
        throw new Error('outer caller outcome');
      });
      await expect(result).rejects.toThrow('outer caller outcome');
      expect(await nestedFailure).toBeInstanceOf(Error);
      expect(peer(service.databasePath)).toBe(false);
      let queuedCalls = 0;
      const queued = service.run(() => { queuedCalls += 1; }).catch(error => error);
      let closeDone = false;
      const closing = service.close().then(() => { closeDone = true; });
      await delay(20);
      expect(closeDone).toBe(false);
      release.resolve();
      await closing;
      expect(await queued).toMatchObject({ statusCode: 503 });
      expect(queuedCalls).toBe(0);
      expect(peer(service.databasePath)).toBe(true);
    } finally { release.resolve(); await service.close(); }
  });

  it('retains failed startup admission when an owned termination and close request both throw', async () => {
    const pidFile = path.join(parent, 'startup.pid');
    const ready = path.join(parent, 'bad-ready');
    const release = path.join(parent, 'startup-exit');
    const producer = path.join(parent, 'startup.cjs');
    await writeFile(producer, `const fs=require('node:fs');process.on('SIGTERM',()=>{});
      fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));let sent=false;
      setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);
      if(!sent&&fs.existsSync(${JSON.stringify(ready)})){sent=true;process.stdout.write(JSON.stringify({type:'ready',backend:'sqlite',abiVersion:2,physicalBackendAbiVersion:7})+'\\n');}},5);`);
    const service = new LocalPhysicalOperationService(root);
    const native = new LocalQleverNativeSparqlClient({ command: process.execPath, args: [producer] });
    const engine = new SolidRdfEngine({ index: { path: path.join(parent, 'facts.sqlite') }, operationService: service, nativeSparqlClient: native });
    let restoreKill: (() => void) | undefined;
    let restoreClose: (() => void) | undefined;
    try {
      const opening = engine.open();
      opening.catch(() => undefined);
      const pid = Number(await barrier(pidFile));
      const originalKill = ChildProcess.prototype.kill;
      const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function(this: ChildProcess, signal) {
        if (this.pid === pid) { throw new Error('owned termination request failed'); }
        return originalKill.call(this, signal);
      });
      restoreKill = () => kill.mockRestore();
      const close = vi.spyOn(native, 'close').mockRejectedValue(new Error('owned close request failed'));
      restoreClose = () => close.mockRestore();
      await writeFile(ready, 'ready');
      await expect(opening).rejects.toThrow('owned close request failed');
      expect(peer(service.databasePath)).toBe(false);
      process.kill(pid, 0); // actual owned producer remains alive
      restoreClose(); restoreClose = undefined;
      restoreKill(); restoreKill = undefined;
      await writeFile(release, 'exit');
      await engine.close();
      expect(() => process.kill(pid, 0)).toThrow();
      expect(peer(service.databasePath)).toBe(true);
    } finally {
      restoreClose?.(); restoreKill?.();
      await writeFile(release, 'exit'); await engine.close();
    }
  });

  it('refuses legacy native clients for protected Local engines', async () => {
    const service = new LocalPhysicalOperationService(root);
    try {
      expect(() => new SolidRdfEngine({ index: { path: path.join(parent, 'facts.sqlite') }, operationService: service,
        nativeSparqlClient: { start: () => undefined, query: () => { throw new Error('unreachable'); }, close: () => undefined },
      })).toThrow('actual-drain');
    } finally { await service.close(); }
  });

  it.each(['engine', 'service'] as const)('retains an unqualified %s sync producer after its outcome settles until its real owned process terminates', async mode => {
    const script = path.join(parent, 'malformed.ts');
    const ready = path.join(parent, 'ready');
    const settled = path.join(parent, 'settled');
    const settle = path.join(parent, 'settle');
    const exit = path.join(parent, 'exit');
    const servicePath = path.resolve('src/storage/LocalPhysicalOperationService.ts');
    const enginePath = path.resolve('src/storage/rdf/SolidRdfEngine.ts');
    await writeFile(script, `import {existsSync,writeFileSync} from 'node:fs';
      import {LocalPhysicalOperationService} from ${JSON.stringify(servicePath)};
      import {SolidRdfEngine} from ${JSON.stringify(enginePath)};
      const service=new LocalPhysicalOperationService(${JSON.stringify(root)});
      const engine=new SolidRdfEngine({index:{path:${JSON.stringify(path.join(parent, 'facts.sqlite'))}},operationService:service});
      await engine.open();let resolve;const outcome=new Promise<void>(done=>{resolve=done});
      engine.setAuthorityFreshnessProvider({assertFresh:()=>undefined,assertFreshSync:()=>outcome});
      let code;try{${mode === 'engine' ? 'engine.query({patterns:[]})' : 'service.runSync(()=>outcome)'};}catch(e){code=e.statusCode;}
      writeFileSync(${JSON.stringify(ready)},JSON.stringify({code,path:service.databasePath}));
      outcome.then(()=>writeFileSync(${JSON.stringify(settled)},'settled'));
      setInterval(()=>{if(existsSync(${JSON.stringify(settle)}))resolve();if(existsSync(${JSON.stringify(exit)}))process.exit(0)},5);`);
    const child = spawn('bun', [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const completion = closed(child);
    completion.catch(() => undefined);
    let diagnostic = '';
    child.stderr?.on('data', chunk => { diagnostic += String(chunk); });
    try {
      const state = JSON.parse(await barrier(ready)) as { code: number; path: string };
      expect(state.code, diagnostic).toBe(503);
      expect(peer(state.path)).toBe(false);
      await writeFile(settle, 'settle');
      await barrier(settled);
      expect(peer(state.path), 'outcome settlement is not actual producer drain').toBe(false);
      await writeFile(exit, 'exit');
      await completion;
      expect(peer(state.path)).toBe(true);
    } finally { await writeFile(exit, 'exit'); await completion; }
  }, 15000);
});
