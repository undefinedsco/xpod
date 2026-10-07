import { describe, expect, it } from 'vitest';
import { DataFactory, Writer } from 'n3';
import { proveMembershipEffectiveRead } from '../../../src/api/matrix/membershipReadProof';
import { MembershipPolicyObserver } from '../../../src/api/matrix/membershipPolicyObservation';
import { membershipPolicyFixture } from '../../helpers/MembershipPolicyFixture';

// Unit scope: supported WAC effective Read over the sealed HTTP observation.
// The policy fixture uses counted principal headers, not real DPoP/ACL enforcement.
const ACL = 'http://www.w3.org/ns/auth/acl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const FOAF = 'http://xmlns.com/foaf/0.1/';

async function policyBody(triples: Array<[string, string, string]>): Promise<string> {
  const writer = new Writer();
  for (const [subject, predicate, object] of triples) writer.addQuad(DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate), DataFactory.namedNode(object));
  return await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
}

describe('supported WAC effective Read proof over a sealed observation', () => {
  it('treats an owner-only direct room policy as no Read for the joining actor', async() => {
    await membershipPolicyFixture(async f => {
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      const proof = await proveMembershipEffectiveRead(observation, f.actor);
      expect(proof.noneRead).toBe(true);
      expect(proof.allRead).toBe(false);
      expect(proof.resources.map(row => row.iri)).toEqual(expect.arrayContaining([ f.room, f.documentIri, ...f.historyDocuments ]));
      // Exact opened actor only: the WAC RDF may allow the owner, but a proof for another WebID is
      // not minted from this sealed observation (root decision 5).
      await expect(proveMembershipEffectiveRead(observation, f.owner)).rejects.toMatchObject({ status: 415 });
    });
  });

  it('grants Read everywhere when the actor has an exact accessTo+default Read authorization', async() => {
    await membershipPolicyFixture(async f => {
      const node = `${f.roomPolicy}#actor-read`;
      f.set('GET', f.roomPolicy, { status: 200, body: await policyBody([
        [node, `${RDF}type`, `${ACL}Authorization`], [node, `${ACL}agent`, f.actor],
        [node, `${ACL}accessTo`, f.room], [node, `${ACL}default`, f.room], [node, `${ACL}mode`, `${ACL}Read`],
      ]) });
      const proof = await proveMembershipEffectiveRead(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'), f.actor);
      expect(proof.allRead).toBe(true);
      expect(proof.noneRead).toBe(false);
    });
  });

  it.each([ `${ACL}Control`, `${ACL}Write`, `${ACL}Append` ])('does not treat %s alone as Read', async mode => {
    await membershipPolicyFixture(async f => {
      const node = `${f.roomPolicy}#actor-mode`;
      f.set('GET', f.roomPolicy, { status: 200, body: await policyBody([
        [node, `${RDF}type`, `${ACL}Authorization`], [node, `${ACL}agent`, f.actor],
        [node, `${ACL}accessTo`, f.room], [node, `${ACL}default`, f.room], [node, `${ACL}mode`, mode],
      ]) });
      const proof = await proveMembershipEffectiveRead(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'), f.actor);
      expect(proof.noneRead).toBe(true);
    });
  });

  it('computes a residual public grant as Read', async() => {
    await membershipPolicyFixture(async f => {
      const node = `${f.roomPolicy}#public-read`;
      f.set('GET', f.roomPolicy, { status: 200, body: await policyBody([
        [node, `${RDF}type`, `${ACL}Authorization`], [node, `${ACL}agentClass`, `${FOAF}Agent`],
        [node, `${ACL}accessTo`, f.room], [node, `${ACL}default`, f.room], [node, `${ACL}mode`, `${ACL}Read`],
      ]) });
      const proof = await proveMembershipEffectiveRead(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'), f.actor);
      expect(proof.allRead).toBe(true);
    });
  });

  it('requires the actor agent and the Read mode in the same typed Authorization', async() => {
    await membershipPolicyFixture(async f => {
      const a = `${f.roomPolicy}#agent-only`;
      const b = `${f.roomPolicy}#mode-only`;
      f.set('GET', f.roomPolicy, { status: 200, body: await policyBody([
        [a, `${RDF}type`, `${ACL}Authorization`], [a, `${ACL}agent`, f.actor], [a, `${ACL}accessTo`, f.room], [a, `${ACL}default`, f.room],
        [b, `${RDF}type`, `${ACL}Authorization`], [b, `${ACL}accessTo`, f.room], [b, `${ACL}default`, f.room], [b, `${ACL}mode`, `${ACL}Read`],
      ]) });
      expect((await proveMembershipEffectiveRead(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'), f.actor)).noneRead).toBe(true);
    });
  });

  it('matches full WebIDs without fragment or host normalization', async() => {
    await membershipPolicyFixture(async f => {
      const node = `${f.roomPolicy}#fragment`;
      f.set('GET', f.roomPolicy, { status: 200, body: await policyBody([
        [node, `${RDF}type`, `${ACL}Authorization`], [node, `${ACL}agent`, f.actor.split('#')[0]],
        [node, `${ACL}accessTo`, f.room], [node, `${ACL}default`, f.room], [node, `${ACL}mode`, `${ACL}Read`],
      ]) });
      expect((await proveMembershipEffectiveRead(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'), f.actor)).noneRead).toBe(true);
    });
  });

  it('stops inheritance at a present-empty direct policy', async() => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status: 200, body: '' });
      const proof = await proveMembershipEffectiveRead(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'), f.actor);
      expect(proof.noneRead).toBe(true);
    });
  });

  it('follows the nearest present ancestor default when the direct policy is absent', async() => {
    await membershipPolicyFixture(async f => {
      const ancestor = new URL('../', f.room).href;
      const ancestorPolicy = f.policyFor(ancestor);
      const node = `${ancestorPolicy}#ancestor-read`;
      f.set('GET', f.roomPolicy, { status: 404 });
      f.set('GET', ancestorPolicy, { status: 200, body: await policyBody([
        [node, `${RDF}type`, `${ACL}Authorization`], [node, `${ACL}agent`, f.actor],
        [node, `${ACL}default`, ancestor], [node, `${ACL}mode`, `${ACL}Read`],
      ]) });
      const proof = await proveMembershipEffectiveRead(await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join'), f.actor);
      if (proof.profile !== 'wac-effective-read-v1') throw new Error('Unexpected ACP proof in a WAC-only fixture');
      const room = proof.resources.find(row => row.iri === f.room)!;
      expect(room.inheritedFrom).toBe(ancestor);
      expect(proof.allRead).toBe(true);
    });
  });

  it('rejects a cloned observation as untrusted rather than denied', async() => {
    await membershipPolicyFixture(async f => {
      const observation = await new MembershipPolicyObserver(f.observationOptions).observe(f.roomId, f.actorContext, 'join');
      await expect(proveMembershipEffectiveRead({ ...observation }, f.actor)).rejects.toThrow();
    });
  });
});
