import { describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { AuthProvider } from '../context/AuthContext';
import { useAuth } from '../context/AuthContextValue';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom(fetchImpl?: typeof fetch) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/.account/',
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
      <span data-testid="error">{auth.accountState.status === 'error' ? auth.accountState.message : ''}</span>
      <button type="button" onClick={() => void auth.retry()}>retry</button>
    </div>
  );
}

async function render(fetchImpl?: typeof fetch) {
  installDom(fetchImpl);
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(<AuthProvider><Probe /></AuthProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

describe('Xpod Account controller', () => {
  test('clears local Account token on 401/403 and remains anonymous', async () => {
    installDom();
    window.sessionStorage.setItem('xpod.cssAccountToken', 'secret-token');
    document.cookie = 'css-account=secret-token; Path=/';
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthProvider><Probe /></AuthProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('anonymous');
    expect(container.querySelector('[data-testid="logged-in"]')?.textContent).toBe('false');
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(document.cookie).not.toContain('secret-token');
    await unmount(root);
  });

  test('classifies 502 as retryable without freezing initialization', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 502 }));
    const { container, root } = await render(fetchImpl as unknown as typeof fetch);

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toMatch(/temporarily unavailable/i);

    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ controls: { account: { logout: '/.account/logout/' } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('authenticated');
    await unmount(root);
  });
});
