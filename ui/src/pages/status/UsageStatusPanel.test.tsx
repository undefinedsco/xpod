import { describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthContext, type AuthContextType } from '../../context/AuthContextValue';
import UsageStatusPanel from './UsageStatusPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/status/usage/storage',
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
  document.cookie = 'css-account=account-token';
}

function authValue(accountId = 'account-a'): AuthContextType {
  const accountState: AuthContextType['accountState'] = { status: 'authenticated' };
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn: true,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState,
    identity: { id: accountId, username: accountId },
  };
}

function usageResponse(accountId: string, storageBytes: number): Response {
  return new Response(JSON.stringify({
    accountId,
    usage: {
      storageBytes,
      ingressBytes: 2048,
      egressBytes: 1024,
      computeSeconds: 3,
      tokensUsed: 4,
      periodStart: null,
    },
    limits: {
      storageLimitBytes: null,
      bandwidthLimitBps: null,
      computeLimitSeconds: null,
      tokenLimitMonthly: null,
    },
  }), { headers: { 'content-type': 'application/json' } });
}

async function render(fetchImpl: typeof fetch) {
  installDom();
  globalThis.fetch = fetchImpl;
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthContext.Provider value={authValue()}>
        <UsageStatusPanel kind="storage" />
      </AuthContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

describe('UsageStatusPanel account boundary', () => {
  test('loads storage usage through the account API with the stored account token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/v1/usage/accounts/account-a');
      expect((init?.headers as Record<string, string>).Authorization).toBe('CSS-Account-Token account-token');
      return usageResponse('account-a', 2048);
    }) as typeof fetch;

    const rendered = await render(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rendered.container.textContent).toContain('Storage');
    expect(rendered.container.textContent).toContain('2 KB');
    expect(rendered.container.textContent).not.toContain('Pod');
    await unmount(rendered.root);
  });
});
