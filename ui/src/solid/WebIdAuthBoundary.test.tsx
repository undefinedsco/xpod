import { describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { createXpodLoginRoute } from '../auth/xpod-login-route';
import { createXpodLogoutCoordinator } from '../auth/xpod-logout';
import { XPOD_REMEMBERED_LOGIN_KEY } from '../auth/xpod-remembered-login';
import { XpodAuthContext, type XpodAuthValue } from '../auth/useXpodAuth';
import type { XpodSolidRuntimeValue } from './XpodSolidRuntime';
import { XpodSolidRuntimeContext } from './XpodSolidRuntime';
import { WebIdAuthBoundary } from './WebIdAuthBoundary';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type RuntimeWithBinding = XpodSolidRuntimeValue & { readonly selectedStorage?: StorageBinding };

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/settings/pod',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
}

function runtimeWith(overrides: Partial<RuntimeWithBinding> = {}): RuntimeWithBinding {
  return {
    session: {
      getSnapshot: () => ({ status: 'anonymous' }),
      subscribe: () => () => undefined,
      fetch: vi.fn(async () => new Response('ok')),
    } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn(async () => new Response('ok')),
    state: { status: 'anonymous' },
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as RuntimeWithBinding;
}

function authValue(overrides: Partial<XpodAuthValue> = {}): XpodAuthValue {
  return {
    account: {
      accountState: { status: 'anonymous', mode: 'login' },
      isLoggedIn: false,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    },
    routes: [createXpodLoginRoute(window.location)],
    webIdState: { status: 'anonymous' },
    readiness: { dashboard: false, localSettings: true, podSettings: false },
    startLogin: vi.fn(async () => undefined),
    retryLogin: vi.fn(async () => undefined),
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
    retryLogout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
    logoutState: { status: 'idle' },
    logoutCoordinator: createXpodLogoutCoordinator({
      account: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
      webId: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
    }),
    switchAccount: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
    ...overrides,
  };
}

async function render(runtime: XpodSolidRuntimeValue, beforeRender?: () => void, auth?: XpodAuthValue) {
  installDom();
  beforeRender?.();
  const value = auth ?? authValue();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodAuthContext.Provider value={value}>
        <XpodSolidRuntimeContext.Provider value={runtime}>
          <WebIdAuthBoundary>
            <span data-testid="protected">ready</span>
          </WebIdAuthBoundary>
        </XpodSolidRuntimeContext.Provider>
      </XpodAuthContext.Provider>,
    );
  });
  return { container, root, auth: value };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

const rememberedAlice = {
  account: { email: 'alice@example.com', displayName: 'Alice Doe' },
  webId: 'https://app.example/alice#me',
  storageBinding: {
    webId: 'https://app.example/alice#me',
    storageUrl: 'https://app.example/alice/',
  },
  routeId: 'xpod-current-origin',
};

function seedRemembered(record: unknown = rememberedAlice) {
  window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify(record));
}

async function clickButton(container: HTMLElement, label: RegExp) {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => label.test(candidate.textContent ?? ''));
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
}

describe('WebIdAuthBoundary', () => {
  test('offers only the current-origin Xpod transaction when anonymous', async () => {
    const runtime = runtimeWith();
    const rendered = await render(runtime);

    expect(rendered.container.querySelector('[data-auth-surface-presentation="compact"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="xpod-login-brand"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="webid-login-route-scroll"]')).toBeNull();
    expect(rendered.container.textContent).toContain('使用 WebID 登录');
    expect(rendered.container.textContent).not.toContain('app.example');
    expect(rendered.container.textContent).not.toContain('连接 Xpod');
    expect(rendered.container.textContent).not.toMatch(/cloud|provider|issuer|add provider/i);
    const button = rendered.container.querySelector('button');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(rendered.auth.startLogin).toHaveBeenCalledTimes(1);
    expect(runtime.login).not.toHaveBeenCalled();
    await unmount(rendered.root);
  });

  test('renders the remembered identity card when anonymous with a remembered login', async () => {
    const runtime = runtimeWith();
    const rendered = await render(runtime, () => seedRemembered());

    expect(rendered.container.querySelector('[data-auth-surface-presentation="compact"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="xpod-login-brand"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain('已记住的身份');
    expect(rendered.container.textContent).toContain('Alice Doe');
    await unmount(rendered.root);
  });

  test('starts the shared host login from the remembered card', async () => {
    const runtime = runtimeWith();
    const rendered = await render(runtime, () => seedRemembered());

    await clickButton(rendered.container, /使用 Alice Doe 登录/);
    expect(rendered.auth.startLogin).toHaveBeenCalledTimes(1);
    expect(runtime.login).not.toHaveBeenCalled();
    await unmount(rendered.root);
  });

  test('shows a remembered Cloud WebID profile without requiring an email or UI-origin Pod', async () => {
    const webId = 'https://id.example/alice/profile/card#me';
    const avatarUrl = 'https://local.nodes.example/alice/profile/avatar.png';
    const runtime = runtimeWith();
    const rendered = await render(runtime, () => seedRemembered({
      account: { displayName: 'Alice from Pod', avatarUrl },
      webId,
      storageBinding: { webId, storageUrl: 'https://local.nodes.example/alice/' },
      routeId: 'xpod-current-origin',
    }));

    expect(rendered.container.querySelector('[data-testid="xpod-login-brand"]')).toBeNull();
    expect(rendered.container.querySelector('img')?.getAttribute('src')).toBe(avatarUrl);
    expect(rendered.container.textContent).toContain('Alice from Pod');
    expect(rendered.container.textContent).not.toContain('id.example');
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    await clickButton(rendered.container, /使用 Alice from Pod 登录/);
    expect(rendered.auth.startLogin).toHaveBeenCalledTimes(1);
    await unmount(rendered.root);
  });

  test('does not render a remembered identity when nothing is remembered', async () => {
    const runtime = runtimeWith();
    const rendered = await render(runtime);

    expect(rendered.container.textContent).not.toContain('已记住的身份');
    expect(rendered.container.textContent).not.toContain('Alice Doe');
    await unmount(rendered.root);
  });

  test('shows the remembered identity on an expired session with a matching WebID', async () => {
    const runtime = runtimeWith({
      state: { status: 'expired', webId: 'https://app.example/alice#me' },
    } as RuntimeWithBinding);
    const rendered = await render(runtime, () => seedRemembered());

    expect(rendered.container.textContent).toContain('会话已过期');
    expect(rendered.container.textContent).toContain('Alice Doe');
    await clickButton(rendered.container, /重新登录 Alice Doe/);
    expect(rendered.auth.retryLogin).toHaveBeenCalledTimes(1);
    expect(runtime.login).not.toHaveBeenCalled();
    await unmount(rendered.root);
  });

  test('hides the remembered identity when the expired WebID does not match', async () => {
    const runtime = runtimeWith({
      state: { status: 'expired', webId: 'https://app.example/bob#me' },
    } as RuntimeWithBinding);
    const rendered = await render(runtime, () => seedRemembered());

    expect(rendered.container.textContent).toContain('会话已过期');
    expect(rendered.container.textContent).not.toContain('Alice Doe');
    await unmount(rendered.root);
  });

  test('waits for the current Pod before rendering Pod-backed children', async () => {
    const runtime = runtimeWith({
      state: { status: 'authenticated', webId: 'https://app.example/alice#me' },
      webId: 'https://app.example/alice#me',
    });
    const rendered = await render(runtime);
    expect(rendered.container.textContent).toContain('正在打开选中的 Pod。');
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    await unmount(rendered.root);
  });

  test('keeps an authenticated WebID and shows a storage conflict when the Pod binding mismatches', async () => {
    const runtime = runtimeWith({
      state: { status: 'authenticated', webId: 'https://app.example/bob#me' },
      webId: 'https://app.example/bob#me',
      currentPod: {
        webId: 'https://app.example/alice#me',
        podUrl: 'https://app.example/alice/',
      } as XpodSolidRuntimeValue['currentPod'],
      selectedStorage: {
        webId: 'https://app.example/alice#me',
        storageUrl: 'https://app.example/alice/',
      },
    } as RuntimeWithBinding);
    const rendered = await render(runtime);
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    expect(rendered.container.textContent).toContain('当前 WebID 已登录，但选中的 Pod 与该身份不一致。');
    expect(rendered.container.textContent).not.toContain('连接 Xpod');
    await unmount(rendered.root);
  });

  test('does not render a Pod whose URL differs from the current selected local binding', async () => {
    const runtime = runtimeWith({
      state: { status: 'authenticated', webId: 'https://app.example/alice#me' },
      webId: 'https://app.example/alice#me',
      currentPod: {
        webId: 'https://app.example/alice#me',
        podUrl: 'https://app.example/alice/',
      } as XpodSolidRuntimeValue['currentPod'],
      selectedStorage: {
        webId: 'https://app.example/alice#me',
        storageUrl: 'https://app.example/bob/',
      },
    } as RuntimeWithBinding);
    const rendered = await render(runtime);
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    expect(rendered.container.textContent).toContain('当前 WebID 已登录，但选中的 Pod 与该身份不一致。');
    await unmount(rendered.root);
  });

  test('renders Pod-backed children once the host reports a current Pod', async () => {
    const runtime = runtimeWith({
      state: { status: 'authenticated', webId: 'https://app.example/alice#me' },
      webId: 'https://app.example/alice#me',
      currentPod: {
        webId: 'https://app.example/alice#me',
        podUrl: 'https://app.example/alice/',
      } as XpodSolidRuntimeValue['currentPod'],
      selectedStorage: {
        webId: 'https://app.example/alice#me',
        storageUrl: 'https://app.example/alice/',
      },
    });
    const rendered = await render(runtime);
    expect(rendered.container.querySelector('[data-testid="protected"]')?.textContent).toBe('ready');
    await unmount(rendered.root);
  });

  test('reports a Pod open failure at the storage step and retries the Pod instead of a re-login', async () => {
    const retryPodOpen = vi.fn();
    const runtime = runtimeWith({
      state: { status: 'authenticated', webId: 'https://app.example/alice#me' },
      webId: 'https://app.example/alice#me',
      podError: { webId: 'https://app.example/alice#me', error: new Error('socket hangup') },
      retryPodOpen,
    });
    const rendered = await render(runtime);

    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    expect(rendered.container.textContent).toContain('无法打开选中的 Pod，请重试。');
    // The WebID session is still valid: no login copy and no raw error leak.
    expect(rendered.container.textContent).not.toContain('连接 Xpod');
    expect(rendered.container.textContent).not.toContain('socket hangup');

    await clickButton(rendered.container, /重试/);
    expect(retryPodOpen).toHaveBeenCalledTimes(1);
    expect(rendered.auth.retryLogin).not.toHaveBeenCalled();
    await unmount(rendered.root);
  });

  test('surfaces a failed login start with a cancel entry instead of failing silently', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtime = runtimeWith();
    const auth = authValue({
      startLogin: vi.fn(async () => {
        throw new Error('An Xpod login transaction is already pending in this tab');
      }),
    });
    const rendered = await render(runtime, undefined, auth);

    await clickButton(rendered.container, /^登录$/);
    expect(rendered.container.textContent).toContain('操作未完成，请重试。');
    expect(consoleError).toHaveBeenCalled();

    await clickButton(rendered.container, /取消当前登录/);
    expect(auth.cancelLogin).toHaveBeenCalledTimes(1);
    expect(rendered.container.textContent).not.toContain('操作未完成，请重试。');
    consoleError.mockRestore();
    await unmount(rendered.root);
  });

  test('surfaces an incomplete switch-account logout instead of failing silently', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtime = runtimeWith({
      state: { status: 'expired', webId: 'https://app.example/alice#me' },
    } as RuntimeWithBinding);
    const auth = authValue({
      switchAccount: vi.fn(async () => ({ status: 'error', account: 'error', webId: 'complete' } as const)),
    });
    const rendered = await render(runtime, () => seedRemembered(), auth);

    await clickButton(rendered.container, /切换账号/);
    expect(auth.switchAccount).toHaveBeenCalledTimes(1);
    expect(rendered.container.textContent).toContain('操作未完成，请重试。');
    consoleError.mockRestore();
    await unmount(rendered.root);
  });

  test('uses the remembered avatar instead of the Xpod brand', async () => {
    const rendered = await render(runtimeWith(), () => seedRemembered({
      ...rememberedAlice,
      account: { ...rememberedAlice.account, avatarUrl: 'https://app.example/alice.png' },
    }));
    const avatar = rendered.container.querySelector('img');
    expect(avatar?.getAttribute('alt')).toBe('Alice Doe');
    expect(avatar?.getAttribute('src')).toBe('https://app.example/alice.png');
    expect(avatar?.className).toContain('h-16 w-16');
    expect(rendered.container.querySelector('[data-testid="xpod-login-brand"]')).toBeNull();
    await unmount(rendered.root);
  });

  test.each([false, true])('keeps the compact card while restoring, remembered=%s', async (remembered) => {
    const rendered = await render(runtimeWith({ state: { status: 'loading' } }), () => {
      if (remembered) seedRemembered();
    });
    expect(rendered.container.querySelector('[data-auth-surface-presentation="compact"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain('正在恢复 Xpod 会话');
    expect(rendered.container.querySelector('button')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    expect(rendered.container.textContent?.includes('Alice Doe')).toBe(remembered);
    expect(Boolean(rendered.container.querySelector('[data-testid="xpod-login-brand"]'))).toBe(!remembered);
    await unmount(rendered.root);
  });

  test('keeps a single compact error card without exposing the main app', async () => {
    const rendered = await render(runtimeWith({
      state: { status: 'error', error: new Error('无法恢复会话，请重试。') },
    }));
    expect(rendered.container.querySelectorAll('[data-auth-surface-presentation="compact"]')).toHaveLength(1);
    expect(rendered.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(rendered.container.textContent).toContain('无法恢复会话，请重试。');
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    await clickButton(rendered.container, /重试/);
    expect(rendered.auth.retryLogin).toHaveBeenCalledTimes(1);
    await unmount(rendered.root);
  });

  test('keeps the compact card during login and ignores a cancelled action failure', async () => {
    let rejectLogin: (error: Error) => void = () => undefined;
    const auth = authValue({
      startLogin: vi.fn(() => new Promise((_resolve, reject) => { rejectLogin = reject; })),
    });
    const rendered = await render(runtimeWith(), undefined, auth);
    await clickButton(rendered.container, /^登录$/);
    expect(rendered.container.querySelector('[data-auth-surface-presentation="compact"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain('正在登录…');
    expect(rendered.container.querySelector('[data-testid="webid-login-entry"]')).toBeNull();
    await clickButton(rendered.container, /^取消$/);
    expect(auth.cancelLogin).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector('[data-testid="webid-login-entry"]')).not.toBeNull();
    await act(async () => rejectLogin(new Error('cancelled late')));
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await unmount(rendered.root);
  });

  test('fills the native login window without drawing another card frame', async () => {
    const previous = globalThis.xpodDesktop;
    globalThis.xpodDesktop = { platform: 'darwin' } as typeof globalThis.xpodDesktop;
    try {
      const rendered = await render(runtimeWith());
      expect(rendered.container.querySelector('[data-auth-surface-frame="window"]')).not.toBeNull();
      expect(rendered.container.querySelector('[data-auth-surface-host="window"]')).not.toBeNull();
      expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
      await unmount(rendered.root);
    } finally {
      globalThis.xpodDesktop = previous;
    }
  });
});
