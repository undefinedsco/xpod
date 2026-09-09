// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from './XpodSolidRuntime';
import { XpodSolidRuntimeContext } from './XpodSolidRuntime';
import { WebIdAuthBoundary } from './WebIdAuthBoundary';
import { XPOD_REMEMBERED_LOGIN_KEY } from '../auth/xpod-remembered-login';

const webId = `${window.location.origin}/alice/profile/card#me`;
const podUrl = `${window.location.origin}/alice/`;

function runtime(overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
  return {
    session: { getSnapshot: () => ({ status: 'anonymous' }) } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn() as typeof fetch,
    state: { status: 'anonymous' },
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as XpodSolidRuntimeValue;
}

function renderBoundary(
  value: XpodSolidRuntimeValue,
  props: Partial<React.ComponentProps<typeof WebIdAuthBoundary>> = {},
) {
  return render(
    <XpodSolidRuntimeContext.Provider value={value}>
      <WebIdAuthBoundary {...props}><span data-testid="protected">ready</span></WebIdAuthBoundary>
    </XpodSolidRuntimeContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.xpodDesktop = undefined;
});

describe('WebIdAuthBoundary', () => {
  test('starts only the Inrupt WebID flow when anonymous', async () => {
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({ login }));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  test('auto-starts the single WebID flow once when the Xpod product route is entered', async () => {
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({ login }), { autoStart: true });

    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(login).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  test('restores the previous Inrupt session before auto-starting login', async () => {
    const initialize = vi.fn(async () => ({ status: 'anonymous' as const }));
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({
      session: {
        getSnapshot: () => ({ status: 'initializing' as const }),
        initialize,
      } as XpodSolidRuntimeValue['session'],
      state: { status: 'loading' },
      login,
    }), { autoStart: true });

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledWith({ restorePreviousSession: true });
    expect(login).not.toHaveBeenCalled();
  });

  test('uses the native window itself as the WebID gate', () => {
    window.xpodDesktop = {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode: vi.fn(),
    };

    renderBoundary(runtime());

    const surface = screen.getByTestId('auth-surface-page');
    const frame = screen.getByRole('region', { name: '登录 Xpod' });
    expect(surface.getAttribute('data-auth-surface-host')).toBe('window');
    expect(frame.getAttribute('data-auth-surface-frame')).toBe('window');
    expect(frame.classList.contains('w-full')).toBe(true);
    expect(frame.classList.contains('h-full')).toBe(true);
    expect(window.xpodDesktop.setWindowMode).toHaveBeenCalledWith('auth');
  });

  test('renders Pod-backed content after the WebID runtime opens storage', () => {
    renderBoundary(runtime({
      state: { status: 'authenticated', webId, podUrl },
      webId,
      podUrl,
      selectedStorage: { webId, storageUrl: podUrl },
      currentPod: { webId, podUrl } as XpodSolidRuntimeValue['currentPod'],
    }));
    expect(screen.getByTestId('protected')).toBeTruthy();
  });

  test('retries Pod opening without restarting OIDC', () => {
    const login = vi.fn(async () => undefined);
    const retryPodOpen = vi.fn();
    renderBoundary(runtime({
      state: { status: 'authenticated', webId },
      webId,
      podError: { webId, error: new Error('offline') },
      login,
      retryPodOpen,
    }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retryPodOpen).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });

  test('switches remembered WebID by logging out only the Solid runtime', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId, storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    const logout = vi.fn(async () => undefined);
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({ logout, login }));
    fireEvent.click(screen.getByRole('button', { name: '切换账号' }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledTimes(1);
  });
});
