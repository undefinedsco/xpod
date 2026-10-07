// Root HTTP/public ORM/SQLite/vault acceptance. Counted identities and policy
// replies are not actual CSS WAC, DPoP, production QLever or user Gateway proof.
import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { createHash } from 'node:crypto';
import { chatResource } from '@undefineds.co/models';
import * as observationModule from '../../../src/api/matrix/membershipPolicyObservation';
import { compileMembershipPolicyGuard, executeMembershipGuardedCas } from '../../../src/api/matrix/membershipPolicyGuard';
import type { GuardedPolicyUpdate } from '../../../src/storage/rdf/GuardedPolicySnapshot';
import * as snapshotModule from '../../../src/storage/rdf/GuardedPolicySnapshot';
import { membershipPolicyFixture, requireFixtureWacObservation } from '../../helpers/MembershipPolicyFixture';

type Fixture = Parameters<Parameters<typeof membershipPolicyFixture>[0]>[0];
const observe = async (f: Fixture) => requireFixtureWacObservation(await new observationModule.MembershipPolicyObserver(f.observationOptions)
  .observe(f.roomId, f.actorContext, 'join'));
const posts = (f: Fixture) => f.requests.filter(r => r.method === 'POST'
  && r.media !== 'application/vnd.xpod.authorization-profile-negotiation+json');
const acknowledge = (f: Fixture, after?: () => void, capture?: (envelope: GuardedPolicyUpdate) => void) => f.onGuardedPost(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const envelope = JSON.parse(Buffer.concat(chunks).toString()) as GuardedPolicyUpdate;
  expect(request.headers['content-type']).toBe('application/vnd.xpod.guarded-sparql-update+json');
  expect(envelope.version).toBe(1);
  capture?.(envelope);
  await f.engine.queryVoid(envelope.update, { sources: [ f.graph ], destination: f.graph });
  after?.(); response.writeHead(204); response.end();
});

describe('root sealed membership guard and exact source confirmation', () => {
  it('sends complete eight-day topology and whole policy digest through the original named transport', async () => {
    await membershipPolicyFixture(async f => {
      const observed = await observe(f);
      expect(observed.coverage).toBe('complete');
      const guard = compileMembershipPolicyGuard(observed);
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      const next = { ...initial.protocols, foreign: { value: 'retain', rootGuarded: true } };
      let sent: GuardedPolicyUpdate | undefined;
      acknowledge(f, undefined, value => { sent = value; });
      const result = await executeMembershipGuardedCas(guard, { protocols: next });
      expect(result.protocols).toEqual(next);
      expect(posts(f)).toHaveLength(1); expect(posts(f)[0]).toMatchObject({ url: f.endpoint, principal: f.owner });
      expect(sent!.guard.scope).toBe(f.room); expect(sent!.guard.ancestors).toEqual([]);
      const root = sent!.guard.resources.find(row => row.iri === f.room)!;
      expect(root.children).toEqual([ f.documentIri, ...f.historyDocuments.map(iri => new URL('./', iri).href) ].sort());
      for (const history of f.historyDocuments) {
        expect(sent!.guard.resources.find(row => row.iri === history)).toMatchObject({ container: false, children: [] });
        expect(f.requests.some(r => r.url === history && r.method === 'GET')).toBe(false);
      }
      const policy = observed.policies.find(row => row.iri === f.roomPolicy)!;
      const term = (t: typeof policy.quads[number]['object']): string[] => t.termType === 'Literal'
        ? [ 'Literal', t.value, t.datatype.value, t.language.toLowerCase() ] : [ 'NamedNode', t.value ];
      const tuples = [...new Set(policy.quads.map(q => JSON.stringify([term(q.subject), term(q.predicate), term(q.object)])))]
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(value => JSON.parse(value) as string[][]);
      const expected = createHash('sha256').update(JSON.stringify(['ground-RDF-v1', f.roomPolicy, 'wac', tuples])).digest('hex');
      expect(sent!.guard.policies.find(row => row.iri === f.roomPolicy)).toMatchObject({ state: 'present', digest: expected });
      expect(sent!.guard.policies.some(row => row.state === 'absent404' && row.digest === null)).toBe(true);
      expect(result.facts.participants).toEqual(initial.facts.participants);
      expect(result.facts.membershipOperation).toEqual(initial.facts.membershipOperation);
    });
  });

  it('does not expose an observation-owned authority reader through a public context getter', async () => {
    await membershipPolicyFixture(async f => {
      const observed = await observe(f);
      const getter = Reflect.get(observationModule, 'membershipObservationContext');
      if (typeof getter !== 'function') { expect(getter).toBeUndefined(); return; }
      const context = getter(observed);
      // A readonly/frozen container still leaks callable privileged capabilities.
      const secret = `${f.podUrl}private/owner-only.ttl`;
      f.set('GET', secret, { status: 200, body: '<urn:root:private> <urn:root:value> "owner-private" .' });
      const before = f.requests.length;
      context.access.allowPolicy(f.room, secret);
      await expect(context.access.readResource(secret, 'GET', new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      expect(f.requests.slice(before).some(r => r.url === secret)).toBe(false);
    });
  });

  it('retains metadata triples that share the changed participants predicate', async () => {
    await membershipPolicyFixture(async f => {
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      const predicate = chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace);
      const retained = DataFactory.quad(DataFactory.namedNode(initial.metadataIri), DataFactory.namedNode(predicate),
        DataFactory.namedNode(f.target));
      f.graph.addQuad(retained);
      const guard = compileMembershipPolicyGuard(await observe(f));
      acknowledge(f, () => { f.graph.removeQuad(retained); });
      await expect(executeMembershipGuardedCas(guard, { participants: [ f.owner, f.actor ] }))
        .rejects.toMatchObject({ status: 409 });
      expect(posts(f)).toHaveLength(1);
    });
  });

  it('rejects cloned observations and forged guards before a source write', async () => {
    await membershipPolicyFixture(async f => {
      const observed = await observe(f);
      expect(() => compileMembershipPolicyGuard({ ...observed })).toThrow();
      const valid = compileMembershipPolicyGuard(observed);
      await expect(executeMembershipGuardedCas({ ...valid }, { participants: [ f.owner, f.actor ] }))
        .rejects.toMatchObject({ status: 409 });
      expect(posts(f)).toHaveLength(0);
    });
  });

  it.each([ 409, 415 ])('treats HTTP%s as terminal without a plain retry or winner adoption', async status => {
    await membershipPolicyFixture(async f => {
      const evidence = compileMembershipPolicyGuard(await observe(f));
      f.onGuardedPost(async (_request, response) => { response.writeHead(status); response.end(); });
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      await expect(executeMembershipGuardedCas(evidence, { protocols: { ...initial.protocols, rootGuarded: true } }))
        .rejects.toMatchObject({ status });
      expect(posts(f)).toHaveLength(1);
      expect((await f.source.readSnapshot(f.roomId, f.ownerContext)).protocols).toEqual(initial.protocols);
    });
  });

  it('does not treat an HTTP204 without a matching write as successful source confirmation', async () => {
    await membershipPolicyFixture(async f => {
      const evidence = compileMembershipPolicyGuard(await observe(f));
      f.onGuardedPost(async (_request, response) => { response.writeHead(204); response.end(); });
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      await expect(executeMembershipGuardedCas(evidence, { protocols: { ...initial.protocols, rootGuarded: true } }))
        .rejects.toMatchObject({ status: 409 });
      expect(posts(f)).toHaveLength(1);
      expect((await f.source.readSnapshot(f.roomId, f.ownerContext)).protocols).toEqual(initial.protocols);
    });
  });

  it('rejects raw canonical changes after observation before sending an update', async () => {
    await membershipPolicyFixture(async f => {
      const evidence = compileMembershipPolicyGuard(await observe(f));
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      f.graph.addQuad(DataFactory.namedNode(f.sourceIri), DataFactory.namedNode('urn:root:concurrent-extra'), DataFactory.literal('changed'));
      await expect(executeMembershipGuardedCas(evidence, { protocols: { ...initial.protocols, rootGuarded: true } }))
        .rejects.toMatchObject({ status: 409 });
      expect(posts(f)).toHaveLength(0);
    });
  });

  it('stops expanded policy term accounting as soon as the total byte budget is exhausted', async () => {
    await membershipPolicyFixture(async f => {
      const original = f.replies.get(`GET ${f.roomPolicy}`)!.body!;
      const datatype = `https://types.example/${'x'.repeat(9000)}`;
      const labels = Array.from({ length: 1200 }, (_, i) =>
        `<${f.roomPolicy}#owner> <http://www.w3.org/2000/01/rdf-schema#label> "label-${i}"^^large:t .`).join('\n');
      const body = `@prefix large: <${datatype}> .\n${original}\n${labels}`;
      expect(Buffer.byteLength(body)).toBeLessThan(8 * 1024 * 1024);
      f.set('GET', f.roomPolicy, { status: 200, body });
      const observed = await observe(f);
      expect(observed.coverage).toBe('complete');
      const policy = observed.policies.find(p => p.iri === f.roomPolicy)!;
      const count = vi.spyOn(snapshotModule, 'groundPolicyQuadBytes');
      try {
        expect(() => compileMembershipPolicyGuard(observed)).toThrow();
        expect(count.mock.calls.length).toBeGreaterThan(0);
        expect(count.mock.calls.length).toBeLessThan(policy.quads.length);
        expect(posts(f)).toHaveLength(0);
      } finally { count.mockRestore(); }
    });
  });

  it('bounds a never-settling readonly lease and sends nothing when its late value eventually arrives', async () => {
    await membershipPolicyFixture(async f => {
      const observed = await new observationModule.MembershipPolicyObserver({ ...f.observationOptions,
        limits: { totalTimeoutMs: 1500 } }).observe(f.roomId, f.actorContext, 'join');
      const evidence = compileMembershipPolicyGuard(observed);
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      const currentLease = await f.credentials.lease({ credentialRef: f.binding.credentialRef,
        ownerWebId: f.owner, version: f.binding.version, recordUsage: false });
      let release: ((value: typeof currentLease) => void) | undefined;
      const lease = vi.spyOn(f.credentials, 'lease').mockImplementation(async () => await new Promise<typeof currentLease>(resolve => { release = resolve; }));
      const requestCount = f.requests.length;
      const start = performance.now();
      try {
        await expect(executeMembershipGuardedCas(evidence, { protocols: { ...initial.protocols, rootGuarded: true } }))
          .rejects.toMatchObject({ status: 503 });
        expect(performance.now() - start).toBeGreaterThanOrEqual(1000);
        expect(performance.now() - start).toBeLessThan(2500);
        expect(f.requests).toHaveLength(requestCount);
        expect(lease).toHaveBeenCalled();
      } finally {
        release?.(currentLease); lease.mockRestore();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(f.requests).toHaveLength(requestCount); expect(posts(f)).toHaveLength(0);
    });
  });

  it('reports a lost successful POST response as unknown rather than adopting the source winner', async () => {
    await membershipPolicyFixture(async f => {
      const evidence = compileMembershipPolicyGuard(await observe(f));
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      const next = { ...initial.protocols, rootGuarded: 'response-lost' };
      f.onGuardedPost(async (request, _response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString()) as GuardedPolicyUpdate;
        await f.engine.queryVoid(envelope.update, { sources: [ f.graph ], destination: f.graph });
        request.socket.destroy();
      });
      await expect(executeMembershipGuardedCas(evidence, { protocols: next })).rejects.toMatchObject({ status: 503 });
      expect(posts(f)).toHaveLength(1);
      expect((await f.source.readSnapshot(f.roomId, f.ownerContext)).protocols).toEqual(next);
    });
  });
});
