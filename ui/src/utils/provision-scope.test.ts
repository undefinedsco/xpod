// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  lookupProvisionScopedWebIds,
  prepareProvisionedPod,
  resolveProvisionApiBaseUrl,
  resolveProvisionScope,
} from './provision-scope';

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

  test('prepares a provisioned Pod through the local Xpod route and returns the receipt', async () => {
    window.history.replaceState(null, '', '/app/');
    const provisionCode = makeProvisionCode({
      spUrl: 'https://node-0000.nodes.undefineds.co/',
      spDomain: 'node-0000.nodes.undefineds.co',
      serviceAccessToken: 'service-token',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      podUrl: 'https://node-0000.nodes.undefineds.co/alice/',
      provisionReceipt: 'receipt-token',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));

    const prepared = await prepareProvisionedPod(
      fetchMock as unknown as typeof fetch,
      'alice',
      provisionCode,
    );

    expect(fetchMock).toHaveBeenCalledWith(new URL('/provision/pods', window.location.origin).href, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer service-token' }),
      body: JSON.stringify({ podName: 'alice' }),
    }));
    expect(prepared).toEqual({ provisionCode, provisionReceipt: 'receipt-token' });
  });

  test('keeps the direct provisioning callback separate from Cloud canonical storage on a hosted Account page', () => {
    vi.stubGlobal('window', {
      location: { href: 'https://id.undefineds.co/.account/create-pod/' },
    });
    const provisionCode = makeProvisionCode({
      spUrl: 'http://127.0.0.1:5737/',
      spDomain: 'node-0000.nodes.undefineds.co',
      serviceAccessToken: 'service-token',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    });

    const scope = resolveProvisionScope(provisionCode);

    expect(scope).toMatchObject({
      lookupUrl: 'http://127.0.0.1:5737/',
      storageRoot: 'https://node-0000.nodes.undefineds.co/',
    });
    expect(resolveProvisionApiBaseUrl(scope!)).toBe('http://127.0.0.1:5737/');
  });
});
