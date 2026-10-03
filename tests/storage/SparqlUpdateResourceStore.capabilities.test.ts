import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import {
  BasicConditions, BasicETagHandler, BasicRepresentation, BadRequestHttpError, ForbiddenHttpError,
  ComposedAuxiliaryStrategy, EqualReadWriteLocker, InMemoryDataAccessor, LockingResourceStore,
  MemoryResourceLocker, NotImplementedHttpError, PatchingStore, PreconditionFailedHttpError,
  RepresentationMetadata, RepresentationPatchHandler, RdfPatcher, SparqlUpdateBodyParser,
  SparqlUpdatePatcher, SuffixAuxiliaryIdentifierStrategy, WrappedExpiringReadWriteLocker,
  guardedStreamFrom, readableToString, type HttpRequest, type Patch,
} from '@solid/community-server';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { SparqlUpdateResourceStore } from '../../src/storage/SparqlUpdateResourceStore';
import { ClusterIdentifierStrategy } from '../../src/util/identifiers/ClusterIdentifierStrategy';
import { DisabledSparqlFeatureError, UnsupportedSparqlQueryError } from '../../src/storage/rdf/RdfSparqlBoundary';

const root = 'https://id.example/';
const card = { path: `${root}alice/profile/card` };
const webId = `${card.path}#me`;
const name = 'http://xmlns.com/foaf/0.1/name';
const solidStorage = 'http://www.w3.org/ns/solid/terms#storage';
const pimStorage = 'http://www.w3.org/ns/pim/space#storage';
const pod = 'https://node.example/alice/';
const { namedNode, literal, quad } = DataFactory;

function metadata(identifier: { path: string }, contentType: string): RepresentationMetadata {
  const result = new RepresentationMetadata(identifier);
  result.contentType = contentType;
  return result;
}

async function patch(text: string, identifier = card): Promise<Patch> {
  return new SparqlUpdateBodyParser().handleSafe({
    request: guardedStreamFrom(text) as unknown as HttpRequest,
    metadata: metadata(identifier, 'application/sparql-update'),
  });
}

function fixture() {
  const identifiers = new ClusterIdentifierStrategy({ baseUrl: root });
  const auxiliary = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.meta'));
  const prepare = vi.fn(async () => ({ graphs: [{ graphIri: card.path, sourceUri: card.path,
    deletes: [], inserts: [quad(namedNode(webId), namedNode(solidStorage), namedNode(pod), namedNode(card.path))],
  }] }));
  const structured = Object.assign(new InMemoryDataAccessor(identifiers), { prepareSparqlUpdate: prepare });
  const files = new InMemoryDataAccessor(identifiers);
  const mix = new MixDataAccessor(structured, files);
  const direct = vi.spyOn(mix, 'executeSparqlUpdate');
  const backend = new SparqlUpdateResourceStore({ accessor: mix, identifierStrategy: identifiers,
    auxiliaryStrategy: auxiliary, metadataStrategy: auxiliary,
    localFirstRdfRepresentationResolver: { resolve: async () => undefined },
  });
  const fallback = new RepresentationPatchHandler(new RdfPatcher(new SparqlUpdatePatcher()));
  const fallbackRun = vi.spyOn(fallback, 'handleSafe');
  const locks = new WrappedExpiringReadWriteLocker(new EqualReadWriteLocker(new MemoryResourceLocker()), 5_000);
  const writeLock = vi.spyOn(locks, 'withWriteLock');
  const store = new LockingResourceStore(new PatchingStore(backend, fallback), locks, auxiliary);
  const represent = (items: Quad[]) => new BasicRepresentation(guardedStreamFrom(items),
    metadata(card, 'internal/quads'), false);
  const initialize = async () => {
    await store.setRepresentation(card, represent([quad(namedNode(webId), namedNode(name), literal('Initial'))]));
    writeLock.mockClear();
  };
  return { mix, direct, prepare, backend, store, represent, initialize, fallbackRun, writeLock };
}

const binding = `INSERT DATA { <${webId}> <${solidStorage}> <${pod}>; <${pimStorage}> <${pod}>. }`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('direct SPARQL PATCH resource capabilities', () => {
  it.each([
    ['profile/card', false], ['settings/preferences', false], ['data.rdf', false],
    ['data.ttl', true], ['data.jsonld', true], ['data.nt', true],
  ])('declares direct authority for %s by generic by-line capability', (suffix, expected) => {
    const f = fixture();
    expect(f.mix.supportsSparqlUpdate({ path: `${root}alice/${suffix}` })).toBe(expected);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('declines an unsupported target before consuming the original patch stream or preparing a delta', async () => {
    const f = fixture();
    await f.initialize();
    const update = await patch(binding);
    await expect(f.backend.modifyResource(card, update)).rejects.toBeInstanceOf(NotImplementedHttpError);
    expect(await readableToString(update.data)).toBe(binding);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.direct).not.toHaveBeenCalled();
  });

  it('applies the untouched additive patch through real CSS fallback inside the canonical resource lock', async () => {
    const f = fixture();
    await f.initialize();
    await f.store.modifyResource(card, await patch(binding),
      new BasicConditions(new BasicETagHandler(), { matchesETag: ['*'] }));
    const result = await f.store.getRepresentation(card, { type: { 'internal/quads': 1 } });
    const items = await arrayifyStream<Quad>(result.data);
    expect(items.some((item) => item.predicate.value === name && item.object.value === 'Initial')).toBe(true);
    for (const predicate of [solidStorage, pimStorage]) {
      expect(items.some((item) => item.subject.value === webId && item.predicate.value === predicate && item.object.value === pod)).toBe(true);
    }
    expect(f.writeLock.mock.calls.map(([identifier]) => identifier.path)).toEqual([card.path]);
    expect(f.fallbackRun).toHaveBeenCalledTimes(1);
    expect(f.direct).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('serializes concurrent owner edits and storage bindings even within one modification second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const allowRead = deferred();
    try {
      const f = fixture();
      await f.initialize();
      const initial = await f.store.getRepresentation(card, { type: { 'internal/quads': 1 } });
      await arrayifyStream(initial.data);
      const readEntered = deferred();
      const get = f.backend.getRepresentation.bind(f.backend);
      vi.spyOn(f.backend, 'getRepresentation').mockImplementationOnce(async (identifier) => {
        readEntered.resolve();
        await allowRead.promise;
        return get(identifier);
      });
      const addingBinding = f.store.modifyResource(card, await patch(binding));
      await Promise.race([readEntered.promise, addingBinding]);
      const ownerPatch = await patch(`INSERT DATA { <${webId}> <${name}> "Owner edit". }`);
      const ownerEdit = f.store.modifyResource(card, ownerPatch);
      await Promise.resolve();
      expect(f.fallbackRun).toHaveBeenCalledTimes(1);
      allowRead.resolve();
      await Promise.all([addingBinding, ownerEdit]);
      const result = await f.store.getRepresentation(card, { type: { 'internal/quads': 1 } });
      const items = await arrayifyStream<Quad>(result.data);
      expect(result.metadata.get(namedNode('http://purl.org/dc/terms/modified'))?.value)
        .toBe(initial.metadata.get(namedNode('http://purl.org/dc/terms/modified'))?.value);
      expect(items.some((item) => item.predicate.value === name && item.object.value === 'Owner edit')).toBe(true);
      for (const predicate of [solidStorage, pimStorage]) {
        expect(items.some((item) => item.predicate.value === predicate && item.object.value === pod)).toBe(true);
      }
      expect(f.writeLock.mock.calls.map(([identifier]) => identifier.path)).toEqual([card.path, card.path]);
      expect(f.prepare).not.toHaveBeenCalled();
    } finally { allowRead.resolve(); vi.useRealTimers(); }
  });

  it('checks conditions before declining native execution so fallback cannot resurrect a missing card', async () => {
    const f = fixture();
    const update = await patch(binding);
    await expect(f.store.modifyResource(card, update,
      new BasicConditions(new BasicETagHandler(), { matchesETag: ['*'] })))
      .rejects.toBeInstanceOf(PreconditionFailedHttpError);
    expect(f.fallbackRun).not.toHaveBeenCalled();
    expect(await readableToString(update.data)).toBe(binding);
  });

  it('keeps eligible by-line resources on the direct native path', async () => {
    const f = fixture();
    f.direct.mockResolvedValueOnce(undefined);
    const identifier = { path: `${root}alice/data.ttl` };
    await f.store.modifyResource(identifier, await patch(binding, identifier));
    expect(f.direct).toHaveBeenCalledTimes(1);
    expect(f.direct.mock.calls[0][1]).toBe(identifier.path);
    expect(f.fallbackRun).not.toHaveBeenCalled();
  });

  it.each([
    [new UnsupportedSparqlQueryError('Native update shape is unsupported'), BadRequestHttpError],
    [new DisabledSparqlFeatureError('Native feature is disabled'), ForbiddenHttpError],
  ])('does not reinterpret native execution errors as capability fallback', async (failure, expected) => {
    const f = fixture();
    f.direct.mockRejectedValueOnce(failure);
    const identifier = { path: `${root}alice/data.ttl` };
    await expect(f.store.modifyResource(identifier, await patch(binding, identifier))).rejects.toBeInstanceOf(expected);
    expect(f.fallbackRun).not.toHaveBeenCalled();
  });

  it('preserves the standard CSS patcher syntax and unsupported-operation errors', async () => {
    const f = fixture();
    await f.initialize();
    await expect(patch('INSERT DATA {')).rejects.toBeInstanceOf(BadRequestHttpError);
    await expect(f.store.modifyResource(card, await patch('CLEAR ALL'))).rejects.toBeInstanceOf(NotImplementedHttpError);
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
