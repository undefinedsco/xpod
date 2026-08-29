// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodRememberedLoginBridge } from './XpodRememberedLoginBridge';
import { readRememberedXpodLogin } from './xpod-remembered-login';

vi.mock('../profile/useXpodProfileCardIdentity', () => ({ useXpodProfileCardIdentity: vi.fn() }));
const mockedProfile = vi.mocked(useXpodProfileCardIdentity);
const webId = `${window.location.origin}/alice/profile/card#me`;
const storageUrl = `${window.location.origin}/alice/`;

function account(): AuthContextType {
  return {
    controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/',
    isLoggedIn: false, authenticating: false, hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined), retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined), accountState: { status: 'anonymous', mode: 'login' },
  };
}

function runtime(ready: boolean): XpodSolidRuntimeValue {
  return {
    state: { status: 'authenticated', webId, ...(ready ? { podUrl: storageUrl } : {}) },
    webId,
    selectedStorage: ready ? { webId, storageUrl } : undefined,
    currentPod: ready ? { webId, podUrl: storageUrl } as XpodSolidRuntimeValue['currentPod'] : undefined,
  } as XpodSolidRuntimeValue;
}

function renderBridge(ready: boolean) {
  return render(
    <AuthContext.Provider value={account()}>
      <XpodSolidRuntimeContext.Provider value={runtime(ready)}>
        <XpodRememberedLoginBridge />
      </XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>,
  );
}

afterEach(() => { cleanup(); window.localStorage.clear(); mockedProfile.mockReset(); });

describe('XpodRememberedLoginBridge', () => {
  test('remembers a ready WebID/Pod without requiring an Account session', async () => {
    mockedProfile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'webid-profile', webId });
    renderBridge(true);
    await waitFor(() => expect(readRememberedXpodLogin()?.storageBinding).toEqual({ webId, storageUrl }));
  });

  test('does not remember a WebID before its Pod is open', () => {
    mockedProfile.mockReturnValue({ displayName: 'Alice', username: 'alice', loading: false, source: 'webid-profile', webId });
    renderBridge(false);
    expect(readRememberedXpodLogin()).toBeUndefined();
  });
});
