import { describe, expect, it } from 'vitest';
import { actualMembershipWacFixture } from '../helpers/ActualMembershipWacFixture';
import { applyMembershipReadDelta } from '../../src/api/matrix/membershipPolicyMutation';

describe('root actual CSS ACL delta and guarded membership phase', () => {
  it('grants and removes whole-history Read through actual policy writes, preserving owner and pending roster', async () => {
    await actualMembershipWacFixture(async f => {
      const histories: string[] = [];
      for (let day = 1; day <= 8; day++) {
        const bucket = `${f.room}2026-09-${String(day).padStart(2, '0')}/`;
        await f.putContainer(bucket);
        const document = `${bucket}events.ttl`;
        await f.putRdf(document, '<urn:root:history> <urn:root:value> "old" .');
        histories.push(document);
      }
      const status = async (iri: string, principal = f.actor) => {
        const response = await fetch(iri, { method: 'HEAD', headers: { 'x-root-fixture-principal': principal } });
        await response.text(); return response.status;
      };
      expect(await status(f.document)).toBe(403);
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      let state = await join.reserveJoin(await join.readCurrent(), { operationId: '$root-actual-join', createdAt: 20 });
      const granted = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-actual-join' });
      for (const iri of [f.room, f.document, ...histories]) expect(await status(iri)).toBe(200);
      expect(await status(f.roomAcl, f.owner)).toBe(200);
      state = await join.markJoinReadGranted(state, '$root-actual-join', granted);
      await join.completeJoin(state, '$root-actual-join');
      const leave = await f.membership.openForLeave(f.roomId, f.actorContext);
      state = await leave.reserveLeave(await leave.readCurrent(), { operationId: '$root-actual-leave', createdAt: 40 });
      expect(state.facts.participants).toContain(f.actor);
      const removed = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'leave', operationId: '$root-actual-leave' });
      for (const iri of [f.room, f.document, ...histories]) expect(await status(iri)).toBe(403);
      expect(await status(f.roomAcl, f.owner)).toBe(200);
      state = await leave.markLeaveReadRemoved(state, '$root-actual-leave', removed);
      expect(state.facts.participants).toContain(f.actor);
      state = await leave.commitLeaveRoster(state, '$root-actual-leave');
      expect(state.facts.participants).toEqual([f.owner]);
      await leave.completeLeave(state, '$root-actual-leave');
    });
  });
});

// Each negative mutates an actual indexed CSS resource after the sealed proof,
// then checks authorization and the guarded phase's physical native effects.
describe('root actual CSS postflight and residual Read boundaries', () => {
  const ACL = 'http://www.w3.org/ns/auth/acl#';
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  it.each(['policy', 'new historical descendant'] as const)('rejects a phase receipt after %s changes', async changed => {
    await actualMembershipWacFixture(async f => {
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      const pending = await join.reserveJoin(await join.readCurrent(), { operationId: '$root-postflight-join', createdAt: 20 });
      const proof = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-postflight-join' });
      const { DataFactory, Parser } = await import('n3');
      let denied = f.document;
      if (changed === 'policy') {
        const policy = await f.policyBody(f.roomAcl);
        const actorNodes = new Set(policy.filter(q => q.predicate.value === `${ACL}agent` && q.object.value === f.actor)
          .map(q => q.subject.value));
        await f.indexedPut(f.roomAcl, policy.filter(q => !actorNodes.has(q.subject.value)));
      } else {
        const bucket = `${f.room}2026-09-09/`;
        await f.putContainer(bucket);
        denied = `${bucket}events.ttl`;
        await f.indexedPut(denied, new Parser().parse('<urn:root:late> <urn:root:value> "late" .'));
        const policyIri = `${denied}.acl`;
        const grant = DataFactory.namedNode(`${policyIri}#owner`);
        await f.indexedPut(policyIri, [
          DataFactory.quad(grant, DataFactory.namedNode(`${RDF}type`), DataFactory.namedNode(`${ACL}Authorization`)),
          DataFactory.quad(grant, DataFactory.namedNode(`${ACL}agent`), DataFactory.namedNode(f.owner)),
          DataFactory.quad(grant, DataFactory.namedNode(`${ACL}accessTo`), DataFactory.namedNode(denied)),
          DataFactory.quad(grant, DataFactory.namedNode(`${ACL}mode`), DataFactory.namedNode(`${ACL}Read`)),
        ]);
      }
      const response = await fetch(denied, { method: 'HEAD', headers: { 'x-root-fixture-principal': f.actor } });
      await response.text(); expect(response.status).toBe(403);
      const before = f.native.mock.calls.length;
      await expect(join.markJoinReadGranted(pending, '$root-postflight-join', proof)).rejects.toMatchObject({ status: 409 });
      expect(f.native.mock.calls.length).toBe(before);
      expect((await join.readCurrent()).facts.membershipOperation?.phase).toBe('join-read-pending');
    });
  });

  it('keeps leave pending when a separate public grant still gives actual content Read', async () => {
    await actualMembershipWacFixture(async f => {
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      let state = await join.reserveJoin(await join.readCurrent(), { operationId: '$root-public-join', createdAt: 20 });
      const proof = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-public-join' });
      state = await join.markJoinReadGranted(state, '$root-public-join', proof);
      await join.completeJoin(state, '$root-public-join');
      const { DataFactory } = await import('n3');
      const node = DataFactory.namedNode(`${f.roomAcl}#independent-public`);
      const extra = [
        DataFactory.quad(node, DataFactory.namedNode(`${RDF}type`), DataFactory.namedNode(`${ACL}Authorization`)),
        DataFactory.quad(node, DataFactory.namedNode(`${ACL}agentClass`), DataFactory.namedNode('http://xmlns.com/foaf/0.1/Agent')),
        DataFactory.quad(node, DataFactory.namedNode(`${ACL}accessTo`), DataFactory.namedNode(f.room)),
        DataFactory.quad(node, DataFactory.namedNode(`${ACL}default`), DataFactory.namedNode(f.room)),
        DataFactory.quad(node, DataFactory.namedNode(`${ACL}mode`), DataFactory.namedNode(`${ACL}Read`)),
      ];
      await f.indexedPut(f.roomAcl, [...await f.policyBody(f.roomAcl), ...extra]);
      const leave = await f.membership.openForLeave(f.roomId, f.actorContext);
      await leave.reserveLeave(await leave.readCurrent(), { operationId: '$root-public-leave', createdAt: 40 });
      await expect(applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'leave', operationId: '$root-public-leave' })).rejects.toMatchObject({ status: 409 });
      const current = await leave.readCurrent();
      expect(current.facts.membershipOperation?.phase).toBe('leave-read-pending');
      expect(current.facts.participants).toContain(f.actor);
      const actual = await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': f.actor } });
      await actual.text(); expect(actual.status).toBe(200);
      const retained = await f.policyBody(f.roomAcl);
      for (const quad of extra) expect(retained.some(q => q.equals(quad))).toBe(true);
    });
  });
});
