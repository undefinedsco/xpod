import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { WelcomePage } from './WelcomePage';

const flow = vi.hoisted(() => ({ complete: vi.fn(), retry: vi.fn(), login: vi.fn(), bootstrap: vi.fn() }));
vi.mock('../utils/registration-flow', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/registration-flow')>(),
  completeRegistrationProvisioning: flow.complete,
  retryRegistrationReadiness: flow.retry,
  loginAccountPassword: flow.login,
  bootstrapAccountPasswordLogin: flow.bootstrap,
}));
vi.mock('../utils/registration', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/registration')>(),
  checkRegistrationUsernameAvailability: vi.fn(async () => ({ available: true, suggestions: [] })),
}));
vi.mock('../utils/account-control-url', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/account-control-url')>(),
  resolveHostedAccountControlUrl: vi.fn(async (value: string) => value),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear(); });

it('retries only readiness after creation without resubmitting credentials or creating a Pod', async () => {
  const { RegistrationProvisioningNotReadyError } = await import('../utils/registration-flow');
  flow.login.mockResolvedValue({ accountToken: 'fixture-account-token' });
  flow.complete.mockRejectedValue(new RegistrationProvisioningNotReadyError());
  flow.retry.mockRejectedValue(new RegistrationProvisioningNotReadyError());
  const value: AuthContextType = {
    controls: { password: { login: '/.account/login/password/' } },
    idpIndex: '/.account/', isLoggedIn: false, authenticating: false, hasOidcPending: false,
    isInitializing: false, initError: null, accountState: { status: 'anonymous', mode: 'login' },
    refetchControls: vi.fn(), retry: vi.fn(), logout: vi.fn(),
  };
  render(<AuthContext.Provider value={value}><MemoryRouter>
    <WelcomePage initialIsRegister />
  </MemoryRouter></AuthContext.Provider>);
  fireEvent.change(screen.getByLabelText('Pod 名称'), { target: { value: 'acceptance-ready' } });
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'acceptance@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password' } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'fixture-password' } });
  fireEvent.click(screen.getByRole('button', { name: '创建账号', exact: true }));
  await screen.findByRole('heading', { name: '正在确认存储空间' });
  expect(screen.queryByRole('button', { name: '创建账号', exact: true })).toBeNull();
  expect(screen.queryByLabelText('密码')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试确认' }));
  await waitFor(() => expect(flow.retry).toHaveBeenCalledTimes(1));
  await screen.findByRole('alert');
  expect(flow.complete).toHaveBeenCalledTimes(1);
  expect(flow.login).toHaveBeenCalledTimes(1);
  expect(flow.bootstrap).not.toHaveBeenCalled();
});
