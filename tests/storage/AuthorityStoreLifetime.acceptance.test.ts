// Root-owned public Store lifetime oracle; the source is a declared controlled file adapter.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  BasicRepresentation, GreedyReadWriteLocker, MemoryMapStorage, MemoryResourceLocker,
  SingleRootIdentifierStrategy, arrayifyStream,
} from '@solid/community-server';
import type { AuxiliaryIdentifierStrategy, ResourceStore } from '@solid/community-server';
import { expect, it } from 'vitest';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let complete!: () => void;
  return { promise: new Promise<void>(resolve => { complete = resolve; }), resolve: () => complete() };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([ promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Own Store fixture barrier timed out')), 5000);
  }) ]); } finally { clearTimeout(timer); }
}
const base = 'https://root.invalid/';
const identifier = { path: `${base}alice/messages.ttl` };
const auxiliary = {
  isAuxiliaryIdentifier: () => false, getSubjectIdentifier: (value: { path: string }) => value,
} as unknown as AuxiliaryIdentifierStrategy;

async function fixture() {
  const parent = path.resolve('.test-data/authority-store-lifetime');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const file = path.join(directory, 'authority.txt');
  await writeFile(file, 'retained authority');
  const operations = new LocalPhysicalOperationService(directory);
  const hierarchy = new HierarchicalReadWriteLocker(
    new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()),
    new SingleRootIdentifierStrategy(base),
  );
  return { file, operations, hierarchy, cleanup: async () => {
    await operations.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

it('caller timeout before a representation retains actual source read and late destroy cleanup', async () => {
  const context = await fixture();
  const readEntered = deferred();
  const returnRepresentation = deferred();
  const destroyEntered = deferred();
  const completeDestroy = deferred();
  const sourceClosed = deferred();
  let actualReads = 0;
  let sourceReturned = false;
  let contextError: unknown;
  let work: ReturnType<typeof setInterval> | undefined;
  const stream = new Readable({
    read() {},
    destroy(error, callback) {
      try { context.operations.runSync(() => { readFileSync(context.file); actualReads += 1; }); }
      catch (caught) { contextError = caught; }
      destroyEntered.resolve();
      void completeDestroy.promise.then(() => { clearInterval(work); callback(error); });
    },
  });
  stream.on('error', () => undefined);
  stream.once('close', sourceClosed.resolve);
  const source = { getRepresentation: async () => {
    readFileSync(context.file); actualReads += 1;
    work = setInterval(() => { readFileSync(context.file); actualReads += 1; }, 10);
    readEntered.resolve();
    await returnRepresentation.promise;
    sourceReturned = true;
    return new BasicRepresentation(stream, 'text/plain');
  } } as unknown as ResourceStore;
  const store = new LockingResourceStore(source, context.hierarchy, auxiliary,
    { operationService: context.operations, representationTimeoutMs: 25 });
  const result = store.getRepresentation(identifier, { type: { 'text/plain': 1 } });
  const rejected = expect(result).rejects.toThrow('Timed out while reading');
  try {
    await within(readEntered.promise);
    await within(rejected);
    expect(actualReads).toBeGreaterThan(0);
    expect(sourceReturned).toBe(false);
    for (const runtime of [ 'bun', 'node' ] as const) {
      expect(authoritySqlitePeerAdmission(runtime, context.operations.databasePath),
        'caller rejection is not actual pre-result source completion').toBe(false);
    }
    returnRepresentation.resolve();
    await within(destroyEntered.promise);
    expect(contextError, 'late cleanup still belongs to the original active session').toBeUndefined();
    expect(stream.closed).toBe(false);
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(false);
    completeDestroy.resolve();
    await within(sourceClosed.promise);
    await context.operations.run(() => undefined);
    expect(authoritySqlitePeerAdmission('bun', context.operations.databasePath)).toBe(true);
  } finally {
    returnRepresentation.resolve(); completeDestroy.resolve();
    await result.catch(() => undefined);
    await within(destroyEntered.promise);
    await within(sourceClosed.promise);
    clearInterval(work);
    await context.cleanup();
  }
}, 30_000);

it('delivers a healthy representation before consumption and retains its genuine lazy read context', async () => {
  const context = await fixture();
  let contextError: unknown;
  let actualReads = 0;
  const stream = new Readable({ read() {
    try {
      const bytes = context.operations.runSync(() => { actualReads += 1; return readFileSync(context.file); });
      this.push(bytes); this.push(null);
    } catch (error) { contextError = error; this.destroy(error as Error); }
  } });
  stream.on('error', () => undefined);
  const source = { getRepresentation: async () => new BasicRepresentation(stream, 'text/plain') } as unknown as ResourceStore;
  const store = new LockingResourceStore(source, context.hierarchy, auxiliary,
    { operationService: context.operations, representationTimeoutMs: 10000 });
  try {
    const representation = await within(store.getRepresentation(identifier, { type: { 'text/plain': 1 } }));
    expect(actualReads).toBe(0);
    expect(authoritySqlitePeerAdmission('bun', context.operations.databasePath)).toBe(false);
    const chunks = await within(arrayifyStream<Buffer>(representation.data));
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString()).toBe('retained authority');
    expect(actualReads).toBe(1);
    expect(contextError).toBeUndefined();
    await context.operations.run(() => undefined);
    expect(stream.closed).toBe(true);
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(true);
  } finally {
    stream.destroy();
    await context.cleanup();
  }
}, 30_000);
