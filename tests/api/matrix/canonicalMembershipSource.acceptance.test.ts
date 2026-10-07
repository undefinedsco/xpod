import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { chatResource } from '@undefineds.co/models';
import { CanonicalMembershipSource } from '../../../src/api/matrix/canonicalMembershipSource';
import { MembershipLifecycle, type MembershipInviteProjectEvent } from '../../../src/api/matrix/membershipLifecycle';
import type { MembershipOperation } from '../../../src/api/matrix/membershipOperation';
import type { MatrixEventRecord } from '../../../src/api/matrix/types';
import { canonicalInviteFixture } from '../../helpers/CanonicalInviteFixture';

type Fixture = Parameters<Parameters<typeof canonicalInviteFixture>[0]>[0];
const sourceFor = (f: Fixture) => new CanonicalMembershipSource({ canonicalSource: f.source,
  resolver: f.resolver, credentials: f.credentials, podAccess: f.podAccess, issuer: f.issuer });
const lifecycleFor = (f: Fixture, id = '$root-invite-first') => new MembershipLifecycle({
  source: sourceFor(f), now: () => 1790985600000, eventId: () => id,
});
const recordFor = (roomId: string, operation: Readonly<MembershipOperation>): MatrixEventRecord => ({
  eventId: operation.operationId, roomId, type: 'm.room.member', sender: operation.actor.webId,
  originServerTs: operation.event.createdAt, stateKey: operation.targetWebId,
  content: { ...operation.event.content }, event: { event_id: operation.operationId, room_id: roomId,
    type: 'm.room.member', sender: operation.actor.webId, origin_server_ts: operation.event.createdAt,
    state_key: operation.targetWebId, content: { ...operation.event.content }, prev_events: [ '$first-parent' ] },
});
const posts = (f: Fixture) => f.requests.filter(r => r.method === 'POST');
function changeProtocols(f: Fixture, transform: (protocols: any) => any): void {
  const old = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
  if (old.object.termType !== 'Literal') throw new Error('Fixture protocol is not a literal');
  f.graph.removeQuad(old);
  f.graph.addQuad(DataFactory.quad(old.subject, old.predicate,
    DataFactory.literal(JSON.stringify(transform(JSON.parse(old.object.value))), old.object.datatype), old.graph));
}

/** Real loopback HTTP + ORM/RDF + SQLite/vault. Projection callbacks do not prove actor-Pod persistence. */
describe('root independent invite source foundation', () => {
  it('separates Bob actor from Alice source transport and preserves all non-protocol RDF', async() => {
    await canonicalInviteFixture(async f => {
      await f.resolver.readAsCaller(f.roomId, f.actorContext);
      const before = f.graph.getQuads(null, null, null, null).filter(q => !q.predicate.value.endsWith('protocols'));
      const project = vi.fn<Parameters<MembershipInviteProjectEvent>, ReturnType<MembershipInviteProjectEvent>>(async input => {
        expect(input.actor.webId).toBe(f.actor); expect(input.actor.podUrl).toBe(f.actorPodUrl);
        expect(input.actor.service).toBeUndefined(); expect((input as any).fetch).toBeUndefined();
        expect(input.existingOnly).toBe(false);
        const record = recordFor(input.roomId, input.operation);
        await input.validateCommitted(record); return record;
      });
      const result = await lifecycleFor(f).invite(f.roomId, f.target, f.actorContext, project);
      expect(result.kind).toBe('invited'); expect(project).toHaveBeenCalledOnce();
      expect(posts(f)).toHaveLength(2);
      expect(posts(f).every(r => r.url === f.endpoint && r.principal === f.owner)).toBe(true);
      for (const q of before) expect(f.graph.has(q)).toBe(true);
      const current = await f.source.readSnapshot(f.roomId, f.ownerContext);
      expect(current.facts.participants).toEqual(expect.arrayContaining([ f.owner, f.actor ]));
      expect(current.facts.participants).not.toContain(f.target);
      expect(current.facts.memberRoles[f.target]).toBeUndefined();
      expect(current.facts.membershipOperation).toMatchObject({ phase: 'complete', actor: { webId: f.actor },
        targetWebId: f.target, authority: f.binding });
      expect(current.protocols.foreign).toEqual({ value: 'retain' });
      expect(f.requests.every(r => r.url === f.documentIri || r.url === f.endpoint)).toBe(true);
    });
  });

  it.each([ 'absent', 'empty' ] as const)('keeps %s root roles in author-only unbound invite', async roles => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false, roles });
      await lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext, async input => recordFor(input.roomId, input.operation));
      const current = await f.source.readSnapshot(f.roomId, f.ownerContext);
      expect(current.facts.membershipOperation?.authority).toBeNull();
      expect(current.facts.membershipOperation?.expected.memberRoles).toEqual(roles === 'absent' ? null : {});
      expect(posts(f).every(r => r.principal === f.owner)).toBe(true);
    });
  });

  it('rejects forged and cross-port expected evidence without a physical source write', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false });
      const source = sourceFor(f);
      const left = await source.open(f.roomId, f.ownerContext);
      const right = await source.open(f.roomId, f.ownerContext);
      const evidence = await left.readCurrent();
      const intent = { operationId: '$root-sealed', createdAt: 1, targetWebId: f.target };
      await expect(right.reserveInvite(evidence, intent)).rejects.toMatchObject({ status: 409 });
      await expect(left.reserveInvite({ facts: structuredClone(evidence.facts) }, intent)).rejects.toMatchObject({ status: 409 });
      expect(Object.isFrozen(evidence.facts.participants)).toBe(true);
      expect(posts(f)).toEqual([]);
    });
  });

  it('does not accept204 without the canonical intention in strict readback', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false }); f.acknowledgeWithoutCommit(true);
      const project = vi.fn<Parameters<MembershipInviteProjectEvent>, ReturnType<MembershipInviteProjectEvent>>();
      await expect(lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext, project)).rejects.toMatchObject({ status: 409 });
      expect(posts(f)).toHaveLength(1); expect(project).not.toHaveBeenCalled();
      expect((await f.source.read(f.roomId, f.ownerContext)).membershipOperation).toBeUndefined();
    });
  });

  it('rejects a second actual HTTP CAS using another port frozen before the first winner', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false });
      const factory = sourceFor(f);
      const left = await factory.open(f.roomId, f.ownerContext);
      const right = await factory.open(f.roomId, f.ownerContext);
      const leftEvidence = await left.readCurrent();
      const rightEvidence = await right.readCurrent();
      await left.reserveInvite(leftEvidence, { operationId: '$left', createdAt: 1, targetWebId: f.target });
      await expect(right.reserveInvite(rightEvidence, { operationId: '$right', createdAt: 2,
        targetWebId: `${f.issuer}other/card#me` })).rejects.toMatchObject({ status: 409 });
      expect(posts(f)).toHaveLength(2);
      const current = await f.source.read(f.roomId, f.ownerContext);
      expect(current.membershipOperation?.operationId).toBe('$left');
      expect(current.membershipInvitations?.[`${f.issuer}other/card#me`]).toBeUndefined();
    });
  });

  it('recovers a committed source intention after lost HTTP response and service reopen', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false }); f.losePostResponse(true);
      await expect(lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext,
        async() => { throw new Error('Actor projection unavailable'); })).rejects.toMatchObject({ status: 409 });
      const committed = await f.source.read(f.roomId, f.ownerContext);
      expect(committed.membershipOperation).toMatchObject({ operationId: '$root-invite-first', phase: 'committed' });
      f.losePostResponse(false);
      const resumed = await lifecycleFor(f, '$must-not-replace').invite(f.roomId, f.target, f.ownerContext,
        async input => recordFor(input.roomId, input.operation));
      expect(resumed.kind).toBe('invited');
      if (resumed.kind === 'invited') {
        expect(resumed.event.eventId).toBe('$root-invite-first');
        expect(resumed.event.originServerTs).toBe(1790985600000);
        expect(resumed.event.event?.prev_events).toEqual([ '$first-parent' ]);
      }
      expect((await f.source.read(f.roomId, f.ownerContext)).membershipOperation?.phase).toBe('complete');
    });
  });

  it('rebuilds discarded locator state through a current legal caller before named effects', async() => {
    await canonicalInviteFixture(async f => {
      // No seed readAsCaller: an empty cache cannot become required authority truth.
      await f.locator.wipe();
      await lifecycleFor(f).invite(f.roomId, f.target, f.actorContext,
        async input => recordFor(input.roomId, input.operation));
      expect(await f.locator.find(f.sourceIri)).toMatchObject({ ownerWebId: f.owner, binding: f.binding });
      expect(posts(f).every(r => r.principal === f.owner)).toBe(true);
    });
  });

  it('retains the invitation and slot when a later call already has the target invited', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false });
      await lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext, async input => recordFor(input.roomId, input.operation));
      const before = f.graph.getQuads(null, null, null, null);
      f.requests.length = 0;
      const unavailablePrivatePdu = vi.fn<Parameters<MembershipInviteProjectEvent>, ReturnType<MembershipInviteProjectEvent>>(async() => { throw new Error('Private old actor event'); });
      await expect(lifecycleFor(f, '$different').invite(f.roomId, f.target, f.ownerContext, unavailablePrivatePdu))
        .resolves.toEqual({ kind: 'already-invited' });
      expect(unavailablePrivatePdu).not.toHaveBeenCalled(); expect(posts(f)).toEqual([]);
      for (const q of before) expect(f.graph.has(q)).toBe(true);
    });
  });

  it('replaces a complete control slot without reading or confirming its private old PDU', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false });
      await lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext, async input => recordFor(input.roomId, input.operation));
      f.requests.length = 0;
      const verify = vi.fn<Parameters<MembershipInviteProjectEvent>, ReturnType<MembershipInviteProjectEvent>>(async input => {
        expect(input.existingOnly).toBe(false);
        expect(input.operation.operationId).toBe('$different');
        return recordFor(input.roomId, input.operation);
      });
      await expect(lifecycleFor(f, '$different').invite(f.roomId, `${f.issuer}other/card#me`, f.ownerContext, verify))
        .resolves.toMatchObject({ kind: 'invited' });
      expect(verify).toHaveBeenCalledOnce();
      expect(posts(f)).toHaveLength(2);
      const current = await f.source.read(f.roomId, f.ownerContext);
      expect(current.membershipOperation?.operationId).toBe('$different');
      expect(current.membershipInvitations?.[f.target]?.id).toBe('$root-invite-first');
      expect(f.requests.every(request => request.url === f.documentIri || request.url === f.endpoint)).toBe(true);
    });
  });

  it('does not journal a projection after its current canonical intention changes', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false });
      let journal = 0;
      const project: MembershipInviteProjectEvent = async input => {
        changeProtocols(f, protocols => ({ ...protocols, matrix: { ...protocols.matrix,
          membershipOperation: { ...protocols.matrix.membershipOperation, operationId: '$concurrent-other' } } }));
        const record = recordFor(input.roomId, input.operation);
        await input.validateCommitted(record);
        journal++; return record;
      };
      await expect(lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext, project)).rejects.toBeDefined();
      expect(journal).toBe(0);
    });
  });

  it('checks current named lease before allowing projection journal effects', async() => {
    await canonicalInviteFixture(async f => {
      await f.resolver.readAsCaller(f.roomId, f.actorContext);
      let journal = 0;
      const project: MembershipInviteProjectEvent = async input => {
        await f.credentials.revoke(f.binding.credentialRef);
        await input.validateCommitted(recordFor(input.roomId, input.operation));
        journal++; return recordFor(input.roomId, input.operation);
      };
      await expect(lifecycleFor(f).invite(f.roomId, f.target, f.actorContext, project)).rejects.toBeDefined();
      expect(journal).toBe(0);
    });
  });

  it('does not project an absent-role intention after RDF changes to present-empty roles', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false, roles: 'absent' });
      const port = await sourceFor(f).open(f.roomId, f.ownerContext);
      const evidence = await port.reserveInvite(await port.readCurrent(),
        { operationId: '$root-absent', createdAt: 1, targetWebId: f.target });
      expect(evidence.facts.membershipOperation?.expected.memberRoles).toBeNull();
      const protocol = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
      f.graph.addQuad(DataFactory.quad(protocol.subject,
        DataFactory.namedNode(protocol.predicate.value.replace(/protocols$/, 'memberRoles')),
        DataFactory.literal('{}', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')), protocol.graph));
      const project = vi.fn<Parameters<MembershipInviteProjectEvent>, ReturnType<MembershipInviteProjectEvent>>(async input => recordFor(input.roomId, input.operation));
      await expect(lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext, project)).rejects.toMatchObject({ status: 409 });
      expect(project).not.toHaveBeenCalled();
    });
  });

  it('rejects changed roster in the complete CAS readback window', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false });
      f.afterPost(async() => {
        const protocol = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
        if (JSON.parse(protocol.object.value).matrix.membershipOperation.phase === 'complete') {
          const predicate = chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace);
          f.graph.removeQuads(f.graph.getQuads(DataFactory.namedNode(f.sourceIri), DataFactory.namedNode(predicate),
            DataFactory.namedNode(f.owner), null));
        }
      });
      await expect(lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext,
        async input => recordFor(input.roomId, input.operation))).rejects.toMatchObject({ status: 409 });
    });
  });

  it('rejects stale complete evidence after actor roster removal without another source write', async() => {
    await canonicalInviteFixture(async f => {
      await f.reset({ named: false });
      await lifecycleFor(f).invite(f.roomId, f.target, f.ownerContext,
        async input => recordFor(input.roomId, input.operation));
      const port = await sourceFor(f).open(f.roomId, f.ownerContext);
      const evidence = await port.readCurrent();
      const predicate = chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace);
      f.graph.removeQuads(f.graph.getQuads(DataFactory.namedNode(f.sourceIri), DataFactory.namedNode(predicate),
        DataFactory.namedNode(f.owner), null));
      f.requests.length = 0;
      await expect(port.completeInvite(evidence, '$root-invite-first')).rejects.toMatchObject({ status: 409 });
      expect(posts(f)).toEqual([]);
    });
  });
});
