import { describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { XpodSolidRuntimeValue } from '../../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../../solid/XpodSolidRuntime';
import PodPage from './PodPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

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

async function renderPodPage(runtime: XpodSolidRuntimeValue) {
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodSolidRuntimeContext.Provider value={runtime}>
        <PodPage />
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

function runtimeWith(fetchImpl: typeof fetch): XpodSolidRuntimeValue {
  return {
    session: {
      fetch: fetchImpl,
      getSnapshot: () => ({ status: 'authenticated', webId: WEB_ID }),
      subscribe: () => () => undefined,
    } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: fetchImpl,
    state: { status: 'authenticated', webId: WEB_ID, podUrl: POD_URL },
    webId: WEB_ID,
    podUrl: POD_URL,
    currentPod: { podUrl: POD_URL } as XpodSolidRuntimeValue['currentPod'],
    login: mock(async () => undefined),
    logout: mock(async () => undefined),
  };
}

describe('PodPage', () => {
  test('renders real runtime identity, available usage, AI status, and safe actions', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://pod.example/api/pod/settings/status');
      return new Response(JSON.stringify({
        identity: { webId: WEB_ID, podUrl: POD_URL },
        storage: {
          status: 'available',
          usage: { storageBytes: 12_582_912, ingressBytes: 2048, egressBytes: 4096 },
          limits: { storageLimitBytes: 104_857_600, bandwidthLimitBps: null },
          source: 'identity_usage',
        },
        aiConnection: {
          status: 'available',
          containerUrl: 'https://pod.example/alice/settings/credentials.ttl',
          configuredProviders: 2,
          lastSyncAt: '2026-07-31T03:04:05.000Z',
          source: 'drizzle-solid',
        },
        generatedAt: '2026-07-31T03:05:00.000Z',
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const runtime = runtimeWith(fetchImpl);

    const { container, root } = await renderPodPage(runtime);

    expect(container.querySelector('[data-workspace-layout="two-pane"]')).toBeTruthy();
    expect(container.textContent).toContain(WEB_ID);
    expect(container.textContent).toContain(POD_URL);
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
});
