import { describe, expect, test, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { AccountAuthBoundary } from './AccountAuthBoundary';
import { XpodAuthContext, type XpodAuthValue } from './useXpodAuth';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/dashboard/overview',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
}

async function render(value: XpodAuthValue, children?: ReactNode) {
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodAuthContext.Provider value={value}>
        <AccountAuthBoundary>{children}</AccountAuthBoundary>
      </XpodAuthContext.Provider>,
    );
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

function value(overrides: Partial<XpodAuthValue> = {}): XpodAuthValue {
  return {
    account: {
      accountState: { status: 'anonymous', mode: 'login' },
      isLoggedIn: false,
      identity: undefined,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    },
    startLogin: vi.fn(async () => undefined),
    routes: [],
    readiness: { dashboard: false, localSettings: true, podSettings: false },
    runtime: undefined,
    ...overrides,
  };
}

describe('AccountAuthBoundary', () => {
  test('uses the one Xpod startLogin action and never exposes a password URL', async () => {
    const startLogin = vi.fn(async () => undefined);
    const rendered = await render(value({ startLogin }));
    const button = rendered.container.querySelector('button');
    expect(button).toBeTruthy();
    expect(rendered.container.textContent).not.toMatch(/password|provider|cloud|external/i);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(startLogin).toHaveBeenCalledTimes(1);
    await unmount(rendered.root);
  });

  test('renders authenticated children and retryable Account errors', async () => {
    const retry = vi.fn(async () => undefined);
    const rendered = await render(value({
      account: {
        accountState: { status: 'error', mode: 'login', message: 'Account temporarily unavailable' },
        isLoggedIn: false,
        identity: undefined,
        retry,
        refetchControls: retry,
        logout: vi.fn(async () => undefined),
      },
    }), <span data-testid="protected">ready</span>);

    expect(rendered.container.textContent).toContain('Account temporarily unavailable');
    const retryButton = Array.from(rendered.container.querySelectorAll('button')).find((node) => /retry/i.test(node.textContent ?? ''));
    expect(retryButton).toBeTruthy();
    await act(async () => retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(retry).toHaveBeenCalledTimes(1);
    await unmount(rendered.root);
  });
});
