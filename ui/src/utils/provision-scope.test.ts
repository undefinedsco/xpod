// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { registerLocalProvisionResolver, unregisterLocalProvisionResolver } from './pod';
import {
  lookupProvisionScopedWebIds,
  prepareProvisionedPod,
  resolveProvisionApiBaseUrl,
  resolveProvisionScope,
} from './provision-scope';

const cloudProfile = { profileUrl: 'https://id.example/.account/account-a/profile/', headers: { Authorization: 'CSS-Account-Token account-a' } };
const cloudWebId = 'https://id.example/alice/profile/card#me';

function makeProvisionCode(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const base64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  return `${base64}.sig`;
}

describe('provision-scope', () => {
  test('fails closed when the authenticated Account lacks a profile control', async () => {
    const code = makeProvisionCode({ spUrl: 'https://local.example/', serviceToken: 'service-token' });
    const request = vi.fn();
    await expect(prepareProvisionedPod(request, 'alice', code)).rejects.toThrow('controls.account.profile');
    expect(request).not.toHaveBeenCalled();
  });

  test.each([401, 409, 500])('does not prepare Local storage when Cloud profile preparation returns %s', async status => {
    const code = makeProvisionCode({ spUrl: 'https://local.example/', serviceToken: 'service-token' });
    const request = vi.fn(async () => new Response(JSON.stringify({ message: 'Cloud profile unavailable' }), { status }));
    await expect(prepareProvisionedPod(request, 'alice', code, cloudProfile)).rejects.toThrow('Cloud profile unavailable');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each([{}, { webId: '' }, { webId: 'not-a-url' }])('rejects invalid Cloud identity before Local provisioning: %j', async body => {
    const code = makeProvisionCode({ spUrl: 'https://local.example/', serviceToken: 'service-token' });
    const request = vi.fn(async () => new Response(JSON.stringify(body)));
    await expect(prepareProvisionedPod(request, 'alice', code, cloudProfile)).rejects.toThrow('Cloud profile preparation did not return a valid WebID');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each([401, 404, 500])('does not interpret HTTP %s as missing Local storage', async (status) => {
    const code = makeProvisionCode({ spUrl: 'https://node.example/', serviceToken: 'test-token' });
    const fetchMock = vi.fn(async () => new Response('{}', { status }));
    await expect(lookupProvisionScopedWebIds(fetchMock, ['https://id.example/alice#me'], code))
      .rejects.toThrow(`Local storage bindings request failed (${status})`);
  });

  test.each(['not-json', '{}', '{"entries":[{}]}'])('rejects malformed binding responses: %s', async (body) => {
    const code = makeProvisionCode({ spUrl: 'https://node.example/', serviceToken: 'test-token' });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    await expect(lookupProvisionScopedWebIds(fetchMock, ['https://id.example/alice#me'], code))
      .rejects.toThrow('Local storage bindings response is malformed');
  });

  afterEach(() => {
    unregisterLocalProvisionResolver();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  test('queries the local Xpod route while keeping the Cloud canonical storage root', async () => {
    window.history.replaceState(null, '', '/app/');
    registerLocalProvisionResolver(async () => 'test-provision-code');
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
    registerLocalProvisionResolver(async () => 'test-provision-code');
    const provisionCode = makeProvisionCode({
      spUrl: 'https://node-0000.nodes.undefineds.co/',
      spDomain: 'node-0000.nodes.undefineds.co',
      serviceAccessToken: 'service-token',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    });
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (url) => new Response(JSON.stringify(String(url) === cloudProfile.profileUrl ? { webId: cloudWebId } : {
      success: true,
      podUrl: 'https://node-0000.nodes.undefineds.co/alice/',
      provisionReceipt: 'receipt-token',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));

    const prepared = await prepareProvisionedPod(
      fetchMock as unknown as typeof fetch,
      'alice',
      provisionCode,
      cloudProfile,
    );

    expect(fetchMock).toHaveBeenCalledWith(new URL('/provision/pods', window.location.origin).href, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer service-token' }),
      body: JSON.stringify({ podName: 'alice', webId: cloudWebId }),
    }));
    expect(prepared).toEqual({ provisionCode, provisionReceipt: 'receipt-token', preparedWebId: cloudWebId });
    expect(fetchMock.mock.calls[0][0]).toBe(cloudProfile.profileUrl);
    const profileInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(profileInit.headers).get('Authorization')).toBe('CSS-Account-Token account-a');
    expect(profileInit.body).toBe(JSON.stringify({ podName: 'alice' }));
  });

  test('does not mistake a loopback Cloud Account page for the Local provisioning service', async () => {
    window.history.replaceState(null, '', '/.account/login/password/register/');
    const provisionCode = makeProvisionCode({ spUrl: 'http://127.0.0.1:39991/', serviceToken: 'test-token' });
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (url) => new Response(JSON.stringify(String(url) === cloudProfile.profileUrl ? { webId: cloudWebId } : { provisionReceipt: 'receipt' }), { status: 201 }));
    await prepareProvisionedPod(fetchMock, 'alice', provisionCode, cloudProfile);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:39991/provision/pods', expect.objectContaining({ method: 'POST' }));
  });

  test('uses the Cloud-issued SP protocol domain from a hosted Account page', async () => {
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
      lookupUrl: 'https://node-0000.nodes.undefineds.co/',
      storageRoot: 'https://node-0000.nodes.undefineds.co/',
    });
    expect(resolveProvisionApiBaseUrl(scope!)).toBe('https://node-0000.nodes.undefineds.co/');

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (url) => new Response(JSON.stringify(String(url) === cloudProfile.profileUrl ? { webId: cloudWebId } : {
      success: true,
      provisionReceipt: 'receipt-token',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));

    await prepareProvisionedPod(fetchMock as unknown as typeof fetch, 'alice', provisionCode, cloudProfile);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://node-0000.nodes.undefineds.co/provision/pods',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
