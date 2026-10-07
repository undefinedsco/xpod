import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource, messageResource, MessageRole, MessageStatus } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { vi } from 'vitest';
import { CanonicalRoomSource } from '../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../src/api/matrix/canonicalRoomIdentity';
import { InMemoryMatrixEventJournal } from '../../src/api/matrix/MatrixEventJournal';
import { PodMatrixStore } from '../../src/api/matrix/PodMatrixStore';
import { roomChatIri, roomDirectoryIri, roomThreadIri } from '../../src/api/matrix/roomResources';
import { buildConditionalEventWrite } from '../../src/api/matrix/conditionalEventWrite';
import type { MembershipOperation } from '../../src/api/matrix/membershipOperation';
import type { MatrixStoreContext } from '../../src/api/matrix/types';

/** Root-owned loopback RDF fixture. Principal headers count transport choice; they are not DPoP. */
export async function membershipPduFixture<T>(run: (f: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
  const f = await open();
  try { return await run(f); } finally { await f.close(); }
}

async function open() {
  const graph = new Store();
  const engine = new QueryEngine();
  const requests: Array<{ url: string; method: string; principal: string }> = [];
  const responses = new Map<string, { status: number; body?: string; location?: string; drop?: boolean }>();
  let beforePost: (() => Promise<void>) | undefined;
  let afterPost: (() => Promise<void>) | undefined;
  let losePostResponse = false;
  const server = createServer((request, response) => {
    void (async() => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      requests.push({ url: url.href, method: request.method!, principal: String(request.headers['x-root-pdu-principal'] ?? '') });
      const override = responses.get(url.href);
      if (override) {
        if (override.drop) { request.socket.destroy(); return; }
        response.writeHead(override.status, { 'Content-Type': 'text/turtle', ...(override.location ? { Location: override.location } : {}) });
        response.end(override.body ?? ''); return;
      }
      let query = url.searchParams.get('query');
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        query = Buffer.concat(chunks).toString();
      }
      if (query) {
        if (/^\s*(?:PREFIX[^\n]+\n)*\s*(?:INSERT|DELETE|WITH)/iu.test(query)) {
          await beforePost?.();
          await engine.queryVoid(query, { sources: [graph], destination: graph });
          await afterPost?.();
          if (losePostResponse) { request.socket.destroy(); return; }
          response.writeHead(204); response.end(); return;
        }
        const result = await engine.query(query, { sources: [graph] });
        const serialized = await engine.resultToString(result, 'application/sparql-results+json');
        let body = '';
        for await (const chunk of serialized.data) body += String(chunk);
        response.writeHead(200, { 'Content-Type': 'application/sparql-results+json' }); response.end(body); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const quads = graph.getQuads(null, null, null, DataFactory.namedNode(url.href));
      if (quads.length === 0) { response.writeHead(404); response.end(); return; }
      const writer = new Writer();
      writer.addQuads(quads.map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
      const body = await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
      response.writeHead(200, { 'Content-Type': 'text/turtle' }); response.end(body);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('Root fixture request failed'); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Root fixture port unavailable');
  const issuer = `http://127.0.0.1:${address.port}/`;
  const ownerPod = `${issuer}alice/`, actorPod = `${issuer}bob/`;
  const owner = `${ownerPod}profile/card#me`, actor = `${actorPod}profile/card#me`, target = `${issuer}charlie/profile/card#me`;
  const roomId = encodeSourceBoundRoomId(chatResource.buildIri(ownerPod, { id: 'root-pdu' }));
  const context = (webId: string, podUrl: string): MatrixStoreContext => ({ webId, podUrl, auth: { type: 'solid', webId } as never });
  const ownerContext = context(owner, ownerPod), actorContext = context(actor, actorPod);
  const pods = [{ podId: 'root-alice', baseUrl: ownerPod, webId: owner }, { podId: 'root-bob', baseUrl: actorPod, webId: actor }];
  const podAccess = { getPodFetch: vi.fn(async(webId: string, options: any) => {
    if (options.auth?.webId !== webId || options.taskCredential || !pods.some(p => p.webId === webId && p.baseUrl === options.podBaseUrl))
      throw new Error('Root fixture refuses mixed caller/target transport');
    return (async(input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers); headers.set('x-root-pdu-principal', webId);
      return await fetch(input, { ...init, headers });
    }) as typeof fetch;
  }) };
  const source = new CanonicalRoomSource({ pods: {
    findByResourceIdentifier: async(url: string) => pods.find(p => url.startsWith(p.baseUrl)),
    findAllByWebId: async(webId: string) => pods.filter(p => p.webId === webId),
  } as never, callerFetchFor: async() => { throw new Error('PDU adapter must not read canonical source in this fixture'); } });
  const journal = new InMemoryMatrixEventJournal();
  const registerReference = vi.spyOn(journal, 'registerReference');
  const registerEvents = vi.spyOn(journal, 'registerEvents');
  const outbound = { enqueue: vi.fn(async() => undefined) };
  const storeFor = () => new PodMatrixStore({ canonicalSource: source, podAccess, journal, outbound });
  const compilerFor = (podUrl: string) => drizzle({ info: { webId: actor, isLoggedIn: true, podUrl },
    fetch: async() => { throw new Error('Root fixture compiler must not fetch'); } } as never,
  { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  const operation: MembershipOperation = { format: 1, operationId: '$root-original-invite', kind: 'invite', phase: 'committed',
    actor: { webId: actor, podUrl: actorPod }, targetWebId: target, authority: null,
    expected: { authorWebId: owner, participants: [owner, actor], memberRoles: { [owner]: 'owner', [actor]: 'admin' }, invitation: null },
    event: { createdAt: 1790985599000, content: { membership: 'invite' } }, ownerRecovery: null };
  const resourceIdFor = (op = operation) => messageResource.buildId({ id: createHash('sha256').update(op.operationId).digest('hex'),
    parent: roomChatIri(op.actor.podUrl, roomId), createdAt: new Date(op.event.createdAt).toISOString() });
  const iriFor = (op = operation) => messageResource.buildIri(op.actor.podUrl, { id: resourceIdFor(op) });
  const eventFor = (op = operation) => ({ event_id: op.operationId, room_id: roomId, type: 'm.room.member', sender: op.actor.webId,
    state_key: op.targetWebId, origin_server_ts: op.event.createdAt, content: { ...op.event.content },
    prev_events: ['$root-first-parent'], auth_events: [], depth: 7, hashes: { sha256: 'root-first-body' }, signatures: {} });
  const seedAnchor = (op = operation) => {
    const chat = roomChatIri(op.actor.podUrl, roomId);
    graph.addQuad(DataFactory.namedNode(chat), DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      DataFactory.namedNode(String(chatResource.config.type)), DataFactory.namedNode(chat.split('#')[0]));
  };
  const seed = async(op = operation, event = eventFor(op), throughHttp = false) => {
    const iri = iriFor(op), createdAt = new Date(op.event.createdAt).toISOString();
    const chat = roomChatIri(op.actor.podUrl, roomId);
    seedAnchor(op);
    const insertQuery = compilerFor(op.actor.podUrl).insert(messageResource).values({ id: resourceIdFor(op),
      parent: roomChatIri(op.actor.podUrl, roomId), chat: roomChatIri(op.actor.podUrl, roomId), thread: roomThreadIri(op.actor.podUrl, roomId),
      maker: op.actor.webId, role: MessageRole.SYSTEM, content: JSON.stringify(event.content), status: MessageStatus.SENT,
      metadata: { '@id': `${iri}/metadata`, protocols: { matrix: { event, senderWebId: op.actor.webId } } }, createdAt, updatedAt: createdAt } as never).toSPARQL().query;
    const write = buildConditionalEventWrite({ insertQuery, messageIri: iri, chatIri: chat,
      roomDirectory: roomDirectoryIri(op.actor.podUrl, roomId), chatType: String(chatResource.config.type),
      messageType: String(messageResource.config.type), parentPredicate: String(messageResource.parent.getPredicate(messageResource.config.namespace)) });
    if (throughHttp) {
      const writeFetch = await podAccess.getPodFetch(op.actor.webId, { auth: context(op.actor.webId, op.actor.podUrl).auth,
        podBaseUrl: op.actor.podUrl });
      const response = await writeFetch(write.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/sparql-update' }, body: write.query });
      if (response.status !== 204) throw new Error('Root competing HTTP write was not acknowledged');
    } else await engine.queryVoid(write.query, { sources: [graph], destination: graph });
  };
  return { graph, engine, requests, responses, owner, actor, target, ownerPod, actorPod, ownerContext, actorContext, roomId,
    pods, podAccess, source, journal, registerReference, registerEvents, outbound, storeFor, compilerFor, operation, resourceIdFor, iriFor, eventFor, seed, seedAnchor,
    beforePost: (callback?: () => Promise<void>) => { beforePost = callback; }, afterPost: (callback?: () => Promise<void>) => { afterPost = callback; },
    losePostResponse: (value: boolean) => { losePostResponse = value; },
    close: async() => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
