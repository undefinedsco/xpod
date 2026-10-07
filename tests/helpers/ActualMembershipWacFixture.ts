// Root: actual CSS WAC/read/write/closure/prepared native persistence, registered
// Pods and current named credential leases. Counted identity is not Gateway DPoP.
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { DataFactory, Parser, Store, type Quad } from 'n3';
import { QueryEngine } from '@comunica/query-sparql';
import { Readable } from 'node:stream';
import { BasicRepresentation, INTERNAL_QUADS, RepresentationMetadata } from '@solid/community-server';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { guardedPolicyClosureFixture } from './GuardedPolicyClosureFixture';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';
import { executeStatement } from '../../src/identity/drizzle/db';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { TaskCredentialStore } from '../../src/api/tasks/TaskCredentialStore';
import { taskCredentialSchema } from '../../src/api/tasks/TaskCredentialSchema';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../src/security/secret-cell';
import { MembershipAuthorityLocator } from '../../src/api/matrix/membershipAuthorityLocator';
import { MembershipAuthorityResolver } from '../../src/api/matrix/membershipAuthorityResolver';
import { CanonicalRoomSource } from '../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../src/api/matrix/canonicalRoomIdentity';
import { CanonicalMembershipSource } from '../../src/api/matrix/canonicalMembershipSource';
import { MembershipLifecycle } from '../../src/api/matrix/membershipLifecycle';
import type { MatrixEventRecord, MatrixStoreContext } from '../../src/api/matrix/types';

type Base = Parameters<Parameters<typeof guardedPolicyClosureFixture>[0]>[0];
type Mapping = NonNullable<Parameters<typeof guardedPolicyClosureFixture>[1]>;
type Fixture = Awaited<ReturnType<typeof configure>>;
export async function actualMembershipWacFixture<T>(run: (f: Fixture) => Promise<T>, mapping: Mapping = {}): Promise<T> {
  return await actualMembershipPolicyFixture(run, 'wac', mapping);
}

export async function actualMembershipAcpFixture<T>(run: (f: Fixture) => Promise<T>, mapping: Mapping = {}): Promise<T> {
  return await actualMembershipPolicyFixture(run, 'acp', mapping);
}

async function actualMembershipPolicyFixture<T>(run: (f: Fixture) => Promise<T>, kind: 'wac' | 'acp', mapping: Mapping): Promise<T> {
  return await guardedPolicyClosureFixture(async base => {
    const runtime = getSqliteRuntime();
    const database = runtime.openDatabase(path.join(base.directory, 'membership-credentials.sqlite'));
    try { return await run(await configure(base, runtime.createDrizzleDatabase(database), kind)); }
    finally { database.close(); }
  }, { ...mapping, policyKind: kind, observation: mapping.observation ?? {} });
}

async function configure(f: Base, database: ReturnType<ReturnType<typeof getSqliteRuntime>['createDrizzleDatabase']>, kind: 'wac' | 'acp') {
  // This fixture also runs ordinary canonical CAS with variable GRAPH guards.
  // Feed its actual indexed inventory, rather than the closed-policy fixture's
  // intentional empty enumeration stub, into the existing server branch.
  f.queryEngine.listGraphs.mockImplementation(async () => new Set(f.engine.scan({ pattern: {} }).quads
    .map(q => q.graph.value).filter(iri => iri.startsWith(f.room))));
  const actorPodUrl = `${f.origin}bob/`;
  const actor = `${actorPodUrl}profile/card#me`;
  await f.putContainer(actorPodUrl);
  await executeStatement(f.identity, sql`INSERT INTO identity_store (container, id, payload) VALUES ('pod', 'root-membership-bob', ${JSON.stringify({ accountId: 'root-membership-bob-account', baseUrl: actorPodUrl, webId: actor })})`);
  const credentials = new TaskCredentialStore({ database: { db: database, schema: taskCredentialSchema.sqlite },
    vault: new SecretCellVault({ rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 31) } }) }) });
  const grant = await credentials.grant({ ownerWebId: f.owner, issuer: f.origin,
    clientId: 'root-actual-membership', clientSecret: 'root-actual-fixture-secret', status: 'active' });
  const binding = { purpose: 'membership' as const, credentialRef: grant.credentialRef, version: 1, issuer: f.origin };
  const locator = new MembershipAuthorityLocator(database);
  const roomId = encodeSourceBoundRoomId(f.source);
  const ownerContext: MatrixStoreContext = { webId: f.owner, podUrl: f.pod, auth: { type: 'solid', webId: f.owner } as never };
  const actorContext: MatrixStoreContext = { webId: actor, podUrl: actorPodUrl, auth: { type: 'solid', webId: actor } as never };
  const requests: Array<{ method: string; url: string; principal: string; media: string | null }> = [];
  const transport = (principal: string, beforeRequest?: () => Promise<void>): typeof fetch => async (input, init) => {
    await beforeRequest?.();
    const headers = new Headers(init?.headers); headers.set('x-root-fixture-principal', principal);
    requests.push({ method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      url: input instanceof Request ? input.url : String(input), principal, media: headers.get('content-type') });
    return await fetch(input, { ...init, headers });
  };
  const source = new CanonicalRoomSource({ pods: new PodLookupRepository(f.identity),
    callerFetchFor: async (context, beforeRequest) => transport(context.webId, beforeRequest) });
  const podAccess = { getPodFetch: async (webId: string, request: any) => {
    if (request.taskCredential && (webId !== f.owner || request.auth || request.taskCredential.credentialRef !== binding.credentialRef
      || request.taskCredential.version !== binding.version || typeof request.beforeRequest !== 'function')) {
      throw new Error('Root actual fixture rejected an invalid named transport');
    }
    return transport(webId, request.beforeRequest);
  } };
  const resolver = new MembershipAuthorityResolver({ canonicalSource: source, locator, credentials, podAccess, issuer: f.origin });
  const options = { canonicalSource: source, resolver, credentials, podAccess, issuer: f.origin };
  const compiler = drizzle({ info: { webId: f.owner, isLoggedIn: true, podUrl: f.pod },
    fetch: async () => { throw new Error('Root compiler cannot fetch'); } } as never,
  { podUrl: f.pod, disableInteropDiscovery: true, resourcePreparation: 'off' });
  const indexedPut = async (iri: string, quads: readonly Quad[]) => {
    await f.lockedStore.setRepresentation({ path: iri }, new BasicRepresentation(
      Readable.from(quads.map(q => DataFactory.quad(q.subject, q.predicate, q.object)), { objectMode: true }),
      new RepresentationMetadata({ path: iri }, INTERNAL_QUADS)));
  };
  await indexedPut(f.podAcl, new Parser({ baseIRI: f.podAcl }).parse(f.ownerPolicy));
  const seed = new Store();
  const insert = compiler.insert(chatResource).values({ id: chatResource.buildId({ id: 'root-guarded' }),
    author: f.owner, participants: [f.owner], title: `actual ${kind.toUpperCase()} membership`,
    metadata: { '@id': `${f.source}/metadata`, memberRoles: {}, preserve: { value: 'retain' },
      protocols: { foreign: { value: 'retain' }, matrix: { roomId, membershipAuthority: binding,
        membershipAuthorityPublication: { eventId: '$root-actual-authority', createdAt: 1, state: 'complete' },
        ...(kind === 'acp' ? { membershipInvitations: {
          [actor]: { id: '$root-actual-admission', inviterWebId: f.owner, createdAt: 10 },
        } } : {}) } } } } as never).toSPARQL().query;
  await new QueryEngine().queryVoid(insert, { sources: [seed], destination: seed });
  await indexedPut(f.document, seed.getQuads(null, null, null, null));
  const membership = new CanonicalMembershipSource(options);
  if (kind === 'acp') {
    // Establish the nonsecret locator through the actual validated owner read. ACP Read
    // mutation is a later slice, so this fixture seeds admission through public ORM only.
    await resolver.readAsCaller(roomId, ownerContext);
  } else {
    const lifecycle = new MembershipLifecycle({ source: membership, eventId: () => '$root-actual-admission', now: () => 10 });
    await lifecycle.invite(roomId, actor, ownerContext, async input => {
    const op = input.operation;
    return { eventId: op.operationId, roomId, type: 'm.room.member', sender: op.actor.webId,
      stateKey: op.targetWebId, originServerTs: op.event.createdAt, content: { ...op.event.content },
      event: { event_id: op.operationId, room_id: roomId, type: 'm.room.member', sender: op.actor.webId,
        state_key: op.targetWebId, origin_server_ts: op.event.createdAt, content: { ...op.event.content } } } as MatrixEventRecord;
    });
  }
  return { ...f, actor, actorPodUrl, roomId, ownerContext, actorContext, canonicalSource: source, membership, options, credentials, binding, locator, indexedPut, requests,
    policyBody: async (iri: string) => new Parser({ baseIRI: iri }).parse(await (await transport(f.owner)(iri)).text()), };
}
