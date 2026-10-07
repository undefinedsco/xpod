import { drizzle, id, object, solidSchema, uri, type AnyPodResource } from '@undefineds.co/drizzle-solid';
import { chatModelResource, chatResource, messageResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer, type Quad } from 'n3';
import { describe, expect, it, vi } from 'vitest';

const podUrl = 'https://pod.example/alice/';
const alice = `${podUrl}profile/card#me`;
const bob = 'https://pod.example/bob/profile/card#me';
const chatIri = chatResource.buildIri(podUrl, { id: 'exact-metadata' });
const metadata = {
  '@id': `${chatIri}/metadata`,
  memberRoles: { [alice]: 'owner', [bob]: 'admin' },
  protocols: { matrix: { roomId: '!example:pod.example' } },
  payload: { value: 'business value', other: 'preserve me', nested: { enabled: true } },
};

function database(fetcher: typeof fetch) {
  return drizzle({ info: { isLoggedIn: true, webId: alice, podUrl }, fetch: fetcher } as never,
    { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
}

async function insertedGraph(resource: AnyPodResource, row: Record<string, unknown>) {
  const db = database(async() => { throw new Error('Compilation must not perform HTTP'); });
  const graph = new Store();
  const query = db.insert(resource as never).values(row as never).toSPARQL().query;
  await new QueryEngine().queryVoid(query, { sources: [graph], destination: graph });
  return graph;
}

async function turtleDocument(graph: Store, duplicates: Quad[] = []): Promise<string> {
  const writer = new Writer();
  writer.addQuads([...graph.getQuads(null, null, null, null), ...duplicates]
    .map(quad => DataFactory.quad(quad.subject, quad.predicate, quad.object)));
  return await new Promise((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
}

describe('public URI arrays and exact inline metadata', () => {
  it.each((['participants', 'mentions'] as const).flatMap(field => [0, 1, 2].map(count => ({ field, count }))))
    ('persists $count $field as RDF URI terms with unchanged full WebIDs', async({ field, count }) => {
    const resource = field === 'participants' ? chatResource : messageResource;
    const id = field === 'participants' ? chatResource.buildId({ id: 'exact-metadata' })
      : 'chat/exact-metadata/2026/10/03/messages.ttl#one';
    const expected = [alice, bob].slice(0, count);
    const graph = await insertedGraph(resource, { id, author: alice, parent: chatIri, [field]: expected });
    const column = resource.getColumn(field)!;
    const values = graph.getQuads(null, column.getPredicate(resource.config.namespace), null, null).map(q => q.object);
    expect(values.map(term => [term.termType, term.value]).sort())
      .toEqual(expected.map(value => ['NamedNode', value]).sort());
  });

  it.each([0, 1, 2])('replaces URI arrays with %s values without deleting referenced WebID facts', async count => {
    const graph = await insertedGraph(chatResource, {
      id: chatResource.buildId({ id: 'exact-metadata' }), author: alice, participants: [alice, bob],
    });
    const document = chatIri.split('#')[0];
    const label = DataFactory.namedNode('https://example.org/label');
    graph.addQuad(DataFactory.namedNode(bob), label, DataFactory.literal('Bob stays'), DataFactory.namedNode(document));
    const expected = [alice, bob].slice(0, count);
    const query = database(async() => { throw new Error('No HTTP'); })
      .update(chatResource).set({ participants: expected }).whereByIri(chatIri).toSPARQL().query;
    await new QueryEngine().queryVoid(query, { sources: [graph], destination: graph });
    const values = graph.getQuads(chatIri, chatResource.participants.getPredicate(chatResource.config.namespace), null, null);
    expect(values.map(q => [q.object.termType, q.object.value]).sort())
      .toEqual(expected.map(value => ['NamedNode', value]).sort());
    expect(graph.getQuads(bob, label, null, null).map(q => q.object.value)).toEqual(['Bob stays']);
  });

  it('preserves inverse array INSERT identity for a non-HTTP absolute URI', async() => {
    const table = solidSchema({ id: id(), links: uri('links').array().inverse().predicate('https://example.org/link') },
      { type: 'https://example.org/InverseArrayProbe' })
      .table('inverse_array_probe', { base: '/fixtures/arrays/', resourceMode: 'sparql', autoRegister: false });
    const graph = await insertedGraph(table, { id: 'one.ttl#this', links: ['urn:uuid:abc'] });
    const quads = graph.getQuads(null, 'https://example.org/link', null, null);
    expect(quads.map(q => [q.subject.termType, q.subject.value, q.object.termType]))
      .toEqual([['NamedNode', 'urn:uuid:abc', 'NamedNode']]);
  });

  it('keeps public scalar string arrays as separate Literal values', async() => {
    const graph = await insertedGraph(chatModelResource, { id: 'array-model.ttl#this', inputModalities: ['text', 'image'] });
    const values = graph.getQuads(null, chatModelResource.inputModalities.getPredicate(chatModelResource.config.namespace), null, null);
    expect(values.map(q => [q.object.termType, q.object.value]).sort()).toEqual([['Literal', 'image'], ['Literal', 'text']]);
  });

  it('preserves the existing public object-array child structure', async() => {
    const table = solidSchema({ id: id(), items: object('items').array().predicate('https://example.org/items') },
      { type: 'https://example.org/ArrayProbe', namespace: { prefix: 'ex', uri: 'https://example.org/' } })
      .table('array_probe', { base: '/fixtures/arrays/', resourceMode: 'sparql', autoRegister: false });
    const child = `${podUrl}fixtures/arrays/one.ttl#child`;
    const graph = await insertedGraph(table, { id: 'one.ttl#this', items: [{ '@id': child, title: 'preserved' }] });
    expect(graph.getQuads(null, 'https://example.org/items', null, null).map(q => [q.object.termType, q.object.value]))
      .toEqual([['NamedNode', child]]);
    expect(graph.getQuads(child, 'https://example.org/title', null, null).map(q => q.object.value)).toEqual(['preserved']);
  });

  it.each([false, true])('hydrates the exact metadata in one GET with duplicate RDF facts = %s', async duplicate => {
    const graph = await insertedGraph(chatResource, {
      id: chatResource.buildId({ id: 'exact-metadata' }), author: alice,
      participants: [alice, bob], metadata,
    });
    const repeated = duplicate ? [
      ...graph.getQuads(metadata['@id'], null, null, null),
      ...graph.getQuads(chatIri, chatResource.participants.getPredicate(chatResource.config.namespace), null, null),
    ] : [];
    const turtle = await turtleDocument(graph, repeated);
    const document = chatIri.split('#')[0];
    const requests: string[] = [];
    const fetcher = vi.fn(async(input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url !== document || requests.length > 1 || (init?.method ?? 'GET') !== 'GET') {
        throw new Error('Exact reads must not fall back to another request');
      }
      const response = new Response(turtle, { headers: { 'Content-Type': 'text/turtle' } });
      Object.defineProperty(response, 'url', { value: document });
      return response;
    });
    const row = await database(fetcher).findByIri(chatResource, chatIri);
    expect(requests).toEqual([document]);
    expect(row).toMatchObject({ author: alice, participants: [alice, bob], metadata });
  });
});
