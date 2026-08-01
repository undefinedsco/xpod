import { describe, expect, test, vi } from 'vitest';

const mock = vi.fn;
import { JSDOM } from 'jsdom';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { XpodSolidRuntimeValue } from '../../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../../solid/XpodSolidRuntime';
import NetworkPage from './NetworkPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://pod.example/dashboard/network',
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

async function renderNetworkPage(runtime: XpodSolidRuntimeValue) {
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodSolidRuntimeContext.Provider value={runtime}>
        <NetworkPage />
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

function createStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    endpoint: 'https://xpod.example/',
    addresses: {
      local: ['http://127.0.0.1:3000/'],
      lan: ['http://192.168.1.24:3000/'],
      public: ['https://xpod.example/'],
    },
    tls: { supported: true, status: 'valid', expiresAt: '2026-10-31T00:00:00.000Z' },
    dns: { supported: false, status: 'unsupported' },
    tunnel: { supported: true, status: 'active' },
    actions: { diagnose: true, renewCertificate: false },
    ...overrides,
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
    issuer: 'https://issuer.identity.example/',
    currentPod: { podUrl } as XpodSolidRuntimeValue['currentPod'],
    login: mock(async () => undefined),
    logout: mock(async () => undefined),
    ...overrides,
  };
}

describe('NetworkPage', () => {
  test('links network status to its canonical Settings configuration', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify(createStatus()), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const { container, root } = await renderNetworkPage(runtimeWith(fetchImpl));

    expect(container.querySelector('a[href="/settings/network"]')).toBeTruthy();
    await unmount(root);
  });

  test('renders live network status and only allowed actions', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://pod.example/api/network/settings/status');
      return new Response(JSON.stringify(createStatus()), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const { container, root } = await renderNetworkPage(runtimeWith(fetchImpl));

    expect(container.querySelector('[data-workspace-layout="two-pane"]')).toBeTruthy();
    expect(container.textContent).toContain('https://xpod.example/');
    expect(container.textContent).toContain('http://127.0.0.1:3000/');
    expect(container.textContent).toContain('http://192.168.1.24:3000/');
    expect(container.textContent).toContain('TLS');
    expect(container.textContent).toContain('valid');
    expect(container.textContent).toContain('DNS unsupported');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Diagnose'))).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Renew certificate'))).toBe(false);
    await unmount(root);
  });

  test('runs diagnose through the API and renders structured per-check results', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/network/settings/diagnose')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          checks: [
            { id: 'endpoint', label: 'Endpoint', status: 'ok', detail: 'reachable' },
            { id: 'dns', label: 'DNS', status: 'unsupported', detail: 'unsupported' },
          ],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(createStatus()), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { container, root } = await renderNetworkPage(runtimeWith(fetchImpl));

    const diagnoseButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Diagnose'));
    if (!diagnoseButton) throw new Error('missing diagnose action');
    await act(async () => {
      diagnoseButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.textContent).toContain('Endpoint');
    expect(container.textContent).toContain('reachable');
    expect(container.textContent).toContain('DNS');
    expect(container.textContent).toContain('unsupported');
    await unmount(root);
  });

  test('renews a certificate, refreshes status, and restores the action button', async () => {
    let statusCalls = 0;
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/network/settings/certificate/renew')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
      }
      statusCalls += 1;
      return new Response(JSON.stringify(createStatus({
        endpoint: statusCalls === 1 ? 'https://before.example/' : 'https://after.example/',
        actions: { diagnose: true, renewCertificate: true },
      })), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { container, root } = await renderNetworkPage(runtimeWith(fetchImpl));

    expect(container.textContent).toContain('https://before.example/');
    const renewButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Renew certificate')) as HTMLButtonElement | undefined;
    if (!renewButton) throw new Error('missing renew certificate action');

    await act(async () => {
      renewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(container.textContent).toContain('https://after.example/');
    expect(renewButton.disabled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith('https://pod.example/api/network/settings/certificate/renew', expect.objectContaining({ method: 'POST' }));
    await unmount(root);
  });

  test('keeps diagnose and renew actions independent when their requests overlap', async () => {
    const diagnoseResponse = deferredResponse({
      checks: [
        { id: 'dns', label: 'DNS', status: 'ok', detail: 'synced' },
      ],
    });
    let statusCalls = 0;
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/network/settings/diagnose')) {
        expect(init?.method).toBe('POST');
        return diagnoseResponse.promise;
      }
      if (String(input).endsWith('/api/network/settings/certificate/renew')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ success: true, status: 'renewed' }), { headers: { 'content-type': 'application/json' } });
      }
      statusCalls += 1;
      return new Response(JSON.stringify(createStatus({
        endpoint: statusCalls === 1 ? 'https://before.example/' : 'https://after.example/',
        actions: { diagnose: true, renewCertificate: true },
      })), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { container, root } = await renderNetworkPage(runtimeWith(fetchImpl));

    const diagnoseButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Diagnose')) as HTMLButtonElement | undefined;
    const renewButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Renew certificate')) as HTMLButtonElement | undefined;
    if (!diagnoseButton || !renewButton) throw new Error('missing network actions');

    await act(async () => {
      diagnoseButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(diagnoseButton.disabled).toBe(true);

    await act(async () => {
      renewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(renewButton.disabled).toBe(false);

    await act(async () => {
      diagnoseResponse.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.textContent).toContain('https://after.example/');
    expect(container.textContent).toContain('synced');
    expect(diagnoseButton.disabled).toBe(false);
    expect(renewButton.disabled).toBe(false);
    await unmount(root);
  });

  test('ignores stale status responses after identity changes and StrictMode remounts', async () => {
    installDom();
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    const aResponse = deferredResponse(createStatus({ endpoint: 'https://old.example/' }));
    const bResponse = deferredResponse(createStatus({ endpoint: 'https://new.example/' }));
    const runtimeA = runtimeWith(mock(() => aResponse.promise) as typeof fetch);
    const runtimeB = runtimeWith(mock(() => bResponse.promise) as typeof fetch, {
      webId: 'https://pod.example/bob/profile/card#me',
      podUrl: 'https://pod-b.example/bob/',
      state: { status: 'authenticated', webId: 'https://pod.example/bob/profile/card#me', podUrl: 'https://pod-b.example/bob/' },
      currentPod: { podUrl: 'https://pod-b.example/bob/' } as XpodSolidRuntimeValue['currentPod'],
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <XpodSolidRuntimeContext.Provider value={runtimeA}>
            <NetworkPage />
          </XpodSolidRuntimeContext.Provider>
        </StrictMode>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root.render(
        <StrictMode>
          <XpodSolidRuntimeContext.Provider value={runtimeB}>
            <NetworkPage />
          </XpodSolidRuntimeContext.Provider>
        </StrictMode>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      bResponse.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('https://new.example/');
    expect(container.textContent).not.toContain('https://old.example/');

    await act(async () => {
      aResponse.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('https://new.example/');
    expect(container.textContent).not.toContain('https://old.example/');
    await unmount(root);
  });
});
