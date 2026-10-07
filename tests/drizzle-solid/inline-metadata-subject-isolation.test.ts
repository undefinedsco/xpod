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

  // G08: the same day document holds one row per message, and each row's metadata child is its
  // own subject. The point of the 100-row case is that isolation is structural — every message has
  // its own `${subject}/metadata`, so an edit to one can never land on another's value. Bodies
  // carry quotes, Unicode, mentions and a reply link because those are the values most likely to
  // be escaped or re-serialized into a shared literal.
  it('keeps 100 message subjects distinct in one day document, and one edit does not move the other 99', async () => {
    const document = 'https://pod.example/alice/.data/chat/team/2026/09/22/messages.ttl';
    const builder = new TripleBuilderImpl();
    const graph = new Store();
    const bodies = Array.from({ length: 100 }, (_unused, index) =>
      `body-${index} "quoted" 数字${index} 😀 @user${index} https://alice.example/card#me`);
    const subjects = bodies.map((_unused, index) => `${document}#msg-${index}`);
    const insertSubject = (index: number, body: string): void => {
      const subject = subjects[index];
      const result = builder.buildInsert(subject, messageResource.metadata, {
        '@id': `${subject}/metadata`,
        protocol: 'matrix',
        protocols: { matrix: {
          eventId: `$event-${index}`,
          content: {
            msgtype: 'm.text',
            body,
            mentions: [ `@u_${index}:pod.example` ],
            mentionsWebIds: [ `https://user${index}.example/profile/card#me` ],
            ...(index === 0 ? {} : { 'co.undefineds.reply': `$event-${index - 1}` }),
          },
        } },
      }, messageResource);
      graph.addQuads(new Parser({ baseIRI: document }).parse(builder.toN3Strings([...result.triples, ...result.childTriples]).join('\n')));
    };
    for (const [index, body] of bodies.entries()) insertSubject(index, body);

    const predicate = messageResource.metadata.getPredicate(messageResource.config.namespace);
    const children = subjects.map(subject => graph.getQuads(subject, predicate, null, null)[0].object.value);
    expect(children).toEqual(subjects.map(subject => `${subject}/metadata`));
    expect(new Set(children).size).toBe(100);

    const engine = new QueryEngine();
    const executeQueryWithSource = async (sparql: { query: string }, source: string) => {
      expect(source).toBe(document);
      const stream = await engine.queryBindings(sparql.query, { sources: [ graph ] });
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
    const readRows = async(): Promise<any[]> => new SelectQueryBuilder(session).from(messageResource).execute();
    const rows = await readRows();
    expect(rows).toHaveLength(100);
    for (const [index, subject] of subjects.entries()) {
      const row = rows.find((candidate: any) => candidate['@id'] === subject);
      expect(row?.metadata).toMatchObject({
        '@id': `${subject}/metadata`,
        protocol: 'matrix',
        protocols: { matrix: { eventId: `$event-${index}`, content: { body: bodies[index] } } },
      });
    }

    // Replace one subject's own metadata child and re-read: the other 99 literals are untouched.
    const childSignature = (child: string): string => graph.getQuads(child, null, null, null)
      .map(quad => `${quad.predicate.value}=${quad.object.value}`).sort().join('|');
    const before = children.map(child => childSignature(child));
    const target = 7;
    graph.removeQuads(graph.getQuads(null, null, null, null).filter(quad => quad.subject.value === children[target]));
    insertSubject(target, `replaced-${target} "edited" ✅`);
    const after = children.map(child => childSignature(child));
    for (const index of subjects.keys()) {
      if (index === target) expect(after[index]).not.toBe(before[index]);
      else expect(after[index]).toBe(before[index]);
    }
    const reread = await readRows();
    expect(reread).toHaveLength(100);
    expect(reread.find((candidate: any) => candidate['@id'] === subjects[target])?.metadata)
      .toMatchObject({ protocols: { matrix: { content: { body: `replaced-${target} "edited" ✅` } } } });
    expect(reread.find((candidate: any) => candidate['@id'] === subjects[8])?.metadata)
      .toMatchObject({ protocols: { matrix: { content: { body: bodies[8] } } } });
  });
});
