// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
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
      <XpodSolidRuntimeContext.Provider value={runtime}><XpodUserCard /></XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>,
  );
}

afterEach(() => { cleanup(); profile.mockReset(); });

describe('XpodUserCard', () => {
  test('is owned by the CSS Account session and stays hidden while Account is anonymous', () => {
    profile.mockReturnValue({ displayName: 'Anonymous', loading: false, source: 'account' });
    renderCard(account(false));
    expect(screen.queryByTestId('xpod-user-card-trigger')).toBeNull();
  });

  test('shows Account identity even when no WebID session is open', () => {
    profile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'account' });
    renderCard(account(true));
    expect(screen.getByLabelText('Open account menu for Alice')).toBeTruthy();
  });

  test('signs out only the CSS Account authority', async () => {
    const accountLogout = vi.fn(async () => undefined);
    const solidLogout = vi.fn(async () => undefined);
    profile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'account' });
    renderCard(account(true, accountLogout), {
      state: { status: 'authenticated', webId: 'https://id.example/alice#me' },
      logout: solidLogout,
    } as XpodSolidRuntimeValue);
    fireEvent.click(screen.getByTestId('xpod-user-card-trigger'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(1));
    expect(solidLogout).not.toHaveBeenCalled();
  });
});
