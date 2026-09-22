import { createRequire } from 'node:module';
import { Parser, Store } from 'n3';
import { QueryEngine } from '@comunica/query-sparql';
import { chatResource, messageResource, runResource, threadResource } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { TripleBuilderImpl } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/triple/builder.js');
const { SelectQueryBuilder } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/query-builders/select-query-builder.js');

// Exercise the installed serializer and hydrator over actual RDF, not object-row mocks.
// The only substituted layer is transport: generated SELECT queries run on an N3 store.
describe('drizzle-solid explicit inline metadata identity', () => {
  it.each([
    ['Message', messageResource, 'messages.ttl'],
    ['Run', runResource, 'runs.ttl'],
    ['Chat', chatResource, 'index.ttl'],
    ['Thread', threadResource, 'index.ttl'],
  ] as const)('keeps two %s metadata objects isolated within the same RDF document', async (_name, resource, file) => {
    const document = `https://pod.example/alice/.data/chat/team/2026/09/22/${file}`;
    const subjects = [`${document}#first`, `${document}#second`];
    const builder = new TripleBuilderImpl();
    const graph = new Store();
    for (const [index, subject] of subjects.entries()) {
      const result = builder.buildInsert(subject, resource.metadata, {
        '@id': `${subject}/metadata`,
        protocol: 'matrix',
        protocols: { matrix: { eventId: `$event-${index}`, content: { body: `body-${index}` } } },
      }, resource);
      const turtle = builder.toN3Strings([...result.triples, ...result.childTriples]).join('\n');
      graph.addQuads(new Parser({ baseIRI: document }).parse(turtle));
    }
    const predicate = resource.metadata.getPredicate(resource.config.namespace);
    const children = subjects.map((subject) => graph.getQuads(subject, predicate, null, null)[0].object.value);
    expect(children).toEqual(subjects.map((subject) => `${subject}/metadata`));
    expect(new Set(children).size).toBe(2);

    const engine = new QueryEngine();
    const executeQueryWithSource = async (sparql: { query: string }, source: string) => {
      expect(source).toBe(document);
      const stream = await engine.queryBindings(sparql.query, { sources: [graph] });
      return (await stream.toArray()).map((binding) => Object.fromEntries([...binding].map(([variable, term]) => [
        variable.value,
        term.termType === 'Literal' && term.datatype.value.endsWith('#json') ? JSON.parse(term.value) : term.value,
      ])));
    };
    const session = {
      execute: async () => subjects.map((subject, index) => ({
        '@id': subject, subject, id: subject.split('#')[1], metadata: children[index],
      })),
      getDialect: () => ({ getSPARQLExecutor: () => ({ executeQueryWithSource }), getPodUrl: () => 'https://pod.example/alice/' }),
    };
    const rows = await new SelectQueryBuilder(session).from(resource).execute();
    expect(rows).toHaveLength(2);
    for (const [index, subject] of subjects.entries()) {
      expect(rows.find((row: any) => row['@id'] === subject)?.metadata).toMatchObject({
        '@id': `${subject}/metadata`, protocol: 'matrix',
        protocols: { matrix: { eventId: `$event-${index}`, content: { body: `body-${index}` } } },
      });
    }
  });
});
