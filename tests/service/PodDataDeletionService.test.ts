import { describe, expect, it, vi } from 'vitest';
import { NotFoundHttpError, RepresentationMetadata } from '@solid/community-server';
import type { AuxiliaryStrategy, ResourceIdentifier } from '@solid/community-server';
import type { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { PodDataDeletionService } from '../../src/service/PodDataDeletionService';

const root = { path: 'https://pod.example/alice/' };
const id = (suffix: string): ResourceIdentifier => ({ path: `${root.path}${suffix}` });

function fixture() {
  const resources = new Set([ root.path, id('nested/').path, id('nested/data.ttl').path, id('photo.png').path ]);
  const indexes = new Set(resources);
  const events: string[] = [];
  const accessor = {
    async* getChildren(identifier: ResourceIdentifier) {
      events.push(`list:${identifier.path}`);
      if (!resources.has(identifier.path)) { throw new NotFoundHttpError(); }
      for (const resource of resources) {
        const suffix = resource.slice(identifier.path.length);
        if (resource.startsWith(identifier.path) && suffix && !suffix.replace(/\/$/u, '').includes('/')) {
          yield new RepresentationMetadata({ path: resource });
        }
      }
    },
    deleteResource: vi.fn(async (identifier: ResourceIdentifier) => {
      events.push(`data:${identifier.path}`);
      if (!resources.delete(identifier.path)) { throw new NotFoundHttpError(); }
    }),
    deletePodRdfGraphs: vi.fn(async () => {}),
    deleteLocalRdfIndex: vi.fn(async (identifier: ResourceIdentifier) => {
      events.push(`index:${identifier.path}`);
      indexes.delete(identifier.path);
    }),
  };
  const auxiliaryStrategy = {
    isAuxiliaryIdentifier: (identifier: ResourceIdentifier) => identifier.path.endsWith('.acl'),
    getAuxiliaryIdentifiers: (identifier: ResourceIdentifier) => [{ path: `${identifier.path}.acl` }],
  };
  return {
    accessor, auxiliaryStrategy, resources, indexes, events,
    service: new PodDataDeletionService(accessor as unknown as MixDataAccessor, auxiliaryStrategy as AuxiliaryStrategy),
  };
}

describe('PodDataDeletionService', () => {
  it('snapshots children and auxiliaries before mutation, deletes nested content and source indexes before the root', async () => {
    const f = fixture();
    f.resources.add(id('.acl').path);
    f.resources.add(id('nested/data.ttl.acl').path);
    await f.service.deletePodData(root);
    expect(f.resources.size).toBe(0);
    expect(f.indexes.size).toBe(0);
    const firstMutation = f.events.findIndex((event) => event.startsWith('data:'));
    expect(f.events.slice(firstMutation).some((event) => event.startsWith('list:'))).toBe(false);
    expect(f.events.indexOf(`data:${id('nested/data.ttl').path}`)).toBeLessThan(f.events.indexOf(`data:${id('nested/').path}`));
    expect(f.events.indexOf(`data:${id('nested/data.ttl.acl').path}`)).toBeLessThan(f.events.indexOf(`data:${id('nested/data.ttl').path}`));
    expect(f.events.slice(-2)).toEqual([`data:${root.path}`, `index:${root.path}`]);
    expect(f.accessor.deleteResource.mock.calls.filter(([identifier]) => identifier.path === id('.acl').path)).toHaveLength(1);
    for (const [identifier] of f.accessor.deleteResource.mock.calls) {
      expect(f.events.indexOf(`data:${identifier.path}`)).toBeLessThan(f.events.indexOf(`index:${identifier.path}`));
    }
    await expect(f.service.deletePodData(root)).resolves.toBeUndefined();
  });

  it('does not delete anything if enumeration fails or escapes the Pod boundary', async () => {
    for (const failure of [new Error('disk unavailable'), undefined]) {
      const f = fixture();
      f.accessor.getChildren = async function* () {
        yield new RepresentationMetadata(id('ok.ttl'));
        if (failure) { throw failure; }
        yield new RepresentationMetadata({ path: 'https://pod.example/bob/private.ttl' });
      };
      await expect(f.service.deletePodData(root)).rejects.toThrow();
      expect(f.accessor.deleteResource).not.toHaveBeenCalled();
    }
  });

  it('propagates content failures and leaves the root intact for retry', async () => {
    const f = fixture();
    f.accessor.deleteResource.mockRejectedValueOnce(new Error('permission denied'));
    await expect(f.service.deletePodData(root)).rejects.toThrow('permission denied');
    expect(f.resources.has(root.path)).toBe(true);
    expect(f.accessor.deleteLocalRdfIndex).not.toHaveBeenCalled();
    await f.service.deletePodData(root);
    expect(f.resources.size).toBe(0);
  });

  it('retries source cleanup across service instances using a persisted snapshot after content disappears', async () => {
    const f = fixture();
    const rdfPath = id('nested/data.ttl').path;
    const plan = JSON.parse(JSON.stringify(await f.service.prepare(root)));
    const original = f.accessor.deleteLocalRdfIndex.getMockImplementation()!;
    let failOnce = true;
    f.accessor.deleteLocalRdfIndex.mockImplementation(async (identifier) => {
      if (identifier.path === rdfPath && failOnce) {
        failOnce = false;
        throw new Error('index busy');
      }
      await original(identifier);
    });
    await expect(f.service.deletePodData(root, plan)).rejects.toThrow('index busy');
    expect(f.resources.has(rdfPath)).toBe(false);
    expect(f.indexes.has(rdfPath)).toBe(true);
    expect(f.resources.has(root.path)).toBe(true);
    const restarted = new PodDataDeletionService(f.accessor as unknown as MixDataAccessor, f.auxiliaryStrategy as AuxiliaryStrategy);
    await restarted.deletePodData(root, plan);
    expect(f.indexes.size).toBe(0);
    expect(f.resources.size).toBe(0);
  });

  it('rejects mismatched, outside, duplicated or wrongly ordered persisted plans before any mutation', async () => {
    const f = fixture();
    const valid = await f.service.prepare(root);
    for (const plan of [
      { ...valid, baseUrl: 'https://pod.example/bob/' },
      { ...valid, resources: ['https://pod.example/bob/file', root.path] },
      { ...valid, resources: [id('../bob/file').path, root.path] },
      { ...valid, resources: [id('file').path, id('file').path, root.path] },
      { ...valid, resources: [id('nested/').path, id('nested/file').path, root.path] },
    ]) {
      await expect(f.service.deletePodData(root, plan)).rejects.toThrow();
    }
    expect(f.accessor.deleteResource).not.toHaveBeenCalled();
  });

  it('does not swallow filesystem or arbitrary 404-shaped errors', async () => {
    for (const error of [Object.assign(new Error('missing'), { code: 'ENOENT' }), { statusCode: 404 }]) {
      const f = fixture();
      f.accessor.deleteResource.mockRejectedValueOnce(error);
      await expect(f.service.deletePodData(root)).rejects.toBe(error);
    }
  });
});

// Exercise the actual source-provenance and mirrored-file lifecycle, not only
// the call ordering of an accessor mock.
describe('PodDataDeletionService with MixDataAccessor', () => {
  it('removes nested RDF sources, auxiliaries and content without touching another Pod', async () => {
    const { mkdtemp, mkdir, rm, stat } = await import('node:fs/promises');
    const path = await import('node:path');
    const { Readable } = await import('node:stream');
    const { ExtensionBasedMapper, FileDataAccessor, BaseIdentifierStrategy, guardStream, INTERNAL_QUADS } = await import('@solid/community-server');
    const { DataFactory } = await import('n3');
    const { MixDataAccessor } = await import('../../src/storage/accessors/MixDataAccessor');
    const { SolidRdfDataAccessor } = await import('../../src/storage/accessors/SolidRdfDataAccessor');
    const { SolidRdfEngine } = await import('../../src/storage/rdf');
    const testRoot = path.resolve('.test-data/pod-data-deletion');
    await mkdir(testRoot, { recursive: true });
    const workDir = await mkdtemp(path.join(testRoot, 'run-'));
    class IdentifierStrategy extends BaseIdentifierStrategy {
      public supportsIdentifier(identifier: ResourceIdentifier): boolean { return identifier.path.startsWith('https://pod.example/'); }
      public isRootContainer(identifier: ResourceIdentifier): boolean { return identifier.path === 'https://pod.example/'; }
    }
    const engine = new SolidRdfEngine({ index: { path: path.join(workDir, 'rdf.sqlite') } });
    const structured = new SolidRdfDataAccessor(engine, new IdentifierStrategy());
    try {
      const mapper = new ExtensionBasedMapper('https://pod.example/', path.join(workDir, 'data'));
      const accessor = new MixDataAccessor(structured, new FileDataAccessor(mapper));
      const auxiliaries = fixture().auxiliaryStrategy as AuxiliaryStrategy;
      const service = new PodDataDeletionService(accessor, auxiliaries);
      for (const identifier of [root, id('nested/'), { path: 'https://pod.example/bob/' }]) {
        const metadata = new RepresentationMetadata(identifier);
        metadata.contentType = INTERNAL_QUADS;
        await accessor.writeContainer(identifier, metadata);
      }
      const rdf = id('nested/data.ttl');
      const acl = id('.acl');
      const other = { path: 'https://pod.example/bob/keep.ttl' };
      for (const identifier of [rdf, acl, other]) {
        const metadata = new RepresentationMetadata(identifier);
        metadata.contentType = INTERNAL_QUADS;
        await accessor.writeDocument(identifier, guardStream(Readable.from([
          DataFactory.quad(DataFactory.namedNode(identifier.path), DataFactory.namedNode('https://schema.org/name'), DataFactory.literal('retained fact')),
        ])), metadata);
      }
      const orphan = id('.settings/privateTypeIndex.ttl');
      const orphanMeta = { path: `meta:${orphan.path}` };
      const unrelatedGraph = DataFactory.namedNode('https://pod.example/alice-other/orphan');
      engine.index.multiPut([
        DataFactory.quad(DataFactory.namedNode(orphan.path), DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), DataFactory.namedNode('http://www.w3.org/ns/solid/terms#TypeIndex'), DataFactory.namedNode(orphan.path)),
        DataFactory.quad(DataFactory.namedNode(orphan.path), DataFactory.namedNode('https://schema.org/name'), DataFactory.literal('orphan metadata'), DataFactory.namedNode(orphanMeta.path)),
        DataFactory.quad(unrelatedGraph, DataFactory.namedNode('https://schema.org/name'), DataFactory.literal('keep unrelated'), unrelatedGraph),
      ]);
      const photo = id('photo.png');
      const photoMetadata = new RepresentationMetadata(photo);
      photoMetadata.contentType = 'image/png';
      await accessor.writeDocument(photo, guardStream(Readable.from([Buffer.from([1, 2, 3])])), photoMetadata);
      const rdfFile = await mapper.mapUrlToFilePath(rdf, false, 'text/turtle');
      const photoFile = await mapper.mapUrlToFilePath(photo, false, 'image/png');
      await expect(stat(rdfFile.filePath)).resolves.toBeDefined();
      expect(engine.storageStats().facts.sourceCount).toBe(3);
      const plan = await service.prepare(root);
      await service.deletePodData(root, plan);
      await expect(stat(rdfFile.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(photoFile.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(accessor.getMetadata(root)).rejects.toBeInstanceOf(NotFoundHttpError);
      await expect(accessor.getMetadata(acl)).rejects.toBeInstanceOf(NotFoundHttpError);
      await expect(accessor.getMetadata(other)).resolves.toBeDefined();
      expect(engine.storageStats().facts.sourceCount).toBe(1);
      expect(engine.scan({ pattern: { graph: { $startsWith: root.path } } }).quads).toHaveLength(0);
      expect(engine.scan({ pattern: { graph: { $startsWith: `meta:${root.path}` } } }).quads).toHaveLength(0);
      expect(engine.scan({ pattern: { graph: unrelatedGraph } }).quads).toHaveLength(1);
      expect(engine.scan({ pattern: { graph: DataFactory.namedNode(other.path) } }).quads).toHaveLength(1);
      await expect(service.deletePodData(root, plan)).resolves.toBeUndefined();
    } finally {
      await structured.finalize();
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe('PodDataDeletionService legacy provisioning mirror', () => {
  it('removes only Pod-scoped quints and parent containment even after primary metadata has disappeared', async () => {
    const { DataFactory } = await import('n3');
    const { SqliteQuintStore } = await import('../../src/storage/quint/SqliteQuintStore');
    const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
    const path = await import('node:path');
    const testRoot = path.resolve('.test-data/pod-deletion-legacy-mirror');
    await mkdir(testRoot, { recursive: true });
    const workDir = await mkdtemp(path.join(testRoot, 'run-'));
    const mirror = new SqliteQuintStore({ path: path.join(workDir, 'quadstore.sqlite') });
    await mirror.open();
    const { namedNode, literal, quad } = DataFactory;
    const contains = namedNode('http://www.w3.org/ns/ldp#contains');
    const parent = namedNode('https://pod.example/');
    const other = namedNode('https://pod.example/alice-other/');
    const own = [
      quad(namedNode(id('orphan.ttl').path), namedNode('https://schema.org/name'), literal('orphan'), namedNode(id('orphan.ttl').path)),
      quad(namedNode(id('orphan.ttl').path), namedNode('https://schema.org/name'), literal('metadata'), namedNode(`meta:${id('orphan.ttl').path}`)),
      quad(parent, contains, namedNode(root.path), parent),
    ];
    const keep = [
      quad(other, namedNode('https://schema.org/name'), literal('keep'), other),
      quad(other, namedNode('https://schema.org/name'), literal('keep meta'), namedNode(`meta:${other.value}`)),
      quad(parent, contains, other, parent),
    ];
    await mirror.multiPut([...own, ...keep]);
    const f = fixture();
    const plan = await f.service.prepare(root);
    // First primary pass succeeded, then legacy storage failed before cleanup.
    await f.service.deletePodData(root, plan);
    const service = new PodDataDeletionService(f.accessor as unknown as MixDataAccessor, f.auxiliaryStrategy as AuxiliaryStrategy, mirror);
    try {
      const close = vi.spyOn(mirror, 'close');
      vi.spyOn(mirror, 'multiDel').mockRejectedValueOnce(new Error('legacy mirror unavailable'));
      await expect(service.deletePodData(root, plan)).rejects.toThrow('legacy mirror unavailable');
      expect(close).toHaveBeenCalledTimes(1);
      await service.deletePodData(root, plan);
      await mirror.open();
      expect(await mirror.count({})).toBe(keep.length);
      expect(await mirror.getByGraphPrefix(root.path)).toHaveLength(0);
      expect(await mirror.getByGraphPrefix(`meta:${root.path}`)).toHaveLength(0);
      for (const statement of keep) {
        expect(await mirror.count({ graph: statement.graph, subject: statement.subject, predicate: statement.predicate, object: statement.object })).toBe(1);
      }
    } finally { await mirror.close(); await rm(workDir, { recursive: true, force: true }); }
  });
});
