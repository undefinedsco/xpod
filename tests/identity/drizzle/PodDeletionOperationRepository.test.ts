import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PodDeletionOperationRepository } from '../../../src/identity/drizzle/PodDeletionOperationRepository';

describe('durable Pod deletion grants', () => {
  const target = { accountId: 'a', podId: 'p', storageUrl: 'https://node.test/p/', nodeId: 'n' };
  const repo = () => new PodDeletionOperationRepository(`sqlite::memory:${randomUUID()}`);
  it('checks exact node/grant, preserves a single operation and requires claim before acknowledgement', async () => {
    const store = repo();
    const { operation, grant } = await store.create(target);
    expect(await store.acknowledge(operation.operationId, 'n', grant, target.storageUrl)).toBe(false);
    expect(await store.claim(operation.operationId, 'other', grant)).toBeUndefined();
    expect(await store.claim(operation.operationId, 'n', 'bad')).toBeUndefined();
    await expect(store.create(target)).rejects.toThrow('already exists');
    expect((await store.claim(operation.operationId, 'n', grant))?.state).toBe('claimed');
    expect(await store.acknowledge(operation.operationId, 'n', grant, 'https://other.test/p/')).toBe(false);
    expect(await store.acknowledge(operation.operationId, 'n', grant, target.storageUrl)).toBe(true);
    expect((await store.get(operation.operationId))?.state).toBe('completed');
  });
  it('shares durable plan between repository instances and retains completed target identity', async () => {
    const url = `sqlite::memory:${randomUUID()}`;
    const first = new PodDeletionOperationRepository(url);
    const operation = await first.createLocal(target, 'op');
    const plan = { baseUrl: target.storageUrl, resources: [`${target.storageUrl}child`, target.storageUrl] };
    await first.savePlan(operation.operationId, plan);
    const second = new PodDeletionOperationRepository(url);
    expect((await second.get('op'))?.plan).toEqual(plan);
    expect(await second.blocksMutation(`${target.storageUrl}child`)).toBe(true);
    await second.complete('op');
    expect(await second.blocksMutation(`${target.storageUrl}child`)).toBe(false);
    expect((await second.createLocal({ ...target, podId: 'new-pod' }, 'op')).podId).toBe('p');
    await expect(second.createLocal({ ...target, storageUrl: 'https://other.test/' }, 'op')).rejects.toThrow('target mismatch');
  });
});

describe('explicit legacy binding authorization', () => {
  async function fixture() {
    const { DrizzleIndexedStorage } = await import('../../../src/identity/drizzle/DrizzleIndexedStorage');
    const url = `sqlite::memory:${randomUUID()}`;
    const store = new DrizzleIndexedStorage(url);
    const pod = await store.create('pod', { accountId: 'creator', baseUrl: 'https://node.test/p/' });
    const repository = new PodDeletionOperationRepository(url);
    const target = { accountId: 'creator', podId: pod.id, nodeId: 'node', storageUrl: pod.baseUrl, returnUrl: 'https://cloud.test/.account/account/' };
    return { repository, store, pod, target, ...(await repository.createAuthorization(target)) };
  }
  it('makes preflight read-only and atomically consumes one nonce for exactly one immutable generation', async () => {
    const f = await fixture();
    expect(await f.repository.authorizationDetails(f.challenge, 'wrong-node')).toBeUndefined();
    expect(await f.repository.authorizationDetails(`${f.details.challengeId}.${'x'.repeat(43)}`, 'node')).toBeUndefined();
    expect(await f.repository.authorizationDetails(f.challenge, 'node')).toEqual(f.details);
    expect(await f.repository.remoteGeneration(f.pod.id, 'node', f.pod.baseUrl)).toBeUndefined();
    const outcomes = await Promise.all(['first', 'second'].map((generation) => f.repository.authorizeGeneration(f.challenge, 'node', generation)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = outcomes[0] ? 'first' : 'second';
    expect(await f.repository.remoteGeneration(f.pod.id, 'node', f.pod.baseUrl)).toBe(winner);
    expect(await f.repository.authorizeGeneration(f.challenge, 'node', 'replay')).toBe(false);
  });
  it('rejects a changed creator and any pre-existing deletion operation', async () => {
    const moved = await fixture();
    await moved.store.set('pod', { ...moved.pod, accountId: 'other' });
    expect(await moved.repository.authorizeGeneration(moved.challenge, 'node', 'local')).toBe(false);
    const pending = await fixture();
    await pending.repository.create(pending.target);
    expect(await pending.repository.authorizeGeneration(pending.challenge, 'node', 'local')).toBe(false);
    const bound = await fixture();
    await bound.repository.bindRemoteGeneration(bound.pod.id, 'node', bound.pod.baseUrl, 'original');
    expect(await bound.repository.authorizeGeneration(bound.challenge, 'node', 'replacement')).toBe(false);
  });
  it('rejects expiry without consuming a generation', async () => {
    const { vi } = await import('vitest');
    const f = await fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.details.expiresAt + 1);
    try { expect(await f.repository.authorizeGeneration(f.challenge, 'node', 'local')).toBe(false); }
    finally { clock.mockRestore(); }
  });
});
