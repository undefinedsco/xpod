import { createRequire } from 'node:module';
import { Parser, Store, Writer } from 'n3';
import { messageResource, MessageStatus } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../src/api/chatkit/store';
import type { ClientToolCallItem } from '../../src/api/chatkit/types';

const require = createRequire(import.meta.url);
const { InsertQueryBuilder } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/query-builders/insert-query-builder.js');
const { ASTToSPARQLConverter } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/ast-to-sparql.js');

const webId = 'https://pod.example/alice/profile/card#me';
const podBase = 'https://pod.example/alice';
const threadRef = 'task/task_1/index.ttl#thread_1';
const messageId = 'task/task_1/2026/10/02/messages.ttl#client_tool_call_mur6';
const documentUrl = `${podBase}/.data/task/task_1/2026/10/02/messages.ttl`;
const messageIri = `${documentUrl}#client_tool_call_mur6`;
const siblingIri = `${documentUrl}#sibling_message`;
const UDFS = 'https://undefineds.co/ns#';

const metadata = {
  '@id': `${messageIri}/metadata`,
  arguments: '{"action":"http://www.w3.org/ns/odrl/2/write","target":"http://x/marker.txt"}',
  protocols: { chatkit: { item_id: messageId, note: 'nested "quotes"' } },
  runId: 'task/task_1/2026/10/02/runs.ttl#run_mur6',
  approval: 'https://pod.example/alice/.data/approvals/2026/10/02.ttl#approval_x',
  output: '{"kind":"approval_decision","decision":"approved","actionExecuted":false}',
  // Newline, backslash and quote must survive the Turtle round-trip unchanged.
  note: 'line1\nline2 \\ backslash " quote',
};

/** The real installed ORM INSERT serializer, wired exactly like PodChatKitStore.updateConditionalMessage. */
function realInsertDb() {
  return {
    insert: (table: unknown) => new InsertQueryBuilder(
      { getDialect: () => ({ getSPARQLConverter: () => new ASTToSPARQLConverter(podBase, webId) }) },
      table,
    ),
    // Existing-item branch needs a message row; the value is not used beyond `id` here.
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ execute: async () => [{ id: messageId }] }) }) }),
    }),
  };
}

function toTurtle(quads: unknown[]): string {
  const writer = new Writer({ format: 'Turtle' });
  writer.addQuads(quads as never);
  let output = '';
  writer.end((_error: Error | null, result: string) => { output = result; });
  return output;
}

/**
 * A fake Pod document. GET serves Turtle with a strong ETag; only PUT is accepted. The removed
 * directPatchMessage bypass issued a PATCH, so it fails here instead of silently corrupting.
 */
function createPod() {
  const graph = new Store();
  graph.addQuads(new Parser({ baseIRI: documentUrl }).parse(
    `<${messageIri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/ns/pim/meeting#Message> .
     <${messageIri}> <${UDFS}messageType> "system" .
     <${messageIri}> <${UDFS}messageStatus> "pending" .
     <${messageIri}> <${UDFS}toolName> "request_approval" .
     <${messageIri}> <${UDFS}toolCallId> "call_00_mur6" .
     <${messageIri}> <http://rdfs.org/sioc/ns#content> "" .
     <${messageIri}> <http://purl.org/dc/terms/created> "2026-10-02T16:35:03.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
     <${siblingIri}> <${UDFS}messageStatus> "completed" .
     <${siblingIri}> <http://rdfs.org/sioc/ns#content> "sibling body" .`,
  ) as never);
  let etag = '"v1"';
  const fetchStub: typeof fetch = async (_input, init) => {
    if (!init?.method || init.method === 'GET') {
      return new Response(toTurtle(graph.getQuads(null, null, null, null)), {
        status: 200, headers: { etag, 'content-type': 'text/turtle' },
      });
    }
    if (init.method === 'PUT') {
      graph.removeQuads(graph.getQuads(null, null, null, null));
      graph.addQuads(new Parser({ baseIRI: documentUrl }).parse(String(init.body)) as never);
      etag = '"v2"';
      return new Response(null, { status: 204 });
    }
    return new Response('unsupported', { status: 405 });
  };
  return { graph, fetchStub };
}

function toolItem(): ClientToolCallItem {
  return {
    id: messageId,
    thread_id: threadRef,
    type: 'client_tool_call',
    name: 'request_approval',
    arguments: String(metadata.arguments),
    call_id: 'call_00_mur6',
    status: 'completed',
    output: String(metadata.output),
    metadata: { ...metadata },
    created_at: Date.UTC(2026, 9, 2, 16, 35, 3) / 1000,
  };
}

function storeContext(db: unknown, fetchFn: typeof fetch): StoreContext {
  return {
    userId: webId,
    auth: { type: 'solid', webId },
    podUrl: podBase,
    _cachedDb: db,
    _cachedFetch: fetchFn,
    _cachedPodBaseUrl: podBase,
  } as unknown as StoreContext;
}

function inlineMetadataChild(graph: Store): Record<string, unknown> | undefined {
  const link = graph.getQuads(messageIri, messageResource.columns.metadata.options.predicate!, null, null)[0];
  if (!link) return undefined;
  if (link.object.termType !== 'NamedNode') throw new Error('metadata persisted as a non-node term');
  const child = link.object.value;
  const values: Record<string, unknown> = { '@id': child };
  for (const quad of graph.getQuads(child, null, null, null)) {
    const key = quad.predicate.value.replace(UDFS, '');
    values[key] = quad.object.termType === 'Literal' && quad.object.datatype.value.endsWith('#json')
      ? JSON.parse(quad.object.value)
      : quad.object.value;
  }
  return values;
}

describe('PodChatKitStore.saveItem message metadata persistence', () => {
  it.each([
    ['recently created message', true],
    ['existing message', false],
  ])('preserves nested metadata, call id, status, output and siblings (%s)', async (_label, recentlyCreated) => {
    const { graph, fetchStub } = createPod();
    const store = new PodChatKitStore({});
    if (recentlyCreated) {
      (store as unknown as { recentlyCreatedIds: Set<string> }).recentlyCreatedIds.add(messageId);
    }

    await store.saveItem({ thread_id: threadRef }, toolItem(), storeContext(realInsertDb(), fetchStub));

    // No flat metadata literal may remain on the message subject.
    const flat = graph.getQuads(messageIri, messageResource.columns.metadata.options.predicate!, null, null)
      .find(quad => quad.object.termType === 'Literal');
    expect(flat, 'metadata must not be persisted as a flat literal').toBeUndefined();

    expect(inlineMetadataChild(graph)).toEqual({
      '@id': `${messageIri}/metadata`,
      arguments: metadata.arguments,
      protocols: metadata.protocols,
      runId: metadata.runId,
      approval: metadata.approval,
      output: metadata.output,
      note: metadata.note,
    });

    // Original identity and the unrelated sibling message survive the update.
    expect(graph.getQuads(messageIri, `${UDFS}toolCallId`, null, null)[0].object.value).toBe('call_00_mur6');
    expect(graph.getQuads(messageIri, `${UDFS}messageType`, null, null).map(quad => quad.object.value)).toEqual(['system']);
    expect(graph.getQuads(messageIri, 'http://purl.org/dc/terms/created', null, null).map(quad => quad.object.value))
      .toEqual(['2026-10-02T16:35:03.000Z']);
    expect(graph.getQuads(messageIri, `${UDFS}messageStatus`, null, null)[0].object.value).toBe(MessageStatus.COMPLETED);
    expect(graph.getQuads(messageIri, 'http://rdfs.org/sioc/ns#content', null, null)[0].object.value).toBe(metadata.output);
    expect(graph.getQuads(siblingIri, `${UDFS}messageStatus`, null, null)[0].object.value).toBe('completed');
    expect(graph.getQuads(siblingIri, 'http://rdfs.org/sioc/ns#content', null, null)[0].object.value).toBe('sibling body');
  });

  it('fails closed when the Pod document has no strong ETag', async () => {
    const { graph, fetchStub } = createPod();
    const weakFetch: typeof fetch = async (input, init) => {
      const response = await fetchStub(input, init);
      if ((!init?.method || init.method === 'GET') && response.headers.get('etag')) {
        const headers = new Headers(response.headers);
        headers.delete('etag');
        return new Response(await response.text(), { status: response.status, headers });
      }
      return response;
    };
    const store = new PodChatKitStore({});
    (store as unknown as { recentlyCreatedIds: Set<string> }).recentlyCreatedIds.add(messageId);
    await expect(store.saveItem({ thread_id: threadRef }, toolItem(), storeContext(realInsertDb(), weakFetch)))
      .rejects.toThrow(/ETag/);
    expect(graph.getQuads(messageIri, `${UDFS}messageStatus`, null, null)[0].object.value).toBe('pending');
  });
});
