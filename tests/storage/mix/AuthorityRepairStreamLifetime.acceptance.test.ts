// Root-owned actual public Mix repair lifecycle; this private fixture is not current Gateway acceptance.
import { fstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  ExtensionBasedMapper, FileDataAccessor, RepresentationMetadata, SingleRootIdentifierStrategy, guardStream,
} from '@solid/community-server';
import { expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { RootedSolidFsSyncJournal } from '../../../src/solidfs/SolidFsSyncJournal';
import { hashAuthoritySource } from '../../../src/storage/AuthorityFreshnessService';
import { LocalPhysicalOperationService } from '../../../src/storage/LocalPhysicalOperationService';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import { authoritySqlitePeerAdmission } from '../../helpers/AuthoritySqlitePeer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([ promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Own Mix repair barrier timed out')), 5000);
  }) ]); } finally { clearTimeout(timer); }
}

it('retains a failed repair file producer until actual close, then repairs without losing its pending token', async () => {
  const parent = path.resolve('.test-data/authority-repair-stream-lifetime');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const root = path.join(directory, 'authority');
  await mkdir(root);
  const base = 'https://root.invalid/';
  const container = `${base}alice/`;
  const resource = `${container}messages.ttl`;
  const text = `<${resource}#msg-id> <urn:root:repair-stream> "retained" .\n#${'x'.repeat(256000)}\n`;
  const operations = new LocalPhysicalOperationService(root);
  const engine = new SolidRdfEngine({ operationService: operations, index: { path: path.join(directory, 'facts.sqlite') } });
  const mapper = new ExtensionBasedMapper(base, root);
  const files = new FileDataAccessor(mapper);
  const structured = new SolidRdfDataAccessor(engine, new SingleRootIdentifierStrategy(base), operations);
  const journal = new RootedSolidFsSyncJournal(root, directory, operations);
  const mix = new MixDataAccessor(structured, files, false, true, files, false, mapper, journal, undefined, operations);
  const destroyEntered = deferred();
  const releaseDestroy = deferred();
  const sourceClosed = deferred();
  let stream: (Readable & { fd: number | null }) | undefined;
  let descriptor: number | undefined;
  let cleanupContextError: unknown;
  let restore: (() => void) | undefined;
  let refused: Promise<unknown> | undefined;
  try {
    await structured.initialize();
    await operations.run(() => files.writeContainer({ path: container }, new RepresentationMetadata({ path: container })));
    await operations.run(() => files.writeDocument({ path: resource }, guardStream(Readable.from([ text ])),
      new RepresentationMetadata({ path: resource }, 'text/turtle')));
    const pending = operations.runSync(() => journal.recordAuthorityPending({
      path: 'alice/messages.ttl', resource, sourcePath: path.join(root, 'alice', 'messages.ttl'),
      source: 'filesystem', projection: 'direct', contentType: 'text/turtle', type: 'updated',
    }, { workspace: base, cwd: root, projection: 'direct', entries: [] }, hashAuthoritySource(text)));
    const original = files.getData.bind(files);
    const fault = vi.spyOn(files, 'getData').mockImplementation(async identifier => {
      const actual = await original(identifier);
      stream = actual as unknown as Readable & { fd: number | null };
      const destroy = actual._destroy.bind(actual);
      actual._destroy = (error, callback) => {
        destroyEntered.resolve();
        void releaseDestroy.promise.then(() => {
          // Real delayed producer cleanup must still own an active admission, not just a held mutex.
          try { operations.runSync(() => fstatSync(descriptor!)); }
          catch (caught) { cleanupContextError = caught; }
          destroy(error, callback);
        });
      };
      actual.once('data', () => {
        descriptor = stream!.fd as number;
        // Public source fault: error is observable before asynchronous destruction completes.
        actual.emit('error', new Error('Root actual repair source error'));
      });
      actual.once('close', sourceClosed.resolve);
      return actual;
    });
    restore = () => fault.mockRestore();
    const iterator = mix.getChildren({ path: container });
    refused = iterator.next();
    void refused.catch(() => undefined);
    await within(destroyEntered.promise);
    await expect(within(refused)).rejects.toMatchObject({ statusCode: 503 });
    expect(typeof descriptor, 'fault follows real file data and an actual open descriptor').toBe('number');
    expect(fstatSync(descriptor!).isFile()).toBe(true);
    expect(stream?.closed).toBe(false);
    expect(journal.getAuthorityPending(pending.id)?.id).toBe(pending.id);
    for (const runtime of [ 'bun', 'node' ] as const) {
      expect(authoritySqlitePeerAdmission(runtime, operations.databasePath),
        'failed outer iterator cannot release a raw file producer still destroying').toBe(false);
    }
    releaseDestroy.resolve();
    await within(sourceClosed.promise);
    expect(cleanupContextError, 'delayed actual file cleanup must retain its original active context').toBeUndefined();
    await operations.run(() => undefined);
    expect(stream?.closed).toBe(true);
    expect(authoritySqlitePeerAdmission('node', operations.databasePath)).toBe(true);
    restore(); restore = undefined;
    // The exact pending token is cleared only by a subsequent successful current-file rebuild.
    for await (const _child of mix.getChildren({ path: container })) { /* consume actual iterator */ }
    expect(journal.getAuthorityPending(pending.id)).toBeUndefined();
    expect(engine.scan({ pattern: { graph: DataFactory.namedNode(resource) } }).quads)
      .toHaveLength(1);
  } finally {
    releaseDestroy.resolve();
    await refused?.catch(() => undefined);
    if (stream) { stream.destroy(); await within(sourceClosed.promise); }
    restore?.();
    await structured.finalize();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
