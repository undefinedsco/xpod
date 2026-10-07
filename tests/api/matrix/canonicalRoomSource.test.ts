import { describe, expect, it, vi } from 'vitest';
import { Parser as SparqlParser } from 'sparqljs';
import { Writer, DataFactory, type Quad } from 'n3';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { withProtocolMetadata } from '../../../src/api/protocol-metadata';
import type { PodLookupResult } from '../../../src/identity/drizzle/PodLookupRepository';

/**
 * These tests drive the real public ORM (`drizzle` + models Chat TripleBuilder) to produce the exact
 * RDF document a Pod would serve, then feed it through the port's caller fetch only. The transport is
 * synthetic; nothing here is a live Pod.
 *
 * Role positives use the **shared ChatMetadata shape**: `memberRoles` is a *root* metadata fact. It
 * is deliberately never written under `protocols.matrix`.
 */
const POD = 'https://pod-a.example/alice/';
const WEBID = `${POD}profile/card#me`;
const KEY = 'roomkey';
const SOURCE_IRI = chatResource.buildIri(POD, { id: KEY });
const DOCUMENT_IRI = SOURCE_IRI.split('#')[0];
const ROOM_ID = encodeSourceBoundRoomId(SOURCE_IRI);
// A source-bound room's Matrix room id *is* its `!c1_` id.
const ROOM = ROOM_ID;
const ADMIN = `${POD}profile/card#me`;
const MEMBER = `${POD}members/bob#me`;
const OUTSIDER = 'https://pod-c.example/carol/profile/card#me';

function context(overrides: Record<string, unknown> = {}) {
  return {
    webId: WEBID,
    podUrl: POD,
    auth: { type: 'solid', webId: WEBID, clientId: 'device-a' },
    ...overrides,
  } as never;
}

function insertChatRow(row: Record<string, unknown>): Quad[] {
  const db = drizzle(
    { fetch: async() => new Response(null, { status: 204 }), info: { webId: WEBID, isLoggedIn: true, podUrl: POD } },
    { podUrl: POD, schema: { chat: chatResource }, resourcePreparation: 'off' },
  );
  const parsed = new SparqlParser().parse((db.insert(chatResource).values(row as never) as never as { toSPARQL: () => { query: string } }).toSPARQL().query) as any;
  const collect = (patterns: any[]): any[] => patterns.flatMap(p => p.type === 'bgp'
    ? p.triples
    : p.type === 'graph' ? collect(p.patterns ?? [{ type: 'bgp', triples: p.triples ?? [] }]) : []);
  return parsed.updates.flatMap((u: any) => collect(u.insert ?? []))
    .map((t: any) => DataFactory.quad(t.subject, t.predicate, t.object));
}

/** Build the Chat document's quads through the public ORM and serialize them to Turtle. */
function chatQuads(overrides: Record<string, unknown> = {}): Quad[] {
  const row = {
    id: chatResource.buildId({ id: KEY }),
    title: 'room',
    author: WEBID,
    participants: [ WEBID, MEMBER ],
    createdAt: '2026-10-02T00:00:00.000Z',
    // Root metadata memberRoles: the shared ChatMetadata location, NOT protocols.matrix.
    metadata: withProtocolMetadata({ memberRoles: { [ ADMIN ]: 'admin', [ MEMBER ]: 'member' } }, 'matrix', { roomId: ROOM }),
    ...overrides,
  };
  return insertChatRow(row);
}

/** A Chat doc whose roles are in the legacy/wrong `protocols.matrix.memberRoles` location. */
function protocolRolesQuads(memberRoles: Record<string, string>): Quad[] {
  return insertChatRow({
    id: chatResource.buildId({ id: KEY }), title: 'room', author: WEBID, participants: [ WEBID, MEMBER ],
    metadata: withProtocolMetadata({}, 'matrix', { roomId: ROOM, memberRoles }),
  });
}

async function toTurtle(quads: Quad[]): Promise<string> {
  const writer = new Writer();
  writer.addQuads(quads);
  return await new Promise<string>((resolve, reject) =>
    writer.end((error, text) => (error ? reject(error) : resolve(text))));
}

function pod(overrides: Partial<PodLookupResult> = {}): PodLookupResult {
  return { podId: 'pod-a', accountId: 'alice', baseUrl: POD, webId: WEBID, webIds: [ WEBID ], ...overrides };
}

/**
 * Build the port with the real public ORM over a synthetic caller transport. The transport records
 * every request and returns the exact canonical document with a defined final URL.
 */
async function source(options: {
  quads?: Quad[];
  turtle?: string;
  podsByResource?: PodLookupResult | undefined;
  noResourcePod?: boolean;
  podsByWebId?: PodLookupResult[];
  transport?: (url: string, init?: RequestInit) => Response | Promise<Response>;
} = {}) {
  const turtle = options.turtle ?? await toTurtle(options.quads ?? chatQuads());
  const podsByResource = options.noResourcePod ? undefined : (options.podsByResource ?? pod());
  const podsByWebId = options.podsByWebId ?? [ pod() ];
  const requests: { url: string; method: string }[] = [];
  const webIdLookups: string[] = [];
  const callerFetchFor = vi.fn(async(_context: unknown) => (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = String(init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase();
    requests.push({ url, method });
    if (options.transport) return await options.transport(url, init);
    const response = new Response(turtle, { status: 200, headers: { 'content-type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }) as unknown as typeof fetch);
  const port = new CanonicalRoomSource({
    pods: {
      findByResourceIdentifier: async() => podsByResource,
      findAllByWebId: async(webId: string) => { webIdLookups.push(webId); return podsByWebId; },
    } as never,
    callerFetchFor: callerFetchFor as never,
  });
  return { port, requests, callerFetchFor, webIdLookups, turtle };
}

describe('canonical room source read port', () => {
  it('does exactly one canonical GET through the real ORM for the caller and returns current root facts', async() => {
    const { port, requests } = await source();
    const facts = await port.read(ROOM_ID, context());
    expect(facts).toMatchObject({
      roomId: ROOM_ID,
      sourceIri: SOURCE_IRI,
      sourcePodId: 'pod-a',
      sourcePodUrl: POD,
      authorWebId: WEBID,
      participants: [ WEBID, MEMBER ],
      // Root metadata memberRoles, decoded exactly.
      memberRoles: { [ ADMIN ]: 'admin', [ MEMBER ]: 'member' },
    });
    // Exactly one network request, and it is the canonical document GET.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ url: DOCUMENT_IRI, method: 'GET' });
  });

  it('agrees on real ORM empty, single, and multiple participants through the same-body read', async() => {
    // Empty: the public writer emits no participant predicate; the empty RDF set must agree with the
    // empty ORM array, not be treated as unreadable.
    const empty = await (await source({ quads: chatQuads({ participants: [] }) })).port.read(ROOM_ID, context());
    expect(empty.participants).toEqual([]);
    // Single.
    const single = await (await source({ quads: chatQuads({ participants: [ WEBID ] }) })).port.read(ROOM_ID, context());
    expect(single.participants).toEqual([ WEBID ]);
    // Multiple (order-insensitive set agreement).
    const multiple = await (await source({ quads: chatQuads({ participants: [ WEBID, MEMBER ] }) })).port.read(ROOM_ID, context());
    expect(multiple.participants).toEqual([ WEBID, MEMBER ]);
  });

  it('treats true absence of root roles as an empty map that agrees with the ORM row', async() => {
    const quads = insertChatRow({
      id: chatResource.buildId({ id: KEY }), title: 'room', author: WEBID, participants: [ WEBID, MEMBER ],
      // Root metadata has protocols but no memberRoles at all.
      metadata: withProtocolMetadata({}, 'matrix', { roomId: ROOM }),
    });
    const facts = await (await source({ quads })).port.read(ROOM_ID, context());
    expect(facts.memberRoles).toEqual({});
    expect(facts.participants).toEqual([ WEBID, MEMBER ]);
  });

  it('agrees regardless of the metadata property insertion order in the public writer', async() => {
    // `withProtocolMetadata` writes memberRoles first; a direct object writes protocols first. RDF is a
    // set and the agreement is map/set based, so both must yield the same accepted facts.
    const reversed = insertChatRow({
      id: chatResource.buildId({ id: KEY }), title: 'room', author: WEBID, participants: [ WEBID, MEMBER ],
      metadata: { protocols: { matrix: { roomId: ROOM } }, memberRoles: { [ ADMIN ]: 'owner', [ MEMBER ]: 'member' } },
    });
    const facts = await (await source({ quads: reversed })).port.read(ROOM_ID, context());
    expect(facts.memberRoles).toEqual({ [ ADMIN ]: 'owner', [ MEMBER ]: 'member' });
    expect(facts.participants).toEqual([ WEBID, MEMBER ]);
  });

  it('fails closed for a legacy or unknown room id without any network read', async() => {
    const { port, requests, callerFetchFor } = await source();
    await expect(port.read('!legacy:pod-a.example', context())).rejects.toMatchObject({ status: 403 });
    await expect(port.read('!c1_not-base64url:pod-a.example', context())).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(callerFetchFor).not.toHaveBeenCalled();
  });

  it('refuses a service or mismatched auth context before any read', async() => {
    const { port, requests, callerFetchFor } = await source();
    await expect(port.read(ROOM_ID, context({ service: { taskCredential: {} } })))
      .rejects.toMatchObject({ status: 403 });
    await expect(port.read(ROOM_ID, context({ auth: { type: 'solid', webId: 'https://other.example/profile/card#me' } })))
      .rejects.toMatchObject({ status: 403 });
    await expect(port.read(ROOM_ID, context({ auth: { type: 'service' } })))
      .rejects.toMatchObject({ status: 403 });
    expect(requests).toHaveLength(0);
    expect(callerFetchFor).not.toHaveBeenCalled();
  });

  it('fails closed for an unregistered, wrong-root, or same-host different-WebID source without prefetch', async() => {
    const unregistered = await source({ noResourcePod: true });
    await expect(unregistered.port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    expect(unregistered.callerFetchFor).not.toHaveBeenCalled();
    expect(unregistered.requests).toHaveLength(0);

    const otherRoot = pod({ podId: 'pod-b', baseUrl: 'https://pod-a.example/bob/', webIds: [ 'https://pod-a.example/bob/profile/card#me' ] });
    const wrongRoot = await source({ podsByResource: otherRoot });
    await expect(wrongRoot.port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    expect(wrongRoot.callerFetchFor).not.toHaveBeenCalled();

    const noAuthorPod = await source({ podsByWebId: [] });
    await expect(noAuthorPod.port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    // The registry lookup happened, but the author check found no owning Pod.
    expect(noAuthorPod.callerFetchFor).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a redirect, redirected flag, missing/different final URL, a 403, or an unparseable body', async() => {
    // A redirect status.
    await expect((await source({ transport: () => new Response('', { status: 302 }) })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
    // A 200 whose transport reports it was redirected.
    await expect((await source({ transport: url => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'url', { value: url });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    } })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    // A 200 whose final URL is not the canonical document.
    await expect((await source({ transport: url => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'url', { value: 'https://pod-a.example/alice/.data/chat/other/index.ttl' });
      return response;
    } })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    // A 200 with an empty final URL.
    await expect((await source({ transport: () => new Response('', { status: 200 }) })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
    // A 403.
    await expect((await source({ transport: () => new Response('', { status: 403 }) })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
    // An unparseable body.
    await expect((await source({ turtle: 'this is not turtle @@@' })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
  });

  it('rejects a literal or custom-typed participant, a literal author, wrong type, or competing creators', async() => {
    const good = chatQuads();
    const subject = DataFactory.namedNode(SOURCE_IRI);
    const authorPredicate = DataFactory.namedNode(String((chatResource as any).author.getPredicate(chatResource.config.namespace)));
    const participantPredicate = DataFactory.namedNode(String((chatResource as any).participants.getPredicate(chatResource.config.namespace)));
    const typePredicate = DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const replace = (predicate: any, replacement: Quad[]): Quad[] =>
      [ ...good.filter(q => !(q.subject.equals(subject) && q.predicate.equals(predicate))), ...replacement ];
    // A URI-shaped plain literal participant must fail closed.
    await expect((await source({ quads: replace(participantPredicate, [
      DataFactory.quad(subject, participantPredicate, DataFactory.literal(WEBID)),
    ]) })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    // A custom-typed URI literal participant must also fail closed.
    await expect((await source({ quads: replace(participantPredicate, [
      DataFactory.quad(subject, participantPredicate,
        DataFactory.literal(WEBID, DataFactory.namedNode('https://schema.org/URL'))),
    ]) })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    // A literal author.
    await expect((await source({ quads: replace(authorPredicate, [
      DataFactory.quad(subject, authorPredicate, DataFactory.literal(WEBID)),
    ]) })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    // Two competing NamedNode authors.
    await expect((await source({ quads: [
      ...good,
      DataFactory.quad(subject, authorPredicate, DataFactory.namedNode('https://evil.example/card#me')),
    ] })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
    // An rdf:type literal.
    await expect((await source({ quads: replace(typePredicate, [
      DataFactory.quad(subject, typePredicate, DataFactory.literal(String(chatResource.config.type))),
    ]) })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });

  it('accepts exact duplicate RDF quads as a set but rejects a competing real creator', async() => {
    const good = chatQuads();
    const facts = await (await source({ quads: [ ...good, ...good ] })).port.read(ROOM_ID, context());
    expect(facts.authorWebId).toBe(WEBID);
    expect(facts.memberRoles).toEqual({ [ ADMIN ]: 'admin', [ MEMBER ]: 'member' });
    const subject = DataFactory.namedNode(SOURCE_IRI);
    const authorPredicate = DataFactory.namedNode(String((chatResource as any).author.getPredicate(chatResource.config.namespace)));
    await expect((await source({ quads: [
      ...good.filter(q => !(q.subject.equals(subject) && q.predicate.equals(authorPredicate))),
      DataFactory.quad(subject, authorPredicate, DataFactory.namedNode(WEBID)),
      DataFactory.quad(subject, authorPredicate, DataFactory.namedNode('https://evil.example/card#me')),
    ] })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });

  it('rejects an invalid or ambiguous root memberRoles record and never promotes a default role', async() => {
    const withRoles = (memberRoles: unknown): Quad[] => insertChatRow({
      id: chatResource.buildId({ id: KEY }), title: 'room', author: WEBID, participants: [ WEBID ],
      // Root metadata memberRoles.
      metadata: withProtocolMetadata({ memberRoles }, 'matrix', { roomId: ROOM }),
    });
    // A non-WebID key is invalid.
    await expect((await source({ quads: withRoles({ alice: 'owner' }) })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
    // A role outside owner/admin/member is invalid.
    await expect((await source({ quads: withRoles({ [ WEBID ]: 'superadmin' }) })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
    // A role record that is not an object is invalid.
    await expect((await source({ quads: withRoles([ WEBID ]) })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
    // A missing root record means no explicit role, not a promoted default.
    const facts = await (await source({ quads: insertChatRow({
      id: chatResource.buildId({ id: KEY }), title: 'room', author: WEBID, participants: [ WEBID ],
      metadata: withProtocolMetadata({}, 'matrix', { roomId: ROOM }),
    }) })).port.read(ROOM_ID, context());
    expect(facts.memberRoles).toEqual({});
  });

  it('rejects non-xsd:json root role literals (plain, custom, language) despite JSON-shaped text', async() => {
    const good = chatQuads();
    const roleQuad = good.find(q => q.object.termType === 'Literal' && q.predicate.value.endsWith('memberRoles'));
    expect(roleQuad).toBeDefined();
    const value = String((roleQuad!.object as { value: string }).value);
    // A literal that spells the same JSON but is not `xsd:json` (plain/custom/language) is a different
    // RDF term and must not be decoded into roles.
    const tamper = (object: Quad['object']): Quad[] => [
      ...good.filter(q => q !== roleQuad),
      DataFactory.quad(roleQuad!.subject, roleQuad!.predicate, object, roleQuad!.graph),
    ];
    for (const object of [
      DataFactory.literal(value),
      DataFactory.literal(value, DataFactory.namedNode('https://example.org/custom')),
      DataFactory.literal(value, 'en'),
    ]) {
      await expect((await source({ quads: tamper(object) })).port.read(ROOM_ID, context()))
        .rejects.toMatchObject({ status: 403 });
    }
  });

  it('rejects a present but JSON-null root role record', async() => {
    const good = chatQuads();
    const roleQuad = good.find(q => q.object.termType === 'Literal' && q.predicate.value.endsWith('memberRoles'));
    expect(roleQuad).toBeDefined();
    const quads = [
      ...good.filter(q => q !== roleQuad),
      DataFactory.quad(roleQuad!.subject, roleQuad!.predicate,
        DataFactory.literal('null', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')), roleQuad!.graph),
    ];
    await expect((await source({ quads })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });

  it('ignores roles placed only under protocols.matrix and never escalates from the wrong location', async() => {
    // The legacy/wrong location: roles under protocols.matrix.memberRoles. They are not root metadata
    // facts, so they cannot grant any role; the participant facts are still verified.
    const quads = protocolRolesQuads({ [ WEBID ]: 'owner', [ MEMBER ]: 'admin' });
    const facts = await (await source({ quads })).port.read(ROOM_ID, context());
    expect(facts.memberRoles).toEqual({});
    expect(facts.participants).toEqual([ WEBID, MEMBER ]);
    expect(facts.authorWebId).toBe(WEBID);
  });

  it('reflects a root role downgrade and a participant revocation on consecutive fresh reads', async() => {
    const withFacts = (participants: string[], roles: Record<string, string>): Quad[] => insertChatRow({
      id: chatResource.buildId({ id: KEY }), title: 'room', author: WEBID, participants,
      metadata: withProtocolMetadata({ memberRoles: roles }, 'matrix', { roomId: ROOM }),
    });
    const admin = await (await source({ quads: withFacts([ WEBID, MEMBER ], { [ MEMBER ]: 'admin' }) })).port.read(ROOM_ID, context());
    expect(admin.memberRoles).toEqual({ [ MEMBER ]: 'admin' });
    // The next fresh read sees the downgrade and the revocation; nothing is cached.
    const member = await (await source({ quads: withFacts([ MEMBER ], { [ MEMBER ]: 'member' }) })).port.read(ROOM_ID, context());
    expect(member.memberRoles).toEqual({ [ MEMBER ]: 'member' });
    expect(member.participants).toEqual([ MEMBER ]);
  });

  it('lets the caller read the source through their own fetch while the exact author owns it', async() => {
    const { port, requests, callerFetchFor, webIdLookups } = await source();
    // Bob is a participant but a *different* authenticated caller than the source author Alice.
    const bobContext = { webId: MEMBER, podUrl: POD, auth: { type: 'solid', webId: MEMBER } } as never;
    const facts = await port.read(ROOM_ID, bobContext);
    expect(facts.authorWebId).toBe(WEBID);
    expect(facts.sourcePodId).toBe('pod-a');
    expect(facts.sourcePodUrl).toBe(POD);
    // The one read goes through the caller's fetch, resolved for Bob specifically.
    expect(callerFetchFor).toHaveBeenCalledTimes(1);
    expect((callerFetchFor.mock.calls[0][0] as { webId?: string }).webId).toBe(MEMBER);
    expect(requests).toEqual([ { url: DOCUMENT_IRI, method: 'GET' } ]);
    // The exact full author WebID (never a same-host alias) owns the registered source.
    expect(webIdLookups).toEqual([ WEBID ]);
  });

  it('returns verified current facts to a caller who is not a member, without events', async() => {
    // Participants do not include the outsider; the port still reports the verified source facts so a
    // later policy layer can tell "confirmed non-member" from "unreadable".
    const { port } = await source();
    const outsiderContext = { webId: OUTSIDER, podUrl: 'https://pod-c.example/carol/', auth: { type: 'solid', webId: OUTSIDER } } as never;
    const facts = await port.read(ROOM_ID, outsiderContext);
    expect(facts.authorWebId).toBe(WEBID);
    expect(facts.participants).toEqual([ WEBID, MEMBER ]);
    expect(facts.memberRoles).toEqual({ [ ADMIN ]: 'admin', [ MEMBER ]: 'member' });
    expect('events' in facts).toBe(false);
  });

  it('parses a valid relative document against the canonical source document base', async() => {
    // A conforming server may serve the subject as a document-relative IRI. The parser base must be
    // the exact source *document* (not the fragment) so `<#this>` resolves to the canonical source.
    const turtle = await toTurtle(chatQuads());
    const relative = turtle.split(SOURCE_IRI).join('#this');
    // The fixture must actually be relative, else this would silently re-test the absolute path.
    expect(relative).not.toBe(turtle);
    expect(relative).toContain('<#this>');
    const { port, requests } = await source({ turtle: relative });
    const facts = await port.read(ROOM_ID, context());
    expect(facts.sourceIri).toBe(SOURCE_IRI);
    expect(facts.authorWebId).toBe(WEBID);
    expect(requests).toEqual([ { url: DOCUMENT_IRI, method: 'GET' } ]);
  });

  it('forged mirror / local SQL room index cannot relocate the decoded source', async() => {
    // A wrong registry root for the same host still fails closed.
    const wrongRoot = pod({ baseUrl: 'https://pod-a.example/alice-other/' });
    await expect((await source({ podsByResource: wrongRoot })).port.read(ROOM_ID, context()))
      .rejects.toMatchObject({ status: 403 });
    // A forged metadata roomId cannot be used to read a different room.
    const forged = chatQuads({ metadata: withProtocolMetadata({ memberRoles: { [ ADMIN ]: 'owner' } }, 'matrix', { roomId: '!forged:evil.example' }) });
    await expect((await source({ quads: forged })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });
});

describe('canonical membership authority read prerequisite', () => {
  const binding = { purpose: 'membership', credentialRef: ' taskcred-owner ', version: 2, issuer: 'https://foreign-issuer.example/' };
  const withBinding = (value: unknown) => chatQuads({ metadata: withProtocolMetadata(
    { memberRoles: { [ADMIN]: 'admin', [MEMBER]: 'member' } }, 'matrix', { roomId: ROOM, membershipAuthority: value },
  ) });

  const publication = { eventId: '$publication-id', createdAt: 0, state: 'pending' };
  const withPublication = (value: unknown, includeBinding = true) => chatQuads({ metadata: withProtocolMetadata(
    { memberRoles: { [ADMIN]: 'admin' } }, 'matrix', { roomId: ROOM,
      ...(includeBinding ? { membershipAuthority: binding } : {}), membershipAuthorityPublication: value },
  ) });

  it('retains a strict publication and CAS snapshot from the one sealed original body', async() => {
    const { port, requests } = await source({ quads: withPublication(publication) });
    const snapshot = await port.readSnapshot(ROOM_ID, context());
    expect(snapshot.facts.membershipAuthorityPublication).toEqual(publication);
    expect(snapshot.protocolsQuad.object.termType).toBe('Literal');
    expect(snapshot.protocols.matrix).toMatchObject({ membershipAuthority: binding, membershipAuthorityPublication: publication });
    expect(requests).toEqual([{ url: DOCUMENT_IRI, method: 'GET' }]);
  });

  it.each([
    [ 'null', null ], [ 'array', [ publication ] ], [ 'blank id', { ...publication, eventId: ' \t ' } ],
    [ 'negative time', { ...publication, createdAt: -1 } ], [ 'fractional time', { ...publication, createdAt: 0.5 } ],
    [ 'unsafe time', { ...publication, createdAt: Number.MAX_SAFE_INTEGER + 1 } ],
    [ 'wrong phase', { ...publication, state: 'finished' } ], [ 'unknown key', { ...publication, secret: 'fixture' } ],
  ])('refuses a malformed %s publication', async(_label, value) => {
    await expect((await source({ quads: withPublication(value) })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a publication without its binding', async() => {
    await expect((await source({ quads: withPublication(publication, false) })).port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });

  it.each([ [ 'eventId', '$another-event' ], [ 'createdAt', 1 ], [ 'state', 'complete' ] ])
  ('refuses synthetic ORM/raw publication disagreement for %s', async(field, value) => {
    const raw = await toTurtle(withPublication(publication));
    const hydrated = await toTurtle(withPublication({ ...publication, [field]: value }));
    const { port } = await source({ transport: url => {
      const response = new Response(hydrated, { headers: { 'content-type': 'text/turtle' } });
      Object.defineProperty(response, 'url', { value: url });
      Object.defineProperty(response, 'clone', { value: () => new Response(raw) });
      return response;
    } });
    await expect(port.readSnapshot(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });

  it('returns the exact nonsecret binding from the real serializer and reopened ORM without issuer normalization', async () => {
    const quads = withBinding(binding);
    const { port, requests } = await source({ quads: [...quads, ...quads] });
    expect(await port.read(ROOM_ID, context())).toMatchObject({ membershipAuthority: binding });
    expect(requests).toEqual([{ url: DOCUMENT_IRI, method: 'GET' }]);
  });

  it('keeps absent authority legal without inventing a grant', async () => {
    expect(await (await source()).port.read(ROOM_ID, context())).not.toHaveProperty('membershipAuthority');
  });

  it.each([
    ['null', null], ['array', []], ['scalar', 'membership'],
    ['wrong purpose', { ...binding, purpose: 'Membership' }],
    ['missing ref', { purpose: 'membership', version: 2, issuer: binding.issuer }],
    ['empty ref', { ...binding, credentialRef: '' }],
    ['whitespace-only ref', { ...binding, credentialRef: ' \t\n ' }],
    ['empty issuer', { ...binding, issuer: '' }],
    ['whitespace-only issuer', { ...binding, issuer: ' \t\n ' }],
    ['missing version', { purpose: 'membership', credentialRef: binding.credentialRef, issuer: binding.issuer }],
    ['string version', { ...binding, version: '2' }], ['zero version', { ...binding, version: 0 }],
    ['fractional version', { ...binding, version: 1.5 }], ['unsafe version', { ...binding, version: Number.MAX_SAFE_INTEGER + 1 }],
    ['unknown field', { ...binding, clientSecret: 'forbidden-fixture-field' }],
  ])('rejects present %s before returning canonical facts', async (_label, value) => {
    const { port } = await source({ quads: withBinding(value) });
    await expect(port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['purpose', 'other'], ['credentialRef', 'taskcred-other'], ['version', 3], ['issuer', 'https://different.example/'],
  ])('rejects hydration disagreement for %s', async (field, value) => {
    const raw = await toTurtle(withBinding(binding));
    const hydrated = await toTurtle(withBinding({ ...binding, [field as string]: value }));
    // Fault injection: the captured raw proof and ORM body disagree. This verifies the public
    // port refuses inconsistent hydration; a real response clone carries the same original body.
    const { port } = await source({ transport: url => {
      const response = new Response(hydrated, { headers: { 'content-type': 'text/turtle' } });
      Object.defineProperty(response, 'url', { value: url });
      Object.defineProperty(response, 'clone', { value: () => new Response(raw) });
      return response;
    } });
    await expect(port.read(ROOM_ID, context())).rejects.toMatchObject({ status: 403 });
  });
});

describe('canonical member recovery same-body facts', () => {
  const invitation = { id: 'frozen-invite', inviterWebId: WEBID, createdAt: 0 };
  const operation = { format: 1, operationId: 'frozen-event', kind: 'invite', phase: 'committed',
    actor: { webId: WEBID, podUrl: POD }, targetWebId: MEMBER, authority: null,
    expected: { authorWebId: WEBID, participants: [WEBID], memberRoles: null, invitation },
    event: { createdAt: 0, content: { membership: 'invite' } }, ownerRecovery: null };
  function recoveryQuads(fields: Record<string, unknown>, roles?: Record<string, string>) {
    return chatQuads({ metadata: { ...(roles === undefined ? {} : { memberRoles: roles }),
      protocols: { other: { preserved: true }, matrix: { roomId: ROOM, ...fields } } } });
  }
  it('proves complete optional records and retains raw absent versus empty role evidence', async() => {
    for (const roles of [undefined, {}]) {
      const quads = recoveryQuads({ membershipInvitations: { [MEMBER]: invitation }, membershipOperation: operation }, roles);
      const { port, requests } = await source({ quads });
      const snapshot = await port.readSnapshot(ROOM, context());
      expect(snapshot.facts.membershipInvitations).toEqual({ [MEMBER]: invitation });
      expect(snapshot.facts.membershipOperation).toEqual(operation);
      expect(snapshot.quads.filter(q => q.predicate.value.endsWith('#memberRoles'))).toHaveLength(roles === undefined ? 0 : 1);
      expect(snapshot.protocols.other).toEqual({ preserved: true });
      expect(requests).toHaveLength(1);
    }
  });
  it.each([null, [], { ...operation, unknown: true }, { ...operation, event: { ...operation.event, content: { membership: 'invite', reason: 'extra' } } }])('rejects malformed-present operation %j', async(value) => {
    const { port } = await source({ quads: recoveryQuads({ membershipOperation: value }) });
    await expect(port.readSnapshot(ROOM, context())).rejects.toMatchObject({ status: 403 });
  });
  it.each([null, [], { [MEMBER]: { ...invitation, extra: true } }])('rejects malformed-present invitations %j', async(value) => {
    const { port } = await source({ quads: recoveryQuads({ membershipInvitations: value }) });
    await expect(port.readSnapshot(ROOM, context())).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a second differently typed protocol term containing valid recovery JSON', async() => {
    const quads = recoveryQuads({ membershipOperation: operation });
    const protocol = quads.find(q => q.object.termType === 'Literal' && q.object.value.includes('"roomId"'))!;
    quads.push(DataFactory.quad(protocol.subject, protocol.predicate, DataFactory.literal(protocol.object.value)));
    const { port } = await source({ quads });
    await expect(port.readSnapshot(ROOM, context())).rejects.toMatchObject({ status: 403 });
  });
});
