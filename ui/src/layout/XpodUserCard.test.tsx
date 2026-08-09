// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../solid/XpodSolidRuntime';
import { XpodUserCard } from './XpodUserCard';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { storeAccountSessionToken } from '../utils/account-session';

function renderCard(state: XpodSolidRuntimeValue['state'], accountLoggedIn = false) {
  const value = {
    state,
    webId: state.webId,
    podUrl: state.podUrl,
    issuer: state.issuer,
    fetch: globalThis.fetch,
    login: async () => undefined,
    logout: async () => undefined,
  } as XpodSolidRuntimeValue;

  return renderToStaticMarkup(
    <AuthContext.Provider value={{
      controls: accountLoggedIn ? { account: { logout: '/.account/logout/' } } : {},
      isInitializing: false, initError: null, idpIndex: '/.account/', isLoggedIn: accountLoggedIn,
      authenticating: false, hasOidcPending: false, refetchControls: async () => undefined,
    } satisfies AuthContextType}>
      <XpodSolidRuntimeContext.Provider value={value}>
        <XpodUserCard />
      </XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>,
  );
}

function authValue(accountLoggedIn: boolean, refetchControls = vi.fn(async () => undefined)): AuthContextType {
  return {
    controls: accountLoggedIn ? { account: { logout: '/.account/logout/' } } : {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn: accountLoggedIn,
    authenticating: false,
    hasOidcPending: false,
    refetchControls,
  };
}

function runtimeValue(
  state: XpodSolidRuntimeValue['state'],
  overrides: Partial<XpodSolidRuntimeValue> = {},
): XpodSolidRuntimeValue {
  return {
    state,
    webId: state.webId,
    podUrl: state.podUrl,
    issuer: state.issuer,
    fetch: globalThis.fetch,
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as XpodSolidRuntimeValue;
}

function renderInteractiveCard(runtime: XpodSolidRuntimeValue, account: AuthContextType) {
  render(
    <AuthContext.Provider value={account}>
      <XpodSolidRuntimeContext.Provider value={runtime}>
        <XpodUserCard />
      </XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>,
  );
}

describe('XpodUserCard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  test('shows the current identity and Pod actions', () => {
    const html = renderCard({
      status: 'authenticated',
      webId: 'https://id.example/alice/profile/card#me',
      podUrl: 'https://pod.example/alice/',
      issuer: 'https://id.example/',
    }, true);

    expect(html).toContain('aria-label="Current user"');
    expect(html).toContain('alice');
    expect(html).toContain('https://pod.example/alice/');
    expect(html).toContain('Open Pod');
    expect(html).toContain('Copy WebID');
    expect(html).toContain('Xpod account');
    expect(html).toContain('Solid identity');
    expect(html).toContain('Sign out account');
    expect(html).toContain('Disconnect WebID');
  });

  test('explains that Pod discovery is still pending', () => {
    const html = renderCard({
      status: 'authenticated',
      webId: 'https://id.example/alice/profile/card#me',
      issuer: 'https://id.example/',
    });

    expect(html).toContain('Pod discovery pending');
    expect(html).not.toContain('Open Pod');
  });

  test('shows a signed-out identity entry without operational summaries', () => {
    const html = renderCard({ status: 'anonymous', issuer: 'https://id.example/' });

    expect(html).toContain('Not signed in');
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Storage');
    expect(html).not.toContain('Bandwidth');
    expect(html).not.toContain('AI Config');
  });

  test('announces identity switching while the runtime session is loading', () => {
    const html = renderCard({ status: 'loading', issuer: 'https://id.example/' });

    expect(html).toContain('Switching Solid identity…');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('Connect a Solid identity');
  });

  test('shows an unavailable identity with a recovery action', () => {
    const html = renderCard({ status: 'error', issuer: 'https://id.example/', error: new Error('session unavailable') });

    expect(html).toContain('Identity unavailable');
    expect(html).toContain('session unavailable');
    expect(html).toContain('Try again');
  });

  test('allows signing out from an account-only session', async () => {
    const refetchControls = vi.fn(async () => undefined);
    const fetchLogout = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchLogout);
    storeAccountSessionToken('account-token');

    renderInteractiveCard(
      runtimeValue({ status: 'anonymous', issuer: 'https://id.example/' }),
      authValue(true, refetchControls),
    );

    expect(screen.getAllByText('Xpod account').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Disconnect WebID/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Sign out account/i }));

    await waitFor(() => expect(fetchLogout).toHaveBeenCalledWith('/.account/logout/', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'CSS-Account-Token account-token',
      },
      credentials: 'include',
    }));
    expect(refetchControls).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
  });

  test('keeps WebID-only actions separate from account actions', () => {
    const logout = vi.fn(async () => undefined);

    renderInteractiveCard(
      runtimeValue({
        status: 'authenticated',
        webId: 'https://id.example/alice/profile/card#me',
        podUrl: 'https://pod.example/alice/',
        issuer: 'https://id.example/',
      }, { logout }),
      authValue(false),
    );

    expect(screen.getByRole('button', { name: /Disconnect WebID/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign out account/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Disconnect WebID/i }));

    expect(logout).toHaveBeenCalledTimes(1);
  });

  test('does not mix account sign-out with WebID disconnect when both sessions exist', async () => {
    const logout = vi.fn(async () => undefined);
    const refetchControls = vi.fn(async () => undefined);
    const fetchLogout = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchLogout);

    renderInteractiveCard(
      runtimeValue({
        status: 'authenticated',
        webId: 'https://id.example/alice/profile/card#me',
        podUrl: 'https://pod.example/alice/',
        issuer: 'https://id.example/',
      }, { logout }),
      authValue(true, refetchControls),
    );

    fireEvent.click(screen.getByRole('button', { name: /Disconnect WebID/i }));

    expect(logout).toHaveBeenCalledTimes(1);
    expect(fetchLogout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Sign out account/i }));

    await waitFor(() => expect(fetchLogout).toHaveBeenCalledTimes(1));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(refetchControls).toHaveBeenCalledTimes(1);
  });
});
