// @vitest-environment jsdom
//
// 锁定回归（设计第二部分 §4.1 / U08+U09）：Pod 管理页是显式创建的唯一入口。
//   - 零 Pod 时必须能进入并看到空状态与创建入口；
//   - 创建必须走**被守卫的**唯一事务（createFirstPodAndWaitForBinding），
//     不得重新引入第二套 prepare+POST。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { AuthContext, type AuthContextType } from '../../context/AuthContextValue';
import { PodSettingsSubjectPanel } from './SystemSettingsSubjectPanel';

const admin = vi.hoisted(() => ({
  getAdminStatus: vi.fn(async () => ({ env: { CSS_BASE_URL: 'https://example.test/' } })),
  getAdminConfig: vi.fn(async () => ({ env: {}, secrets: {} })),
  getProvisionStatus: vi.fn(async () => ({})),
  getDdnsStatus: vi.fn(async () => ({})),
  getPublicIpCheck: vi.fn(async () => null),
  resolveAdminAccessBaseUrl: vi.fn(() => 'https://example.test/'),
}));
vi.mock('../../api/admin', () => ({
  ...admin,
  updateAdminConfig: vi.fn(async () => true),
  triggerRestart: vi.fn(async () => undefined),
}));

const runtime = vi.hoisted(() => ({
  webId: undefined as string | undefined,
  podUrl: undefined as string | undefined,
  issuer: undefined as string | undefined,
  state: { status: 'anonymous' } as { status: string },
}));
vi.mock('../../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => runtime }));

const bindings = vi.hoisted(() => ({ fetch: vi.fn(async (): Promise<StorageBinding[]> => []) }));
vi.mock('../../auth/account-storage-bindings', () => ({ fetchAccountStorageBindings: bindings.fetch }));

const flow = vi.hoisted(() => ({ create: vi.fn(async (): Promise<StorageBinding[]> => []) }));
vi.mock('../../utils/consent-first-pod', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/consent-first-pod')>(),
  createFirstPodAndWaitForBinding: flow.create,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  bindings.fetch.mockResolvedValue([]);
  runtime.webId = undefined;
  runtime.podUrl = undefined;
  runtime.state = { status: 'anonymous' };
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: { account: { username: 'alice', pod: '/.account/account/pod/', bindings: '/.account/account/bindings' } },
    idpIndex: '/.account/',
    isLoggedIn: true,
    authenticating: false,
    hasOidcPending: false,
    isInitializing: false,
    initError: null,
    accountState: { status: 'authenticated' },
    refetchControls: vi.fn(),
    retry: vi.fn(),
    logout: vi.fn(),
    bindAccountCapability: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <PodSettingsSubjectPanel kind="pod" />
    </AuthContext.Provider>,
  );
}

it('shows the empty state and an explicit create entry when the account has no Pod', async () => {
  renderPanel();
  expect(await screen.findByText('这个账号还没有任何存储空间。创建后即可用它授权应用访问。')).toBeTruthy();
  expect(screen.getByLabelText('创建存储空间')).toBeTruthy();
  // 只是进入页面不得发起创建。
  expect(flow.create).not.toHaveBeenCalled();
});

it('creates through the guarded transaction only on explicit submit', async () => {
  renderPanel();
  const input = await screen.findByLabelText('创建存储空间');
  fireEvent.change(input, { target: { value: 'alice' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));

  await waitFor(() => expect(flow.create).toHaveBeenCalledTimes(1));
  expect(flow.create).toHaveBeenCalledWith(expect.objectContaining({
    createPodUrl: '/.account/account/pod/',
    username: 'alice',
  }));
  expect(await screen.findByText('存储空间已创建。')).toBeTruthy();
});

it('lists the account storage bindings instead of guessing a single Pod', async () => {
  bindings.fetch.mockResolvedValue([
    { webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://node.example/alice/' },
    { webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://other.example/alice/' },
  ]);
  renderPanel();
  expect(await screen.findByText('https://node.example/alice/')).toBeTruthy();
  expect(screen.getByText('https://other.example/alice/')).toBeTruthy();
  expect(screen.queryByText('这个账号还没有任何存储空间。创建后即可用它授权应用访问。')).toBeNull();
});

// 创建超时/失败的可锁定一半（设计第二部分 §4.2）：失败后**不自动重试**、不重复创建；
// 再次提交仍走同一个被守卫的事务，由权威清单决定是否放行。
// 另一半（"超时后先查询原任务再恢复结果"）需要服务端幂等任务 API，属 §12.3 的 S02/S03。
it('does not auto-retry or fork a second creation path after a failed attempt', async () => {
  flow.create.mockRejectedValueOnce(new Error('暂时无法确认已有 Pod，请重试读取或返回账号。'));
  renderPanel();
  const input = await screen.findByLabelText('创建存储空间');
  fireEvent.change(input, { target: { value: 'alice' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));

  await waitFor(() => expect(flow.create).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('alert')).toBeTruthy();

  // 失败后不得自行重试。
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(flow.create).toHaveBeenCalledTimes(1);

  // 再次显式提交仍复用同一个被守卫的事务（不是第二套创建路径）。
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() => expect(flow.create).toHaveBeenCalledTimes(2));
});
