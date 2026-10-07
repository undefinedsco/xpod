// Root-owned real HTTP + actual CSS WAC/locks + Mix persisted native-protocol
// acceptance. Comunica protocol producer, no production QLever/current Gateway claim.
import { describe, expect, it, vi } from 'vitest';
import { guardedPolicyClosureFixture, guardedMedia, expectedGroundDigest } from '../helpers/GuardedPolicyClosureFixture';
import { metadataRequestContext } from '../../src/storage/MetadataRequestContext';
import { AuthorityResourceTracker, authorityResourceTracker } from '../../src/storage/AuthorityResourceTracker';
import { RepresentationMetadata, RDF, LDP } from '@solid/community-server';
import { Parser } from 'n3';
import { GuardedPolicyClosure } from '../../src/storage/GuardedPolicyClosure';

describe('independent guarded full policy closure at the actual HTTP commit boundary', () => {
  it('preserves ordinary plain SPARQL on the actual persisted source graph', async () => {
    await guardedPolicyClosureFixture(async f => {
      expect((await f.post(f.sourceUpdate, 'application/sparql-update')).status).toBe(204);
      expect(await f.readPersisted(f.document)).toContain('committed');
      expect(f.native).toHaveBeenCalledOnce();
      expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
    });
  });

  it.each([ 'source', 'policy' ] as const)('accepts an unchanged complete closure for a single %s write and persists it', async kind => {
    await guardedPolicyClosureFixture(async f => {
      const response = await f.post({ version: 1, update: kind === 'source' ? f.sourceUpdate : f.policyUpdate, guard: f.expected() });
      expect(response.status, response.text).toBe(204);
      expect(f.native).toHaveBeenCalledOnce();
      expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
      if (kind === 'source') expect(await f.readPersisted(f.document)).toContain('committed');
      else expect(await f.readPersisted(f.roomAcl)).toContain(f.owner);
    });
  });

  it.each([ 'source', 'policy' ] as const)('rejects a new empty descendant after observation before %s write', async kind => {
    await guardedPolicyClosureFixture(async f => {
      const guard = f.expected();
      await f.putContainer(`${f.room}new-empty/`);
      f.native.mockClear();
      const before = await f.readPersisted(f.document);
      const response = await f.post({ version: 1, update: kind === 'source' ? f.sourceUpdate : f.policyUpdate, guard });
      expect(response.status, response.text).toBe(409);
      expect(await f.readPersisted(f.document)).toBe(before);
      expect(f.native).not.toHaveBeenCalled();
      expect(f.queryEngine.queryVoid).not.toHaveBeenCalled();
    });
  });

  it.each([ 'source', 'policy' ] as const)('rejects a required ancestor full-content change before %s write', async kind => {
    await guardedPolicyClosureFixture(async f => {
      const guard = f.expected();
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n<${f.podAcl}#owner> <http://www.w3.org/2000/01/rdf-schema#label> "changed after observation" .`);
      f.native.mockClear();
      const before = await f.readPersisted(f.document);
      const response = await f.post({ version: 1, update: kind === 'source' ? f.sourceUpdate : f.policyUpdate, guard });
      expect(response.status, response.text).toBe(409);
      expect(await f.readPersisted(f.document)).toBe(before);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('does not downgrade an unsupported version to plain SPARQL', async () => {
    await guardedPolicyClosureFixture(async f => {
      const response = await f.post({ version: 77, update: f.sourceUpdate, guard: f.expected() });
      expect(response.status, response.text).toBe(400);
      expect(await f.readPersisted(f.document)).toContain('pending');
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('rejects an unknown media type without a mutation', async () => {
    await guardedPolicyClosureFixture(async f => {
      expect((await f.post(f.sourceUpdate, `${guardedMedia}-unknown`)).status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it.each([ 'normal', 'authorization' ] as const)('refuses a same-Pod %s write whose actual write-lock subject is outside the room', async kind => {
    await guardedPolicyClosureFixture(async f => {
      const outside = `${f.pod}outside.ttl${kind === 'authorization' ? '.acl' : ''}`;
      const query = f.policyUpdate.replaceAll(`<${f.roomAcl}>`, `<${outside}>`);
      const before = await f.readPersisted(f.document);
      const response = await f.post({ version: 1, update: query, guard: f.expected() });
      expect(response.status, response.text).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.document)).toBe(before);
    });
  });

  it('rejects a warm policy 404 replaced through the actual shared-lock writer with an independent worker generation', async () => {
    await guardedPolicyClosureFixture(async f => {
      const { historyPolicy, guard } = await f.withHistory();
      const before = await f.readPersisted(f.document);
      const generation = authorityResourceTracker.snapshot(historyPolicy);
      const otherWorker = new AuthorityResourceTracker();
      const originalPlan = f.locks.withWriteLockAndReadDependencies.bind(f.locks);
      const plan = vi.spyOn(f.locks, 'withWriteLockAndReadDependencies').mockImplementationOnce(async (...args) => {
        // Real ordinary CSS WRITE, outside A's cache; only the process-local generation
        // tracker is separate, as it is in another CSS worker sharing the lock/backend.
        const mutation = vi.spyOn(authorityResourceTracker, 'runMutation').mockImplementation((iri, callback) => otherWorker.runMutation(iri, callback));
        try {
          await metadataRequestContext.run({ metadataCache: new Map() }, () => f.putRdf(historyPolicy, ''));
        } finally { mutation.mockRestore(); }
        return originalPlan(...args);
      });
      try {
        const response = await f.post({ version: 1, update: f.sourceUpdate, guard });
        expect(otherWorker.generation(historyPolicy), JSON.stringify({ response, planned: plan.mock.calls.length, nativeWrites: f.native.mock.calls.length })).toBe(1);
        expect(authorityResourceTracker.snapshot(historyPolicy)).toEqual(generation);
        expect(response.status, JSON.stringify({ response, nativeWrites: f.native.mock.calls.length })).toBe(409);
        expect(f.native).not.toHaveBeenCalled();
        expect(await f.readPersisted(f.document)).toBe(before);
      } finally { plan.mockRestore(); }
    });
  });

  it('refuses an orphan policy that was never in the actual resource-to-policy closure', async () => {
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.room}orphan.acl`;
      const query = f.policyUpdate.replaceAll(`<${f.roomAcl}>`, `<${target}>`);
      const response = await f.post({ version: 1, update: query, guard: f.expected() });
      expect(response.status, JSON.stringify({ response, nativeWrites: f.native.mock.calls.length })).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('does not widen room WHERE data access to an unrelated Pod graph through the new media', async () => {
    await guardedPolicyClosureFixture(async f => {
      const outside = `${f.pod}outside-data.ttl`;
      await f.putRdf(outside, '<urn:root:outside> <urn:root:value> "unrelated" .');
      f.native.mockClear();
      const query = f.sourceUpdate.replace('WHERE {', `WHERE { GRAPH <${outside}> { <urn:root:outside> <urn:root:value> "unrelated" }`);
      expect((await f.post(query, 'application/sparql-update')).status).toBe(400);
      expect(f.native).not.toHaveBeenCalled();
      const response = await f.post({ version: 1, update: query, guard: f.expected() });
      expect(response.status, JSON.stringify({ response, nativeWrites: f.native.mock.calls.length })).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('refuses missing child metadata after discovery even when containment and A local generation stay unchanged', async () => {
    await guardedPolicyClosureFixture(async f => {
      const { history, guard } = await f.withHistory();
      const generation = authorityResourceTracker.snapshot(history);
      const otherWorker = new AuthorityResourceTracker();
      const originalPlan = f.locks.withWriteLockAndReadDependencies.bind(f.locks);
      const plan = vi.spyOn(f.locks, 'withWriteLockAndReadDependencies').mockImplementationOnce(async (...args) => {
        const mutation = vi.spyOn(authorityResourceTracker, 'runMutation').mockImplementation((iri, callback) => otherWorker.runMutation(iri, callback));
        try {
          // Actual adapter fault/recovery window: erase metadata, preserving ldp:contains.
          // This is a lower-level write under the real hierarchy lock, not a normal HTTP
          // deletion claim. It exercises the server's missing-vs-empty obligation.
          await metadataRequestContext.run({ metadataCache: new Map() }, () => f.locks.withWriteLock({ path: history }, () => f.accessor.writeMetadata({ path: history }, new RepresentationMetadata({ path: history }))));
        } finally { mutation.mockRestore(); }
        return originalPlan(...args);
      });
      try {
        const response = await f.post({ version: 1, update: f.sourceUpdate, guard });
        expect(otherWorker.generation(history)).toBe(1);
        expect(authorityResourceTracker.snapshot(history)).toEqual(generation);
        expect(response.status, JSON.stringify({ response, nativeWrites: f.native.mock.calls.length })).toBe(404);
        expect(f.native).not.toHaveBeenCalled();
        expect(await f.readPersisted(f.document)).toContain('pending');
      } finally { plan.mockRestore(); }
    });
  });

  it('compares the exact inventory rather than its count after a same-count history swap', async () => {
    await guardedPolicyClosureFixture(async f => {
      const { history, guard } = await f.withHistory();
      await f.lockedStore.deleteResource({ path: history });
      await f.putRdf(`${f.room}replacement.ttl`, '<urn:replacement> <urn:value> "same count" .');
      f.native.mockClear();
      const response = await f.post({ version: 1, update: f.sourceUpdate, guard });
      expect(response.status, response.text).toBe(409);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.document)).toContain('pending');
    });
  });

  it.each([ 'descendant', 'ancestor' ] as const)('refuses a real %s container whose metadata lost its container types', async kind => {
    await guardedPolicyClosureFixture(async f => {
      const history = `${f.room}history/`;
      const child = `${history}old-day.ttl`;
      const guard = f.expected();
      if (kind === 'descendant') {
        await f.putContainer(history);
        await f.putRdf(child, '<urn:root:history> <urn:root:value> "retained child" .');
        guard.resources[0].children.push(history);
        // An incomplete client guard must not cause the actual server inventory to
        // treat a slash container as a document and omit its persisted descendants.
        guard.resources.push({ iri: history, container: false, children: [], policyIri: f.authStrategy.getAuxiliaryIdentifier({ path: history }).path });
        guard.policies.push({ iri: f.authStrategy.getAuxiliaryIdentifier({ path: history }).path, kind: 'wac', state: 'absent404', digest: null });
      }
      const target = kind === 'descendant' ? history : f.pod;
      await metadataRequestContext.run({ metadataCache: new Map() }, () => f.locks.withWriteLock({ path: target }, async () => {
        // Actual lower adapter fault/recovery write, preserving metadata existence
        // and containment. This is not a normal HTTP deletion or Redis claim.
        const metadata = new RepresentationMetadata(await f.accessor.getMetadata({ path: target }));
        metadata.removeQuad(metadata.identifier, RDF.terms.type, LDP.terms.Container);
        metadata.removeQuad(metadata.identifier, RDF.terms.type, LDP.terms.BasicContainer);
        await f.accessor.writeMetadata({ path: target }, metadata);
      }));
      await metadataRequestContext.run({ metadataCache: new Map() }, async () => {
        const metadata = await f.accessor.getMetadata({ path: target });
        expect(metadata.has(RDF.terms.type, LDP.terms.Container)).toBe(false);
        expect(metadata.has(RDF.terms.type, LDP.terms.BasicContainer)).toBe(false);
        if (kind === 'descendant') {
          const children = [];
          for await (const row of f.accessor.getChildren({ path: history })) children.push(row.identifier.value);
          expect(children).toContain(child);
          expect(await f.readPersisted(child)).toContain('retained child');
        }
      });
      f.native.mockClear();
      const response = await f.post({ version: 1, update: f.sourceUpdate, guard });
      expect(response.status, JSON.stringify({ response, nativeWrites: f.native.mock.calls.length })).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.document)).toContain('pending');
    });
  });

  it.each([ 'absent-to-empty', 'empty-to-absent' ] as const)('detects policy %s independently of empty graph enumeration', async direction => {
    await guardedPolicyClosureFixture(async f => {
      const { historyPolicy, guard: seed } = await f.withHistory();
      if (direction === 'empty-to-absent') await f.putRdf(historyPolicy, '');
      const guard = { ...seed, policies: seed.policies.map(row => direction === 'empty-to-absent' && row.iri === historyPolicy
        ? { ...row, state: 'present-empty' as const, digest: expectedGroundDigest(historyPolicy, []) } : row) };
      if (direction === 'empty-to-absent') await f.lockedStore.deleteResource({ path: historyPolicy });
      else await f.putRdf(historyPolicy, '');
      f.native.mockClear();
      const response = await f.post({ version: 1, update: f.sourceUpdate, guard });
      expect(response.status, response.text).toBe(409);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('keeps the persisted source pending when a pre-policy guard is reused after a successful policy step', async () => {
    await guardedPolicyClosureFixture(async f => {
      const oldGuard = f.expected();
      expect((await f.post({ version: 1, update: f.policyUpdate, guard: oldGuard })).status).toBe(204);
      expect(await f.readPersisted(f.roomAcl)).toContain(f.owner);
      f.native.mockClear();
      const response = await f.post({ version: 1, update: f.sourceUpdate, guard: oldGuard });
      expect(response.status, response.text).toBe(409);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.document)).toContain('pending');
    });
  });

  it('does not treat a 204 acknowledgement as a matched canonical condition', async () => {
    await guardedPolicyClosureFixture(async f => {
      const response = await f.post({ version: 1, update: f.sourceUpdate.replaceAll('pending', 'never-present'), guard: f.expected() });
      expect(response.status, response.text).toBe(204);
      expect(f.native).toHaveBeenCalledOnce();
      expect(await f.readPersisted(f.document)).toContain('pending');
    });
  });

  it('excludes an actual ordinary CSS descendant writer during guard-to-native commit', async () => {
    await guardedPolicyClosureFixture(async f => {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      f.native.mockImplementationOnce(async (...args) => { entered(); await hold; return await f.executeNative(...args); });
      const a = f.post({ version: 1, update: f.sourceUpdate, guard: f.expected() });
      await Promise.race([ reached, a.then(response => { throw new Error(`Guard did not reach native boundary: ${response.status}`); }) ]);
      const target = `${f.room}concurrent-history.ttl`;
      const write = vi.spyOn(f.accessor, 'writeDocument');
      let writerSettled = false;
      const writer = f.putRdf(target, '<urn:root:writer> <urn:root:value> "after commit" .').then(() => { writerSettled = true; });
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(writerSettled).toBe(false);
        expect(write.mock.calls.some(([identifier]) => identifier.path === target)).toBe(false);
      } finally { release(); }
      const response = await a; await writer;
      expect(response.status, response.text).toBe(204);
      expect(writerSettled).toBe(true);
      expect(await f.readPersisted(f.document)).toContain('committed');
      expect(await f.readPersisted(target)).toContain('after commit');
      write.mockRestore();
    });
  });

  it('refuses a physical in-room policy whose actual mapped WRITE subject is outside the room', async () => {
    await guardedPolicyClosureFixture(async f => {
      expect(f.podAcl.startsWith(f.room)).toBe(true);
      expect(f.lockedStore.getLockIdentifier({ path: f.podAcl }).path).toBe(f.pod);
      const update = `INSERT { GRAPH <${f.podAcl}> { <${f.podAcl}#owner> <http://www.w3.org/2000/01/rdf-schema#label> "must not write under a READ dependency" } } WHERE { GRAPH <${f.document}> { ?s ?p ?o } }`;
      const before = await f.readPersisted(f.podAcl);
      const response = await f.post({ version: 1, update, guard: f.expected() });
      expect(response.status, response.text).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
      expect(await f.readPersisted(f.podAcl)).toBe(before);
    }, { podPolicyInsideRoom: true });
  });

  it('supports an actual external policy mapped to the room WRITE subject without guessing a suffix', async () => {
    await guardedPolicyClosureFixture(async f => {
      expect(f.roomAcl.startsWith(f.room)).toBe(false);
      expect(f.lockedStore.getLockIdentifier({ path: f.roomAcl }).path).toBe(f.room);
      const response = await f.post({ version: 1, update: f.policyUpdate, guard: f.expected() });
      expect(response.status, response.text).toBe(204);
      expect(f.native).toHaveBeenCalledOnce();
      expect(await f.readPersisted(f.roomAcl)).toContain(f.owner);
      const nativeScope = f.native.mock.calls[0][2];
      expect(new Set(nativeScope?.allowedGraphUrls)).toEqual(new Set([ f.document, f.roomAcl ]));
      expect(f.queryEngine.listGraphs).not.toHaveBeenCalled();
    }, { roomPolicyOutsideRoom: true });
  });

  it('bounds the full persisted policy including cumulative Literal datatypes and closes before returning', async () => {
    await guardedPolicyClosureFixture(async f => {
      const start = Date.now();
      const { history, historyPolicy, guard: seed } = await f.withHistory();
      const datatype = `https://datatype.invalid/${'a'.repeat(64 * 1024)}`;
      const acl = 'http://www.w3.org/ns/auth/acl#';
      // Source authorization uses its small Pod policy. The independently persisted
      // history policy is read by the complete closure, without a giant single token
      // or an earlier ordinary WAC read timeout hiding the byte-accounting boundary.
      const policy = `<${historyPolicy}#owner> a <${acl}Authorization>; <${acl}accessTo> <${history}>; <${acl}agent> <${f.owner}>; <${acl}mode> <${acl}Read>, <${acl}Write>, <${acl}Control> .\n`
        + Array.from({ length: 130 }, (_, index) => `<${historyPolicy}#owner> <http://www.w3.org/2000/01/rdf-schema#label> "x-${index}"^^<${datatype}> .`).join('\n');
      await f.putRdf(historyPolicy, policy);
      const seeded = Date.now();
      f.native.mockClear();
      const guard = { ...seed, policies: seed.policies.map(row => row.iri === historyPolicy
        ? { ...row, state: 'present' as const, digest: expectedGroundDigest(historyPolicy, new Parser({ baseIRI: historyPolicy }).parse(policy)) } : row) };
      const read = vi.spyOn(GuardedPolicyClosure.prototype, 'read');
      const requested = Date.now();
      try {
        const response = await f.post({ version: 1, update: f.sourceUpdate, guard });
        expect(response.status, JSON.stringify({ response, errors: f.handlerErrors, nativeWrites: f.native.mock.calls.length,
          closureReads: read.mock.calls.length, seedMs: seeded - start, requestMs: Date.now() - requested })).toBe(415);
        expect(read).toHaveBeenCalled();
        expect(f.native).not.toHaveBeenCalled();
        expect(await f.readPersisted(f.document)).toContain('pending');
      } finally { read.mockRestore(); }
    });
  });
});
