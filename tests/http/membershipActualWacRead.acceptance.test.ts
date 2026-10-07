// Root's independent HTTP oracle uses real CSS authorization and both production
// concrete/public WAC checkers. Fixture credentials do not prove Gateway DPoP.
import { describe, expect, it } from 'vitest';
import { guardedPolicyClosureFixture } from '../helpers/GuardedPolicyClosureFixture';

const ACL = 'http://www.w3.org/ns/auth/acl#';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
function rule(policy: string, id: string, predicate: 'accessTo' | 'default', target: string,
  agent: string, mode = 'Read', publicAgent = false): string {
  return `<${policy}#${id}> a <${ACL}Authorization>; <${ACL}${predicate}> <${target}>;
    <${ACL}${publicAgent ? 'agentClass' : 'agent'}> <${agent}>; <${ACL}mode> <${ACL}${mode}> .`;
}
async function head(iri: string, actor: string): Promise<number> {
  const response = await fetch(iri, { method: 'HEAD', headers: { 'x-root-fixture-principal': actor } });
  await response.text(); return response.status;
}

describe('root actual CSS effective WAC Read corpus', () => {
  it('inherits actual public Read until a present empty policy stops inheritance', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n${rule(f.podAcl, 'public', 'default', f.pod, FOAF_AGENT, 'Read', true)}`);
      expect(await head(f.document, actor)).toBe(200);
      await f.putRdf(f.roomAcl, '');
      expect(await head(f.room, actor)).toBe(403);
      expect(await head(f.document, actor)).toBe(403);
      expect((await f.readClosure()).policies.find(p => p.iri === f.roomAcl)?.state).toBe('present-empty');
    });
  });

  it.each([ 'accessTo', 'default' ] as const)('distinguishes direct and inherited %s', async predicate => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      await f.putRdf(f.roomAcl, rule(f.roomAcl, 'reader', predicate, f.room, actor));
      expect(await head(f.room, actor)).toBe(predicate === 'accessTo' ? 200 : 403);
      expect(await head(f.document, actor)).toBe(predicate === 'default' ? 200 : 403);
    });
  });

  it('stops at a nearer present nonmatching default instead of taking a farther public grant', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n${rule(f.podAcl, 'public', 'default', f.pod, FOAF_AGENT, 'Read', true)}`);
      await f.putRdf(f.roomAcl, rule(f.roomAcl, 'wrong-container', 'default', `${f.room}other/`, actor));
      expect(await head(f.document, actor)).toBe(403);
    });
  });

  it('allows a child with its own direct Read while its parent remains unreadable', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      await f.putRdf(f.roomAcl, '');
      const policy = f.policyIri(f.document);
      await f.putRdf(policy, rule(policy, 'child-reader', 'accessTo', f.document, actor));
      expect(await head(f.room, actor)).toBe(403);
      expect(await head(f.document, actor)).toBe(200);
    });
  });

  it('uses the complete WebID including the fragment', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      const policy = f.policyIri(f.document);
      await f.putRdf(policy, rule(policy, 'exact-reader', 'accessTo', f.document, actor));
      expect(await head(f.document, actor)).toBe(200);
      expect(await head(f.document, `${f.pod}profile/card#other`)).toBe(403);
      expect(await head(f.document, `${f.pod}profile/card`)).toBe(403);
    });
  });

  it('does not combine an actor and Read from different authorizations', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      const policy = f.policyIri(f.document);
      await f.putRdf(policy, `${rule(policy, 'actor-write', 'accessTo', f.document, actor, 'Write')}\n${rule(policy, 'other-read', 'accessTo', f.document, f.owner)}`);
      expect(await head(f.document, actor)).toBe(403);
    });
  });

  it('distinguishes Control on an auxiliary ACL from Read on ordinary content', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#controller`;
      const policy = f.policyIri(f.document);
      await f.putRdf(policy, rule(policy, 'controller', 'accessTo', f.document, actor, 'Control'));
      expect(await head(f.document, actor)).toBe(403);
      expect(await head(policy, actor)).toBe(200);
    });
  });

  it('retains actual residual public Read after a named grant is removed', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      const policy = f.policyIri(f.document);
      const publicRule = rule(policy, 'public', 'accessTo', f.document, FOAF_AGENT, 'Read', true);
      await f.putRdf(policy, `${publicRule}\n${rule(policy, 'named', 'accessTo', f.document, actor)}`);
      expect(await head(f.document, actor)).toBe(200);
      await f.putRdf(policy, publicRule);
      expect(await head(f.document, actor)).toBe(200);
    });
  });

  it('finds a real denied history document beyond a seven-day window', async () => {
    await guardedPolicyClosureFixture(async f => {
      const actor = `${f.pod}profile/card#reader`;
      await f.putRdf(f.podAcl, `${f.ownerPolicy}\n${rule(f.podAcl, 'public', 'default', f.pod, FOAF_AGENT, 'Read', true)}`);
      const documents: string[] = [];
      for (let day = 1; day <= 8; day++) {
        const container = `${f.room}2026-09-${String(day).padStart(2, '0')}/`;
        await f.putContainer(container);
        const document = `${container}events.ttl`;
        await f.putRdf(document, '<urn:root:history> <urn:root:value> "old" .');
        documents.push(document);
      }
      await f.putRdf(f.policyIri(documents[0]), '');
      for (const document of documents.slice(1)) expect(await head(document, actor)).toBe(200);
      expect(await head(documents[0], actor)).toBe(403);
      const closure = await f.readClosure();
      expect(documents.every(document => closure.resources.some(r => r.iri === document))).toBe(true);
    });
  });
});
