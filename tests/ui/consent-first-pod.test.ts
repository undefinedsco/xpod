// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFirstPodAndWaitForBinding,
  checkFirstPodNameAvailability,
  createFirstPodAndWaitForWebIds,
  deriveFirstPodNameCandidate,
  waitForConsentWebIds,
  waitForConsentBindings,
} from '../../ui/src/utils/consent-first-pod';

import { registerLocalProvisionResolver, unregisterLocalProvisionResolver } from '../../ui/src/utils/pod';

describe('consent first Pod helpers', () => {
  afterEach(() => {
    unregisterLocalProvisionResolver();
    document.cookie = 'css-account=; Path=/; Max-Age=0';
  });
  beforeEach(() => {
    // The hosted-control guard resolves Account URLs against
    // window.location.origin; keep provision-code storage isolated per test.
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('derives a valid Pod name from a WebID path', () => {
    expect(deriveFirstPodNameCandidate([
      'https://id.undefineds.co/glocal/profile/card#me',
    ])).toBe('glocal');
  });

  it('creates a Pod with provision code and waits for consent WebIDs', async () => {
    document.cookie = 'css-account=token; Path=/';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyAccountInventory())
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/glocal/' }))
      .mockResolvedValueOnce(jsonResponse(200, { webIds: [] }))
      .mockResolvedValueOnce(jsonResponse(200, {
        webIds: [ 'https://id.undefineds.co/glocal/profile/card#me' ],
      }));

    await expect(createFirstPodAndWaitForWebIds({
      createPodUrl: '/.account/account/pod',
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: { Authorization: 'CSS-Account-Token token' },
      maxAttempts: 2,
      pickWebIdUrl: '/.account/oidc/pick-webid/',
      pollIntervalMs: 0,
      provisionCode: 'provision-code',
      username: 'GLOCAL',
    })).resolves.toEqual([ 'https://id.undefineds.co/glocal/profile/card#me' ]);

    expect(fetchMock.mock.calls.some(([url]) => url === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3000/.account/account/pod');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[1]).toEqual([
      'http://localhost:3000/.account/account/pod',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'CSS-Account-Token token',
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          name: 'glocal',
          settings: { provisionCode: 'provision-code' },
        }),
      },
    ]);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/.account/oidc/pick-webid/');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/.account/oidc/pick-webid/');
  });

  it('prepares a Local Pod receipt before sending the CSS Account create request', async () => {
    document.cookie = 'css-account=token; Path=/';
    const provisionCode = makeProvisionCode();
    registerLocalProvisionResolver(async () => provisionCode);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyAccountInventory())
      .mockResolvedValueOnce(jsonResponse(201, {
        podUrl: 'https://node.example/glocal/',
        provisionReceipt: 'provision-receipt',
      }))
      .mockResolvedValueOnce(jsonResponse(201, {
        podUrl: 'https://node.example/glocal/',
        webId: 'https://node.example/glocal/profile/card#me',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        webIds: [ 'https://node.example/glocal/profile/card#me' ],
      }));

    await expect(createFirstPodAndWaitForWebIds({
      createPodUrl: '/.account/account/pod',
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: { Authorization: 'CSS-Account-Token token' },
      maxAttempts: 1,
      pickWebIdUrl: '/.account/oidc/pick-webid/',
      pollIntervalMs: 0,
      provisionCode,
      username: 'GLOCAL',
    })).resolves.toEqual([ 'https://node.example/glocal/profile/card#me' ]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3000/.account/account/pod');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[1]).toEqual([
      'http://localhost:3000/provision/pods',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer service-token',
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ podName: 'glocal' }),
      },
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      'http://localhost:3000/.account/account/pod',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'CSS-Account-Token token',
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          name: 'glocal',
          settings: {
            provisionCode,
            provisionReceipt: 'provision-receipt',
          },
        }),
      },
    ]);
  });

  it('maps creation conflicts to an actionable name error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyAccountInventory())
      .mockResolvedValueOnce(jsonResponse(409, {
        message: 'There already is a resource at https://node.example/glocal/',
      }));

    await expect(createFirstPodAndWaitForWebIds({
      createPodUrl: '/.account/account/pod',
      fetchImpl: fetchMock as unknown as typeof fetch,
      pickWebIdUrl: '/.account/oidc/pick-webid/',
      username: 'glocal',
    })).rejects.toThrow('Pod 名称已被占用');
  });

  it('uses the created WebID response while consent WebID polling catches up', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyAccountInventory())
      .mockResolvedValueOnce(jsonResponse(201, {
        podUrl: 'https://node.example/glocal/',
        webId: 'https://id.undefineds.co/glocal/profile/card#me',
      }))
      .mockResolvedValue(jsonResponse(200, { webIds: [] }));

    await expect(createFirstPodAndWaitForWebIds({
      createPodUrl: '/.account/account/pod',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
      pickWebIdUrl: '/.account/oidc/pick-webid/',
      pollIntervalMs: 0,
      username: 'glocal',
    })).resolves.toEqual([ 'https://id.undefineds.co/glocal/profile/card#me' ]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('checks provisioned SP Pod name availability', async () => {
    const provisionCode = makeProvisionCode();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }));

    await expect(checkFirstPodNameAvailability({
      fetchImpl: fetchMock as unknown as typeof fetch,
      provisionCode,
      username: 'glocal-new',
    })).resolves.toEqual({
      status: 'available',
      message: 'This Pod name is available.',
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      'https://node.example/provision/pods/glocal-new',
      {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer service-token',
        },
        credentials: 'include',
      },
    ]);
  });

  it('reports taken when the provisioned SP already has the Pod name', async () => {
    const provisionCode = makeProvisionCode();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { exists: true }));

    await expect(checkFirstPodNameAvailability({
      fetchImpl: fetchMock as unknown as typeof fetch,
      provisionCode,
      username: 'glocal',
    })).resolves.toEqual({
      status: 'taken',
      message: 'Pod name "glocal" is already used on this storage.',
    });
  });

  it('returns an empty list when consent WebID polling does not settle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { webIds: [] }));

    await expect(waitForConsentWebIds({
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
      pickWebIdUrl: '/.account/oidc/pick-webid/',
      pollIntervalMs: 0,
    })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  const exactWebIds = [
    'https://POD.example/alice/profile/card#me',
    'https://pod.example:443/alice/profile/card#me',
    'https://pod.example/alice/./profile/card#me',
    'https://pod.example/alice/profile/card?view=1#me',
    'https://pod.example/alice/profile/card?view=2#me',
    'https://pod.example/alice/profile/card#other',
    'https://pod.example/alice/profile/card#me',
  ];

  it('keeps distinct original WebIDs when polling while deduplicating identical bindings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      entries: [...exactWebIds, exactWebIds[0]].map((webId) => ({
        webId, storageUrl: 'https://STORAGE.example:443/alice',
      })),
    }));
    await expect(waitForConsentBindings({
      fetchImpl: fetchMock as unknown as typeof fetch,
      pickWebIdUrl: '/.account/oidc/pick-webid/', maxAttempts: 1,
    })).resolves.toEqual(exactWebIds.map((webId) => ({
      webId, storageUrl: 'https://storage.example/alice/',
    })));
  });

  it('preserves complete WebIDs returned by Pod creation without merging URL spellings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyAccountInventory())
      .mockResolvedValue(jsonResponse(201, {
        webId: exactWebIds[0], webIds: exactWebIds,
        podUrl: 'https://STORAGE.example:443/alice',
      }));
    await expect(createFirstPodAndWaitForBinding({
      createPodUrl: '/.account/account/pod',
      fetchImpl: fetchMock as unknown as typeof fetch,
      provisionCode: 'provision-code', username: 'alice',
    })).resolves.toEqual(exactWebIds.map((webId) => ({
      webId, storageUrl: 'https://storage.example/alice/',
    })));
  });

  it.each(['not a URL', 'ftp://pod.example/card#me',
    ' https://pod.example/card#me', 'https://pod.example/card#me ',
    'https://pod.\nexample/card#me', 'https://pod.\rexample/card#me',
    'https://pod.\texample/card#me',
  ])('rejects invalid WebID input %j instead of repairing its identity', async (webId) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      entries: [{ webId, storageUrl: 'https://storage.example/alice/' }],
    }));
    await expect(waitForConsentBindings({
      fetchImpl: fetchMock as unknown as typeof fetch,
      pickWebIdUrl: '/.account/oidc/pick-webid/', maxAttempts: 1,
    })).resolves.toEqual([]);
  });

  it('creates and polls the exact WebID/storage binding before consent continues', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyAccountInventory())
      .mockResolvedValueOnce(jsonResponse(201, {
        podUrl: 'https://app.example/glocal/',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { entries: [] }))
      .mockResolvedValueOnce(jsonResponse(200, {
        entries: [{
          webId: 'https://app.example/glocal/profile/card#me',
          storageUrl: 'https://app.example/glocal/',
        }],
        webIds: ['https://evil.example/not-authoritative'],
      }));

    await expect(createFirstPodAndWaitForBinding({
      createPodUrl: '/.account/account/pod',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
      pickWebIdUrl: '/.account/oidc/pick-webid/',
      pollIntervalMs: 0,
      username: 'glocal',
    })).resolves.toEqual([{
      webId: 'https://app.example/glocal/profile/card#me',
      storageUrl: 'https://app.example/glocal/',
    }]);
  });
});

function makeProvisionCode(): string {
  const payload = Buffer.from(JSON.stringify({
    spUrl: 'https://node.example/',
    serviceToken: 'service-token',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `${payload}.signature`;
}

function jsonResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => typeof json === 'string' ? json : JSON.stringify(json),
  } as Response;
}

/**
 * First-Pod creation reads the authoritative Account Pod inventory before it
 * prepares or creates anything, so every create/poll mock chain has to answer
 * that GET first. An empty inventory is what lets a genuinely new account
 * bootstrap a Pod.
 */
function emptyAccountInventory(): Response {
  return jsonResponse(200, { pods: {} });
}
