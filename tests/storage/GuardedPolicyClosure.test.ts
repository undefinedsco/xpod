// Actual HTTP/Mix/native fixture for policy-shape negatives; synthetic producer only
// for the byte-budget boundary. These are not production QLever/DPoP claims.
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { DataFactory } from 'n3';
import { BasicRepresentation, RepresentationMetadata, RDF, LDP, INTERNAL_QUADS,
  SingleRootIdentifierStrategy, SuffixAuxiliaryIdentifierStrategy, GreedyReadWriteLocker,
  MemoryResourceLocker, MemoryMapStorage } from '@solid/community-server';
import { guardedPolicyClosureFixture } from '../helpers/GuardedPolicyClosureFixture';
import { GuardedPolicyClosure } from '../../src/storage/GuardedPolicyClosure';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import type { DataAccessor, ResourceStore } from '@solid/community-server';
import type { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
const acl = 'http://www.w3.org/ns/auth/acl#';
describe('guarded complete policy closure developer boundaries', () => {
  it.each([
    `<urn:rule> <${acl}agentGroup> <https://group.example/team> .`,
    `<urn:rule> <${acl}agentClass> <https://unknown.example/Class> .`,
    `<urn:rule> a <https://unknown.example/Policy> .`,
  ])('refuses unsupported ground WAC matching while retaining the source', async extension => {
    await guardedPolicyClosureFixture(async f => {
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n${extension}`);
      const expected = f.expected();
      f.native.mockClear();
      const before = await f.readPersisted(f.document);
      const response = await f.post({version: 1, update: f.sourceUpdate, guard: expected});
      expect(response.status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.document)).toBe(before);
    });
  });
  it('drains an early ground-term rejection and retains its HTTP denial', async () => {
    await guardedPolicyClosureFixture(async f => {
      const guard = f.expected();
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n_:unsupported <http://www.w3.org/2000/01/rdf-schema#label> "blank" .`);
      f.native.mockClear();
      const response = await f.post({version: 1, update: f.sourceUpdate, guard});
      expect(response.status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
      // Successful ordinary LDP write after denial demonstrates that the actual held read drained.
      await expect(f.putRdf(f.podAcl, f.ownerPolicy)).resolves.toBeDefined();
    });
  });

  it('rejects a document whose persisted metadata falsely claims to be a container', async () => {
    await guardedPolicyClosureFixture(async f => {
      const guard = f.expected();
      const metadata = await f.accessor.getMetadata({path: f.document});
      metadata.add(RDF.terms.type, LDP.terms.Container);
      await f.locks.withWriteLock({path: f.document}, () => f.accessor.writeMetadata({path: f.document}, metadata));
      expect((await f.accessor.getMetadata({path: f.document})).has(RDF.terms.type, LDP.terms.Container)).toBe(true);
      f.native.mockClear();
      const response = await f.post({version: 1, update: f.sourceUpdate, guard});
      expect(response.status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('counts a literal datatype in the total closure byte budget', async () => {
    const root = 'https://budget.example/';
    const identifiers = new SingleRootIdentifierStrategy(root);
    const locks = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), identifiers);
    const auxiliary = new SuffixAuxiliaryIdentifierStrategy('.acl');
    const meta = new RepresentationMetadata({path: root}, INTERNAL_QUADS);
    meta.add(RDF.terms.type, LDP.terms.Container);
    const backend = {getMetadata: async () => meta, getChildren: async function* () {}} as unknown as DataAccessor;
    const accessor = new MixDataAccessor(backend, backend);
    const quad = DataFactory.quad(DataFactory.namedNode('urn:rule'), DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
      DataFactory.literal('small', DataFactory.namedNode(`https://datatype.example/${'x'.repeat(8 * 1024 * 1024)}`)));
    const store = new LockingResourceStore({getRepresentation: async () => new BasicRepresentation(Readable.from([quad], {objectMode: true}), meta)} as unknown as ResourceStore, locks, auxiliary);
    const podLookup = {findByResourceIdentifier: async () => ({baseUrl: root, podId: 'budget', accountId: 'budget'})} as unknown as PodLookupRepository;
    const closure = new GuardedPolicyClosure({accessor, store, locks, identifierStrategy: identifiers, authStrategy: auxiliary, auxiliaryStrategy: auxiliary, podLookup});
    await expect(closure.read(root)).rejects.toThrow(/total body budget/);
  });
});
