import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { ApiServer } from '../../src/api/ApiServer';
import { registerAdminRoutes } from '../../src/api/handlers/AdminHandler';
import { registerNetworkSettingsRoutes } from '../../src/api/handlers/NetworkSettingsHandler';
import { createGatewayAdminProxyHeaders, GATEWAY_ADMIN_PROXY_HEADERS } from '../../src/runtime/GatewayAdminProxyAuth';
import { GatewayProxy, getFreePort } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor';

const SECRET = 'test-internal-admin-proxy-secret';

describe('GatewayProxy admin ingress authorization', () => {
  let api: ApiServer;
  let proxy: GatewayProxy;
  let apiPort: number;
  let proxyPort: number;
  let previousEnvPath: string | undefined;
  let previousAdminToken: string | undefined;

  beforeAll(async () => {
    previousEnvPath = process.env.XPOD_ENV_PATH;
    previousAdminToken = process.env.XPOD_ADMIN_TOKEN;
    const testDir = mkdtempSync(path.join(tmpdir(), 'xpod-admin-proxy-auth-'));
    process.env.XPOD_ENV_PATH = path.join(testDir, '.env.local');
    writeFileSync(process.env.XPOD_ENV_PATH, 'CSS_BASE_URL=http://localhost:3000/\n', 'utf8');

    apiPort = await getFreePort(46300, '127.0.0.1');
    proxyPort = await getFreePort(apiPort + 1, '127.0.0.1');
    const authMiddleware = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: false,
          error: 'Authentication required',
          category: 'invalid_credentials' as const,
          statusCode: 401,
        }),
      },
    });
    api = new ApiServer({
      port: apiPort,
      host: '127.0.0.1',
      authMiddleware,
    });
    registerAdminRoutes(api, { internalAdminAuthSecret: SECRET });
    registerNetworkSettingsRoutes(api, {
      endpoint: () => `http://127.0.0.1:${proxyPort}/`,
      internalAdminAuthSecret: SECRET,
    });
    await api.start();

    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1', {
      internalAdminAuthSecret: SECRET,
      clientRemoteAddressResolver: (req) => String(req.headers['x-test-remote-address'] ?? req.socket.remoteAddress ?? ''),
    });
    proxy.setTargets({ api: `http://127.0.0.1:${apiPort}` });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await api.stop();
    if (previousEnvPath === undefined) {
      delete process.env.XPOD_ENV_PATH;
    } else {
      process.env.XPOD_ENV_PATH = previousEnvPath;
    }
    if (previousAdminToken === undefined) {
      delete process.env.XPOD_ADMIN_TOKEN;
    } else {
      process.env.XPOD_ADMIN_TOKEN = previousAdminToken;
    }
  });

  it('does not grant admin capabilities or mutations to a remote client through Gateway without token', async () => {
    const status = await gatewayStatus('203.0.113.10');
    expect(status.capabilities.services.lifecycle.restart.supported).toBe(false);

    const mutation = await gatewayConfigPatch('203.0.113.10');
    expect(mutation.status).toBe(403);
  });

  it('strips forged internal admin marker headers before constructing Gateway evidence', async () => {
    const forgedHeaders = Object.fromEntries(GATEWAY_ADMIN_PROXY_HEADERS.map((header) => [header, 'forged']));
    const status = await gatewayStatus('203.0.113.10', {
      ...forgedHeaders,
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'localhost',
    });

    expect(status.capabilities.services.lifecycle.restart.supported).toBe(false);
  });

  it('allows a loopback original client through Gateway', async () => {
    const status = await gatewayStatus('127.0.0.1');
    expect(status.capabilities.services.lifecycle.restart.supported).toBe(true);

    const mutation = await gatewayConfigPatch('127.0.0.1');
    expect(mutation.status).toBe(200);
  });

  it('lets the Network authorizer accept signed loopback evidence while rejecting remote anonymous callers', async () => {
    const local = await gatewayNetworkStatus('127.0.0.1');
    expect(local.status).toBe(200);

    const remote = await gatewayNetworkStatus('203.0.113.10');
    expect(remote.status).toBe(401);
  });

  it('allows a remote client with a valid admin token through Gateway', async () => {
    process.env.XPOD_ADMIN_TOKEN = 'admin-token';
    const status = await gatewayStatus('203.0.113.10', { 'x-xpod-admin-token': 'admin-token' });
    expect(status.capabilities.services.lifecycle.restart.supported).toBe(true);

    const mutation = await gatewayConfigPatch('203.0.113.10', { 'x-xpod-admin-token': 'admin-token' });
    expect(mutation.status).toBe(200);
  });

  it('keeps direct local API semantics but rejects bad marker secrets and replayed markers', async () => {
    const directStatus = await directStatusRequest();
    expect(directStatus.capabilities.services.lifecycle.restart.supported).toBe(true);

    const wrongSecret = createGatewayAdminProxyHeaders({
      secret: 'wrong-secret',
      method: 'PUT',
      url: '/api/admin/config',
      originalClientLoopback: true,
    }) as Record<string, string>;
    expect((await directConfigPatch(wrongSecret)).status).toBe(403);

    const replayedStatusMarker = createGatewayAdminProxyHeaders({
      secret: SECRET,
      method: 'GET',
      url: '/api/admin/status',
      originalClientLoopback: true,
    }) as Record<string, string>;
    expect((await directConfigPatch(replayedStatusMarker)).status).toBe(403);
  });

  it('does not fall back to direct local authorization for proxied requests when gateway secret is missing', async () => {
    const insecureApiPort = await getFreePort(proxyPort + 1, '127.0.0.1');
    const insecureProxyPort = await getFreePort(insecureApiPort + 1, '127.0.0.1');
    const insecureApi = new ApiServer({
      port: insecureApiPort,
      host: '127.0.0.1',
      authMiddleware: { process: async () => true } as unknown as AuthMiddleware,
    });
    registerAdminRoutes(insecureApi);
    await insecureApi.start();
    const insecureProxy = new GatewayProxy(insecureProxyPort, new Supervisor(), '127.0.0.1', {
      clientRemoteAddressResolver: () => '127.0.0.1',
    });
    insecureProxy.setTargets({ api: `http://127.0.0.1:${insecureApiPort}` });
    await insecureProxy.start();

    try {
      const statusResponse = await fetch(`http://127.0.0.1:${insecureProxyPort}/api/admin/status`);
      expect(statusResponse.status).toBe(200);
      const status = await statusResponse.json() as any;
      expect(status.capabilities.services.lifecycle.restart.supported).toBe(false);

      const mutation = await fetch(`http://127.0.0.1:${insecureProxyPort}/api/admin/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env: { CSS_LOGGING_LEVEL: 'debug' } }),
      });
      expect(mutation.status).toBe(403);
    } finally {
      await insecureProxy.stop();
      await insecureApi.stop();
    }
  });

  async function gatewayStatus(remoteAddress: string, headers: Record<string, string> = {}): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/admin/status`, {
      headers: {
        ...headers,
        'x-test-remote-address': remoteAddress,
      },
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function gatewayConfigPatch(remoteAddress: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/api/admin/config`, {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-test-remote-address': remoteAddress,
      },
      body: JSON.stringify({ env: { CSS_LOGGING_LEVEL: 'debug' } }),
    });
  }

  async function gatewayNetworkStatus(remoteAddress: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/api/network/settings/status`, {
      headers: { 'x-test-remote-address': remoteAddress },
    });
  }

  async function directStatusRequest(headers: Record<string, string> = {}): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/admin/status`, { headers });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function directConfigPatch(headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${apiPort}/api/admin/config`, {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ env: { CSS_LOGGING_LEVEL: 'trace' } }),
    });
  }
});
