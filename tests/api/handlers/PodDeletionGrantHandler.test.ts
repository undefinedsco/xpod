import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { NodeTokenAuthenticator } from '../../../src/api/auth/NodeTokenAuthenticator';
import { PodDeletionOperationRepository } from '../../../src/identity/drizzle/PodDeletionOperationRepository';
import { registerPodDeletionGrantRoutes } from '../../../src/api/handlers/PodDeletionGrantHandler';

describe('Pod deletion grant callback', () => {
  it('requires authenticated exact node, grant and target for claim and completion', async () => {
    const operations = new PodDeletionOperationRepository(`sqlite::memory:${randomUUID()}`);
    const target = { accountId: 'a', podId: 'p', nodeId: 'n', storageUrl: 'https://node.test/p/' };
    const { operation, grant } = await operations.create(target);
    const routes = new Map<string, (...args: any[]) => Promise<void>>();
    let nodeId = 'n';
    let authorized = true;
    registerPodDeletionGrantRoutes({ post: (url: string, handler: (...args: any[]) => Promise<void>) => routes.set(url, handler) } as unknown as ApiServer,
      operations, { canAuthenticate: () => authorized, authenticate: async () => ({ success: authorized, context: { type: 'node', nodeId } }) } as unknown as NodeTokenAuthenticator);
    async function call(action: string, body: object) {
      const request = Readable.from([JSON.stringify(body)]);
      const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
      await routes.get(`/api/pod-deletions/:operationId/${action}`)!(request, response, { operationId: operation.operationId });
      return response;
    }
    authorized = false;
    expect((await call('claim', { grant, storageUrl: target.storageUrl })).statusCode).toBe(401);
    authorized = true; nodeId = 'other';
    expect((await call('claim', { grant, storageUrl: target.storageUrl })).statusCode).toBe(403);
    nodeId = 'n';
    expect((await call('claim', { grant, storageUrl: 'https://evil.test/' })).statusCode).toBe(403);
    expect((await call('claim', { grant: 'bad', storageUrl: target.storageUrl })).statusCode).toBe(403);
    expect((await call('claim', { grant, storageUrl: target.storageUrl })).statusCode).toBe(200);
    expect((await call('complete', { grant, storageUrl: target.storageUrl })).statusCode).toBe(200);
    expect((await call('complete', { grant, storageUrl: target.storageUrl })).statusCode).toBe(200);
  });
});

describe('operator-confirmed legacy generation callback', () => {
  it('keeps preflight read-only and rejects a different node, owner, or storage target', async () => {
    const { DrizzleIndexedStorage } = await import('../../../src/identity/drizzle/DrizzleIndexedStorage');
    const { PodLookupRepository } = await import('../../../src/identity/drizzle/PodLookupRepository');
    const { EdgeNodeRepository } = await import('../../../src/identity/drizzle/EdgeNodeRepository');
    const { getIdentityDatabase } = await import('../../../src/identity/drizzle/db');
    const url = `sqlite::memory:${randomUUID()}`;
    const store = new DrizzleIndexedStorage(url);
    const pod = await store.create('pod', { accountId: 'creator', baseUrl: 'https://node.test/p/' });
    await store.create('owner', { podId: pod.id, webId: 'https://node.test/p/profile/card#me' });
    const operations = new PodDeletionOperationRepository(url);
    const nodes = new EdgeNodeRepository(getIdentityDatabase(url));
    await nodes.registerSpNode({ nodeId: 'node', publicUrl: 'https://node.test/' });
    const { challenge, details } = await operations.createAuthorization({ accountId: 'creator', podId: pod.id, storageUrl: pod.baseUrl, nodeId: 'node', returnUrl: 'https://cloud.test/.account/account/' });
    const routes = new Map<string, (...args: any[]) => Promise<void>>();
    const server = { post: (path: string, handler: (...args: any[]) => Promise<void>) => routes.set(path, handler), get: (path: string, handler: (...args: any[]) => Promise<void>) => routes.set(path, handler) };
    let authenticatedNode = 'node';
    registerPodDeletionGrantRoutes(server as unknown as ApiServer, operations, {
      canAuthenticate: () => true, authenticate: async () => ({ success: true, context: { type: 'node', nodeId: authenticatedNode } }),
    } as unknown as NodeTokenAuthenticator, { pods: new PodLookupRepository(getIdentityDatabase(url)), nodes });
    async function call(action: string, body: object = {}) {
      const request = Object.assign(Readable.from([JSON.stringify(body)]), { headers: { 'x-xpod-pod-authorization': challenge } });
      const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
      await routes.get(`/api/pod-deletions/:operationId/${action}`)!(request, response, { operationId: details.challengeId });
      return response.statusCode;
    }
    authenticatedNode = 'other'; expect(await call('authorize-details')).toBe(403);
    authenticatedNode = 'node'; expect(await call('authorize-details')).toBe(200);
    expect(await operations.remoteGeneration(pod.id, 'node', pod.baseUrl)).toBeUndefined();
    expect(await call('authorize', { remotePodId: 'local', storageUrl: 'https://else.test/p/', ownerWebIds: ['https://node.test/p/profile/card#me'] })).toBe(403);
    expect(await call('authorize', { remotePodId: 'local', storageUrl: pod.baseUrl, ownerWebIds: ['https://attacker.test/#me'] })).toBe(403);
    expect(await call('authorize', { remotePodId: 'local', storageUrl: pod.baseUrl, ownerWebIds: ['https://node.test/p/profile/card#me'] })).toBe(200);
    expect(await operations.remoteGeneration(pod.id, 'node', pod.baseUrl)).toBe('local');
    expect(await call('authorize-details')).toBe(409);
  });
});
