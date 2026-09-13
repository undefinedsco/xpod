import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import { RdfQuadIndex } from '../../../src/storage/rdf/RdfQuadIndex';
import { RdfQuerySparqlEngine } from '../../../src/storage/rdf/RdfQuerySparqlEngine';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';

const { namedNode, literal, quad } = DataFactory;

// Regression: ChatKit history disappeared after refresh because the public
// SPARQL evaluator did not expose authorized Pod file graphs as its default graph.
// Found by real local-Pod browser QA on 2026-08-29.
describe('RdfQuerySparqlEngine Pod default graph regression', () => {
  it('queries authorized named Pod file graphs through the endpoint default graph', async () => {
    const source = 'https://pod.example/alice/.data/chat/thread/messages.ttl';
    const rdfEngine = new SolidRdfEngine({ index: new RdfQuadIndex({ path: ':memory:' }) });
    await rdfEngine.open();
    await rdfEngine.replaceSource([
      quad(
        namedNode(`${source}#message`),
        namedNode('https://schema.org/text'),
        literal('Persisted message'),
        namedNode(source),
      ),
    ], {
      source,
      workspace: 'https://pod.example/alice/.data/chat/thread/',
    });
    const sparql = new RdfQuerySparqlEngine(rdfEngine);

    try {
      const stream = await sparql.queryBindings(
        'SELECT ?text WHERE { ?message <https://schema.org/text> ?text }',
        'https://pod.example/alice/.data/',
        undefined,
        { unionDefaultGraph: true },
      );
      const values: string[] = [];
      for await (const binding of stream) {
        const value = binding.get('text');
        if (value) values.push(value.value);
      }

      expect(values).toEqual([ 'Persisted message' ]);

      // The standard evaluator must not implicitly merge named graphs.
      const standard = await sparql.queryBindings(
        'SELECT ?text WHERE { ?message <https://schema.org/text> ?text }',
        'https://pod.example/alice/.data/',
      );
      const standardRows = [];
      for await (const binding of standard) standardRows.push(binding);
      expect(standardRows).toHaveLength(0);

      for (const restriction of [
        { deniedGraphUrls: [source] },
        { allowedGraphUrls: ['https://pod.example/alice/.data/other.ttl'] },
        { deniedSourceUrls: [source] },
      ]) {
        const restricted = await sparql.queryBindings(
          'SELECT ?text WHERE { ?message <https://schema.org/text> ?text }',
          'https://pod.example/alice/.data/',
          { basePath: 'https://pod.example/alice/.data/', mode: 'read', ...restriction },
          { unionDefaultGraph: true },
        );
        const restrictedRows = [];
        for await (const binding of restricted) restrictedRows.push(binding);
        expect(restrictedRows, JSON.stringify(restriction)).toHaveLength(0);
      }
    } finally {
      await sparql.close();
    }
  });
});
