// @vitest-environment jsdom
//
// 回归（设计第二部分 §4.1 / U06 的显式例外）：授权页缺 Pod 时**不自动**创建。
//
// 目标契约：
//   授权页只读绑定、选择、批准/拒绝；没有可用 Pod 时说明原因，并给出
//   "创建并继续 / 前往 Pod 管理 / 拒绝"三个出口。
//   创建只在用户显式点击主操作后发生，且必须复用全仓唯一的受守卫创建事务
//   （createFirstPodAndWaitForBinding），成功后重新读取权威绑定并回到同一个
//   interaction 继续授权。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { xpodConsentErrors, xpodRegistrationCopy } from '../auth/xpod-account-copy';
import { createXpodLoginRoute } from '../auth/xpod-login-route';
import { createXpodLoginTransactionStore } from '../auth/xpod-login-transaction';
import { FIRST_POD_BINDING_MISSING } from '../utils/consent-first-pod';
import { ConsentPage } from './ConsentPage';

const consentUrl = '/.account/oidc/consent/';
const pickUrl = '/.account/oidc/pick-webid/';
const podControlUrl = '/.account/account/pod/';

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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function renderConsent(overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={['/.account/oidc/consent/']}>
        <ConsentPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function posts(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === path && init?.method === 'POST');
}

function anyPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '创建并继续' }) as HTMLButtonElement;
}

function makeProvisionCode(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
  return `${encoded}.signature`;
}

it('无绑定加载完成后不自动创建，只提供创建、管理与拒绝三个出口', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') {
      // 加载阶段任何写操作都必须记录在案：本条回归的核心就是"不得发生"。
      return json({ location: '/should-not-happen' });
    }
    if (path === consentUrl) return json({ client: { client_id: 'client', client_name: 'Client' } });
    if (path === pickUrl) return json({ entries: [] });
    // 权威清单为空 —— 这正是守卫允许"新账号 bootstrap 建 Pod"的放行条件。
    // 必须给成功且空的清单，否则创建会被 inventory 失败挡在前面，测试就会因为
    // 错误的原因通过。
    if (path === podControlUrl) return json({ pods: {} });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  renderConsent({ controls: { account: { username: 'alice', pod: podControlUrl } } });

  // 页面读到绑定后停在显式创建入口，而不是发起任何自动写操作。
  await screen.findByRole('button', { name: '创建并继续' });
  // 给名称可用性检查（防抖 + 异步结论）稳定下来的时间，再断言没有写操作。
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(anyPosts(fetchMock)).toEqual([]);
  expect(screen.getByRole('button', { name: '前往 Pod 管理' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '拒绝', exact: true })).toBeTruthy();
  // 名称来自当前身份的可见候选，但始终显示在输入框里由用户确认后再创建。
  expect((screen.getByLabelText('WebID 名称') as HTMLInputElement).value).toBe('alice');
});

it('点击创建后只发一次受守卫的创建请求，拿到绑定后回到同一 interaction 继续授权', async () => {
  // 原 interaction 的返回目标必须在整条创建链路里保持不丢、不被消费。
  // 挂起事务是本机作用域（xpod.auth.transaction），因此绑定也取当前 Xpod 源。
  const localBinding = {
    webId: `${window.location.origin}/alice/profile/card#me`,
    storageUrl: `${window.location.origin}/alice/`,
  };
  const returnTo = '/ai-connections/?provider=original&view=keys';
  const transactionStore = createXpodLoginTransactionStore({
    storage: window.sessionStorage,
    origin: window.location.origin,
  });
  transactionStore.begin({
    id: 'consent-first-pod-transaction',
    route: createXpodLoginRoute(window.location),
    authorizationSurface: 'redirect',
    discovery: 'strict',
    returnTo,
  });

  let created = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (path === podControlUrl && init?.method === 'POST') {
      created = true;
      return json({ webId: localBinding.webId, podUrl: localBinding.storageUrl }, 201);
    }
    if (init?.method === 'POST') {
      throw new Error(`Unexpected mutation: ${path}`);
    }
    if (path === consentUrl) return json({ client: { client_id: 'client', client_name: 'Client' } });
    if (path === pickUrl) return json({ entries: created ? [localBinding] : [] });
    if (path === podControlUrl) return json({ pods: {} });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  renderConsent({ controls: { account: { username: 'alice', pod: podControlUrl } } });

  const pickReadsBefore = fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === pickUrl && !init?.method).length;
  fireEvent.click(await screen.findByRole('button', { name: '创建并继续' }));

  // 创建成功后重新读取权威绑定，并回到同一 interaction 的批准表单。
  await waitFor(() => expect(screen.getByRole('button', { name: '允许', exact: true })).toBeTruthy());
  expect(posts(fetchMock, podControlUrl)).toHaveLength(1);
  expect(JSON.parse(String(posts(fetchMock, podControlUrl)[0][1]?.body))).toEqual({ name: 'alice' });
  const pickReadsAfter = fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === pickUrl && !init?.method).length;
  expect(pickReadsAfter).toBeGreaterThan(pickReadsBefore);
  // 创建不等于代替用户授权：批准请求仍只能由用户点击产生。
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
  // 同一个 interaction 仍然有效：事务记录与 returnTo 都没被消费。
  expect(transactionStore.readSinglePending()?.returnTo).toBe(returnTo);
});

it('创建失败时显示可重试的本地化错误，且不锁死页面', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (path === podControlUrl && init?.method === 'POST') {
      return json({ message: 'Internal Server Error' }, 500);
    }
    if (init?.method === 'POST') return json({}, 404);
    if (path === consentUrl) return json({ client: { client_id: 'client', client_name: 'Client' } });
    if (path === pickUrl) return json({ entries: [] });
    if (path === podControlUrl) return json({ pods: {} });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  renderConsent({ controls: { account: { username: 'alice', pod: podControlUrl } } });
  fireEvent.click(await screen.findByRole('button', { name: '创建并继续' }));

  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.storageCreateFailed));
  // 不泄漏服务端的英文原始错误。
  expect(screen.queryByText(/Internal Server Error/u)).toBeNull();
  // 重试与离开都还在：重试会再次发起同一条受守卫的创建请求。
  expect(createButton().disabled).toBe(false);
  expect(screen.getByRole('button', { name: '前往 Pod 管理' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '拒绝', exact: true })).toBeTruthy();
  expect(posts(fetchMock, podControlUrl)).toHaveLength(1);

  fireEvent.click(createButton());
  await waitFor(() => expect(posts(fetchMock, podControlUrl)).toHaveLength(2));
});

it('账号清单里已有 Pod 时，点击创建不会新建替代品，而是交回绑定重读出口', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') throw new Error(`Unexpected mutation: ${path}`);
    if (path === consentUrl) return json({ client: { client_id: 'client', client_name: 'Client' } });
    if (path === pickUrl) return json({ entries: [] });
    // 账号权威清单里已有 Pod，但该 WebID 没有可用绑定。
    if (path === podControlUrl) return json({ pods: { 'https://storage.example/old-name/': '/.account/pod/id' } });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  renderConsent({ controls: { account: { username: 'another-name', pod: podControlUrl } } });
  fireEvent.click(await screen.findByRole('button', { name: '创建并继续' }));

  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(FIRST_POD_BINDING_MISSING));
  expect(anyPosts(fetchMock)).toEqual([]);
  // 交回权威绑定重读出口：重试读取、换一个账号与 Pod 管理都可达。
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '换一个账号' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '前往 Pod 管理' })).toBeTruthy();
});

it('按 checkFirstPodNameAvailability 的结论给出本地化名称提示并阻止已占用名称', async () => {
  window.sessionStorage.setItem('provisionCode', makeProvisionCode({
    spUrl: 'https://node.example/',
    serviceToken: 'test-token',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') throw new Error(`Unexpected mutation: ${path}`);
    if (path === consentUrl) return json({ client: { client_id: 'client', client_name: 'Client' } });
    if (path === pickUrl) return json({ entries: [] });
    if (path === '/provision/pods/alice') {
      return json({ message: `Pod name "alice" is already used on this storage.` }, 409);
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  renderConsent({ controls: { account: { username: 'alice', pod: podControlUrl } } });

  await waitFor(() => expect(screen.getByText(xpodRegistrationCopy.podNameTaken)).toBeTruthy());
  expect(createButton().disabled).toBe(true);
  expect(anyPosts(fetchMock)).toEqual([]);
});
