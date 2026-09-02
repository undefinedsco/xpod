// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { lookupProvisionScopedWebIds, type StorageScope } from './storage-scope';

describe('storage-scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  test('uses the local Xpod lookup route for a Cloud canonical storage scope', async () => {
    window.history.replaceState(null, '', '/settings/');
    const localLookupUrl = new URL('/provision/webids', window.location.origin).href;
    const scope: StorageScope = {
      root: 'https://node-0000.nodes.undefineds.co/',
      lookupUrl: 'https://node-0000.nodes.undefineds.co/',
      serviceToken: 'service-token',
      mode: 'local',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [
        {
          webId: 'https://id.undefineds.co/alice/profile/card#me',
          storageUrl: 'https://node-0000.nodes.undefineds.co/alice/',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const entries = await lookupProvisionScopedWebIds(fetchMock as unknown as typeof fetch, [
      'https://id.undefineds.co/alice/profile/card#me',
    ], scope);

    expect(fetchMock).toHaveBeenCalledWith(localLookupUrl, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer service-token' }),
    }));
    expect(entries).toEqual([{
      webId: 'https://id.undefineds.co/alice/profile/card#me',
      storageUrl: 'https://node-0000.nodes.undefineds.co/alice/',
      storageMode: 'local',
    }]);
  });
});
