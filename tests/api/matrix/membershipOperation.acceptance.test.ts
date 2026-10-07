import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { parseMembershipInvitations, parseMembershipOperation } from '../../../src/api/matrix/membershipOperation';
import { buildCanonicalRoomCas } from '../../../src/api/matrix/canonicalRoomCas';
import { MembershipAuthorityPublisher } from '../../../src/api/matrix/membershipAuthorityPublication';

const podUrl = 'https://source.example/root-operation/';
const owner = `${podUrl}profile/card#me`;
const member = 'https://member.example/profile/card#me';
const sourceIri = chatResource.buildIri(podUrl, { id: 'root-operation' });
const documentIri = sourceIri.split('#')[0];
const roomId = encodeSourceBoundRoomId(sourceIri);
const binding = { purpose: 'membership', credentialRef: 'named-root-operation', version: 1, issuer: 'https://issuer.example/' };
const invitation = { id: '$root-invitation', inviterWebId: owner, createdAt: 1 };
const operation = () => ({ format: 1, operationId: '$root-operation', kind: 'invite', phase: 'committed',
  actor: { webId: owner, podUrl }, targetWebId: member, authority: null,
  expected: { authorWebId: owner, participants: [ owner ], memberRoles: null, invitation: null },
  event: { createdAt: 2, content: { membership: 'invite' } }, ownerRecovery: null });

async function rdf(matrix: Record<string, unknown>, roles?: Record<string, string>) {
  const db = drizzle({ info: { webId: owner, isLoggedIn: true, podUrl },
    fetch: async() => { throw new Error('Serialization must not fetch'); } } as never,
  { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  const graph = new Store();
  await new QueryEngine().queryVoid(db.insert(chatResource).values({
    id: chatResource.buildId({ id: 'root-operation' }), author: owner, participants: [ owner ],
    metadata: { '@id': `${sourceIri}/metadata`, ...(roles === undefined ? {} : { memberRoles: roles }),
      protocols: { unrelated: { preserved: true }, matrix: { roomId, ...matrix } },
      settings: { unrelated: 'preserve verbatim' } },
  } as never).toSPARQL().query, { sources: [ graph ], destination: graph });
  return { db, graph };
}

async function turtle(graph: Store) {
  const writer = new Writer();
  writer.addQuads(graph.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
  return await new Promise<string>((resolve, reject) => writer.end((error, ttl) => error ? reject(error) : resolve(ttl)));
}

function sourceFor(graph: Store) {
  const pod = { podId: 'root-operation', accountId: 'owner', baseUrl: podUrl, webId: owner, webIds: [ owner ] };
  const requests = vi.fn(async(input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(documentIri);
    expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
    const response = new Response(await turtle(graph), { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: documentIri }); return response;
  });
  return { source: new CanonicalRoomSource({ pods: { findByResourceIdentifier: async() => pod,
    findAllByWebId: async(webId: string) => webId === owner ? [ pod ] : [] }, callerFetchFor: async() => requests }), requests };
}
const caller = { webId: owner, podUrl, auth: { type: 'solid', webId: owner } } as never;

describe('root strict membership recovery record acceptance', () => {
  it('preserves absent vs present-empty expected roles and grantless owner invitation', () => {
    expect(parseMembershipOperation(operation())).toEqual(operation());
    const empty = { ...operation(), expected: { ...operation().expected, memberRoles: {} } };
    expect(parseMembershipOperation(empty)).toEqual(empty);
    expect(parseMembershipOperation(empty)).not.toEqual(parseMembershipOperation(operation()));
    expect(parseMembershipInvitations({ [member]: invitation })).toEqual({ [member]: invitation });
  });

  it.each([
    [ 'unknown field', () => ({ ...operation(), madeUp: true }) ],
    [ 'invalid phase', () => ({ ...operation(), phase: 'join-read-pending' }) ],
    [ 'join without named authority', () => ({ ...operation(), kind: 'join', phase: 'join-read-pending',
      event: { createdAt: 2, content: { membership: 'join' } } }) ],
    [ 'content/kind disagreement', () => ({ ...operation(), event: { createdAt: 2, content: { membership: 'leave' } } }) ],
    [ 'extra event content', () => ({ ...operation(), event: { createdAt: 2, content: { membership: 'invite', extra: true } } }) ],
    [ 'duplicate expected participant', () => ({ ...operation(), expected: { ...operation().expected, participants: [ owner, owner ] } }) ],
    [ 'invalid role', () => ({ ...operation(), expected: { ...operation().expected, memberRoles: { [owner]: 'super-admin' } } }) ],
    [ 'invalid actor identity', () => ({ ...operation(), actor: { webId: '@alice:source', podUrl } }) ],
    [ 'negative event time', () => ({ ...operation(), event: { ...operation().event, createdAt: -1 } }) ],
    [ 'extra recovery field', () => ({ ...operation(), ownerRecovery: { generation: 1, binding, secret: 'not-allowed' } }) ],
    [ 'zero recovery generation', () => ({ ...operation(), ownerRecovery: { generation: 0, binding } }) ],
    [ 'unknown purpose', () => ({ ...operation(), authority: { ...binding, purpose: 'chat' } }) ],
    [ 'malformed invitation', () => ({ ...operation(), expected: { ...operation().expected,
      invitation: { ...invitation, inviterWebId: '@alice:source' } } }) ],
  ])('rejects %s as malformed-present data', (_name, value) => {
    expect(parseMembershipOperation(value())).toBeUndefined();
  });

  it.each([ null, [], { [member]: { ...invitation, unknown: true } }, { '@bob:server': invitation } ])(
    'rejects malformed invitation map %#', value => {
      expect(parseMembershipInvitations(value)).toBeUndefined();
    });

  it('returns verified operation and invitations from the same public ORM/RDF response', async() => {
    const { graph } = await rdf({ membershipOperation: operation(), membershipInvitations: { [member]: invitation } });
    const { source, requests } = sourceFor(graph);
    const facts = await source.read(roomId, caller);
    expect(facts).toMatchObject({ membershipOperation: operation(), membershipInvitations: { [member]: invitation } });
    expect(requests).toHaveBeenCalledOnce();
  });

  it.each([ { membershipOperation: null }, { membershipOperation: { ...operation(), unknown: true } },
    { membershipInvitations: null }, { membershipInvitations: { [member]: { ...invitation, unknown: true } } } ])(
    'rejects malformed-present protocol data in actual RDF %#', async matrix => {
      const { graph } = await rdf(matrix);
      await expect(sourceFor(graph).source.read(roomId, caller)).rejects.toMatchObject({ status: 403 });
    });

  it('refuses unfinished membership publication before creating any Pod write handle or PDU', async() => {
    const { graph } = await rdf({ membershipOperation: operation(), membershipAuthority: binding,
      membershipAuthorityPublication: { eventId: '$earlier-authority', createdAt: 1, state: 'complete' } });
    const { source } = sourceFor(graph);
    const getPodFetch = vi.fn(async() => { throw new Error('An unfinished operation must be checked before any write handle'); });
    const project = vi.fn(async() => { throw new Error('An unfinished operation must not project events'); });
    const publisher = new MembershipAuthorityPublisher({ canonicalSource: source,
      credentials: { lease: async() => ({ ...binding, ownerWebId: owner }) } as never,
      podAccess: { getPodFetch }, issuer: binding.issuer });
    await expect(publisher.publish(roomId, binding, caller, project)).rejects.toMatchObject({ status: 409 });
    expect(getPodFetch).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it.each([ undefined, {} ])('changes roster/roles/protocol together and preserves unrelated RDF (%#)', async originalRoles => {
    const { db, graph } = await rdf({ membershipOperation: operation() }, originalRoles);
    const { source } = sourceFor(graph);
    const snapshot = await source.readSnapshot(roomId, caller);
    const nextProtocols = structuredClone(snapshot.protocols);
    (nextProtocols.matrix as any).membershipOperation.phase = 'complete';
    const nextRoles = { [owner]: 'owner' as const, [member]: 'member' as const };
    const query = buildCanonicalRoomCas(db, snapshot, { protocols: nextProtocols,
      participants: [ owner, member ], memberRoles: nextRoles });
    const before = new Store(graph.getQuads(null, null, null, null));
    await new QueryEngine().queryVoid(query, { sources: [ graph ], destination: graph });
    const facts = await source.read(roomId, caller);
    expect(new Set(facts.participants)).toEqual(new Set([ owner, member ]));
    expect(facts.memberRoles).toEqual(nextRoles);
    expect(facts.membershipOperation?.phase).toBe('complete');
    const protocolPredicate = snapshot.protocolsQuad.predicate.value;
    const namespace = protocolPredicate.slice(0, Math.max(protocolPredicate.lastIndexOf('/'), protocolPredicate.lastIndexOf('#')) + 1);
    const predicates = new Set([ chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace),
      `${namespace}memberRoles`,
      snapshot.protocolsQuad.predicate.value ]);
    const beforeUnchanged = before.getQuads(null, null, null, null).filter(q => !predicates.has(q.predicate.value));
    for (const quad of beforeUnchanged) expect(graph.has(quad)).toBe(true);
    const after = new Store(graph.getQuads(null, null, null, null));
    const staleRollback = buildCanonicalRoomCas(db, snapshot, {
      protocols: snapshot.protocols, participants: [ owner ], memberRoles: originalRoles ?? null,
    });
    await new QueryEngine().queryVoid(staleRollback, { sources: [ graph ], destination: graph });
    expect(graph.size).toBe(after.size);
    for (const quad of after.getQuads(null, null, null, null)) expect(graph.has(quad)).toBe(true);
    // Stale replays cannot change the complete operation back to committed or duplicate terms.
    expect((await source.read(roomId, caller)).membershipOperation?.phase).toBe('complete');
  });
});
