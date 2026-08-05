import http from 'http';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort, GatewayProxy } from '../../src/runtime';
import {
  createGatewayAdminProxyHeaders,
  verifyGatewayAdminProxyHeaders,
} from '../../src/runtime/GatewayAdminProxyAuth';
import { Supervisor } from '../../src/supervisor/Supervisor';

const INTERNAL_PROXY_SECRET = 'test-internal-pod-proxy-secret';

describe('GatewayProxy response headers', () => {
  let upstream: http.Server;
  let proxy: GatewayProxy;
  let proxyPort: number;
  const seenByUpstream: string[] = [];
  let latestUpstreamHeaders: http.IncomingHttpHeaders = {};

  beforeAll(async () => {
    const upstreamPort = await getFreePort(46000, '127.0.0.1');
    proxyPort = await getFreePort(upstreamPort + 1, '127.0.0.1');

    upstream = http.createServer((req, res) => {
      seenByUpstream.push(`${req.method} ${req.url}`);
      latestUpstreamHeaders = req.headers;

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, DPoP, Content-Type');
        res.end();
        return;
      }

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
        // Multiple writes make the fixture genuinely chunked without manually
        // adding a framing header that Bun's Node compatibility layer duplicates.
        res.write('{"error":');
        res.end('"unauthorized"}');
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

    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1', {
      internalAdminAuthSecret: INTERNAL_PROXY_SECRET,
    });
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

  it('preserves a valid signed internal Pod marker from a loopback API request', async () => {
    const intent = {
      ownerWebId: 'https://id.example/alice/profile/card#me',
      method: 'GET' as const,
      resourceUrl: 'https://id.example/alice/settings/credentials.ttl',
      principalKind: 'solid-user' as const,
      scopes: ['ai:credentials:read'],
    };
    const marker = createGatewayAdminProxyHeaders({
      secret: INTERNAL_PROXY_SECRET,
      method: 'GET',
      url: '/.internal/pod-data',
      originalClientLoopback: true,
      nonce: 'gateway-internal-pod-nonce',
      intent,
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/.internal/pod-data`, {
      headers: marker as Record<string, string>,
    });

    expect(response.status).toBe(200);
    expect(verifyGatewayAdminProxyHeaders({
      headers: latestUpstreamHeaders,
      secret: INTERNAL_PROXY_SECRET,
      method: 'GET',
      url: '/.internal/pod-data',
    })).toMatchObject({ valid: true, originalClientLoopback: true, intent });
  });

  it('binds POST internal Pod markers to a SHA-256 body digest', async () => {
    const body = 'query=SELECT+%2A+WHERE+%7B%7D';
    const digest = createHash('sha256').update(body).digest('hex');
    const intent = {
      ownerWebId: 'https://id.example/alice/profile/card#me',
      method: 'POST' as const,
      resourceUrl: 'https://id.example/alice/settings/providers/-/sparql',
      principalKind: 'solid-user' as const,
      scopes: ['ai:credentials:read'],
      bodyDigest: digest,
    };
    const marker = createGatewayAdminProxyHeaders({
      secret: INTERNAL_PROXY_SECRET,
      method: 'POST',
      url: '/.internal/pod-data',
      originalClientLoopback: true,
      nonce: 'post-body-nonce',
      intent,
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/.internal/pod-data`, {
      method: 'POST',
      headers: {
        ...(marker as Record<string, string>),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    expect(response.status).toBe(200);
    const verifiedPost = verifyGatewayAdminProxyHeaders({
      headers: latestUpstreamHeaders,
      secret: INTERNAL_PROXY_SECRET,
      method: 'POST',
      url: '/.internal/pod-data',
    });
    expect(verifiedPost).toMatchObject({ valid: true, intent });

    const tamperedHeaders = {
      ...latestUpstreamHeaders,
      'x-xpod-admin-proxy-intent': JSON.stringify({ ...intent, bodyDigest: 'b'.repeat(64) }),
    };
    expect(verifyGatewayAdminProxyHeaders({
      headers: tamperedHeaders,
      secret: INTERNAL_PROXY_SECRET,
      method: 'POST',
      url: '/.internal/pod-data',
    })).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a signed POST marker without a body digest', () => {
    const marker = createGatewayAdminProxyHeaders({
      secret: INTERNAL_PROXY_SECRET,
      method: 'POST',
      url: '/.internal/pod-data',
      originalClientLoopback: true,
      intent: {
        ownerWebId: 'https://id.example/alice/profile/card#me',
        method: 'POST',
        resourceUrl: 'https://id.example/alice/settings/providers/-/sparql',
        principalKind: 'solid-user',
        scopes: ['ai:credentials:read'],
      },
    });

    expect(verifyGatewayAdminProxyHeaders({
      headers: marker,
      secret: INTERNAL_PROXY_SECRET,
      method: 'POST',
      url: '/.internal/pod-data',
    })).toMatchObject({ valid: false, reason: 'invalid_intent' });
  });

  it('strips an invalid internal Pod marker even from a loopback request', async () => {
    const marker = createGatewayAdminProxyHeaders({
      secret: 'forged-secret',
      method: 'GET',
      url: '/.internal/pod-data',
      originalClientLoopback: true,
      nonce: 'forged-nonce',
      intent: {
        ownerWebId: 'https://id.example/mallory/profile/card#me',
        method: 'GET',
        resourceUrl: 'https://id.example/alice/settings/credentials.ttl',
        principalKind: 'solid-user',
        scopes: ['ai:credentials:read'],
      },
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/.internal/pod-data`, {
      headers: marker as Record<string, string>,
    });

    expect(response.status).toBe(200);
    expect(verifyGatewayAdminProxyHeaders({
      headers: latestUpstreamHeaders,
      secret: INTERNAL_PROXY_SECRET,
      method: 'GET',
      url: '/.internal/pod-data',
    })).toMatchObject({ present: false, valid: false });
  });

  it('does not duplicate transfer-encoding on proxied chunked responses', async () => {
    const { headers, body } = await requestRaw(`http://127.0.0.1:${proxyPort}/unauthorized`);

    const transferEncodingCount = headers
      .filter((header) => header.toLowerCase() === 'transfer-encoding')
      .length;

    expect(transferEncodingCount).toBeLessThanOrEqual(1);
    expect(body).toBe(JSON.stringify({ error: 'unauthorized' }));
  });

  it('reflects the browser origin on credentialed proxied responses', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/ok`, {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('finishes proxied 204 CORS preflight responses', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/test`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,dpop,content-type',
      },
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
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
