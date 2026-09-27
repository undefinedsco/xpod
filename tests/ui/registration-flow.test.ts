import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapAccountPasswordLogin,
  loginAccountPassword,
  RegistrationProvisioningNotReadyError,
  retryRegistrationReadiness,
} from '../../ui/src/utils/registration-flow';

describe('registration never creates a Pod', () => {
  it('exposes no provisioning entry and no Pod-create call', async () => {
    // spec §5.2 第 2 步：注册完成只创建 Account，不调用 Local prepare、不自动创建 Pod。
    // 创建必须走存储空间页的显式入口（PodManagementPanel）。
    const module = await import('../../ui/src/utils/registration-flow');
    expect(Object.keys(module)).not.toContain('completeRegistrationProvisioning');

    const source = readFileSync('ui/src/utils/registration-flow.ts', 'utf8');
    expect(source).not.toContain('prepareProvisionedPod');
    expect(source).not.toContain('createPodUrl');
    expect(source).not.toContain('hasExistingPod');
  });
});

describe('bootstrapAccountPasswordLogin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    });

    expect(result).toEqual({ accountToken: 'acct-token-1', loginUrl: 'http://localhost/.account/login/password/' });
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
    })).rejects.toMatchObject({
      name: 'RegistrationError',
      code: 'EMAIL_ALREADY_REGISTERED',
      message: '该邮箱已注册，请登录或重置密码。',
    });
  });
});

describe('retryRegistrationReadiness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('surfaces NotReady and never posts when only a different username WebID is visible', async () => {
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
        webIdLinks: { 'https://node.example/bob/profile/card#me': '/.account/account/webid/2' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        pods: { 'https://pods.example/bob/': '/.account/account/pod/2' },
      }));

    await expect(retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    })).rejects.toBeInstanceOf(RegistrationProvisioningNotReadyError);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === '/.account/oidc/consent/')).toBe(false);
  });

  it('returns consent state and never posts when the requested binding becomes ready', async () => {
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
        webIdLinks: { 'https://id.example/alice/profile/card#me': '/.account/account/webid/1' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example/',
      'https://id.example/.account/account/webid',
      '/.account/oidc/consent/',
    ]);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
  });

  it('accepts an account-owned node-root WebID for the requested username', async () => {
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
        webIdLinks: { 'https://node.example/alice/profile/card#me': '/.account/account/webid/1' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example/',
      'https://id.example/.account/account/webid',
      '/.account/oidc/consent/',
    ]);
  });

  it('checks Local SP readiness through the requested WebID and scoped binding without creating', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'service-token',
      spDomain: 'node.example',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
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
        webIdLinks: {
          'https://id.example/alice/profile/card#me': '/.account/account/webid/1',
          'https://id.example/bob/profile/card#me': '/.account/account/webid/2',
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        entries: [
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://node.example/alice/',
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: false });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://node.example/provision/webids');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ webIds: ['https://id.example/alice/profile/card#me'] }),
    });
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST' && call[0] === 'https://id.example/.account/account/pod';
    })).toBe(false);
  });

  it('succeeds from durable exact binding even when the transient provision code is expired', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'service-token',
      spDomain: 'node.example',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://node.example/alice/',
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example/',
      'https://id.example/.account/account/bindings',
      '/.account/oidc/consent/',
    ]);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
  });

  it('does not treat a different storage root as ready for an expired provision target', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'expired-service-token',
      spDomain: 'node-a.example',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://node-b.example/alice/',
          },
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://id.example/alice/',
          },
        ],
      }));

    await expect(retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    })).rejects.toBeInstanceOf(RegistrationProvisioningNotReadyError);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example/',
      'https://id.example/.account/account/bindings',
    ]);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
  });

  it('uses stored expired operation target when retry options omit the provision code', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'expired-service-token',
      spDomain: 'node-a.example',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    installSessionStorage({ provisionCode });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://node-b.example/alice/',
          },
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://id.example/alice/',
          },
        ],
      }));

    await expect(retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    })).rejects.toBeInstanceOf(RegistrationProvisioningNotReadyError);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example/',
      'https://id.example/.account/account/bindings',
    ]);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
  });

  it('treats the expired provision target storage root as ready when durable binding matches it', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'expired-service-token',
      spDomain: 'node-a.example',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://node-a.example/alice/',
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example/',
      'https://id.example/.account/account/bindings',
      '/.account/oidc/consent/',
    ]);
  });

  it('uses stored expired operation target as ready when retry options omit the provision code', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'expired-service-token',
      spDomain: 'node-a.example',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    installSessionStorage({ provisionCode });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [
          {
            webId: 'https://id.example/alice/profile/card#me',
            storageUrl: 'https://node-a.example/alice/',
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await retryRegistrationReadiness({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example/',
      'https://id.example/.account/account/bindings',
      '/.account/oidc/consent/',
    ]);
  });
});

describe('loginAccountPassword', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      message: '该邮箱已注册，但密码不正确，请登录或重置密码。',
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

function makeProvisionCode(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
}

function installSessionStorage(initial: Record<string, string>): void {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
}
