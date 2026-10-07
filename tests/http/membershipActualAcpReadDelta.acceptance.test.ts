// Root-owned independent ACP Read delta + guarded source-phase acceptance.
// Actual CSS/index/SQLite/vault/public ORM with counted principals/Comunica;
// not Gateway DPoP, production QLever, persistent PDU or crash/reconciliation evidence.
import { describe, expect, it } from 'vitest';
import { Parser, Store, type Quad } from 'n3';
import { actualMembershipAcpFixture } from '../helpers/ActualMembershipWacFixture';
import { rootAcpPolicy, expectedGroundDigest } from '../helpers/GuardedPolicyClosureFixture';
import { applyMembershipReadDelta } from '../../src/api/matrix/membershipPolicyMutation';

const ACP = 'http://www.w3.org/ns/solid/acp#';

describe('root actual ACP Read delta and guarded source phases', () => {
  it.each(['absent404', 'present-empty', 'existing custom ACR'] as const)(
    'grants and removes all eight historical days from %s, retaining owner and unrelated policy', async start => {
      await actualMembershipAcpFixture(async f => {
        const other = `${f.origin}carol/profile/card#me`;
        let originalPolicy: Quad[] = [];
        let acr = `${f.roomAcl}#acr`;
        if (start === 'present-empty') await f.putRdf(f.roomAcl, '');
        if (start === 'existing custom ACR') {
          acr = `${f.roomAcl}#custom-acr`;
          const policy = `${rootAcpPolicy(f.roomAcl, f.room, f.owner, ['Read', 'Write', 'Control'])}
            ${rootAcpPolicy(f.roomAcl, f.room, other, ['Read'], { label: 'other-reader' })}
            <${f.roomAcl}#note> <urn:root:preserve> "foreign policy metadata" .`
            .replaceAll(`<${f.roomAcl}#acr>`, `<${acr}>`);
          await f.putRdf(f.roomAcl, policy);
          originalPolicy = await f.policyBody(f.roomAcl);
        }
        const ordinary = [f.room, f.document];
        for (let day = 1; day <= 8; day++) {
          const bucket = `${f.room}2026-09-${String(day).padStart(2, '0')}/`;
          const document = `${bucket}messages.ttl`;
          await f.putContainer(bucket);
          await f.putRdf(document, `<${document}#msg-one> <urn:root:text> "one" .
            <${document}#msg-two> <urn:root:text> "two" .`);
          ordinary.push(bucket, document);
        }
        const head = async (iri: string, principal: string) => {
          const response = await fetch(iri, { method: 'HEAD', headers: { 'x-root-fixture-principal': principal } });
          await response.arrayBuffer(); return response.status;
        };
        for (const iri of ordinary) expect(await head(iri, f.actor)).toBe(403);
        expect(await head(f.document, f.owner)).toBe(200);
        if (start === 'existing custom ACR') expect(await head(ordinary[ordinary.length - 1], other)).toBe(200);

        const join = await f.membership.openForJoin(f.roomId, f.actorContext);
        let state = await join.reserveJoin(await join.readCurrent(), { operationId: '$root-acp-delta-join', createdAt: 20 });
        expect(state.facts.membershipReadGrants?.[f.actor]).not.toHaveProperty('readProfile');
        const reservedParticipants = [...state.facts.participants];
        f.requests.length = 0;
        const granted = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
          { kind: 'join', operationId: '$root-acp-delta-join' });
        expect(f.requests.filter(row => row.method === 'GET')
          .every(row => row.url === f.document || row.url === f.roomAcl)).toBe(true);
        for (const iri of ordinary) expect(await head(iri, f.actor)).toBe(200);
        expect(await head(f.roomAcl, f.actor)).toBe(403);
        expect(await head(f.document, f.owner)).toBe(200);
        expect((await join.readCurrent()).facts.participants).toEqual(reservedParticipants);
        state = await join.markJoinReadGranted(state, '$root-acp-delta-join', granted);
        const installed = state.facts.membershipReadGrants?.[f.actor];
        expect(installed).toMatchObject({ state: 'installed', actorWebId: f.actor,
          sourceIri: f.source, joinOperationId: '$root-acp-delta-join', createdAt: 20,
          policyIri: f.roomAcl, readProfile: 'acp-ground-v1' });
        expect(installed?.authorizationIri?.split('#')).toHaveLength(2);
        const policyAfterJoin = await f.policyBody(f.roomAcl);
        expect(policyAfterJoin.some(q => q.subject.value === acr && q.predicate.value === `${ACP}accessControl`
          && q.object.value === installed?.authorizationIri)).toBe(true);
        expect(policyAfterJoin.some(q => q.subject.value === acr && q.predicate.value === `${ACP}memberAccessControl`
          && q.object.value === installed?.authorizationIri)).toBe(true);
        for (const quad of originalPolicy) expect(policyAfterJoin.some(q => q.equals(quad))).toBe(true);
        await join.completeJoin(state, '$root-acp-delta-join');

        const leave = await f.membership.openForLeave(f.roomId, f.actorContext);
        state = await leave.reserveLeave(await leave.readCurrent(), { operationId: '$root-acp-delta-leave', createdAt: 40 });
        expect(state.facts.participants).toContain(f.actor);
        f.requests.length = 0;
        const removed = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
          { kind: 'leave', operationId: '$root-acp-delta-leave' });
        expect(f.requests.filter(row => row.method === 'GET')
          .every(row => row.url === f.document || row.url === f.roomAcl)).toBe(true);
        for (const iri of ordinary) expect(await head(iri, f.actor)).toBe(403);
        expect(await head(f.document, f.owner)).toBe(200);
        if (start === 'existing custom ACR') expect(await head(ordinary[ordinary.length - 1], other)).toBe(200);
        const remaining = await f.policyBody(f.roomAcl);
        if (start === 'existing custom ACR') {
          expect(expectedGroundDigest(f.roomAcl, remaining, 'acp'))
            .toBe(expectedGroundDigest(f.roomAcl, originalPolicy, 'acp'));
        } else {
          const shell = new Parser().parse(`<${acr}> a <${ACP}AccessControlResource>; <${ACP}resource> <${f.room}> .`);
          expect(expectedGroundDigest(f.roomAcl, remaining, 'acp'))
            .toBe(expectedGroundDigest(f.roomAcl, shell, 'acp'));
        }
        expect(new Store(policyAfterJoin).size - new Store(remaining).size).toBe(9);
        state = await leave.markLeaveReadRemoved(state, '$root-acp-delta-leave', removed);
        expect(state.facts.participants).toContain(f.actor);
        state = await leave.commitLeaveRoster(state, '$root-acp-delta-leave');
        expect(state.facts.participants).toEqual([f.owner]);
        const current = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
        expect(current.protocols.foreign).toEqual({ value: 'retain' });
        await leave.completeLeave(state, '$root-acp-delta-leave');
      });
    });
});
