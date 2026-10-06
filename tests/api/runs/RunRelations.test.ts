import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { DataFactory, Parser as TurtleParser, Writer } from 'n3';
import { Parser as SparqlParser } from 'sparqljs';
import type { Quad } from '@rdfjs/types';
import { PodChatKitStore } from '../../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../../src/api/chatkit/store';
import { Run } from '../../../src/api/runs/schema';
import type { RunRecordData } from '../../../src/api/runs/store';

const relations = {
  delivery: 'https://pod.example/alice/.data/chat/default/2026/09/22/deliveries.ttl#delivery_1',
  trigger: 'https://pod.example/alice/.data/chat/default/index.ttl#trigger_1',
  input: 'https://pod.example/alice/.data/chat/default/2026/09/22/messages.ttl#message_1',
};
// Link relations (task/thread/delivery) are reported as opaque resource ids and re-resolved by
// the ORM. Plain-URI collaboration relations (trigger/input) keep their full URI.
const relationsBase = {
  delivery: 'chat/default/2026/09/22/deliveries.ttl#delivery_1',
  trigger: relations.trigger,
  input: relations.input,
};
const run: RunRecordData = {
  id: 'chat/default/2026/09/22/runs.ttl#run_1',
  thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
  workspace: 'https://pod.example/alice/workspaces/default/',
  status: 'queued',
  runner: 'https://pod.example/alice/agents/worker#this',
  createdAt: Date.UTC(2026, 8, 22) / 1000,
  updatedAt: Date.UTC(2026, 8, 22) / 1000,
};
const runBase: RunRecordData = { ...run, thread: 'chat/default/index.ttl#thread_1' };

function fixture(initial?: Record<string, unknown>, realRead = false, bound = true) {
  const pod = 'https://pod.example/alice/';
  const iri = `${pod}.data/${run.id}`;
  const documentUrl = iri.split('#')[0];
  const rows = new Map<string, Record<string, unknown>>();
  let body = '';
  let version = 1;
  let conditionalWrites = 0;
  const authenticatedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(documentUrl);
    if (init?.method === 'PUT') {
      expect(new Headers(init.headers).get('if-match')).toBe(`"${version}"`);
      body = String(init.body);
      const quads = new TurtleParser({ baseIRI: documentUrl }).parse(body);
      const row: Record<string, unknown> = { id: run.id };
      for (const key of Object.keys(Run.columns) as Array<keyof typeof Run.columns>) {
        const column = Run.columns[key];
        const value = quads.find(quad => quad.subject.value === iri && quad.predicate.value === column.options.predicate);
        if (value) row[String(key)] = value.object.value;
      }
      rows.set(run.id, row);
      version += 1;
      conditionalWrites += 1;
      return new Response(null, { status: 204 });
    }
    return new Response(body, { headers: { 'content-type': 'text/turtle', etag: `"${version}"` } });
  }) as typeof fetch;
  const serializer = drizzle({ fetch: authenticatedFetch, info: { webId: `${pod}profile/card#me`, isLoggedIn: true } } as never,
    { schema: { run: Run }, podUrl: pod });
  const persist = (values: Record<string, unknown>) => {
    const query = serializer.insert(Run).values(values as never).toSPARQL().query;
    const parsed = new SparqlParser().parse(query);
    if (parsed.type !== 'update') throw new Error('Expected ORM INSERT');
    const quads: Quad[] = [];
    for (const update of parsed.updates) {
      if (!('updateType' in update) || update.updateType !== 'insert') throw new Error('Expected INSERT DATA');
      for (const graph of update.insert) {
        if (graph.type !== 'graph') throw new Error('Expected document graph');
        for (const triple of graph.triples) {
          quads.push(DataFactory.quad(triple.subject as Quad['subject'], triple.predicate as Quad['predicate'], triple.object as Quad['object']));
        }
      }
    }
    body = new Writer({ format: 'Turtle' }).quadsToString(quads);
    rows.set(run.id, { ...values });
  };
  if (initial) persist(initial);
  const db = {
    getDialect: bound ? () => serializer.getDialect() : undefined,
    findById: async (resource: unknown, id: string) => {
      expect(resource).toBe(Run);
      if (realRead) return serializer.findById(Run, id);
      return rows.get(id) ?? null;
    },
    insert: (resource: unknown) => {
      expect(resource).toBe(Run);
      return { values: (values: Record<string, unknown>) => ({
        // Conditional updates use the real serializer without changing the server snapshot.
        toSPARQL: () => serializer.insert(Run).values(values as never).toSPARQL(),
        // Creation retains the ORM's awaitable builder behavior.
        then: (resolve: (value: void) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve().then(() => persist(values)).then(resolve, reject),
      }) };
    },
  };
  const context = { _cachedDb: db, _cachedFetch: authenticatedFetch, _cachedPodBaseUrl: pod } as StoreContext;
  return { store: new PodChatKitStore({}), context, rows, get conditionalWrites() { return conditionalWrites; } };
}

describe('Run collaboration relations', () => {
  it('reads owned RDF relations as opaque IDs using the verified database binding', async () => {
    const { store, context } = fixture({ ...run, ...relations,
      createdAt: new Date(run.createdAt * 1000), updatedAt: new Date(run.updatedAt * 1000) }, true);
    await expect(store.loadRun(run.id, context)).resolves.toMatchObject({ ...runBase, ...relationsBase });
  });

  it.each(['https://foreign.example/alice/', 'https://pod.example/bob/'])('preserves same-layout relations from another Pod (%s)', async foreignPod => {
    const foreign = { thread: `${foreignPod}.data/chat/default/index.ttl#thread_1`,
      task: `${foreignPod}.data/task/index.ttl#task_1`,
      delivery: `${foreignPod}.data/chat/default/2026/09/22/deliveries.ttl#delivery_1` };
    const { store, context } = fixture({ ...run, ...relations, ...foreign }, true);
    await expect(store.loadRun(run.id, context)).resolves.toMatchObject(foreign);
  });

  it('preserves absolute relations without a verified database binding', async () => {
    const { store, context } = fixture({ ...run, ...relations }, true, false);
    await expect(store.loadRun(run.id, context)).resolves.toMatchObject({ thread: run.thread, ...relations });
  });

  it('persists and reads all three shared URI relations when creating a Run', async () => {
    const { store, context, rows } = fixture();
    await store.saveRun({ ...run, ...relations }, context);
    expect(rows.get(run.id)).toMatchObject(relations);
    expect(await store.loadRun(run.id, context)).toMatchObject({ ...runBase, ...relationsBase });
  });

  it('preserves externally written relations through a runtime status update', async () => {
    const server = fixture({
      ...run,
      ...relations,
      createdAt: new Date(run.createdAt * 1000).toISOString(),
      updatedAt: new Date(run.updatedAt * 1000).toISOString(),
    });
    const { store, context, rows } = server;
    const loaded = await store.loadRun(run.id, context);
    await store.saveRun({ ...loaded, status: 'running', updatedAt: run.updatedAt + 1 }, context);
    expect(server.conditionalWrites).toBe(1);
    expect(rows.get(run.id)).toMatchObject({ ...relations, status: 'running' });
    expect(await store.loadRun(run.id, context)).toMatchObject({ ...relationsBase, status: 'running' });
  });

  it('round-trips legacy Runs with absent optional relations', async () => {
    const { store, context } = fixture();
    await store.saveRun({ ...run }, context);
    const loaded = await store.loadRun(run.id, context);
    expect(loaded.delivery).toBeUndefined();
    expect(loaded.trigger).toBeUndefined();
    expect(loaded.input).toBeUndefined();
    await store.saveRun({ ...loaded, status: 'running' }, context);
    expect(await store.loadRun(run.id, context)).toMatchObject({ ...runBase, status: 'running' });
  });
});
