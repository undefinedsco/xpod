// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { createXpodLoginTransactionStore } from '../auth/xpod-login-transaction';
import { createXpodLoginRoute } from '../auth/xpod-login-route';
import { ConsentPage } from './ConsentPage';

const pickUrl = '/.account/oidc/pick-webid/';
const consentUrl = '/.account/oidc/consent/';
const binding = { webId: 'https://pod.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' };
const resumeLocation = '/oidc/auth/resume?uid=remembered-session';
const assign = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  assign.mockReset();
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
