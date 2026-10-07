import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { MembershipAuthorityResolver, isMembershipAuthorityProof } from '../../../src/api/matrix/membershipAuthorityResolver';
import { MembershipAuthorityLocator } from '../../../src/api/matrix/membershipAuthorityLocator';
import { getTaskCredentialDatabase, resetTaskCredentialDatabases } from '../../../src/api/tasks/TaskCredentialDatabase';
import { TaskCredentialStore } from '../../../src/api/tasks/TaskCredentialStore';
import { getSqliteRuntime } from '../../../src/storage/SqliteRuntime';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../../src/security/secret-cell';

const podUrl = 'https://pod.example/root-resolver/';
const owner = `${podUrl}profile/card#me`;
const member = 'https://member.example/card#me';
const outsider = 'https://outsider.example/card#me';
const issuer = 'https://issuer.example/';
const sourceIri = chatResource.buildIri(podUrl, { id: 'root-resolver' });
const documentIri = sourceIri.split('#')[0];
const roomId = encodeSourceBoundRoomId(sourceIri);
const caller = (webId: string) => ({ webId, podUrl: `${new URL(webId).origin}/`, auth: { type: 'solid', webId } }) as never;

/** Public ORM/RDF and real SQL/vault; the Pod transport is a counted adapter, not a live Gateway. */
async function fixture(run: (f: Awaited<ReturnType<typeof openFixture>>) => Promise<void>) {
  const base = path.resolve('.test-data/solid-multiparty-acceptance/provider-b/root-review/resolver-fixtures');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'root-'));
  const f = await openFixture(directory);
  try { await run(f); } finally {
    for (const database of f.databases) database.close();
    resetTaskCredentialDatabases();
    await rm(directory, { recursive: true, force: true });
  }
}

async function openFixture(directory: string) {
  const now = new Date('2026-10-03T00:00:00Z');
  const credentials = new TaskCredentialStore({
    database: getTaskCredentialDatabase(`sqlite:${path.join(directory, 'vault.sqlite')}`), now: () => now,
    vault: new SecretCellVault({ rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'fixture',
      keys: { fixture: Buffer.alloc(32, 9) } }) }),
  });
  const grant = await credentials.grant({ ownerWebId: owner, issuer, clientId: 'resolver-fixture-client',
    clientSecret: 'resolver-fixture-secret', status: 'active', expiresAt: new Date(now.getTime() + 60000) });
  const binding = { purpose: 'membership' as const, credentialRef: grant.credentialRef, version: 1, issuer };
  const databases: ReturnType<ReturnType<typeof getSqliteRuntime>['openDatabase']>[] = [];
  const openLocator = () => {
    const runtime = getSqliteRuntime();
    const database = runtime.openDatabase(path.join(directory, 'locator.sqlite'));
    databases.push(database);
    return new MembershipAuthorityLocator(runtime.createDrizzleDatabase(database));
  };
  const locator = openLocator();
  let protocols: Record<string, unknown> = { roomId, membershipAuthority: binding,
    membershipAuthorityPublication: { eventId: '$root-published', createdAt: 1, state: 'complete' } };
  let participants = [ owner, member ];
  let author = owner;
  let beforeTaskTransport: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  const body = async() => {
    const db = drizzle({ info: { webId: owner, isLoggedIn: true, podUrl },
      fetch: async() => { throw new Error('Compilation must not fetch'); } } as never,
    { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
    const query = db.insert(chatResource).values({ id: chatResource.buildId({ id: 'root-resolver' }), author,
      participants, metadata: { '@id': `${sourceIri}/metadata`, protocols: { matrix: protocols } } } as never).toSPARQL().query;
    const graph = new Store();
    await new QueryEngine().queryVoid(query, { sources: [ graph ], destination: graph });
    const writer = new Writer();
    writer.addQuads(graph.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    return await new Promise<string>((resolve, reject) => writer.end((error, ttl) => error ? reject(error) : resolve(ttl)));
  };
  const transport = async(input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(documentIri);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    requests.push(url);
    const response = new Response(await body(), { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: documentIri });
    return response;
  };
  const pod = { podId: 'root-resolver', accountId: 'owner', baseUrl: podUrl, webId: owner, webIds: [ owner ] };
  const source = new CanonicalRoomSource({ pods: { findByResourceIdentifier: async() => pod,
    findAllByWebId: async(webId: string) => webId === owner ? [ pod ] : [] },
  callerFetchFor: async(_context, beforeRequest) => async(input, init) => {
    await beforeRequest?.(); return await transport(input, init);
  } });
  const podAccess = { getPodFetch: vi.fn(async(webId: string, request: any) => {
    expect(webId).toBe(owner);
    expect(request.auth).toBeUndefined();
    expect(request.taskCredential).toEqual({ credentialRef: binding.credentialRef, version: binding.version });
    expect(request.taskCredential.ownerGrant).toBeUndefined();
    expect(request.beforeRequest).toBeTypeOf('function');
    await beforeTaskTransport?.();
    return async(input: RequestInfo | URL, init?: RequestInit) => {
      await request.beforeRequest(); return await transport(input, init);
    };
  }) };
  const resolverFor = (candidateLocator = locator) => new MembershipAuthorityResolver({ canonicalSource: source,
    locator: candidateLocator, credentials, podAccess, issuer });
  return { credentials, binding, locator, openLocator, resolver: resolverFor(), resolverFor, source, requests, podAccess,
    databases, setProtocols: (value: Record<string, unknown>) => { protocols = value; },
    setParticipants: (value: string[]) => { participants = value; }, setAuthor: (value: string) => { author = value; },
    beforeTaskTransport: (callback: () => Promise<void>) => { beforeTaskTransport = callback; } };
}

describe('root independent current membership authority resolver', () => {
  it('keeps Bob actor separate from Alice transport and verifies current source after SQL reopen', async() => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(member));
      expect(await f.locator.find(sourceIri)).toMatchObject({ ownerWebId: owner, binding: f.binding });
      f.requests.length = 0;
      const proof = await f.resolverFor(f.openLocator()).resolveForMembership(roomId, caller(member));
      expect(proof).toMatchObject({ actorWebId: member, transportOwnerWebId: owner,
        binding: f.binding, facts: { sourceIri, authorWebId: owner } });
      expect(f.requests).toEqual([ documentIri ]);
      expect(f.podAccess.getPodFetch).toHaveBeenCalledOnce();
      expect('fetch' in proof).toBe(false);
      expect('write' in proof).toBe(false);
      expect((await f.credentials.listForOwner(owner))[0].lastUsedAt).toBeUndefined();
    });
  });

  it('wipes only candidate SQL; current legal caller rebuilds it and vault grant remains usable', async() => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(owner));
      await f.locator.wipe(); f.requests.length = 0;
      await expect(f.resolver.resolveForMembership(roomId, caller(member))).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toEqual([]);
      expect(f.podAccess.getPodFetch).not.toHaveBeenCalled();
      await expect(f.credentials.lease({ credentialRef: f.binding.credentialRef, ownerWebId: owner, version: 1,
        recordUsage: false })).resolves.toMatchObject({ version: 1 });
      await f.resolver.readAsCaller(roomId, caller(member));
      await expect(f.resolver.resolveForMembership(roomId, caller(member))).resolves.toMatchObject({ actorWebId: member });
    });
  });

  it('does not derive authority from an outsider who can read a public Chat', async() => {
    await fixture(async f => {
      await expect(f.resolver.readAsCaller(roomId, caller(outsider))).resolves.toMatchObject({ authorWebId: owner });
      expect(await f.locator.find(sourceIri)).toBeUndefined();
      await expect(f.resolver.resolveForMembership(roomId, caller(outsider))).rejects.toMatchObject({ status: 403 });
      expect(f.podAccess.getPodFetch).not.toHaveBeenCalled();
    });
  });

  it.each([ 'absent', 'foreign' ])('preserves ordinary %s binding reads without task authority', async variant => {
    await fixture(async f => {
      f.setProtocols({ roomId, ...(variant === 'foreign' ? {
        membershipAuthority: { ...f.binding, issuer: 'https://other.example/' },
        membershipAuthorityPublication: { eventId: '$remote', createdAt: 1, state: 'complete' },
      } : {}) });
      await expect(f.resolver.readAsCaller(roomId, caller(member))).resolves.toMatchObject({ sourceIri });
      f.requests.length = 0;
      await expect(f.resolver.resolveForMembership(roomId, caller(member))).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toEqual([]);
      expect(f.podAccess.getPodFetch).not.toHaveBeenCalled();
    });
  });

  it.each([ 'binding', 'pending', 'author' ])('rejects changed %s proof after cached discovery', async variant => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(owner)); f.requests.length = 0;
      if (variant === 'author') f.setAuthor(member);
      else f.setProtocols({ roomId, membershipAuthority: { ...f.binding, ...(variant === 'binding' ? { version: 2 } : {}) },
        membershipAuthorityPublication: { eventId: '$root-published', createdAt: 1,
          state: variant === 'pending' ? 'pending' : 'complete' } });
      await expect(f.resolver.resolveForMembership(roomId, caller(member))).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(1);
      expect(await f.locator.find(sourceIri)).toBeUndefined();
      expect(f.podAccess.getPodFetch).toHaveBeenCalledOnce();
    });
  });

  it('refuses a rotated lease before selecting the owner task transport', async() => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(owner)); f.requests.length = 0;
      await f.credentials.rotate(f.binding.credentialRef, { clientId: 'rotated-client', clientSecret: 'rotated-secret', expectedVersion: 1 });
      await expect(f.resolver.resolveForMembership(roomId, caller(member))).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toEqual([]);
      expect(f.podAccess.getPodFetch).not.toHaveBeenCalled();
    });
  });

  it('rechecks current lease at the physical request boundary after transport construction', async() => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(owner)); f.requests.length = 0;
      f.beforeTaskTransport(async() => { await f.credentials.revoke(f.binding.credentialRef); });
      await expect(f.resolver.resolveForMembership(roomId, caller(member))).rejects.toMatchObject({ status: 403 });
      expect(f.podAccess.getPodFetch).toHaveBeenCalledOnce();
      expect(f.requests).toEqual([]);
    });
  });

  it('rejects changed caller identity before task resolution and retains caller-only source contract', async() => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(owner)); f.requests.length = 0;
      const bad = { webId: member, auth: { type: 'solid', webId: owner } } as never;
      await expect(f.resolver.resolveForMembership(roomId, bad)).rejects.toMatchObject({ status: 403 });
      await expect(f.source.read(roomId, { webId: owner, service: {} } as never)).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toEqual([]);
      expect(f.podAccess.getPodFetch).not.toHaveBeenCalled();
    });
  });

  it('does not allow verified facts to be changed after the opaque proof is registered', async() => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(owner));
      const proof = await f.resolver.resolveForMembership(roomId, caller(member));
      expect(isMembershipAuthorityProof(proof)).toBe(true);
      expect(isMembershipAuthorityProof({ ...proof })).toBe(false);
      try { (proof.facts.participants as string[]).push(outsider); } catch { /* A frozen array rejects mutation. */ }
      try { (proof.facts.memberRoles as Record<string, string>)[outsider] = 'admin'; } catch { /* A frozen role map rejects mutation. */ }
      try { (proof.snapshot.protocols.matrix as any).membershipAuthority.version = 999; } catch { /* Frozen evidence. */ }
      expect(proof.facts.participants).not.toContain(outsider);
      expect(proof.facts.memberRoles[outsider]).toBeUndefined();
      expect((proof.snapshot.protocols.matrix as any).membershipAuthority.version).toBe(1);
    });
  });

  it.each([ 'sourcePodId', 'sourceRoot' ])('does not perform a named GET for a poisoned %s cache candidate', async field => {
    await fixture(async f => {
      await f.resolver.readAsCaller(roomId, caller(owner));
      const candidate = (await f.locator.find(sourceIri))!;
      await f.locator.remember({ ...candidate, [field]: field === 'sourceRoot' ? 'https://wrong.example/' : 'wrong-pod' });
      f.requests.length = 0;
      await expect(f.resolver.resolveForMembership(roomId, caller(member))).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toEqual([]);
      expect(await f.locator.find(sourceIri)).toBeUndefined();
    });
  });

  it('does not accept a caller constructed named-read capability', async() => {
    await fixture(async f => {
      const forged = { sourceIri, sourcePodId: 'root-resolver', sourceRoot: podUrl,
        ownerWebId: owner, binding: f.binding };
      await expect(f.source.readNamedSnapshot(roomId, forged)).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toEqual([]);
      expect(f.podAccess.getPodFetch).not.toHaveBeenCalled();
    });
  });
});
