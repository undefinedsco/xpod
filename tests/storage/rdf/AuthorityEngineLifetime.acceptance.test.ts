import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalPhysicalOperationService } from '../../../src/storage/LocalPhysicalOperationService';
import { LocalQleverNativeSparqlClient } from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import { authoritySqlitePeerAdmission } from '../../helpers/AuthoritySqlitePeer';

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned ${label} observation exceeded 5s`)), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fileBarrier(file: string): Promise<string> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Owned ${path.basename(file)} barrier exceeded 5s`);
}

async function engineFixture() {
  const parent = path.resolve('.test-data/authority-engine-lifetime');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const sourceRoot = path.join(directory, 'source');
  await mkdir(sourceRoot);
  const pidFile = path.join(directory, 'owned.pid');
  const queryFile = path.join(directory, 'query-count');
  const cancelFile = path.join(directory, 'cancel');
  const releaseFile = path.join(directory, 'release');
  const producer = path.join(directory, 'producer.cjs');
  await writeFile(producer, `
    const fs = require('node:fs');
    const input = require('node:readline').createInterface({ input: process.stdin });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.stdout.write(JSON.stringify({ type: 'ready', backend: 'sqlite', abiVersion: 1, physicalBackendAbiVersion: 7 }) + '\\n');
    let count = 0;
    let active = false;
    let shutdown = false;
    input.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'query') {
        active = true;
        fs.writeFileSync(${JSON.stringify(queryFile)}, String(++count));
        const poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
          clearInterval(poll);
          active = false;
          process.stdout.write(JSON.stringify({ type: 'result', id: message.id,
            result: { status: 'ok', mediaType: 'application/sparql-results+json', body: '{"boolean":true}' } }) + '\\n');
          if (shutdown) process.exit(0);
        }, 5);
      }
      if (message.type === 'cancel') fs.writeFileSync(${JSON.stringify(cancelFile)}, message.id);
      if (message.type === 'shutdown') { shutdown = true; if (!active) process.exit(0); }
    });
  `);
  const client = new LocalQleverNativeSparqlClient({
    command: process.execPath, args: [ producer ],
    expectedNativeSparqlAbiVersion: 1, expectedPhysicalBackendAbiVersion: 7,
  });
  const operations = new LocalPhysicalOperationService(sourceRoot);
  const engine = new SolidRdfEngine({
    index: { path: path.join(directory, 'rdf.sqlite') },
    operationService: operations,
    nativeSparqlClient: client,
  });
  engine.setAuthorityFreshnessProvider({ assertFresh: () => undefined, assertFreshSync: () => undefined });
  return { directory, sourceRoot, pidFile, queryFile, cancelFile, releaseFile, client, operations, engine };
}

// Root-owned actual product Engine entry tests; controlled IPC producer is not production QLever.
describe('Root actual Engine operation lifetime', () => {
  it('rejects caller timeout promptly but holds real peers until matching producer completion', async () => {
    const f = await engineFixture();
    let pid: number | undefined;
    let result: Promise<unknown> | undefined;
    try {
      await bounded(f.engine.open(), 'Engine open');
      result = f.engine.sparqlQuery('ASK {}', { basePath: f.sourceRoot, timeoutMs: 150 })
        .then(value => value, error => error);
      expect(await fileBarrier(f.queryFile)).toBe('1');
      pid = Number(await fileBarrier(f.pidFile));
      expect(await bounded(result, 'caller timeout')).toMatchObject({ code: 'qlever_request_timeout' });
      await fileBarrier(f.cancelFile);
      expect(() => process.kill(pid!, 0)).not.toThrow();
      expect(authoritySqlitePeerAdmission('bun', f.operations.databasePath)).toBe(false);
      expect(authoritySqlitePeerAdmission('node', f.operations.databasePath)).toBe(false);
      await writeFile(f.releaseFile, 'actual terminal allowed\n');
      // Admission behind the real registered drain proves the entire operation has released.
      await bounded(f.operations.run(() => undefined), 'operation release');
      expect(authoritySqlitePeerAdmission('node', f.operations.databasePath)).toBe(true);
      expect(() => process.kill(pid!, 0), 'shared healthy producer may survive request completion').not.toThrow();
    } finally {
      await writeFile(f.releaseFile, 'cleanup actual producer\n');
      await f.client.close();
      await bounded(f.engine.close(), 'Engine close');
      await bounded(f.operations.close(), 'operation service close');
      await result;
      if (pid !== undefined) expect(() => process.kill(pid!, 0), 'owned producer must be reaped').toThrow();
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30000);

  it('stops new Engine admission and keeps close pending until the actual producer terminates', async () => {
    const f = await engineFixture();
    let pid: number | undefined;
    let closing: Promise<void> | undefined;
    let result: Promise<unknown> | undefined;
    let closed = false;
    try {
      await bounded(f.engine.open(), 'Engine open');
      result = f.engine.sparqlQuery('ASK {}', { basePath: f.sourceRoot, timeoutMs: 150 })
        .then(value => value, error => error);
      expect(await fileBarrier(f.queryFile)).toBe('1');
      pid = Number(await fileBarrier(f.pidFile));
      expect(await bounded(result, 'caller timeout')).toMatchObject({ code: 'qlever_request_timeout' });
      closing = f.engine.close();
      void closing.then(() => { closed = true; }, () => undefined);
      await expect(f.engine.sparqlQuery('ASK {}', { basePath: f.sourceRoot, timeoutMs: 150 }))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(await readFile(f.queryFile, 'utf8'), 'no second producer request may start').toBe('1');
      expect(authoritySqlitePeerAdmission('node', f.operations.databasePath)).toBe(false);
      expect(closed).toBe(false);
      expect(() => process.kill(pid!, 0)).not.toThrow();
      await writeFile(f.releaseFile, 'actual terminal and owned exit allowed\n');
      await bounded(closing, 'actual Engine close');
      expect(closed).toBe(true);
      expect(() => process.kill(pid!, 0), 'close success requires actual owned exit').toThrow();
      expect(authoritySqlitePeerAdmission('node', f.operations.databasePath)).toBe(true);
    } finally {
      await writeFile(f.releaseFile, 'cleanup actual producer\n');
      await f.client.close();
      await bounded(f.engine.close(), 'Engine close cleanup');
      await bounded(f.operations.close(), 'operation service close cleanup');
      await closing; await result;
      if (pid !== undefined) expect(() => process.kill(pid!, 0)).toThrow();
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30000);
});
