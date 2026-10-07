import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BasicRepresentation, GreedyReadWriteLocker, MemoryMapStorage, MemoryResourceLocker,
  SingleRootIdentifierStrategy, arrayifyStream } from '@solid/community-server';
import type { AuxiliaryIdentifierStrategy, ResourceStore, Patch, Representation } from '@solid/community-server';
import { describe, expect, it, vi } from 'vitest';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';

function peer(database: string): boolean {
  const child = spawnSync('node', ['-e', `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);let admitted=false;
    try{db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');admitted=true;db.exec('ROLLBACK')}catch(e){if(!/busy|locked/i.test(e.message))throw e}}finally{db.close()}process.stdout.write(JSON.stringify(admitted))`, database], { encoding: 'utf8', timeout: 5000 });
  expect(child.status, child.stderr).toBe(0); return JSON.parse(child.stdout);
}
const base = 'https://own.invalid/'; const identifier = { path: `${base}alice/document.ttl` };
const auxiliary = { isAuxiliaryIdentifier: () => false, getSubjectIdentifier: (value: { path: string }) => value } as unknown as AuxiliaryIdentifierStrategy;
const names = ['hasResource', 'getRepresentation', 'addResource', 'setRepresentation', 'deleteResource', 'modifyResource'] as const;

describe('direct Store admission before hierarchy and source', () => {
  it.each(names)('queues %s behind an actual Bun SQLite owner before invoking any hierarchy/source callback', async name => {
    await mkdir('.test-data/local-store-admission', { recursive: true });
    const root = await mkdtemp(path.resolve('.test-data/local-store-admission/own-'));
    const service = new LocalPhysicalOperationService(path.join(root, 'data'));
    const owner = spawn('bun', ['-e', `const{Database}=require('bun:sqlite');const db=new Database(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');process.stdout.write('ready');process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0)})`, service.databasePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const reaped = new Promise<void>((resolve, reject) => { owner.once('error', reject); owner.once('close', code => code === 0 ? resolve() : reject(new Error(`Own peer exited ${code}`))); });
    const ready = new Promise<void>(resolve => owner.stdout.once('data', () => resolve()));
    const locker = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), new SingleRootIdentifierStrategy(base));
    const read = vi.spyOn(locker, 'withReadLock'); const write = vi.spyOn(locker, 'withWriteLock');
    let calls = 0;
    const source = {
      hasResource: async () => { calls++; expect(peer(service.databasePath)).toBe(false); return true; },
      getRepresentation: async () => { calls++; expect(peer(service.databasePath)).toBe(false); return new BasicRepresentation(Readable.from(['data']), 'text/plain'); },
      addResource: async (_id: unknown, representation: Representation) => { calls++; expect(peer(service.databasePath)).toBe(false); await arrayifyStream(representation.data); return new Map(); },
      setRepresentation: async (_id: unknown, representation: Representation) => { calls++; expect(peer(service.databasePath)).toBe(false); await arrayifyStream(representation.data); return new Map(); },
      deleteResource: async () => { calls++; expect(peer(service.databasePath)).toBe(false); return new Map(); },
      modifyResource: async () => { calls++; expect(peer(service.databasePath)).toBe(false); return new Map(); },
    } as unknown as ResourceStore;
    const store = new LockingResourceStore(source, locker, auxiliary, { operationService: service });
    let operation: Promise<unknown> | undefined;
    try {
      await ready;
      switch (name) {
        case 'hasResource': operation = store.hasResource(identifier); break;
        case 'getRepresentation': operation = store.getRepresentation(identifier, {}); break;
        case 'addResource': operation = store.addResource(identifier, new BasicRepresentation(Readable.from([]), 'text/plain')); break;
        case 'setRepresentation': operation = store.setRepresentation(identifier, new BasicRepresentation(Readable.from([]), 'text/plain')); break;
        case 'deleteResource': operation = store.deleteResource(identifier); break;
        case 'modifyResource': operation = store.modifyResource(identifier, {} as Patch); break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(calls).toBe(0); expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      owner.stdin.write('release'); await reaped;
      const value = await operation;
      if (name === 'getRepresentation') { await arrayifyStream((value as Representation).data); }
      await service.run(() => undefined);
      expect(calls).toBe(1); expect(peer(service.databasePath)).toBe(true);
    } finally { owner.stdin.end('release'); await reaped; await operation?.catch(() => undefined); await service.close(); read.mockRestore(); write.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});
