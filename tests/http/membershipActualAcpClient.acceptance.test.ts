import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { actualMembershipAcpFixture } from '../helpers/ActualMembershipWacFixture';
import { expectedSourceDigest, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';
import { MembershipPolicyObserver, proveMembershipEffectiveRead, compileMembershipPolicyGuard,
  executeMembershipGuardedCas } from '../../src/api/matrix/membershipPolicyObservation';

const negotiation = 'application/vnd.xpod.authorization-profile-negotiation+json';
const observation = 'application/vnd.xpod.authorization-observation+json';

/** Actual CSS/SQLite/vault/ORM and named lease; counted principals, not Gateway DPoP.
 * The fixture native producer is Comunica, not production QLever. */
describe('root actual CSS ACP client evidence', () => {
  it('calibrates actual owner admission, absent target Read and a qualified source-bound declaration', async () => {
    await actualMembershipAcpFixture(async f => {
      const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(initial.facts.membershipInvitations?.[f.actor]).toEqual({
        id: '$root-actual-admission', inviterWebId: f.owner, createdAt: 10,
      });
      expect(initial.facts.membershipAuthorityPublication?.state).toBe('complete');
      const denied = await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': f.actor } });
      await denied.text(); expect(denied.status).toBe(403);
      const payload = { ...await f.observationRequest(f.actor), profile: 'a2-profile-negotiation-v1' };
      f.native.mockClear();
      const response = await fetch(`${f.room}-/sparql`, { method: 'POST',
        headers: { 'content-type': negotiation, 'x-root-fixture-principal': f.owner }, body: JSON.stringify(payload) });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual({ version: 1, profile: 'a2-profile-declaration-v1',
        guardedPolicyProfile: 'acp-ground-v1', requesterWebId: f.owner, targetWebId: f.actor,
        sourceIri: f.source, sourceDigest: expectedSourceDigest(f.source, f.document, initial.quads),
        contextDigest: payload.contextDigest, challenge: payload.challenge });
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('obtains a closed actual ACP network proof without exposing WAC provenance or writing data', async () => {
    await actualMembershipAcpFixture(async f => {
      const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      f.requests.length = 0; f.native.mockClear();
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      expect(result.coverage).toBe('complete');
      const proof = await proveMembershipEffectiveRead(result, f.actor);
      expect(proof.profile).toBe('acp-effective-read-v1');
      expect(proof.actorWebId).toBe(f.actor);
      expect(proof.noneRead).toBe(true); expect(proof.allRead).toBe(false);
      expect(proof.resources.map(row => row.iri).sort()).toEqual([f.room, f.document].sort());
      expect(proof.resources.every(row => row.read === false && !('inheritedFrom' in row))).toBe(true);
      expect(proof).toMatchObject({ sourceIri: f.source,
        sourceDigest: expectedSourceDigest(f.source, f.document, initial.quads) });
      const posts = f.requests.filter(row => row.method === 'POST');
      expect(posts.map(row => row.media)).toEqual([negotiation, observation]);
      expect(posts.every(row => row.url === `${f.room}-/sparql` && row.principal === f.owner)).toBe(true);
      expect(result.counts.requests).toBe(2);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('includes private server-root Read and all eight historical buckets without policy or message body GETs', async () => {
    await actualMembershipAcpFixture(async f => {
      const rootPolicy = f.policyIri(f.origin);
      await f.putRdfSet(rootPolicy, rootAcpPolicy(rootPolicy, f.origin, f.actor, ['Read'], { label: 'reader' }));
      const history: string[] = [];
      for (const day of ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26',
        '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']) {
        const bucket = `${f.room}${day}/`;
        const document = `${bucket}messages.ttl`;
        await f.putContainer(bucket);
        await f.putRdf(document, `<${document}#msg-one> <urn:root:text> "first" .
          <${document}#msg-two> <urn:root:text> "second" .`);
        history.push(bucket, document);
      }
      const head = await fetch(history[history.length - 1], { method: 'HEAD',
        headers: { 'x-root-fixture-principal': f.actor } });
      await head.text(); expect(head.status).toBe(200);
      f.requests.length = 0; f.native.mockClear();
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      const proof = await proveMembershipEffectiveRead(result, f.actor);
      expect(proof.profile).toBe('acp-effective-read-v1');
      expect(proof.allRead).toBe(true); expect(proof.noneRead).toBe(false);
      expect(proof.resources.map(row => row.iri).sort()).toEqual([f.room, f.document, ...history].sort());
      expect(proof.resources.every(row => !('inheritedFrom' in row))).toBe(true);
      expect(f.requests.some(row => row.method === 'GET' && (history.includes(row.url) || row.url === rootPolicy))).toBe(false);
      expect(f.requests.filter(row => row.method === 'POST').map(row => row.media)).toEqual([negotiation, observation]);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('rejects copied observations and a different actor instead of minting consumable evidence', async () => {
    await actualMembershipAcpFixture(async f => {
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      f.native.mockClear();
      for (const copy of [{ ...result }, JSON.parse(JSON.stringify(result))]) {
        await expect(proveMembershipEffectiveRead(copy, f.actor)).rejects.toBeDefined();
        expect(() => compileMembershipPolicyGuard(copy)).toThrow();
      }
      await expect(proveMembershipEffectiveRead(result, f.owner)).rejects.toBeDefined();
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('rejects an unrelated raw physical-source addition before proof or native source commit', async () => {
    await actualMembershipAcpFixture(async f => {
      const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(result);
      await f.indexedPut(f.document, [...initial.quads, DataFactory.quad(
        DataFactory.namedNode(`${f.document}#other-record`), DataFactory.namedNode('urn:root:unrelated'),
        DataFactory.literal('new raw source value'))]);
      f.native.mockClear();
      await expect(proveMembershipEffectiveRead(result, f.actor)).rejects.toMatchObject({ status: 409 });
      await expect(executeMembershipGuardedCas(guard, { protocols: { ...initial.protocols,
        rootProbe: { value: 'must not commit' } } })).rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('fences a changed private root policy at the actual guarded native source write', async () => {
    await actualMembershipAcpFixture(async f => {
      const rootPolicy = f.policyIri(f.origin);
      await f.putRdfSet(rootPolicy, rootAcpPolicy(rootPolicy, f.origin, f.actor, ['Read'], { label: 'reader' }));
      const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      const proof = await proveMembershipEffectiveRead(result, f.actor);
      expect(proof.allRead).toBe(true);
      const guard = compileMembershipPolicyGuard(result);
      await f.putRdfSet(rootPolicy, rootAcpPolicy(rootPolicy, f.origin, f.actor, ['Read'], { deny: true, label: 'reader' }));
      const denied = await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': f.actor } });
      await denied.text(); expect(denied.status).toBe(403);
      f.native.mockClear();
      await expect(executeMembershipGuardedCas(guard, { protocols: { ...initial.protocols,
        rootProbe: { value: 'must not commit' } } })).rejects.toMatchObject({ status: 409 });
      const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(expectedSourceDigest(f.source, f.document, current.quads)).toBe(expectedSourceDigest(f.source, f.document, initial.quads));
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('calibrates the actual generic ACP guarded source CAS with a supported protocol-only change', async () => {
    await actualMembershipAcpFixture(async f => {
      const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      const guard = compileMembershipPolicyGuard(result);
      f.native.mockClear();
      const current = await executeMembershipGuardedCas(guard, { protocols: { ...initial.protocols,
        rootProbe: { value: 'confirmed generic source CAS' } } });
      expect(current.protocols.rootProbe).toEqual({ value: 'confirmed generic source CAS' });
      expect(current.facts.participants).toEqual(initial.facts.participants);
      expect(current.facts.membershipInvitations).toEqual(initial.facts.membershipInvitations);
      expect(current.facts.membershipAuthority).toEqual(initial.facts.membershipAuthority);
      expect(f.native).toHaveBeenCalledTimes(1);
    });
  });

  it('expires at the original remaining total deadline instead of gaining a fresh lifetime at sealing', async () => {
    await actualMembershipAcpFixture(async f => {
      let delayed = false;
      const original = f.options.podAccess.getPodFetch;
      f.options.podAccess.getPodFetch = async (webId, request) => {
        const named = await original(webId, request);
        return async (input, init) => {
          if (!delayed && String(input) === f.document && (init?.method ?? 'GET') === 'GET') {
            delayed = true;
            await new Promise(resolve => setTimeout(resolve, 400));
          }
          return await named(input, init);
        };
      };
      const started = performance.now();
      const result = await new MembershipPolicyObserver({ ...f.options,
        limits: { totalTimeoutMs: 1500 } }).observe(f.roomId, f.actorContext, 'join');
      expect(delayed).toBe(true); expect(result.coverage).toBe('complete');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 1600 - (performance.now() - started))));
      f.native.mockClear();
      expect(() => compileMembershipPolicyGuard(result)).toThrow();
      await expect(proveMembershipEffectiveRead(result, f.actor)).rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('bounds and closes the actual physical canonical body consumed by asynchronous proof', async () => {
    let stalled = false;
    let document = '';
    let enteredAt: number | undefined;
    let closedAt: number | undefined;
    await actualMembershipAcpFixture(async f => {
      document = f.document;
      const result = await new MembershipPolicyObserver({ ...f.options,
        limits: { requestTimeoutMs: 400 } }).observe(f.roomId, f.actorContext, 'join');
      expect(result.coverage).toBe('complete');
      stalled = true; f.native.mockClear();
      let failure: unknown;
      try { await proveMembershipEffectiveRead(result, f.actor); }
      catch (error) { failure = error; }
      expect(enteredAt).toBeDefined();
      expect(performance.now() - enteredAt!).toBeLessThan(700);
      expect(failure).toMatchObject({ status: 503 });
      for (let i = 0; i < 20 && closedAt === undefined; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(closedAt).toBeDefined(); expect(closedAt! - enteredAt!).toBeLessThan(700);
      expect(f.native).not.toHaveBeenCalled();
    }, { intercept: (request, response, url) => {
      if (!stalled || request.method !== 'GET' || url !== document) return false;
      enteredAt = performance.now();
      const watchdog = setTimeout(() => request.socket.destroy(), 1600);
      watchdog.unref();
      request.socket.once('close', () => { closedAt = performance.now(); clearTimeout(watchdog); });
      response.writeHead(200, { 'Content-Type': 'text/turtle' });
      response.write('<urn:root:unfinished>');
      return true;
    } });
  });

  it('does not renew an observation lifetime while a generic guarded CAS waits for its current lease', async () => {
    await actualMembershipAcpFixture(async f => {
      const initial = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      const started = performance.now();
      const result = await new MembershipPolicyObserver({ ...f.options, limits: { totalTimeoutMs: 1500 } })
        .observe(f.roomId, f.actorContext, 'join');
      expect(result.coverage).toBe('complete');
      const guard = compileMembershipPolicyGuard(result);
      const lease = f.credentials.lease.bind(f.credentials);
      vi.spyOn(f.credentials, 'lease').mockImplementationOnce(async input => {
        await new Promise(resolve => setTimeout(resolve, 350));
        return await lease(input);
      });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 1350 - (performance.now() - started))));
      const before = f.requests.length;
      f.native.mockClear();
      let failure: unknown;
      try {
        await executeMembershipGuardedCas(guard, { protocols: { ...initial.protocols,
          rootProbe: { value: 'must not gain a new lifetime' } } });
      } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      expect(f.requests).toHaveLength(before);
      expect(f.native).not.toHaveBeenCalled();
    });
  });
});
