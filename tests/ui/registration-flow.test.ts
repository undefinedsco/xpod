import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapAccountPasswordLogin,
  completeRegistrationProvisioning,
  loginAccountPassword,
} from '../../ui/src/utils/registration-flow';

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
      .mockResolvedValueOnce(jsonResponse(200, { pods: {} }))
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/alice/' }))
      .mockResolvedValueOnce(jsonResponse(200, { webIdLinks: { 'https://id.example/alice/profile/card#me': '/.account/account/webid/1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      idpIndex: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://id.example/');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/.account/account/pod');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/.account/account/pod');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
        'Content-Type': 'application/json',
      },
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/.account/account/webid');
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/.account/oidc/consent/');
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
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
      .mockResolvedValueOnce(jsonResponse(200, { pods: {} }))
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/alice/' }))
      .mockResolvedValueOnce(jsonResponse(200, { webIdLinks: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { pods: { 'https://pods.example/alice/': '/.account/account/pod/1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      idpIndex: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/.account/account/webid');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/.account/account/pod');
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
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
      .mockResolvedValueOnce(jsonResponse(200, { pods: {} }))
      .mockResolvedValueOnce(jsonResponse(409, {
        message: 'Pod creation failed: There already is a resource at https://id.example/alice/',
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      idpIndex: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Username is already taken. Your account was created; sign in and choose another Pod name.');
  });

  it('does not map unrelated pod creation errors to username conflicts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { pods: {} }))
      .mockResolvedValueOnce(jsonResponse(400, {
        message: 'An account needs at least 1 login method.',
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      idpIndex: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('An account needs at least 1 login method.');
  });

  it('does not map another pod path conflict to the current username', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { pods: {} }))
      .mockResolvedValueOnce(jsonResponse(409, {
        message: 'Pod creation failed: There already is a resource at https://id.example/bob/',
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      idpIndex: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Pod creation failed: There already is a resource at https://id.example/bob/');
  });

  it('continues when the requested username already belongs to the logged-in account', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        pods: { 'https://pods.example/alice/': '/.account/account/pod/1' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        webIdLinks: { 'https://id.example/alice/profile/card#me': '/.account/account/webid/1' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      idpIndex: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/.account/account/pod');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
  });

  it('fails registration when authenticated account controls do not expose pod creation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {},
        },
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      idpIndex: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Pod creation endpoint not found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
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

    expect(result).toEqual({ accountToken: 'acct-token-1', loginUrl: '/.account/login/password/' });
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

  it('maps duplicate email errors to a stable registration error', async () => {
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
      .mockResolvedValueOnce(jsonResponse(400, {
        message: 'There already is a login for this e-mail address.',
      }));

    await expect(bootstrapAccountPasswordLogin({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountCreateUrl: '/.account/account/',
      email: 'alice@example.com',
      password: 'secret',
      idpIndex: 'https://id.example/.account/',
    })).rejects.toMatchObject({
      name: 'RegistrationError',
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'This email is already registered. Sign in instead, or reset the password.',
    });
  });
});

describe('loginAccountPassword', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('logs into an existing account and returns the CSS account token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { authorization: 'acct-token-2' }));

    const result = await loginAccountPassword({
      fetchImpl: fetchMock as unknown as typeof fetch,
      loginUrl: '/.account/login/password/',
      email: 'alice@example.com',
      password: 'secret',
    });

    expect(result).toEqual({ accountToken: 'acct-token-2' });
    expect(fetchMock).toHaveBeenCalledWith('/.account/login/password/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: 'alice@example.com', password: 'secret' }),
    });
  });

  it('keeps duplicate-email recovery on the registration path when the password is wrong', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(403, { message: 'Invalid email/password combination.' }));

    await expect(loginAccountPassword({
      fetchImpl: fetchMock as unknown as typeof fetch,
      loginUrl: '/.account/login/password/',
      email: 'alice@example.com',
      password: 'wrong',
      duplicateEmailRecovery: true,
    })).rejects.toMatchObject({
      name: 'RegistrationError',
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'This email is already registered, but the password did not match. Sign in or reset the password.',
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
