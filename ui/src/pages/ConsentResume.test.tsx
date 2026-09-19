// @vitest-environment jsdom
import { xpodConsentErrors } from '../auth/xpod-account-copy';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { createXpodLoginTransactionStore } from '../auth/xpod-login-transaction';
import { createXpodLoginRoute } from '../auth/xpod-login-route';
import { ConsentPage } from './ConsentPage';
import { storageBindingKey } from '../auth/xpod-storage-selection';

const pickUrl = '/.account/oidc/pick-webid/';
const consentUrl = '/.account/oidc/consent/';
const binding = { webId: 'https://pod.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' };
const resumeLocation = '/oidc/auth/resume?uid=remembered-session';
const assign = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  assign.mockReset();
  window.xpodDesktop = undefined;
  const browserWindow = window;
  const facade = Object.create(browserWindow);
  Object.defineProperty(facade, 'location', { value: {
    get href() { return browserWindow.location.href; },
    get origin() { return browserWindow.location.origin; },
    assign,
  } });
  vi.stubGlobal('window', facade);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderConsent(overrides: Partial<AuthContextType> = {}) {
  const auth: AuthContextType = {
    controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/',
    isLoggedIn: true, authenticating: false, hasOidcPending: true,
    refetchControls: vi.fn(), retry: vi.fn(), logout: vi.fn(), accountState: { status: 'authenticated' },
    ...overrides,
  };
  return render(<StrictMode><AuthContext.Provider value={auth}>
    <MemoryRouter><ConsentPage /></MemoryRouter>
  </AuthContext.Provider></StrictMode>);
}

function mockPicker(data: Record<string, unknown>, submit = async () => json({ location: resumeLocation })) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === consentUrl && !init?.method) return json({ client: { client_id: 'desktop', client_name: 'Xpod Desktop' } });
    if (String(input) === pickUrl && !init?.method) return json(data);
    if (String(input) === pickUrl && init?.method === 'POST') return submit();
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function posts(fetchMock: ReturnType<typeof mockPicker>, url: string) {
  return fetchMock.mock.calls.filter(([input, init]) => String(input) === url && init?.method === 'POST');
}

describe('ConsentPage remembered identity recovery', () => {
  it('navigates the native resume after manual WebID selection without fetching its code callback', async () => {
    const fetchMock = mockPicker({ entries: [binding] });
    renderConsent();
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(resumeLocation));
    expect(posts(fetchMock, pickUrl)).toHaveLength(1);
    expect(posts(fetchMock, pickUrl)[0][1]).toMatchObject({ redirect: 'manual' });
    expect(posts(fetchMock, consentUrl)).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === resumeLocation)).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([undefined, '', '   ', 42])('rejects manual pick without a valid resume location: %s', async (location) => {
    const fetchMock = mockPicker({ entries: [binding] }, async () => json({ location }));
    renderConsent();
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.missingRedirect));
    expect(posts(fetchMock, pickUrl)).toHaveLength(1);
    expect(posts(fetchMock, consentUrl)).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it('submits consent for the current WebID without following HTTP redirects in fetch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === pickUrl) return json({ entries: [binding] });
      if (String(input) === consentUrl && !init?.method) return json({
        client: { client_id: 'desktop' }, webId: binding.webId,
      });
      if (String(input) === consentUrl && init?.method === 'POST') return json({ location: resumeLocation });
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetchMock);
    renderConsent();
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(resumeLocation));
    const consentPosts = fetchMock.mock.calls.filter(([input, init]) => String(input) === consentUrl && init?.method === 'POST');
    expect(consentPosts).toHaveLength(1);
    expect(consentPosts[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('picks the verified resume WebID once and navigates at top level without POST consent or fetching the callback', async () => {
    const fetchMock = mockPicker({ entries: [binding], resumeWebId: binding.webId });
    renderConsent();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(resumeLocation));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(posts(fetchMock, pickUrl)).toHaveLength(1);
    expect(posts(fetchMock, pickUrl)[0][1]).toMatchObject({
      credentials: 'include', redirect: 'manual',
      body: JSON.stringify({ webId: binding.webId, remember: true }),
    });
    expect(posts(fetchMock, consentUrl)).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === resumeLocation)).toBe(false);
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  });

  it.each(['additional scope', 'explicit consent'])('shows real consent after identity recovery redirects for %s', async () => {
    const fetchMock = mockPicker({ entries: [binding], resumeWebId: binding.webId });
    const first = renderConsent();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(resumeLocation));
    first.unmount();
    expect(posts(fetchMock, consentUrl)).toHaveLength(0);
    // The real resumed IdP interaction now needs consent and withdraws its
    // login-only resume hint. A new page load must wait for user approval.
    const consentFetch = mockPicker({ entries: [binding] });
    renderConsent();
    expect(await screen.findByRole('button', { name: '批准' })).toBeTruthy();
    expect(posts(consentFetch, pickUrl)).toHaveLength(0);
    expect(posts(consentFetch, consentUrl)).toHaveLength(0);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it.each(['first consent', 'new scope', 'explicit consent', 'revoked grant'])(
    'shows %s for approval when the backend does not offer identity recovery, even for a same-origin transaction', async () => {
      const localBinding = { webId: `${window.location.origin}/alice/profile/card#me`, storageUrl: `${window.location.origin}/alice/` };
      createXpodLoginTransactionStore({ storage: window.sessionStorage, origin: window.location.origin }).begin({
        id: 'visible-consent-transaction', route: createXpodLoginRoute(window.location),
        authorizationSurface: 'redirect', discovery: 'strict', selectedStorage: localBinding,
      });
      const fetchMock = mockPicker({ entries: [localBinding] });
      renderConsent();
      expect(await screen.findByRole('button', { name: '批准' })).toBeTruthy();
      expect(posts(fetchMock, pickUrl)).toHaveLength(0);
      expect(posts(fetchMock, consentUrl)).toHaveLength(0);
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['unowned WebID', { entries: [binding], resumeWebId: 'https://attacker.example/me' }],
    ['legacy IDs without owned bindings', { entries: [], webIds: [binding.webId], resumeWebId: binding.webId }],
    ['multiple identities', { entries: [binding, { webId: 'https://pod.example/bob#me', storageUrl: 'https://pod.example/bob/' }], resumeWebId: binding.webId }],
    ['ambiguous storage', { entries: [binding, { ...binding, storageUrl: 'https://other-pod.example/alice/' }], resumeWebId: binding.webId }],
    ['malformed entry', { entries: [{ webId: binding.webId }], resumeWebId: binding.webId }],
  ])('does not fabricate an automatic binding from %s', async (_label, data) => {
    const fetchMock = mockPicker(data);
    renderConsent();
    await waitFor(() => expect(screen.queryByText('正在恢复授权…')).toBeNull());
    expect(posts(fetchMock, pickUrl)).toHaveLength(0);
    expect(posts(fetchMock, consentUrl)).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(['HTTP failure', 'missing location', 'network failure'])(
    'shows a recoverable failure without silently retrying on %s', async (failure) => {
      let attempts = 0;
      const fetchMock = mockPicker({ entries: [binding], resumeWebId: binding.webId }, async () => {
        attempts += 1;
        if (attempts > 1) return json({ location: resumeLocation });
        if (failure === 'network failure') throw new TypeError('Failed to fetch');
        return failure === 'missing location' ? json({}) : json({ message: 'unavailable' }, 503);
      });
      renderConsent();
      const retry = await screen.findByRole('button', { name: '重试' });
      expect(posts(fetchMock, pickUrl)).toHaveLength(1);
      expect(posts(fetchMock, consentUrl)).toHaveLength(0);
      expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
      fireEvent.click(retry);
      await waitFor(() => expect(assign).toHaveBeenCalledWith(resumeLocation));
      expect(posts(fetchMock, pickUrl)).toHaveLength(2);
      expect(posts(fetchMock, consentUrl)).toHaveLength(0);
    },
  );
});

it('returns from automatic resume failure without automatically resuming the editable form again', async () => {
  const fetchMock = mockPicker({ entries: [binding], resumeWebId: binding.webId }, async () => json({ message: 'unavailable' }, 503));
  renderConsent();
  fireEvent.click(await screen.findByRole('button', { name: '返回授权' }));
  expect(await screen.findByRole('button', { name: '批准' })).toBeTruthy();
  expect(posts(fetchMock, pickUrl)).toHaveLength(1);
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
  expect(assign).not.toHaveBeenCalled();
});

it.each([{ message: 'Invalid OIDC interaction' }, { errorCode: 'E0002' }])('leaves an expired H400 interaction without offering approval or replay: %j', async (body) => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(async () => json(body, 400));
  vi.stubGlobal('fetch', fetchMock);
  renderConsent();
  const safeReturn = await screen.findByRole('button', { name: '返回账号' });
  expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  expect(screen.queryByRole('button', { name: '取消授权' })).toBeNull();
  const requests = fetchMock.mock.calls.length;
  fireEvent.click(safeReturn);
  expect(assign).toHaveBeenCalledWith(new URL('/.account/', window.location.origin).href);
  expect(fetchMock).toHaveBeenCalledTimes(requests);
});

it('offers real cancellation and a safe Account return when initial consent loading fails', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => json({ message: 'unavailable' }, init?.method === 'POST' ? 500 : 503));
  vi.stubGlobal('fetch', fetchMock);
  renderConsent();
  fireEvent.click(await screen.findByRole('button', { name: '取消授权' }));
  await screen.findByRole('button', { name: '重试取消' });
  expect(posts(fetchMock, '/.account/oidc/cancel')).toHaveLength(1);
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '返回账号' }));
  expect(assign).toHaveBeenCalledWith(new URL('/.account/', window.location.origin).href);
});

it('keeps retry cancellation available after cancellation fails while anonymous', async () => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(async () => json({ message: 'unavailable' }, 503));
  vi.stubGlobal('fetch', fetchMock);
  renderConsent({ isLoggedIn: false, accountState: { status: 'anonymous' } });
  fireEvent.click(await screen.findByRole('button', { name: '取消授权' }));
  fireEvent.click(await screen.findByRole('button', { name: '重试取消' }));
  await waitFor(() => expect(posts(fetchMock, '/.account/oidc/cancel')).toHaveLength(2));
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
});

it.each([503, 400])('retries a rejected desktop return without OIDC mutations after HTTP %s', async (status) => {
  const cancelLogin = vi.fn().mockRejectedValueOnce(new Error('desktop unavailable')).mockResolvedValueOnce(undefined);
  window.xpodDesktop = { cancelLogin } as NonNullable<Window['xpodDesktop']>;
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(async () => json(status === 400 ? { errorCode: 'E0002' } : {}, status));
  vi.stubGlobal('fetch', fetchMock);
  renderConsent();
  fireEvent.click(await screen.findByRole('button', { name: '返回应用' }));
  fireEvent.click(await screen.findByRole('button', { name: '重试返回' }));
  await waitFor(() => expect(cancelLogin).toHaveBeenCalledTimes(2));
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
  expect(posts(fetchMock, '/.account/oidc/cancel')).toHaveLength(0);
});

it('treats an E0002-only cancellation response as expired and never replays cancellation', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/.account/oidc/cancel' && init?.method === 'POST') return json({ errorCode: 'E0002' }, 400);
    if (String(input) === consentUrl) return json({ client: { client_id: 'desktop' }, webId: binding.webId });
    if (String(input) === pickUrl) return json({ entries: [binding] });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetchMock);
  renderConsent();
  fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
  const safeReturn = await screen.findByRole('button', { name: '返回账号' });
  expect(screen.queryByRole('button', { name: '重试取消' })).toBeNull();
  expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  expect(screen.queryByRole('button', { name: '取消授权' })).toBeNull();
  fireEvent.click(safeReturn);
  expect(assign).toHaveBeenCalledWith(new URL('/.account/', window.location.origin).href);
  expect(posts(fetchMock, '/.account/oidc/cancel')).toHaveLength(1);
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
});


it('keeps both bindings editable and the manual selection after refreshing a failed submission', async () => {
  const firstBinding = { webId: `${window.location.origin}/alice#me`, storageUrl: `${window.location.origin}/alice/` };
  const other = { webId: `${window.location.origin}/bob#me`, storageUrl: `${window.location.origin}/bob/` };
  const store = createXpodLoginTransactionStore({ storage: window.sessionStorage, origin: window.location.origin });
  store.begin({ id: 'editable-consent-retry', route: createXpodLoginRoute(window.location), authorizationSurface: 'redirect', discovery: 'strict' });
  const fetchMock = mockPicker({ entries: [firstBinding, other] }, async () => json({}, 503));
  renderConsent();
  fireEvent.change(await screen.findByLabelText('身份与存储空间'), { target: { value: storageBindingKey(other) } });
  fireEvent.click(screen.getByRole('button', { name: '批准' }));
  const retry = await screen.findByRole('button', { name: '重试' });
  expect(posts(fetchMock, pickUrl)).toHaveLength(1);
  const reads = fetchMock.mock.calls.filter(([input, init]) => String(input) === consentUrl && !init?.method).length;
  fireEvent.click(retry);
  const selector = await screen.findByLabelText('身份与存储空间') as HTMLSelectElement;
  expect(Array.from(selector.options, (option) => option.value)).toEqual(expect.arrayContaining([storageBindingKey(firstBinding), storageBindingKey(other)]));
  expect(selector.value).toBe(storageBindingKey(other));
  expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === consentUrl && !init?.method)).toHaveLength(reads + 1);
  expect(posts(fetchMock, pickUrl)).toHaveLength(1);
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
});

it('keeps an entry-time selected storage scope fixed when multiple bindings exist and a submission is retried', async () => {
  const firstBinding = { webId: `${window.location.origin}/alice#me`, storageUrl: `${window.location.origin}/alice/` };
  const other = { webId: `${window.location.origin}/bob#me`, storageUrl: `${window.location.origin}/bob/` };
  createXpodLoginTransactionStore({ storage: window.sessionStorage, origin: window.location.origin }).begin({
    id: 'fixed-consent-retry', route: createXpodLoginRoute(window.location), authorizationSurface: 'redirect', discovery: 'strict', selectedStorage: firstBinding,
  });
  const fetchMock = mockPicker({ entries: [firstBinding, other] }, async () => json({}, 503));
  renderConsent();
  fireEvent.click(await screen.findByRole('button', { name: '批准' }));
  fireEvent.click(await screen.findByRole('button', { name: '重试' }));
  await screen.findByRole('button', { name: '批准' });
  expect(screen.queryByLabelText('身份与存储空间')).toBeNull();
  expect(posts(fetchMock, pickUrl)).toHaveLength(1);
  expect(JSON.parse(String(posts(fetchMock, pickUrl)[0][1]?.body))).toMatchObject({ webId: firstBinding.webId });
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
});

it('does not create storage or replace a fixed entry binding when only another binding remains', async () => {
  const firstBinding = { webId: `${window.location.origin}/alice#me`, storageUrl: `${window.location.origin}/alice/` };
  const other = { webId: `${window.location.origin}/bob#me`, storageUrl: `${window.location.origin}/bob/` };
  const store = createXpodLoginTransactionStore({ storage: window.sessionStorage, origin: window.location.origin });
  store.begin({ id: 'missing-fixed-consent', route: createXpodLoginRoute(window.location), authorizationSurface: 'redirect', discovery: 'strict', selectedStorage: firstBinding });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return json({}, 503);
    if (String(input) === consentUrl) return json({ client: { client_id: 'desktop' } });
    if (String(input) === pickUrl) return json({ entries: [other] });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderConsent({ controls: { account: { username: 'alice', pod: '/.account/account/pod/' } } });
  await screen.findByRole('button', { name: '重试' });
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  expect(store.readSinglePending()?.selectedStorage).toMatchObject(firstBinding);
});

it('preserves the original pending return target until the cancellation callback takes over', async () => {
  const store = createXpodLoginTransactionStore({ storage: window.sessionStorage, origin: window.location.origin });
  const returnTo = '/ai-connections/?provider=original&view=keys';
  store.begin({ id: 'cancel-return-target', route: createXpodLoginRoute(window.location), authorizationSurface: 'redirect', discovery: 'strict', returnTo });
  const callback = '/app/auth/callback?error=access_denied&state=cancel-state';
  const redirect = vi.fn((location: string) => {
    expect(location).toBe(callback);
    expect(store.readSinglePending()?.returnTo).toBe(returnTo);
  });
  Object.defineProperty(window.location, 'href', { configurable: true, set: redirect });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/.account/oidc/cancel' && init?.method === 'POST') return json({ location: callback });
    if (String(input) === consentUrl) return json({ client: { client_id: 'desktop' } });
    if (String(input) === pickUrl) return json({ entries: [{ webId: `${window.location.origin}/alice#me`, storageUrl: `${window.location.origin}/alice/` }] });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetchMock);
  renderConsent();
  fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
  await waitFor(() => expect(redirect).toHaveBeenCalledOnce());
  expect(store.readSinglePending()?.returnTo).toBe(returnTo);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([input]) => String(input))).toEqual(['/.account/oidc/cancel']);
});

function SwitchRouteProbe() {
  return <output data-testid="switch-route">{useLocation().pathname}</output>;
}

function renderConsentForSwitch(overrides: Partial<AuthContextType> = {}) {
  const auth: AuthContextType = {
    controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/',
    isLoggedIn: true, authenticating: false, hasOidcPending: true,
    refetchControls: vi.fn(), retry: vi.fn(), logout: vi.fn(), accountState: { status: 'authenticated' },
    ...overrides,
  };
  return render(<AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={['/.account/oidc/consent/']}>
      <ConsentPage />
      <SwitchRouteProbe />
    </MemoryRouter>
  </AuthContext.Provider>);
}

function beginVisibleConsentTransaction(id: string) {
  const localBinding = { webId: `${window.location.origin}/alice/profile/card#me`, storageUrl: `${window.location.origin}/alice/` };
  createXpodLoginTransactionStore({ storage: window.sessionStorage, origin: window.location.origin }).begin({
    id, route: createXpodLoginRoute(window.location), authorizationSurface: 'redirect', discovery: 'strict', selectedStorage: localBinding,
  });
  return localBinding;
}

it('keeps the current Account and reports an incomplete sign-out when switching fails', async () => {
  // `logout()` reports a failed CSS revocation by settling with an error
  // Account state instead of rejecting, so the page must confirm the session
  // is actually anonymous before it leaves for the login form.
  const localBinding = beginVisibleConsentTransaction('switch-account-failed');
  const logout = vi.fn(async () => undefined);
  const fetchMock = mockPicker({ entries: [localBinding] });
  renderConsentForSwitch({ logout, isAnonymous: () => false });
  fireEvent.click(await screen.findByRole('button', { name: '换一个账号' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.signOutIncomplete));
  expect(logout).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('switch-route').textContent).toBe('/.account/oidc/consent/');
  expect(posts(fetchMock, pickUrl)).toHaveLength(0);
  expect(posts(fetchMock, consentUrl)).toHaveLength(0);
});

it('leaves for the login form once the Account session is confirmed anonymous', async () => {
  const localBinding = beginVisibleConsentTransaction('switch-account-confirmed');
  const logout = vi.fn(async () => undefined);
  mockPicker({ entries: [localBinding] });
  renderConsentForSwitch({ logout, isAnonymous: () => true });
  fireEvent.click(await screen.findByRole('button', { name: '换一个账号' }));
  await waitFor(() => expect(screen.getByTestId('switch-route').textContent).toBe('/.account/login/password/'));
  expect(logout).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(xpodConsentErrors.signOutIncomplete)).toBeNull();
});
