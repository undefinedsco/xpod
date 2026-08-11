// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
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
    accountAuthState: authenticated,
    authState: authenticated,
    state: authenticated,
    ...overrides,
  };
}

describe('AccountPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /add pod/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /new key/i })).toBeNull();
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
});
