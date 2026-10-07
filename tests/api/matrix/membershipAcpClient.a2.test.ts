import { describe, expect, it } from 'vitest';
import { actualMembershipAcpFixture } from '../../helpers/ActualMembershipWacFixture';
import { MembershipPolicyObserver, proveMembershipEffectiveRead } from '../../../src/api/matrix/membershipPolicyObservation';
import { applyMembershipReadDelta } from '../../../src/api/matrix/membershipPolicyMutation';

const negotiation = 'application/vnd.xpod.authorization-profile-negotiation+json';
const observation = 'application/vnd.xpod.authorization-observation+json';

/**
 * B-owned closed actual-HTTP ACP client invariants (actual CSS/SQLite/vault/named lease, counted
 * principals, Comunica native producer — not Gateway DPoP or production QLever). The root acceptance
 * suite owns the broader calibration; these lock the ACP-specific delta and budget fail-closed edges.
 */
describe('A2 ACP client fail-closed invariants', () => {
  it('refuses an ACP Read delta with no matching pending operation, zero native/policy effects', async() => {
    await actualMembershipAcpFixture(async f => {
      f.native.mockClear();
      // No operation is reserved for this actor: the shared operation/phase guard refuses 409 before
      // any policy/source write (ACP support is real; this is a wrong-operation negative).
      await expect(applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-actual-admission' })).rejects.toMatchObject({ status: 409 });
      expect(f.native).not.toHaveBeenCalled();
      const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
      expect(current.facts.participants).toEqual([ f.owner ]);
    });
  });

  it('grants and removes an ACP Read through the same lifecycle with an explicit installed profile', async() => {
    await actualMembershipAcpFixture(async f => {
      const head = async (iri: string, principal: string) => {
        const response = await fetch(iri, { method: 'HEAD', headers: { 'x-root-fixture-principal': principal } });
        await response.arrayBuffer(); return response.status;
      };
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      let state = await join.reserveJoin(await join.readCurrent(), { operationId: '$own-acp-join', createdAt: 20 });
      expect(state.facts.membershipReadGrants?.[f.actor]).not.toHaveProperty('readProfile');
      expect(await head(f.document, f.actor)).toBe(403);
      f.native.mockClear();
      const evidence = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$own-acp-join' });
      expect(f.native).toHaveBeenCalledTimes(1);
      expect(await head(f.document, f.actor)).toBe(200);
      state = await join.markJoinReadGranted(state, '$own-acp-join', evidence);
      expect(state.facts.membershipReadGrants?.[f.actor]).toMatchObject({ state: 'installed', readProfile: 'acp-ground-v1' });
      state = await join.completeJoin(state, '$own-acp-join');
      const leave = await f.membership.openForLeave(f.roomId, f.actorContext);
      state = await leave.reserveLeave(await leave.readCurrent(), { operationId: '$own-acp-leave', createdAt: 40 });
      f.native.mockClear();
      const removed = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'leave', operationId: '$own-acp-leave' });
      expect(f.native).toHaveBeenCalledTimes(1);
      expect(await head(f.document, f.actor)).toBe(403);
      expect(await head(f.document, f.owner)).toBe(200);
      state = await leave.markLeaveReadRemoved(state, '$own-acp-leave', removed);
      state = await leave.commitLeaveRoster(state, '$own-acp-leave');
      expect(state.facts.participants).toEqual([ f.owner ]);
      await leave.completeLeave(state, '$own-acp-leave');
    });
  });

  it('never runs a free ACP observation when the shared request budget permits only negotiation', async() => {
    await actualMembershipAcpFixture(async f => {
      f.requests.length = 0; f.native.mockClear();
      await expect(new MembershipPolicyObserver({ ...f.options, limits: { requests: 1 } })
        .observe(f.roomId, f.actorContext, 'join')).rejects.toMatchObject({ status: 503 });
      const posts = f.requests.filter(row => row.method === 'POST');
      expect(posts.map(row => row.media)).toEqual([ negotiation ]);
      expect(posts.every(row => row.url === `${f.room}-/sparql` && row.principal === f.owner)).toBe(true);
      expect(f.requests.some(row => row.method === 'POST' && row.media === observation)).toBe(false);
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('answers the public ACP proof from the same actual returned read table with no WAC inheritance', async() => {
    await actualMembershipAcpFixture(async f => {
      f.native.mockClear();
      const result = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'join');
      const proof = await proveMembershipEffectiveRead(result, f.actor);
      expect(result.coverage).toBe('complete');
      expect(proof.profile).toBe('acp-effective-read-v1');
      // The published rows are exactly the qualified guard inventory bijection, never WAC provenance.
      expect(proof.resources.map(row => row.iri).sort()).toEqual(result.resources.map(row => row.iri).sort());
      expect(proof.resources.every(row => row.read === false && !('inheritedFrom' in row))).toBe(true);
      expect(result.counts.requests).toBe(2);
      expect(f.native).not.toHaveBeenCalled();
    });
  });
});
