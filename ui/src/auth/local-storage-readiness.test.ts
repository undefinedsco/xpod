import { describe, expect, it, vi } from 'vitest';
import { waitForCurrentAccountStorageBindings } from './local-storage-readiness';

describe('managed Local durable binding readiness', () => {
  it('waits past an unrelated Cloud Pod until the exact Local scope is committed', async () => {
    const cloud = { webId: 'https://id.example/alice#me', storageUrl: 'https://id.example/alice/' };
    const local = { webId: cloud.webId, storageUrl: 'https://node.example/alice/' };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ bindings: [cloud] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ bindings: [cloud, local] })));
    const result = await waitForCurrentAccountStorageBindings({
      controls: { account: { bindings: 'https://id.example/.account/bindings' } },
      origin: 'https://id.example', trustedAccountIndex: 'https://id.example/.account/',
      storageRoot: 'https://node.example/', fetchImpl, maxAttempts: 2, pollIntervalMs: 0,
    });
    expect(result).toEqual([local]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed when creation never publishes a durable current-scope pair', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ bindings: [] })));
    await expect(waitForCurrentAccountStorageBindings({
      controls: { account: { bindings: '/.account/bindings' } }, origin: 'https://id.example',
      storageRoot: 'https://node.example/', fetchImpl, maxAttempts: 2, pollIntervalMs: 0,
    })).rejects.toThrow('storage binding');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
