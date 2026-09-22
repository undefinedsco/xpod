import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort, GatewayProxy } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

/**
 * `/service/*` exposes logs and service control. Reaching the Gateway through a tunnel must
 * not be enough to use it: the gate is authority, not address. Both of the proxy's listeners
 * are exercised, because the ingress listener is what a tunnel forwards to.
 */
describe('service endpoints require operator authority', () => {
  let proxy: GatewayProxy;
  let proxyPort: number;
  let ingressPort: number;

  beforeAll(async () => {
    proxyPort = await getFreePort(46500, '127.0.0.1');
    ingressPort = await getFreePort(proxyPort + 1, '127.0.0.1');
    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1', {
      internalAdminAuthSecret: 'service-gate-secret',
      ingressPort,
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
  });

  async function status(port: number, path: string, method = 'GET'): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    await response.arrayBuffer();
    return response.status;
  }

  it('serves the entry probe to anyone: it is how a client checks the entry', async () => {
    expect(await status(ingressPort, '/service/status')).toBe(200);
    expect(await status(proxyPort, '/service/status')).toBe(200);
  });

  it('refuses logs and service control from the tunnel entry', async () => {
    expect(await status(ingressPort, '/service/logs')).toBe(403);
    expect(await status(ingressPort, '/service/restart/css', 'POST')).toBe(403);
    expect(await status(ingressPort, '/service/stop', 'POST')).toBe(403);
  });

  it('refuses them when a forwarding header marks the caller as remote', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/service/logs`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(403);
  });

  it('keeps them available to a caller on this machine', async () => {
    expect(await status(proxyPort, '/service/logs')).toBe(200);
  });
});

describe('the internal Pod-data channel does not exist', () => {
  it('does not serve Pod data through /.internal/pod-data on either listener', async () => {
    const proxyPort = await getFreePort(46600, '127.0.0.1');
    const ingressPort = await getFreePort(proxyPort + 1, '127.0.0.1');
    const cssPort = await getFreePort(ingressPort + 1, '127.0.0.1');
    // Stand-in for today's CSS: the deleted route is just an unknown path, so it is a
    // plain 404. A 200 here would mean the Gateway itself served the internal channel.
    const css = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve, reject) => {
      css.listen(cssPort, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve());
    });
    const proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1', {
      internalAdminAuthSecret: 'internal-pod-secret',
      ingressPort,
    });
    proxy.setTargets({ css: `http://127.0.0.1:${cssPort}` });
    await proxy.start();
    try {
      for (const port of [proxyPort, ingressPort]) {
        const response = await fetch(`http://127.0.0.1:${port}/.internal/pod-data`, {
          method: 'POST',
        });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('not found');
      }
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve, reject) => {
        css.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
