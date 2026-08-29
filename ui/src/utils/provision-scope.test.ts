// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { lookupProvisionScopedWebIds } from './provision-scope';

function makeProvisionCode(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const base64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  return `${base64}.sig`;
}

describe('provision-scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  test('queries the local Xpod route while keeping the Cloud canonical storage root', async () => {
    window.history.replaceState(null, '', '/app/');
    const localLookupUrl = new URL('/provision/webids', window.location.origin).href;
    const provisionCode = makeProvisionCode({
      spUrl: 'https://node-0000.nodes.undefineds.co/',
      spDomain: 'node-0000.nodes.undefineds.co',
      serviceToken: 'service-token',
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [
        {
          webId: 'https://id.undefineds.co/alice/profile/card#me',
          storageUrl: 'https://node-0000.nodes.undefineds.co/alice/',
        },
        {
          webId: 'https://id.undefineds.co/alice/profile/card#me',
          storageUrl: 'https://other.nodes.undefineds.co/alice/',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const entries = await lookupProvisionScopedWebIds(fetchMock as unknown as typeof fetch, [
      'https://id.undefineds.co/alice/profile/card#me',
    ], provisionCode);

    expect(fetchMock).toHaveBeenCalledWith(localLookupUrl, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer service-token' }),
    }));
    expect(entries).toEqual([{
      webId: 'https://id.undefineds.co/alice/profile/card#me',
      podUrl: undefined,
      storageUrl: 'https://node-0000.nodes.undefineds.co/alice/',
    }]);
  });
});
