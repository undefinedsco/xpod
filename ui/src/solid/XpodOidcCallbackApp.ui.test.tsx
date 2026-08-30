// @vitest-environment jsdom

import { useEffect } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  resolveXpodCallbackRestartDestination,
  XpodOidcCallbackApp,
  type XpodOidcCallbackRuntime,
} from './XpodOidcCallbackApp';
import { createXpodLoginTransactionStore } from '../auth/xpod-login-transaction';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function callbackRuntime(): XpodOidcCallbackRuntime {
  return {
    session: {
      fetch: vi.fn(async () => new Response('ok')),
      getSnapshot: () => ({ status: 'anonymous' as const }),
      handleIncomingRedirect: vi.fn(),
      logout: vi.fn(async () => undefined),
    },
    pod: { open: vi.fn() },
    getIssuer: () => window.location.origin,
    setIssuer: () => undefined,
  } as unknown as XpodOidcCallbackRuntime;
}

describe('Xpod OIDC callback recovery surface', () => {
  test('lets the redirected product app own the document title', async () => {
    const href = `${window.location.origin}/auth/callback?transaction=callback-ui-completed-123456`;
    window.sessionStorage.setItem('xpod.auth.callback.completed.v1.callback-ui-completed-123456', JSON.stringify({
      destination: `${window.location.origin}/ai-config/model-assignments`,
      completedAt: Date.now(),
    }));
    document.title = 'Xpod - 正在登录';

    function ProductApp() {
      useEffect(() => {
        document.title = 'Xpod Settings';
      }, []);
      return <main>AI Config</main>;
    }

    render(
      <XpodOidcCallbackApp
        href={href}
        runtime={callbackRuntime()}
        location={{ replace: vi.fn() }}
        renderRedirected={() => <ProductApp />}
      />,
    );

    await waitFor(() => expect(document.title).toBe('Xpod Settings'));
  });

  test('shows one branded recovery action instead of the raw provider error', async () => {
    const href = `${window.location.origin}/auth/callback?transaction=callback-ui-stale-123456&code=used&state=used`;
    const runtime = callbackRuntime();
    const restartSignIn = vi.fn();
    const view = render(
      <XpodOidcCallbackApp
        href={href}
        runtime={runtime}
        restartSignIn={restartSignIn}
      />,
    );

    const surface = await view.findByRole('region', { name: '登录请求已失效' });
    expect(surface.textContent).toContain('这次登录请求已经失效，请重新登录。');
    expect(view.queryByText('Unable to complete Xpod sign-in')).toBeNull();
    expect(view.queryByText('The identity provider could not verify this sign-in. Start again.')).toBeNull();
    expect(view.getAllByRole('button')).toHaveLength(1);
    expect(view.getByRole('button', { name: '重新登录' })).toBeTruthy();
    expect(surface.querySelectorAll('a')).toHaveLength(0);
    expect(surface.querySelector('details')?.textContent).toContain('missing-transaction');
    expect(view.getByTestId('xpod-login-brand').getAttribute('data-presentation')).toBe('compact');
    expect(view.queryByText('使用 WebID 登录')).toBeNull();
    expect(view.getByTestId('xpod-login-brand').className).not.toContain('flex-col');
    expect(view.getByTestId('xpod-login-brand').querySelector('img')?.className).toContain('h-7');
    const details = surface.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.className).toContain('focus-visible:ring-ring');
    expect(details?.querySelector('code')?.className).not.toContain('bg-muted');
    expect(view.getByRole('alert').parentElement?.contains(details)).toBe(true);
    expect(runtime.session.handleIncomingRedirect).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: '重新登录' }));
    await waitFor(() => {
      expect(runtime.session.logout).toHaveBeenCalledTimes(1);
      expect(restartSignIn).toHaveBeenCalledWith('/dashboard/overview');
    });
  });

  test('returns settings-only callback recovery to the settings product entry', () => {
    const href = `${window.location.origin}/auth/callback?transaction=callback-ui-settings-stale-123456&code=used&state=used`;

    expect(resolveXpodCallbackRestartDestination({
      href,
      basePath: '/settings/',
    })).toBe('/settings/');
  });

  test('prefers the pending transaction returnTo over the settings product entry fallback', () => {
    const href = `${window.location.origin}/auth/callback?transaction=callback-ui-return-to-123456&code=code&state=state`;
    const store = createXpodLoginTransactionStore({
      origin: window.location.origin,
      storage: window.sessionStorage,
    });
    store.begin({
      id: 'callback-ui-return-to-123456',
      route: {
        id: 'xpod-current-origin',
        label: window.location.host,
        identityProvider: { url: window.location.origin, label: window.location.host },
        storageProvider: { url: window.location.origin, label: window.location.host },
        availability: 'ready',
      },
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/ai-config/model-assignments',
    });

    expect(resolveXpodCallbackRestartDestination({
      href,
      transactionStore: store,
      basePath: '/settings/',
    })).toBe('/ai-config/model-assignments');
  });

  test('keeps callback recovery in the compact desktop workspace card', async () => {
    vi.stubGlobal('xpodDesktop', {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode: vi.fn(),
    });
    const href = `${window.location.origin}/auth/callback?transaction=callback-ui-window-stale-123456&code=used&state=used`;

    const view = render(
      <XpodOidcCallbackApp
        href={href}
        runtime={callbackRuntime()}
        restartSignIn={vi.fn()}
      />,
    );

    const surface = await view.findByRole('region', { name: '登录请求已失效' });
    expect(surface.parentElement?.getAttribute('data-auth-surface-host')).toBeNull();
    expect(surface.classList.contains('w-[280px]')).toBe(true);
    expect(surface.classList.contains('h-[400px]')).toBe(true);
    expect(view.getByTestId('xpod-login-brand')).toBeTruthy();
    expect(view.getAllByRole('heading', { name: '登录请求已失效' })).toHaveLength(2);

  });

  test('auto-resets a mismatched WebID and returns to the transaction product login entry', async () => {
    const transactionId = 'callback-ui-webid-mismatch-123456';
    const href = `${window.location.origin}/auth/callback?transaction=${transactionId}&code=code&state=state`;
    window.history.replaceState(null, '', href);
    const store = createXpodLoginTransactionStore({
      origin: window.location.origin,
      storage: window.sessionStorage,
    });
    store.begin({
      id: transactionId,
      route: {
        id: 'xpod-current-origin',
        label: window.location.host,
        identityProvider: { url: window.location.origin, label: window.location.host },
        storageProvider: { url: window.location.origin, label: window.location.host },
        availability: 'ready',
      },
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/ai-config/model-assignments',
      selectedStorage: {
        webId: `${window.location.origin}/alice/profile/card#me`,
        storageUrl: `${window.location.origin}/alice/`,
      },
    });
    const runtime = callbackRuntime();
    runtime.session.getSnapshot = () => ({
      status: 'authenticated',
      webId: `${window.location.origin}/bob/profile/card#me`,
    });
    runtime.session.handleIncomingRedirect = vi.fn(async () => ({
      status: 'authenticated',
      webId: `${window.location.origin}/bob/profile/card#me`,
    }));
    const restartSignIn = vi.fn();

    const view = render(
      <XpodOidcCallbackApp
        href={href}
        runtime={runtime}
        transactionStore={store}
        restartSignIn={restartSignIn}
      />,
    );

    expect((await view.findByRole('status')).textContent).toContain('Xpod 正在清理不匹配的登录状态。');
    expect(view.queryByText('身份与 Pod 不匹配')).toBeNull();
    expect(view.queryByText(/Account, WebID, and Pod/u)).toBeNull();
    expect(view.queryByRole('button')).toBeNull();
    await waitFor(() => {
      expect(runtime.session.logout).toHaveBeenCalledTimes(1);
      expect(restartSignIn).toHaveBeenCalledWith('/ai-config/model-assignments');
    });
    expect(store.readSinglePending()).toBeUndefined();
  });
});
