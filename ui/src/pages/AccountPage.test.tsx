// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { xpodFirstPodErrors } from '../auth/xpod-account-copy';
import { AccountPage } from './AccountPage';

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  const authenticated = { status: 'authenticated' } as const;
  return {
    controls: {
      account: {
        webId: '/.account/account/web-id/',
      },
    },
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn: true,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: authenticated,
    ...overrides,
  };
}

describe('AccountPage', () => {
  test('reads durable Account bindings even after an old creation code expires', async () => {
    sessionStorage.setItem('provisionCode', `${btoa(JSON.stringify({ exp: 1 }))}.signature`);
    const origin = window.location.origin;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bindings: [{
      webId: `${origin}/alice/profile/card#me`, storageUrl: `${origin}/alice/`,
    }] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthContext.Provider value={authValue({ controls: { account: {
      bindings: '/.account/account/bindings/',
    } } })}><MemoryRouter><AccountPage /></MemoryRouter></AuthContext.Provider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${origin}/.account/account/bindings/`, expect.anything()));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/provision/'))).toBe(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  test('does not expose arbitrary WebID linking in the Xpod account product', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ webIdLinks: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(
      <AuthContext.Provider value={authValue()}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.queryByRole('button', { name: /link webid/i })).toBeNull();
    expect(screen.queryByLabelText(/webid url/i)).toBeNull();
  });

  test('fails closed without fetching external account controls with Account token headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            webId: 'https://evil.example/.account/account/web-id/',
            pod: 'https://evil.example/.account/account/pod/',
            clientCredentials: 'https://evil.example/.account/client-credentials/',
          },
          password: {
            forgot: `${window.location.protocol}//user@${window.location.host}/.account/login/password/forgot/`,
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Same-origin provisioning discovery is allowed, but external Account
    // controls must never be fetched and no request may carry the Account
    // token header.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('evil.example');
      const headers = (call[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization ?? headers.Authorization).toBeUndefined();
    }
    expect(screen.queryByRole('button', { name: /add pod/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /new credential/i })).toBeNull();
    expect(screen.getByRole('link', { name: /change password/i }).getAttribute('href'))
      .toBe('/idp/credentials/password/');
  });

  test('fetches current-origin account controls through resolved absolute URLs', async () => {
    const origin = window.location.origin;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/web-id/')) {
        return new Response(JSON.stringify({ webIdLinks: { [`${origin}/alice/profile/card#me`]: `${origin}/.account/web-id/alice/` } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/pod/')) {
        return new Response(JSON.stringify({ pods: { [`${origin}/alice/`]: `${origin}/.account/pod/alice/` } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            webId: '/.account/account/web-id/',
            pod: '/.account/account/pod/',
            clientCredentials: '/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `${origin}/.account/account/web-id/`,
      `${origin}/.account/account/pod/`,
      `${origin}/.account/client-credentials/`,
    ]);
  });

  test('fetches controls advertised by the authenticated Cloud Account index', async () => {
    const cloudAccountIndex = 'https://id.example/.account/';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/web-id/')) {
        return new Response(JSON.stringify({
          webIdLinks: { 'https://id.example/alice/profile/card#me': 'https://id.example/.account/web-id/alice/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/')) {
        return new Response(JSON.stringify({ pods: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        idpIndex: cloudAccountIndex,
        controls: {
          account: {
            webId: `${cloudAccountIndex}account/account-1/web-id/`,
            pod: `${cloudAccountIndex}account/account-1/pod/`,
            clientCredentials: `${cloudAccountIndex}account/account-1/client-credentials/`,
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByRole('link', {
      name: 'https://id.example/alice/profile/card#me',
    })).toBeTruthy());
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `${cloudAccountIndex}account/account-1/web-id/`,
      `${cloudAccountIndex}account/account-1/pod/`,
      `${cloudAccountIndex}account/account-1/client-credentials/`,
    ]);
  });

  test('uses the Account storage binding as the local Xpod identity and Pod fallback', async () => {
    const webId = 'https://id.undefineds.co/alice/profile/card#me';
    const storageUrl = 'https://node.example/alice/';
    const payload = btoa(JSON.stringify({
      spUrl: 'https://node.example/',
      serviceAccessToken: 'local-service-token',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    })).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
    const provisionCode = `${payload}.signature`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/provision/status')) {
        return new Response(JSON.stringify({ registered: true, provisionCode }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/provision/webids')) {
        return new Response(JSON.stringify({ entries: [{ webId, storageUrl }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/bindings')) {
        return new Response(JSON.stringify({
          bindings: [{ webId, storageUrl }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/web-id/') || url.endsWith('/pod/')) {
        return new Response(JSON.stringify({ message: 'not available through this origin' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            bindings: '/.account/account/bindings',
            webId: '/.account/account/web-id/',
            pod: '/.account/account/pod/',
            clientCredentials: '/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole('link', { name: webId })).toBeTruthy();
    expect(screen.getByRole('link', { name: storageUrl })).toBeTruthy();
    expect(screen.queryByText('No Pods found. Create one to get started.')).toBeNull();
    expect(screen.queryByRole('button', { name: /delete pod/i })).toBeNull();
  });

  test('shows Cloud WebID and an empty local storage prompt instead of a fake sync banner', async () => {
    const payload = btoa(JSON.stringify({
      spUrl: 'https://node-0000.undefineds.co/',
      serviceToken: 'svc-local',
      spDomain: 'node-0000.undefineds.co',
    }));
    sessionStorage.setItem('provisionCode', `${payload}.sig`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/web-id/')) {
        return new Response(JSON.stringify({
          webIdLinks: { 'https://id.undefineds.co/gcloud/profile/card#me': 'https://id.undefineds.co/.account/web-id/gcloud/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/')) {
        return new Response(JSON.stringify({
          pods: { 'https://id.undefineds.co/gcloud/': 'https://id.undefineds.co/.account/pod/gcloud/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/provision/webids')) {
        return new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            webId: '/.account/account/web-id/',
            pod: '/.account/account/pod/',
            clientCredentials: '/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'https://id.undefineds.co/gcloud/profile/card#me' })).toBeTruthy();
    });
    expect(screen.getByText('This device has no Pod yet. Create one to store data here.')).toBeTruthy();
    expect(screen.queryByText(/正在同步/)).toBeNull();
    sessionStorage.removeItem('provisionCode');
  });

  test('keeps the Cloud WebID visible when the provisioned Local Pod route is temporarily unreachable', async () => {
    const webId = 'https://id.undefineds.co/alice/profile/card#me';
    const payload = btoa(JSON.stringify({
      spUrl: 'https://node-unreachable.undefineds.co/',
      serviceToken: 'svc-local',
      spDomain: 'node-unreachable.undefineds.co',
    }));
    sessionStorage.setItem('provisionCode', `${payload}.sig`);
    const alertMock = vi.fn();
    vi.stubGlobal('alert', alertMock);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/web-id/')) {
        return new Response(JSON.stringify({
          webIdLinks: { [webId]: 'https://id.undefineds.co/.account/web-id/alice/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/')) {
        return new Response(JSON.stringify({ pods: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/provision/webids')) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            webId: '/.account/account/web-id/',
            pod: '/.account/account/pod/',
            clientCredentials: '/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole('link', { name: webId })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.cloudRouteUnavailable);
    expect(screen.getByText('This device has no Pod yet. Create one to store data here.')).toBeTruthy();
    expect(alertMock).not.toHaveBeenCalled();
  });

  test('keeps client credential request failures scoped to the credential action', async () => {
    const webId = 'https://id.undefineds.co/alice/profile/card#me';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/client-credentials/')) {
        throw new TypeError('fetch failed');
      }
      if (url.endsWith('/web-id/')) {
        return new Response(JSON.stringify({
          webIdLinks: { [webId]: 'https://id.undefineds.co/.account/web-id/alice/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/')) {
        return new Response(JSON.stringify({ pods: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            webId: '/.account/account/web-id/',
            pod: '/.account/account/pod/',
            clientCredentials: '/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await screen.findByRole('link', { name: webId });
    fireEvent.click(screen.getByRole('button', { name: /new credential/i }));
    fireEvent.change(screen.getByPlaceholderText('my-solid-client'), { target: { value: 'Workbench' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('无法创建客户端凭据，请重试。');
    expect(screen.getByRole('alert').textContent).not.toContain(xpodFirstPodErrors.cloudRouteUnavailable);
  });

  test('renders a Pod-scoped inline error instead of a native alert when Pod creation fails', async () => {
    const alertMock = vi.fn();
    vi.stubGlobal('alert', alertMock);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        throw new TypeError('fetch failed');
      }
      const url = String(input);
      if (url.endsWith('/web-id/')) {
        return new Response(JSON.stringify({ webIdLinks: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/pod/')) {
        return new Response(JSON.stringify({ pods: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            webId: '/.account/account/web-id/',
            pod: '/.account/account/pod/',
            clientCredentials: '/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: /add pod/i }));
    fireEvent.change(screen.getByPlaceholderText('my-pod'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('无法创建存储空间，请重试。');
    expect(screen.getByRole('alert').textContent).not.toContain(xpodFirstPodErrors.cloudRouteUnavailable);
    expect(alertMock).not.toHaveBeenCalled();
  });

  test('prepares a Local provisioned Pod before linking it through CSS Account controls', async () => {
    const provisionCode = `${btoa(JSON.stringify({
      spUrl: 'http://localhost:5737/',
      spDomain: 'node.example',
      serviceToken: 'local-service-token',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')}.signature`;
    const webId = 'https://id.example/alice/profile/card#me';
    const postSequence: string[] = [];
    sessionStorage.setItem('provisionCode', provisionCode);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/.account/account/web-id/') {
        return new Response(JSON.stringify({
          webIdLinks: { [webId]: '/.account/account/web-id/alice/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/.account/account/pod/' && init?.method === 'POST') {
        postSequence.push('css-link');
        expect(JSON.parse(String(init.body))).toEqual({
          name: 'alice',
          settings: {
            provisionCode,
            provisionReceipt: 'receipt-123',
          },
        });
        return new Response(JSON.stringify({}), { status: 201 });
      }
      if (url.pathname === '/.account/account/pod/') {
        return new Response(JSON.stringify({ pods: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/.account/client-credentials/') {
        return new Response(JSON.stringify({ clientCredentials: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/provision/webids') {
        return new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/provision/pods' && init?.method === 'POST') {
        postSequence.push('local-prepare');
        expect(JSON.parse(String(init.body))).toEqual({ podName: 'alice' });
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer local-service-token');
        return new Response(JSON.stringify({ provisionReceipt: 'receipt-123' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        idpIndex: 'https://id.example/.account/',
        controls: {
          account: {
            webId: 'https://id.example/.account/account/web-id/',
            pod: 'https://id.example/.account/account/pod/',
            clientCredentials: 'https://id.example/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await screen.findByRole('link', { name: webId });
    fireEvent.click(screen.getByRole('button', { name: /add pod/i }));
    fireEvent.change(screen.getByPlaceholderText('my-pod'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(postSequence).toEqual(['local-prepare', 'css-link']));
  });

  test('does not call Local provisioning before CSS Pod creation when no provision scope exists', async () => {
    const webId = 'https://id.example/alice/profile/card#me';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/.account/account/web-id/') {
        return new Response(JSON.stringify({
          webIdLinks: { [webId]: '/.account/account/web-id/alice/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/.account/account/pod/' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'alice' });
        return new Response(JSON.stringify({}), { status: 201 });
      }
      if (url.pathname === '/.account/account/pod/') {
        return new Response(JSON.stringify({ pods: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/.account/client-credentials/') {
        return new Response(JSON.stringify({ clientCredentials: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/provision/pods') {
        throw new Error('Cloud Account creation must not call Local provisioning without a provision scope');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        idpIndex: 'https://id.example/.account/',
        controls: {
          account: {
            webId: 'https://id.example/.account/account/web-id/',
            pod: 'https://id.example/.account/account/pod/',
            clientCredentials: 'https://id.example/.account/client-credentials/',
          },
        },
      })}>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await screen.findByRole('link', { name: webId });
    fireEvent.click(screen.getByRole('button', { name: /add pod/i }));
    fireEvent.change(screen.getByPlaceholderText('my-pod'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) =>
      new URL(String(input), window.location.origin).pathname === '/provision/pods',
    )).toBe(false);
  });

  test('uses theme tokens instead of light-only product colors', () => {
    const source = readFileSync(join(process.cwd(), 'ui/src/pages/AccountPage.tsx'), 'utf8');

    expect(source).toContain('bg-background');
    expect(source).toContain('bg-card');
    expect(source).toContain('text-foreground');
    expect(source).toContain('text-muted-foreground');
    expect(source).toContain('bg-primary');
    expect(source).not.toMatch(/bg-white|bg-zinc|text-zinc|border-zinc|divide-zinc|#7C4DFF|#6B3FE8/);
  });

  test('does not present Solid client credentials as Xpod API Keys', () => {
    const source = readFileSync(join(process.cwd(), 'ui/src/pages/AccountPage.tsx'), 'utf8');

    expect(source).not.toContain('generateApiKey');
    expect(source).not.toContain('New API Key Created');
    expect(source).not.toContain('/chat/completions · /responses · /models');
    expect(source).not.toContain('Authorization: Bearer sk-xxx');
  });
});
