// @vitest-environment jsdom
//
// Only the authority may decide that an existing grant covers a new interaction.
// Browser storage, even for the same Account, client and WebID, never approves it.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { ConsentPage } from './ConsentPage';

const binding = { webId: 'http://127.0.0.1:3000/alice/profile/card#me', storageUrl: 'http://127.0.0.1:3000/alice/' };
const boundLocation = '/.account/interaction/bound-interaction/oidc/consent/';
let currentUrl: URL;
let nextLocation = boundLocation;
const callbackLocation = '/auth/callback?code=abc&state=1';
const assign = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  assign.mockReset();
  window.xpodDesktop = undefined;
  const browserWindow = window;
  currentUrl = new URL('/.account/interaction/source/oidc/consent/', browserWindow.location.origin);
  nextLocation = boundLocation;
  const facade = Object.create(browserWindow);
  Object.defineProperty(facade, 'location', {
    value: {
      get href() { return currentUrl.href; },
      get pathname() { return currentUrl.pathname; },
      get origin() { return browserWindow.location.origin; },
      assign,
    },
  });
  vi.stubGlobal('window', facade);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function renderConsent(accountId = 'alice', assertCurrent: () => void = () => undefined) {
  const auth: AuthContextType = {
    controls: {}, identity: { id: accountId }, bindAccountCapability: () => assertCurrent, isInitializing: false, initError: null, idpIndex: '/.account/',
    isLoggedIn: true, authenticating: false, hasOidcPending: true,
    refetchControls: vi.fn(), retry: vi.fn(), logout: vi.fn(), accountState: { status: 'authenticated' },
  };
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter><ConsentPage /></MemoryRouter>
    </AuthContext.Provider>,
  );
}

function mockConsent(consentBody: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/oidc/consent/') && !init?.method) return json(consentBody);
    if (url.endsWith('/oidc/pick-webid/') && !init?.method) return json({ entries: [binding] });
    if (url.endsWith('/oidc/pick-webid/') && init?.method === 'POST') return json({ location: nextLocation });
    if (url.endsWith('/oidc/consent/') && init?.method === 'POST') return json({ location: callbackLocation });
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ConsentPage requires authority or an explicit approval', () => {
  it('asks explicitly when binding a WebID returns a new Consent interaction', async () => {
    mockConsent({ client: { client_id: 'desktop', client_name: 'Xpod Desktop' } });
    renderConsent();
    fireEvent.click(await screen.findByRole('button', { name: '允许' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(boundLocation));
    expect(sessionStorage.getItem('xpod.consent.carry.v1')).toBeNull();

    cleanup();
    currentUrl = new URL(boundLocation, currentUrl.origin);
    assign.mockReset();
    const fetchMock = mockConsent({ client: { client_id: 'desktop' }, webId: binding.webId });
    renderConsent();
    await screen.findByRole('button', { name: '允许' });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(callbackLocation));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each(['same Account new session', 'different Account', 'different interaction', 'different client', 'missing client', 'expired', 'future'])(
    'ignores a legacy browser approval for %s', async (scenario) => {
      currentUrl = new URL(boundLocation, currentUrl.origin);
      // This was written by source session A. Every render below has a valid new
      // Account capability from session B, including the identical-Account case.
      sessionStorage.setItem('xpod.consent.carry.v1', JSON.stringify({
        clientId: 'desktop', accountId: 'alice', consentUrl: currentUrl.href,
        webId: binding.webId, remember: true,
        at: Date.now() + (scenario === 'future' ? 60_000 : scenario === 'expired' ? -180_000 : 0),
      }));
      if (scenario === 'different interaction') currentUrl = new URL('/.account/interaction/other/oidc/consent/', currentUrl.origin);
      const fetchMock = mockConsent({
        client: { ...(scenario === 'missing client' ? {} : { client_id: scenario === 'different client' ? 'other' : 'desktop' }), client_name: 'Xpod Desktop' },
        webId: binding.webId,
      });
      renderConsent(scenario === 'different Account' ? 'bob' : 'alice', vi.fn());
      await screen.findByRole('button', { name: '允许' });
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    },
  );
});
