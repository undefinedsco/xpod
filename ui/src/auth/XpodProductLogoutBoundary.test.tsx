// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { SolidSessionAdapter } from '@undefineds.co/solid-sdk';
import { AuthProvider } from '../context/AuthContext';
import { useAuth } from '../context/AuthContextValue';
import { XpodUserCard } from '../layout/XpodUserCard';
import { createXpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodSolidRuntimeProvider } from '../solid/XpodSolidRuntimeProvider';
import { useXpodSolidRuntime } from '../solid/useXpodSolidRuntime';
import { WebIdAuthBoundary } from '../solid/WebIdAuthBoundary';
import { AccountAuthBoundary } from './AccountAuthBoundary';
import { XpodProductLogoutBoundary } from './XpodProductLogoutBoundary';

vi.mock('../profile/useXpodProfileCardIdentity', () => ({
  useXpodProfileCardIdentity: () => ({ displayName: 'Alice', loading: false, source: 'account' }),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

function StateProbe() {
  const account = useAuth();
  const runtime = useXpodSolidRuntime();
  return <output data-testid="provider-states">{account.accountState.status}/{runtime.state.status}</output>;
}

async function renderProduct(route: 'webid' | 'account', failure: 'account' | 'solid', accountFailures = 1) {
  const webId = `${window.location.origin}/alice/profile/card#me`;
  const podUrl = `${window.location.origin}/alice/`;
  let loggedIn = true;
  const accountLogout = vi.fn(async () => {
    if (failure === 'account' && accountLogout.mock.calls.length <= accountFailures) return new Response('', { status: 503 });
    loggedIn = false;
    return new Response('{}');
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === '/provision/status') return new Response('', { status: 404 });
    if (path === '/.account/logout' && init?.method === 'POST') return accountLogout();
    if (path === '/.account/') return new Response(JSON.stringify({ controls: loggedIn
      ? { account: { logout: '/.account/logout', id: 'alice', username: 'alice' } }
      : {} }));
    return new Response(JSON.stringify({ available: false }));
  }));
  const adapter: SolidSessionAdapter = {
    info: { isLoggedIn: true, webId },
    fetch: vi.fn(async () => new Response(JSON.stringify({ available: false }))),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => { adapter.info.isLoggedIn = false; }),
    handleIncomingRedirect: vi.fn(async () => undefined),
    events: { on: vi.fn(), off: vi.fn() } as unknown as SolidSessionAdapter['events'],
  };
  if (failure === 'solid') vi.mocked(adapter.logout).mockRejectedValueOnce(new Error('Solid cleanup failed'));
  const core = createXpodSolidRuntimeValue({ sessionFactory: () => adapter });
  core.setIssuer(window.location.origin);
  await core.session.initialize();
  vi.spyOn(core.pod, 'open').mockResolvedValue({ webId, podUrl } as Awaited<ReturnType<typeof core.pod.open>>);
  const protectedContent = <><XpodUserCard /><span data-testid="protected-content">Pod content</span></>;
  render(<AuthProvider><XpodSolidRuntimeProvider value={core}><MemoryRouter>
    <StateProbe />
    <XpodProductLogoutBoundary>
      {route === 'webid'
        ? <WebIdAuthBoundary autoStart>{protectedContent}</WebIdAuthBoundary>
        : <AccountAuthBoundary>{protectedContent}</AccountAuthBoundary>}
    </XpodProductLogoutBoundary>
  </MemoryRouter></XpodSolidRuntimeProvider></AuthProvider>);
  await waitFor(() => expect(screen.getByTestId('provider-states').textContent).toBe('authenticated/authenticated'));
  fireEvent.click(await screen.findByTestId('xpod-user-card-trigger'));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  return { accountLogout, solidLogout: vi.mocked(adapter.logout), login: vi.mocked(adapter.login) };
}

describe('product logout across real auth Provider transitions', () => {
  it('keeps repeated Account logout failures retryable until CSS confirms success', async () => {
    const { accountLogout, solidLogout, login } = await renderProduct('webid', 'account', 2);
    await screen.findByText('退出未完成');
    fireEvent.click(screen.getByRole('button', { name: '重试退出' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('退出未完成')).toBeTruthy();
    expect(screen.getByTestId('provider-states').textContent).toBe('error/anonymous');
    fireEvent.click(screen.getByRole('button', { name: '重试退出' }));
    await waitFor(() => expect(screen.getByTestId('provider-states').textContent).toBe('anonymous/anonymous'));
    expect(accountLogout).toHaveBeenCalledTimes(3);
    expect(solidLogout).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
    expect(screen.queryByText('退出未完成')).toBeNull();
  });

  it.each(['webid', 'account'] as const)('retains Account failure recovery after the %s gate unmounts the card', async (route) => {
    const { accountLogout, solidLogout, login } = await renderProduct(route, 'account');
    await screen.findByText('退出未完成');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByTestId('provider-states').textContent).toBe('error/anonymous');
    expect(screen.queryByTestId('xpod-user-card-trigger')).toBeNull();
    expect(screen.queryByTestId('protected-content')).toBeNull();
    expect(solidLogout).toHaveBeenCalledTimes(1);
    expect(accountLogout).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重试退出' }));
    await waitFor(() => expect(screen.getByTestId('provider-states').textContent).toBe('anonymous/anonymous'));
    expect(accountLogout).toHaveBeenCalledTimes(2);
    expect(solidLogout).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
    expect(screen.queryByText('退出未完成')).toBeNull();
  });

  it('keeps Account intact until failed Solid cleanup is successfully retried', async () => {
    const { accountLogout, solidLogout } = await renderProduct('webid', 'solid');
    await screen.findByText('退出未完成');
    expect(accountLogout).not.toHaveBeenCalled();
    expect(screen.getByTestId('provider-states').textContent).toBe('authenticated/authenticated');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.getByTestId('protected-content').closest('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试退出' }));
    await waitFor(() => expect(screen.getByTestId('provider-states').textContent).toBe('anonymous/anonymous'));
    expect(solidLogout).toHaveBeenCalledTimes(2);
    expect(accountLogout).toHaveBeenCalledTimes(1);
  });
});
