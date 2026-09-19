// @vitest-environment jsdom
//
// 锁定回归（设计 §8 第 1 步）：账号创建与 Pod 创建解耦。
//
// 目标契约（第二部分 §4.1 / U01 / U02 / U03）：
//   - 注册只创建 Account，不隐式创建 Pod，不做 Local prepare；
//   - 登录成功不依赖 Pod 就绪；
//   - 已登录但无 Pod 的用户落到 Account 管理，而不是 create-pod。
//
// 这些断言在当前实现下**预期失败**：先补失败回归，再按 §8 第 2 步拆分创建入口。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: { password: { login: '/.account/login/password/' } },
    idpIndex: '/.account/',
    isLoggedIn: false,
    authenticating: false,
    hasOidcPending: false,
    isInitializing: false,
    initError: null,
    accountState: { status: 'anonymous', mode: 'register' },
    refetchControls: vi.fn(),
    retry: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

function LocationProbe() {
  return <output data-testid="route">{useLocation().pathname}</output>;
}

it('注册成功后不再自动创建 Pod，也不进入存储确认状态', async () => {
  // 复现既有账户恢复分支：拿到 Account token 后当前实现会直接进入建 Pod 流程。
  flow.login.mockResolvedValue({ accountToken: 'fixture-account-token' });

  render(
    <AuthContext.Provider value={authValue()}>
      <MemoryRouter initialEntries={['/.account/']}>
        <Routes>
          <Route path="/.account/" element={<WelcomePage initialIsRegister />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  fireEvent.change(screen.getByLabelText('Pod 名称'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'fixture-password' } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'fixture-password' } });
  fireEvent.click(screen.getByRole('button', { name: '创建账号', exact: true }));

  await waitFor(() => expect(flow.login).toHaveBeenCalledTimes(1));

  // 注册不得触发 provisioning（prepare / 创建 / 就绪重试都不得发生）。
  expect(flow.complete).not.toHaveBeenCalled();
  expect(flow.retry).not.toHaveBeenCalled();

  // 也不得进入"正在确认存储空间"这一建 Pod 专属状态。
  expect(screen.queryByRole('heading', { name: '正在确认存储空间' })).toBeNull();
});

it('已登录但无 Pod 的用户落到 Account 管理，不再被转到 create-pod', async () => {
  render(
    <AuthContext.Provider value={authValue({ isLoggedIn: true, accountState: { status: 'authenticated' } })}>
      <MemoryRouter initialEntries={['/.account/']}>
        <Routes>
          <Route path="/.account/" element={<WelcomePage initialIsRegister />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/.account/account/'));
});
