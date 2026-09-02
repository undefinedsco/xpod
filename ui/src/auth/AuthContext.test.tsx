import { describe, expect, test, vi } from 'vitest';
import { act, StrictMode, useLayoutEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { fireEvent } from '@testing-library/react';
import { AuthProvider } from '../context/AuthContext';
import { useAuth } from '../context/AuthContextValue';
import { resolveXpodAccountIndex } from '../context/resolve-xpod-account-index';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom(fetchImpl?: typeof fetch, url = 'https://app.example/.account/') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.fetch = fetchImpl ?? (vi.fn() as unknown as typeof fetch);
  return dom;
}

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.accountState.status}</span>
      <span data-testid="logged-in">{String(auth.isLoggedIn)}</span>
      <span data-testid="anonymous">{String(auth.isAnonymous?.())}</span>
      <span data-testid="error">{auth.accountState.status === 'error' ? auth.accountState.message : ''}</span>
      <span data-testid="identity-webid">{auth.identity?.webId ?? ''}</span>
      <button type="button" onClick={() => void auth.retry()}>retry</button>
      <button type="button" onClick={() => void auth.logout()}>logout</button>
    </div>
  );
}

function ImmediateLogoutProbe() {
  const auth = useAuth();
  const status = auth.accountState.status;
  const logout = auth.logout;
  useLayoutEffect(() => {
    if (status === 'authenticated') void logout();
  }, [logout, status]);
  return (
    <div>
      <span data-testid="status">{auth.accountState.status}</span>
      <span data-testid="anonymous">{String(auth.isAnonymous?.())}</span>
    </div>
  );
}

async function render(fetchImpl?: typeof fetch, probe: ReactElement = <Probe />, url?: string) {
  installDom(fetchImpl, url);
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(<AuthProvider>{probe}</AuthProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

describe('Xpod Account controller', () => {
  test('uses the Cloud Account service for a managed loopback Xpod', async () => {
    installDom(undefined, 'http://127.0.0.1:3000/dashboard/overview');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      managed: true,
      oidcIssuer: 'https://id.undefineds.co/',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(resolveXpodAccountIndex(fetchImpl as unknown as typeof fetch))
      .resolves.toBe('https://id.undefineds.co/.account/');
  });

  test('finishes Account initialization when effects are replayed by Strict Mode', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ controls: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    installDom(fetchImpl as unknown as typeof fetch, 'https://app.example/app/');
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);

    await act(async () => {
      root.render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('anonymous');
    await unmount(root);
  });

  test.each([401, 403])('clears local Account token on %s and remains anonymous', async (status) => {
    installDom();
    window.localStorage.setItem('xpod.cssAccountToken', 'secret-token');
    window.sessionStorage.setItem('xpod.cssAccountToken', 'secret-token');
    document.cookie = 'css-account=secret-token; Path=/';
    const fetchImpl = vi.fn(async () => new Response('', { status }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthProvider><Probe /></AuthProvider>);
    });
    // Let the unauthenticated confirmation round run in real time, then flush.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await act(async () => {});

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('anonymous');
    expect(container.querySelector('[data-testid="logged-in"]')?.textContent).toBe('false');
    expect(window.localStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(document.cookie).not.toContain('secret-token');
    await unmount(root);
  });

  test('keeps the Account token when a transient 401 recovers on the confirmation probe', async () => {
    installDom();
    window.localStorage.setItem('xpod.cssAccountToken', 'secret-token');
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 401 });
      return new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthProvider><Probe /></AuthProvider>);
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await act(async () => {});

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('authenticated');
    expect(window.localStorage.getItem('xpod.cssAccountToken')).toBe('secret-token');
    await unmount(root);
  });

  test('restores Account controls from the remembered CSS cookie without copying the token to localStorage', async () => {
    installDom(undefined, 'https://app.example/status/overview');
    document.cookie = 'css-account=persisted-token; Path=/';
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('CSS-Account-Token persisted-token');
      return new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('authenticated');
    expect(container.querySelector('[data-testid="logged-in"]')?.textContent).toBe('true');
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(window.localStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(document.cookie).toContain('persisted-token');
    await unmount(root);
  });

  test('does not expose the CSS WebID-management control as the Account identity WebID', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      controls: {
        account: {
          logout: '/.account/logout/',
          webId: '/.account/account/alice/webid/',
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { container, root } = await render(
      fetchImpl as unknown as typeof fetch,
      <Probe />,
      'https://app.example/status/overview',
    );

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('authenticated');
    expect(container.querySelector('[data-testid="identity-webid"]')?.textContent).toBe('');
    await unmount(root);
  });

  test('automatically retries transient Account controls failures without showing a terminal login error', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const { container, root } = await render(fetchImpl as unknown as typeof fetch, <Probe />, 'https://app.example/status/overview');

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('initializing');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('authenticated');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await unmount(root);
  });

  test('cancels a pending transient Account retry after unmount', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 502 }));
    const { root } = await render(fetchImpl as unknown as typeof fetch, <Probe />, 'https://app.example/status/overview');

    await unmount(root);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not block Account controls on a pending OIDC consent probe', async () => {
    let resolveConsent: ((response: Response) => void) | undefined;
    const consentResponse = new Promise<Response>((resolve) => {
      resolveConsent = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), window.location.origin).pathname;
      if (pathname === '/.account/') {
        return new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === '/.account/oidc/consent/') return consentResponse;
      throw new Error(`unexpected request ${pathname}`);
    });

    const { container, root } = await render(fetchImpl as unknown as typeof fetch);

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('authenticated');
    expect(container.querySelector('[data-testid="logged-in"]')?.textContent).toBe('true');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    resolveConsent?.(new Response(JSON.stringify({ client: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await act(async () => {
      await consentResponse;
    });
    await unmount(root);
  });

  test('does not probe OIDC consent for authenticated controls on the Status surface', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), window.location.origin).pathname;
      if (pathname === '/.account/') {
        return new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected request ${pathname}`);
    });

    const { container, root } = await render(fetchImpl as unknown as typeof fetch, <Probe />, 'https://app.example/status/overview');

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('authenticated');
    expect(container.querySelector('[data-testid="logged-in"]')?.textContent).toBe('true');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/.account/oidc/consent/'))).toBe(false);
    await unmount(root);
  });

  test('keeps Account credentials available when logout cannot reach CSS', async () => {
    installDom();
    window.sessionStorage.setItem('xpod.cssAccountToken', 'secret-token');
    document.cookie = 'css-account=secret-token; Path=/';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      const logoutButton = container.querySelector('button:last-of-type');
      if (!logoutButton) throw new Error('missing logout button');
      fireEvent.click(logoutButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="anonymous"]')?.textContent).toBe('false');
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBe('secret-token');
    expect(document.cookie).toContain('secret-token');
    await unmount(root);
  });

  test('rejects a cross-origin logout control without sending the Account token or clearing the local session', async () => {
    installDom(undefined, 'https://app.example/status/overview');
    window.sessionStorage.setItem('xpod.cssAccountToken', 'secret-token');
    document.cookie = 'css-account=secret-token; Path=/';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        controls: { account: { logout: 'https://evil.example/.account/logout/' } },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      const logoutButton = container.querySelector('button:last-of-type');
      if (!logoutButton) throw new Error('missing logout button');
      fireEvent.click(logoutButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://app.example/provision/status', expect.objectContaining({
      credentials: 'include',
    }));
    expect(fetchImpl).not.toHaveBeenCalledWith(
      'https://evil.example/.account/logout/',
      expect.anything(),
    );
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="anonymous"]')?.textContent).toBe('false');
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBe('secret-token');
    expect(document.cookie).toContain('secret-token');
    await unmount(root);
  });

  test('keeps a just-authenticated Account non-anonymous when an immediate logout fails', async () => {
    installDom();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), window.location.origin).pathname;
      if (pathname === '/.account/') {
        return new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === '/.account/oidc/consent/') return new Response('', { status: 404 });
      if (pathname === '/.account/logout/') return new Response('', { status: 503 });
      throw new Error(`unexpected request ${pathname}`);
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const { container, root } = await render(fetchImpl as unknown as typeof fetch, <ImmediateLogoutProbe />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="anonymous"]')?.textContent).toBe('false');
    await unmount(root);
  });

  test('reports anonymous synchronously after a successful real AuthProvider logout', async () => {
    installDom();
    window.sessionStorage.setItem('xpod.cssAccountToken', 'secret-token');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      const logoutButton = container.querySelector('button:last-of-type');
      if (!logoutButton) throw new Error('missing logout button');
      fireEvent.click(logoutButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('anonymous');
    expect(container.querySelector('[data-testid="anonymous"]')?.textContent).toBe('true');
    await unmount(root);
  });
});
