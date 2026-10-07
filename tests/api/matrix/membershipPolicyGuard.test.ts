import { describe, expect, it, vi } from 'vitest';
import { MembershipPolicyObserver, isMembershipAcpObservation,
  type MembershipPolicyObservation, type MembershipRoomObservation } from '../../../src/api/matrix/membershipPolicyObservation';
import { compileMembershipPolicyGuard, executeMembershipGuardedCas } from '../../../src/api/matrix/membershipPolicyGuard';
import { membershipPolicyFixture, fixtureNegotiationMedia } from '../../helpers/MembershipPolicyFixture';

const asWac = (observation: MembershipRoomObservation): MembershipPolicyObservation => {
  if (isMembershipAcpObservation(observation)) throw new Error('Unexpected ACP observation in a WAC fixture');
  return observation;
};

/** Counted loopback HTTP/public ORM RDF CAS, not actual server closure validation or DPoP. */
describe('sealed membership policy guard compiler and narrow transport', () => {
  it('saves actual direct children, compiles only required WAC ancestors and rejects cloned evidence', async() => {
    await membershipPolicyFixture(async f => {
      const result = asWac(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'));
      const root = result.resources.find(row => row.iri === result.scope.roomContainer)!;
      expect(root.children.length).toBe(9);
      for (const document of f.historyDocuments) expect(result.resources.find(row => row.iri === document)?.children).toEqual([]);
      expect(Object.isFrozen(root.children)).toBe(true);
      const guard = compileMembershipPolicyGuard(result);
      expect(guard.scope).toBe(result.scope.roomContainer);
      expect(() => compileMembershipPolicyGuard({ ...result })).toThrow();
      await expect(executeMembershipGuardedCas({ ...guard }, { protocols: {} })).rejects.toMatchObject({ status: 409 });
      expect(f.requests.some(request => request.method === 'POST' && request.media !== fixtureNegotiationMedia)).toBe(false);
    });
  });
  it.each([409, 415])('keeps explicit HTTP %s terminal without plain fallback or winner adoption', async status => {
    await membershipPolicyFixture(async f => {
      const result = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(result);
      let posts = 0;
      f.additionalRequest((request, response, url) => {
        if (request.method !== 'POST') return false;
        expect(url).toBe(f.endpoint); posts++; response.writeHead(status); response.end(); return true;
      });
      await expect(executeMembershipGuardedCas(guard, { protocols: { ...((await f.source.readSnapshot(f.roomId, f.ownerContext)).protocols), probe: true } }))
        .rejects.toMatchObject({ status });
      expect(posts).toBe(1);
    });
  });
  it('a 204 without an exact mutation is not success', async() => {
    await membershipPolicyFixture(async f => {
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(observation);
      f.additionalRequest((request, response) => {
        if (request.method !== 'POST') return false;
        response.writeHead(204); response.end(); return true;
      });
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      await expect(executeMembershipGuardedCas(guard, { protocols: { ...initial.protocols, probe: true } })).rejects.toMatchObject({ status: 409 });
    });
  });
  it('uses the same sealed named transport after observation abort and confirms actual public ORM CAS readback', async() => {
    await membershipPolicyFixture(async f => {
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(observation);
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      let posts = 0;
      f.additionalRequest(async(request, response, url) => {
        if (request.method !== 'POST') return false;
        expect(url).toBe(f.endpoint);
        expect(request.headers['content-type']).toBe('application/vnd.xpod.guarded-sparql-update+json');
        let body = ''; for await (const chunk of request) body += chunk;
        const envelope = JSON.parse(body);
        expect(envelope.version).toBe(1); expect(envelope.guard.ancestors).toEqual([]);
        expect(envelope.guard.resources).toHaveLength(18);
        await f.engine.queryVoid(envelope.update, { sources: [f.graph], destination: f.graph });
        posts++; response.writeHead(204); response.end(); return true;
      });
      const result = await executeMembershipGuardedCas(guard, { protocols: { ...initial.protocols, probe: true } });
      expect(result.protocols.probe).toBe(true); expect(posts).toBe(1);
      expect(f.requests.filter(request => request.method === 'POST').every(request => request.principal === f.owner)).toBe(true);
    });
  });
  it('revoked current lease fails before any source POST', async() => {
    await membershipPolicyFixture(async f => {
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(observation);
      await f.credentials.revoke(f.binding.credentialRef);
      await expect(executeMembershipGuardedCas(guard, { protocols: {} })).rejects.toMatchObject({ status: 403 });
      expect(f.requests.some(request => request.method === 'POST' && request.media !== fixtureNegotiationMedia)).toBe(false);
    });
  });
  it('checks the request deadline again after an awaited lease and makes no source request', async() => {
    await membershipPolicyFixture(async f => {
      // Read the change source BEFORE observation so the exact original 500ms total deadline (and its
      // now-enforced remaining TTL) is exercised on the guarded consumption, with no test-side gap.
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      const observation = await new MembershipPolicyObserver({ ...f.observationOptions, limits: { totalTimeoutMs: 500 } })
        .observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(observation);
      const lease = f.credentials.lease.bind(f.credentials);
      vi.spyOn(f.credentials, 'lease').mockImplementationOnce(async input => {
        await new Promise(resolve => setTimeout(resolve, 600)); return await lease(input);
      });
      const before = f.requests.length;
      await expect(executeMembershipGuardedCas(guard, { protocols: initial.protocols })).rejects.toMatchObject({ status: 503 });
      expect(f.requests.length).toBe(before);
    });
  });
  it('isolates concurrent request signals while an earlier request expires waiting for its lease', async() => {
    await membershipPolicyFixture(async f => {
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      const observation = await new MembershipPolicyObserver({ ...f.observationOptions, limits: { totalTimeoutMs: 500 } })
        .observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(observation);
      const lease = f.credentials.lease.bind(f.credentials);
      vi.spyOn(f.credentials, 'lease').mockImplementationOnce(async input => {
        await new Promise(resolve => setTimeout(resolve, 600)); return await lease(input);
      });
      f.additionalRequest(async(request, response) => {
        if (request.method !== 'POST') return false;
        let body = ''; for await (const chunk of request) body += chunk;
        await f.engine.queryVoid(JSON.parse(body).update, { sources: [f.graph], destination: f.graph });
        response.writeHead(204); response.end(); return true;
      });
      const first = executeMembershipGuardedCas(guard, { protocols: initial.protocols }).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 100));
      const second = await executeMembershipGuardedCas(guard, { protocols: initial.protocols });
      expect(second.protocols).toEqual(initial.protocols);
      expect(await first).toMatchObject({ status: 503 });
      expect(f.requests.filter(request => request.method === 'POST' && request.media !== fixtureNegotiationMedia)).toHaveLength(1);
    });
  });

  it('bounds a never-settled readonly lease await and does not request after its late release', async() => {
    await membershipPolicyFixture(async f => {
      const initial = await f.source.readSnapshot(f.roomId, f.ownerContext);
      const lease = f.credentials.lease.bind(f.credentials);
      const current = await lease({ credentialRef: f.binding.credentialRef, ownerWebId: f.owner, version: 1, recordUsage: false });
      const observation = await new MembershipPolicyObserver({ ...f.observationOptions, limits: { totalTimeoutMs: 500 } })
        .observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(observation);
      let release!: (value: typeof current) => void;
      vi.spyOn(f.credentials, 'lease').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const before = f.requests.length;
      const start = Date.now();
      try {
        await expect(executeMembershipGuardedCas(guard, { protocols: initial.protocols })).rejects.toMatchObject({ status: 503 });
        expect(Date.now() - start).toBeLessThan(700);
        expect(f.requests.length).toBe(before);
      } finally { release(current); }
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(f.requests.length).toBe(before);
    });
  });

});
