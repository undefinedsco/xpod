// @vitest-environment jsdom
//
// 锁定回归（设计 §8 第 1 步）：授权流程不再自动创建 Pod。
//
// 目标契约（第二部分 §4.1 / U06 / U11）：
//   授权页只读绑定、选择、批准/拒绝；没有可用 Pod 时必须给出
//   "前往 Pod 管理"与"取消授权"，**不得**替用户提交创建请求。
//
// 当前实现下**预期失败**：`shouldAutoProvisionStorage` 会在无绑定且账号有 pod control
// 时自动走创建流程。
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { ConsentPage } from './ConsentPage';

function reset(): void {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.xpodDesktop = undefined;
}

beforeEach(reset);
afterEach(reset);

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn: true,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: { status: 'authenticated' },
    ...overrides,
  };
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).pathname;
}

it('授权时没有可用 Pod 不会自动创建，只提供管理与取消', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') {
      // 任何写操作都记录在案：本条回归的核心就是"不得发生"。
      return new Response(JSON.stringify({ location: '/should-not-happen' }), { status: 200 });
    }
    if (path === '/.account/oidc/consent/') {
      return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
    }
    if (path === '/.account/oidc/pick-webid/') {
      // 账号已登录但没有任何 storage 绑定。
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }
    if (path === '/.account/account/pod/') {
      // 权威清单为空 —— 这正是当前实现允许"新账号 bootstrap 建 Pod"的放行条件。
      // 必须给成功且空的清单，否则自动创建会被 inventory 失败挡在前面，
      // 测试就会因为错误的原因通过。
      return new Response(JSON.stringify({ pods: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  render(
    <AuthContext.Provider value={authValue({
      // 账号有 pod control 与 username —— 正是当前触发自动创建的条件。
      controls: { account: { username: 'alice', pod: '/.account/account/pod/' } },
    })}>
      <MemoryRouter initialEntries={['/.account/oidc/consent/']}>
        <ConsentPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  // 先等页面确实读到了绑定（这一步 GET 一定会发），再给自动创建 effect 足够的
  // 时间发起请求或稳定下来，然后断言"没有发生任何写操作"。
  await waitFor(() => expect(
    fetchMock.mock.calls.some(([input]) => requestPath(input) === '/.account/oidc/pick-webid/'),
  ).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([input]) => requestPath(input))).toEqual([]);
});
