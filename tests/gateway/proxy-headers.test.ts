import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort, GatewayProxy } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

describe('GatewayProxy response headers', () => {
  let upstream: http.Server;
  let proxy: GatewayProxy;
  let proxyPort: number;
  const seenByUpstream: string[] = [];

  beforeAll(async () => {
    const upstreamPort = await getFreePort(46000, '127.0.0.1');
    proxyPort = await getFreePort(upstreamPort + 1, '127.0.0.1');

    upstream = http.createServer((req, res) => {
      seenByUpstream.push(`${req.method} ${req.url}`);

      if (req.method === 'HEAD') {
        res.statusCode = 404;
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write('missing');
        res.end();
        return;
      }

      if (req.url === '/unauthorized') {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise<void>((resolve, reject) => {
      upstream.listen(upstreamPort, '127.0.0.1', (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1');
    proxy.setTargets({ css: `http://127.0.0.1:${upstreamPort}` });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it('sanitizes HEAD proxy responses for fetch clients', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/missing`, { method: 'HEAD' });

    expect(res.status).toBe(404);
    expect(res.headers.get('transfer-encoding')).toBeNull();
  });

  it('rejects root file mutations before proxying to CSS', async () => {
    const beforeCount = seenByUpstream.length;
    const res = await fetch(`http://127.0.0.1:${proxyPort}/test-cloud-auth.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'root writes should not reach CSS',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      name: 'ForbiddenHttpError',
      statusCode: 403,
      details: { cause: 'root-container-write' },
    });
    expect(seenByUpstream).toHaveLength(beforeCount);
  });

  it('does not duplicate transfer-encoding on proxied chunked responses', async () => {
    const { headers, body } = await requestRaw(`http://127.0.0.1:${proxyPort}/unauthorized`);

    const transferEncodingCount = headers
      .filter((header) => header.toLowerCase() === 'transfer-encoding')
      .length;

    expect(transferEncodingCount).toBeLessThanOrEqual(1);
    expect(body).toBe(JSON.stringify({ error: 'unauthorized' }));
  });
});

function requestRaw(url: string): Promise<{ headers: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        resolve({
          headers: res.rawHeaders.filter((_, index) => index % 2 === 0),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    }).on('error', reject);
  });
}

describe('GatewayProxy Matrix routing', () => {
  let cssUpstream: http.Server;
  let apiUpstream: http.Server;
  let proxy: GatewayProxy;
  let proxyPort: number;
  const seenByCss: string[] = [];
  const seenByApi: string[] = [];

  beforeAll(async () => {
    const cssPort = await getFreePort(46100, '127.0.0.1');
    const apiPort = await getFreePort(cssPort + 1, '127.0.0.1');
    proxyPort = await getFreePort(apiPort + 1, '127.0.0.1');

    cssUpstream = http.createServer((req, res) => {
      seenByCss.push(`${req.method} ${req.url}`);
      res.statusCode = 200;
      res.setHeader('x-seen-forwarded-host', String(req.headers['x-forwarded-host'] ?? ''));
      res.end(`css:${req.url}`);
    });

    apiUpstream = http.createServer((req, res) => {
      seenByApi.push(`${req.method} ${req.url}`);
      res.statusCode = 200;
      res.setHeader('x-seen-forwarded-host', String(req.headers['x-forwarded-host'] ?? ''));
      res.end(`api:${req.url}`);
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        cssUpstream.listen(cssPort, '127.0.0.1', (error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        apiUpstream.listen(apiPort, '127.0.0.1', (error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    ]);

    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1');
    proxy.setTargets({
      css: `http://127.0.0.1:${cssPort}`,
      api: `http://127.0.0.1:${apiPort}`,
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        cssUpstream.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        apiUpstream.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    ]);
  });

  it('routes Matrix discovery and client API paths to the API server', async () => {
    const discovery = await fetch(`http://127.0.0.1:${proxyPort}/.well-known/matrix/client`);
    const versions = await fetch(`http://127.0.0.1:${proxyPort}/_matrix/client/versions`);
    const solid = await fetch(`http://127.0.0.1:${proxyPort}/profile/card`);

    expect(await discovery.text()).toBe('api:/.well-known/matrix/client');
    expect(await versions.text()).toBe('api:/_matrix/client/versions');
    expect(await solid.text()).toBe('css:/profile/card');
    expect(seenByApi).toEqual(expect.arrayContaining([
      'GET /.well-known/matrix/client',
      'GET /_matrix/client/versions',
    ]));
    expect(seenByCss).toEqual(expect.arrayContaining(['GET /profile/card']));
  });

  it('routes API subdomain traffic to the API server independent of path shape', async () => {
    const apiHostResponse = await fetch(`http://127.0.0.1:${proxyPort}/custom-protocol/status`, {
      headers: { 'x-forwarded-host': 'api.example.com' },
    });
    const idHostResponse = await fetch(`http://127.0.0.1:${proxyPort}/custom-protocol/status`, {
      headers: { 'x-forwarded-host': 'id.example.com' },
    });

    expect(await apiHostResponse.text()).toBe('api:/custom-protocol/status');
    expect(await idHostResponse.text()).toBe('css:/custom-protocol/status');
    expect(apiHostResponse.headers.get('x-seen-forwarded-host')).toBe('api.example.com');
    expect(seenByApi).toEqual(expect.arrayContaining([
      'GET /custom-protocol/status',
    ]));
    expect(seenByCss).toEqual(expect.arrayContaining([
      'GET /custom-protocol/status',
    ]));
  });

  it('routes registry host traffic to the API server without rewriting the public host', async () => {
    const registryHostResponse = await fetch(`http://127.0.0.1:${proxyPort}/nodes/node-0000`, {
      headers: { 'x-forwarded-host': 'registry.example.com' },
    });

    expect(await registryHostResponse.text()).toBe('api:/nodes/node-0000');
    expect(registryHostResponse.headers.get('x-seen-forwarded-host')).toBe('registry.example.com');
    expect(seenByApi).toEqual(expect.arrayContaining([
      'GET /nodes/node-0000',
    ]));
  });
});
