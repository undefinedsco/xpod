// @vitest-environment jsdom
//
// The consent page renders the shared Pod sign-in views. Requests and state
// stay the page's own; this file locks what the user sees.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { storageBindingKey } from '../auth/xpod-storage-selection';
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

function stubConsent(entries: unknown[], client: Record<string, unknown> = { client_id: 'https://app.example/id', client_name: 'Northstar', client_uri: 'https://app.example/' }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === '/.account/oidc/consent/') return new Response(JSON.stringify({ client }), { status: 200 });
    if (path === '/.account/oidc/pick-webid/') return new Response(JSON.stringify({ entries }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage(overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={['/.account/oidc/consent/']}><ConsentPage /></MemoryRouter>
    </AuthContext.Provider>,
  );
}

const cloud = { webId: 'https://pod.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/', label: 'Alice' };
const edge = { webId: 'http://127.0.0.1:3000/alice/profile/card#me', storageUrl: 'http://127.0.0.1:3000/alice/', label: 'Alice Home' };

describe('ConsentPage presentation', () => {
  it('renders the authorization as the shared consent view: service bar, app title and host, one level-1 heading', async () => {
    stubConsent([cloud]);
    renderPage();
    await screen.findByRole('button', { name: '允许' });

    expect(screen.getByText(/Xpod · 账号服务/)).toBeTruthy();
    // The browser page frame's account-service introduction carries an h2; the
    // view itself keeps the single level-1 heading.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByTestId('web-account-introduction')).toBeTruthy();
    const authorizeHeading = screen.getByRole('heading', { level: 1, name: '授权 Northstar' });
    // §3/§5 title spec: the consent heading carries the shared sign-in/register
    // class contract — `text-[17px]` at weight 600, not the default `text-xl`.
    // The utility class is the source-level guard only; the rendered size is the
    // shared `.pod-sign-in h1` contract (22px/600), asserted from computed styles in
    // tests/e2e/account-web-layout.spec.ts. Do not read this assertion as the
    // computed font size.
    expect(authorizeHeading.className).toContain('text-[17px]');
    expect(authorizeHeading.className).toContain('font-semibold');
    expect(screen.getByText('app.example')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('未能验证这个应用的来源');
    // One WebID: a single row, no choice, and the location is only a badge.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    // The packaged acceptance driver proves the exact binding from this
    // rendered shape: a single binding must expose no chooser at all.
    expect(document.getElementById('oidc-consent-webid')).toBeNull();
    expect(document.getElementById('oidc-consent-storage')).toBeNull();
    expect(screen.getByRole('img', { name: '数据存在 Xpod 云端' })).toBeTruthy();
    expect(screen.queryByText('Personal Messages Platform')).toBeNull();
  });

  it('offers a radio group for several WebIDs and keeps the native select id automation drives', async () => {
    stubConsent([cloud, edge]);
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: '用哪个 WebID 登录？' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(within(group).getByRole('img', { name: '数据存在边缘设备上' })).toBeTruthy();

    const select = document.getElementById('oidc-consent-webid') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((option) => option.value)).toContain(storageBindingKey(edge));

    // Allow stays disabled until a WebID is chosen, then enables.
    expect((screen.getByRole('button', { name: '允许' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(group).getByRole('radio', { name: /Alice Home/ }));
    await waitFor(() => expect((screen.getByRole('button', { name: '允许' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows a missing Pod as the no-WebID view: create and continue, account page, deny', async () => {
    const fetchMock = stubConsent([]);
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '还没有 WebID' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByTestId('web-account-introduction')).toBeTruthy();
    expect(screen.getByText(/Xpod · 账号服务/)).toBeTruthy();
    // The no-Pod consent view keeps no name field: naming happens only after the
    // user moves into the scoped lightweight create page.
    expect(screen.queryByLabelText('WebID 名称')).toBeNull();
    expect(screen.getByRole('button', { name: '创建并继续' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '存到边缘设备（打开账号页）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
    // Nothing is created until the user asks.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('names an application without client_name by its host, then by its client_id host, then generically', async () => {
    stubConsent([cloud], { client_id: 'https://id.example/client', client_uri: 'https://app.example/' });
    const first = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '授权 app.example' })).toBeTruthy();
    first.unmount();

    stubConsent([cloud], { client_id: 'https://id.example/client' });
    const second = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '授权 id.example' })).toBeTruthy();
    second.unmount();

    stubConsent([cloud], { client_id: 'opaque-client' });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '授权 这个应用' })).toBeTruthy();
    expect(screen.getByText(/这个应用 将以这个身份读写你的数据/)).toBeTruthy();
  });

  it('describes each identity by its short name, keeping the full WebID inside the request details only', async () => {
    const local = {
      webId: 'http://localhost:39991/acceptml1/profile/card#me',
      storageUrl: 'http://localhost:39991/acceptml1/',
    };
    stubConsent([local]);
    renderPage();
    await screen.findByRole('button', { name: '允许' });
    const row = document.querySelector('[data-pod-sign-in="webid-row"]') as HTMLElement;
    expect(row.textContent).toContain('acceptml1');
    expect(row.textContent).not.toContain('localhost');
    const details = screen.getByText('请求详情').closest('details')!;
    expect(within(details).getByText(local.webId)).toBeTruthy();
  });

  it('checks the WebID name in WebID wording and offers no Pod-management shortcut', async () => {
    stubConsent([]);
    renderPage({ controls: { account: { username: 'alice', pod: '/.account/account/pod/' } } });
    await screen.findByRole('heading', { level: 1, name: '还没有 WebID' });
    expect(screen.queryByText(/也可以在这里直接创建/)).toBeNull();
    expect(screen.queryByRole('button', { name: '前往 Pod 管理' })).toBeNull();
    expect(screen.queryByText(/Pod 名称可用/)).toBeNull();
  });

  // §4 / §11.1 / §13.11: a native host authentication surface fills the
  // host-selected 440x620 window; only a browser document is the two-column page.
  it('fills the native host window instead of the browser document page', async () => {
    const setWindowMode = vi.fn();
    vi.stubGlobal('xpodDesktop', { setWindowMode });
    stubConsent([cloud]);
    renderPage();
    await screen.findByRole('button', { name: '允许' });

    const panel = screen.getByTestId('web-account-panel');
    expect(panel.getAttribute('data-web-account-layout')).toBe('window');
    expect(panel.getAttribute('data-web-account-host')).toBe('window');
    expect(document.querySelector('[data-pod-sign-in-frame="window"]')).not.toBeNull();
    expect(document.querySelector('[data-pod-sign-in-frame="page"]')).toBeNull();
    // The page frame's introduction column is a browser-document surface only.
    expect(screen.queryByTestId('web-account-introduction')).toBeNull();
    expect(setWindowMode).toHaveBeenLastCalledWith('account');
  });

  it('keeps the missing-Pod branch in the same native host window', async () => {
    const setWindowMode = vi.fn();
    vi.stubGlobal('xpodDesktop', { setWindowMode });
    stubConsent([]);
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '还没有 WebID' })).toBeTruthy();

    expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('window');
    expect(document.querySelector('[data-pod-sign-in-frame="window"]')).not.toBeNull();
    expect(screen.queryByTestId('web-account-introduction')).toBeNull();
    expect(setWindowMode).toHaveBeenLastCalledWith('account');
  });
});
