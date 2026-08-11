import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { XpodAuthContext, type XpodAuthValue } from '../auth/useXpodAuth';
import { createXpodLogoutCoordinator } from '../auth/xpod-logout';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodUserCard } from './XpodUserCard';

afterEach(() => cleanup());

function runtime(overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
  const state = overrides.state ?? { status: 'anonymous' };
  return {
    session: { getSnapshot: () => state.status === 'authenticated'
      ? { status: 'authenticated', webId: state.webId }
      : { status: 'anonymous' } } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn() as typeof fetch,
    state,
    webId: state.status === 'authenticated' ? state.webId : undefined,
    podUrl: state.status === 'authenticated' ? state.podUrl : undefined,
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as XpodSolidRuntimeValue;
}

function auth(overrides: Partial<XpodAuthValue> = {}): XpodAuthValue {
  const coordinator = createXpodLogoutCoordinator({
    account: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
    webId: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
  });
  return {
    account: {
      accountState: { status: 'anonymous', mode: 'login' },
      isLoggedIn: false,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      ...overrides.account,
    },
    runtime: runtime(),
    routes: [],
    webIdState: { status: 'anonymous' },
    readiness: { dashboard: false, localSettings: true, podSettings: false },
    selectedStorage: undefined,
    startLogin: vi.fn(async () => undefined),
    retryLogin: vi.fn(async () => undefined),
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' })),
    retryLogout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' })),
    logoutState: { status: 'idle' },
    logoutCoordinator: coordinator,
    switchAccount: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderCard(value: XpodAuthValue, solid: XpodSolidRuntimeValue = runtime()) {
  return render(
    <XpodAuthContext.Provider value={value}>
      <XpodSolidRuntimeContext.Provider value={solid}>
        <XpodUserCard product="dashboard" switchHref="/settings/models" />
      </XpodSolidRuntimeContext.Provider>
    </XpodAuthContext.Provider>,
  );
}

describe('XpodUserCard', () => {
  test('opens a real dialog and starts the shared login controller when anonymous', async () => {
    const value = auth();
    renderCard(value);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in to xpod/i }));
    });
    expect(value.startLogin).toHaveBeenCalledTimes(1);
  });

  test('shows sanitized Account, WebID, and selected Pod summary without secrets', async () => {
    const secret = 'Bearer super-secret-token';
    const solid = runtime({
      state: {
        status: 'authenticated',
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
      },
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      selectedStorage: { webId: 'https://id.example/alice#me', storageUrl: 'https://pod.example/alice/' },
    });
    const value = auth({
      account: {
        accountState: { status: 'authenticated' },
        isLoggedIn: true,
        identity: { displayName: 'Alice', username: 'alice' },
      },
      runtime: solid,
    });
    renderCard(value, solid);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });

    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByText('https://id.example/alice#me')).toBeTruthy();
    expect(screen.getByText('https://pod.example/alice/')).toBeTruthy();
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use a different account/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings/models');
  });

  test('marks the shared identity control as Pod-ready only for an exact open binding', async () => {
    const solid = runtime({
      state: {
        status: 'authenticated',
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
      },
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      selectedStorage: { webId: 'https://id.example/alice#me', storageUrl: 'https://pod.example/alice/' },
      currentPod: { webId: 'https://id.example/alice#me', podUrl: 'https://pod.example/alice/' } as XpodSolidRuntimeValue['currentPod'],
    });
    const value = auth({
      account: { accountState: { status: 'authenticated' }, isLoggedIn: true, identity: { username: 'alice' } },
      runtime: solid,
    });
    renderCard(value, solid);

    expect(screen.getByTestId('xpod-user-card-trigger').getAttribute('data-pod-ready')).toBe('true');
  });

  test('hides authenticated actions after a partial failure and offers deterministic retry', async () => {
    const retryLogout = vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const));
    const value = auth({
      account: { accountState: { status: 'error', mode: 'login', message: 'unavailable' }, isLoggedIn: false, identity: { username: 'alice' } },
      logoutState: { status: 'error', account: 'error', webId: 'complete' },
      retryLogout,
    });
    renderCard(value, runtime({ state: { status: 'authenticated', webId: 'https://id.example/alice#me' } }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });

    expect(screen.getByText(/sign out incomplete/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /use a different account/i })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });
    expect(retryLogout).toHaveBeenCalledTimes(1);
  });
});
