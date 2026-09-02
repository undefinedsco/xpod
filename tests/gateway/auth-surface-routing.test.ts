import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort, GatewayProxy } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

describe('GatewayProxy auth surface routing', () => {
  let api: http.Server;
  let css: http.Server;
  let proxy: GatewayProxy;
  let proxyPort: number;

  beforeAll(async () => {
    const apiPort = await getFreePort(46600, '127.0.0.1');
    const cssPort = await getFreePort(apiPort + 1, '127.0.0.1');
    proxyPort = await getFreePort(cssPort + 1, '127.0.0.1');
    api = http.createServer((req, res) => {
      res.statusCode = 200;
      res.end(`api:${req.url}`);
    });
    css = http.createServer((req, res) => {
      res.statusCode = 200;
      res.end(`css:${req.url}`);
    });
    await listen(api, apiPort);
    await listen(css, cssPort);
    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1');
    proxy.setTargets({ api: `http://127.0.0.1:${apiPort}`, css: `http://127.0.0.1:${cssPort}` });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await close(api);
    await close(css);
  });

  for (const pathname of [
    '/dashboard',
    '/status',
    '/network',
    '/settings',
    '/ai-config',
    '/ai-connections',
  ]) {
    it(`routes ${pathname} with a query to API without rewriting it`, async () => {
      const query = '?transaction=tx-123&code=code-456&state=state-789';
      const response = await fetch(`http://127.0.0.1:${proxyPort}${pathname}${query}`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`api:${pathname}${query}`);
    });
  }

  it('routes the exact callback, theme bootstrap and assets to API while preserving the full query', async () => {
    const query = '?transaction=tx-123&code=code-456&state=state-789';
    const callback = await fetch(`http://127.0.0.1:${proxyPort}/auth/callback${query}`);
    expect(await callback.text()).toBe(`api:/auth/callback${query}`);

    const asset = await fetch(`http://127.0.0.1:${proxyPort}/auth/callback/assets/callback.js${query}`);
    expect(await asset.text()).toBe(`api:/auth/callback/assets/callback.js${query}`);

    const theme = await fetch(`http://127.0.0.1:${proxyPort}/auth/callback/theme-init.js${query}`);
    expect(await theme.text()).toBe(`api:/auth/callback/theme-init.js${query}`);
  });

  for (const pathname of [
    '/.account/',
    '/.account/oidc/consent/',
    '/.oidc/authorize',
    '/.oidc/token',
    '/alice/profile/card',
    '/auth/callback/',
  ]) {
    it(`keeps ${pathname} on CSS`, async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${pathname}?q=1`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`css:${pathname}?q=1`);
    });
  }
});

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()));
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
