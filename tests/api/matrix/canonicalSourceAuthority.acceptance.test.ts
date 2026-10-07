import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';

const podUrl = 'https://pod.example/alice/';
const alice = `${podUrl}profile/card#me`;
const bob = 'https://pod.example/bob/profile/card#me';
const sourceIri = chatResource.buildIri(podUrl, { id: 'authority-acceptance' });
const document = sourceIri.split('#')[0];
const roomId = encodeSourceBoundRoomId(sourceIri);
const caller = { webId: bob, podUrl: 'https://pod.example/bob/', auth: { type: 'solid', webId: bob } } as never;

async function sourceDocument(roles: unknown, protocolRoles?: unknown, roleTerm?: 'plain' | 'custom' | 'language', nullProtocol = false): Promise<string> {
  // The public serializer omits null properties. Emit a real role term first, then replace its
  // object for the explicit-null negative, so absence and malformed presence remain distinct.
  const serializedRoles = roles === null ? { [bob]: 'member' } : roles;
  const db = drizzle({ info: { isLoggedIn: true, webId: alice, podUrl },
    fetch: async() => { throw new Error('No HTTP during compilation'); } } as never,
  { disableInteropDiscovery: true, resourcePreparation: 'off', podUrl });
  const query = db.insert(chatResource).values({
    id: chatResource.buildId({ id: 'authority-acceptance' }), author: alice, participants: [alice, bob],
    metadata: { '@id': `${sourceIri}/metadata`, memberRoles: serializedRoles,
      protocols: { matrix: { roomId, ...(protocolRoles === undefined ? {} : { memberRoles: protocolRoles }) } } },
  } as never).toSPARQL().query;
  const graph = new Store();
  await new QueryEngine().queryVoid(query, { sources: [graph], destination: graph });
  if (roleTerm || roles === null) {
    const edge = graph.getQuads(`${sourceIri}/metadata`, null, null, null)
      .find(q => q.object.termType === 'Literal' && q.object.value === JSON.stringify(serializedRoles));
    if (!edge || edge.object.termType !== 'Literal') throw new Error('The actual public role literal was not found');
    const object = roles === null ? DataFactory.literal('null', edge.object.datatype)
      : roleTerm === 'language' ? DataFactory.literal(edge.object.value, 'en')
      : roleTerm === 'custom' ? DataFactory.literal(edge.object.value, DataFactory.namedNode('https://example.org/custom'))
      : DataFactory.literal(edge.object.value);
    graph.removeQuad(edge);
    graph.addQuad(DataFactory.quad(edge.subject, edge.predicate, object, edge.graph));
  }
  if (nullProtocol) {
    const edge = graph.getQuads(`${sourceIri}/metadata`, null, null, null)
      .find(q => q.object.termType === 'Literal' && q.object.value === JSON.stringify({ matrix: { roomId } }));
    if (!edge || edge.object.termType !== 'Literal') throw new Error('The actual public protocol literal was not found');
    graph.removeQuad(edge);
    graph.addQuad(DataFactory.quad(edge.subject, edge.predicate, DataFactory.literal('null', edge.object.datatype), edge.graph));
  }
  const writer = new Writer();
  writer.addQuads(graph.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
  return await new Promise((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
}

function reader(body: () => Promise<string>) {
  const transport = vi.fn(async(input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(document);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    const response = new Response(await body(), { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: document });
    return response;
  });
  const callerFetchFor = vi.fn(async(context: unknown) => { expect(context).toBe(caller); return transport; });
  const pod = { podId: 'source-alice', accountId: 'alice', baseUrl: podUrl, webId: alice, webIds: [alice] };
  const port = new CanonicalRoomSource({
    pods: { findByResourceIdentifier: async() => pod, findAllByWebId: async(webId: string) => webId === alice ? [pod] : [] } as never,
    callerFetchFor,
  });
  return { port, transport, callerFetchFor };
}

describe('independent canonical source current-authority acceptance', () => {
  it('reads Alice source using Bob caller authority and the public root memberRoles field', async() => {
    const roles = { [alice]: 'owner', [bob]: 'admin' };
    const { port, transport } = reader(() => sourceDocument(roles));
    const facts = await port.read(roomId, caller);
    expect(facts.authorWebId).toBe(alice);
    expect(facts.participants).toEqual([alice, bob]);
    expect(facts.memberRoles).toEqual(roles);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refreshes role downgrade on the same reader and same caller context', async() => {
    let role = 'admin';
    const { port, transport } = reader(() => sourceDocument({ [bob]: role }));
    expect((await port.read(roomId, caller)).memberRoles[bob]).toBe('admin');
    role = 'member';
    expect((await port.read(roomId, caller)).memberRoles[bob]).toBe('member');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('cannot elevate a root member by adding a conflicting protocol memberRoles mirror', async() => {
    const { port } = reader(() => sourceDocument({ [bob]: 'member' }, { [bob]: 'owner' }));
    expect((await port.read(roomId, caller)).memberRoles[bob]).toBe('member');
  });

  it('rejects an unknown role in the root metadata rather than treating it as absent', async() => {
    const { port, transport } = reader(() => sourceDocument({ [bob]: 'superuser' }));
    await expect(port.read(roomId, caller)).rejects.toMatchObject({ status: 403 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['plain', 'custom', 'language'] as const)('rejects a %s literal containing JSON-shaped role text', async mode => {
    const { port, transport } = reader(() => sourceDocument({ [bob]: 'admin' }, undefined, mode));
    await expect(port.read(roomId, caller)).rejects.toMatchObject({ status: 403 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects an explicit null role record instead of treating it as missing', async() => {
    const { port } = reader(() => sourceDocument(null));
    await expect(port.read(roomId, caller)).rejects.toMatchObject({ status: 403 });
  });

  it('returns an authority refusal for a null protocol object', async() => {
    const { port } = reader(() => sourceDocument({ [bob]: 'member' }, undefined, undefined, true));
    await expect(port.read(roomId, caller)).rejects.toMatchObject({ status: 403 });
  });
});
