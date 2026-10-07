import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource, messageResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { buildConditionalEventWrite } from '../../../src/api/matrix/conditionalEventWrite';
import { roomChatIri } from '../../../src/api/matrix/roomResources';
import type { MembershipOperation } from '../../../src/api/matrix/membershipOperation';
import type { MatrixStoreContext } from '../../../src/api/matrix/types';

const servers: Server[] = [];
afterEach(async() => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture() {
  const graph = new Store(); const engine = new QueryEngine();
  const requests: Array<{ method: string; path: string; caller: string }> = [];
  let bodyMode: 'normal' | 'empty' | 'malformed' = 'normal';
  let readStatus = 200;
  let unreadable = false; let redirect = false; let finalUrlWrong = false; let lostWriteResponse = false;
  const server = createServer((request, response) => { void (async() => {
    const url = new URL(request.url!, base);
    requests.push({ method: request.method!, path: url.pathname, caller: String(request.headers['x-fixture-caller']) });
    if (unreadable) { response.writeHead(403).end(); return; }
    if (redirect) { response.writeHead(302, { Location: '/wrong.ttl' }).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const query = url.searchParams.get('query') ?? (raw.startsWith('query=') ? new URLSearchParams(raw).get('query') : raw);
    if (query && (request.method === 'POST' || url.searchParams.has('query'))) {
      if (/^\s*(?:PREFIX[^\n]*\n\s*)*(?:SELECT|ASK)/iu.test(query)) {
        const stream = await engine.queryBindings(query, { sources: [graph], unionDefaultGraph: true });
        const bindings = await stream.toArray(); const vars = new Set<string>();
        const rows = bindings.map(binding => Object.fromEntries([...binding].map(([key, term]) => {
          vars.add(key.value); return [key.value, { type: term.termType === 'NamedNode' ? 'uri' : term.termType === 'BlankNode' ? 'bnode' : 'literal',
            value: term.value, ...(term.termType === 'Literal' ? { datatype: term.datatype.value } : {}) }];
        })));
        response.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
        response.end(JSON.stringify({ head: { vars: [...vars] }, results: { bindings: rows } })); return;
      }
      await engine.queryVoid(query, { sources: [graph], destination: graph });
      if (lostWriteResponse) { request.socket.destroy(); return; }
      response.writeHead(204).end(); return;
    }
    const quads = graph.getQuads(null, null, null, DataFactory.namedNode(url.href));
    if (!quads.length) { response.writeHead(404).end(); return; }
    const writer = new Writer(); writer.addQuads(quads.map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const ttl = await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
    response.writeHead(readStatus, { 'Content-Type': 'text/turtle' }); response.end(bodyMode === 'empty' ? '' : bodyMode === 'malformed' ? 'this is not Turtle {' : ttl);
  })().catch(() => { response.writeHead(500).end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  const base = `http://127.0.0.1:${address.port}/`;
  const podUrl = `${base}actor/`; const readerPod = `${base}reader/`;
  const actor = `${podUrl}profile/card#me`; const reader = `${readerPod}profile/card#me`;
  const context: MatrixStoreContext = { webId: actor, podUrl, auth: { type: 'solid', webId: actor } };
  const readerContext: MatrixStoreContext = { webId: reader, podUrl: readerPod, auth: { type: 'solid', webId: reader } };
  const roomId = encodeSourceBoundRoomId(chatResource.buildIri(podUrl, { id: 'pdu-room' }));
  const operation: MembershipOperation = { format: 1, operationId: '$frozen-invite', kind: 'invite', phase: 'committed',
    actor: { webId: actor, podUrl }, targetWebId: `${base}target/profile#me`, authority: null,
    expected: { authorWebId: actor, participants: [actor], memberRoles: null, invitation: null },
    event: { createdAt: Date.parse('2026-10-03T23:59:59Z'), content: { membership: 'invite' } }, ownerRecovery: null };
  const compiler = drizzle({ info: { webId: actor, podUrl, isLoggedIn: true }, fetch: async() => { throw new Error('No compiler fetch'); } } as never,
    { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  const fixedId = messageResource.buildId({ id: createHash('sha256').update(operation.operationId).digest('hex'),
    parent: roomChatIri(podUrl, roomId), createdAt: new Date(operation.event.createdAt).toISOString() });
  const messageIri = messageResource.buildIri(podUrl, { id: fixedId });
  const pdu = { event_id: operation.operationId, room_id: roomId, type: 'm.room.member', sender: actor,
    state_key: operation.targetWebId, origin_server_ts: operation.event.createdAt, content: { membership: 'invite' },
    prev_events: ['$first-parent'], auth_events: ['$original-auth'], depth: 7 };
  const anchor = async(): Promise<void> => {
    await engine.queryVoid(compiler.insert(chatResource).values({ id: chatResource.buildId({ id: 'pdu-room' }),
      author: actor, participants: [actor], metadata: { protocols: { matrix: { roomId } } } } as never).toSPARQL().query,
    { sources: [graph], destination: graph });
  };
  const seed = async(): Promise<void> => {
    await anchor();
    const query = compiler.insert(messageResource).values({ id: fixedId, parent: roomChatIri(podUrl, roomId),
      chat: roomChatIri(podUrl, roomId), maker: actor, content: JSON.stringify(pdu.content),
      createdAt: new Date(operation.event.createdAt).toISOString(), metadata: { '@id': `${messageIri}/metadata`,
        protocols: { matrix: { event: pdu, senderWebId: actor } } } } as never).toSPARQL().query;
    const write = buildConditionalEventWrite({ insertQuery: query, messageIri, chatIri: roomChatIri(podUrl, roomId),
      roomDirectory: roomChatIri(podUrl, roomId).split('index.ttl')[0], chatType: String(chatResource.config.type),
      messageType: String(messageResource.config.type), parentPredicate: messageResource.parent.getPredicate(messageResource.config.namespace) });
    await engine.queryVoid(write.query, { sources: [graph], destination: graph });
  };
  const pods = [{ podId: 'actor', baseUrl: podUrl, webId: actor }, { podId: 'reader', baseUrl: readerPod, webId: reader }];
  const source = new CanonicalRoomSource({ pods: { findByResourceIdentifier: async() => pods[0],
    findAllByWebId: async(webId: string) => pods.filter(p => p.webId === webId) } as never,
    callerFetchFor: async() => { throw new Error('Source GET is outside adapter scope'); } });
  const access = { getPodFetch: vi.fn(async(webId: string, request: any) => {
    expect(request.auth.webId).toBe(webId); expect(request.taskCredential).toBeUndefined();
    return (async(input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers); headers.set('x-fixture-caller', webId);
      const response = await fetch(input, { ...init, headers });
      if (finalUrlWrong) Object.defineProperty(response, 'url', { value: `${base}wrong.ttl` });
      return response;
    }) as typeof fetch;
  }) };
  const journal = new InMemoryMatrixEventJournal(); const register = vi.spyOn(journal, 'registerReference');
  const registerEvents = vi.spyOn(journal, 'registerEvents'); const enqueue = vi.fn();
  const reopen = () => new PodMatrixStore({ canonicalSource: source, podAccess: access, journal, outbound: { enqueue }, clock: () => Date.parse('2026-10-05T00:00:00Z') });
  const store = reopen();
  const validate = vi.fn(async() => {});
  const input = () => ({ roomId, operation, actor: context, existingOnly: false, validateCommitted: validate });
  const mutate = (name: string, value: string, literal = false): void => {
    const predicate = messageResource.getColumn(name)!.getPredicate(messageResource.config.namespace);
    graph.removeQuads(graph.getQuads(DataFactory.namedNode(messageIri), DataFactory.namedNode(predicate), null, null));
    graph.addQuad(DataFactory.quad(DataFactory.namedNode(messageIri), DataFactory.namedNode(predicate),
      literal ? DataFactory.literal(value) : DataFactory.namedNode(value), DataFactory.namedNode(messageIri.split('#')[0])));
  };
  return { store, reopen, source, graph, anchor, seed, input, operation, messageIri, fixedId, pdu, context, readerContext, access, requests,
    register, registerEvents, enqueue, validate, mutate, unreadable: () => { unreadable = true; },
    body: (mode: 'empty' | 'malformed') => { bodyMode = mode; },
    partial: () => { readStatus = 206; },
    redirect: () => { redirect = true; }, wrongUrl: () => { finalUrlWrong = true; }, loseWrite: () => { lostWriteResponse = true; } };
}

describe('original actor adapter public ORM/RDF and real loopback HTTP (counted principal, not DPoP)', () => {
  it('rejects invalid operation before network', async() => {
    const store = new PodMatrixStore({});
    await expect(store.projectMembershipInvite({ roomId: '!room', operation: {} as never, actor: { webId: 'https://actor.example/#me' },
      existingOnly: false, validateCommitted: async() => {} })).rejects.toMatchObject({ status: 400 });
  });
  it('keeps the first full PDU and fixed IRI, without reading a newer head', async() => {
    const f = await fixture(); await f.seed();
    const result = await f.store.projectMembershipInvite(f.input());
    expect(result.event).toEqual(f.pdu); expect(result.resourceId).toBe(f.messageIri);
    expect(result.senderWebId).toBe(f.operation.actor.webId);
    expect(f.requests).toHaveLength(1); expect(f.registerEvents).not.toHaveBeenCalled();
    expect(f.register).toHaveBeenCalledTimes(1); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('reopening after midnight still reads the first full body before head or signing work', async() => {
    const f = await fixture(); await f.seed();
    await f.store.projectMembershipInvite(f.input()); f.requests.length = 0;
    const result = await f.reopen().projectMembershipInvite(f.input());
    expect(result.event).toEqual(f.pdu); expect(result.resourceId).toBe(f.messageIri);
    expect(f.requests).toHaveLength(1); expect(f.registerEvents).not.toHaveBeenCalled();
  });
  it('existingOnly uses the real caller own root to read a registered foreign actor resource with zero journal', async() => {
    const f = await fixture(); await f.seed();
    const result = await f.store.projectMembershipInvite({ ...f.input(), actor: f.readerContext, existingOnly: true });
    expect(result.event).toEqual(f.pdu); expect(f.access.getPodFetch).toHaveBeenCalledWith(f.readerContext.webId,
      expect.objectContaining({ podBaseUrl: f.readerContext.podUrl }));
    expect(f.requests[0].caller).toBe(f.readerContext.webId); expect(f.register).not.toHaveBeenCalled();
    expect(f.registerEvents).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['maker', 'provenance', 'datatype', 'duplicate', 'forbidden', 'redirect', 'url', 'empty', 'malformed', 'validator'] as const)('rejects %s before bookkeeping', async mode => {
    const f = await fixture(); await f.seed();
    if (mode === 'maker') f.mutate('maker', f.readerContext.webId);
    if (mode === 'provenance') {
      const protocol = f.graph.getQuads(null, null, null, null).find(q => q.object.termType === 'Literal' && q.object.value.includes('"senderWebId"'))!;
      const json = JSON.parse(protocol.object.value); delete json.matrix.senderWebId;
      f.graph.removeQuad(protocol); f.graph.addQuad(DataFactory.quad(protocol.subject, protocol.predicate,
        DataFactory.literal(JSON.stringify(json), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')), protocol.graph));
    }
    if (mode === 'datatype') {
      const protocol = f.graph.getQuads(null, null, null, null).find(q => q.object.termType === 'Literal' && q.object.value.includes('\"senderWebId\"'))!;
      f.graph.removeQuad(protocol); f.graph.addQuad(DataFactory.quad(protocol.subject, protocol.predicate, DataFactory.literal(protocol.object.value), protocol.graph));
    }
    if (mode === 'duplicate') {
      const predicate = messageResource.maker.getPredicate(messageResource.config.namespace);
      f.graph.addQuad(DataFactory.quad(DataFactory.namedNode(f.messageIri), DataFactory.namedNode(predicate),
        DataFactory.namedNode(f.readerContext.webId), DataFactory.namedNode(f.messageIri.split('#')[0])));
    }
    if (mode === 'empty' || mode === 'malformed') f.body(mode);
    if (mode === 'forbidden') f.unreadable(); if (mode === 'redirect') f.redirect(); if (mode === 'url') f.wrongUrl();
    if (mode === 'validator') f.validate.mockRejectedValueOnce(new Error('source phase revoked'));
    await expect(f.store.projectMembershipInvite(f.input())).rejects.toThrow();
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(0);
    expect(f.register).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('even a public existing winner cannot be journaled by another actor', async() => {
    const f = await fixture(); await f.seed();
    await expect(f.store.projectMembershipInvite({ ...f.input(), actor: f.readerContext })).rejects.toMatchObject({ status: 403 });
    expect(f.requests).toHaveLength(0); expect(f.register).not.toHaveBeenCalled();
  });
  it('absence with no local Chat anchor never fabricates a mirror or confirms 204', async() => {
    const f = await fixture();
    await expect(f.store.projectMembershipInvite(f.input())).rejects.toMatchObject({ status: 503 });
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(1);
    expect(f.graph.getQuads(DataFactory.namedNode(f.messageIri), null, null, null)).toHaveLength(0);
    expect(f.register).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('persists only after exact absence and confirms a real guarded first winner', async() => {
    const f = await fixture(); await f.anchor();
    const result = await f.store.projectMembershipInvite(f.input());
    expect(result.event).toMatchObject({ event_id: f.operation.operationId, origin_server_ts: f.operation.event.createdAt });
    expect(result.resourceId).toBe(f.messageIri); expect(f.registerEvents).not.toHaveBeenCalled();
    expect(f.register).toHaveBeenCalledTimes(1); expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.requests.filter(r => r.method === 'POST')).not.toHaveLength(0);
  });
  it('a nonempty parsed day file with only another subject proves exact absence', async() => {
    const f = await fixture(); await f.anchor();
    f.graph.addQuad(DataFactory.quad(DataFactory.namedNode(`${f.messageIri.split('#')[0]}#other`),
      DataFactory.namedNode('https://example.test/note'), DataFactory.literal('another subject'),
      DataFactory.namedNode(f.messageIri.split('#')[0])));
    const result = await f.store.projectMembershipInvite(f.input());
    expect(result.event?.event_id).toBe(f.operation.operationId);
    expect(f.register).toHaveBeenCalledTimes(1); expect(f.registerEvents).not.toHaveBeenCalled();
  });
  it('adopts only the exact strict first winner after a lost conditional write response', async() => {
    const f = await fixture(); await f.anchor(); f.loseWrite();
    const result = await f.store.projectMembershipInvite(f.input());
    expect(result.event?.event_id).toBe(f.operation.operationId); expect(result.resourceId).toBe(f.messageIri);
    expect(f.register).toHaveBeenCalledTimes(1); expect(f.registerEvents).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('does not infer absence from a partial daily document response', async() => {
    const f = await fixture(); await f.anchor(); f.partial();
    f.graph.addQuad(DataFactory.quad(DataFactory.namedNode(`${f.messageIri.split('#')[0]}#other`),
      DataFactory.namedNode('https://example.test/note'), DataFactory.literal('another subject'),
      DataFactory.namedNode(f.messageIri.split('#')[0])));
    await expect(f.store.projectMembershipInvite(f.input())).rejects.toBeDefined();
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(0);
    expect(f.register).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('existingOnly exact absence is a conflict and performs no history/SQL registration', async() => {
    const f = await fixture();
    await expect(f.store.projectMembershipInvite({ ...f.input(), existingOnly: true })).rejects.toMatchObject({ status: 409 });
    expect(f.requests).toHaveLength(1); expect(f.register).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled();
  });
});
