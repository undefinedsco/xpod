// @vitest-environment jsdom
//
// FirstPod 轻页的读取契约：只有**当前目标部署**的权威绑定能证明就绪并消费一次性
// 任务。其他 root 的绑定、读失败都不能被当作证据；裸 legacy GET 没有任务时只
// 导航到 Account 管理，不读、不 lookup、不创建。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { xpodFirstPodErrors } from '../auth/xpod-account-copy';
import { saveConsentContinuation } from '../utils/safe-continuation';
import { FirstPodPage } from './FirstPodPage';

const ACCOUNT_ID = 'alice';
const INTERACTION = '/.account/interaction/flow-read';
const CREATE_PATH = `${INTERACTION}/create-pod/`;
const CONSENT_RETURN = `${INTERACTION}/oidc/consent/`;
const LEGACY_PATH = '/.account/create-pod/';
const ACCOUNT_BASE = `https://id.example/.account/account/${ACCOUNT_ID}/`;

function resetFirstPodReadFailureState(): void {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  globalThis.sessionStorage?.clear();
  window.localStorage.clear();
  globalThis.localStorage?.clear();
  window.xpodDesktop = undefined;
  globalThis.xpodDesktop = undefined;
  window.__XPOD__ = undefined;
}

beforeEach(() => {
  resetFirstPodReadFailureState();
});

afterEach(() => {
  resetFirstPodReadFailureState();
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: 'https://id.example/.account/',
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

/** jsdom's location is read-only; swap in a facade the page reads and navigates. */
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

function renderAt(path: string, overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={[path]}>
        <FirstPodPage />
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

/** Every advertised Account control agrees on the same authoritative Account id. */
function accountControls(overrides: Record<string, string | undefined> = {}) {
  return {
    account: {
      id: ACCOUNT_ID,
      username: ACCOUNT_ID,
      bindings: `${ACCOUNT_BASE}bindings/`,
      webId: `${ACCOUNT_BASE}webid/`,
      pod: `${ACCOUNT_BASE}pod/`,
      ...overrides,
    },
  };
}

function seedTask(accountId = ACCOUNT_ID): void {
  expect(saveConsentContinuation({
    accountId,
    interaction: INTERACTION,
    returnTo: CONSENT_RETURN,
  })).toBe(true);
}

function makeProvisionCode(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
  return `${encoded}.signature`;
}

function futureExp(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

function installProvisionContext(payload: Record<string, unknown>): void {
  window.__XPOD__ = { authenticating: false, provisionCode: makeProvisionCode(payload) };
}

function installLiveLocalProvisionContext(): void {
  installProvisionContext({ spUrl: 'https://node.example/', serviceToken: 'test-token', exp: futureExp() });
}

function installExpiredLocalProvisionContext(storageDomain: string): void {
  installProvisionContext({
    spUrl: `https://${storageDomain}/`,
    spDomain: storageDomain,
    serviceToken: 'expired-token',
    exp: 1,
  });
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).pathname;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function taskRecord(): unknown {
  return JSON.parse(window.sessionStorage.getItem('xpod.safe-continuation.consent.v2') ?? 'null');
}

function method(init: RequestInit | undefined): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function anyPost(fetchMock: ReturnType<typeof vi.fn>): boolean {
  return fetchMock.mock.calls.some(([, init]) => method(init as RequestInit | undefined) === 'POST');
}

/** Paths this page POSTed to, in order. */
function postedPaths(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => method(init as RequestInit | undefined) === 'POST')
    .map(([input]) => requestPath(input));
}

function webIdReads(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input) === `/.account/account/${ACCOUNT_ID}/webid/`).length;
}

describe('FirstPodPage Account WebID read failures', () => {
  it.each([
    {
      name: 'endpoint 500',
      webIdResponse: () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
    },
    {
      name: 'malformed JSON',
      webIdResponse: () => new Response('not-json', { status: 200 }),
    },
    {
      name: 'malformed shape',
      webIdResponse: () => new Response(JSON.stringify({}), { status: 200 }),
    },
  ])('does not create storage when the Account WebID read returns $name, including retry', async ({ webIdResponse }) => {
    installLocation(CREATE_PATH);
    seedTask();
    installLiveLocalProvisionContext();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === `/.account/account/${ACCOUNT_ID}/webid/`) {
        return webIdResponse();
      }
      if (path.endsWith('/pod/') && init?.method === 'POST') {
        return jsonResponse({ pod: 'created' }, 201);
      }
      if (path === '/provision/webids') {
        return jsonResponse({ entries: [] });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt(CREATE_PATH, { controls: accountControls({ bindings: undefined }) });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));
    expect(anyPost(fetchMock)).toBe(false);
    expect(taskRecord()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(webIdReads(fetchMock)).toBe(2));
    expect(anyPost(fetchMock)).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(false);
  });

  it('does not create storage when the Account WebID control is missing, including retry', async () => {
    installLocation(CREATE_PATH);
    seedTask();
    installLiveLocalProvisionContext();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === `/.account/account/${ACCOUNT_ID}/bindings/`) {
        return jsonResponse({ bindings: [] });
      }
      if (path.endsWith('/pod/') && init?.method === 'POST') {
        return jsonResponse({ pod: 'created' }, 201);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt(CREATE_PATH, { controls: accountControls({ webId: undefined }) });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));

    expect(anyPost(fetchMock)).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(false);
    expect(taskRecord()).not.toBeNull();
  });

  it('uses Account WebIDs as Local lookup candidates when durable bindings are empty', async () => {
    installLocation(CREATE_PATH);
    seedTask();
    installLiveLocalProvisionContext();
    const webId = 'https://node.example/alice/profile/card#me';
    const storageUrl = 'https://node.example/alice/';
    const createPod = vi.fn(async () => jsonResponse({ pod: 'created' }, 201));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === `/.account/account/${ACCOUNT_ID}/bindings/`) {
        return jsonResponse({ bindings: [] });
      }
      if (path === `/.account/account/${ACCOUNT_ID}/webid/`) {
        return jsonResponse({ webIdLinks: { [webId]: `https://id.example/.account/account/${ACCOUNT_ID}/webid/alice/` } });
      }
      if (path === '/provision/webids') {
        expect(JSON.parse(String(init?.body))).toEqual({ webIds: [webId] });
        return jsonResponse({ entries: [{ webId, storageUrl }] });
      }
      if (path.endsWith('/pod/') && init?.method === 'POST') {
        return createPod();
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt(CREATE_PATH, { controls: accountControls() });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(CONSENT_RETURN));
    expect(createPod).not.toHaveBeenCalled();
    // The only POST is the scoped lookup; nothing was created.
    expect(postedPaths(fetchMock)).toEqual(['/provision/webids']);
    expect(webIdReads(fetchMock)).toBe(1);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(true);
    expect(taskRecord()).toBeNull();
  });

  it('accepts durable exact storage before requiring an expired Local provision code', async () => {
    installLocation(CREATE_PATH);
    seedTask();
    const webId = 'https://id.example/alice/profile/card#me';
    const storageUrl = 'https://node-a.example/alice/';
    installExpiredLocalProvisionContext('node-a.example');
    const createPod = vi.fn(async () => jsonResponse({ pod: 'created' }, 201));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === `/.account/account/${ACCOUNT_ID}/bindings/`) {
        return jsonResponse({ bindings: [{ webId, storageUrl }] });
      }
      if (path === '/provision/webids') {
        throw new Error('Durable exact storage must not require Local lookup');
      }
      if (path.endsWith('/pod/') && init?.method === 'POST') {
        return createPod();
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt(CREATE_PATH, { controls: accountControls() });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(CONSENT_RETURN));
    expect(createPod).not.toHaveBeenCalled();
    expect(postedPaths(fetchMock)).toEqual([]);
    expect(webIdReads(fetchMock)).toBe(0);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(false);
    expect(taskRecord()).toBeNull();
  });

  it('never treats a durable binding on another root as the current target', async () => {
    installLocation(CREATE_PATH);
    seedTask();
    installProvisionContext({ spUrl: 'http://127.0.0.1:5179/', serviceToken: 'local-token', exp: futureExp() });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === `/.account/account/${ACCOUNT_ID}/bindings/`) {
        return jsonResponse({ bindings: [{
          webId: 'https://cloud.example/owner/profile/card#me',
          storageUrl: 'https://cloud.example/owner/',
        }] });
      }
      if (path === '/provision/webids') {
        return jsonResponse({ entries: [] });
      }
      if (path.endsWith('/pod/') && init?.method === 'POST') {
        return jsonResponse({ pod: 'created' }, 201);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt(CREATE_PATH, { controls: accountControls({ webId: undefined }) });

    expect(await screen.findByRole('button', { name: '创建 Pod 并继续授权' })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe(CREATE_PATH);
    // The only POST is the scoped lookup; the create path was never called.
    expect(postedPaths(fetchMock)).toEqual(['/provision/webids']);
    // 别的 root 不能代替当前目标：一次性任务仍留给本次显式创建。
    expect(taskRecord()).not.toBeNull();
  });

  it('keeps the task on create failure when only another root is bound (recovery)', async () => {
    installLocation(CREATE_PATH);
    seedTask();
    installLiveLocalProvisionContext();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === CONSENT_RETURN) {
        return jsonResponse({ client: { client_id: 'flow-read', client_name: '验收应用' } });
      }
      if (path === `/.account/account/${ACCOUNT_ID}/bindings/`) {
        return jsonResponse({ bindings: [{
          webId: 'https://cloud.example/owner/profile/card#me',
          storageUrl: 'https://cloud.example/owner/',
        }] });
      }
      if (path === '/provision/webids') {
        return jsonResponse({ entries: [] });
      }
      if (path === '/provision/pods' && init?.method === 'POST') {
        return jsonResponse({ provisionReceipt: 'receipt-1' });
      }
      if (path.endsWith('/pod/')) {
        return method(init) === 'POST'
          ? jsonResponse({ message: 'boom' }, 500)
          : jsonResponse({ pods: {} });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt(CREATE_PATH, { controls: accountControls({ webId: undefined }) });

    fireEvent.click(await screen.findByRole('button', { name: '创建 Pod 并继续授权' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain(xpodFirstPodErrors.storageCreateFailed));
    expect(screen.getByTestId('location').textContent).toBe(CREATE_PATH);
    expect(taskRecord()).not.toBeNull();
  });

  it('does not read Account or Pod data, look up or create on the bare legacy create-pod deep link', async () => {
    installLocation(LEGACY_PATH);
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => jsonResponse({}, 404));
    vi.stubGlobal('fetch', fetchMock);

    renderAt(LEGACY_PATH, { controls: accountControls() });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/.account/account/'));
    // The page's source branding can read public deployment metadata while
    // the legacy entry still rejects every Account/Pod read or mutation.
    expect(fetchMock.mock.calls.some(([, init]) => method(init) === 'POST')).toBe(false);
    expect(fetchMock.mock.calls.every(([input, init]) =>
      requestPath(input) === '/api/service-info' && method(init) === 'GET',
    )).toBe(true);
  });

  it('does not inspect or create ownerless storage from the bare legacy deep link', async () => {
    installLocation(LEGACY_PATH);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('Unexpected mutation');
      const path = requestPath(input);
      if (path === '/provision/status') return jsonResponse({ registered: false });
      if (path.endsWith('/pod/')) {
        return jsonResponse({ pods: { 'https://storage.example/orphan/': '/.account/pod/id' } });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt(LEGACY_PATH, { controls: accountControls({ bindings: undefined, webId: undefined }) });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/.account/account/'));
    expect(postedPaths(fetchMock)).toEqual([]);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input).endsWith('/pod/'))).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input).endsWith('/bindings/'))).toBe(false);
  });
});
