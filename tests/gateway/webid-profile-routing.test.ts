import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort, GatewayProxy } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

describe('GatewayProxy WebID profile routing', () => {
  let api: http.Server;
  let css: http.Server;
  let proxy: GatewayProxy;
  let proxyPort: number;
  const seenByApi: string[] = [];
  const seenByCss: string[] = [];

  beforeAll(async () => {
    const apiPort = await getFreePort(46100, '127.0.0.1');
    const cssPort = await getFreePort(apiPort + 1, '127.0.0.1');
    proxyPort = await getFreePort(cssPort + 1, '127.0.0.1');

    api = http.createServer((req, res) => {
      seenByApi.push(req.url ?? '/');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('api');
    });

    css = http.createServer((req, res) => {
      seenByCss.push(req.url ?? '/');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('css');
    });

    await listen(api, apiPort);
    await listen(css, cssPort);

    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1');
    proxy.setTargets({
      api: `http://127.0.0.1:${apiPort}`,
      css: `http://127.0.0.1:${cssPort}`,
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await close(api);
    await close(css);
  });

  it('routes hosted WebID profile documents to CSS', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/ganbb/profile/card`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('css');
    expect(seenByCss).toContain('/ganbb/profile/card');
    expect(seenByApi).not.toContain('/ganbb/profile/card');
  });

  it('continues routing ordinary Pod resources to CSS', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/ganbb/.data/sessions/index.ttl`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('css');
    expect(seenByCss).toContain('/ganbb/.data/sessions/index.ttl');
  });
});

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
