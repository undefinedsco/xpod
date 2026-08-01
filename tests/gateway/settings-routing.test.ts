import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort, GatewayProxy } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

describe('GatewayProxy Settings routing', () => {
  let api: http.Server;
  let css: http.Server;
  let proxy: GatewayProxy;
  let proxyPort: number;

  beforeAll(async () => {
    const apiPort = await getFreePort(46500, '127.0.0.1');
    const cssPort = await getFreePort(apiPort + 1, '127.0.0.1');
    proxyPort = await getFreePort(cssPort + 1, '127.0.0.1');
    api = http.createServer((req, res) => res.end(`api:${req.url}`));
    css = http.createServer((req, res) => res.end(`css:${req.url}`));
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

  for (const pathname of ['/settings', '/settings/', '/settings/models', '/settings/assets/main.js']) {
    it(`routes ${pathname} to the API web product server`, async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${pathname}`);
      expect(await response.text()).toBe(`api:${pathname}`);
    });
  }
});

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()));
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
