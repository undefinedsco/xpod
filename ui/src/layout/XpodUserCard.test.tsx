// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodProductLogoutBoundary } from '../auth/XpodProductLogoutBoundary';
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

afterEach(() => { cleanup(); profile.mockReset(); });

describe('XpodUserCard', () => {
  test('stays hidden when neither Account nor WebID is authenticated', () => {
    profile.mockReturnValue({ displayName: 'Anonymous', loading: false, source: 'account' });
    renderCard(account(false));
    expect(screen.queryByTestId('xpod-user-card-trigger')).toBeNull();
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
    fireEvent.click(screen.getByLabelText('Open account menu for Bob'));
    expect(screen.getByText('WebID connected')).toBeTruthy();
    expect(screen.queryByText('Account connected')).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch account' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
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
    expect(screen.queryByTestId('xpod-user-card-trigger')).toBeNull();
  });

  test('shows Account identity even when no WebID session is open', () => {
    profile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'account' });
    renderCard(account(true));
    expect(screen.getByLabelText('Open account menu for Alice')).toBeTruthy();
  });

  test('does not fall back to Account id for an active WebID handle without a profile nickname', () => {
    const webId = 'https://id.example/bob/profile/card#me';
    profile.mockReturnValue({ displayName: 'Bob Profile', webId, loading: false, source: 'webid-profile' });
    renderCard(account(true), { state: { status: 'authenticated', webId }, webId } as XpodSolidRuntimeValue);
    fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
    expect(screen.getByText('@bob')).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(accountLogout).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试退出' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(1));
    expect(solidLogout).toHaveBeenCalledTimes(2);
  });
});
