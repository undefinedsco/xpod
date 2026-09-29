import { describe, expect, it } from 'vitest';

import { PodChatKitStore } from '../../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../../src/api/chatkit/store';
import { CALLER_POD_ACCESS_UNAVAILABLE } from '../../../src/api/ai-gateway/auth/CallerPodAccess';
import { CALLER_DPOP_REPLAY_UNSUPPORTED } from '../../../src/api/ai-gateway/auth/CallerPodAccess';
import {
  POD_INTERFACE_KEY_MISSING,
  type PodAccessFetchProvider,
} from '../../../src/api/ai-gateway/pod/OwnerPodAccess';

const OWNER = 'https://pod.example/alice/profile/card#me';

function storeWith(podAccess: PodAccessFetchProvider): PodChatKitStore {
  return new PodChatKitStore({ podAccess });
}

const browserCaller = {
  type: 'solid',
  webId: OWNER,
  tokenType: 'DPoP',
  accessToken: 'browser-token',
} as StoreContext['auth'];

const bearerCaller = {
  type: 'solid',
  webId: OWNER,
  tokenType: 'Bearer',
  accessToken: 'reusable-token',
} as StoreContext['auth'];

describe('PodChatKitStore Pod access failures', () => {
  it('says a browser session cannot be replayed instead of reporting an empty history', async () => {
    const store = storeWith({ getPodFetch: async () => undefined });

    await expect(store.loadThreads(20, undefined, 'desc', { userId: OWNER, auth: browserCaller }))
      .rejects.toThrow(CALLER_DPOP_REPLAY_UNSUPPORTED);
  });

  it('says a reusable Bearer caller has no Pod credential on file', async () => {
    const store = storeWith({ getPodFetch: async () => undefined });

    await expect(store.loadThreads(20, undefined, 'desc', { userId: OWNER, auth: bearerCaller }))
      .rejects.toThrow(POD_INTERFACE_KEY_MISSING);
  });

  it('says authentication is missing when the context carries no Solid identity', async () => {
    const store = storeWith({ getPodFetch: async () => undefined });

    await expect(store.loadThreads(20, undefined, 'desc', { userId: 'anonymous' }))
      .rejects.toThrow(CALLER_POD_ACCESS_UNAVAILABLE);
  });

  it('reports the reason the credential was refused', async () => {
    const store = storeWith({
      getPodFetch: async () => {
        throw new Error(`${POD_INTERFACE_KEY_MISSING}`);
      },
    });

    await expect(store.loadThreads(20, undefined, 'desc', { userId: OWNER, auth: bearerCaller }))
      .rejects.toThrow(POD_INTERFACE_KEY_MISSING);
  });

  it('still answers with data when a Pod fetch is available', async () => {
    const rows: unknown[] = [];
    const store = storeWith({ getPodFetch: async () => (async () => new Response('ok')) as typeof fetch });

    // The drizzle instance is cached on the context, so this exercises the empty-history path
    // with a working database rather than the failure path above.
    const context = {
      userId: OWNER,
      auth: bearerCaller,
      _cachedDb: {
        select: () => ({
          from: () => ({
            where: () => ({ execute: async () => rows }),
            execute: async () => rows,
          }),
        }),
      },
    } as unknown as StoreContext;

    await expect(store.loadThreads(20, undefined, 'desc', context)).resolves.toMatchObject({ data: [] });
  });
});
