// Root independent actual CSS GET/HEAD/WAC/output serialization against the
// server closure's actual inventory. Fixed fixture identity is not DPoP.
import { describe, expect, it } from 'vitest';
import { parseLinkHeader } from '@solid/community-server';
import { Parser } from 'n3';
import { guardedPolicyClosureFixture } from '../helpers/GuardedPolicyClosureFixture';

const ACL = 'http://www.w3.org/ns/auth/acl#';
const contains = (iri: string, body: string): string[] => [...new Set(new Parser({ baseIRI: iri }).parse(body)
  .filter(q => q.subject.value === iri && q.predicate.value === 'http://www.w3.org/ns/ldp#contains')
  .map(q => q.object.value))].sort();

describe('root actual CSS container listing and guarded inventory equivalence', () => {
  it('serializes the complete normal direct children and excludes actual auxiliary resources', async () => {
    await guardedPolicyClosureFixture(async f => {
      const history = `${f.room}history.ttl`;
      const empty = `${f.room}empty/`;
      await f.putRdf(history, '<urn:root:history> <urn:root:value> "old" .');
      await f.putContainer(empty);
      await f.putRdf(f.roomAcl, f.ownerPolicy.replaceAll(f.podAcl, f.roomAcl).replaceAll(`<${f.pod}>`, `<${f.room}>`));
      await f.putRdf(`${history}.meta`, '<urn:root:metadata> <urn:root:value> "aux" .');
      const response = await fetch(f.room);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/turtle/u);
      const children = contains(f.room, await response.text());
      expect(children).toEqual([ f.document, history, empty ].sort());
      expect(children).not.toContain(f.roomAcl); expect(children).not.toContain(`${history}.meta`);
      const closure = await f.readClosure();
      expect(closure.resources.find(r => r.iri === f.room)?.children).toEqual(children);
      expect(closure.resources.find(r => r.iri === empty)).toMatchObject({ container: true, children: [] });
      const head = await fetch(f.room, { method: 'HEAD' });
      expect(head.status).toBe(200); expect(await head.text()).toBe('');
      for (const headers of [ response.headers, head.headers ]) {
        const links = parseLinkHeader(headers.get('link') ?? undefined).filter(link => link.parameters.rel?.split(/\s+/u).includes('acl'));
        expect(links.map(link => new URL(link.target, f.room).href)).toEqual([ f.roomAcl ]);
      }
      expect(f.native).not.toHaveBeenCalled();
    });
  });

  it('generates actual non-suffix Link mappings for both GET and HEAD', async () => {
    await guardedPolicyClosureFixture(async f => {
      const closure = await f.readClosure();
      for (const method of [ 'GET', 'HEAD' ]) {
        const response = await fetch(f.room, { method });
        expect(response.status).toBe(200); await response.text();
        const links = parseLinkHeader(response.headers.get('link') ?? undefined).filter(link => link.parameters.rel?.split(/\s+/u).includes('acl'));
        expect(links.map(link => new URL(link.target, f.room).href)).toEqual([ f.roomAcl ]);
        expect(closure.resources.find(r => r.iri === f.room)?.policyIri).toBe(f.roomAcl);
      }
      expect(f.roomAcl.endsWith('.acl')).toBe(false);
    }, { roomPolicyOutsideRoom: true });
  });

  it('keeps a denied normal child in the readable parent listing', async () => {
    await guardedPolicyClosureFixture(async f => {
      const history = `${f.room}private-history.ttl`;
      const actor = `${f.pod}profile/card#other`;
      await f.putRdf(history, '<urn:root:private-history> <urn:root:value> "old" .');
      await f.putRdf(f.roomAcl, `${f.ownerPolicy.replaceAll(f.podAcl, f.roomAcl).replaceAll(`<${f.pod}>`, `<${f.room}>`)}
        <${f.roomAcl}#reader> a <${ACL}Authorization>; <${ACL}accessTo> <${f.room}>;
        <${ACL}agent> <${actor}>; <${ACL}mode> <${ACL}Read> .`);
      const headers = { 'x-root-fixture-principal': actor };
      const response = await fetch(f.room, { headers });
      expect(response.status).toBe(200);
      expect(contains(f.room, await response.text())).toContain(history);
      const child = await fetch(history, { method: 'HEAD', headers });
      expect(child.status).toBe(403); await child.text();
      expect((await f.readClosure()).resources.some(r => r.iri === history)).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    });
  });
});
