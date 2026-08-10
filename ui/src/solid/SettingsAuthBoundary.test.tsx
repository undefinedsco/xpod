import { describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { XpodSolidRuntimeValue } from './XpodSolidRuntime';
import { XpodSolidRuntimeContext } from './XpodSolidRuntime';
import { XpodPodReadinessBoundary } from './SettingsAuthBoundary';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/settings/pod',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
}

function runtimeWith(overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
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
  };
}

async function render(runtime: XpodSolidRuntimeValue) {
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodSolidRuntimeContext.Provider value={runtime}>
        <XpodPodReadinessBoundary>
          <span data-testid="protected">ready</span>
        </XpodPodReadinessBoundary>
      </XpodSolidRuntimeContext.Provider>,
    );
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

describe('XpodPodReadinessBoundary', () => {
  test('offers only the current-origin Xpod transaction when anonymous', async () => {
    const runtime = runtimeWith();
    const rendered = await render(runtime);

    expect(rendered.container.textContent).toContain('Xpod');
    expect(rendered.container.textContent).not.toMatch(/cloud|provider|issuer|add provider/i);
    const button = rendered.container.querySelector('button');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(runtime.login).toHaveBeenCalledWith(expect.objectContaining({
      route: expect.objectContaining({
        id: 'xpod-current-origin',
        identityProvider: expect.objectContaining({ url: 'https://app.example' }),
      }),
    }));
    await unmount(rendered.root);
  });

  test('waits for the current Pod before rendering Pod-backed children', async () => {
    const runtime = runtimeWith({
      state: { status: 'authenticated', webId: 'https://app.example/alice#me' },
      webId: 'https://app.example/alice#me',
    });
    const rendered = await render(runtime);
    expect(rendered.container.textContent).toContain('Preparing Pod');
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    await unmount(rendered.root);
  });

  test('renders Pod-backed children once the host reports a current Pod', async () => {
    const runtime = runtimeWith({
      state: { status: 'authenticated', webId: 'https://app.example/alice#me' },
      webId: 'https://app.example/alice#me',
      currentPod: { podUrl: 'https://app.example/alice/' } as XpodSolidRuntimeValue['currentPod'],
    });
    const rendered = await render(runtime);
    expect(rendered.container.querySelector('[data-testid="protected"]')?.textContent).toBe('ready');
    await unmount(rendered.root);
  });
});
