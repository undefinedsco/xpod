import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { chatResource, messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { MembershipAuthorityPublisher } from '../../../src/api/matrix/membershipAuthorityPublication';
import { OwnerPodAccess } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';
import type { MatrixEventRecord, MatrixStoreContext } from '../../../src/api/matrix/types';
import { TaskCredentialStore } from '../../../src/api/tasks/TaskCredentialStore';
import { getTaskCredentialDatabase, resetTaskCredentialDatabases } from '../../../src/api/tasks/TaskCredentialDatabase';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../../src/security/secret-cell';

vi.mock('@undefineds.co/drizzle-solid', async() => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return { ...actual, drizzle: vi.fn() };
});

async function publicationFixture(realHttp = false) {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  vi.mocked(drizzle).mockImplementation(actual.drizzle);
  let transport: typeof fetch;
  let httpServer: Server | undefined;
  let podUrl = 'https://pod.example/publication/';
  if (realHttp) {
    httpServer = createServer(async(request, response) => {
      if (request.headers.authorization !== 'Bearer fixture-token') { response.writeHead(401).end(); return; }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await transport(new URL(request.url!, podUrl), { method: request.method,
          body: request.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
      } catch { response.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP fixture did not bind');
    podUrl = `http://127.0.0.1:${address.port}/publication/`;
    ownedServers.push(httpServer);
  }
  const owner = `${podUrl}profile/card#me`;
  const sourceIri = chatResource.buildIri(podUrl, { id: 'publication-fixture' });
  const documentIri = sourceIri.split('#')[0];
  const roomId = encodeSourceBoundRoomId(sourceIri);
  const context: MatrixStoreContext = { webId: owner, podUrl,
    auth: { type: 'solid', webId: owner, accessToken: 'fixture-token', tokenType: 'Bearer' } };
  const graph = new Store();
  const engine = new QueryEngine();
  const compiler = actual.drizzle({ info: { webId: owner, podUrl, isLoggedIn: true },
    fetch: async() => { throw new Error('Compilation must not fetch'); } } as never,
  { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  await engine.queryVoid(compiler.insert(chatResource).values({ id: chatResource.buildId({ id: 'publication-fixture' }),
    author: owner, participants: [ owner ], title: 'preserved Chat title',
    metadata: { '@id': `${sourceIri}/metadata`, memberRoles: { [owner]: 'owner' },
      customRoot: { preserved: true }, protocols: { unrelated: { preserved: true }, matrix: { roomId } } },
  } as never).toSPARQL().query, { sources: [ graph ], destination: graph });
  const untouched = graph.getQuads(null, null, null, null).filter(q => q.object.termType !== 'Literal'
    || !q.object.value.includes('"roomId"'));
  let acceptWithoutWrite = false;
  let postCount = 0;
  let beforePost: (() => void) | undefined;
  transport = async(input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST') {
      postCount++;
      const mutate = beforePost;
      beforePost = undefined;
      mutate?.();
      if (!acceptWithoutWrite) await engine.queryVoid(String(init.body), { sources: [ graph ], destination: graph });
      const response = new Response(null, { status: 204 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    expect(url).toBe(documentIri);
    const writer = new Writer();
    writer.addQuads(graph.getQuads(null, null, null, null)
      .map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const ttl = await new Promise<string>((resolve, reject) => writer.end((error, body) => error ? reject(error) : resolve(body)));
    const response = new Response(ttl, { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: documentIri });
    return response;
  };
  const access = new OwnerPodAccess({ sessions: { session: async() => { throw new Error('Bearer caller must not borrow a credential'); } } as never,
    fetch: realHttp ? fetch : transport });
  const pod = { podId: 'publication', baseUrl: podUrl, webId: owner, webIds: [ owner ] };
  const source = new CanonicalRoomSource({ pods: {
    findByResourceIdentifier: async() => pod,
    findAllByWebId: async(webId: string) => webId === owner ? [ pod ] : [],
  } as never, callerFetchFor: async(caller, beforeRequest) => {
    const result = await access.getPodFetch(caller.webId, { auth: caller.auth, beforeRequest });
    if (!result) throw new Error('Caller session unavailable');
    return result;
  } });
  const base = path.resolve('.test-data/solid-multiparty-acceptance/sol-membership-binding-prerequisite-20261003/publication-vault');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'owned-'));
  ownedDirectories.push(directory);
  let now = new Date('2026-10-03T00:00:00Z');
  const credentials = new TaskCredentialStore({ database: getTaskCredentialDatabase(`sqlite:${path.join(directory, 'tasks.sqlite')}`),
    now: () => now, vault: new SecretCellVault({ rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'fixture',
      keys: { fixture: Buffer.alloc(32, 9) } }) }) });
  const grant = await credentials.grant({ ownerWebId: owner, issuer: binding.issuer, clientId: 'fixture-client',
    clientSecret: 'fixture-secret', status: 'active', expiresAt: new Date(now.getTime() + 60000) });
  const approvedBinding = { ...binding, credentialRef: grant.credentialRef };
  vi.spyOn(credentials, 'lease');
  const publisher = new MembershipAuthorityPublisher({ canonicalSource: source, credentials,
    podAccess: access, issuer: binding.issuer, now: () => 1790985600000 });
  const events = new Map<string, MatrixEventRecord>();
  const project = vi.fn(async(input: Parameters<NonNullable<Parameters<MembershipAuthorityPublisher['publish']>[3]>>[0]) => {
    const existing = events.get(input.publication.eventId);
    if (existing) return existing;
    if (input.existingOnly) throw new Error('No persisted projection');
    const record = { eventId: input.publication.eventId, roomId, type: eventType, sender: owner,
      stateKey: '', content: { ...input.binding }, originServerTs: input.publication.createdAt,
      event: { event_id: input.publication.eventId, room_id: roomId, type: eventType, sender: owner,
        state_key: '', content: { ...input.binding }, origin_server_ts: input.publication.createdAt },
    } as MatrixEventRecord;
    events.set(record.eventId, record);
    return record;
  });
  return { publisher, source, context, graph, untouched, roomId, project, credentials, events, binding: approvedBinding,
    revoke: async() => { await credentials.revoke(grant.credentialRef); },
    expire: () => { now = new Date(now.getTime() + 60001); },
    mutateBeforePost: (mutate: () => void) => { beforePost = mutate; },
    noWrite: () => { acceptWithoutWrite = true; }, posts: () => postCount };
}

describe('membership publication actual public ORM and RDF CAS', () => {
  it('rejects unfinished membership before projection or canonical writes; complete history permits publication', async() => {
    const fixture = await publicationFixture();
    const protocol = fixture.graph.getQuads(null, null, null, null).find(q => q.object.termType === 'Literal'
      && q.object.value.includes('"roomId"'))!;
    const protocols = JSON.parse(protocol.object.value);
    protocols.matrix.membershipOperation = { format: 1, operationId: 'frozen-member-event', kind: 'invite', phase: 'committed',
      actor: { webId: fixture.context.webId, podUrl: fixture.context.podUrl }, targetWebId: 'https://bob.example/profile/card#me', authority: null,
      expected: { authorWebId: fixture.context.webId, participants: [fixture.context.webId], memberRoles: null, invitation: null },
      event: { createdAt: 0, content: { membership: 'invite' } }, ownerRecovery: null };
    fixture.graph.removeQuad(protocol);
    const pending = DataFactory.quad(protocol.subject, protocol.predicate,
      DataFactory.literal(JSON.stringify(protocols), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')), protocol.graph);
    fixture.graph.addQuad(pending);
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toMatchObject({ status: 409 });
    expect(fixture.posts()).toBe(0);
    expect(fixture.project).not.toHaveBeenCalled();
    protocols.matrix.membershipOperation.phase = 'complete';
    fixture.graph.removeQuad(pending);
    fixture.graph.addQuad(DataFactory.quad(protocol.subject, protocol.predicate,
      DataFactory.literal(JSON.stringify(protocols), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')), protocol.graph));
    await fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project);
    expect(fixture.posts()).toBe(2);
  });
  it('carries caller authentication through an owned real HTTP CAS endpoint and exact readback', async() => {
    const fixture = await publicationFixture(true);
    const record = await fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project);
    expect(fixture.posts()).toBe(2);
    const facts = await fixture.source.read(fixture.roomId, fixture.context);
    expect(facts.membershipAuthorityPublication).toEqual({ eventId: record.eventId,
      createdAt: record.originServerTs, state: 'complete' });
    for (const quad of fixture.untouched) expect(fixture.graph.has(quad)).toBe(true);
  });
  it('publishes and completes while preserving unrelated RDF; same binding reuses the event', async() => {
    const fixture = await publicationFixture();
    const first = await fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project);
    const facts = await fixture.source.read(fixture.roomId, fixture.context);
    expect(facts.membershipAuthority).toEqual(fixture.binding);
    expect(facts.membershipAuthorityPublication).toEqual({ eventId: first.eventId, createdAt: first.originServerTs, state: 'complete' });
    for (const quad of fixture.untouched) expect(fixture.graph.has(quad)).toBe(true);
    const posts = fixture.posts();
    const second = await fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project);
    expect(second.eventId).toBe(first.eventId);
    expect(fixture.events.size).toBe(1);
    expect(fixture.posts()).toBe(posts);
    expect(vi.mocked(fixture.credentials.lease).mock.calls.length).toBeGreaterThan(5);
  });

  it('does not treat an accepted 204 without a canonical change as a CAS win', async() => {
    const fixture = await publicationFixture();
    fixture.noWrite();
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toMatchObject({ status: 409 });
    expect(fixture.project).not.toHaveBeenCalled();
    expect((await fixture.source.read(fixture.roomId, fixture.context)).membershipAuthority).toBeUndefined();
  });

  it.each([ 'participant set', 'extra typed protocol value', 'root roles term' ])
  ('refuses a concurrent %s change without replacing the old protocols term', async(kind) => {
    const fixture = await publicationFixture();
    const oldProtocol = fixture.graph.getQuads(null, null, null, null)
      .find(q => q.object.termType === 'Literal' && q.object.value.includes('"roomId"'))!;
    fixture.mutateBeforePost(() => {
      if (kind === 'participant set') {
        const participant = fixture.graph.getQuads(null, null, null, null)
          .find(q => q.predicate.value === chatResource.participants.getPredicate(chatResource.config.namespace))!;
        fixture.graph.addQuad(DataFactory.quad(participant.subject, participant.predicate,
          DataFactory.namedNode('https://pod.example/new/profile/card#me'), participant.graph));
      } else if (kind === 'extra typed protocol value') {
        fixture.graph.addQuad(DataFactory.quad(oldProtocol.subject, oldProtocol.predicate,
          DataFactory.literal(oldProtocol.object.value, DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#string')), oldProtocol.graph));
      } else {
        const roles = fixture.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('memberRoles'))!;
        fixture.graph.removeQuad(roles);
        fixture.graph.addQuad(DataFactory.quad(roles.subject, roles.predicate,
          DataFactory.literal('{}', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')), roles.graph));
      }
    });
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toBeDefined();
    expect(fixture.graph.has(oldProtocol)).toBe(true);
    expect(fixture.project).not.toHaveBeenCalled();
  });

  it('rejects a revoked incoming lease before any Pod write or projection', async() => {
    const fixture = await publicationFixture();
    await fixture.revoke();
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toMatchObject({ status: 403 });
    expect(fixture.posts()).toBe(0);
    expect(fixture.project).not.toHaveBeenCalled();
  });

  it.each([ 'wrong issuer', 'wrong ref', 'wrong owner', 'stale version', 'expired', 'wrong purpose' ])
  ('rejects %s using an actual SQLite/vault lease before Pod effects', async(kind) => {
    const fixture = await publicationFixture();
    const request = { ...fixture.binding };
    let caller = fixture.context;
    if (kind === 'wrong issuer') request.issuer = 'https://foreign.example/';
    if (kind === 'wrong ref') request.credentialRef = 'taskcred_missing';
    if (kind === 'stale version') request.version = 2;
    if (kind === 'wrong purpose') Object.assign(request, { purpose: 'execution' });
    if (kind === 'expired') fixture.expire();
    if (kind === 'wrong owner') {
      const other = 'https://pod.example/other/profile/card#me';
      caller = { ...fixture.context, webId: other, auth: { type: 'solid', webId: other,
        accessToken: 'fixture-other', tokenType: 'Bearer' } };
    }
    await expect(fixture.publisher.publish(fixture.roomId, request, caller, fixture.project)).rejects.toMatchObject({ status: 403 });
    expect(fixture.posts()).toBe(0);
    expect(fixture.project).not.toHaveBeenCalled();
  });

  it('resumes a pending projection with its original identity after a lost callback response', async() => {
    const fixture = await publicationFixture();
    const project = fixture.project.getMockImplementation()!;
    fixture.project.mockImplementationOnce(async(input) => {
      await project(input);
      throw new Error('Fixture lost projection response');
    });
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toThrow('lost projection response');
    const pending = (await fixture.source.read(fixture.roomId, fixture.context)).membershipAuthorityPublication!;
    expect(pending.state).toBe('pending');
    const recovered = await fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project);
    expect(recovered.eventId).toBe(pending.eventId);
    expect(recovered.originServerTs).toBe(pending.createdAt);
    expect(fixture.events.size).toBe(1);
    expect((await fixture.source.read(fixture.roomId, fixture.context)).membershipAuthorityPublication?.state).toBe('complete');
  });

  it('retries queue after canonical completion without creating another event identity', async() => {
    const fixture = await publicationFixture();
    const project = fixture.project.getMockImplementation()!;
    let interrupted = false;
    fixture.project.mockImplementation(async(input) => {
      const record = await project(input);
      if (input.queueOnly && !interrupted) { interrupted = true; throw new Error('Fixture interrupted queue'); }
      return record;
    });
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toThrow('interrupted queue');
    const completed = (await fixture.source.read(fixture.roomId, fixture.context)).membershipAuthorityPublication!;
    expect(completed.state).toBe('complete');
    const posts = fixture.posts();
    const record = await fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project);
    expect(record.eventId).toBe(completed.eventId);
    expect(fixture.events.size).toBe(1);
    expect(fixture.posts()).toBe(posts);
    expect(fixture.project.mock.calls.filter(([input]) => !input.existingOnly)).toHaveLength(1);
  });

  it('repairs the old complete queue before allowing a new binding to replace its recovery entry', async() => {
    const fixture = await publicationFixture();
    await fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project);
    await fixture.credentials.rotate(fixture.binding.credentialRef, { clientId: 'fixture-new-client',
      clientSecret: 'fixture-new-secret', expectedVersion: 1 });
    const project = fixture.project.getMockImplementation()!;
    fixture.project.mockImplementation(async(input) => {
      if (input.queueOnly && input.binding.version === 1) {
        expect(input.authorityBinding.version).toBe(2);
        throw new Error('Fixture old queue repair blocked');
      }
      return await project(input);
    });
    const posts = fixture.posts();
    await expect(fixture.publisher.publish(fixture.roomId, { ...fixture.binding, version: 2 }, fixture.context, fixture.project))
      .rejects.toThrow('old queue repair blocked');
    expect(fixture.posts()).toBe(posts);
    expect((await fixture.source.read(fixture.roomId, fixture.context)).membershipAuthority).toEqual(fixture.binding);
  });

  it('refuses a valid foreign owner lease when the canonical original author is another caller', async() => {
    const fixture = await publicationFixture();
    const other = 'https://pod.example/other/profile/card#me';
    const grant = await fixture.credentials.grant({ ownerWebId: other, issuer: fixture.binding.issuer,
      clientId: 'fixture-other', clientSecret: 'fixture-other-secret', status: 'active' });
    const otherBinding = { ...fixture.binding, credentialRef: grant.credentialRef };
    const caller: MatrixStoreContext = { webId: other, podUrl: fixture.context.podUrl,
      auth: { type: 'solid', webId: other, accessToken: 'fixture-other', tokenType: 'Bearer' } };
    await expect(fixture.publisher.publish(fixture.roomId, otherBinding, caller, fixture.project)).rejects.toMatchObject({ status: 403 });
    expect(fixture.posts()).toBe(0);
    expect(fixture.project).not.toHaveBeenCalled();
  });

  it('leaves the publication pending when the incoming lease is revoked before completion', async() => {
    const fixture = await publicationFixture();
    const project = fixture.project.getMockImplementation()!;
    fixture.project.mockImplementationOnce(async(input) => {
      const record = await project(input);
      await fixture.revoke();
      return record;
    });
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toMatchObject({ status: 403 });
    expect(fixture.posts()).toBe(1);
    expect((await fixture.source.read(fixture.roomId, fixture.context)).membershipAuthorityPublication?.state).toBe('pending');
  });

  it('lets the exact owner explicitly finish a rotated old pending projection before publishing the new version', async() => {
    const fixture = await publicationFixture();
    const project = fixture.project.getMockImplementation()!;
    fixture.project.mockImplementationOnce(async(input) => {
      await project(input);
      throw new Error('Fixture interrupted pending publication');
    });
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toThrow('interrupted');
    const oldPending = (await fixture.source.read(fixture.roomId, fixture.context)).membershipAuthorityPublication!;
    await fixture.credentials.rotate(fixture.binding.credentialRef, { clientId: 'fixture-rotated',
      clientSecret: 'fixture-rotated-secret', expectedVersion: 1 });
    const postsBeforeOldRequest = fixture.posts();
    await expect(fixture.publisher.publish(fixture.roomId, fixture.binding, fixture.context, fixture.project)).rejects.toMatchObject({ status: 403 });
    expect(fixture.posts()).toBe(postsBeforeOldRequest);
    const next = { ...fixture.binding, version: 2 };
    const published = await fixture.publisher.publish(fixture.roomId, next, fixture.context, fixture.project);
    expect(published.eventId).not.toBe(oldPending.eventId);
    expect(fixture.events.get(oldPending.eventId)?.content).toEqual(fixture.binding);
    expect(fixture.events.size).toBe(2);
    const facts = await fixture.source.read(fixture.roomId, fixture.context);
    expect(facts.membershipAuthority).toEqual(next);
    expect(facts.membershipAuthorityPublication?.state).toBe('complete');
  });
});

const eventType = 'co.undefineds.membership.authority';
const binding = {
  purpose: 'membership', credentialRef: 'taskcred_publication', version: 1,
  issuer: 'https://issuer.example/',
};

beforeEach(() => { vi.clearAllMocks(); });
const ownedDirectories: string[] = [];
const ownedServers: Server[] = [];
afterEach(async() => {
  for (const server of ownedServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  resetTaskCredentialDatabases();
  for (const directory of ownedDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('membership authority publication public state boundary', () => {
  it.each([
    [ 'missing named lease', binding ],
    [ 'wrong purpose', { ...binding, purpose: 'execution' } ],
    [ 'missing frozen version', { purpose: binding.purpose, credentialRef: binding.credentialRef, issuer: binding.issuer } ],
    [ 'zero frozen version', { ...binding, version: 0 } ],
    [ 'blank explicit ref', { ...binding, credentialRef: ' \t ' } ],
    [ 'secret-bearing payload', { ...binding, clientSecret: 'fixture-only' } ],
  ])('rejects %s before event or Chat mutation', async(_label, content) => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    const chatsBefore = structuredClone(rows.get(chatResource));
    const eventsBefore = structuredClone(rows.get(messageResource));
    await expect(store.setState(room.roomId, eventType, '', content, context))
      .rejects.toMatchObject({ status: 403 });
    expect(rows.get(chatResource)).toEqual(chatsBefore);
    expect(rows.get(messageResource)).toEqual(eventsBefore);
  });

  it('rejects a nonempty publication state key before effects', async() => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    const eventsBefore = structuredClone(rows.get(messageResource));
    await expect(store.setState(room.roomId, eventType, 'other', binding, context))
      .rejects.toMatchObject({ status: 403 });
    expect(rows.get(messageResource)).toEqual(eventsBefore);
  });

  it.each([ [ true, 0 ], [ false, 0 ], [ true, 1 ] ])
  ('guards the committed PDU before bookkeeping (PDU present: %s, timestamp skew: %s)', async(hasPdu, skew) => {
    const { store, context, db } = matrixHarness();
    const room = await store.createRoom({}, context);
    const eventId = '$publication-stable-id';
    const createdAt = 1790985600000;
    const candidate = {
      event_id: eventId, room_id: room.roomId, sender: context.webId,
      type: eventType, state_key: '', content: binding, origin_server_ts: createdAt,
      prev_events: [ '$newer-parent' ], auth_events: [ '$newer-auth' ], depth: 20,
      hashes: { sha256: 'candidate-hash' }, signatures: {},
    };
    const persisted = {
      ...candidate, prev_events: [ '$original-parent' ], auth_events: [ '$original-auth' ],
      depth: 10, hashes: { sha256: 'committed-hash' }, origin_server_ts: createdAt + Number(skew),
    };
    const winner = {
      eventId, roomId: room.roomId, sender: context.webId, type: eventType,
      stateKey: '', content: binding, originServerTs: createdAt + Number(skew),
      role: 'system', event: hasPdu ? persisted : undefined,
    };
    // Isolate the append decision after a real conditional write's readback. This is a
    // bookkeeping regression, not a substitute for the publisher's RDF CAS tests.
    const append = store as unknown as {
      writeMessageRow: (...args: unknown[]) => Promise<boolean>;
      awaitCommittedWinner: (...args: unknown[]) => Promise<typeof winner>;
      queueFederationDelivery: (...args: unknown[]) => Promise<void>;
      appendEvent: (database: unknown, input: unknown, caller: unknown, observed: unknown[]) => Promise<unknown>;
    };
    vi.spyOn(append, 'writeMessageRow').mockResolvedValue(true);
    vi.spyOn(append, 'awaitCommittedWinner').mockResolvedValue(winner);
    const queue = vi.spyOn(append, 'queueFederationDelivery').mockResolvedValue(undefined);
    const result = append.appendEvent(db, {
      roomId: room.roomId, sender: context.webId, type: eventType, stateKey: '',
      content: binding, originServerTs: createdAt, event: candidate,
      validateCommitted: async(record: typeof winner) => {
        if (record.originServerTs !== createdAt || record.event?.origin_server_ts !== createdAt) {
          throw Object.assign(new Error('Publication time differs'), { status: 409 });
        }
      },
    }, context, []);
    if (!hasPdu || skew) {
      await expect(result).rejects.toMatchObject({ status: 409 });
      expect(queue).not.toHaveBeenCalled();
      return;
    }
    await result;
    expect(queue).toHaveBeenCalledOnce();
    expect(queue.mock.calls[0][3]).toEqual(persisted);
    expect(queue.mock.calls[0][3]).not.toEqual(candidate);
  });

});
