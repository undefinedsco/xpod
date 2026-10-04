import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import {
  addResourceMetadata, BaseIdentifierStrategy, BasicConditions, BasicRepresentation, DataAccessorBasedStore,
  ExtensionBasedMapper, FileDataAccessor,
  GreedyReadWriteLocker, HH, INTERNAL_QUADS, MemoryMapStorage, MemoryResourceLocker, NotFoundHttpError,
  PreconditionFailedHttpError, RepresentationMetadata, updateModifiedDate, WrappedExpiringReadWriteLocker,
  type AuxiliaryStrategy, type Representation, type ResourceIdentifier,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HierarchyLockingResourceStore } from '../../src/storage/HierarchyLockingResourceStore';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { SparqlUpdateResourceStore } from '../../src/storage/SparqlUpdateResourceStore';
import { StorageETagHandler } from '../../src/storage/conditions/StorageETagHandler';
import { RdfQuadIndex, SolidRdfEngine } from '../../src/storage/rdf';
import { getStorageVersion, storageVersionReadContext } from '../../src/storage/StorageVersion';

const root = 'http://localhost/';
const id = { path: `${root}run.ttl` };
const { literal, namedNode, quad } = DataFactory;
const graph = namedNode(`meta:${id.path}`);
const etags = new StorageETagHandler();
class Strategy extends BaseIdentifierStrategy {
  public supportsIdentifier(value: ResourceIdentifier): boolean { return value.path.startsWith(root); }
  public isRootContainer(value: ResourceIdentifier): boolean { return value.path === root; }
}
const auxiliary = {
  isAuxiliaryIdentifier: () => false,
  getAuxiliaryIdentifier: (value: ResourceIdentifier) => ({ path: `${value.path}.meta` }),
  getAuxiliaryIdentifiers: () => [],
  addMetadata: async () => undefined,
} as unknown as AuxiliaryStrategy;
const document = (value: string): BasicRepresentation => new BasicRepresentation(Readable.from([
  quad(namedNode(`${id.path}#run`), namedNode('https://schema.org/name'), literal(value)),
]), id, INTERNAL_QUADS);
async function consume(value: Representation): Promise<string[]> {
  return (await arrayifyStream<ReturnType<typeof quad>>(value.data)).map((item) => item.object.value);
}

describe('legacy storage revision upgrade under resource locks', () => {
  let directory: string;
  let engine: SolidRdfEngine;
  let accessor: SolidRdfDataAccessor;
  let locks: WrappedExpiringReadWriteLocker;
  let store: HierarchyLockingResourceStore;
  beforeEach(async () => {
    const parent = path.resolve('.test-data/storage-legacy-etag');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(path.join(parent, 'case-'));
    engine = new SolidRdfEngine({ index: new RdfQuadIndex({ path: path.join(directory, 'rdf.sqlite') }) });
    accessor = new SolidRdfDataAccessor(engine, new Strategy());
    await accessor.initialize();
    await accessor.writeContainer({ path: root }, new RepresentationMetadata({ path: root }));
    const metadata = new RepresentationMetadata(id);
    addResourceMetadata(metadata, false);
    updateModifiedDate(metadata);
    metadata.add(namedNode('https://example.com/custom'), literal('preserved'));
    // Seed the actual pre-revision metadata layout, without passing through today's writer.
    await engine.put(metadata.quads().map((item) => quad(item.subject, item.predicate, item.object, graph)));
    await engine.put([quad(namedNode(`${id.path}#run`), namedNode('https://schema.org/name'), literal('legacy'), namedNode(id.path))]);
    locks = new WrappedExpiringReadWriteLocker(
      new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 10_000,
    );
    store = new HierarchyLockingResourceStore(
      new DataAccessorBasedStore(accessor, new Strategy(), auxiliary, auxiliary), locks, auxiliary, new Strategy(),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await accessor.finalize();
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves old metadata and body, persists one stable revision, and supports conditional writes', async () => {
    const before = engine.scan({ pattern: { graph } }).quads;
    const response = await store.getRepresentation(id, {});
    const tag = etags.getETag(response.metadata)!;
    expect(tag).toMatch(/^"xpod-[a-f0-9]{32}-/);
    expect(await consume(response)).toEqual(['legacy']);
    const after = engine.scan({ pattern: { graph } }).quads;
    expect(after.filter((item) => !item.predicate.equals(HH.terms.etag))).toEqual(before);
    const again = await store.getRepresentation(id, {});
    expect(etags.getETag(again.metadata)).toBe(tag);
    await consume(again);
    const condition = new BasicConditions(etags, { matchesETag: [tag] });
    await store.setRepresentation(id, document('updated'), condition);
    await expect(store.setRepresentation(id, document('stale'), condition)).rejects.toBeInstanceOf(PreconditionFailedHttpError);
    expect(await arrayifyStream(await accessor.getData(id))).toEqual([
      quad(namedNode(`${id.path}#run`), namedNode('https://schema.org/name'), literal('updated')),
    ]);
    expect(etags.getETag(await accessor.getMetadata(id))).not.toBe(tag);
  });

  it('two readers release their read locks before initializing exactly once', async () => {
    const put = vi.spyOn(engine, 'put');
    const read = async (): Promise<string | undefined> => {
      const response = await store.getRepresentation(id, {});
      await consume(response);
      return etags.getETag(response.metadata);
    };
    const tags = await Promise.all([read(), read()]);
    expect(tags[0]).toBeTruthy();
    expect(tags[1]).toBe(tags[0]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('rechecks after a competing mutation and never replaces its newly committed revision', async () => {
    const original = locks.withWriteLock.bind(locks);
    let raced = false;
    vi.spyOn(locks, 'withWriteLock').mockImplementation(async (identifier, callback) => {
      if (!raced) {
        raced = true;
        await store.setRepresentation(id, document('concurrent writer'));
      }
      return original(identifier, callback);
    });
    const put = vi.spyOn(engine, 'put');
    const response = await store.getRepresentation(id, {});
    const committed = etags.getETag(await accessor.getMetadata(id));
    expect(etags.getETag(response.metadata)).toBe(committed);
    expect(await consume(response)).toEqual(['concurrent writer']);
    // The ordinary document write persists metadata and data; the upgrade adds neither.
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('fails closed on revision persistence failure and recovers without touching the old body', async () => {
    const put = vi.spyOn(engine, 'put').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    await expect(store.getRepresentation(id, {})).rejects.toThrow('storage unavailable');
    expect(etags.getETag(await accessor.getMetadata(id))).toBeUndefined();
    const response = await store.getRepresentation(id, {});
    expect(etags.getETag(response.metadata)).toBeTruthy();
    expect(await consume(response)).toEqual(['legacy']);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('keeps direct startup metadata reads side effect free and does not migrate inside a conditional write', async () => {
    const put = vi.spyOn(engine, 'put');
    expect(etags.getETag(await accessor.getMetadata(id))).toBeUndefined();
    const condition = new BasicConditions(etags, { matchesETag: ['"old-timestamp-version"'] });
    // Even a caller with inherited read context must not request a lock upgrade under the write lock.
    await storageVersionReadContext.run(true, async () => {
      await expect(store.setRepresentation(id, document('invalid'), condition)).rejects.toBeInstanceOf(PreconditionFailedHttpError);
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('preserves 404 without creating metadata for a missing resource', async () => {
    const put = vi.spyOn(engine, 'put');
    await expect(store.getRepresentation({ path: `${root}missing.ttl` }, {})).rejects.toBeInstanceOf(NotFoundHttpError);
    expect(put).not.toHaveBeenCalled();
  });

  it('returns the upgraded revision with actual local-file RDF bytes and rejects stale conditional writes', async () => {
    const dataDirectory = path.join(directory, 'data');
    await mkdir(dataDirectory);
    const files = new FileDataAccessor(new ExtensionBasedMapper(root, dataDirectory));
    const staleSidecarRevision = '11111111111111111111111111111111';
    const fileMetadata = new RepresentationMetadata(id, 'text/turtle');
    fileMetadata.set(HH.terms.etag, literal(staleSidecarRevision));
    const originalText = '<#run> <https://schema.org/name> "legacy" .\n';
    await files.writeDocument(id, new BasicRepresentation(originalText, fileMetadata).data, fileMetadata);
    const mix = new MixDataAccessor(accessor, files);
    const localStore = new HierarchyLockingResourceStore(new SparqlUpdateResourceStore({
      accessor: mix, identifierStrategy: new Strategy(), auxiliaryStrategy: auxiliary, metadataStrategy: auxiliary,
    }), locks, auxiliary, new Strategy());
    const response = await localStore.getRepresentation(id, {});
    const tag = etags.getETag(response.metadata)!;
    expect(response.metadata.contentType).toBe('text/turtle');
    expect(tag).toMatch(/^"xpod-[a-f0-9]{32}-/);
    expect(tag).not.toContain(staleSidecarRevision);
    expect((await arrayifyStream<Buffer>(response.data)).map((chunk) => chunk.toString()).join('')).toBe(originalText);
    const persistedMetadata = await accessor.getMetadata(id);
    expect(persistedMetadata.getAll(HH.terms.etag)).toHaveLength(1);
    expect(persistedMetadata.get(HH.terms.etag)?.value).toMatch(/^[a-f0-9]{32}$/);
    expect(getStorageVersion(response.metadata)).toBe(getStorageVersion(persistedMetadata));
    expect(response.metadata.getAll(HH.terms.etag)).toHaveLength(1);
    expect(response.metadata.get(HH.terms.etag)?.value).toBe(tag);
    const condition = new BasicConditions(etags, { matchesETag: [tag] });
    await localStore.setRepresentation(id, document('updated'), condition);
    await expect(localStore.setRepresentation(id, document('stale'), condition)).rejects.toBeInstanceOf(PreconditionFailedHttpError);
    const current = await localStore.getRepresentation(id, {});
    expect(etags.getETag(current.metadata)).not.toBe(tag);
    expect((await arrayifyStream<Buffer>(current.data)).map((chunk) => chunk.toString()).join('')).toContain('updated');
  });

  it('does not trust a file-side revision for RDF that has not been indexed', async () => {
    const dataDirectory = path.join(directory, 'data');
    await mkdir(dataDirectory);
    const files = new FileDataAccessor(new ExtensionBasedMapper(root, dataDirectory));
    const unindexed = { path: `${root}unindexed.ttl` };
    const metadata = new RepresentationMetadata(unindexed, 'text/turtle');
    metadata.set(HH.terms.etag, literal('11111111111111111111111111111111'));
    await files.writeDocument(unindexed, new BasicRepresentation('<#run> <urn:name> "file" .', metadata).data, metadata);
    const local = await new MixDataAccessor(accessor, files).getLocalRdfDocument(unindexed);
    expect(etags.getETag(local.metadata)).toBeUndefined();
    expect((await arrayifyStream<Buffer>(local.data)).map((chunk) => chunk.toString()).join('')).toContain('file');
    await expect(accessor.getMetadata(unindexed)).rejects.toBeInstanceOf(NotFoundHttpError);
  });
});
