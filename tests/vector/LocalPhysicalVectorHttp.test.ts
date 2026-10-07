import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { CachedHandler } from 'asynchronous-handlers';
import { BadRequestHttpError, IdentifierMap, PermissionBasedAuthorizer, guardStream } from '@solid/community-server';
import type { CredentialsExtractor, PermissionReader, PermissionReaderInput } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { expect, it, vi } from 'vitest';
import { VectorHttpHandler } from '../../src/http/vector/VectorHttpHandler';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

async function fixture(refuseCredentials = false) {
  await mkdir('.test-data/local-vector-http', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/local-vector-http/own-'));
  const operations = new LocalPhysicalOperationService(path.join(root, 'authority'));
  const filename = path.join(root, 'index.sqlite');
  const store = new SqliteVectorStore({ connectionString: filename, operationService: operations });
  const embedding = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
  await store.ensureVectorTable('own-http'); await store.upsertVector('own-http', 41, embedding);
  let extracts = 0; let permissions = 0; let actualClosed = 0;
  const credentials = new CachedHandler({ canHandle: async () => undefined, handle: async () => {
    extracts += 1;
    if (refuseCredentials) { throw new BadRequestHttpError('Own refused credentials'); }
    return { agent: { webId: 'urn:own:agent' } };
  } } as never) as unknown as CredentialsExtractor;
  const permissionReader = { handleSafe: async (input: PermissionReaderInput) => {
    permissions += 1;
    expect(authoritySqlitePeerAdmission('node', operations.databasePath)).toBe(false);
    return new IdentifierMap([...input.requestedModes.entrySets()].map(([id]) => [id, {
      [PERMISSIONS.Read]: true, [PERMISSIONS.Append]: true, [PERMISSIONS.Modify]: true,
    }] as const));
  } } as unknown as PermissionReader;
  const handler = new VectorHttpHandler({ vectorStore: store, credentialsExtractor: credentials,
    permissionReader, authorizer: new PermissionBasedAuthorizer(), operationService: operations });
  const completions: Promise<void>[] = [];
  const failures: unknown[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    request.once('close', () => { actualClosed += 1; });
    completions.push(handler.handleSafe({ request: guardStream(request), response }).catch(error => {
      failures.push(error); response.destroy(error instanceof Error ? error : undefined);
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Missing own listener'); }
  return { store, operations, embedding, filename, origin: `http://127.0.0.1:${address.port}/alice/-/vector`,
    extracts: () => extracts, permissions: () => permissions, actualClosed: () => actualClosed,
    complete: async () => { await Promise.all(completions); expect(failures).toEqual([]); }, cleanup: async () => {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(completions); await store.close().catch(() => undefined); await operations.close();
      await rm(root, { recursive: true, force: true });
    } };
}

it('failed POST credential preparation preserves a writable error response and actual original body close', async () => {
  const context = await fixture(true);
  try {
    const response = await fetch(`${context.origin}/upsert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ignored: 'body rejected before parse' }) });
    expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).toContain('Own refused credentials');
    await context.complete(); expect(context.extracts()).toBe(1); expect(context.permissions()).toBe(0);
    expect(context.actualClosed()).toBe(1);
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(true);
  } finally { await context.cleanup(); }
}, 15_000);

it.each(['upsert', 'delete'] as const)('%s per-record envelopes propagate stopped admission as503 before actual vector SQL', async action => {
  const context = await fixture();
  let calls = 0;
  const original = action === 'upsert' ? context.store.upsertVector.bind(context.store) : context.store.deleteVector.bind(context.store);
  const hook = action === 'upsert'
    ? vi.spyOn(context.store, 'upsertVector').mockImplementation((model, id, value) => { calls += 1; context.operations.stop(); return (original as typeof context.store.upsertVector)(model, id, value); })
    : vi.spyOn(context.store, 'deleteVector').mockImplementation((model, id) => { calls += 1; context.operations.stop(); return (original as typeof context.store.deleteVector)(model, id); });
  try {
    const payload = action === 'upsert'
      ? { model: 'own-http', vectors: [{ id: 42, vector: context.embedding }, { id: 43, vector: context.embedding }] }
      : { model: 'own-http', ids: [41, 42] };
    const response = await fetch(`${context.origin}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: true });
    await context.complete(); expect(calls).toBe(1); expect(context.permissions()).toBe(1);
    await context.operations.close();
    const observer = new SqliteVectorStore({ connectionString: context.filename });
    try { expect(await observer.getVectorIds('own-http')).toEqual([41]); }
    finally { await observer.close(); }
  } finally { hook.mockRestore(); await context.cleanup(); }
}, 15_000);
