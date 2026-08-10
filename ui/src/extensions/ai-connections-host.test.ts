import { describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { createXpodAiConnectionsHost } from './ai-connections-host';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://app.example/settings/models',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  dom.window.fetch = vi.fn(async () => new Response('ok')) as unknown as typeof dom.window.fetch;
}

function runtimeWith(login: XpodSolidRuntimeValue['login']): XpodSolidRuntimeValue {
  return {
    session: {
      getSnapshot: () => ({ status: 'anonymous' }),
      subscribe: () => () => undefined,
      fetch: vi.fn(async () => new Response('ok')),
    } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn(async () => new Response('ok')),
    state: { status: 'anonymous' },
    login,
    logout: vi.fn(async () => undefined),
  };
}

describe('Xpod AI Connections host', () => {
  test('starts the shared Xpod current-origin transaction without accepting an issuer', async () => {
    installDom();
    const login = vi.fn(async () => undefined);
    const host = createXpodAiConnectionsHost(runtimeWith(login));

    await host.solid.requireLogin();

    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      authorizationSurface: 'redirect',
      discovery: 'strict',
      route: expect.objectContaining({
        id: 'xpod-current-origin',
        identityProvider: expect.objectContaining({ url: 'https://app.example' }),
        storageProvider: expect.objectContaining({ url: 'https://app.example' }),
      }),
    }));
    expect(login).not.toHaveBeenCalledWith('https://app.example');
  });
});
