import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { MembershipPolicyObserver } from '../../../src/api/matrix/membershipPolicyObservation';
import { membershipPolicyFixture, fixtureNegotiationMedia, requireFixtureWacObservation } from '../../helpers/MembershipPolicyFixture';

type Fixture = Parameters<Parameters<typeof membershipPolicyFixture>[0]>[0];
const observer = (f: Fixture, limits?: ConstructorParameters<typeof MembershipPolicyObserver>[0]['limits']) =>
  new MembershipPolicyObserver({ ...f.observationOptions, limits });
const run = async(f: Fixture, limits?: ConstructorParameters<typeof MembershipPolicyObserver>[0]['limits']) =>
  requireFixtureWacObservation(await observer(f, limits).observe(f.roomId, f.actorContext, 'join'));

/** Real loopback HTTP/RDF/SQLite/vault. Counted headers are not real DPoP and policy
 * observations below neither grant/revoke Read nor prove commit-time topology. */
describe('root independent membership policy HTTP observations', () => {
  it('follows actual non-suffix Link and observes all eight history buckets without message bodies', async() => {
    await membershipPolicyFixture(async f => {
      f.denyCallerRead(f.actor);
      const before = f.graph.getQuads(null, null, null, null);
      const result = await run(f);
      expect(result.coverage).toBe('complete'); expect(result.effectiveRead).toBe('not-proved');
      expect(result.scope).toMatchObject({ actorWebId: f.actor, sourceIri: f.sourceIri, roomContainer: f.room, kind: 'join' });
      for (const url of f.historyDocuments) {
        expect(f.requests.some(r => r.url === url && r.method === 'HEAD')).toBe(true);
        expect(f.requests.some(r => r.url === url && r.method === 'GET')).toBe(false);
      }
      expect(f.requests.some(r => r.url === f.roomPolicy && r.method === 'GET')).toBe(true);
      expect(f.requests.every(r => r.principal === f.owner && !r.url.endsWith('.acl'))).toBe(true);
      expect(f.requests.every(r => r.method === 'HEAD' || r.method === 'GET'
        || (r.method === 'POST' && r.media === fixtureNegotiationMedia))).toBe(true);
      expect(f.graph.getQuads(null, null, null, null)).toEqual(before);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.policies.find(p => p.iri === f.roomPolicy)).toMatchObject({ kind: 'wac', state: 'present' });
    });
  });

  it('resolves a relative actual acl Link instead of constructing a suffix', async() => {
    await membershipPolicyFixture(async f => {
      f.set('HEAD', f.room, { status: 200, links: `<${new URL(f.roomPolicy).pathname}>; rel="acl"` });
      const result = await run(f);
      expect(result.coverage).toBe('complete');
      expect(result.policies.some(p => p.iri === f.roomPolicy)).toBe(true);
      expect(f.requests.every(r => !r.url.endsWith('.acl'))).toBe(true);
    });
  });

  it('distinguishes a present-empty direct ACL from absent404 and stops WAC inheritance there', async() => {
    await membershipPolicyFixture(async f => {
      const direct = f.policyFor(f.historyDocuments[0]);
      f.set('GET', direct, { status: 200, body: '' });
      const result = await run(f);
      expect(result.policies.find(p => p.iri === direct)?.state).toBe('present-empty');
      expect(result.policies.find(p => p.iri === f.policyFor(f.historyDocuments[1]))?.state).toBe('absent404');
      expect(result.resources.find(r => r.iri === f.historyDocuments[0])?.wacInheritance).toBe('direct');
      expect(result.effectiveRead).toBe('not-proved');
    });
  });

  it.each([403, 206, 500])('keeps policy HTTP%s unknown instead of absent', async status => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status, body: '' });
      const result = await run(f);
      expect(result.coverage).toBe('incomplete'); expect(result.effectiveRead).toBe('not-proved');
      expect(result.policies.find(p => p.iri === f.roomPolicy)?.state).toBe('unknown');
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  it('does not accept malformed RDF as an empty present ACL', async() => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status: 200, body: 'this is not Turtle <' });
      const result = await run(f);
      expect(result.coverage).toBe('incomplete');
      expect(result.policies.find(p => p.iri === f.roomPolicy)?.state).toBe('unknown');
    });
  });

  it('does not choose arbitrarily between conflicting acl links', async() => {
    await membershipPolicyFixture(async f => {
      const other = `${f.podUrl}policies/second`;
      f.set('HEAD', f.room, { status: 200, links: `<${f.roomPolicy}>; rel="acl", <${other}>; rel="acl"` });
      const result = await run(f);
      expect(result.coverage).toBe('incomplete');
      expect(f.requests.some(r => r.method === 'GET' && (r.url === other || r.url === f.roomPolicy))).toBe(false);
    });
  });

  it('reports a valid other-Pod ACL link outside support without following it', async() => {
    await membershipPolicyFixture(async f => {
      const other = `${f.issuer}other-pod/policy`;
      f.set('HEAD', f.room, { status: 200, links: `<${other}>; rel="acl"` });
      const result = await run(f);
      expect(result.coverage).toBe('incomplete');
      expect(f.requests.some(r => r.url === other)).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  it('rejects a redirect without following it with owner transport', async() => {
    await membershipPolicyFixture(async f => {
      const other = `${f.podUrl}private/redirected`;
      f.set('GET', f.roomPolicy, { status: 302, headers: { Location: other } });
      const result = await run(f);
      expect(result.coverage).toBe('incomplete');
      expect(f.requests.some(r => r.url === other)).toBe(false);
    });
  });

  it.each(['resources', 'requests', 'bytes', 'depth'] as const)('reports incomplete when %s budget is exhausted', async budget => {
    await membershipPolicyFixture(async f => {
      if (budget === 'bytes') {
        // A one-byte budget cannot even send the mandatory qualification request.
        // It must fail before traversal or any evidence/source/policy mutation.
        await expect(run(f, { bytes: 1 })).rejects.toMatchObject({ status: 503 });
        expect(f.requests.some(request => request.method === 'POST')).toBe(false);
        return;
      }
      const result = await run(f, { [budget]: 1 });
      expect(result.coverage).toBe('incomplete'); expect(result.effectiveRead).toBe('not-proved');
      expect(result.issues.length).toBeGreaterThan(0);
      expect(f.requests.every(r => r.method !== 'POST' || r.media === fixtureNegotiationMedia)).toBe(true);
    });
  });

  it('does not traverse unrelated containment or turn a cycle into complete coverage', async() => {
    await membershipPolicyFixture(async f => {
      const unrelated = `${f.podUrl}private/unrelated`;
      await f.container(f.room, [f.room, unrelated]); f.discover(f.room, f.roomPolicy);
      const result = await run(f);
      expect(result.coverage).toBe('incomplete');
      expect(f.requests.some(r => r.url === unrelated)).toBe(false);
    });
  });

  it('keeps ACP ancestor coverage explicit and never reports effective Read as proved', async() => {
    await membershipPolicyFixture(async f => {
      await f.acp();
      const result = await run(f);
      expect(result.policies.find(p => p.iri === f.roomPolicy)?.kind).toBe('acp');
      expect(result.effectiveRead).toBe('not-proved');
      // Same-Pod reader cannot infer absence of member policies above registered root.
      expect(result.coverage).toBe('incomplete'); expect(result.issues.length).toBeGreaterThan(0);
      expect(f.requests.some(r => r.url === f.podUrl && r.method === 'HEAD')).toBe(true);
    });
  });

  it('does not discard conflicting discovery constraints when a policy was already cached', async() => {
    await membershipPolicyFixture(async f => {
      f.set('HEAD', f.historyDocuments[0], { status: 200,
        links: `<${f.roomPolicy}>; rel="acl", <http://www.w3.org/ns/solid/acp#AccessControlResource>; rel="type"` });
      const result = await run(f);
      expect(result.coverage).toBe('incomplete');
      expect(result.issues.some(i => i.code === 'ambiguous-policy-kind')).toBe(true);
      expect(f.requests.filter(r => r.method === 'GET' && r.url === f.roomPolicy)).toHaveLength(1);
    });
  });

  for (const canonicalRead of [1, 2, 3]) {
    it.each(['headers', 'body'] as const)(`bounds canonical read ${canonicalRead} stalled %s by the total deadline`, async stall => {
      await membershipPolicyFixture(async f => {
        // Keep traversal short so read 3 proves the bookend, rather than an earlier expiry.
        await f.container(f.room, [f.documentIri]); f.discover(f.room, f.roomPolicy);
        f.set('GET', f.documentIri, { status: 200, stall, releaseAfterMs: 1200,
          when: () => f.requests.filter(r => r.method === 'GET' && r.url === f.documentIri).length === canonicalRead });
        const start = performance.now();
        await run(f, { requestTimeoutMs: 1000, totalTimeoutMs: 150 }).catch(() => undefined);
        expect(performance.now() - start).toBeLessThan(700);
        expect(f.requests.filter(r => r.method === 'GET' && r.url === f.documentIri)).toHaveLength(canonicalRead);
        for (let i = 0; i < 20 && !f.closedStalls.includes(f.documentIri); i++)
          await new Promise(resolve => setTimeout(resolve, 10));
        expect(f.closedStalls).toContain(f.documentIri);
        expect(f.requests.every(r => r.method !== 'POST' || r.media === fixtureNegotiationMedia)).toBe(true);
        if (canonicalRead < 3) expect(f.requests.every(r => r.method === 'GET' && r.url === f.documentIri)).toBe(true);
      });
    });
  }

  it('refuses altered canonical admission at the bookend without source writes', async() => {
    await membershipPolicyFixture(async f => {
      const policy = f.replies.get(`GET ${f.roomPolicy}`)!;
      policy.before = () => {
        const old = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
        if (old.object.termType !== 'Literal') throw new Error('Fixture protocols not literal');
        const value = JSON.parse(old.object.value);
        value.matrix.membershipInvitations[f.actor].createdAt = 99;
        f.graph.removeQuad(old);
        f.graph.addQuad(DataFactory.quad(old.subject, old.predicate,
          DataFactory.literal(JSON.stringify(value), old.object.datatype), old.graph));
      };
      await expect(run(f)).rejects.toBeDefined();
      expect(f.requests.every(r => r.method !== 'POST' || r.media === fixtureNegotiationMedia)).toBe(true);
    });
  });

  it('sends no further request after the frozen lease is revoked mid-observation', async() => {
    await membershipPolicyFixture(async f => {
      let atRevocation = 0;
      f.replies.get(`GET ${f.roomPolicy}`)!.before = async() => {
        await f.credentials.revoke(f.binding.credentialRef); atRevocation = f.requests.length;
      };
      await run(f).catch(() => undefined);
      expect(atRevocation).toBeGreaterThan(0);
      expect(f.requests).toHaveLength(atRevocation);
    });
  });

  it.each(['headers', 'body'] as const)('stops and closes actual stalled %s response by deadline', async stall => {
    await membershipPolicyFixture(async f => {
      const start = performance.now();
      let enteredStallAtMs: number | undefined;
      f.set('GET', f.roomPolicy, { status: 200, stall,
        before: () => { enteredStallAtMs = performance.now() - start; } });
      const result = await run(f, { requestTimeoutMs: 120, totalTimeoutMs: 2000 });
      expect(result.coverage).toBe('incomplete'); expect(performance.now() - start).toBeLessThan(2500);
      for (let i = 0; i < 20 && !f.closedStalls.includes(f.roomPolicy); i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(f.closedStalls, JSON.stringify({ enteredStallAtMs,
        elapsedMs: performance.now() - start, issues: result.issues,
        requests: f.requests.map(request => ({ method: request.method, url: request.url })) })).toContain(f.roomPolicy);
      expect(result.policies.find(p => p.iri === f.roomPolicy)?.state).toBe('unknown');
      expect(f.requests.every(r => r.method !== 'POST' || r.media === fixtureNegotiationMedia)).toBe(true);
    });
  });
});
