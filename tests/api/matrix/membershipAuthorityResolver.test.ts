import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { Parser as SparqlParser } from 'sparqljs';
import { Writer, DataFactory, type Quad } from 'n3';
import { getSqliteRuntime, type SqliteDatabase } from '../../../src/storage/SqliteRuntime';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { MembershipAuthorityLocator } from '../../../src/api/matrix/membershipAuthorityLocator';
import { MembershipAuthorityResolver, isMembershipAuthorityProof } from '../../../src/api/matrix/membershipAuthorityResolver';
import type { MatrixStoreContext } from '../../../src/api/matrix/types';

const root = 'https://pod.example/alice/';
const owner = `${root}profile/card#me`;
const bob = 'https://bob.example/profile/card#me';
const sourceIri = chatResource.buildIri(root, { id: 'resolver-room' });
const roomId = encodeSourceBoundRoomId(sourceIri);
const binding = { purpose: 'membership' as const, credentialRef: 'taskcred_explicit', version: 1, issuer: 'https://issuer.example/' };
const caller = (webId = owner): MatrixStoreContext => ({ webId, podUrl: root,
  auth: { type: 'solid', webId, accessToken: 'fixture', tokenType: 'Bearer' } });
const opened: SqliteDatabase[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

async function fixture() {
  const runtime = getSqliteRuntime(); const raw = runtime.openDatabase(':memory:'); opened.push(raw);
  const locator = new MembershipAuthorityLocator(runtime.createDrizzleDatabase(raw));
  let version = 1, current = 1, revoked = false, absent = false, foreign = false, pending = false, retryRevoke = false;
  const network = vi.fn(async() => {
    const db = drizzle({ fetch: globalThis.fetch, info: { webId: owner, podUrl: root, isLoggedIn: true } } as never,
      { podUrl: root, resourcePreparation: 'off', disableInteropDiscovery: true });
    const matrix = { roomId, ...(!absent ? { membershipAuthority: { ...binding, version, ...(foreign ? { issuer: 'https://foreign.example/' } : {}) },
      membershipAuthorityPublication: { eventId: '$published', createdAt: 1, state: pending ? 'pending' : 'complete' } } : {}) };
    const ast = new SparqlParser().parse(db.insert(chatResource).values({ id: chatResource.buildId({ id: 'resolver-room' }), title: 'room', author: owner,
      participants: [ owner, bob ], metadata: { memberRoles: { [owner]: 'owner', [bob]: 'member' }, protocols: { matrix } },
      createdAt: new Date('2026-10-03T00:00:00Z'),
    } as never).toSPARQL().query) as unknown as { updates: Array<{ insert: unknown[] }> };
    const collect = (entries: unknown[]): Quad[] => entries.flatMap(entry => {
      const pattern = entry as { triples?: Quad[]; patterns?: unknown[] };
      return [ ...(pattern.triples ?? []), ...collect(pattern.patterns ?? []) ];
    });
    const writer = new Writer();
    for (const update of ast.updates) writer.addQuads(collect(update.insert).map(q => DataFactory.quad(q.subject, q.predicate, q.object))); 
    const ttl = await new Promise<string>((resolve, reject) => writer.end((error, body) => error ? reject(error) : resolve(body)));
    const response = new Response(ttl, { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: sourceIri.split('#')[0] }); return response;
  });
  const pod = { podId: 'alice-pod', accountId: 'alice', baseUrl: root, webId: owner };
  const pods = { findByResourceIdentifier: vi.fn(async() => pod), findAllByWebId: vi.fn(async() => [ pod ]) };
  const callerFetchFor = vi.fn(async() => network as typeof fetch);
  const canonicalSource = new CanonicalRoomSource({ pods, callerFetchFor });
  const lease = vi.fn(async() => {
    if (revoked) throw new Error('Revoked');
    return { credentialRef: binding.credentialRef, ownerWebId: owner, version: current, issuer: binding.issuer,
      clientId: 'fixture', clientSecret: 'fixture-secret' };
  });
  const getPodFetch = vi.fn(async(webId: string, context: { beforeRequest?: () => Promise<void> }) => {
    expect(webId).toBe(owner);
    return async(input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(sourceIri.split('#')[0]); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
      await context.beforeRequest?.(); const response = await network();
      if (retryRevoke) { revoked = true; await context.beforeRequest?.(); await network(); }
      return response;
    };
  });
  const resolver = new MembershipAuthorityResolver({ canonicalSource, locator, credentials: { lease } as never,
    podAccess: { getPodFetch } as never, issuer: binding.issuer });
  return { resolver, locator, network, lease, getPodFetch, callerFetchFor, canonicalSource, pods,
    rotate: () => { version = 2; current = 2; }, changeBody: () => { version = 2; }, revoke: () => { revoked = true; },
    absent: () => { absent = true; }, foreign: () => { foreign = true; }, pending: () => { pending = true; },
    retryRevoke: () => { retryRevoke = true; } };
}

describe('current membership named authority resolver', () => {
  it('bootstraps with a legitimate caller then keeps Bob actor distinct from Alice task transport', async() => {
    const f = await fixture(); await f.resolver.readAsCaller(roomId, caller()); f.network.mockClear();
    const actor = caller(bob); const proof = await f.resolver.resolveForMembership(roomId, actor);
    expect(isMembershipAuthorityProof(proof)).toBe(true); expect(proof.actorWebId).toBe(bob);
    expect(proof.transportOwnerWebId).toBe(owner); expect(proof.facts.authorWebId).toBe(owner);
    expect('fetch' in proof).toBe(false); expect(JSON.parse(JSON.stringify(proof))).not.toHaveProperty('snapshot');
    expect(JSON.parse(JSON.stringify(proof))).not.toHaveProperty('facts'); expect(actor.auth).toMatchObject({ webId: bob });
    expect(f.network).toHaveBeenCalledTimes(1);
    expect(f.getPodFetch).toHaveBeenCalledWith(owner, expect.objectContaining({
      taskCredential: { credentialRef: binding.credentialRef, version: 1 }, podBaseUrl: root, beforeRequest: expect.any(Function),
    })); expect(f.getPodFetch.mock.calls[0][1]).not.toHaveProperty('auth');
  });
  it('does not guess a candidate for an unjoined actor or an empty locator', async() => {
    const f = await fixture(); await expect(f.resolver.resolveForMembership(roomId, caller(bob))).rejects.toMatchObject({ status: 403 });
    expect(f.lease).not.toHaveBeenCalled(); expect(f.getPodFetch).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled();
    await f.resolver.readAsCaller(roomId, caller('https://outsider.example/card#me'));
    expect(await f.locator.find(sourceIri)).toBeUndefined();
  });
  it('rebuilds a wiped locator only through a current member or owner caller read', async() => {
    const f = await fixture(); await f.resolver.readAsCaller(roomId, caller()); await f.locator.wipe();
    await expect(f.resolver.resolveForMembership(roomId, caller(bob))).rejects.toMatchObject({ status: 403 });
    await f.resolver.readAsCaller(roomId, caller(bob)); expect((await f.resolver.resolveForMembership(roomId, caller(bob))).actorWebId).toBe(bob);
  });
  it('allows absent binding and foreign issuer caller reads but refuses the named path', async() => {
    for (const mode of [ 'absent', 'foreign' ] as const) {
      const f = await fixture(); f[mode](); await expect(f.resolver.readAsCaller(roomId, caller())).resolves.toHaveProperty('authorWebId', owner);
      await expect(f.resolver.resolveForMembership(roomId, caller())).rejects.toMatchObject({ status: 403 });
      expect(f.getPodFetch).not.toHaveBeenCalled(); expect(f.lease).not.toHaveBeenCalled();
    }
  });
  it('refuses old versions before transport and rebuilds after an explicit current caller read', async() => {
    const f = await fixture(); await f.resolver.readAsCaller(roomId, caller()); f.rotate(); f.network.mockClear();
    await expect(f.resolver.resolveForMembership(roomId, caller(bob))).rejects.toMatchObject({ status: 403 });
    expect(f.network).not.toHaveBeenCalled(); expect(await f.locator.find(sourceIri)).toBeUndefined();
    await f.resolver.readAsCaller(roomId, caller()); expect((await f.resolver.resolveForMembership(roomId, caller(bob))).binding.version).toBe(2);
  });
  it('discards a candidate whose current source binding changed without chasing the new reference', async() => {
    const f = await fixture(); await f.resolver.readAsCaller(roomId, caller()); f.changeBody();
    await expect(f.resolver.resolveForMembership(roomId, caller(bob))).rejects.toMatchObject({ status: 403 });
    expect(await f.locator.find(sourceIri)).toBeUndefined(); expect(f.getPodFetch).toHaveBeenCalledTimes(1);
    expect(f.getPodFetch.mock.calls[0][1]).toHaveProperty('taskCredential.version', 1);
  });
  it('refuses pending publication and a forged caller identity', async() => {
    const f = await fixture(); await f.resolver.readAsCaller(roomId, caller()); f.pending();
    await expect(f.resolver.resolveForMembership(roomId, caller())).rejects.toMatchObject({ status: 403 });
    f.lease.mockClear(); await expect(f.resolver.resolveForMembership(roomId, { ...caller(), webId: bob })).rejects.toMatchObject({ status: 403 });
    expect(f.lease).not.toHaveBeenCalled();
  });
  it('rechecks revoked authority on a physical retry and makes no second Pod request', async() => {
    const f = await fixture(); await f.resolver.readAsCaller(roomId, caller()); f.network.mockClear(); f.retryRevoke();
    await expect(f.resolver.resolveForMembership(roomId, caller(bob))).rejects.toMatchObject({ status: 403 });
    expect(f.network).toHaveBeenCalledTimes(1); expect(await f.locator.find(sourceIri)).toBeUndefined();
  });
});


it('keeps branded facts, roles, protocols and RDF evidence immutable', async() => {
  const f = await fixture(); await f.resolver.readAsCaller(roomId, caller());
  const proof = await f.resolver.resolveForMembership(roomId, caller(bob));
  expect(() => (proof.facts.participants as string[]).push('https://forged.example/card#me')).toThrow();
  expect(() => { (proof.facts.memberRoles as Record<string, string>)[bob] = 'owner'; }).toThrow();
  expect(() => { (proof.snapshot.protocols.matrix as { membershipAuthority: { version: number } }).membershipAuthority.version = 99; }).toThrow();
  expect(() => { (proof.snapshot.protocolsQuad as unknown as { _object: unknown })._object = null; }).toThrow();
  expect(proof.snapshot.protocolsQuad.equals(proof.snapshot.quads.find(q => q.equals(proof.snapshot.protocolsQuad))!)).toBe(true);
  expect(isMembershipAuthorityProof(proof)).toBe(true);
});
