import { describe, expect, test, vi } from 'vitest';

const mock = vi.fn;
import { JSDOM } from 'jsdom';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { XpodSolidRuntimeValue } from '../../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../../solid/XpodSolidRuntime';
import PodPage from './PodPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';
const ISSUER_URL = 'https://issuer.identity.example/';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://pod.example/dashboard/pod',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  window.open = mock(() => null) as unknown as typeof window.open;
  window.matchMedia = mock(() => ({
    matches: false,
    media: '(max-width: 767px)',
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
  })) as unknown as typeof window.matchMedia;
}

async function renderPodPage(runtime: XpodSolidRuntimeValue, view: 'combined' | 'settings' | 'usage' = 'combined') {
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodSolidRuntimeContext.Provider value={runtime}>
        <PodPage view={view} />
      </XpodSolidRuntimeContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

function createStatus({
  webId = WEB_ID,
  podUrl = POD_URL,
  providers = 2,
  containerUrl = 'https://pod.example/alice/settings/credentials.ttl',
}: {
  webId?: string;
  podUrl?: string;
  providers?: number;
  containerUrl?: string;
} = {}) {
  return {
    identity: { webId, podUrl },
    storage: {
      status: 'available',
      usage: { storageBytes: 12_582_912, ingressBytes: 2048, egressBytes: 4096 },
      limits: { storageLimitBytes: 104_857_600, bandwidthLimitBps: null },
      source: 'identity_usage',
    },
    aiConnection: {
      status: 'available',
      containerUrl,
      configuredProviders: providers,
      lastSyncAt: '2026-07-31T03:04:05.000Z',
      source: 'drizzle-solid',
    },
    generatedAt: '2026-07-31T03:05:00.000Z',
  };
}

function deferredResponse(body: unknown) {
  let resolve!: () => void;
  const promise = new Promise<Response>((done) => {
    resolve = () => done(new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }));
  });
  return { promise, resolve };
}

function deferredFetch(body: unknown) {
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const fetchImpl = mock(async () => {
    await gate;
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl, resolve };
}

function runtimeWith(fetchImpl: typeof fetch, overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
  const webId = overrides.webId ?? WEB_ID;
  const podUrl = overrides.podUrl ?? POD_URL;
  return {
    session: {
      fetch: fetchImpl,
      getSnapshot: () => ({ status: 'authenticated', webId }),
      subscribe: () => () => undefined,
    } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: fetchImpl,
    state: { status: 'authenticated', webId, podUrl },
    webId,
    podUrl,
    issuer: ISSUER_URL,
    currentPod: { podUrl } as XpodSolidRuntimeValue['currentPod'],
    login: mock(async () => undefined),
    logout: mock(async () => undefined),
    ...overrides,
  };
}

describe('PodPage', () => {
  test('separates identity settings from usage observability', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify(createStatus()), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const settings = await renderPodPage(runtimeWith(fetchImpl), 'settings');
    expect(settings.container.textContent).toContain('Identity');
    expect(settings.container.textContent).not.toContain('Current Pod quota view');
    expect(settings.container.querySelector('a[href="/dashboard/usage"]')).toBeTruthy();
    await unmount(settings.root);

    const usage = await renderPodPage(runtimeWith(fetchImpl), 'usage');
    expect(usage.container.textContent).toContain('Current Pod quota view');
    expect(usage.container.textContent).not.toContain('Current Solid session');
    expect(usage.container.querySelector('a[href="/settings/pod"]')).toBeTruthy();
    await unmount(usage.root);
  });

  test('renders real runtime identity, available usage, AI status, and safe actions', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://pod.example/api/pod/settings/status');
      return new Response(JSON.stringify(createStatus()), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const runtime = runtimeWith(fetchImpl);

    const { container, root } = await renderPodPage(runtime);

    expect(container.querySelector('[data-workspace-layout="two-pane"]')).toBeTruthy();
    expect(container.textContent).toContain(WEB_ID);
    expect(container.textContent).toContain(POD_URL);
    expect(container.textContent).toContain(ISSUER_URL);
    expect(container.textContent).toContain('12 MB');
    expect(container.textContent).toContain('100 MB limit');
    expect(container.textContent).toContain('2 providers');
    expect(container.textContent).toContain('Last sync');

    const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Open Pod'));
    expect(openButton).toBeTruthy();
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.open).toHaveBeenCalledWith(POD_URL, '_blank', 'noopener,noreferrer');

    await unmount(root);
  });

  test('does not fake missing usage as zero and shows partial errors clearly', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({
      identity: { webId: WEB_ID, podUrl: POD_URL },
      storage: { status: 'unsupported', reason: 'usage_not_available' },
      aiConnection: { status: 'error', reason: 'service_access_missing' },
      generatedAt: '2026-07-31T03:05:00.000Z',
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const { container, root } = await renderPodPage(runtimeWith(fetchImpl));

    expect(container.textContent).toContain('Usage unsupported');
    expect(container.textContent).toContain('AI Connection unavailable');
    expect(container.textContent).not.toContain('0 B used');

    await unmount(root);
  });

  test('login again uses the Solid runtime issuer instead of guessing from WebID or Pod URL', async () => {
    const splitWebId = 'https://id.example/alice/profile/card#me';
    const splitPodUrl = 'https://storage.example/alice/';
    const fetchImpl = mock(async () => new Response(JSON.stringify({
      identity: { webId: splitWebId, podUrl: splitPodUrl },
      storage: { status: 'unsupported', reason: 'usage_not_available' },
      aiConnection: { status: 'unsupported', reason: 'not_configured' },
      generatedAt: '2026-07-31T03:05:00.000Z',
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const runtime = {
      ...runtimeWith(fetchImpl),
      state: { status: 'authenticated', webId: splitWebId, podUrl: splitPodUrl },
      webId: splitWebId,
      podUrl: splitPodUrl,
      issuer: 'https://issuer.identity.example/',
      currentPod: { podUrl: splitPodUrl } as XpodSolidRuntimeValue['currentPod'],
      login: mock(async () => undefined),
    } satisfies XpodSolidRuntimeValue;

    const { container, root } = await renderPodPage(runtime);
    const loginButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Login again'));
    if (!loginButton) throw new Error('missing login again button');

    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(runtime.login).toHaveBeenCalledWith('https://issuer.identity.example/');
    expect(runtime.login).not.toHaveBeenCalledWith('https://id.example');
    expect(runtime.login).not.toHaveBeenCalledWith('https://storage.example');
    await unmount(root);
  });

  test('keeps WebID, Pod, and issuer visually separate for split identity deployments', async () => {
    const splitWebId = 'https://id.example/alice/profile/card#me';
    const splitPodUrl = 'https://storage.example/alice/';
    const splitIssuer = 'https://issuer.identity.example/';
    const fetchImpl = mock(async () => new Response(JSON.stringify(createStatus({
      webId: splitWebId,
      podUrl: splitPodUrl,
      containerUrl: 'https://storage.example/alice/settings/credentials.ttl',
    })), { headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const { container, root } = await renderPodPage(runtimeWith(fetchImpl, {
      webId: splitWebId,
      podUrl: splitPodUrl,
      issuer: splitIssuer,
      state: { status: 'authenticated', webId: splitWebId, podUrl: splitPodUrl },
      currentPod: { podUrl: splitPodUrl } as XpodSolidRuntimeValue['currentPod'],
    }));

    expect(container.textContent).toContain('WebID');
    expect(container.textContent).toContain(splitWebId);
    expect(container.textContent).toContain('Pod');
    expect(container.textContent).toContain(splitPodUrl);
    expect(container.textContent).toContain('Issuer');
    expect(container.textContent).toContain(splitIssuer);
    await unmount(root);
  });

  test('loads the real status response after StrictMode remount cleanup', async () => {
    installDom();
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    const response = deferredFetch(createStatus({
      providers: 5,
      containerUrl: 'https://pod.example/alice/settings/strict-mode.ttl',
    }));
    const runtime = runtimeWith(response.fetchImpl as typeof fetch);

    await act(async () => {
      root.render(
        <StrictMode>
          <XpodSolidRuntimeContext.Provider value={runtime}>
            <PodPage />
          </XpodSolidRuntimeContext.Provider>
        </StrictMode>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(response.fetchImpl.mock.calls).toHaveLength(1);

    await act(async () => {
      response.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('5 providers');
    expect(container.textContent).toContain('https://pod.example/alice/settings/strict-mode.ttl');
    expect(container.textContent).not.toContain('Usage unsupported');
    expect(container.textContent).not.toContain('Refreshing usage');
    await unmount(root);
  });

  test('ignores stale status responses after identity changes', async () => {
    installDom();
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    const aWebId = 'https://id.example/alice/profile/card#me';
    const aPodUrl = 'https://pod-a.example/alice/';
    const bWebId = 'https://id.example/bob/profile/card#me';
    const bPodUrl = 'https://pod-b.example/bob/';
    const aResponse = deferredResponse(createStatus({
      webId: aWebId,
      podUrl: aPodUrl,
      providers: 1,
      containerUrl: 'https://pod-a.example/alice/settings/credentials.ttl',
    }));
    const bResponse = deferredResponse(createStatus({
      webId: bWebId,
      podUrl: bPodUrl,
      providers: 7,
      containerUrl: 'https://pod-b.example/bob/settings/credentials.ttl',
    }));
    const runtimeA = runtimeWith(mock(() => aResponse.promise) as typeof fetch, {
      webId: aWebId,
      podUrl: aPodUrl,
      state: { status: 'authenticated', webId: aWebId, podUrl: aPodUrl },
      currentPod: { podUrl: aPodUrl } as XpodSolidRuntimeValue['currentPod'],
    });
    const runtimeB = runtimeWith(mock(() => bResponse.promise) as typeof fetch, {
      webId: bWebId,
      podUrl: bPodUrl,
      state: { status: 'authenticated', webId: bWebId, podUrl: bPodUrl },
      currentPod: { podUrl: bPodUrl } as XpodSolidRuntimeValue['currentPod'],
    });

    await act(async () => {
      root.render(
        <XpodSolidRuntimeContext.Provider value={runtimeA}>
          <PodPage />
        </XpodSolidRuntimeContext.Provider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root.render(
        <XpodSolidRuntimeContext.Provider value={runtimeB}>
          <PodPage />
        </XpodSolidRuntimeContext.Provider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      bResponse.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain(bWebId);
    expect(container.textContent).toContain(bPodUrl);
    expect(container.textContent).toContain('7 providers');
    expect(container.textContent).not.toContain(aPodUrl);
    expect(container.textContent).not.toContain('1 providers');

    await act(async () => {
      aResponse.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain(bWebId);
    expect(container.textContent).toContain(bPodUrl);
    expect(container.textContent).toContain('7 providers');
    expect(container.textContent).not.toContain(aWebId);
    expect(container.textContent).not.toContain(aPodUrl);
    expect(container.textContent).not.toContain('1 providers');
    await unmount(root);
  });
});
