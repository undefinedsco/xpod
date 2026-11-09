import { describe, expect, it } from 'vitest';
import { chatResource, messageResource, threadResource } from '@undefineds.co/models';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { InMemoryMatrixRoomDirectory } from '../../../src/api/matrix/MatrixRoomDirectory';

const bob = 'https://id.example/people/bob#me';
const alicePod = 'https://pods.example/alice/';
const bobPod = 'https://pods.example/bob/';
const roomId = '!shared-room:example.test';

function surfaceId(room: string): string {
  return `matrix-${require('node:crypto').createHash('sha256').update(room).digest('hex').slice(0, 16)}`;
}

/**
 * Real drizzle-solid 0.3.26 + real @undefineds.co/models against a traced
 * fetch that denies every broad parent/Pod/global endpoint. Only the verified
 * room's exact document and its nested room `/-/sparql` collection route are
 * allowed. This exercises the actual per-database `sparqlEndpoint` binding,
 * not an overridden getDb.
 */
describe('Matrix room-scoped ORM binding (real drizzle + models)', () => {
  it('reads a shared room through its own container without broad access', async () => {
    const surface = surfaceId(roomId);
    const container = `${alicePod}.data/chat/${surface}/`;
    const chatIri = `${container}index.ttl#this`;
    const threadIri = `${container}index.ttl#thread`;
    const allowed: string[] = [];
    const denied: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw);
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith(`/.data/chat/${surface}/-/sparql`) || url.pathname.endsWith(`/.data/chat/${surface}/index.ttl`)) {
        allowed.push(`${method} ${url.pathname}`);
      } else {
        denied.push(`${method} ${url.pathname}`);
        return new Response('denied by least-privilege trace', { status: 403 });
      }
      if (url.pathname.endsWith('/-/sparql')) {
        expect(method).toBe('GET');
        const bindings = [
          {
            subject: { type: 'uri', value: chatIri },
            parent: { type: 'uri', value: `${container}` },
            status: { type: 'literal', value: 'active' },
            title: { type: 'literal', value: 'Alice and Bob' },
            createdAt: { type: 'literal', value: '2026-10-25T00:00:00.000Z', datatype: 'http://www.w3.org/2001/XMLSchema#dateTime' },
          },
        ];
        return new Response(JSON.stringify({ head: { vars: Object.keys(bindings[0]) }, results: { bindings } }), {
          headers: { 'content-type': 'application/sparql-results+json' },
        });
      }
      return new Response(`@prefix dct: <http://purl.org/dc/terms/>.
@prefix meeting: <http://www.w3.org/ns/pim/meeting#>.
@prefix udfs: <https://undefineds.co/ns#>.
<${chatIri}> a meeting:LongChat; dct:title "Alice and Bob"; udfs:status "active".`, {
        headers: { 'content-type': 'text/turtle' },
      });
    };
    const directory = new InMemoryMatrixRoomDirectory(async root => root === alicePod || root === bobPod);
    const store = new PodMatrixStore({
      serverName: 'example.test',
      journal: new InMemoryMatrixEventJournal(),
      directory,
      verifyStorage: async root => root === alicePod || root === bobPod,
      podAccess: { getPodFetch: async (webId, options) => {
        // The caller stays Bob while the target root is Alice's Pod.
        expect(webId).toBe(bob);
        expect(options?.podBaseUrl).toBe(alicePod);
        return fetchImpl;
      } },
    });
    const context = {
      webId: bob, podUrl: bobPod, roomStorage: alicePod, roomContainer: container,
      auth: { type: 'solid' as const, webId: bob, clientId: 'bob-device' },
    } as any;
    // getState performs an exact room-document read plus a room-scoped
    // collection SELECT internally; both must stay inside the room container.
    await store.getState(roomId, 'm.room.name', '', context).catch(() => undefined);
    expect(denied).toEqual([]);
    expect(allowed.some(entry => entry.includes('/-/sparql'))).toBe(true);
    expect(allowed.some(entry => entry.endsWith('/index.ttl'))).toBe(true);
  });

  it('never mutates the shared models tables or asks the broad chat endpoint', async () => {
    const endpointBefore = chatResource.getSparqlEndpoint();
    const source = { chatResource, messageResource, threadResource };
    expect(Object.values(source).every(table => typeof table.getSparqlEndpoint === 'function')).toBe(true);
    expect(chatResource.getSparqlEndpoint()).toBe(endpointBefore);
    expect(endpointBefore).toBe('/.data/chat/-/sparql');
  });
});
