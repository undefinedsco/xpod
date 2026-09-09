// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodDesktopIdentityBridge } from './XpodDesktopIdentityBridge';

const WEB_ID = `${window.location.origin}/alice/profile/card#me`;
const POD_URL = `${window.location.origin}/alice/`;

function account(authenticated: boolean): AuthContextType {
  return {
    controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/',
    isLoggedIn: authenticated, authenticating: false, hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined), retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: authenticated ? { status: 'authenticated' } : { status: 'anonymous', mode: 'login' },
    ...(authenticated ? { identity: { displayName: '  Alice\u0000\nAdmin  ', username: 'alice' } } : {}),
  };
}

function runtime(authenticated: boolean): XpodSolidRuntimeValue {
  return {
    state: authenticated ? { status: 'authenticated', webId: WEB_ID, podUrl: POD_URL } : { status: 'anonymous' },
    webId: authenticated ? WEB_ID : undefined,
    podUrl: authenticated ? POD_URL : undefined,
    currentPod: authenticated ? { webId: WEB_ID, podUrl: POD_URL } as XpodSolidRuntimeValue['currentPod'] : undefined,
  } as XpodSolidRuntimeValue;
}

function composition(authenticated: boolean) {
  return (
    <AuthContext.Provider value={account(authenticated)}>
      <XpodSolidRuntimeContext.Provider value={runtime(authenticated)}>
        <XpodDesktopIdentityBridge />
      </XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>
  );
}

afterEach(() => { cleanup(); window.xpodDesktop = undefined; });

describe('Xpod desktop identity bridge', () => {
  test('projects independent Account and WebID state without exposing Account internals', async () => {
    const setIdentity = vi.fn();
    const setWindowMode = vi.fn();
    window.xpodDesktop = { setIdentity, setWindowMode };
    const view = render(composition(true));
    await waitFor(() => expect(setIdentity).toHaveBeenLastCalledWith({ label: 'Alice Admin', webId: WEB_ID, podUrl: POD_URL }));
    expect(setIdentity.mock.lastCall?.[0]).not.toHaveProperty('id');
    view.rerender(composition(false));
    await waitFor(() => expect(setIdentity).toHaveBeenLastCalledWith(null));
  });
});
