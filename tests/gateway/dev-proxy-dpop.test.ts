import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import httpProxy from 'http-proxy';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, TargetExtractor } from '@solid/community-server';
import { GatewayProxy, getFreePort } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';
import { SolidTokenAuthenticator } from '../../src/api/auth/SolidTokenAuthenticator';
import { xpodGatewayProxy } from '../../ui/vite.config';
import { ConfiguredLoopbackDPoPWebIdExtractor } from '../../src/authentication/ConfiguredLoopbackDPoPWebIdExtractor';

describe('Web dev proxy preserves DPoP request identity', () => {
  let upstream: http.Server;
  let devServer: http.Server;
  let devProxy: httpProxy;
  let gateway: GatewayProxy;
  let browserOrigin: string;
  let accessToken: string;
  let proofKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let cssServer: http.Server;
  let socketDirectory: string;

  beforeAll(async () => {
    const upstreamPort = await getFreePort(46000, '127.0.0.1');
    const gatewayPort = await getFreePort(upstreamPort + 1, '127.0.0.1');
    const devPort = await getFreePort(gatewayPort + 1, '127.0.0.1');
    const issuer = `http://localhost:${upstreamPort}/`;
    const webId = `${issuer}alice/profile/card#me`;
    browserOrigin = `http://127.0.0.1:${devPort}`;
    const issuerKeys = await generateKeyPair('ES256');
    const issuerJwk = { ...await exportJWK(issuerKeys.publicKey), kid: 'issuer-key', alg: 'ES256' };
    proofKeys = await generateKeyPair('ES256');
    const jkt = await calculateJwkThumbprint(await exportJWK(proofKeys.publicKey));
    accessToken = await new SignJWT({ webid: webId, client_id: 'web-test', cnf: { jkt } })
      .setProtectedHeader({ alg: 'ES256', kid: 'issuer-key' })
      .setIssuer(issuer).setSubject(webId).setAudience('solid')
      .setIssuedAt().setExpirationTime('1h').sign(issuerKeys.privateKey);
    const auth = new SolidTokenAuthenticator({ publicBaseUrl: issuer });

    upstream = http.createServer(async (req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}jwks` }));
      } else if (req.url === '/jwks') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: [issuerJwk] }));
      } else if (req.url === '/alice/profile/card') {
        res.setHeader('Content-Type', 'text/turtle');
        res.end(`<${webId}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${issuer}> .`);
      } else {
        const result = await auth.authenticate(req);
        res.statusCode = result.success ? 200 : 401;
        res.end(JSON.stringify({ authenticated: result.success }));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, resolve));
    const internalSecret = 'dev-proxy-css-test-secret';
    vi.stubEnv('XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET', internalSecret);
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor({
      handleSafe: async ({ request }: { request: HttpRequest }) => ({
        path: new URL(request.url!, `${String(request.headers['x-forwarded-proto']).split(',')[0]}://${request.headers.host}`).href,
      }),
    } as unknown as TargetExtractor, 'https://canonical-pod.example/');
    cssServer = http.createServer(async (req, res) => {
      try {
        const credentials = await extractor.handleSafe(req as HttpRequest);
        res.end(JSON.stringify({ webId: credentials.agent?.webId, unixPeer: req.socket.remoteAddress === undefined }));
      } catch {
        res.statusCode = 401;
        res.end(JSON.stringify({ authenticated: false }));
      }
    });
    // Unix-domain socket paths are capped at roughly 104 bytes on macOS.
    // Worktree paths can exceed that before the socket filename is appended,
    // so keep this self-cleaning socket fixture under the short system tmp root.
    socketDirectory = await mkdtemp(path.join(os.tmpdir(), 'xpod-dpop-'));
    const socketPath = path.join(socketDirectory, 'css.sock');
    await new Promise<void>((resolve) => cssServer.listen(socketPath, resolve));
    gateway = new GatewayProxy(gatewayPort, new Supervisor(), '127.0.0.1', {
      baseUrl: 'https://canonical-pod.example/',
      internalAdminAuthSecret: internalSecret,
    });
    gateway.setTargets({ api: issuer, css: { socketPath } });
    await gateway.start();
    devProxy = httpProxy.createProxyServer(xpodGatewayProxy(`http://127.0.0.1:${gatewayPort}`)['/api']);
    devServer = http.createServer((req, res) => devProxy.web(req, res));
    await listen(devServer, devPort);
  });

  afterAll(async () => {
    devProxy?.close();
    if (devServer) await close(devServer);
    if (gateway) await gateway.stop();
    if (upstream) await close(upstream);
    if (cssServer) await close(cssServer);
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function request(path: string, signedOrigin = browserOrigin, method = 'GET', headers: Record<string, string> = {}): Promise<Response> {
    const proof = await new SignJWT({
      htu: `${signedOrigin}${path}`, htm: method,
      ath: createHash('sha256').update(accessToken).digest('base64url'),
    }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(proofKeys.publicKey) })
      .setJti(randomUUID()).setIssuedAt().sign(proofKeys.privateKey);
    return fetch(`${browserOrigin}${path}`, {
      method,
      headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof, ...headers },
    });
  }

  it.each(['/api/ai/client-configuration/capability', '/v1/models'])(
    'verifies the original browser URL through both proxy hops: %s', async (path) => {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authenticated: true });
    },
  );

  it('still rejects a proof signed for another origin', async () => {
    const response = await request('/api/ai/client-configuration/capability', 'https://wrong.example');
    expect(response.status).toBe(401);
  });

  it('verifies a browser-signed Pod SPARQL request across the internal CSS Unix socket', async () => {
    const path = '/alice/settings/-/sparql';
    const response = await request(path, browserOrigin, 'POST', {
      'x-xpod-canonical-host': 'canonical-pod.example',
      'x-xpod-canonical-origin': 'https://canonical-pod.example',
      'x-xpod-canonical-url': `https://canonical-pod.example${path}`,
      'x-xpod-local-route-url': `http://127.0.0.2:9999${path}`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ webId: expect.stringContaining('/alice/profile/card#me'), unixPeer: true });
  });

  it('does not let an attested CSS route accept a proof for a different browser origin', async () => {
    const path = '/alice/settings/-/sparql';
    const response = await request(path, 'https://wrong.example', 'POST', {
      'x-xpod-canonical-host': 'canonical-pod.example',
      'x-xpod-canonical-origin': 'https://canonical-pod.example',
      'x-xpod-canonical-url': `https://canonical-pod.example${path}`,
    });
    expect(response.status).toBe(401);
  });
});

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
