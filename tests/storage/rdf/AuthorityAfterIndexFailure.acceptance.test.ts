import path from 'node:path';
import { Readable } from 'node:stream';
import { AtomicFileDataAccessor, BasicRepresentation, INTERNAL_QUADS } from '@solid/community-server';
import { Parser } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { guardedPolicyClosureFixture } from '../../helpers/GuardedPolicyClosureFixture';

describe('Root: complete RDF authority survives a post-file index failure', () => {
  it('retains a complete existing authority after a failed ordinary replacement', async () => {
    await guardedPolicyClosureFixture(async (fixture) => {
      const before = await fixture.readPersisted(fixture.document);
      const replacement = `<${fixture.document}#replacement> <urn:root:predicate> "new complete authority" .`;
      let completeAtFault: string | undefined;
      const original = fixture.structured.writeRdfSourceDocument.bind(fixture.structured);
      const injected = vi.spyOn(fixture.structured, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
        if (args[0].path !== fixture.document) return original(...args);
        completeAtFault = await fixture.readPersisted(fixture.document);
        throw new Error('Root injected post-file index failure');
      });
      try {
        // This fixture preserves Turtle on PUT; submit parsed RDF to exercise
        // the ordinary structured write path through the actual locked store.
        const expected = new Parser({ baseIRI: fixture.document }).parse(replacement);
        await expect(fixture.lockedStore.setRepresentation(
          { path: fixture.document },
          new BasicRepresentation(Readable.from(expected, { objectMode: true }), INTERNAL_QUADS),
        )).rejects.toThrow('Root injected post-file index failure');
        expect(completeAtFault).toBeDefined();
        const atFault = new Parser({ baseIRI: fixture.document }).parse(completeAtFault!);
        expect(atFault).toEqual(expected);

        let retained: string | undefined;
        let readError: string | undefined;
        try { retained = await fixture.readPersisted(fixture.document); }
        catch (error) { readError = String((error as NodeJS.ErrnoException).code ?? error); }
        process.stdout.write(JSON.stringify({
          rootIndexFailure: true, completeRdfObservedBeforeFault: true,
          retainedAuthority: retained !== undefined, readError,
        }) + '\n');
        expect(retained, 'an index failure must not erase an existing RDF authority').toBeDefined();
        const after = new Parser({ baseIRI: fixture.document }).parse(retained!);
        const old = new Parser({ baseIRI: fixture.document }).parse(before);
        expect(JSON.stringify(after) === JSON.stringify(old) || JSON.stringify(after) === JSON.stringify(expected)).toBe(true);
      } finally { injected.mockRestore(); }
    }, {
      rdfFileDataAccessor: ({ rootFilePath, mapper }) => new AtomicFileDataAccessor(
        mapper, rootFilePath + path.sep,
        path.join(rootFilePath, '.internal', 'tempFiles') + path.sep,
      ),
    });
  }, 30_000);
});
