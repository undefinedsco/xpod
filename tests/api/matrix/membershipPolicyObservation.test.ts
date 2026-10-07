import { describe, expect, it, vi } from 'vitest';
import { DataFactory, Writer } from 'n3';
import { MembershipPolicyObserver, isMembershipAcpObservation,
  type MembershipPolicyObservation, type MembershipRoomObservation } from '../../../src/api/matrix/membershipPolicyObservation';
import { openMembershipObservationAccess } from '../../../src/api/matrix/membershipSourceAccess';
import { membershipPolicyFixture, fixtureNegotiationMedia } from '../../helpers/MembershipPolicyFixture';

const asWac = (observation: MembershipRoomObservation): MembershipPolicyObservation => {
  if (isMembershipAcpObservation(observation)) throw new Error('Unexpected ACP observation in a WAC fixture');
  return observation;
};

describe('readonly policy observations (shared loopback HTTP/ORM/vault fixture, not DPoP/effective ACL)', () => {
  it('covers every listed history date without message bodies, writes or generalized owner capability', async() => {
    await membershipPolicyFixture(async f => {
      f.denyCallerRead(f.actor);
      const observer = new MembershipPolicyObserver(f.observationOptions);
      const result = asWac(await observer.observe(f.roomId, f.actorContext, 'join'));
      expect(result.issues).toEqual([]);
      expect(result.coverage).toBe('complete'); expect(result.effectiveRead).toBe('not-proved');
      expect(result.resources.map(resource => resource.iri)).toEqual(expect.arrayContaining(f.historyDocuments));
      for (const document of f.historyDocuments) expect(f.requests.some(request => request.url === document && request.method === 'GET')).toBe(false);
      expect(f.requests.some(request => request.method === 'POST' && request.media !== fixtureNegotiationMedia)).toBe(false);
      expect(Object.isFrozen(result.policies[0].quads)).toBe(true);
      const access = await openMembershipObservationAccess(f.observationOptions, f.roomId, f.actorContext, 'join');
      expect(Object.keys(access)).not.toEqual(expect.arrayContaining(['fetch', 'db', 'executeCas']));
      await expect(access.readResource(f.historyDocuments[0], 'GET', new AbortController().signal)).rejects.toMatchObject({ status: 403 });
      const before = f.requests.length;
      expect(() => access.allowPolicy(f.documentIri, `${f.issuer}outside/policy`)).toThrow();
      expect(f.requests).toHaveLength(before);
    });
  });
  it('distinguishes empty direct policy from absence and stops WAC inheritance', async() => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status: 200, body: '' });
      const result = asWac(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'));
      expect(result.policies.find(policy => policy.iri === f.roomPolicy)?.state).toBe('present-empty');
      expect(result.resources.find(resource => resource.iri === f.room)?.wacInheritance).toBe('direct');
      expect(f.requests.some(request => request.url === f.podUrl && request.method === 'HEAD')).toBe(false);
      expect(result.effectiveRead).toBe('not-proved');
    });
  });
  it.each([403, 206])('does not treat HTTP %s as absent', async status => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status, body: '' });
      const result = asWac(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'));
      expect(result.coverage).toBe('incomplete');
      expect(result.policies.find(policy => policy.iri === f.roomPolicy)?.state).toBe('unknown');
      expect(result.issues.some(issue => issue.code === `http-${status}`)).toBe(true);
    });
  });
  it('budget exhaustion cannot return truncated complete coverage', async() => {
    await membershipPolicyFixture(async f => {
      const result = asWac(await new MembershipPolicyObserver({ ...f.observationOptions, limits: { requests: 3 } })
        .observe(f.roomId, f.actorContext, 'join'));
      expect(result.coverage).toBe('incomplete'); expect(result.counts.requests).toBe(3);
      expect(result.resources.map(resource => resource.iri)).not.toEqual(expect.arrayContaining(f.historyDocuments));
      expect(f.requests.some(request => request.method === 'POST' && request.media !== fixtureNegotiationMedia)).toBe(false);
    });
  });
  it('counts document descendants in the depth bound', async() => {
    await membershipPolicyFixture(async f => {
      const result = asWac(await new MembershipPolicyObserver({ ...f.observationOptions, limits: { depth: 1 } })
        .observe(f.roomId, f.actorContext, 'join'));
      expect(result.coverage).toBe('incomplete');
      expect(result.issues.some(issue => issue.code === 'containment-depth-budget')).toBe(true);
      expect(f.requests.some(request => f.historyDocuments.includes(request.url))).toBe(false);
    });
  });
  it.each(['headers', 'body'] as const)('actually aborts a stalled %s response and stops further observation requests', async stall => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status: 200, stall });
      const result = asWac(await new MembershipPolicyObserver({ ...f.observationOptions, limits: { requestTimeoutMs: 80, totalTimeoutMs: 1000 } })
        .observe(f.roomId, f.actorContext, 'join'));
      expect(result.coverage).toBe('incomplete');
      expect(result.issues.some(issue => issue.code === 'request-deadline')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(f.closedStalls).toContain(f.roomPolicy);
      const observedRequests = f.requests.filter(request => request.url !== f.documentIri);
      expect(observedRequests.at(-1)?.url).toBe(f.roomPolicy);
      expect(f.requests.some(request => request.method === 'POST' && request.media !== fixtureNegotiationMedia)).toBe(false);
    });
  });
  it('rejects malformed named resolution without caller bootstrap', async() => {
    await membershipPolicyFixture(async f => {
      const bootstrap = vi.spyOn(f.resolver, 'readAsCaller');
      vi.spyOn(f.resolver, 'resolveForMembership').mockResolvedValue(undefined as never);
      await expect(new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join')).rejects.toMatchObject({ status: 403 });
      expect(bootstrap).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
    });
  });
  it('retains conflicting scheme constraints on a cached policy without an extra GET', async() => {
    await membershipPolicyFixture(async f => {
      const history = f.historyDocuments[0];
      f.set('HEAD', history, { status: 200, links: `<${f.roomPolicy}>; rel="acl", <http://www.w3.org/ns/solid/acp#AccessControlResource>; rel="type"` });
      const result = asWac(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'));
      expect(result.coverage).toBe('incomplete');
      expect(result.issues.some(issue => issue.code === 'ambiguous-policy-kind')).toBe(true);
      expect(result.policies.find(policy => policy.iri === f.roomPolicy)?.kind).toBe('unknown');
      expect(f.requests.filter(request => request.url === f.roomPolicy && request.method === 'GET')).toHaveLength(1);
    });
  });
  it.each([1, 2, 3])('binds total abort to canonical request stage %s, including setup and bookend', async stage => {
    await membershipPolicyFixture(async f => {
      const writer = new Writer(); writer.addQuads(f.graph.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
      const body = await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
      let reads = 0;
      const reply: { status: number; body: string; stall?: 'body'; before: () => void } = {
        status: 200, body, before: () => { if (++reads === stage) reply.stall = 'body'; },
      };
      f.set('GET', f.documentIri, reply);
      const observe = new MembershipPolicyObserver({ ...f.observationOptions, limits: { totalTimeoutMs: 500, requestTimeoutMs: 2000 } })
        .observe(f.roomId, f.actorContext, 'join');
      if (stage < 3) await expect(observe).rejects.toMatchObject({ status: 503 });
      else expect((await observe).coverage).toBe('incomplete');
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(reads).toBe(stage); expect(f.closedStalls).toContain(f.documentIri);
      expect(f.requests.some(request => request.method === 'POST' && request.media !== fixtureNegotiationMedia)).toBe(false);
    });
  });
  it('records ACP ancestor boundary as incomplete rather than effective authorization', async() => {
    await membershipPolicyFixture(async f => {
      await f.acp();
      const result = asWac(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'));
      expect(result.coverage).toBe('incomplete'); expect(result.effectiveRead).toBe('not-proved');
      expect(result.policies.find(policy => policy.iri === f.roomPolicy)?.kind).toBe('acp');
      expect(result.issues.some(issue => issue.code === 'unsupported-ancestry-beyond-pod-root')).toBe(true);
    });
  });
});
