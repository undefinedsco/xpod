// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { isManagedLocalProvisionHost } from '../utils/pod';
import { XpodLocalLoginPreflight } from './XpodLocalLoginPreflight';

vi.mock('../utils/pod', () => ({ isManagedLocalProvisionHost: vi.fn() }));
vi.mock('../pages/FirstPodPage', () => ({ FirstPodPage: ({ onReady }: { onReady: () => void }) => <button onClick={onReady}>Local Pod ready</button> }));
vi.mock('./AccountAuthBoundary', () => ({ AccountAuthBoundary: ({ children }: { children: React.ReactNode }) => <section data-testid="account-gate">{children}</section> }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Local login preflight', () => {
  it('skips Account readiness for Cloud and standalone authorization', async () => {
    vi.mocked(isManagedLocalProvisionHost).mockReturnValue(false);
    const onReady = vi.fn();
    render(<StrictMode><XpodLocalLoginPreflight onReady={onReady} /></StrictMode>);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('account-gate')).toBeNull();
  });

  it('waits for discovery, then lets anonymous Local users authenticate inside OIDC', async () => {
    vi.mocked(isManagedLocalProvisionHost).mockReturnValue(true);
    const onReady = vi.fn();
    const view = render(<AuthContext.Provider value={{ isInitializing: true } as AuthContextType}>
      <XpodLocalLoginPreflight onReady={onReady} />
    </AuthContext.Provider>);
    expect(screen.queryByTestId('account-gate')).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
    view.rerender(<AuthContext.Provider value={{ isInitializing: false, isLoggedIn: false } as AuthContextType}>
      <XpodLocalLoginPreflight onReady={onReady} />
    </AuthContext.Provider>);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('account-gate')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Local Pod ready' })).toBeNull();
  });

  it('prepares Local storage when the Account is already authenticated', () => {
    vi.mocked(isManagedLocalProvisionHost).mockReturnValue(true);
    const onReady = vi.fn();
    render(<AuthContext.Provider value={{ isInitializing: false, isLoggedIn: true } as AuthContextType}>
      <XpodLocalLoginPreflight onReady={onReady} />
    </AuthContext.Provider>);
    expect(onReady).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Local Pod ready' }));
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
