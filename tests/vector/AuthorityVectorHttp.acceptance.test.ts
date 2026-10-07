// Root-owned actual HTTP/vector SQL oracle; declared credentials/policy are not real DPoP or full WAC.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { CachedHandler } from 'asynchronous-handlers';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { BadRequestHttpError, IdentifierMap, PermissionBasedAuthorizer, guardStream } from '@solid/community-server';
import type { CredentialsExtractor, PermissionReader, PermissionReaderInput } from '@solid/community-server';
import { expect, it } from 'vitest';
import { VectorHttpHandler } from '../../src/http/vector/VectorHttpHandler';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([ promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Owned vector HTTP deadline')), 10_000);
  }) ]); } finally { clearTimeout(timer); }
}

async function fixture() {
  const parent = path.resolve('.test-data/authority-vector-http');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'root-'));
  const operations = new LocalPhysicalOperationService(path.join(root, 'authority'));
  const storeOptions = { connectionString: path.join(root, 'separate-index', 'vectors.sqlite'), operationService: operations };
  const store = new SqliteVectorStore(storeOptions);
  await store.ensureVectorTable('root-vector');
  await store.upsertVector('root-vector', 41, Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0));
  let origin = '';
  let profileRequests = 0;
  let permissionCalls = 0;
  const extraction = new Map<string, number>();
  const failures: unknown[] = [];
  const completions: Promise<void>[] = [];
  const credentials = new CachedHandler({
    canHandle: async () => undefined,
    handle: async (request: IncomingMessage) => {
      const key = `${request.url}:${request.headers.authorization ?? 'anonymous'}`;
      extraction.set(key, (extraction.get(key) ?? 0) + 1);
      if (request.headers.authorization === 'Bearer refused-fixture') {
        throw new BadRequestHttpError('Fixture credential rejected');
      }
      if (request.headers.authorization) {
        const profile = await fetch(`${origin}/profile/card`, { signal: AbortSignal.timeout(4000) });
        expect(profile.status).toBe(200);
        expect(await profile.text()).toBe('declared current profile');
      }
      return { agent: { webId: 'urn:root:fixture' } };
    },
  } as never) as unknown as CredentialsExtractor;
  const permissionReader = { handleSafe: async (input: PermissionReaderInput) => {
    permissionCalls += 1;
    for (const runtime of [ 'bun', 'node' ] as const) {
      expect(authoritySqlitePeerAdmission(runtime, operations.databasePath)).toBe(false);
    }
    // An actual public SQL read must nest in this same protected permission session.
    expect(await store.countVectors('root-vector')).toBe(1);
    return new IdentifierMap([ ...input.requestedModes.entrySets() ].map(([ identifier ]) =>
      [ identifier, { [PERMISSIONS.Read]: true } ] as const));
  } } as unknown as PermissionReader;
  const options = { vectorStore: store, credentialsExtractor: credentials, permissionReader,
    authorizer: new PermissionBasedAuthorizer(), operationService: operations };
  const handler = new VectorHttpHandler(options);
  const server = createServer((request, response) => {
    const operation = request.url === '/profile/card'
      ? operations.run(async () => {
        profileRequests += 1;
        expect(authoritySqlitePeerAdmission('node', operations.databasePath)).toBe(false);
        response.writeHead(200, { 'content-type': 'text/plain' }); response.end('declared current profile');
      })
      : handler.handleSafe({ request: guardStream(request), response });
    completions.push(operation.catch(error => {
      failures.push(error); response.destroy(error instanceof Error ? error : undefined);
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Owned vector listener has no address'); }
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, operations, extraction, failures, profileRequests: () => profileRequests,
    permissionCalls: () => permissionCalls, completed: () => within(Promise.all(completions)), cleanup: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await within(Promise.all(completions));
      await store.close().catch(() => undefined); await operations.close();
      await rm(root, { recursive: true, force: true });
      for (const suffix of [ '', '-wal', '-shm' ]) { await rm(operations.databasePath + suffix, { force: true }); }
    } };
}

it('cold original request credential lookup precedes shared vector permission/SQL admission without self-wait', async () => {
  const context = await fixture();
  try {
    const response = await fetch(`${context.origin}/alice/-/vector/stats`, {
      headers: { Authorization: 'Bearer cold-fixture' }, signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ totalCount: 1 });
    await context.completed();
    expect(context.profileRequests()).toBe(1);
    expect(context.permissionCalls()).toBe(1);
    expect(context.extraction.get('/alice/-/vector/stats:Bearer cold-fixture')).toBe(1);
    expect(context.failures).toEqual([]);
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(true);
  } finally { await context.cleanup(); }
}, 30_000);

it('failed original credentials are evaluated once, preserve error output and never observe vector permissions', async () => {
  const context = await fixture();
  try {
    const refused = await fetch(`${context.origin}/alice/-/vector/stats`, {
      headers: { Authorization: 'Bearer refused-fixture' }, signal: AbortSignal.timeout(8000),
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain('Fixture credential rejected');
    await context.completed();
    expect(context.extraction.get('/alice/-/vector/stats:Bearer refused-fixture')).toBe(1);
    expect(context.permissionCalls()).toBe(0);
    expect(context.failures).toEqual([]);
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(true);
    const healthy = await fetch(`${context.origin}/alice/-/vector/stats`, { signal: AbortSignal.timeout(8000) });
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ totalCount: 1 });
    await context.completed();
  } finally { await context.cleanup(); }
}, 30_000);
