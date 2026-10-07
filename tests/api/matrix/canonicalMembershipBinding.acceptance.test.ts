import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { getTaskCredentialDatabase, resetTaskCredentialDatabases } from '../../../src/api/tasks/TaskCredentialDatabase';
import { createTaskCredentialSource, TaskCredentialStore } from '../../../src/api/tasks/TaskCredentialStore';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../../src/security/secret-cell';

const podUrl = 'https://pod.example/root-binding/';
const owner = `${podUrl}profile/card#me`;
const member = 'https://pod.example/member/profile/card#me';
const sourceIri = chatResource.buildIri(podUrl, { id: 'membership-binding' });
const documentIri = sourceIri.split('#')[0];
const roomId = encodeSourceBoundRoomId(sourceIri);
const issuer = 'https://issuer.example/';
const binding = { purpose: 'membership', credentialRef: ' taskcred_root-binding ', version: 1, issuer };
const context = { webId: member, podUrl: 'https://pod.example/member/', auth: { type: 'solid', webId: member } } as never;

async function sourceBody(value: unknown, options: { absent?: boolean; extraValue?: unknown; repeatIdentical?: boolean } = {}) {
  const db = drizzle({ info: { webId: owner, isLoggedIn: true, podUrl },
    fetch: async() => { throw new Error('Compilation must not contact a Pod'); } } as never,
  { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  const matrix = { roomId, unrelatedExtension: { preserved: true },
    ...(options.absent ? {} : { membershipAuthority: value }) };
  const query = db.insert(chatResource).values({
    id: chatResource.buildId({ id: 'membership-binding' }), author: owner, participants: [ owner, member ],
    // Intentionally absent memberRoles: the binding must survive this valid early return too.
    metadata: { '@id': `${sourceIri}/metadata`, protocols: { matrix } },
  } as never).toSPARQL().query;
  const graph = new Store();
  await new QueryEngine().queryVoid(query, { sources: [ graph ], destination: graph });
  const quads = graph.getQuads(null, null, null, null);
  const protocol = quads.find(q => q.object.termType === 'Literal'
    && q.object.value === JSON.stringify({ matrix }));
  if (!protocol || protocol.object.termType !== 'Literal') throw new Error('Public serializer did not emit protocols');
  if ('extraValue' in options) {
    quads.push(DataFactory.quad(protocol.subject, protocol.predicate,
      DataFactory.literal(JSON.stringify({ matrix: { ...matrix, membershipAuthority: options.extraValue } }), protocol.object.datatype),
      protocol.graph));
  }
  if (options.repeatIdentical) quads.push(protocol);
  const writer = new Writer();
  writer.addQuads(quads.map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
  return await new Promise<string>((resolve, reject) => writer.end((error, ttl) => error ? reject(error) : resolve(ttl)));
}

function reader(ttl: string) {
  const transport = vi.fn(async(input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(documentIri);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    const response = new Response(ttl, { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: documentIri });
    return response;
  });
  const pod = { podId: 'root-binding', accountId: 'owner', baseUrl: podUrl, webId: owner, webIds: [ owner ] };
  const port = new CanonicalRoomSource({
    pods: { findByResourceIdentifier: async() => pod,
      findAllByWebId: async(webId: string) => webId === owner ? [ pod ] : [] } as never,
    callerFetchFor: async(caller) => { expect(caller).toBe(context); return transport; },
  });
  return { port, transport };
}

describe('root independent canonical membership pointer acceptance', () => {
  it('roundtrips public serialization through a new actual ORM reader without a role record', async() => {
    const ttl = await sourceBody(binding);
    for (let reopen = 0; reopen < 2; reopen++) {
      const { port, transport } = reader(ttl);
      const facts = await port.read(roomId, context);
      expect(facts.membershipAuthority).toEqual(binding);
      expect(facts.memberRoles).toEqual({});
      expect(facts.authorWebId).toBe(owner);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps an absent binding legal and does not default a named grant', async() => {
    const { port, transport } = reader(await sourceBody(undefined, { absent: true }));
    expect((await port.read(roomId, context)).membershipAuthority).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reads a foreign deployment issuer as data without locally authorizing it', async() => {
    const foreign = { ...binding, issuer: 'https://other-deployment.example/' };
    const { port } = reader(await sourceBody(foreign));
    expect((await port.read(roomId, context)).membershipAuthority).toEqual(foreign);
  });

  it.each([
    [ 'null', null ], [ 'array', [ binding ] ],
    [ 'wrong purpose', { ...binding, purpose: 'execution' } ],
    [ 'blank ref', { ...binding, credentialRef: ' \t ' } ],
    [ 'blank issuer', { ...binding, issuer: '' } ],
    [ 'whitespace issuer', { ...binding, issuer: ' \t ' } ],
    [ 'missing version', { purpose: 'membership', credentialRef: binding.credentialRef, issuer } ],
    [ 'zero version', { ...binding, version: 0 } ],
    [ 'fractional version', { ...binding, version: 1.5 } ],
    [ 'unsafe version', { ...binding, version: Number.MAX_SAFE_INTEGER + 1 } ],
    [ 'string version', { ...binding, version: '1' } ],
    [ 'secret field', { ...binding, clientSecret: 'dummy-test-value' } ],
  ])('refuses a present %s binding from the original body', async(_name, value) => {
    const { port, transport } = reader(await sourceBody(value));
    await expect(port.read(roomId, context)).rejects.toMatchObject({ status: 403 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses a second different typed protocol term even if ORM selects a valid first value', async() => {
    const { port } = reader(await sourceBody(binding, { extraValue: { ...binding, version: 2 } }));
    await expect(port.read(roomId, context)).rejects.toMatchObject({ status: 403 });
  });

  it('treats repeated identical RDF quads as one fact', async() => {
    const { port } = reader(await sourceBody(binding, { repeatIdentical: true }));
    expect((await port.read(roomId, context)).membershipAuthority).toEqual(binding);
  });
});

describe('root independent named lease configured issuer acceptance', () => {
  it('rejects foreign issuer and stale/revoked/expired owner leases with actual SQLite and vault', async() => {
    const base = path.resolve('.test-data/solid-multiparty-acceptance/provider-b/root-review/purpose-binding-prerequisite');
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(path.join(base, 'acceptance-'));
    let now = new Date('2026-10-03T00:00:00Z');
    const url = `sqlite:${path.join(directory, 'tasks.sqlite')}`;
    const open = () => new TaskCredentialStore({ database: getTaskCredentialDatabase(url), now: () => now,
      vault: new SecretCellVault({ rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'fixture',
        keys: { fixture: Buffer.alloc(32, 7) } }) }) });
    try {
      let store = open();
      const grant = await store.grant({ ownerWebId: owner, issuer, clientId: 'root-fixture-client',
        clientSecret: 'root-fixture-secret', status: 'active', expiresAt: new Date(now.getTime() + 60000) });
      const named = { credentialRef: grant.credentialRef, ownerWebId: owner, version: 1 };
      const source = createTaskCredentialSource({ store, issuer });
      const foreignSource = createTaskCredentialSource({ store, issuer: 'https://foreign-issuer.example/' });
      await expect(source.forRef(named)).resolves.toMatchObject({ credentialRef: grant.credentialRef, version: 1 });
      await expect(foreignSource.forRef(named)).resolves.toBeUndefined();
      await expect(foreignSource.forRef({ credentialRef: grant.credentialRef, ownerWebId: owner })).resolves.toBeUndefined();
      await expect(source.forRef({ ...named, ownerWebId: member })).resolves.toBeUndefined();
      expect((await store.listForOwner(owner))[0].lastUsedAt).toBeUndefined();
      await store.rotate(grant.credentialRef, { clientId: 'rotated-fixture-client', clientSecret: 'rotated-fixture-secret', expectedVersion: 1 });
      await expect(source.forRef(named)).resolves.toBeUndefined();
      resetTaskCredentialDatabases();
      store = open();
      const reopened = createTaskCredentialSource({ store, issuer });
      await expect(reopened.forRef({ ...named, version: 2 })).resolves.toMatchObject({ version: 2 });
      now = new Date(now.getTime() + 60001);
      await expect(reopened.forRef({ ...named, version: 2 })).resolves.toBeUndefined();
      await store.revoke(grant.credentialRef);
      await expect(reopened.forRef({ ...named, version: 2 })).resolves.toBeUndefined();
    } finally {
      resetTaskCredentialDatabases();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
