import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { XpodAuthProvider } from '../auth/XpodAuthProvider';
import type { XpodAuthAccountSource } from '../auth/useXpodAuth';
import {
  XpodSolidRuntimeContext,
  type XpodSolidRuntimeValue,
} from '../solid/XpodSolidRuntime';

afterEach(() => {
  cleanup();
  window.xpodDesktop = undefined;
});

const WEB_ID = `${window.location.origin}/alice/profile/card#me`;
const POD_URL = `${window.location.origin}/alice/`;

function account(overrides: Partial<XpodAuthAccountSource> = {}): XpodAuthAccountSource {
  return {
    accountState: { status: 'anonymous', mode: 'login' },
    isLoggedIn: false,
    retry: vi.fn(async () => undefined),
    refetchControls: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function runtime({ authenticated = false }: { authenticated?: boolean } = {}): XpodSolidRuntimeValue {
  const state = authenticated
    ? { status: 'authenticated', webId: WEB_ID, podUrl: POD_URL } as const
    : { status: 'anonymous' } as const;
  return {
    session: {
      getSnapshot: () => authenticated
        ? { status: 'authenticated', webId: WEB_ID }
        : { status: 'anonymous' },
    } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn() as typeof fetch,
    state,
    webId: authenticated ? WEB_ID : undefined,
    podUrl: authenticated ? POD_URL : undefined,
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
}

function composition(accountSource: XpodAuthAccountSource, solid: XpodSolidRuntimeValue) {
  return (
    <XpodSolidRuntimeContext.Provider value={solid}>
      <XpodAuthProvider account={accountSource}>
        <span>content</span>
      </XpodAuthProvider>
    </XpodSolidRuntimeContext.Provider>
  );
}

describe('Xpod desktop identity bridge', () => {
  test('publishes only the sanitized Account, WebID, and Pod summary, then clears it on logout', async () => {
    const setIdentity = vi.fn();
    const setWindowMode = vi.fn();
    window.xpodDesktop = { setIdentity, setWindowMode };
    const signedIn = account({
      accountState: { status: 'authenticated' },
      isLoggedIn: true,
      identity: {
        id: 'internal-account-id',
        username: 'alice',
        displayName: '  Alice\u0000\nAdmin  ',
        webId: 'javascript:alert(1)',
      },
    });
    const anonymous = account();
    const { rerender } = render(composition(signedIn, runtime({ authenticated: true })));

    await waitFor(() => {
      expect(setIdentity).toHaveBeenLastCalledWith({
        label: 'Alice Admin',
        webId: WEB_ID,
        podUrl: POD_URL,
      });
    });
    expect(setIdentity.mock.lastCall?.[0]).not.toHaveProperty('id');
    expect(setWindowMode).toHaveBeenCalledWith('workspace');

    rerender(composition(anonymous, runtime()));

    await waitFor(() => {
      expect(setIdentity).toHaveBeenLastCalledWith(null);
    });
  });
});
