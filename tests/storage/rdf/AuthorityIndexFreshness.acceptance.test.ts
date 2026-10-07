// Independent actual CSS/File/SQLite reads after an ordinary index fault.
// The native protocol producer is Comunica, not production QLever/Gateway.
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Quad } from '@rdfjs/types';
import { AtomicFileDataAccessor, BasicRepresentation, INTERNAL_QUADS, arrayifyStream } from '@solid/community-server';
import { Parser } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { metadataRequestContext } from '../../../src/storage/MetadataRequestContext';
import { QleverSparqlEngine } from '../../../src/storage/rdf/QleverSparqlEngine';
import { guardedPolicyClosureFixture } from '../../helpers/GuardedPolicyClosureFixture';

type Fixture = Parameters<Parameters<typeof guardedPolicyClosureFixture>[0]>[0];
const atomicOptions = {
  authorityRecovery: true,
  rdfFileDataAccessor: ({ rootFilePath, mapper }: {
    rootFilePath: string;
    mapper: ConstructorParameters<typeof AtomicFileDataAccessor>[0];
  }) => new AtomicFileDataAccessor(mapper, rootFilePath + path.sep,
    path.join(rootFilePath, '.internal', 'tempFiles') + path.sep),
};
const triples = (quads: readonly Quad[]) => quads.map(quad =>
  JSON.stringify([quad.subject, quad.predicate, quad.object])).sort();
const parse = (iri: string, text: string) => new Parser({ baseIRI: iri }).parse(text);
const put = (fixture: Fixture, iri: string, text: string) => fixture.lockedStore.setRepresentation(
  { path: iri }, new BasicRepresentation(Readable.from(parse(iri, text), { objectMode: true }), INTERNAL_QUADS),
);

async function withIndexFault(fixture: Fixture, iri: string, run: (replacement: string) => Promise<void>) {
  const replacement = `<${iri}#replacement> <urn:root:freshness> "new complete bytes" .`;
  const original = fixture.structured.writeRdfSourceDocument.bind(fixture.structured);
  let observed = false;
  const fault = vi.spyOn(fixture.structured, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
    if (args[0].path !== iri) return original(...args);
    expect(triples(parse(iri, await fixture.readPersisted(iri)))).toEqual(triples(parse(iri, replacement)));
    observed = true;
    throw new Error('Root freshness index fault');
  });
  try {
    await expect(put(fixture, iri, replacement)).rejects.toThrow('Root freshness index fault');
    expect(observed).toBe(true);
    await run(replacement);
  } finally { fault.mockRestore(); }
}

describe('Root: failed index writes cannot expose stale authoritative facts', () => {
  it.each(['fresh-request', 'warm-hit', 'warm-miss'] as const)(
    'returns current file facts or explicit unavailability after %s', async kind => {
      await guardedPolicyClosureFixture(async fixture => {
        const iri = kind === 'warm-miss' ? `${fixture.room}new-freshness.ttl` : fixture.document;
        await metadataRequestContext.run({ metadataCache: new Map() }, async () => {
          if (kind === 'warm-hit') await fixture.accessor.getMetadata({ path: iri });
          if (kind === 'warm-miss') await expect(fixture.accessor.getMetadata({ path: iri })).rejects.toMatchObject({ statusCode: 404 });
          await withIndexFault(fixture, iri, async () => {
            const read = async () => {
              let data: Quad[] | undefined;
              let error: unknown;
              try { data = await arrayifyStream(await fixture.accessor.getData({ path: iri })) as Quad[]; }
              catch (caught) { error = caught; }
              if (error !== undefined) {
                expect(error, 'uncertain indexing must not look like a missing authority').toMatchObject({ statusCode: 503 });
                return;
              }
              // A successful read is legitimate only if its facts match a retained
              // complete file. Complete rollback is allowed; missing files are not.
              const file = await fixture.readPersisted(iri);
              expect(triples(data!)).toEqual(triples(parse(iri, file)));
            };
            if (kind === 'fresh-request') await metadataRequestContext.run({ metadataCache: new Map() }, read);
            else await read();
          });
        });
      }, atomicOptions);
    }, 30_000,
  );

  it('does not let a native ASK use old facts after a complete file replacement failed indexing', async () => {
    await guardedPolicyClosureFixture(async fixture => {
      const iri = fixture.document;
      const baseline = `<${iri}#old> <urn:root:old-fact> "old" .`;
      await put(fixture, iri, baseline);
      const native = new QleverSparqlEngine(fixture.engine);
      const query = `ASK { GRAPH <${iri}> { <${iri}#old> <urn:root:old-fact> "old" } }`;
      const scope = { basePath: fixture.room, mode: 'read' as const, allowedGraphUrls: [iri] };
      expect(await native.queryBoolean(query, fixture.room, scope)).toBe(true);
      await withIndexFault(fixture, iri, async () => {
        let answer: boolean | undefined;
        let error: unknown;
        try { answer = await native.queryBoolean(query, fixture.room, scope); }
        catch (caught) { error = caught; }
        if (error !== undefined) {
          expect(error, 'native index uncertainty must be explicit').toMatchObject({ statusCode: 503 });
          return;
        }
        const actualFile = parse(iri, await fixture.readPersisted(iri));
        const old = parse(iri, baseline)[0];
        expect(answer).toBe(actualFile.some(quad => quad.subject.equals(old.subject)
          && quad.predicate.equals(old.predicate) && quad.object.equals(old.object)));
      });
    }, atomicOptions);
  }, 30_000);
});
