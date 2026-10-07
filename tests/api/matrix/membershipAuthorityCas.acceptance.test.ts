import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { describe, expect, it } from 'vitest';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { buildMembershipAuthorityCas } from '../../../src/api/matrix/membershipAuthorityPublication';

const podUrl = 'https://root.example/cas/';
const owner = `${podUrl}profile/card#me`;
const iri = chatResource.buildIri(podUrl, { id: 'root-publication-cas' });
const document = iri.split('#')[0];
const roomId = encodeSourceBoundRoomId(iri);
const context = { webId: owner, podUrl, auth: { type: 'solid', webId: owner } } as never;
const binding = { purpose: 'membership', credentialRef: 'root-nonsecret-pointer', version: 1,
  issuer: 'https://root.example/' };

async function fixture(roles = true) {
  const db = drizzle({ info: { webId: owner, podUrl, isLoggedIn: true },
    fetch: async() => { throw new Error('Compiler must not make network requests'); } } as never,
  { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  const graph = new Store();
  const engine = new QueryEngine();
  await engine.queryVoid(db.insert(chatResource).values({
    id: chatResource.buildId({ id: 'root-publication-cas' }), author: owner, participants: [ owner ],
    title: 'must survive', metadata: { '@id': `${iri}/metadata`, unknownRoot: { value: 'keep' },
      ...(roles ? { memberRoles: { [owner]: 'owner' } } : {}),
      protocols: { foreign: { nested: [ 'keep', 3 ] }, matrix: { roomId, unknownMatrix: { value: 'keep' } } },
    },
  } as never).toSPARQL().query, { sources: [ graph ], destination: graph });
  let gets = 0;
  const pod = { podId: 'root-cas', baseUrl: podUrl, webId: owner, webIds: [ owner ] };
  const source = new CanonicalRoomSource({ pods: { findByResourceIdentifier: async() => pod,
    findAllByWebId: async(webId: string) => webId === owner ? [ pod ] : [] } as never,
  callerFetchFor: async() => async(input, init) => {
    expect(String(input)).toBe(document);
    expect(init?.redirect).toBe('error');
    gets++;
    const writer = new Writer();
    writer.addQuads(graph.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const ttl = await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
    const response = new Response(ttl, { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: document });
    return response;
  } });
  const snapshot = await source.readSnapshot(roomId, context);
  expect(gets).toBe(1);
  const next = structuredClone(snapshot.protocols);
  next.matrix = { ...(next.matrix as object), membershipAuthority: binding,
    membershipAuthorityPublication: { eventId: '$root-fixed', createdAt: 1790985600000, state: 'pending' } };
  const query = buildMembershipAuthorityCas(db, snapshot, next);
  return { graph, engine, source, snapshot, next, query };
}

describe('root independent public ORM canonical publication CAS', () => {
  it.each([ true, false ])('changes exactly the protocol term and preserves all other facts (roles present: %s)', async(roles) => {
    const f = await fixture(roles);
    const before = f.graph.getQuads(null, null, null, null);
    const old = before.find(q => q.subject.equals(f.snapshot.protocolsQuad.subject)
      && q.predicate.equals(f.snapshot.protocolsQuad.predicate))!;
    await f.engine.queryVoid(f.query, { sources: [ f.graph ], destination: f.graph });
    expect(f.graph.has(old)).toBe(false);
    for (const q of before.filter(q => !q.equals(old))) expect(f.graph.has(q)).toBe(true);
    expect(f.graph.size).toBe(before.length);
    const reopened = await f.source.readSnapshot(roomId, context);
    expect(reopened.protocols).toEqual(f.next);
    expect(reopened.facts.membershipAuthority).toEqual(binding);
    // Replaying the stale CAS cannot create another term or overwrite a later publication.
    await f.engine.queryVoid(f.query, { sources: [ f.graph ], destination: f.graph });
    expect(f.graph.size).toBe(before.length);
    expect((await f.source.readSnapshot(roomId, context)).protocols).toEqual(f.next);
  });

  it.each([ 'type', 'author', 'metadata', 'participants', 'memberRoles', 'protocols' ])
  ('rejects an additional %s term after the sealed snapshot', async(field) => {
    const f = await fixture();
    const predicate = field === 'type' ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      : [ 'memberRoles', 'protocols' ].includes(field)
        ? f.snapshot.protocolsQuad.predicate.value.replace(/protocols$/, field)
        : chatResource.getColumn(field)!.getPredicate(chatResource.config.namespace);
    const subject = [ 'memberRoles', 'protocols' ].includes(field) ? f.snapshot.metadataIri : iri;
    const current = f.graph.getQuads(DataFactory.namedNode(subject), DataFactory.namedNode(predicate), null, null)[0];
    const extra = DataFactory.quad(DataFactory.namedNode(subject), DataFactory.namedNode(predicate),
      field === 'protocols' || field === 'memberRoles'
        ? DataFactory.literal(current.object.value, DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#string'))
        : DataFactory.namedNode('https://root.example/changed#term'), current.graph);
    f.graph.addQuad(extra);
    const before = f.graph.getQuads(null, null, null, null);
    await f.engine.queryVoid(f.query, { sources: [ f.graph ], destination: f.graph });
    expect(f.graph.size).toBe(before.length);
    for (const q of before) expect(f.graph.has(q)).toBe(true);
  });

  it('fences absent root roles against concurrent role creation', async() => {
    const f = await fixture(false);
    const protocol = f.graph.getQuads(null, null, null, null)
      .find(q => q.predicate.equals(f.snapshot.protocolsQuad.predicate))!;
    f.graph.addQuad(DataFactory.quad(protocol.subject,
      DataFactory.namedNode(protocol.predicate.value.replace(/protocols$/, 'memberRoles')),
      DataFactory.literal(JSON.stringify({ [owner]: 'owner' }), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')),
      protocol.graph));
    const before = f.graph.getQuads(null, null, null, null);
    await f.engine.queryVoid(f.query, { sources: [ f.graph ], destination: f.graph });
    for (const q of before) expect(f.graph.has(q)).toBe(true);
    expect(f.graph.size).toBe(before.length);
  });
});
