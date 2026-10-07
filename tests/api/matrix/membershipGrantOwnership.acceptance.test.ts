import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { createHash } from 'node:crypto';
import { CanonicalMembershipSource } from '../../../src/api/matrix/canonicalMembershipSource';
import { MembershipAuthorityResolver } from '../../../src/api/matrix/membershipAuthorityResolver';
import { MembershipLifecycle } from '../../../src/api/matrix/membershipLifecycle';
import { grantAuthorizationIri } from '../../../src/api/matrix/membershipReadGrant';
import type { MatrixEventRecord } from '../../../src/api/matrix/types';
import { applyMembershipReadDelta } from '../../../src/api/matrix/membershipPolicyMutation';
import { membershipPolicyFixture } from '../../helpers/MembershipPolicyFixture';
import { membershipPhasePolicyFixture } from '../../helpers/MembershipPhasePolicyFixture';

const ACL = 'http://www.w3.org/ns/auth/acl#';
describe('root operation-owned WAC grant boundary', () => {
  it('keeps grant identity distinct for full source fragments sharing policy, actor and operation key', () => {
    const policy = 'https://example.org/pod/policies/shared';
    const actor = 'https://example.org/actor/profile/card#me';
    // Operation keys can repeat across separately scoped sources. A fragment is part
    // of each canonical source identity even when both live in the same document.
    expect(grantAuthorizationIri(policy, actor, '$join', 'https://example.org/pod/chat/index.ttl#one'))
      .not.toBe(grantAuthorizationIri(policy, actor, '$join', 'https://example.org/pod/chat/index.ttl#two'));
  });

  it.each(['author', 'binding', 'source'] as const)('rejects a reservation with a foreign %s before ACL effects', async changed => {
    await membershipPolicyFixture(async base => {
      const f = await membershipPhasePolicyFixture(base);
      const join = await new CanonicalMembershipSource(f.observationOptions).openForJoin(f.roomId, f.actorContext);
      await join.reserveJoin(await join.readCurrent(), { operationId: '$root-foreign-reservation', createdAt: 20 });
      const old = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
      if (old.object.termType !== 'Literal') throw new Error('Root fixture protocols must be JSON');
      const value = JSON.parse(old.object.value);
      const reservation = value.matrix.membershipReadGrants?.[f.actor];
      expect(reservation).toBeDefined();
      if (changed === 'author') reservation.authorPodUrl.webId = f.target;
      else if (changed === 'binding') reservation.binding.version = f.binding.version + 1;
      else reservation.sourceIri = `${f.sourceIri.split('#')[0]}#foreign-source`;
      f.graph.removeQuad(old);
      f.graph.addQuad(DataFactory.quad(old.subject, old.predicate,
        DataFactory.literal(JSON.stringify(value), old.object.datatype), old.graph));
      f.requests.length = 0;
      await expect(applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-foreign-reservation' })).rejects.toMatchObject({ status: 409 });
      expect(f.requests.filter(request => request.mutation === 'policy')).toEqual([]);
      expect(f.graph.getQuads(null, DataFactory.namedNode(`${ACL}agent`), DataFactory.namedNode(f.actor),
        DataFactory.namedNode(f.roomPolicy))).toEqual([]);
      expect((await join.readCurrent()).facts.membershipOperation?.phase).toBe('join-read-pending');
    });
  });

  it('retains separate actor grants across slot retirement, locator reset and a new join', async () => {
    await membershipPolicyFixture(async base => {
      const f = await membershipPhasePolicyFixture(base);
      const options = { ...f.observationOptions };
      const finishJoin = async(actor: typeof f.actorContext, id: string) => {
        const port = await new CanonicalMembershipSource(options).openForJoin(f.roomId, actor);
        let current = await port.reserveJoin(await port.readCurrent(), { operationId: id, createdAt: 20 });
        const proof = await applyMembershipReadDelta(options, f.roomId, actor, { kind: 'join', operationId: id });
        current = await port.markJoinReadGranted(current, id, proof);
        await port.completeJoin(current, id);
      };
      const invite = async(target: string, id: string) => {
        await new MembershipLifecycle({ source: new CanonicalMembershipSource(options), eventId: () => id, now: () => 30 })
          .invite(f.roomId, target, f.ownerContext, async input => {
            const op = input.operation;
            return { eventId: op.operationId, roomId: f.roomId, type: 'm.room.member', sender: op.actor.webId,
              stateKey: op.targetWebId, originServerTs: op.event.createdAt, content: { ...op.event.content },
              event: { event_id: op.operationId, room_id: f.roomId, type: 'm.room.member', sender: op.actor.webId,
                state_key: op.targetWebId, origin_server_ts: op.event.createdAt, content: { ...op.event.content } } } as MatrixEventRecord;
          });
      };
      const actorGrants = (actor: string) => f.graph.getQuads(null, DataFactory.namedNode(`${ACL}agent`),
        DataFactory.namedNode(actor), DataFactory.namedNode(f.roomPolicy));
      await finishJoin(f.actorContext, '$root-first-owned-join');
      const first = actorGrants(f.actor); expect(first).toHaveLength(1);
      await invite(f.target, '$root-other-admission');
      await finishJoin(f.targetContext, '$root-other-owned-join');
      const other = actorGrants(f.target); expect(other).toHaveLength(1);
      expect(f.graph.has(first[0])).toBe(true);
      await f.locator.wipe();
      options.resolver = new MembershipAuthorityResolver({ ...options, locator: f.locator });
      // Explicit qualified current-member caller read rebuilds the candidate. The named
      // phase port must retain its existing prohibition on implicit caller bootstrap.
      await options.resolver.readAsCaller(f.roomId, f.actorContext);
      const leave = await new CanonicalMembershipSource(options).openForLeave(f.roomId, f.actorContext);
      let current = await leave.reserveLeave(await leave.readCurrent(), { operationId: '$root-reset-leave', createdAt: 40 });
      const removed = await applyMembershipReadDelta(options, f.roomId, f.actorContext,
        { kind: 'leave', operationId: '$root-reset-leave' });
      current = await leave.markLeaveReadRemoved(current, '$root-reset-leave', removed);
      current = await leave.commitLeaveRoster(current, '$root-reset-leave');
      await leave.completeLeave(current, '$root-reset-leave');
      expect(actorGrants(f.actor)).toEqual([]);
      expect(f.graph.has(other[0])).toBe(true);
      expect(new Set(current.facts.participants)).toEqual(new Set([f.owner, f.target]));
      await invite(f.actor, '$root-next-admission');
      await finishJoin(f.actorContext, '$root-new-owned-join');
      const next = actorGrants(f.actor); expect(next).toHaveLength(1);
      expect(next[0].subject.value).not.toBe(first[0].subject.value);
      expect(f.graph.has(first[0])).toBe(false);
      expect(f.graph.has(other[0])).toBe(true);
    });
  });

  it('retains an exact legacy node that existed before join and keeps residual leave pending', async () => {
    await membershipPolicyFixture(async base => {
      const f = await membershipPhasePolicyFixture(base);
      const legacy = DataFactory.namedNode(`${f.roomPolicy}#membership-read-${createHash('sha256')
        .update(`${f.actor}\n${f.room}`).digest('hex').slice(0, 32)}`);
      const graph = DataFactory.namedNode(f.roomPolicy);
      const pairs = [
        ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${ACL}Authorization`],
        [`${ACL}agent`, f.actor], [`${ACL}accessTo`, f.room], [`${ACL}default`, f.room], [`${ACL}mode`, `${ACL}Read`],
      ];
      const existing = pairs.map(([predicate, object]) => DataFactory.quad(legacy,
        DataFactory.namedNode(predicate), DataFactory.namedNode(object), graph));
      f.graph.addQuads(existing); await f.refreshPolicy();
      const source = new CanonicalMembershipSource(f.observationOptions);
      const join = await source.openForJoin(f.roomId, f.actorContext);
      let state = await join.reserveJoin(await join.readCurrent(), { operationId: '$root-preexisting-join', createdAt: 20 });
      const proof = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-preexisting-join' });
      state = await join.markJoinReadGranted(state, '$root-preexisting-join', proof);
      await join.completeJoin(state, '$root-preexisting-join');
      const leave = await source.openForLeave(f.roomId, f.actorContext);
      await leave.reserveLeave(await leave.readCurrent(), { operationId: '$root-preexisting-leave', createdAt: 40 });
      let error: unknown;
      try { await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { kind: 'leave', operationId: '$root-preexisting-leave' }); } catch (caught) { error = caught; }
      for (const quad of existing) expect(f.graph.has(quad)).toBe(true);
      expect(error).toMatchObject({ status: 409 });
      const current = await leave.readCurrent();
      expect(current.facts.membershipOperation?.phase).toBe('leave-read-pending');
      expect(current.facts.participants).toContain(f.actor);
    });
  });

  it.each(['additional mode', 'additional agent'] as const)('preserves a grant with %s outside the membership delta', async changed => {
    await membershipPolicyFixture(async base => {
      const f = await membershipPhasePolicyFixture(base);
      const source = new CanonicalMembershipSource(f.observationOptions);
      const join = await source.openForJoin(f.roomId, f.actorContext);
      let state = await join.reserveJoin(await join.readCurrent(), { operationId: '$root-owned-join', createdAt: 20 });
      const proof = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-owned-join' });
      state = await join.markJoinReadGranted(state, '$root-owned-join', proof);
      await join.completeJoin(state, '$root-owned-join');
      const grant = f.graph.getQuads(null, DataFactory.namedNode(`${ACL}agent`), DataFactory.namedNode(f.actor),
        DataFactory.namedNode(f.roomPolicy))[0];
      expect(grant).toBeDefined();
      const extra = DataFactory.quad(grant.subject,
        DataFactory.namedNode(`${ACL}${changed === 'additional mode' ? 'mode' : 'agent'}`),
        DataFactory.namedNode(changed === 'additional mode' ? `${ACL}Control` : f.target), grant.graph);
      f.graph.addQuad(extra);
      await f.refreshPolicy();
      const leave = await source.openForLeave(f.roomId, f.actorContext);
      await leave.reserveLeave(await leave.readCurrent(), { operationId: '$root-owned-leave', createdAt: 40 });
      f.requests.length = 0;
      await expect(applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { kind: 'leave', operationId: '$root-owned-leave' })).rejects.toMatchObject({ status: 415 });
      expect(f.graph.has(extra)).toBe(true);
      expect(f.graph.has(grant)).toBe(true);
      expect(f.requests.filter(request => request.mutation === 'policy')).toEqual([]);
      expect((await leave.readCurrent()).facts.membershipOperation?.phase).toBe('leave-read-pending');
    });
  });
});
