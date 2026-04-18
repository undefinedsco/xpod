import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapAccountPasswordLogin, completeRegistrationProvisioning } from '../../ui/src/utils/registration-flow';

describe('completeRegistrationProvisioning', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates pod and waits for server-linked WebID before consent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/alice/' }))
      .mockResolvedValueOnce(jsonResponse(200, { webIdLinks: { 'https://id.example/alice/profile/card#me': '/.account/account/webid/1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      idpIndex: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ redirectedToConsent: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://id.example/');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/.account/account/pod');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/.account/account/webid');
  });

  it('treats a visible pod record as ready even before webIdLinks catches up', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/alice/' }))
      .mockResolvedValueOnce(jsonResponse(200, { webIdLinks: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { pods: { 'https://pods.example/alice/': '/.account/account/pod/1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      idpIndex: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ redirectedToConsent: true });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/.account/account/webid');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/.account/account/pod');
  });

  it('maps duplicate pod resource errors to a clear username conflict message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(409, {
        message: 'Pod creation failed: There already is a resource at https://id.example/alice/',
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      idpIndex: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Username is already taken. Your account was created; sign in and choose another Pod name.');
  });
});

describe('bootstrapAccountPasswordLogin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates account, uses CSS account token, and resolves login endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { authorization: 'acct-token-1' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          password: {
            create: '/.account/password/create',
            login: '/.account/login/password/',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await bootstrapAccountPasswordLogin({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountCreateUrl: '/.account/account/',
      email: 'alice@example.com',
      password: 'secret',
      idpIndex: 'https://id.example/.account/',
    });

    expect(result).toEqual({ loginUrl: '/.account/login/password/' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
        'Content-Type': 'application/json',
      },
    });
  });
});

function jsonResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  } as Response;
}
