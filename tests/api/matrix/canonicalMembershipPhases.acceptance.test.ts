import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { CanonicalMembershipSource } from '../../../src/api/matrix/canonicalMembershipSource';
import { MembershipLifecycle } from '../../../src/api/matrix/membershipLifecycle';
import type { MembershipOperation } from '../../../src/api/matrix/membershipOperation';
import type { MatrixEventRecord, MatrixStoreContext } from '../../../src/api/matrix/types';
import { canonicalInviteFixture } from '../../helpers/CanonicalInviteFixture';
import { membershipPhasePolicyFixture } from '../../helpers/MembershipPhasePolicyFixture';
import { applyMembershipReadDelta } from '../../../src/api/matrix/membershipPolicyMutation';

type Fixture = Parameters<Parameters<typeof canonicalInviteFixture>[0]>[0];
const factory = (f: Fixture) => new CanonicalMembershipSource({ canonicalSource: f.source,
  resolver: f.resolver, credentials: f.credentials, podAccess: f.podAccess, issuer: f.issuer });
const record = (roomId: string, op: Readonly<MembershipOperation>): MatrixEventRecord => ({
  eventId: op.operationId, roomId, type: 'm.room.member', sender: op.actor.webId,
  originServerTs: op.event.createdAt, stateKey: op.targetWebId, content: { ...op.event.content },
  event: { event_id: op.operationId, room_id: roomId, type: 'm.room.member', sender: op.actor.webId,
    origin_server_ts: op.event.createdAt, state_key: op.targetWebId, content: { ...op.event.content } },
});
const posts = (f: Fixture) => f.requests.filter(request => request.method === 'POST' && request.mutation !== 'policy'
  && request.media !== 'application/vnd.xpod.authorization-profile-negotiation+json');
const policyPosts = (f: Fixture) => f.requests.filter(request => request.mutation === 'policy');
const delta = async(f: Fixture, id: string, kind: 'join' | 'leave', actor = f.actorContext) => {
  const policy = await membershipPhasePolicyFixture(f);
  return await applyMembershipReadDelta(policy.observationOptions, f.roomId, actor, { operationId: id, kind });
};
const invite = async(f: Fixture, target = f.actor, id = '$root-admission') => {
  const lifecycle = new MembershipLifecycle({ source: factory(f), eventId: () => id, now: () => 10 });
  await lifecycle.invite(f.roomId, target, f.ownerContext, async input => record(input.roomId, input.operation));
};
const prepare = async(f: Fixture, roles: 'absent' | 'empty' = 'empty') => {
  await f.reset({ participants: [f.owner], roles });
  await invite(f);
  f.requests.length = 0;
};
function changeProtocols(f: Fixture, update: (protocols: any) => any): void {
  const old = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
  if (old.object.termType !== 'Literal') throw new Error('Fixture protocols must be JSON');
  f.graph.removeQuad(old);
  f.graph.addQuad(DataFactory.quad(old.subject, old.predicate,
    DataFactory.literal(JSON.stringify(update(JSON.parse(old.object.value))), old.object.datatype), old.graph));
}
function changeRoles(f: Fixture, roles: Record<string, string>): void {
  const protocol = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
  const predicate = DataFactory.namedNode(protocol.predicate.value.replace(/protocols$/, 'memberRoles'));
  f.graph.removeQuads(f.graph.getQuads(protocol.subject, predicate, null, null));
  f.graph.addQuad(DataFactory.quad(protocol.subject, predicate,
    DataFactory.literal(JSON.stringify(roles), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')), protocol.graph));
}
async function joinAll(f: Fixture, actor: MatrixStoreContext = f.actorContext, id = '$root-join') {
  const port = await factory(f).openForJoin(f.roomId, actor);
  let evidence = await port.reserveJoin(await port.readCurrent(), { operationId: id, createdAt: 20 });
  evidence = await port.markJoinReadGranted(evidence, id, await delta(f, id, 'join', actor));
  return await port.completeJoin(evidence, id);
}

/** Actual HTTP + public ORM conditional RDF + SQLite/vault and full-history ACL delta/proof.
 * Counted principals do not prove CSS authorization, actor PDU persistence, DPoP or user Gateway. */
describe('root independent canonical join/leave phase primitives', () => {
  it.each(['absent', 'empty'] as const)('reserves join from canonical admission with %s raw roles', async roles => {
    await canonicalInviteFixture(async f => {
      await prepare(f, roles);
      f.denyCallerRead(f.actor);
      await expect(f.source.readSnapshot(f.roomId, f.actorContext)).rejects.toMatchObject({ status: 403 });
      f.requests.length = 0;
      const port = await factory(f).openForJoin(f.roomId, f.actorContext);
      const before = await port.readCurrent();
      const preserved = f.graph.getQuads(null, null, null, null).filter(q =>
        !['protocols', 'memberRoles', 'participant'].some(suffix => q.predicate.value.endsWith(suffix)));
      const pending = await port.reserveJoin(before, { operationId: '$root-join', createdAt: 20 });
      expect(pending.facts.membershipOperation).toMatchObject({ kind: 'join', phase: 'join-read-pending',
        actor: { webId: f.actor, podUrl: f.actorPodUrl }, targetWebId: f.actor, authority: f.binding,
        expected: { participants: [f.owner], memberRoles: roles === 'absent' ? null : {},
          invitation: { id: '$root-admission', inviterWebId: f.owner, createdAt: 10 } } });
      expect(pending.facts.participants).toEqual(expect.arrayContaining([f.owner, f.actor]));
      expect(pending.facts.memberRoles).toEqual({ [f.actor]: 'member' });
      expect(pending.facts.membershipInvitations?.[f.actor]).toBeUndefined();
      for (const quad of preserved) expect(f.graph.has(quad)).toBe(true);
      expect(posts(f)).toHaveLength(1);
      expect(f.requests.every(request => request.principal === f.owner)).toBe(true);
      expect(f.requests.every(request => request.url === f.documentIri || request.url === f.endpoint)).toBe(true);
      // Source-only primitive has not granted the caller actual Read.
      await expect(f.source.readSnapshot(f.roomId, f.actorContext)).rejects.toMatchObject({ status: 403 });
    });
  });

  it('consumes an earlier invitation independently of the most recent complete slot', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      await invite(f, f.target, '$root-second-admission');
      f.requests.length = 0;
      await joinAll(f);
      await joinAll(f, f.targetContext, '$root-second-join');
      const current = await f.source.read(f.roomId, f.ownerContext);
      expect(new Set(current.participants)).toEqual(new Set([f.owner, f.actor, f.target]));
      expect(current.memberRoles).toEqual({ [f.actor]: 'member', [f.target]: 'member' });
      expect(current.membershipInvitations).toEqual({});
      expect(current.membershipOperation).toMatchObject({ operationId: '$root-second-join', phase: 'complete' });
      expect(posts(f)).toHaveLength(6);
      expect(posts(f).every(request => request.url === f.endpoint)).toBe(true);
      expect(policyPosts(f)).toHaveLength(2);
      expect(f.requests.some(request => request.method === 'GET' && request.url.endsWith('messages.ttl'))).toBe(false);
    });
  });

  it('allows only one of two independent HTTP join reservations to win', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const left = await factory(f).openForJoin(f.roomId, f.actorContext);
      const right = await factory(f).openForJoin(f.roomId, f.actorContext);
      const a = await left.readCurrent(); const b = await right.readCurrent();
      await left.reserveJoin(a, { operationId: '$root-left', createdAt: 20 });
      await expect(right.reserveJoin(b, { operationId: '$root-right', createdAt: 30 })).rejects.toBeDefined();
      const current = await f.source.read(f.roomId, f.ownerContext);
      expect(current.membershipOperation).toMatchObject({ operationId: '$root-left', phase: 'join-read-pending' });
      expect(current.participants.filter(webId => webId === f.actor)).toHaveLength(1);
    });
  });

  it.each(['invitation', 'roles', 'binding'] as const)('rejects stale join reserve after %s changes', async changed => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const port = await factory(f).openForJoin(f.roomId, f.actorContext);
      const snapshot = await port.readCurrent();
      if (changed === 'roles') changeRoles(f, { [f.actor]: 'admin' });
      else changeProtocols(f, protocols => ({ ...protocols, matrix: { ...protocols.matrix,
        ...(changed === 'invitation' ? { membershipInvitations: {} }
          : { membershipAuthority: { ...f.binding, version: 2 } }) } }));
      await expect(port.reserveJoin(snapshot, { operationId: '$must-not-win', createdAt: 20 })).rejects.toBeDefined();
      const current = await f.source.read(f.roomId, f.ownerContext);
      expect(current.participants).toEqual([f.owner]);
      expect(current.membershipOperation?.operationId).toBe('$root-admission');
    });
  });

  it('rejects orphan roles, missing admission and unbound join without source mutations', async() => {
    await canonicalInviteFixture(async f => {
      for (const invalid of ['orphan', 'missing', 'unbound']) {
        await prepare(f);
        if (invalid === 'orphan') changeRoles(f, { [f.actor]: 'admin' });
        if (invalid === 'missing') changeProtocols(f, p => ({ ...p, matrix: { ...p.matrix, membershipInvitations: {} } }));
        if (invalid === 'unbound') changeProtocols(f, p => {
          const matrix = { ...p.matrix }; delete matrix.membershipAuthority; delete matrix.membershipAuthorityPublication;
          return { ...p, matrix };
        });
        f.requests.length = 0;
        await expect((async() => {
          const port = await factory(f).openForJoin(f.roomId, f.actorContext);
          await port.reserveJoin(await port.readCurrent(), { operationId: '$invalid', createdAt: 20 });
        })()).rejects.toBeDefined();
        expect(posts(f)).toEqual([]);
      }
    });
  });

  it('cannot invent a trusted locator from an invited caller that cannot read canonical', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f); await f.locator.wipe(); f.denyCallerRead(f.actor); f.requests.length = 0;
      await expect(factory(f).openForJoin(f.roomId, f.actorContext)).rejects.toBeDefined();
      expect(posts(f)).toEqual([]);
      expect(f.requests.filter(request => request.principal === f.owner)).toEqual([]);
    });
  });

  it('retains immutable join fields through legal marks and rejects a skipped phase', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const port = await factory(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$root-join', createdAt: 20 });
      f.requests.length = 0;
      await expect(port.completeJoin(pending, '$root-join')).rejects.toBeDefined();
      expect(posts(f)).toEqual([]);
      const committed = await port.markJoinReadGranted(pending, '$root-join', await delta(f, '$root-join', 'join'));
      const complete = await port.completeJoin(committed, '$root-join');
      const frozen = pending.facts.membershipOperation!;
      expect(complete.facts.membershipOperation).toEqual({ ...frozen, phase: 'complete' });
      expect(complete.facts.participants).toEqual(pending.facts.participants);
      expect(complete.facts.memberRoles).toEqual(pending.facts.memberRoles);
    });
  });

  it.each(['reserve', 'read-mark', 'complete'] as const)('reopens exact join after lost response at %s', async phase => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      let port = await factory(f).openForJoin(f.roomId, f.actorContext);
      f.losePostResponse(phase === 'reserve');
      let evidence = await port.reserveJoin(await port.readCurrent(), { operationId: '$root-join', createdAt: 20 });
      f.losePostResponse(false);
      port = await factory(f).openForJoin(f.roomId, f.actorContext); evidence = await port.readCurrent();
      const readDelta = await delta(f, '$root-join', 'join');
      f.losePostResponse(phase === 'read-mark');
      if (phase === 'read-mark') {
        await expect(port.markJoinReadGranted(evidence, '$root-join', readDelta)).rejects.toMatchObject({ status: 503 });
      } else evidence = await port.markJoinReadGranted(evidence, '$root-join', readDelta);
      f.losePostResponse(false);
      port = await factory(f).openForJoin(f.roomId, f.actorContext); evidence = await port.readCurrent();
      f.losePostResponse(phase === 'complete'); evidence = await port.completeJoin(evidence, '$root-join');
      f.losePostResponse(false);
      expect(evidence.facts.membershipOperation).toMatchObject({ operationId: '$root-join',
        event: { createdAt: 20 }, phase: 'complete', expected: { invitation: { id: '$root-admission' } } });
      expect(posts(f)).toHaveLength(3);
      expect(policyPosts(f)).toHaveLength(1);
    });
  });

  it('leaves in the required order while preserving another member and unrelated RDF', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f); await joinAll(f);
      await invite(f, f.target, '$root-second-admission'); await joinAll(f, f.targetContext, '$root-second-join');
      f.requests.length = 0;
      const port = await factory(f).openForLeave(f.roomId, f.actorContext);
      const initial = await port.readCurrent();
      const pending = await port.reserveLeave(initial, { operationId: '$root-leave', createdAt: 40 });
      expect(pending.facts.participants).toEqual(initial.facts.participants);
      expect(pending.facts.memberRoles).toEqual(initial.facts.memberRoles);
      await expect(port.commitLeaveRoster(pending, '$root-leave')).rejects.toBeDefined();
      await expect(port.completeLeave(pending, '$root-leave')).rejects.toBeDefined();
      expect(posts(f)).toHaveLength(1);
      const removed = await port.markLeaveReadRemoved(pending, '$root-leave', await delta(f, '$root-leave', 'leave'));
      expect(removed.facts.participants).toEqual(initial.facts.participants);
      const committed = await port.commitLeaveRoster(removed, '$root-leave');
      expect(new Set(committed.facts.participants)).toEqual(new Set([f.owner, f.target]));
      expect(committed.facts.memberRoles).toEqual({ [f.target]: 'member' });
      const complete = await port.completeLeave(committed, '$root-leave');
      expect(complete.facts.membershipOperation).toEqual({ ...pending.facts.membershipOperation!, phase: 'complete' });
      expect(posts(f)).toHaveLength(4);
      expect(policyPosts(f)).toHaveLength(1);
      expect((await f.source.readSnapshot(f.roomId, f.ownerContext)).protocols.foreign).toEqual({ value: 'retain' });
    });
  });

  it.each(['absent', 'empty'] as const)('does not materialize roles during leave from %s roles', async roles => {
    await canonicalInviteFixture(async f => {
      await f.reset({ participants: [f.owner, f.actor], roles });
      await f.resolver.readAsCaller(f.roomId, f.ownerContext);
      const port = await factory(f).openForLeave(f.roomId, f.actorContext);
      let evidence = await port.reserveLeave(await port.readCurrent(), { operationId: '$root-leave', createdAt: 40 });
      evidence = await port.markLeaveReadRemoved(evidence, '$root-leave', await delta(f, '$root-leave', 'leave'));
      evidence = await port.commitLeaveRoster(evidence, '$root-leave');
      evidence = await port.completeLeave(evidence, '$root-leave');
      expect(evidence.facts.membershipOperation?.expected.memberRoles).toEqual(roles === 'absent' ? null : {});
      const current = await f.source.readSnapshot(f.roomId, f.ownerContext);
      expect(current.quads.some(q => q.predicate.value.endsWith('memberRoles'))).toBe(roles !== 'absent');
      expect(current.facts.memberRoles).toEqual({});
    });
  });

  it('rejects author leave and forged actor identity with no physical source mutation', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      for (const actor of [f.ownerContext, { ...f.actorContext, auth: { type: 'solid', webId: f.owner } } as MatrixStoreContext]) {
        f.requests.length = 0;
        await expect((async() => {
          const port = await factory(f).openForLeave(f.roomId, actor);
          await port.reserveLeave(await port.readCurrent(), { operationId: '$root-illegal', createdAt: 40 });
        })()).rejects.toBeDefined();
        expect(posts(f)).toEqual([]);
      }
    });
  });

  it('rejects cross-port evidence and a revoked lease before additional requests', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const left = await factory(f).openForJoin(f.roomId, f.actorContext);
      const right = await factory(f).openForJoin(f.roomId, f.actorContext);
      const expected = await left.readCurrent(); f.requests.length = 0;
      await expect(right.reserveJoin(expected, { operationId: '$root-forged', createdAt: 20 })).rejects.toBeDefined();
      await expect(left.reserveJoin({ facts: structuredClone(expected.facts) },
        { operationId: '$root-forged', createdAt: 20 })).rejects.toBeDefined();
      expect(posts(f)).toEqual([]);
      await f.credentials.revoke(f.binding.credentialRef); f.requests.length = 0;
      await expect(left.reserveJoin(expected, { operationId: '$root-revoked', createdAt: 20 })).rejects.toBeDefined();
      expect(f.requests).toEqual([]);
    });
  });

  it.each(['reserve', 'read-mark', 'roster', 'complete'] as const)('reopens exact leave after lost response at %s', async phase => {
    await canonicalInviteFixture(async f => {
      await prepare(f); await joinAll(f); f.requests.length = 0;
      let port = await factory(f).openForLeave(f.roomId, f.actorContext);
      f.losePostResponse(phase === 'reserve');
      let evidence = await port.reserveLeave(await port.readCurrent(), { operationId: '$root-leave', createdAt: 40 });
      f.losePostResponse(false);
      port = await factory(f).openForLeave(f.roomId, f.actorContext); evidence = await port.readCurrent();
      const readDelta = await delta(f, '$root-leave', 'leave');
      f.losePostResponse(phase === 'read-mark');
      if (phase === 'read-mark') {
        await expect(port.markLeaveReadRemoved(evidence, '$root-leave', readDelta)).rejects.toMatchObject({ status: 503 });
      } else evidence = await port.markLeaveReadRemoved(evidence, '$root-leave', readDelta);
      f.losePostResponse(false);
      port = await factory(f).openForLeave(f.roomId, f.actorContext); evidence = await port.readCurrent();
      f.losePostResponse(phase === 'roster'); evidence = await port.commitLeaveRoster(evidence, '$root-leave');
      f.losePostResponse(false);
      port = await factory(f).openForLeave(f.roomId, f.actorContext); evidence = await port.readCurrent();
      f.losePostResponse(phase === 'complete'); evidence = await port.completeLeave(evidence, '$root-leave');
      f.losePostResponse(false);
      expect(evidence.facts.membershipOperation).toMatchObject({ operationId: '$root-leave',
        event: { createdAt: 40 }, phase: 'complete', expected: { participants: expect.arrayContaining([f.owner, f.actor]) } });
      expect(evidence.facts.participants).toEqual([f.owner]);
      expect(posts(f)).toHaveLength(4);
      expect(policyPosts(f)).toHaveLength(1);
    });
  });

  it('cannot retire a join-read-pending operation to make another invitation', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const port = await factory(f).openForJoin(f.roomId, f.actorContext);
      await port.reserveJoin(await port.readCurrent(), { operationId: '$root-join', createdAt: 20 });
      f.requests.length = 0;
      await expect(invite(f, f.target, '$root-must-not-replace')).rejects.toBeDefined();
      expect(posts(f)).toEqual([]);
      const current = await f.source.read(f.roomId, f.ownerContext);
      expect(current.membershipOperation).toMatchObject({ operationId: '$root-join', phase: 'join-read-pending' });
      expect(current.membershipInvitations?.[f.target]).toBeUndefined();
    });
  });

  it.each(['roles', 'recovery'] as const)('rejects stale phase evidence after %s changes', async changed => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const port = await factory(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$root-join', createdAt: 20 });
      const readDelta = await delta(f, '$root-join', 'join');
      if (changed === 'roles') changeRoles(f, { [f.actor]: 'admin' });
      else changeProtocols(f, p => ({ ...p, matrix: { ...p.matrix,
        membershipOperation: { ...p.matrix.membershipOperation, ownerRecovery: { generation: 1, binding: f.binding } } } }));
      await expect(port.markJoinReadGranted(pending, '$root-join', readDelta)).rejects.toBeDefined();
      expect((await f.source.read(f.roomId, f.ownerContext)).membershipOperation?.phase).toBe('join-read-pending');
    });
  });

  it('does not interpret204 without the canonical phase change as a winning mark', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const port = await factory(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$root-join', createdAt: 20 });
      const readDelta = await delta(f, '$root-join', 'join');
      f.acknowledgeWithoutCommit(true);
      await expect(port.markJoinReadGranted(pending, '$root-join', readDelta)).rejects.toBeDefined();
      expect((await f.source.read(f.roomId, f.ownerContext)).membershipOperation?.phase).toBe('join-read-pending');
    });
  });

  it.each(['add foreign quad', 'change foreign title'] as const)('does not commit a Read phase when native source execution sees %s after precheck', async change => {
    await canonicalInviteFixture(async f => {
      await prepare(f);
      const port = await factory(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), {operationId: '$root-raw-fence', createdAt: 20});
      const readDelta = await delta(f, '$root-raw-fence', 'join');
      const sourceProtocols = f.graph.getQuads(null, null, null, null).find(value => value.predicate.value.endsWith('protocols'));
      if (!sourceProtocols) throw new Error('Fixture protocols are missing');
      f.beforePost(async () => {
        f.beforePost(undefined);
        if (change === 'add foreign quad') {
          f.graph.addQuad(DataFactory.quad(sourceProtocols.subject, DataFactory.namedNode('urn:root:foreign-fence'),
            DataFactory.literal('added after sealed source precheck'), sourceProtocols.graph));
        } else {
          const title = f.graph.getQuads(null, null, null, null).find(value => value.object.termType === 'Literal' && value.object.value === 'unrelated title');
          if (!title) throw new Error('Fixture title is missing');
          f.graph.removeQuad(title);
          f.graph.addQuad(DataFactory.quad(title.subject, title.predicate, DataFactory.literal('changed after sealed source precheck'), title.graph));
        }
      });
      const before = posts(f).length;
      let failure: unknown;
      try { await port.markJoinReadGranted(pending, '$root-raw-fence', readDelta); }
      catch (error) { failure = error; }
      expect(posts(f)).toHaveLength(before + 1);
      // Inspect the actual native result even when the changed foreign RDF makes
      // a later canonical parser fail; that error cannot undo a phase write.
      const rawProtocols = f.graph.getQuads(sourceProtocols.subject, sourceProtocols.predicate, null, sourceProtocols.graph);
      expect(rawProtocols).toHaveLength(1);
      expect(rawProtocols[0].object.termType).toBe('Literal');
      expect(JSON.parse(rawProtocols[0].object.value).matrix.membershipOperation.phase).toBe('join-read-pending');
      expect([409, 503]).toContain((failure as {status?: number} | undefined)?.status);
    });
  });

  it('fails closed when named resolution yields no capability without trying caller bootstrap', async() => {
    await canonicalInviteFixture(async f => {
      await prepare(f); f.requests.length = 0;
      const bootstrap = vi.fn(async(...args: Parameters<typeof f.resolver.readAsCaller>) =>
        await f.resolver.readAsCaller(...args));
      const source = new CanonicalMembershipSource({ canonicalSource: f.source,
        resolver: { resolveForMembership: async() => undefined as never, readAsCaller: bootstrap },
        credentials: f.credentials, podAccess: f.podAccess, issuer: f.issuer });
      await expect(source.openForJoin(f.roomId, f.actorContext)).rejects.toBeDefined();
      expect(bootstrap).not.toHaveBeenCalled();
      expect(f.requests).toEqual([]);
    });
  });
});
