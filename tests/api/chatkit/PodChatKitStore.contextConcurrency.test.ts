import { describe, expect, it, vi } from 'vitest';

import { PodChatKitStore } from '../../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../../src/api/chatkit/store';
import type { PodAccessFetchProvider } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';

const OWNER = 'https://pod.example/alice/profile/card#me';
const OTHER = 'https://pod.example/bob/profile/card#me';
const caller = { type: 'solid', webId: OWNER } as StoreContext['auth'];

describe('PodChatKitStore request-scoped database acquisition', () => {
  it('opens one Pod database when a single request context is used concurrently', async () => {
    const podFetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    const getPodFetch = vi.fn(async () => podFetch);
    const store = new PodChatKitStore({ podAccess: { getPodFetch } as PodAccessFetchProvider });
    const context: StoreContext = { userId: OWNER, auth: caller };

    await Promise.allSettled([
      store.loadThreads(1, undefined, 'desc', context),
      store.loadThreads(1, undefined, 'desc', context),
    ]);

    // `GET /api/tasks` fans out with Promise.all over one context. The context already caches the
    // database, but without an in-flight guard both reads race past the empty cache and each opens
    // a Pod database (credential resolution + init) for the same request.
    expect(getPodFetch).toHaveBeenCalledTimes(1);
    expect((context as { _cachedDb?: unknown })._cachedDb).toBeDefined();
  });

  it('never shares a Pod database between distinct request credentials', async () => {
    const podFetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    const getPodFetch = vi.fn(async () => podFetch);
    const store = new PodChatKitStore({ podAccess: { getPodFetch } as PodAccessFetchProvider });
    const ownerContext: StoreContext = { userId: OWNER, auth: caller };
    const otherContext: StoreContext = { userId: OTHER, auth: { type: 'solid', webId: OTHER } };

    await Promise.allSettled([
      store.loadThreads(1, undefined, 'desc', ownerContext),
      store.loadThreads(1, undefined, 'desc', otherContext),
    ]);

    // The in-flight guard is bound to one request context; a second principal still resolves and
    // opens its own Pod database, so a revoked or foreign credential can never reuse privileged
    // state that was opened for someone else.
    expect(getPodFetch).toHaveBeenCalledTimes(2);
    expect((ownerContext as { _cachedDb?: unknown })._cachedDb)
      .not.toBe((otherContext as { _cachedDb?: unknown })._cachedDb);
  });

  it('re-resolves Pod access after a failed open instead of caching the failure', async () => {
    const podFetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    let calls = 0;
    const getPodFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient credential failure');
      return podFetch;
    });
    const store = new PodChatKitStore({ podAccess: { getPodFetch } as PodAccessFetchProvider });
    const context: StoreContext = { userId: OWNER, auth: caller };

    await expect(store.loadThreads(1, undefined, 'desc', context))
      .rejects.toThrow('transient credential failure');
    await expect(store.loadThreads(1, undefined, 'desc', context)).resolves.toBeDefined();

    // A rejected in-flight open must not be remembered: the next request-scoped call resolves the
    // credential again rather than reusing a poisoned database.
    expect(getPodFetch).toHaveBeenCalledTimes(2);
    expect((context as { _cachedDb?: unknown })._cachedDb).toBeDefined();
  });
});
