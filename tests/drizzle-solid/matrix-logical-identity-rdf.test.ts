import { createRequire } from 'node:module';
import { Parser, Store } from 'n3';
import { QueryEngine } from '@comunica/query-sparql';
import { messageResource } from '@undefineds.co/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matrixHarness } from '../helpers/MatrixMemoryDatabase';

const require = createRequire(import.meta.url);
const { TripleBuilderImpl } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/triple/builder.js');
const { SelectQueryBuilder } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/query-builders/select-query-builder.js');

/**
 * The logical event identity, checked against actual RDF.
 *
 * The in-memory harness stores rows as objects and de-duplicates by id, so on its own it cannot
 * show what a Pod holds. This test takes the rows the write path actually produced, serializes
 * each row's metadata with the real drizzle-solid builder into one Turtle graph, and hydrates it
 * back with the real ORM reader. What is asserted is the storage-level fact the migration needs:
 * one logical `(roomId, eventId)` maps to exactly one RDF message metadata subject, carrying the
 * first attempt's content and creation time — not one subject per retry.
 *
 * The transport substituted is the SPARQL source (the N3 store), exactly as in the sibling
 * `inline-metadata-subject-isolation` test; serialization and hydration are the real components.
 */
const POD = 'https://pod.example/alice/';

type MessageRow = {
  id: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

/** A hydrated metadata view of one message subject. */
async function readMetadata(rows: readonly MessageRow[]): Promise<Record<string, any>[]> {
  const builder = new TripleBuilderImpl();
  const graph = new Store();
  const subjects: string[] = [];
  for (const row of rows) {
    if (!row.metadata) continue;
    const subject = messageResource.buildIri(POD, { id: row.id });
    subjects.push(subject);
    const result = builder.buildInsert(subject, messageResource.metadata, row.metadata, messageResource);
    graph.addQuads(new Parser({ baseIRI: subject }).parse(builder.toN3Strings([ ...result.triples, ...result.childTriples ]).join('\n')));
  }
  const predicate = messageResource.metadata.getPredicate(messageResource.config.namespace);
  const engine = new QueryEngine();
  // Every message in one scenario lands on the same day document, which is exactly the property
  // under test: a retry must not have re-bucketed the event into a second document.
  const document = subjects[0]?.split('#')[0];
  const executeQueryWithSource = async (sparql: { query: string }, source: string) => {
    expect(source).toBe(document);
    const stream = await engine.queryBindings(sparql.query, { sources: [ graph ] });
    return (await stream.toArray()).map((binding) => Object.fromEntries([...binding].map(([ variable, term ]) => [
      variable.value,
      term.termType === 'Literal' && term.datatype.value.endsWith('#json') ? JSON.parse(term.value) : term.value,
    ])));
  };
  const session = {
    execute: async () => subjects.map((subject) => ({
      '@id': subject, subject, id: subject.split('#').pop(),
      metadata: graph.getQuads(subject, predicate, null, null)[0]?.object.value,
    })),
    getDialect: () => ({ getSPARQLExecutor: () => ({ executeQueryWithSource }), getPodUrl: () => POD }),
  };
  return await new SelectQueryBuilder(session).from(messageResource).execute();
}

/** The event facts carried inside one hydrated row's `protocols.matrix` metadata. */
function matrixEventOf(row: any): Record<string, any> | undefined {
  return row?.metadata?.protocols?.matrix?.event as Record<string, any> | undefined;
}

describe('logical event identity over real RDF', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('leaves one message subject for cross-txn and cross-day retries, with the first content and time', async () => {
    vi.useFakeTimers({ toFake: [ 'Date' ] });
    const { store, context, rows } = matrixHarness();
    vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
    const room = await store.createRoom({}, context);
    const first = await store.sendEvent(room.roomId, 'm.room.message', 'txn-a', { body: 'first' }, context, { msgid: '$rdf-logical' });
    vi.setSystemTime(new Date('2026-09-20T10:00:05.000Z'));
    await store.sendEvent(room.roomId, 'm.room.message', 'txn-b', { body: 'first' }, context, { msgid: '$rdf-logical' });
    vi.setSystemTime(new Date('2026-09-21T10:00:00.000Z'));
    const crossDay = await store.sendEvent(room.roomId, 'm.room.message', 'txn-c', { body: 'first' }, context, { msgid: '$rdf-logical' });

    const messages = (rows.get(messageResource) as MessageRow[]).filter(row =>
      matrixEventOf(row)?.type === 'm.room.message');
    const hydrated = await readMetadata(messages);
    const forKey = hydrated.map(matrixEventOf).filter((event): event is Record<string, any> => event?.event_id === '$rdf-logical');

    // The RDF holds exactly one subject for the logical key, whatever carried the retry.
    expect(forKey).toHaveLength(1);
    expect(forKey[0].content?.body).toBe('first');
    expect(forKey[0].origin_server_ts).toBe(first.originServerTs);
    expect(crossDay.originServerTs).toBe(first.originServerTs);
    expect(messages).toHaveLength(1);
  });

  it('keeps the first RDF subject and rejects competing content that lands on another day', async () => {
    vi.useFakeTimers({ toFake: [ 'Date' ] });
    const { store, context, rows } = matrixHarness();
    vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
    const room = await store.createRoom({}, context);
    const first = await store.sendEvent(room.roomId, 'm.room.message', 'txn-a', { body: 'first' }, context, { msgid: '$rdf-conflict' });
    vi.setSystemTime(new Date('2026-09-21T10:00:00.000Z'));
    await expect(store.sendEvent(room.roomId, 'm.room.message', 'txn-b', { body: 'second' }, context, { msgid: '$rdf-conflict' }))
      .rejects.toMatchObject({ status: 409 });

    const messages = (rows.get(messageResource) as MessageRow[]).filter(row =>
      matrixEventOf(row)?.type === 'm.room.message');
    const hydrated = await readMetadata(messages);
    const forKey = hydrated.map(matrixEventOf).filter((event): event is Record<string, any> => event?.event_id === '$rdf-conflict');

    expect(forKey).toHaveLength(1);
    expect(forKey[0].content?.body).toBe('first');
    expect(forKey[0].origin_server_ts).toBe(first.originServerTs);
    // The refused content never reached the graph.
    expect(JSON.stringify(forKey)).not.toContain('second');
  });
});
