import { describe, expect, it, vi } from 'vitest';
import { Parser, Writer } from 'n3';
import { expectedSourceDigest, guardedPolicyClosureFixture } from '../helpers/GuardedPolicyClosureFixture';

const media = 'application/vnd.xpod.authorization-observation+json';

describe('actual authorization observation full ground source and inventory', () => {
  it('keeps source set digest stable under triple order and exact duplicates', async () => {
    await guardedPolicyClosureFixture(async f => {
      const request = await f.observationRequest();
      const quads = new Parser({ baseIRI: f.document }).parse(await f.readPersisted(f.document));
      const writer = new Writer({ format: 'Turtle' });
      writer.addQuads([...quads].reverse());
      writer.addQuads(quads);
      const turtle = await new Promise<string>((resolve, reject) => {
        writer.end((error, text) => error ? reject(error) : resolve(text));
      });
      await f.putRdf(f.document, turtle);
      const response = await f.post(request, media);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).sourceDigest).toBe(request.expectedSourceDigest);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('rejects a stale full-source digest for both extra triples and different integer lexical forms', async () => {
    await guardedPolicyClosureFixture(async f => {
      const original = await f.readPersisted(f.document);
      const request = await f.observationRequest();
      const extra = '<urn:root:extra> <urn:root:value> "01"^^<http://www.w3.org/2001/XMLSchema#integer> .';
      await f.putRdf(f.document, `${original}\n${extra}`);
      expect((await f.post(request, media)).status).toBe(409);
      const current = await f.observationRequest();
      expect((await f.post(current, media)).status).toBe(200);
      await f.putRdf(f.document, `${original}\n${extra.replace('"01"', '"+1"')}`);
      expect((await f.post(current, media)).status).toBe(409);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('binds the full source fragment as part of the independently computed digest domain', async () => {
    await guardedPolicyClosureFixture(async f => {
      const request = await f.observationRequest();
      const other = new URL(f.source); other.hash = '#root-other-source';
      const changed = { ...request, sourceIri: other.href };
      expect((await f.post(changed, media)).status).toBe(409);
      const quads = new Parser({ baseIRI: f.document }).parse(await f.readPersisted(f.document));
      expect(expectedSourceDigest(other.href, f.document, quads)).not.toBe(request.expectedSourceDigest);
      expect((await f.post(request, media)).status).toBe(200);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('includes old dated history across nested containers without scanning an unrelated Pod sibling', async () => {
    await guardedPolicyClosureFixture(async f => {
      const oldContainer = `${f.room}2020/`;
      const oldHistory = `${oldContainer}01-01.ttl`;
      const sibling = `${f.pod}unrelated/`;
      await f.putContainer(oldContainer);
      await f.putRdf(oldHistory, '<urn:root:old> <urn:root:when> "2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .');
      await f.putContainer(sibling);
      await f.putRdf(`${sibling}unrelated.ttl`, '<urn:root:unrelated> <urn:root:value> "private" .');
      expect((await fetch(oldHistory, { method: 'HEAD' })).status).toBe(200);
      const enumeration = vi.spyOn(f.accessor, 'getChildren');
      const response = await f.post(await f.observationRequest(), media);
      expect(response.status).toBe(200);
      const result = JSON.parse(response.text);
      expect(result.guard.resources.some((row: { iri: string }) => row.iri === oldHistory)).toBe(true);
      expect(result.read.find((row: { iri: string }) => row.iri === oldHistory)?.allowed).toBe(true);
      expect(enumeration.mock.calls.some(([identifier]) => identifier.path === sibling || identifier.path === f.pod)).toBe(false);
      expect(response.text).not.toContain(sibling);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });
});
