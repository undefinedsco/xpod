import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapAccountPasswordLogin,
  completeRegistrationProvisioning,
  loginAccountPassword,
  RegistrationProvisioningNotReadyError,
  retryRegistrationReadiness,
} from '../../ui/src/utils/registration-flow';

describe('completeRegistrationProvisioning', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      accountIndexUrl: 'https://id.example/',
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
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://id.example/.account/account/pod');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://id.example/.account/account/pod');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
        'Content-Type': 'application/json',
      },
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://id.example/.account/account/webid');
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
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://id.example/.account/account/webid');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('https://id.example/.account/account/pod');
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
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Pod 名称已被占用。账号已创建，请登录后换一个名称。');
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
      accountIndexUrl: 'https://id.example/',
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
      accountIndexUrl: 'https://id.example/',
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
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://id.example/.account/account/pod');
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

  it('ignores Cloud pod records when checking an existing Local SP account', async () => {
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
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { bindings: [] }))
      .mockResolvedValueOnce(jsonResponse(200, {
        webIdLinks: { 'https://node.example/alice/profile/card#me': '/.account/account/webid/1' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { entries: [] }))
      .mockResolvedValueOnce(jsonResponse(201, { provisionReceipt: 'receipt-1' }))
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/alice/' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [
          {
            webId: 'https://node.example/alice/profile/card#me',
            storageUrl: 'https://node.example/alice/',
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock.mock.calls.some(([url]) => url === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://id.example/.account/account/bindings');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://id.example/.account/account/webid');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://node.example/provision/webids');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('https://node.example/provision/pods');
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ podName: 'alice' }),
    });
    expect(fetchMock.mock.calls[5]?.[0]).toBe('https://id.example/.account/account/pod');
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        name: 'alice',
        settings: { provisionCode, provisionReceipt: 'receipt-1' },
      }),
    });
  });

  it('does not create a Local SP pod when that SP already resolves the linked WebID', async () => {
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
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [{
          webId: 'https://node.example/alice/profile/card#me',
          storageUrl: 'https://node.example/alice/',
        }],
      }))
      .mockResolvedValueOnce(jsonResponse(200, { client: { client_id: 'linx' } }));

    const result = await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    });

    expect(result).toEqual({ createdPod: true, redirectedToConsent: true });
    expect(fetchMock.mock.calls.some(([url]) => url === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === 'https://id.example/.account/account/webid')).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === 'https://node.example/provision/webids')).toBe(false);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST' && call[0] === '/.account/account/pod';
    })).toBe(false);
  });

  it('prepares a Local SP pod before linking it during registration', async () => {
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
            bindings: '/.account/account/bindings',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { bindings: [] }))
      .mockResolvedValueOnce(jsonResponse(200, {
        webIdLinks: { 'https://node.example/alice/profile/card#me': '/.account/account/webid/1' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { entries: [] }))
      .mockResolvedValueOnce(jsonResponse(201, { provisionReceipt: 'receipt-1' }))
      .mockResolvedValueOnce(jsonResponse(201, { podUrl: 'https://node.example/alice/' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        bindings: [{
          webId: 'https://node.example/alice/profile/card#me',
          storageUrl: 'https://node.example/alice/',
        }],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    });

    expect(fetchMock.mock.calls[4]?.[0]).toBe('https://node.example/provision/pods');
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ podName: 'alice' }),
    });
    expect(fetchMock.mock.calls[5]?.[0]).toBe('https://id.example/.account/account/pod');
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        name: 'alice',
        settings: { provisionCode, provisionReceipt: 'receipt-1' },
      }),
    });
  });

  it('fails registration when authenticated account controls do not expose pod creation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { registered: false }))
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {},
        },
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Pod creation endpoint not found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/provision/status');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://id.example/');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token acct-token-1',
      },
    });
  });

  it('does not create a pod when the existing pod query fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(503, { message: 'Account pod query unavailable' }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Account pod query unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
  });

  it('does not create a pod when the existing pod response is malformed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        controls: {
          account: {
            pod: '/.account/account/pod',
            webId: '/.account/account/webid',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { pods: [] }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    })).rejects.toThrow('Account pod response is malformed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST';
    })).toBe(false);
  });

  it('does not create a Local SP pod when the WebID listing control is missing', async () => {
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
          },
        },
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    })).rejects.toThrow('WebID listing endpoint not found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not create a Local SP pod when linked WebID lookup fails', async () => {
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
        webIdLinks: { 'https://id.example/alice/profile/card#me': '/.account/account/webid/1' },
      }))
      .mockResolvedValueOnce(jsonResponse(503, { message: 'Local lookup unavailable' }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
      provisionCode,
    })).rejects.toThrow('Local storage bindings request failed (503)');
    expect(fetchMock.mock.calls.some((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST' && call[0] === 'https://id.example/.account/account/pod';
    })).toBe(false);
  });

  it('does not claim completion from a different username WebID owned by the same account', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(15_001);

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
      .mockResolvedValueOnce(jsonResponse(200, {
        webIdLinks: { 'https://node.example/bob/profile/card#me': '/.account/account/webid/2' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        pods: { 'https://pods.example/bob/': '/.account/account/pod/2' },
      }));

    await expect(completeRegistrationProvisioning({
      fetchImpl: fetchMock as unknown as typeof fetch,
      accountToken: 'acct-token-1',
      accountIndexUrl: 'https://id.example/',
      username: 'alice',
    })).rejects.toBeInstanceOf(RegistrationProvisioningNotReadyError);
    expect(fetchMock.mock.calls.some(([url]) => url === '/.account/oidc/consent/')).toBe(false);
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
