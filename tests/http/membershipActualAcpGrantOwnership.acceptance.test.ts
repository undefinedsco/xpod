// Root-owned actual CSS ownership counterexamples. Every negative first calibrates
// the genuine ACP join; counted principals/Comunica are not GatewayDPoP/QLever.
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { actualMembershipAcpFixture } from '../helpers/ActualMembershipWacFixture';
import { expectedGroundDigest } from '../helpers/GuardedPolicyClosureFixture';
import { applyMembershipReadDelta } from '../../src/api/matrix/membershipPolicyMutation';
import { MembershipPolicyObserver, compileMembershipPolicyGuard, executeMembershipGuardedCas }
  from '../../src/api/matrix/membershipPolicyObservation';
import { grantAuthorizationIri } from '../../src/api/matrix/membershipReadGrant';

type Fixture = Parameters<Parameters<typeof actualMembershipAcpFixture>[0]>[0];
const ACP = 'http://www.w3.org/ns/solid/acp#';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const { namedNode: n, quad: q } = DataFactory;
async function head(f: Fixture): Promise<number> {
  const response = await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': f.actor } });
  await response.arrayBuffer(); return response.status;
}
async function installedJoin(f: Fixture) {
  const join = await f.membership.openForJoin(f.roomId, f.actorContext);
  let state = await join.reserveJoin(await join.readCurrent(), { operationId: '$root-acp-owned-join', createdAt: 20 });
  const proof = await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
    { kind: 'join', operationId: '$root-acp-owned-join' });
  expect(await head(f)).toBe(200);
  state = await join.markJoinReadGranted(state, '$root-acp-owned-join', proof);
  const grant = state.facts.membershipReadGrants?.[f.actor];
  expect(grant).toMatchObject({ state: 'installed', readProfile: 'acp-ground-v1' });
  if (!grant?.authorizationIri) throw new Error('Root positive calibration has no installed grant root');
  await join.completeJoin(state, '$root-acp-owned-join');
  return grant;
}
async function changeInstalledRecord(f: Fixture, change: (record: Record<string, unknown>) => void) {
  const snapshot = await f.canonicalSource.readSnapshot(f.roomId, f.ownerContext);
  const observation = await new MembershipPolicyObserver(f.options).observe(f.roomId, f.actorContext, 'leave');
  expect(observation.coverage).toBe('complete');
  const protocols = JSON.parse(JSON.stringify(snapshot.protocols));
  change(protocols.matrix.membershipReadGrants[f.actor]);
  await executeMembershipGuardedCas(compileMembershipPolicyGuard(observation), { protocols });
}
async function expectUnmodifiedLeave(f: Fixture, allowedStatuses = [415]) {
  const leave = await f.membership.openForLeave(f.roomId, f.actorContext);
  await leave.reserveLeave(await leave.readCurrent(), { operationId: '$root-acp-owned-leave', createdAt: 40 });
  const before = await f.policyBody(f.roomAcl);
  f.native.mockClear();
  let failure: unknown;
  try { await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
    { kind: 'leave', operationId: '$root-acp-owned-leave' }); }
  catch (error) { failure = error; }
  expect(f.native).not.toHaveBeenCalled();
  expect(failure).toBeDefined();
  expect(allowedStatuses).toContain((failure as { status: number }).status);
  expect(expectedGroundDigest(f.roomAcl, await f.policyBody(f.roomAcl), 'acp'))
    .toBe(expectedGroundDigest(f.roomAcl, before, 'acp'));
  const state = await leave.readCurrent();
  expect(state.facts.membershipOperation?.phase).toBe('leave-read-pending');
  expect(state.facts.participants).toContain(f.actor);
  expect(await head(f)).toBe(200);
}

describe('root actual ACP grant ownership and explicit profile', () => {
  it('does not adopt byte-identical policy nodes on a second reserved-join attempt', async () => {
    await actualMembershipAcpFixture(async f => {
      const join = await f.membership.openForJoin(f.roomId, f.actorContext);
      await join.reserveJoin(await join.readCurrent(), { operationId: '$root-acp-collision', createdAt: 20 });
      await applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-acp-collision' });
      expect(await head(f)).toBe(200);
      expect((await join.readCurrent()).facts.membershipReadGrants?.[f.actor]?.state).toBe('reserved');
      const before = await f.policyBody(f.roomAcl);
      f.native.mockClear();
      await expect(applyMembershipReadDelta(f.options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-acp-collision' })).rejects.toMatchObject({ status: 415 });
      expect(f.native).not.toHaveBeenCalled();
      expect(expectedGroundDigest(f.roomAcl, await f.policyBody(f.roomAcl), 'acp'))
        .toBe(expectedGroundDigest(f.roomAcl, before, 'acp'));
      expect((await join.readCurrent()).facts.membershipOperation?.phase).toBe('join-read-pending');
      expect(await head(f)).toBe(200);
    });
  });

  it.each(['extra Write', 'extra agent', 'foreign incoming reference'] as const)(
    'preserves an installed grant with %s and refuses removal before native effects', async changed => {
      await actualMembershipAcpFixture(async f => {
        const grant = await installedJoin(f);
        const before = await f.policyBody(f.roomAcl);
        const policy = before.find(row => row.subject.value === grant.authorizationIri && row.predicate.value === `${ACP}apply`)?.object;
        expect(policy?.termType).toBe('NamedNode');
        const matcher = before.find(row => row.subject.value === policy!.value && row.predicate.value === `${ACP}anyOf`)?.object;
        expect(matcher?.termType).toBe('NamedNode');
        const extra = changed === 'extra Write' ? q(n(policy!.value), n(`${ACP}allow`), n(`${ACL}Write`))
          : changed === 'extra agent' ? q(n(matcher!.value), n(`${ACP}agent`), n(`${f.origin}carol/profile/card#me`))
          : q(n(`${f.roomAcl}#external-note`), n('urn:root:borrowed-authority'), n(grant.authorizationIri!));
        await f.indexedPut(f.roomAcl, [...before, extra]);
        expect(await head(f)).toBe(200);
        await expectUnmodifiedLeave(f);
      });
    });

  it.each(['wac-ground-v1', 'missing legacy profile'] as const)(
    'does not interpret %s as an ACP installed grant', async changed => {
      await actualMembershipAcpFixture(async f => {
        await installedJoin(f);
        await changeInstalledRecord(f, grant => {
          if (changed === 'missing legacy profile') delete grant.readProfile;
          else grant.readProfile = changed;
        });
        expect(await head(f)).toBe(200);
        await expectUnmodifiedLeave(f, [409, 415]);
      });
    });

  it('does not delete a same-shape foreign grant by trusting a corrupted installed pointer', async () => {
    await actualMembershipAcpFixture(async f => {
      const grant = await installedJoin(f);
      const before = await f.policyBody(f.roomAcl);
      const root = grant.authorizationIri!;
      const policy = before.find(row => row.subject.value === root && row.predicate.value === `${ACP}apply`)?.object.value;
      const matcher = before.find(row => row.subject.value === policy && row.predicate.value === `${ACP}anyOf`)?.object.value;
      if (!policy || !matcher) throw new Error('Root positive calibration lost its policy/matcher');
      const foreign = grantAuthorizationIri(f.roomAcl, f.actor, '$root-foreign-join', f.source);
      const mapping = new Map([[root, foreign], [policy, `${foreign}-policy`], [matcher, `${foreign}-matcher`]]);
      const owned = before.filter(row => mapping.has(row.subject.value)
        || (row.object.termType === 'NamedNode' && row.object.value === root
          && [ `${ACP}accessControl`, `${ACP}memberAccessControl` ].includes(row.predicate.value)));
      expect(owned).toHaveLength(9);
      const foreignQuads = owned.map(row => q(n(mapping.get(row.subject.value) ?? row.subject.value), row.predicate,
        row.object.termType === 'NamedNode' ? n(mapping.get(row.object.value) ?? row.object.value) : row.object));
      await f.indexedPut(f.roomAcl, [...before, ...foreignQuads]);
      await changeInstalledRecord(f, record => { record.authorizationIri = foreign; });
      expect(await head(f)).toBe(200);
      await expectUnmodifiedLeave(f, [409, 415]);
    });
  });
});
