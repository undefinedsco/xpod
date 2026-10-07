// Root-owned actual Local CSS/File/SQLite acceptance. This does not qualify
// production QLever, Cloud, current Gateway or concurrent query consumption.
import path from 'node:path';
import { Readable } from 'node:stream';
import { AtomicFileDataAccessor, BasicRepresentation, INTERNAL_QUADS } from '@solid/community-server';
import { DataFactory, Parser } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { guardedPolicyClosureFixture } from '../../helpers/GuardedPolicyClosureFixture';

describe('Root: embedded facts respect pending authority replacement', () => {
  it('returns current file facts or 503 after complete-file replacement fails indexing', async () => {
    await guardedPolicyClosureFixture(async fixture => {
      const iri = fixture.document;
      const baseline = `<${iri}#old> <urn:root:embedded-freshness> "old" .`;
      const replacement = `<${iri}#new> <urn:root:embedded-freshness> "new" .`;
      const parse = (text: string) => new Parser({ baseIRI: iri }).parse(text);
      const put = (text: string) => fixture.lockedStore.setRepresentation({ path: iri },
        new BasicRepresentation(Readable.from(parse(text), { objectMode: true }), INTERNAL_QUADS));
      const old = parse(baseline)[0];
      const query = {
        patterns: [{ graph: DataFactory.namedNode(iri), subject: old.subject,
          predicate: old.predicate, object: old.object }],
      };
      await put(baseline);
      expect(fixture.engine.query(query).bindings).toHaveLength(1);
      const original = fixture.structured.writeRdfSourceDocument.bind(fixture.structured);
      let observedCompleteFile = false;
      const fault = vi.spyOn(fixture.structured, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
        if (args[0].path !== iri) return original(...args);
        const actual = parse(await fixture.readPersisted(iri));
        expect(actual).toHaveLength(1);
        expect(actual[0].subject.equals(parse(replacement)[0].subject)).toBe(true);
        observedCompleteFile = true;
        throw new Error('Root embedded freshness index fault');
      });
      try {
        await expect(put(replacement)).rejects.toThrow('Root embedded freshness index fault');
        expect(observedCompleteFile).toBe(true);
        const retained = parse(await fixture.readPersisted(iri));
        let rows: number | undefined;
        let error: unknown;
        try { rows = fixture.engine.query(query).bindings.length; }
        catch (caught) { error = caught; }
        if (error !== undefined) {
          expect(error, 'embedded index uncertainty must be explicit').toMatchObject({ statusCode: 503 });
          return;
        }
        const retainedOld = retained.filter(quad => quad.subject.equals(old.subject)
          && quad.predicate.equals(old.predicate) && quad.object.equals(old.object)).length;
        expect(rows, 'successful embedded facts must agree with the retained complete authority').toBe(retainedOld);
      } finally { fault.mockRestore(); }
    }, {
      authorityRecovery: true,
      rdfFileDataAccessor: ({ rootFilePath, mapper }) => new AtomicFileDataAccessor(
        mapper, rootFilePath + path.sep, path.join(rootFilePath, '.internal', 'tempFiles') + path.sep),
    });
  }, 30_000);
});
