// @vitest-environment jsdom
//
// One approval per login.
//
// Approving an interaction that is not bound to a WebID yet makes the IdP answer
// `pick-webid` with a fresh interaction. The page carries the user's decision into
// that interaction instead of showing the same approval screen twice.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { ConsentPage } from './ConsentPage';

const pickUrl = '/.account/oidc/pick-webid/';
const consentUrl = '/.account/oidc/consent/';
const binding = { webId: 'http://127.0.0.1:3000/alice/profile/card#me', storageUrl: 'http://127.0.0.1:3000/alice/' };
const boundLocation = '/oidc/auth/bound-interaction';
const callbackLocation = '/auth/callback?code=abc&state=1';
const assign = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  assign.mockReset();
  window.xpodDesktop = undefined;
  const browserWindow = window;
  const facade = Object.create(browserWindow);
  Object.defineProperty(facade, 'location', {
    value: {
      get href() { return browserWindow.location.href; },
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

function renderConsent() {
  const auth: AuthContextType = {
    controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/',
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
    if (url === consentUrl && !init?.method) return json(consentBody);
    if (url === pickUrl && !init?.method) return json({ entries: [binding] });
    if (url === pickUrl && init?.method === 'POST') return json({ location: boundLocation });
    if (url === consentUrl && init?.method === 'POST') return json({ location: callbackLocation });
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ConsentPage approval carry', () => {
  it('completes the bound interaction without asking for the same approval twice', async () => {
    // 1. the unbound interaction: the user approves once
    mockConsent({ client: { client_id: 'desktop', client_name: 'Xpod Desktop' } });
    renderConsent();
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(boundLocation));
    expect(window.sessionStorage.getItem('xpod.consent.carry.v1')).toBeTruthy();

    // 2. the interaction the IdP created for that same request is already bound
    cleanup();
    assign.mockReset();
    const fetchMock = mockConsent({
      client: { client_id: 'desktop', client_name: 'Xpod Desktop' },
      webId: binding.webId,
    });
    renderConsent();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(callbackLocation));
    const consentPosts = fetchMock.mock.calls.filter(([input, init]) => String(input) === consentUrl && init?.method === 'POST');
    expect(consentPosts).toHaveLength(1);
    expect(consentPosts[0]?.[1]).toMatchObject({ credentials: 'include', redirect: 'manual' });
    // The decision is single use.
    expect(window.sessionStorage.getItem('xpod.consent.carry.v1')).toBeNull();
  });

  it('ignores a carried decision for a different client', async () => {
    mockConsent({ client: { client_id: 'desktop', client_name: 'Xpod Desktop' } });
    renderConsent();
    fireEvent.click(await screen.findByRole('button', { name: '批准' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(boundLocation));

    cleanup();
    assign.mockReset();
    const fetchMock = mockConsent({
      client: { client_id: 'another-client', client_name: 'Other App' },
      webId: binding.webId,
    });
    renderConsent();

    await screen.findByRole('button', { name: '批准' });
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === consentUrl && init?.method === 'POST')).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });
});
