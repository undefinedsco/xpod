import { afterEach, describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { resolveXpodAccountIndex } from './resolve-xpod-account-index';
import { resolveProvisionCodeForCurrentScope, isManagedLocalProvisionHost } from '../utils/pod';

let dom: JSDOM | undefined;
function installDom(_fetch: unknown, url: string) {
  dom = new JSDOM('<!doctype html><html></html>', { url });
  vi.stubGlobal('window', dom.window);
}

afterEach(() => {
  vi.unstubAllGlobals();
  dom?.window.close();
});

describe('server-provided Account authority', () => {
  test('uses the server Account authority on a public alias without probing Local status', async () => {
    installDom(undefined, 'https://pods.undefineds.co/.account/create-pod/');
    window.__XPOD__ = { idpIndex: 'https://id.undefineds.co/.account/', authenticating: false };
    const fetchImpl = vi.fn();

    await expect(resolveXpodAccountIndex(fetchImpl as unknown as typeof fetch))
      .resolves.toBe('https://id.undefineds.co/.account/');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    'http://127.0.0.1:3000/.account/',
    'https://local-node.pods.example/.account/',
  ])('keeps Cloud discovery and provisioning on loopback with Local bootstrap %s', async (idpIndex) => {
    installDom(undefined, 'http://127.0.0.1:3000/.account/create-pod/');
    window.__XPOD__ = { idpIndex, authenticating: false };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      managed: true, registered: true,
      oidcIssuer: 'https://id.example/', provisionCode: 'local-host-code',
    })));

    await expect(resolveXpodAccountIndex(fetchImpl as unknown as typeof fetch))
      .resolves.toBe('https://id.example/.account/');
    await expect(resolveProvisionCodeForCurrentScope()).resolves.toBe('local-host-code');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://127.0.0.1:3000/provision/status');
  });

  test.each(['http://192.168.1.10:3000/status/overview', 'https://node.example/status/overview'])(
    'discovers managed identity on a Local alias: %s', async (url) => {
      installDom(undefined, url);
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        managed: true, registered: false, oidcIssuer: 'https://id.example/',
      })));
      await expect(resolveXpodAccountIndex(fetchImpl)).resolves.toBe('https://id.example/.account/');
      await expect(resolveProvisionCodeForCurrentScope()).rejects.toThrow();
    },
  );

  test.each([404, 200])('clears managed Local discovery when the same window becomes standalone (%s)', async (status) => {
    installDom(undefined, 'http://127.0.0.1:3000/status/overview');
    await resolveXpodAccountIndex(async () => new Response(JSON.stringify({ managed: true, oidcIssuer: 'https://id.example/' })));
    expect(isManagedLocalProvisionHost()).toBe(true);
    await resolveXpodAccountIndex(async () => new Response(status === 404 ? '' : JSON.stringify({ managed: false }), { status }));
    expect(isManagedLocalProvisionHost()).toBe(false);
  });

  test.each([
    'javascript:alert(1)',
    'https://user:secret@id.example/.account/',
    'https://id.example/other/',
    'https://id.example/.account/?target=elsewhere',
    'https://id.example/.account/#fragment',
  ])('rejects an invalid server Account bootstrap: %s', async (idpIndex) => {
    installDom(undefined, 'https://pods.example/.account/');
    window.__XPOD__ = { idpIndex, authenticating: false };
    const fetchImpl = vi.fn();
    await expect(resolveXpodAccountIndex(fetchImpl as unknown as typeof fetch)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

});
