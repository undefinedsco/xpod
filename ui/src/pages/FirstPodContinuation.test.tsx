// @vitest-environment jsdom
//
// Consent 专用轻量快速创建页（`/.account/create-pod/`，scoped）的新契约：
//   * 单纯访问 / 刷新**不创建**任何资源；
//   * 已有可用绑定时直接回到同一个 interaction 的授权页，不新建替代 Pod；
//   * 次级入口“使用自己的部署”只导航到重管理页，保留一次性续接上下文，
//     在离开时**不** prepare/POST。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { createFirstPodAndWaitForBinding } from '../utils/consent-first-pod';
import { saveConsentContinuation } from '../utils/safe-continuation';
import { FirstPodPage } from './FirstPodPage';

vi.mock('../utils/consent-first-pod', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/consent-first-pod')>(),
  createFirstPodAndWaitForBinding: vi.fn(),
}));

const INTERACTION = '/.account/interaction/flow-nine';
const CREATE_PATH = `${INTERACTION}/create-pod/`;
const CONSENT_RETURN = `${INTERACTION}/oidc/consent/`;

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

/** jsdom's location is read-only; swap in a facade the page can navigate. */
function installLocation(pathname: string) {
  const browserWindow = window;
  const navigation = {
    href: `${browserWindow.location.origin}${pathname}`,
    origin: browserWindow.location.origin,
    pathname,
    assign: vi.fn(),
  };
  const facade = Object.create(browserWindow);
  Object.defineProperty(facade, 'location', { value: navigation });
  vi.stubGlobal('window', facade);
  return navigation;
}

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

function renderLight(overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={[CREATE_PATH]}>
        <LocationProbe />
        <FirstPodPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function anyPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
}

function seedContinuation() {
  expect(saveConsentContinuation({
    accountId: 'alice',
    interaction: INTERACTION,
    returnTo: CONSENT_RETURN,
  })).toBe(true);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('FirstPodPage light quick-create', () => {
  it('a bare GET with no continuation creates nothing and shows the expired-task exit', async () => {
    installLocation(CREATE_PATH);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    renderLight({ controls: { account: { id: 'alice' } } });

    await screen.findByText('创建任务已失效');
    expect(anyPosts(fetchMock)).toEqual([]);
    expect(createFirstPodAndWaitForBinding).not.toHaveBeenCalled();
  });

  it('returns to the same interaction without creating when a usable binding already exists', async () => {
    installLocation(CREATE_PATH);
    seedContinuation();
    const webId = `${window.location.origin}/alice/profile/card#me`;
    const storageUrl = `${window.location.origin}/alice/`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), window.location.origin).pathname.endsWith('/bindings/')) {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderLight({
      controls: { account: { id: 'alice', bindings: '/.account/account/alice/bindings/' } },
    });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(CONSENT_RETURN));
    expect(createFirstPodAndWaitForBinding).not.toHaveBeenCalled();
    expect(anyPosts(fetchMock)).toEqual([]);
    // 一次性任务已被消费，刷新不会再回到旧授权。
    expect(window.sessionStorage.getItem('xpod.safe-continuation.consent.v2')).toBeNull();
  });

  it('“使用自己的部署” navigates to the heavy page, never creates, and keeps the continuation', async () => {
    const navigation = installLocation(CREATE_PATH);
    seedContinuation();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    renderLight({ controls: { account: { id: 'alice' } } });

    fireEvent.click(await screen.findByRole('button', { name: '使用自己的部署' }));

    expect(navigation.assign).toHaveBeenCalledWith('/settings/pod');
    expect(anyPosts(fetchMock)).toEqual([]);
    expect(createFirstPodAndWaitForBinding).not.toHaveBeenCalled();
    // 离开时保留上下文，重管理页才能显示“回到授权”并可回到同一原事务。
    const record = JSON.parse(window.sessionStorage.getItem('xpod.safe-continuation.consent.v2') ?? 'null');
    expect(record?.interaction).toBe(INTERACTION);
    expect(record?.returnTo).toBe(CONSENT_RETURN);
  });

  it('cancels the original interaction UID and clears the one-time task', async () => {
    const navigation = installLocation(CREATE_PATH);
    seedContinuation();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (init?.method === 'POST') {
        expect(path).toBe(`${INTERACTION}/oidc/cancel`);
        return new Response(JSON.stringify({ location: `${INTERACTION}/` }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ bindings: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderLight({ controls: { account: { id: 'alice', bindings: '/.account/account/alice/bindings/' } } });

    fireEvent.click(await screen.findByRole('button', { name: '取消授权' }));

    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(`${INTERACTION}/`));
    expect(window.sessionStorage.getItem('xpod.safe-continuation.consent.v2')).toBeNull();
    expect(createFirstPodAndWaitForBinding).not.toHaveBeenCalled();
  });

  it('stays on the page with localised copy when cancelling fails', async () => {
    const navigation = installLocation(CREATE_PATH);
    seedContinuation();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'Invalid OIDC interaction' }), {
          status: 500, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ bindings: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderLight({ controls: { account: { id: 'alice', bindings: '/.account/account/alice/bindings/' } } });

    fireEvent.click(await screen.findByRole('button', { name: '取消授权' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('取消授权失败，请重试或直接关闭此页面。'));
    expect(navigation.assign).not.toHaveBeenCalled();
    // 失败不清理任务：用户原地重试或返回同一授权。
    expect(window.sessionStorage.getItem('xpod.safe-continuation.consent.v2')).not.toBeNull();
    expect(createFirstPodAndWaitForBinding).not.toHaveBeenCalled();
  });
});
