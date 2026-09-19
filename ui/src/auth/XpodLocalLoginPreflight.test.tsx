// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

  // 锁定回归（设计 §8 第 1 步 / U07）：预检不得内嵌建 Pod。
  // 账号已登录不等于 Pod 就绪；登录必须能在零 Pod 时继续，
  // 建 Pod 是 Pod 管理页的显式操作。
  it('does not embed Pod creation when the Account is already authenticated', async () => {
    vi.mocked(isManagedLocalProvisionHost).mockReturnValue(true);
    const onReady = vi.fn();
    render(<AuthContext.Provider value={{ isInitializing: false, isLoggedIn: true } as AuthContextType}>
      <XpodLocalLoginPreflight onReady={onReady} />
    </AuthContext.Provider>);

    // 不得渲染建 Pod 入口。
    expect(screen.queryByRole('button', { name: 'Local Pod ready' })).toBeNull();
    // 且登录应当继续，不因缺少 Pod 而卡住。
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });
});
