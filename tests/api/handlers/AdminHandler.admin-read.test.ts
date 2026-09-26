import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import { registerAdminRoutes } from '../../../src/api/handlers/AdminHandler';
import { registerAdminDdnsRoutes } from '../../../src/api/handlers/AdminDdnsHandler';
import { createGatewayAdminProxyHeaders } from '../../../src/runtime/GatewayAdminProxyAuth';

describe('Admin route authorization', () => {
  // These routes authorize by loopback/proxy marker (they register `public: true`), so the server
  // only needs a middleware that declines every credential.
  const server = new ApiServer({
    port: 3195,
    authMiddleware: new AuthMiddleware({ authenticator: { canAuthenticate: () => false } as never }),
  });
  const baseUrl = 'http://localhost:3195';
  const internalAdminAuthSecret = 'admin-read-fixture-secret';

  beforeAll(async() => {
    registerAdminRoutes(server, { internalAdminAuthSecret });
    registerAdminDdnsRoutes(server, { internalAdminAuthSecret });
    await server.start();
  });

  afterAll(async() => {
    await server.stop();
  });

  it('allows admin reads from loopback', async() => {
    const response = await fetch(`${baseUrl}/api/admin/status`);
    expect(response.status).toBe(200);

    const ddnsResponse = await fetch(`${baseUrl}/api/admin/ddns`);
    expect(ddnsResponse.status).toBe(200);
  });

  it('denies admin reads that arrive through the gateway from a remote client', async() => {
    // 网关转发时一定会带上 proxy marker；远端客户端的 marker 声明 originalClientLoopback=0。
    // 缺少签名的 marker 无效，必须拒绝。
    for (const path of ['/api/admin/status', '/api/admin/config', '/api/admin/logs', '/api/admin/logs/stream', '/api/admin/logs/file', '/api/admin/public-ip']) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { 'x-xpod-admin-proxy-loopback': '0' },
      });
      expect(response.status, path).toBe(403);
    }

    const ddnsResponse = await fetch(`${baseUrl}/api/admin/ddns`, {
      headers: { 'x-xpod-admin-proxy-loopback': '0' },
    });
    expect(ddnsResponse.status).toBe(403);
  });

  it('accepts the configured admin token even for remote clients', async() => {
    const previousToken = process.env.XPOD_ADMIN_TOKEN;
    process.env.XPOD_ADMIN_TOKEN = 'test-admin-token';
    try {
      const response = await fetch(`${baseUrl}/api/admin/config`, {
        headers: {
          'x-xpod-admin-proxy-loopback': '0',
          'x-xpod-admin-token': 'test-admin-token',
        },
      });
      expect(response.status).toBe(200);
    } finally {
      if (previousToken === undefined) {
        delete process.env.XPOD_ADMIN_TOKEN;
      } else {
        process.env.XPOD_ADMIN_TOKEN = previousToken;
      }
    }
  });

  it('still requires the admin guard for mutations', async() => {
    const response = await fetch(`${baseUrl}/api/admin/ddns/refresh`, {
      method: 'POST',
      headers: { 'x-xpod-admin-proxy-loopback': '0' },
    });
    expect(response.status).toBe(403);
  });

  it.each(['/api/admin/status', '/api/admin/ddns'])('preserves signed local access to %s', async(path) => {
    const headers = createGatewayAdminProxyHeaders({
      secret: internalAdminAuthSecret,
      method: 'GET',
      url: path,
      originalClientLoopback: true,
    }) as Record<string, string>;
    expect((await fetch(`${baseUrl}${path}`, { headers })).status).toBe(200);
    expect((await fetch(`${baseUrl}${path}`, {
      headers: { ...headers, 'x-xpod-admin-proxy-loopback': '0' },
    })).status).toBe(403);
  });

  it('rejects correctly signed proxy traffic from a remote client', async() => {
    const path = '/api/admin/ddns';
    const headers = createGatewayAdminProxyHeaders({
      secret: internalAdminAuthSecret, method: 'GET', url: path, originalClientLoopback: false,
    }) as Record<string, string>;
    expect((await fetch(`${baseUrl}${path}`, { headers })).status).toBe(403);
  });
});
