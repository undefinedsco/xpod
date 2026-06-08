import { describe, expect, it, vi } from 'vitest';
import {
  checkFirstPodNameAvailability,
  createFirstPodAndWaitForWebIds,
  deriveFirstPodNameCandidate,
  waitForConsentWebIds,
} from '../../ui/src/utils/consent-first-pod';

describe('consent first Pod helpers', () => {
  it('derives a valid Pod name from a WebID path', () => {
    expect(deriveFirstPodNameCandidate([
      'https://id.undefineds.co/glocal/profile/card#me',
    ])).toBe('glocal');
  });

  it('creates a Pod with provision code and waits for consent WebIDs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        registered: true,
        provisionCode: 'fresh-provision-code',
      }))
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

    expect(fetchMock.mock.calls[0]).toEqual([
      '/provision/status',
      {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      },
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/.account/account/pod',
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
          settings: { provisionCode: 'fresh-provision-code' },
        }),
      },
    ]);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/.account/oidc/pick-webid/');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/.account/oidc/pick-webid/');
  });

  it('maps creation conflicts to an actionable name error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(409, {
      message: 'There already is a resource at https://node.example/glocal/',
    }));

    await expect(createFirstPodAndWaitForWebIds({
      createPodUrl: '/.account/account/pod',
      fetchImpl: fetchMock as unknown as typeof fetch,
      pickWebIdUrl: '/.account/oidc/pick-webid/',
      username: 'glocal',
    })).rejects.toThrow('Pod name is already taken');
  });

  it('uses the created WebID response while consent WebID polling catches up', async () => {
    const fetchMock = vi.fn()
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('checks provisioned SP Pod name availability', async () => {
    const provisionCode = makeProvisionCode();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        registered: true,
        provisionCode,
      }))
      .mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }));

    await expect(checkFirstPodNameAvailability({
      fetchImpl: fetchMock as unknown as typeof fetch,
      provisionCode,
      username: 'glocal-new',
    })).resolves.toEqual({
      status: 'available',
      message: 'This Pod name is available.',
    });

    expect(fetchMock.mock.calls[1]).toEqual([
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
      .mockResolvedValueOnce(jsonResponse(200, {
        registered: true,
        provisionCode,
      }))
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
