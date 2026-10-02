// @vitest-environment jsdom
//
// 授权页"缺 Pod"入口的回归（设计第二部分 §4.1 / U06，2026-10-01 新流程）。
//
// 目标契约：
//   * 缺 Pod 的授权页本身只读：没有可用绑定时说明原因，给出"创建 Pod /
//     管理 Pod/ 拒绝"三个出口，加载时不发生任何写操作；
//   * 主操作不再在 Consent 内放名字表单、也不直接 POST，而是把"真实 Account id +
//     精确 UID + 同源原 ConsentURL + TTL"的一次性任务交给同 UID 的轻量快速创建页
//     （`/.account/interaction/{UID}/create-pod/`）；
//   * 任务安全绑定真实 Account id（不是服务地址 / WebID / username）；缺任一权威
//     输入（无 Account id、无 interaction 作用域）都失败退出：不保存可用任务、
//     也绝不跳进有效创建；
//   * 读取失败（500 / malformed）保持失败出口，不能因为读失败而误 create；
//   * 自己部署相关出口打开同 UID 的 Account Pod 管理页，保留安全续接上下文。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { xpodConsentErrors, xpodFirstPodErrors } from '../auth/xpod-account-copy';
import { peekConsentContinuation } from '../utils/safe-continuation';
import { ConsentPage } from './ConsentPage';

const UID = 'lead-consent-7f3a';
const INTERACTION = `/.account/interaction/${UID}`;
const CONSENT_PATH = `${INTERACTION}/oidc/consent/`;
const PICK_PATH = `${INTERACTION}/oidc/pick-webid/`;
const CREATE_PATH = `${INTERACTION}/create-pod/`;
const MANAGEMENT_PATH = `${INTERACTION}/manage-pod/`;
const ACCOUNT_ID = 'alice';
const CONTINUATION_KEY = 'xpod.safe-continuation.consent.v2';

/** 真实 Account 权威控制：每个路由都从会话自身的 opaque Account id 构建。 */
const ACCOUNT_CONTROLS = {
  account: {
    id: ACCOUNT_ID,
    username: 'alice',
    logout: `/.account/account/${ACCOUNT_ID}/logout/`,
    pod: `/.account/account/${ACCOUNT_ID}/pod/`,
    bindings: `/.account/account/${ACCOUNT_ID}/bindings/`,
  },
};

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

/** jsdom 的 location 只读；换成可导航的 facade，页面才能读到真实作用域。 */
function installLocation(pathname: string) {
  const browserWindow = window;
  const navigation = {
    href: `${browserWindow.location.origin}${pathname}`,
    origin: browserWindow.location.origin,
    pathname,
    search: '',
    assign: vi.fn(),
  };
  const facade = Object.create(browserWindow);
  Object.defineProperty(facade, 'location', { value: navigation });
  vi.stubGlobal('window', facade);
  return navigation;
}

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

function renderConsent(overrides: Partial<AuthContextType> = {}, entries: string[] = [CONSENT_PATH]) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={entries}>
        <LocationProbe />
        <ConsentPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).pathname;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function anyPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

/** 缺 Pod 的最小权威读取：consent 有 client，pick-webid 空绑定，其余 404。 */
function noPodFetch(overrides: {
  consent?: () => Response;
  pick?: () => Response;
  consentPath?: string;
  pickPath?: string;
} = {}) {
  const consentPath = overrides.consentPath ?? CONSENT_PATH;
  const pickPath = overrides.pickPath ?? PICK_PATH;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') return json({}, 500);
    if (path === consentPath) {
      return overrides.consent?.() ?? json({ client: { client_id: 'client', client_name: 'Client' } });
    }
    if (path === pickPath) return overrides.pick?.() ?? json({ entries: [] });
    return json({}, 404);
  });
}

describe('ConsentPage no-Pod entry', () => {
  it('缺 Pod 加载后停在显式出口，不自动创建、不自动批准、不写任务', async () => {
    installLocation(CONSENT_PATH);
    const fetchMock = noPodFetch();
    vi.stubGlobal('fetch', fetchMock);

    renderConsent({ controls: ACCOUNT_CONTROLS, identity: { id: ACCOUNT_ID } });

    await screen.findByRole('button', { name: '创建 Pod' });
    // 给防抖/异步结论稳定下来的时间，再断言加载阶段没有任何写操作。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(anyPosts(fetchMock)).toEqual([]);
    // 三个显式出口：创建 Pod / 管理 Pod/ 拒绝。
    expect(screen.getByRole('button', { name: '管理 Pod' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝', exact: true })).toBeTruthy();
    // 没有被自动带走，也没有提前写出一次性任务。
    expect(screen.getByTestId('location').textContent).toBe(CONSENT_PATH);
    expect(window.sessionStorage.getItem(CONTINUATION_KEY)).toBeNull();
    // Consent 内不再重复名字表单。
    expect(screen.queryByLabelText('WebID 名称')).toBeNull();
  });

  it('点击创建只把一次性任务交给同 UID 轻量创建页，无 prepare/POST，也不重复名字字段', async () => {
    const navigation = installLocation(CONSENT_PATH);
    const fetchMock = noPodFetch();
    vi.stubGlobal('fetch', fetchMock);

    renderConsent({ controls: ACCOUNT_CONTROLS, identity: { id: ACCOUNT_ID } });

    expect(screen.queryByLabelText('WebID 名称')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '创建 Pod' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(CREATE_PATH));
    // 任务绑定真实 Account id + 精确 UID + 同源原 ConsentURL。
    const record = peekConsentContinuation({ accountId: ACCOUNT_ID });
    expect(record?.kind).toBe('consent');
    expect(record?.interaction).toBe(INTERACTION);
    expect(record?.returnTo).toBe(CONSENT_PATH);
    // 只导航：没有 prepare、没有 POST，也没有越过用户的自动批准。
    expect(anyPosts(fetchMock)).toEqual([]);
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it('"管理 Pod"打开同 UID 管理页并保留续接任务，不创建资源', async () => {
    const navigation = installLocation(CONSENT_PATH);
    const fetchMock = noPodFetch();
    vi.stubGlobal('fetch', fetchMock);

    renderConsent({ controls: ACCOUNT_CONTROLS, identity: { id: ACCOUNT_ID } });

    fireEvent.click(await screen.findByRole('button', { name: '管理 Pod' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(MANAGEMENT_PATH));
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(anyPosts(fetchMock)).toEqual([]);
    expect(peekConsentContinuation({ accountId: ACCOUNT_ID })?.interaction).toBe(INTERACTION);
  });

  it('读不到权威 Account id 时不保存任务、也不跳进有效创建，只给失败出口', async () => {
    installLocation(CONSENT_PATH);
    const fetchMock = noPodFetch();
    vi.stubGlobal('fetch', fetchMock);

    // 只有可见用户名，没有任何从真实 Account 路由推导出的权威 id。
    renderConsent({ controls: { account: { username: 'alice' } } });

    fireEvent.click(await screen.findByRole('button', { name: '创建 Pod' }));

    expect(await screen.findByText(xpodFirstPodErrors.accountIdentityMissing)).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(CONSENT_PATH);
    expect(window.sessionStorage.getItem(CONTINUATION_KEY)).toBeNull();
    expect(anyPosts(fetchMock)).toEqual([]);
  });

  it('页面不在 interaction 作用域内时不保存任务、不跳进有效创建', async () => {
    const unscoped = '/.account/oidc/consent/';
    installLocation(unscoped);
    const fetchMock = noPodFetch({
      consentPath: unscoped,
      pickPath: '/.account/oidc/pick-webid/',
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConsent({ controls: ACCOUNT_CONTROLS, identity: { id: ACCOUNT_ID } }, [unscoped]);

    fireEvent.click(await screen.findByRole('button', { name: '创建 Pod' }));

    expect(await screen.findByText(xpodFirstPodErrors.accountIdentityMissing)).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(unscoped);
    expect(window.sessionStorage.getItem(CONTINUATION_KEY)).toBeNull();
    expect(anyPosts(fetchMock)).toEqual([]);
  });

  const readFailures: Array<[string, () => Response]> = [
    ['pick-webid 读取返回 500', () => json({ message: 'boom' }, 500)],
    ['pick-webid 返回 malformed entries', () => json({ entries: 'not-an-array' })],
  ];
  it.each(readFailures)('%s 时保持失败出口，不误 create', async (_label, respond) => {
    installLocation(CONSENT_PATH);
    const fetchMock = noPodFetch({ pick: respond });
    vi.stubGlobal('fetch', fetchMock);

    renderConsent({ controls: ACCOUNT_CONTROLS, identity: { id: ACCOUNT_ID } });

    await screen.findByText(xpodConsentErrors.bindingsFailed);
    // 读取失败不能伪造出创建入口，也不能写出可用任务。
    expect(screen.queryByRole('button', { name: '创建 Pod' })).toBeNull();
    expect(window.sessionStorage.getItem(CONTINUATION_KEY)).toBeNull();
    expect(anyPosts(fetchMock)).toEqual([]);
  });
});
