import { describe, expect, it, vi } from 'vitest';
import { createPodRuntime } from '../src/pod-runtime';
import type { PodRuntimeAdapter } from '../src/pod-runtime';

type TestDatabase = {
  id: string;
};

function createAdapter(
  discoverPod: PodRuntimeAdapter<TestDatabase>['discoverPod'] = vi.fn(async () => 'https://pod.example/alice/'),
) {
  return {
    discoverPod: vi.fn(discoverPod),
    openDatabase: vi.fn(async ({ podUrl }) => ({ id: `db:${podUrl}` })),
    hydrateCollections: vi.fn(async () => undefined),
  } satisfies PodRuntimeAdapter<TestDatabase>;
}

describe('createPodRuntime', () => {
  it('opens an explicit Pod URL without discovery', async () => {
    const adapter = createAdapter();
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const opened = await runtime.open({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice',
      fetch: authenticatedFetch,
    });

    expect(opened.podUrl).toBe('https://pod.example/alice');
    expect(adapter.discoverPod).not.toHaveBeenCalled();
    expect(adapter.openDatabase).toHaveBeenCalledWith({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice',
      fetch: authenticatedFetch,
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    });
  });

  it('does not reuse a cached explicit Pod when the same WebID selects another Pod', async () => {
    const adapter = createAdapter();
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const first = await runtime.open({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice',
      fetch: authenticatedFetch,
    });
    const second = await runtime.open({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice-secondary',
      fetch: authenticatedFetch,
    });

    expect(first).not.toBe(second);
    expect(first.podUrl).toBe('https://pod.example/alice');
    expect(second.podUrl).toBe('https://pod.example/alice-secondary');
    expect(adapter.discoverPod).not.toHaveBeenCalled();
    expect(adapter.openDatabase).toHaveBeenCalledTimes(2);
  });

  it('clears only the selected explicit Pod and leaves another Pod cached', async () => {
    const adapter = createAdapter();
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const first = await runtime.open({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice',
      fetch: authenticatedFetch,
    });
    const second = await runtime.open({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice-secondary',
      fetch: authenticatedFetch,
    });
    runtime.clear({ webId: 'https://id.example/alice#me', podUrl: first.podUrl });

    const reopenedSecond = await runtime.open({
      webId: 'https://id.example/alice#me',
      podUrl: second.podUrl,
      fetch: authenticatedFetch,
    });
    const reopenedFirst = await runtime.open({
      webId: 'https://id.example/alice#me',
      podUrl: first.podUrl,
      fetch: authenticatedFetch,
    });

    expect(reopenedSecond).toBe(second);
    expect(reopenedFirst).not.toBe(first);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(3);
  });

  it('single-flights concurrent opens for the same identity', async () => {
    let resolvePod: (podUrl: string) => void = () => undefined;
    const discovery = new Promise<string>((resolve) => {
      resolvePod = resolve;
    });
    const adapter = createAdapter(() => discovery);
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const first = runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    const second = runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    resolvePod('https://pod.example/alice/');

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);
    expect(firstResult).toEqual({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      database: { id: 'db:https://pod.example/alice/' },
      collections: 'ready',
    });
    expect(adapter.discoverPod).toHaveBeenCalledTimes(1);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(1);
  });

  it('reuses a successful open without rediscovery', async () => {
    const adapter = createAdapter();
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const first = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    const second = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    expect(first).toBe(second);
    expect(adapter.discoverPod).toHaveBeenCalledTimes(1);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(1);
  });

  it('evicts discovery failures so the identity can be retried', async () => {
    const adapter = createAdapter(
      vi.fn()
        .mockRejectedValueOnce(new Error('discovery failed'))
        .mockResolvedValueOnce('https://pod.example/alice/'),
    );
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    await expect(runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    })).rejects.toThrow('discovery failed');
    await expect(runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    })).resolves.toMatchObject({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      collections: 'ready',
    });

    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(1);
  });

  it('isolates different WebIDs even when they discover the same Pod URL', async () => {
    const adapter = createAdapter(async () => 'https://pod.example/shared/');
    const runtime = createPodRuntime({ adapter });
    const aliceFetch = vi.fn() as unknown as typeof fetch;
    const bobFetch = vi.fn() as unknown as typeof fetch;

    const alice = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: aliceFetch,
    });
    const bob = await runtime.open({
      webId: 'https://id.example/bob#me',
      fetch: bobFetch,
    });

    expect(alice).not.toBe(bob);
    expect(alice.webId).toBe('https://id.example/alice#me');
    expect(bob.webId).toBe('https://id.example/bob#me');
    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(2);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(2);
  });

  it('uses clear to rediscover the same WebID when its Pod URL may have changed', async () => {
    const adapter = createAdapter(
      vi.fn()
        .mockResolvedValueOnce('https://pod.example/alice/')
        .mockResolvedValueOnce('https://pod.example/alice-new/'),
    );
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const first = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    runtime.clear({ webId: 'https://id.example/alice#me' });
    const second = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    expect(first.podUrl).toBe('https://pod.example/alice/');
    expect(second.podUrl).toBe('https://pod.example/alice-new/');
    expect(first).not.toBe(second);
    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(2);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(2);
  });

  it('passes the original fetch reference through without wrapping or cloning it', async () => {
    const adapter = createAdapter();
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    expect(adapter.discoverPod).toHaveBeenCalledWith({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    });
    expect(adapter.openDatabase).toHaveBeenCalledWith({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      fetch: authenticatedFetch,
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    });
  });

  it('evicts hydrate failures so the full open can be retried', async () => {
    const adapter = createAdapter();
    adapter.hydrateCollections
      .mockRejectedValueOnce(new Error('hydrate failed'))
      .mockResolvedValueOnce(undefined);
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    await expect(runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    })).rejects.toThrow('hydrate failed');
    await expect(runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    })).resolves.toMatchObject({
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      collections: 'ready',
    });

    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(2);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(2);
  });

  it('dispose clears successful cached opens', async () => {
    const adapter = createAdapter();
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    runtime.dispose();
    await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(2);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(2);
  });

  it('clear for a WebID prevents a pending open from repopulating the cache after it resolves', async () => {
    let resolvePod: (podUrl: string) => void = () => undefined;
    const discovery = new Promise<string>((resolve) => {
      resolvePod = resolve;
    });
    const adapter = createAdapter(
      vi.fn()
        .mockReturnValueOnce(discovery)
        .mockResolvedValueOnce('https://pod.example/alice-after-clear/'),
    );
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const pendingOpen = runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    runtime.clear({ webId: 'https://id.example/alice#me' });
    resolvePod('https://pod.example/alice/');
    await expect(pendingOpen).rejects.toThrow('Pod open aborted');
    const reopened = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    expect(reopened.podUrl).toBe('https://pod.example/alice-after-clear/');
    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(1);
  });

  it('clear without identity prevents pending opens from repopulating cache after logout reset', async () => {
    let resolvePod: (podUrl: string) => void = () => undefined;
    const discovery = new Promise<string>((resolve) => {
      resolvePod = resolve;
    });
    const adapter = createAdapter(
      vi.fn()
        .mockReturnValueOnce(discovery)
        .mockResolvedValueOnce('https://pod.example/alice-after-global-clear/'),
    );
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const pendingOpen = runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    runtime.clear();
    resolvePod('https://pod.example/alice/');
    await expect(pendingOpen).rejects.toThrow('Pod open aborted');
    const reopened = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    expect(reopened.podUrl).toBe('https://pod.example/alice-after-global-clear/');
    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(1);
  });

  it('dispose prevents a pending open from repopulating the cache after it resolves', async () => {
    let resolvePod: (podUrl: string) => void = () => undefined;
    const discovery = new Promise<string>((resolve) => {
      resolvePod = resolve;
    });
    const adapter = createAdapter(
      vi.fn()
        .mockReturnValueOnce(discovery)
        .mockResolvedValueOnce('https://pod.example/alice-after-dispose/'),
    );
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const pendingOpen = runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    runtime.dispose();
    resolvePod('https://pod.example/alice/');
    await expect(pendingOpen).rejects.toThrow('Pod open aborted');
    const reopened = await runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    expect(reopened.podUrl).toBe('https://pod.example/alice-after-dispose/');
    expect(adapter.discoverPod).toHaveBeenCalledTimes(2);
    expect(adapter.openDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.hydrateCollections).toHaveBeenCalledTimes(1);
  });

  it('does not run database or collection side effects for a stale open that resolves after a newer open', async () => {
    let resolveFirstPod: (podUrl: string) => void = () => undefined;
    let resolveSecondPod: (podUrl: string) => void = () => undefined;
    const firstDiscovery = new Promise<string>((resolve) => {
      resolveFirstPod = resolve;
    });
    const secondDiscovery = new Promise<string>((resolve) => {
      resolveSecondPod = resolve;
    });
    const sideEffects: string[] = [];
    const adapter = {
      discoverPod: vi.fn()
        .mockReturnValueOnce(firstDiscovery)
        .mockReturnValueOnce(secondDiscovery),
      openDatabase: vi.fn(async ({ podUrl, isCurrent }) => {
        sideEffects.push(`open:${podUrl}:${isCurrent()}`);
        return { id: `db:${podUrl}` };
      }),
      hydrateCollections: vi.fn(async ({ podUrl, isCurrent }) => {
        sideEffects.push(`hydrate:${podUrl}:${isCurrent()}`);
      }),
    } satisfies PodRuntimeAdapter<TestDatabase>;
    const runtime = createPodRuntime({ adapter });
    const authenticatedFetch = vi.fn() as unknown as typeof fetch;

    const staleOpen = runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });
    runtime.clear({ webId: 'https://id.example/alice#me' });
    const currentOpen = runtime.open({
      webId: 'https://id.example/alice#me',
      fetch: authenticatedFetch,
    });

    resolveSecondPod('https://pod.example/current/');
    await expect(currentOpen).resolves.toMatchObject({
      podUrl: 'https://pod.example/current/',
    });
    resolveFirstPod('https://pod.example/stale/');
    await expect(staleOpen).rejects.toThrow('Pod open aborted');

    expect(sideEffects).toEqual([
      'open:https://pod.example/current/:true',
      'hydrate:https://pod.example/current/:true',
    ]);
  });
});
