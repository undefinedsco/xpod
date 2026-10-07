import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { expect, vi } from 'vitest';
import { CanonicalRoomSource } from '../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../src/api/matrix/canonicalRoomIdentity';
import { MembershipAuthorityLocator } from '../../src/api/matrix/membershipAuthorityLocator';
import { MembershipAuthorityResolver } from '../../src/api/matrix/membershipAuthorityResolver';
import { TaskCredentialStore } from '../../src/api/tasks/TaskCredentialStore';
import { taskCredentialSchema } from '../../src/api/tasks/TaskCredentialSchema';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../src/security/secret-cell';
import type { MatrixStoreContext } from '../../src/api/matrix/types';

/** Root-owned HTTP/RDF/SQLite fixture. Counted principal headers are not real DPoP or ACL proof. */
export async function canonicalInviteFixture<T>(
  run: (fixture: Awaited<ReturnType<typeof openFixture>>) => Promise<T>,
): Promise<T> {
  const base = path.resolve('.test-data/solid-multiparty-acceptance/provider-b/root-review/invite-fixtures');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'root-'));
  const fixture = await openFixture(directory);
  try { return await run(fixture); } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function openFixture(directory: string) {
  const graph = new Store();
  const engine = new QueryEngine();
  const requests: Array<{ url: string; method: string; principal: string; media: string | null; mutation?: 'source' | 'policy' }> = [];
  const requestRecords = new WeakMap<IncomingMessage, (typeof requests)[number]>();
  let documentIri = '';
  let endpoint = '';
  let beforePost: (() => Promise<void>) | undefined;
  let afterPost: (() => Promise<void>) | undefined;
  let acknowledgeWithoutCommit = false;
  let losePostResponse = false;
  const deniedReaders = new Set<string>();
  const executePost = async(update: string, request: IncomingMessage, response: ServerResponse,
    mutation: 'source' | 'policy' = 'source', afterCommit?: () => Promise<void>): Promise<void> => {
    const recorded = requestRecords.get(request);
    if (recorded) recorded.mutation = mutation;
    await beforePost?.();
    if (!acknowledgeWithoutCommit) await engine.queryVoid(update, { sources: [graph], destination: graph });
    await afterCommit?.();
    await afterPost?.();
    if (losePostResponse) { request.socket.destroy(); return; }
    response.writeHead(204); response.end();
  };
  let additionalRequest: ((request: IncomingMessage, response: ServerResponse, url: string) => Promise<boolean> | boolean) | undefined;
  const server = createServer((request, response) => {
    void (async() => {
      const url = `http://${request.headers.host}${request.url}`;
      const recorded = { url, method: request.method!, principal: String(request.headers['x-root-fixture-principal'] ?? ''),
        media: typeof request.headers['content-type'] === 'string' ? request.headers['content-type'].split(';')[0] : null };
      requests.push(recorded); requestRecords.set(request, recorded);
      if (await additionalRequest?.(request, response, url)) return;
      if (url === documentIri && request.method === 'GET') {
        if (deniedReaders.has(String(request.headers['x-root-fixture-principal'] ?? ''))) {
          response.writeHead(403); response.end('Canonical caller read denied'); return;
        }
        const writer = new Writer();
        writer.addQuads(graph.getQuads(null, null, null, null)
          .filter(q => q.graph.termType === 'DefaultGraph' || q.graph.value === documentIri)
          .map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
        const ttl = await new Promise<string>((resolve, reject) =>
          writer.end((error, text) => error ? reject(error) : resolve(text)));
        response.writeHead(200, { 'Content-Type': 'text/turtle' }); response.end(ttl);
      } else if (url === endpoint && request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        await executePost(Buffer.concat(chunks).toString(), request, response);
      } else { response.writeHead(400); response.end('Unexpected fixture request'); }
    })().catch(() => { response.writeHead(500); response.end('Fixture request failed'); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const issuer = `http://127.0.0.1:${address.port}/`;
  const podUrl = `${issuer}owner/`;
  const actorPodUrl = `${issuer}actor/`;
  const targetPodUrl = `${issuer}target/`;
  const owner = `${podUrl}profile/card#me`;
  const actor = `${actorPodUrl}profile/card#me`;
  const target = `${issuer}target/profile/card#me`;
  const sourceIri = chatResource.buildIri(podUrl, { id: 'root-invite' });
  documentIri = sourceIri.split('#')[0];
  endpoint = `${documentIri.slice(0, documentIri.lastIndexOf('/') + 1)}-/sparql`;
  const roomId = encodeSourceBoundRoomId(sourceIri);
  const runtime = getSqliteRuntime();
  const database = runtime.openDatabase(path.join(directory, 'authority.sqlite'));
  const sql = runtime.createDrizzleDatabase(database);
  const credentials = new TaskCredentialStore({ database: { db: sql, schema: taskCredentialSchema.sqlite },
    vault: new SecretCellVault({ rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'fixture',
      keys: { fixture: Buffer.alloc(32, 17) } }) }) });
  const grant = await credentials.grant({ ownerWebId: owner, issuer, clientId: 'root-invite-fixture',
    clientSecret: 'root-invite-fixture-secret', status: 'active' });
  const binding = { purpose: 'membership' as const, credentialRef: grant.credentialRef, version: 1, issuer };
  const locator = new MembershipAuthorityLocator(sql);
  const compiler = drizzle({ info: { webId: owner, isLoggedIn: true, podUrl },
    fetch: async() => { throw new Error('Fixture compiler must not fetch'); } } as never,
  { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  const ownerContext: MatrixStoreContext = { webId: owner, podUrl, auth: { type: 'solid', webId: owner } as never };
  const actorContext: MatrixStoreContext = { webId: actor, podUrl: actorPodUrl, auth: { type: 'solid', webId: actor } as never };
  const targetContext: MatrixStoreContext = { webId: target, podUrl: targetPodUrl, auth: { type: 'solid', webId: target } as never };
  const pods = [ { podId: 'root-owner', baseUrl: podUrl, webId: owner, webIds: [ owner ] },
    { podId: 'root-actor', baseUrl: actorPodUrl, webId: actor, webIds: [ actor ] },
    { podId: 'root-target', baseUrl: targetPodUrl, webId: target, webIds: [ target ] } ];
  const countedFetch = (principal: string, beforeRequest?: () => Promise<void>): typeof fetch => async(input, init) => {
    await beforeRequest?.();
    const headers = new Headers(init?.headers);
    headers.set('x-root-fixture-principal', principal);
    return await fetch(input, { ...init, headers });
  };
  const source = new CanonicalRoomSource({ pods: {
    findByResourceIdentifier: async(url: string) => pods.find(p => url.startsWith(p.baseUrl)),
    findAllByWebId: async(webId: string) => pods.filter(p => p.webId === webId),
  } as never, callerFetchFor: async(context, beforeRequest) => countedFetch(context.webId, beforeRequest) });
  const podAccess = { getPodFetch: vi.fn(async(webId: string, request: any) => {
    if (request.taskCredential) {
      expect(webId).toBe(owner); expect(request.auth).toBeUndefined();
      expect(request.taskCredential).toEqual({ credentialRef: binding.credentialRef, version: binding.version });
      expect(request.beforeRequest).toBeTypeOf('function');
    } else {
      expect(request.auth?.webId).toBe(webId);
    }
    return countedFetch(webId, request.beforeRequest);
  }) };
  const resolver = new MembershipAuthorityResolver({ canonicalSource: source, locator, credentials, podAccess, issuer });
  const reset = async(input: { named?: boolean; roles?: 'absent' | 'empty' | 'admin'; participants?: string[] } = {}) => {
    graph.removeQuads(graph.getQuads(null, null, null, null));
    await engine.queryVoid(compiler.insert(chatResource).values({ id: chatResource.buildId({ id: 'root-invite' }),
      author: owner, participants: input.participants ?? [ owner, actor ], title: 'unrelated title',
      metadata: { '@id': `${sourceIri}/metadata`, preserve: { value: 'root fixture' },
        ...(input.roles === 'absent' ? {} : { memberRoles: input.roles === 'empty' ? {} : { [owner]: 'owner', [actor]: 'admin' } }),
        protocols: { foreign: { value: 'retain' }, matrix: { roomId,
          ...(input.named === false ? {} : { membershipAuthority: binding,
            membershipAuthorityPublication: { eventId: '$root-published', createdAt: 1, state: 'complete' } }) } },
      } } as never).toSPARQL().query, { sources: [ graph ], destination: graph });
    await locator.wipe(); requests.length = 0; deniedReaders.clear();
  };
  await reset();
  return { graph, engine, compiler, credentials, binding, locator, source, resolver, podAccess, issuer,
    podUrl, actorPodUrl, targetPodUrl, owner, actor, target, sourceIri, documentIri, endpoint, roomId, ownerContext, actorContext, targetContext,
    requests, reset, executePost, beforePost: (callback?: () => Promise<void>) => { beforePost = callback; },
    afterPost: (callback?: () => Promise<void>) => { afterPost = callback; },
    acknowledgeWithoutCommit: (value: boolean) => { acknowledgeWithoutCommit = value; },
    losePostResponse: (value: boolean) => { losePostResponse = value; },
    denyCallerRead: (webId: string, denied = true) => { if (denied) deniedReaders.add(webId); else deniedReaders.delete(webId); },
    additionalRequest: (handler?: typeof additionalRequest) => { additionalRequest = handler; },
    close: async() => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      database.close();
    } };
}
