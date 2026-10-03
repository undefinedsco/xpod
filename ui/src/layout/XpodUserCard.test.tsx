// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodProductLogoutBoundary } from '../auth/XpodProductLogoutBoundary';
import { readRememberedXpodLogin, rememberPendingXpodAccountEmail, rememberXpodLogin } from '../auth/xpod-remembered-login';
import { XPOD_LOGIN_ROUTE_ID } from '../auth/xpod-login-route';
import { XpodUserCard } from './XpodUserCard';

vi.mock('../profile/useXpodProfileCardIdentity', () => ({ useXpodProfileCardIdentity: vi.fn() }));
const profile = vi.mocked(useXpodProfileCardIdentity);

function account(authenticated: boolean, logout = vi.fn(async () => undefined)): AuthContextType {
  return {
    controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/',
    isLoggedIn: authenticated, isAnonymous: () => !authenticated,
    authenticating: false, hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined), retry: vi.fn(async () => undefined), logout,
    accountState: authenticated ? { status: 'authenticated' } : { status: 'anonymous', mode: 'login' },
    ...(authenticated ? { identity: { id: 'alice', displayName: 'Alice', username: 'alice' } } : {}),
  };
}

function renderCard(accountValue: AuthContextType, runtime: XpodSolidRuntimeValue | null = null) {
  return render(
    <AuthContext.Provider value={accountValue}>
      <XpodSolidRuntimeContext.Provider value={runtime}><XpodProductLogoutBoundary><XpodUserCard /></XpodProductLogoutBoundary></XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>,
  );
}

afterEach(() => { cleanup(); profile.mockReset(); window.localStorage.clear(); window.sessionStorage.clear(); });

describe('XpodUserCard', () => {
  test.each([
    ['/.account/', `${window.location.origin}/.account/account/`],
    ['https://id.example/.account/', 'https://id.example/.account/account/'],
  ])('opens Account management at its advertised issuer %s', (idpIndex, href) => {
    profile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'account' });
    renderCard({ ...account(true), idpIndex });
    fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
    expect(screen.getByRole('link', { name: '账号管理' }).getAttribute('href')).toBe(href);
  });

  test('does not offer an Account link without a trusted HTTP issuer', () => {
    profile.mockReturnValue({ displayName: 'Alice', loading: false, source: 'account' });
    renderCard({ ...account(true), idpIndex: 'javascript:alert(1)' });
    fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
    expect(screen.queryByRole('link', { name: '账号管理' })).toBeNull();
  });

  test('offers login when neither Account nor WebID is authenticated', () => {
    profile.mockReturnValue({ displayName: 'Anonymous', loading: false, source: 'account' });
    renderCard(account(false));
    expect(screen.getByRole('link', { name: '登录' })).toBeTruthy();
  });

  test.each(['anonymous', 'error'] as const)('keeps WebID-only identity and logout available with Account %s and an unavailable Pod', async (status) => {
    const webId = 'https://id.example/bob/profile/card#me';
    const accountLogout = vi.fn(async () => undefined);
    const solidLogout = vi.fn(async () => undefined);
    const accountValue = {
      ...account(false, accountLogout),
      accountState: status === 'error'
        ? { status: 'error' as const, mode: 'login' as const, message: 'Account offline' }
        : { status: 'anonymous' as const, mode: 'login' as const },
      identity: { id: 'old-account', displayName: 'Old Account' },
    };
    const runtime = {
      state: { status: 'authenticated', webId },
      webId,
      podError: { webId, error: new Error('Pod unavailable') },
      logout: solidLogout,
    } as XpodSolidRuntimeValue;
    profile.mockReturnValue({ displayName: 'Bob', webId, loading: false, source: 'webid-profile' });
    renderCard(accountValue, runtime);
    expect(profile).toHaveBeenLastCalledWith({ accountIdentity: undefined, runtime });
    fireEvent.click(screen.getByLabelText('打开 Bob 的个人卡片'));
    expect(screen.getByText('WebID 已登录')).toBeTruthy();
    expect(screen.queryByText('Account connected')).toBeNull();
    expect(screen.getByRole('button', { name: '切换 WebID' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(1));
    expect(solidLogout).toHaveBeenCalledTimes(1);
    expect(accountValue.isLoggedIn).toBe(false);
    expect(accountValue.accountState.status).toBe(status);
  });

  test.each(['expired', 'error'] as const)('does not use a retained WebID in %s state as login evidence', (status) => {
    profile.mockReturnValue({ displayName: 'Bob', loading: false, source: 'webid-profile' });
    renderCard(account(false), {
      webId: 'https://id.example/bob#me',
      state: { status, webId: 'https://id.example/bob#me', error: new Error('expired') },
    } as XpodSolidRuntimeValue);
    expect(screen.getByRole('link', { name: '登录' })).toBeTruthy();
  });

  test('shows the authenticated Account without claiming a WebID session', () => {
    profile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'account' });
    renderCard(account(true));
    expect(screen.getByTestId('xpod-user-card-trigger')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '登录' })).toBeNull();
    expect(screen.queryByRole('button', { name: '切换 WebID' })).toBeNull();
  });

  test('does not fall back to Account id for an active WebID handle without a profile nickname', () => {
    const webId = 'https://id.example/bob/profile/card#me';
    profile.mockReturnValue({ displayName: 'Bob Profile', webId, loading: false, source: 'webid-profile' });
    renderCard(account(true), { state: { status: 'authenticated', webId }, webId } as XpodSolidRuntimeValue);
    fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
    expect(screen.getByText(webId)).toBeTruthy();
    expect(screen.queryByText('@alice')).toBeNull();
  });

  test('signs out the Solid session before the CSS Account authority', async () => {
    const order: string[] = [];
    const accountLogout = vi.fn(async () => { order.push('account'); });
    const solidLogout = vi.fn(async () => { order.push('solid'); });
    profile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'account' });
    renderCard({ ...account(true, accountLogout), isAnonymous: () => true }, {
      state: { status: 'authenticated', webId: 'https://id.example/alice#me' },
      logout: solidLogout,
    } as XpodSolidRuntimeValue);
    fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
    fireEvent.click(await screen.findByRole('button', { name: '退出' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(1));
    expect(solidLogout).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['solid', 'account']);
  });
  test('retains the account and retries after Solid logout fails', async () => {
    const accountLogout = vi.fn(async () => undefined);
    const solidLogout = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    profile.mockReturnValue({ displayName: 'Alice', loading: false, source: 'account' });
    renderCard({ ...account(true, accountLogout), isAnonymous: () => true }, {
      state: { status: 'authenticated', webId: 'https://id.example/alice#me' }, logout: solidLogout,
    } as XpodSolidRuntimeValue);
    fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(accountLogout).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '退出' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试退出' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(1));
    expect(solidLogout).toHaveBeenCalledTimes(2);
  });
});

test.each([undefined, { id: 'cloud-account' }])('uses unchecked temporary Account email from the advertised Cloud issuer with identity %j', (identity) => {
  rememberPendingXpodAccountEmail('cloud@example.test', undefined, 'https://id.example/.account/', false);
  profile.mockReturnValue({ displayName: 'Cloud', loading: false, source: 'account' });
  renderCard({ ...account(true), idpIndex: 'https://id.example/.account/', identity });
  const resolved = profile.mock.calls[profile.mock.calls.length - 1]?.[0].accountIdentity;
  expect(resolved?.username).toBe('cloud');
  expect(resolved?.id).toBe(identity?.id);
});


test.each(['bob', undefined])('does not borrow historical Account display for a different or missing cached id %s', (cachedId) => {
  const webId = 'https://id.example/bob/profile/card#me';
  rememberXpodLogin({
    issuer: 'https://id.example',
    account: { ...(cachedId ? { id: cachedId } : {}), username: 'bob', displayName: 'Bob Cache' },
    webId, storageBinding: { webId, storageUrl: 'https://pod.example/bob/' }, routeId: XPOD_LOGIN_ROUTE_ID,
  });
  expect(readRememberedXpodLogin()?.account.displayName).toBe('Bob Cache');
  profile.mockReturnValue({ displayName: 'alice', loading: false, source: 'account' });
  renderCard({ ...account(true), idpIndex: 'https://id.example/.account/', identity: { id: 'alice' } });
  expect(profile.mock.calls.at(-1)?.[0].accountIdentity).toEqual({ id: 'alice' });
});

test('current Account email wins over another Account historical display', () => {
  const webId = 'https://id.example/bob/profile/card#me';
  rememberXpodLogin({ issuer: 'https://id.example', account: { id: 'bob', username: 'bob', displayName: 'Bob Cache' },
    webId, storageBinding: { webId, storageUrl: 'https://pod.example/bob/' }, routeId: XPOD_LOGIN_ROUTE_ID });
  rememberPendingXpodAccountEmail('alice@example.test', undefined, 'https://id.example/.account/', true);
  profile.mockReturnValue({ displayName: 'alice', loading: false, source: 'account' });
  renderCard({ ...account(true), idpIndex: 'https://id.example/.account/', identity: { id: 'alice' } });
  expect(profile.mock.calls.at(-1)?.[0].accountIdentity).toEqual({ id: 'alice', username: 'alice', displayName: 'alice' });
});


test.each([
  { controls: { account: { logout: 'https://id.example/.account/account/alice/logout/' } }, cachedId: 'bob', expected: undefined },
  { controls: {}, cachedId: 'bob', expected: undefined },
  { controls: { account: { logout: 'https://id.example/.account/account/alice/logout/' } }, cachedId: 'alice', expected: { id: 'alice', username: 'alice', displayName: 'Alice Cache' } },
])('requires authoritative Account controls before borrowing cached presentation %j', ({ controls, cachedId, expected }) => {
  const webId = 'https://id.example/alice/profile/card#me';
  rememberXpodLogin({ issuer: 'https://id.example', account: { id: cachedId, username: cachedId, displayName: cachedId === 'alice' ? 'Alice Cache' : 'Bob Cache' },
    webId, storageBinding: { webId, storageUrl: 'https://pod.example/alice/' }, routeId: XPOD_LOGIN_ROUTE_ID });
  profile.mockReturnValue({ displayName: 'Account', loading: false, source: 'account' });
  renderCard({ ...account(true), idpIndex: 'https://id.example/.account/', identity: undefined, controls });
  expect(profile.mock.calls.at(-1)?.[0].accountIdentity).toEqual(expected);
});
