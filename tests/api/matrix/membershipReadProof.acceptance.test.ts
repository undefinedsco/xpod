// Root independent supported-profile proof checks. Counted HTTP/ORM fixture;
// actual CSS authorization is separately exercised by the HTTP corpus.
import { describe, expect, it } from 'vitest';
import { MembershipPolicyObserver } from '../../../src/api/matrix/membershipPolicyObservation';
import { proveMembershipEffectiveRead } from '../../../src/api/matrix/membershipReadProof';
import { membershipPolicyFixture, requireFixtureWacObservation, requireFixtureWacRead } from '../../helpers/MembershipPolicyFixture';

const ACL = 'http://www.w3.org/ns/auth/acl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const FOAF = 'http://xmlns.com/foaf/0.1/Agent';
const authorization = (node: string, room: string, actor: string): string =>
  `<${node}> a <${ACL}Authorization>; <${ACL}accessTo> <${room}>; <${ACL}default> <${room}>;
    <${ACL}agent> <${actor}>; <${ACL}mode> <${ACL}Read> .`;

describe('root sealed membership Read supported-profile boundaries', () => {
  it('rejects an untyped authorization even when the backend matcher would grant Read', async () => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status: 200, body: authorization(`${f.roomPolicy}#untyped`, f.room, f.actor)
        .replace(`a <${ACL}Authorization>;`, '') });
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      expect(observation.coverage).toBe('complete');
      await expect(proveMembershipEffectiveRead(observation, f.actor)).rejects.toMatchObject({ status: 415 });
    });
  });

  it.each([`${ACL}origin`, 'urn:root:requires-condition'])('rejects unsupported condition %s with an explicit unsupported outcome', async predicate => {
    await membershipPolicyFixture(async f => {
      const node = `${f.roomPolicy}#conditional`;
      f.set('GET', f.roomPolicy, { status: 200, body: `${authorization(node, f.room, f.actor)}
        <${node}> <${predicate}> <https://condition.example/> .` });
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      await expect(proveMembershipEffectiveRead(observation, f.actor)).rejects.toMatchObject({ status: 415 });
    });
  });

  it('reports the actual selected inherited ACL, preserving present-empty as a stop', async () => {
    await membershipPolicyFixture(async f => {
      const ancestor = new URL('../', f.room).href;
      const policy = f.policyFor(ancestor);
      f.set('GET', f.roomPolicy, { status: 404 });
      f.set('GET', policy, { status: 200, body: `<${policy}#public> a <${ACL}Authorization>;
        <${ACL}default> <${ancestor}>; <${ACL}agentClass> <${FOAF}>; <${ACL}mode> <${ACL}Read> .` });
      let observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      const proof = requireFixtureWacRead(await proveMembershipEffectiveRead(observation, f.actor));
      expect(proof.allRead).toBe(true);
      expect(proof.resources.every(row => row.policyIri === policy && row.inheritedFrom === ancestor)).toBe(true);
      f.set('GET', f.roomPolicy, { status: 200, body: '' });
      observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      expect((await proveMembershipEffectiveRead(observation, f.actor)).noneRead).toBe(true);
    });
  });

  it('retains the eight-day historical denial without fetching any history bodies', async () => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status: 200, body: authorization(`${f.roomPolicy}#reader`, f.room, f.actor) });
      f.set('GET', f.policyFor(f.historyDocuments[0]), { status: 200, body: '' });
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      const proof = await proveMembershipEffectiveRead(observation, f.actor);
      expect(proof.allRead).toBe(false); expect(proof.noneRead).toBe(false);
      expect(proof.resources.filter(row => !row.read).map(row => row.iri)).toEqual([f.historyDocuments[0]]);
      expect(f.requests.filter(row => row.method === 'GET' && f.historyDocuments.includes(row.url))).toHaveLength(0);
      expect(requireFixtureWacObservation(observation).policies.some(row => row.quads.some(q => q.predicate.value === `${RDF}type`))).toBe(true);
    });
  });
});
