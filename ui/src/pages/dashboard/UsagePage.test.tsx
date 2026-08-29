import { describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthContext, type AuthContextType } from '../../context/AuthContextValue';
import UsagePage from './UsagePage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/dashboard/usage',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  window.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(max-width: 767px)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function authValue(accountId?: string): AuthContextType {
  const accountState: AuthContextType['accountState'] = accountId
    ? { status: 'authenticated' }
    : { status: 'anonymous', mode: 'login' };
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn: Boolean(accountId),
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState,
    identity: accountId ? { id: accountId, username: accountId } : undefined,
  };
}

function usageResponse(accountId: string, storageBytes: number): Response {
  return new Response(JSON.stringify({
    accountId,
    usage: {
      storageBytes,
      ingressBytes: 0,
      egressBytes: 0,
      computeSeconds: 0,
      tokensUsed: 0,
      periodStart: null,
    },
  }), { headers: { 'content-type': 'application/json' } });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function render(value: AuthContextType, fetchImpl: typeof fetch) {
  installDom();
  globalThis.fetch = fetchImpl;
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthContext.Provider value={value}>
        <UsagePage />
      </AuthContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

async function rerender(root: Root, value: AuthContextType) {
  await act(async () => {
    root.render(
      <AuthContext.Provider value={value}>
        <UsagePage />
      </AuthContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

describe('UsagePage request ownership', () => {
  test('ignores stale completion after an account switch and lets the latest account win', async () => {
    const requests = new Map<string, ReturnType<typeof deferredResponse>>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const accountId = decodeURIComponent(String(input).split('/').at(-1)!);
      const deferred = deferredResponse();
      requests.set(accountId, deferred);
      return deferred.promise;
    }) as typeof fetch;
    const rendered = await render(authValue('account-a'), fetchImpl);
    expect(requests.has('account-a')).toBe(true);

    await rerender(rendered.root, authValue('account-b'));
    expect(requests.has('account-b')).toBe(true);

    await act(async () => {
      requests.get('account-a')?.resolve(usageResponse('account-a', 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rendered.container.textContent).not.toContain('1 B');
    expect(rendered.container.textContent).toContain('Loading account usage');

    await act(async () => {
      requests.get('account-b')?.resolve(usageResponse('account-b', 2));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rendered.container.textContent).toContain('2 B');
    expect(rendered.container.textContent).not.toContain('1 B');
    await unmount(rendered.root);
  });

  test('ignores stale errors and loading completion after an account switch', async () => {
    const requests = new Map<string, ReturnType<typeof deferredResponse>>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const accountId = decodeURIComponent(String(input).split('/').at(-1)!);
      const deferred = deferredResponse();
      requests.set(accountId, deferred);
      return deferred.promise;
    }) as typeof fetch;
    const rendered = await render(authValue('account-a'), fetchImpl);
    await rerender(rendered.root, authValue('account-b'));

    await act(async () => {
      requests.get('account-a')?.reject(new Error('stale account failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(rendered.container.textContent).toContain('Loading account usage');

    await act(async () => {
      requests.get('account-b')?.resolve(usageResponse('account-b', 4));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rendered.container.textContent).toContain('4 B');
    await unmount(rendered.root);
  });

  test('clears prior usage when switching accounts and logging out', async () => {
    const requests = new Map<string, ReturnType<typeof deferredResponse>>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const accountId = decodeURIComponent(String(input).split('/').at(-1)!);
      const deferred = deferredResponse();
      requests.set(accountId, deferred);
      return deferred.promise;
    }) as typeof fetch;
    const rendered = await render(authValue('account-a'), fetchImpl);
    requests.get('account-a')?.resolve(usageResponse('account-a', 3));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rendered.container.textContent).toContain('3 B');

    await rerender(rendered.root, authValue('account-b'));
    expect(rendered.container.textContent).not.toContain('3 B');
    expect(rendered.container.textContent).toContain('Loading account usage');

    await rerender(rendered.root, authValue());
    expect(rendered.container.textContent).not.toContain('3 B');
    expect(rendered.container.textContent).toContain('Account identity unavailable');
    await unmount(rendered.root);
  });
});
