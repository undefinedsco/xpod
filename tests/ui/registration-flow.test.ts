import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeRegistrationProvisioning } from '../../ui/src/utils/registration-flow';

describe('completeRegistrationProvisioning', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates profile, pod, storage link, webid link, and oidc pick before consent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, { success: true }))
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/alice/' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
      .mockResolvedValueOnce(jsonResponse(200, { webidUrl: 'https://id.example/alice/profile/card#me' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
      .mockResolvedValueOnce(jsonResponse(200, { location: '/.account/oidc/consent/' }))
      .mockResolvedValueOnce(jsonResponse(200, { webIds: ['https://id.example/alice/profile/card#me'] }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      idpIndex: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ redirectedToConsent: true });
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/identity');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/.account/account/pod');
    expect(fetchMock.mock.calls[5]?.[0]).toBe('/.account/account/webid');
    expect(fetchMock.mock.calls[6]?.[0]).toBe('https://id.example/oidc/pick-webid/');
  });
});

function jsonResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  } as Response;
}
