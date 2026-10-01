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
import { webIdShortName } from '@undefineds.co/shared-ui';
import { peekConsentContinuation, saveConsentContinuation } from '../utils/safe-continuation';

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
    } } })}><MemoryRouter><AccountPage locale="en" /></MemoryRouter></AuthContext.Provider>);
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
          <AccountPage locale="en" />
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
          <AccountPage locale="en" />
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
      .toBe('/.account/login/password/forgot/');
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
          <AccountPage locale="en" />
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
          <AccountPage locale="en" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => {
      const link = screen.getByRole('link', { name: webIdShortName('https://id.example/alice/profile/card#me') });
      expect(link.getAttribute('href')).toBe('https://id.example/alice/profile/card#me');
      expect(screen.getByText('https://id.example/alice/profile/card#me')).toBeTruthy();
    });
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
          <AccountPage locale="en" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    const webIdLink = await screen.findByRole('link', { name: webIdShortName(webId) });
    expect(webIdLink.getAttribute('href')).toBe(webId);
    expect(screen.getByText(webId)).toBeTruthy();
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
          <AccountPage locale="en" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: webIdShortName('https://id.undefineds.co/gcloud/profile/card#me') })).toBeTruthy();
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
          <AccountPage locale="en" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole('link', { name: webIdShortName(webId) })).toBeTruthy();
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
          <AccountPage locale="en" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await screen.findByRole('link', { name: webIdShortName(webId) });
    fireEvent.click(screen.getByRole('button', { name: /new credential/i }));
    fireEvent.change(screen.getByPlaceholderText('my-solid-client'), { target: { value: 'Workbench' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('无法创建客户端凭据，请重试。');
    expect(screen.getByRole('alert').textContent).not.toContain(xpodFirstPodErrors.cloudRouteUnavailable);
  });

  // 设计第二部分 §4.1 / U04：创建只在统一的 Pod 管理页发生。
  // AccountPage 不再内嵌独立 prepare+POST 事务，入口只做导航。
  test('does not create or prepare a Pod from AccountPage; the entry only leads to Pod management', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/web-id/')) {
        return new Response(JSON.stringify({ webIdLinks: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/')) {
        return new Response(JSON.stringify({ pods: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
          <AccountPage locale="en" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const entry = await screen.findByRole('button', { name: /manage pods/i });
    fireEvent.click(entry);

    // 不发起任何写请求，也不触发 provisioning。
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/provision/'))).toBe(false);
    // 旧的 Pod 名称输入框不再存在。
    expect(screen.queryByPlaceholderText('my-pod')).toBeNull();
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

  test('默认 zh-CN；日常管理入口只存 Account 续接并进入重管理页', async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const browserWindow = window;
    // The URL even looks like a consent route, but the provider reports no
    // pending authorization: daily management must not fabricate a task.
    const navigation = { href: browserWindow.location.href, origin: browserWindow.location.origin, pathname: '/.account/interaction/flow-nine/oidc/consent/' };
    const facade = Object.create(browserWindow);
    Object.defineProperty(facade, 'location', { value: navigation });
    vi.stubGlobal('window', facade);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));

    render(
      <AuthContext.Provider value={authValue({ controls: { account: {
        pod: '/.account/account/alice/pod/',
        logout: '/.account/account/alice/logout/',
      } } })}>
        <MemoryRouter><AccountPage /></MemoryRouter>
      </AuthContext.Provider>,
    );

    // 没有显式 locale 时默认中文。
    expect(await screen.findByText('账号总览')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '管理 Pod' }));
    expect(navigation.href).toBe('/settings/pod');
    const record = JSON.parse(window.sessionStorage.getItem('xpod.safe-continuation.management.v2') ?? 'null');
    expect(record?.accountId).toBe('alice');
    expect(record?.returnTo).toBe('/.account/interaction/flow-nine/account/');
    expect(record?.kind).toBe('management');
    expect(window.sessionStorage.getItem('xpod.safe-continuation.consent.v2')).toBeNull();
  });

  test('从授权上下文进入管理时写入 consent 续接，保留原 interaction 与回程', async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const browserWindow = window;
    const interactionPath = '/.account/interaction/flow-nine/oidc/consent/';
    const navigation = { href: `${browserWindow.location.origin}${interactionPath}`, origin: browserWindow.location.origin, pathname: interactionPath };
    const facade = Object.create(browserWindow);
    Object.defineProperty(facade, 'location', { value: navigation });
    vi.stubGlobal('window', facade);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));

    render(
      <AuthContext.Provider value={authValue({ hasOidcPending: true, controls: { account: {
        pod: '/.account/account/alice/pod/',
        logout: '/.account/account/alice/logout/',
      } } })}>
        <MemoryRouter><AccountPage /></MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '管理 Pod' }));
    const record = JSON.parse(window.sessionStorage.getItem('xpod.safe-continuation.consent.v2') ?? 'null');
    expect(record?.accountId).toBe('alice');
    expect(record?.interaction).toBe('/.account/interaction/flow-nine');
    expect(record?.returnTo).toBe('/.account/interaction/flow-nine/oidc/consent/');
  });
  /**
   * A Pod has two authority sources: the bindings listing (WebID ↔ storage URL)
   * and the Pod inventory (storage URL → its management address). The inventory
   * is the only source of the advertised delete address, so the two must be
   * merged onto one row; dropping the duplicate silently removed management.
   */
  test('merges the Pod inventory management address onto the binding row and deletes it by that address', async () => {
    const origin = window.location.origin;
    const webId = `${origin}/alice/profile/card#me`;
    const storageUrl = `${origin}/alice/`;
    const podResource = `${origin}/.account/account/alice/pod/alice/`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/bindings/')) {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ pods: { [storageUrl]: podResource } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === podResource && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <AuthContext.Provider value={authValue({ controls: { account: {
        bindings: '/.account/account/alice/bindings/',
        pod: '/.account/account/alice/pod/',
      } } })}>
        <MemoryRouter><AccountPage locale="zh-CN" /></MemoryRouter>
      </AuthContext.Provider>,
    );

    const webIdLink = await screen.findByRole('link', { name: webIdShortName(webId) });
    expect(webIdLink.getAttribute('href')).toBe(webId);
    // The advertised management address, not the storage URL, drives the removal.
    const deleteButton = await screen.findByRole('button', { name: new RegExp(`删除 Pod ${webIdShortName(webId)}`) });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === podResource && init?.method === 'DELETE')).toBe(true));
    // The storage URL itself must never be used as the management address.
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === storageUrl && init?.method === 'DELETE')).toBe(false);
    confirmSpy.mockRestore();
  });

  test('keeps the Pod when the user cancels the confirmation', async () => {
    const origin = window.location.origin;
    const webId = `${origin}/alice/profile/card#me`;
    const storageUrl = `${origin}/alice/`;
    const podResource = `${origin}/.account/account/alice/pod/alice/`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/bindings/')) {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ pods: { [storageUrl]: podResource } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <AuthContext.Provider value={authValue({ controls: { account: {
        bindings: '/.account/account/alice/bindings/',
        pod: '/.account/account/alice/pod/',
      } } })}>
        <MemoryRouter><AccountPage locale="zh-CN" /></MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`删除 Pod ${webIdShortName(webId)}`) }));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    confirmSpy.mockRestore();
  });

  test('a Pod without an advertised management address offers no removal action', async () => {
    const origin = window.location.origin;
    const webId = `${origin}/alice/profile/card#me`;
    const storageUrl = `${origin}/alice/`;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/bindings/')) {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    render(
      <AuthContext.Provider value={authValue({ controls: { account: {
        bindings: '/.account/account/alice/bindings/',
        pod: '/.account/account/alice/pod/',
      } } })}>
        <MemoryRouter><AccountPage locale="zh-CN" /></MemoryRouter>
      </AuthContext.Provider>,
    );

    await screen.findByRole('link', { name: webIdShortName(webId) });
    expect(screen.queryByRole('button', { name: /删除 Pod/ })).toBeNull();
  });

  test('keeps a real Pod visible when it cannot be linked to any WebID', async () => {
    const origin = window.location.origin;
    const webId = `${origin}/alice/profile/card#me`;
    const storageUrl = `${origin}/alice/`;
    const orphanStorage = `${origin}/backup/`;
    const orphanResource = `${origin}/.account/account/alice/pod/backup/`;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/bindings/')) {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ pods: { [storageUrl]: `${origin}/.account/account/alice/pod/alice/`, [orphanStorage]: orphanResource } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    render(
      <AuthContext.Provider value={authValue({ controls: { account: {
        bindings: '/.account/account/alice/bindings/',
        pod: '/.account/account/alice/pod/',
      } } })}>
        <MemoryRouter><AccountPage locale="zh-CN" /></MemoryRouter>
      </AuthContext.Provider>,
    );

    // The unlinked Pod is shown as its own storage row, not silently dropped and
    // not dressed up as a WebID identity.
    const orphanLink = await screen.findByRole('link', { name: /backup/ });
    expect(orphanLink.getAttribute('href')).toBe(orphanStorage);
    expect(screen.getByRole('button', { name: /删除 Pod backup/ })).toBeTruthy();
  });

  test('daily management drops a leftover consent task so the heavy page cannot resume it', async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const browserWindow = window;
    const navigation = { href: browserWindow.location.href, origin: browserWindow.location.origin, pathname: '/.account/account/' };
    const facade = Object.create(browserWindow);
    Object.defineProperty(facade, 'location', { value: navigation });
    vi.stubGlobal('window', facade);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));

    // A still-valid consent task queued earlier for this same Account.
    saveConsentContinuation({
      accountId: 'alice',
      interaction: '/.account/interaction/flow-nine',
      returnTo: '/.account/interaction/flow-nine/oidc/consent/',
    });
    expect(peekConsentContinuation({ accountId: 'alice' })).not.toBeNull();

    render(
      <AuthContext.Provider value={authValue({ hasOidcPending: false, controls: { account: {
        pod: '/.account/account/alice/pod/',
        logout: '/.account/account/alice/logout/',
      } } })}>
        <MemoryRouter><AccountPage locale="zh-CN" /></MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '管理 Pod' }));
    // The explicit daily intent is the only source of navigation.
    expect(peekConsentContinuation({ accountId: 'alice' })).toBeNull();
    const record = JSON.parse(window.sessionStorage.getItem('xpod.safe-continuation.management.v2') ?? 'null');
    expect(record?.kind).toBe('management');
    expect(record?.accountId).toBe('alice');
  });

  /**
   * The local provision scope filters *which* storage may show; it must not drop
   * the management address the account inventory already advertised for the very
   * same storage URL. Otherwise the local branch loses the only delete address.
   */
  test('local provision scope keeps the advertised Pod management address', async () => {
    window.sessionStorage.clear();
    const origin = window.location.origin;
    const webId = `${origin}/alice/profile/card#me`;
    const storageUrl = `${origin}/alice/`;
    const podResource = `${origin}/.account/account/alice/pod/alice/`;
    const outsideStorage = 'https://other.example/backup/';
    const outsideResource = `${origin}/.account/account/alice/pod/backup/`;
    const provisionCode = `${btoa(JSON.stringify({ spUrl: `${origin}/`, serviceToken: 'local-service-token', exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
    window.sessionStorage.setItem('provisionCode', provisionCode);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/provision/webids')) {
        return new Response(JSON.stringify({ entries: [{ webId, storageUrl, storageMode: 'local' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/bindings/')) {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ pods: { [storageUrl]: podResource, [outsideStorage]: outsideResource } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === podResource && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <AuthContext.Provider value={authValue({ controls: { account: {
        bindings: '/.account/account/alice/bindings/',
        pod: '/.account/account/alice/pod/',
        webId: '/.account/account/alice/web-id/',
      } } })}>
        <MemoryRouter><AccountPage locale="zh-CN" /></MemoryRouter>
      </AuthContext.Provider>,
    );

    await screen.findByRole('link', { name: webIdShortName(webId) });
    // The scoped branch must still show the inventory's advertised action.
    const deleteButton = await screen.findByRole('button', { name: new RegExp(`删除 Pod ${webIdShortName(webId)}`) });
    // Storage outside the local scope is filtered out, even though the inventory listed it.
    expect(screen.queryByRole('link', { name: /other\.example/ })).toBeNull();

    // Cancelling the confirmation must not delete anything.
    fireEvent.click(deleteButton);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === podResource && init?.method === 'DELETE')).toBe(true));
    // Never the storage URL, never the out-of-scope inventory address.
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === storageUrl && init?.method === 'DELETE')).toBe(false);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === outsideResource && init?.method === 'DELETE')).toBe(false);
    confirmSpy.mockRestore();
  });

  test('local provision scope shows a Pod with no advertised address but offers no removal', async () => {
    window.sessionStorage.clear();
    const origin = window.location.origin;
    const webId = `${origin}/alice/profile/card#me`;
    const storageUrl = `${origin}/alice/`;
    const provisionCode = `${btoa(JSON.stringify({ spUrl: `${origin}/`, serviceToken: 'local-service-token', exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
    window.sessionStorage.setItem('provisionCode', provisionCode);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/provision/webids')) {
        return new Response(JSON.stringify({ entries: [{ webId, storageUrl, storageMode: 'local' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/bindings/')) {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pod/') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ pods: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ clientCredentials: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({ controls: { account: {
        bindings: '/.account/account/alice/bindings/',
        pod: '/.account/account/alice/pod/',
        webId: '/.account/account/alice/web-id/',
      } } })}>
        <MemoryRouter><AccountPage locale="zh-CN" /></MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole('link', { name: new RegExp(storageUrl) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /删除 Pod/ })).toBeNull();
  });
});
