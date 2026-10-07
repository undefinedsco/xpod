import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { deliverPhysicalResult, iteratePhysicalResult, observePhysicalStream, runPhysicalOperation } from '../../src/storage/LocalPhysicalStreamLifetime';

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function peer(database: string): boolean {
  const child = spawnSync('node', ['-e', `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
    let admitted=false;try{db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');admitted=true;db.exec('ROLLBACK')}catch(e){if(!/busy|locked/i.test(e.message))throw e}}finally{db.close()}process.stdout.write(JSON.stringify(admitted))`, database], { encoding: 'utf8', timeout: 5000 });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0); return JSON.parse(child.stdout);
}

describe('Local actual lazy producer lifetime (owned fixture)', () => {
  let root: string;
  let service: LocalPhysicalOperationService;
  beforeEach(async () => { await mkdir('.test-data/local-stream-lifetime', { recursive: true }); root = await mkdtemp(path.resolve('.test-data/local-stream-lifetime/own-')); service = new LocalPhysicalOperationService(path.join(root, 'data')); });
  afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });

  it('delivers a real stream before consumption and runs lazy reads in the actual active context', async () => {
    let active = false;
    const stream = new Readable({ read() { active = service.runSync(() => !peer(service.databasePath)); this.push('content'); this.push(null); } });
    const value = await deliverPhysicalResult(service, async () => stream, observePhysicalStream);
    try {
      expect(value).toBe(stream); expect(peer(service.databasePath)).toBe(false);
      let text = ''; for await (const chunk of value) { text += String(chunk); }
      expect(text).toBe('content'); expect(active).toBe(true);
    } finally { stream.destroy(); }
    await service.run(() => undefined); expect(peer(service.databasePath)).toBe(true);
  });

  it('socket-style cancellation holds admission until the actual slow destroy callback closes', async () => {
    const destroying = barrier(); const release = barrier();
    const stream = new Readable({ read() {}, destroy(error, done) { destroying.resolve(); void release.promise.then(() => done(error)); } });
    await deliverPhysicalResult(service, async () => stream, observePhysicalStream);
    let stopped = false;
    try {
      stream.destroy(); await destroying.promise;
      const closing = service.close().then(() => { stopped = true; });
      await tick(); expect(stopped).toBe(false); expect(peer(service.databasePath)).toBe(false);
      release.resolve(); await closing; expect(peer(service.databasePath)).toBe(true);
    } finally { release.resolve(); stream.destroy(); }
  });

  it('iteration and asynchronous return keep the same physical admission through finally work', async () => {
    const returning = barrier(); const release = barrier(); let active = false;
    const source = async function* () {
      try { active = service.runSync(() => !peer(service.databasePath)); yield 1; }
      finally { returning.resolve(); await release.promise; expect(service.runSync(() => !peer(service.databasePath))).toBe(true); }
    };
    const iterator = iteratePhysicalResult(service, source);
    try {
      expect(await iterator.next()).toEqual({ done: false, value: 1 }); expect(active).toBe(true);
      let finished = false; const returned = iterator.return!(undefined).then(() => { finished = true; });
      await returning.promise; await tick(); expect(finished).toBe(false); expect(peer(service.databasePath)).toBe(false);
      release.resolve(); await returned;
    } finally { release.resolve(); await iterator.return!(undefined); }
    await service.run(() => undefined); expect(peer(service.databasePath)).toBe(true);
  });

  it('consumes a rejected actual HTTP body without destroying the original error response', async () => {
    const closed = barrier();
    const server = createServer((request, response) => {
      request.once('close', closed.resolve);
      void runPhysicalOperation(service, async () => {
        expect(peer(service.databasePath)).toBe(false);
        throw new Error('Existing container');
      }, request).catch(() => { response.writeHead(409); response.end('conflict'); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') { throw new Error('Missing own HTTP address'); }
      const response = await fetch(`http://127.0.0.1:${address.port}/existing/`, { method: 'PUT', body: 'unconsumed body' });
      expect(response.status).toBe(409); expect(await response.text()).toBe('conflict');
      await closed.promise;
      await service.run(() => undefined);
      expect(peer(service.databasePath)).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

});
