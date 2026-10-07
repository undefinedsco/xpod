// Root-owned actual Local file/index listing regression; no Gateway/Cloud claim.
import path from 'node:path';
import { Readable } from 'node:stream';
import { AtomicFileDataAccessor, BasicRepresentation, INTERNAL_QUADS } from '@solid/community-server';
import { Parser } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { guardedPolicyClosureFixture } from '../../helpers/GuardedPolicyClosureFixture';

describe('Root: container listings respect pending child authority', () => {
  it('lists the retained child or reports 503 after its index write fails', async () => {
    await guardedPolicyClosureFixture(async fixture => {
      const iri = `${fixture.room}root-pending-child.ttl`;
      const text = `<${iri}#record> <urn:root:container-freshness> "complete child" .`;
      const list = async () => {
        const children: string[] = [];
        for await (const child of fixture.accessor.getChildren({ path: fixture.room })) {
          children.push(child.identifier.value);
        }
        return children;
      };
      expect(await list()).toContain(fixture.document);
      expect(await list()).not.toContain(iri);
      const original = fixture.structured.writeRdfSourceDocument.bind(fixture.structured);
      let observedCompleteFile = false;
      const fault = vi.spyOn(fixture.structured, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
        if (args[0].path !== iri) return original(...args);
        expect(new Parser({ baseIRI: iri }).parse(await fixture.readPersisted(iri))).toHaveLength(1);
        observedCompleteFile = true;
        throw new Error('Root container child index fault');
      });
      try {
        await expect(fixture.lockedStore.setRepresentation({ path: iri },
          new BasicRepresentation(Readable.from(new Parser({ baseIRI: iri }).parse(text),
            { objectMode: true }), INTERNAL_QUADS))).rejects.toThrow('Root container child index fault');
        expect(observedCompleteFile).toBe(true);
        let retained = false;
        try { await fixture.readPersisted(iri); retained = true; }
        catch (error) {
          // A coherent rollback to original absence is allowed.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        let children: string[] | undefined;
        let error: unknown;
        try { children = await list(); }
        catch (caught) { error = caught; }
        if (error !== undefined) {
          expect(error, 'pending child cannot become false absence').toMatchObject({ statusCode: 503 });
          return;
        }
        expect(children!.includes(iri), 'listing must agree with retained child authority').toBe(retained);
      } finally { fault.mockRestore(); }
    }, {
      authorityRecovery: true,
      rdfFileDataAccessor: ({ rootFilePath, mapper }) => new AtomicFileDataAccessor(mapper,
        rootFilePath + path.sep, path.join(rootFilePath, '.internal', 'tempFiles') + path.sep),
    });
  }, 30_000);
});
