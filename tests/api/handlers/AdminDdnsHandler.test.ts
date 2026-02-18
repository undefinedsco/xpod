import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import { registerAdminDdnsRoutes } from '../../../src/api/handlers/AdminDdnsHandler';
import type { Authenticator, AuthResult } from '../../../src/api/auth/Authenticator';
import type { DdnsManager } from '../../../src/edge/DdnsManager';

class MockAuthenticator implements Authenticator {
  public canAuthenticate(): boolean { return true; }
  public async authenticate(): Promise<AuthResult> {
    return {
      success: true,
      context: { type: 'solid', webId: 'https://example.com/user#me', accountId: 'user-123' },
    };
  }
}

function createMockDdnsManager(overrides: Partial<ReturnType<DdnsManager['getStatus']>> = {}): DdnsManager {
  const status = {
    allocated: false,
    fqdn: undefined as string | undefined,
    ipv4: undefined as string | undefined,
    ipv6: undefined as string | undefined,
    mode: 'unknown' as 'direct' | 'tunnel' | 'unknown',
    tunnelProvider: 'none',
    ...overrides,
  };
  return {
    getStatus: () => status,
    runOnce: async () => {
      if (!status.allocated) {
        status.allocated = true;
        status.fqdn = 'my-node.pods.undefineds.site';
        status.mode = 'direct';
        status.ipv4 = '203.0.113.42';
      }
    },
  } as unknown as DdnsManager;
}

function makeServer(port: number): { server: ApiServer; baseUrl: string } {
  const server = new ApiServer({
    port,
    authMiddleware: new AuthMiddleware({ authenticator: new MockAuthenticator() }),
  });
  return { server, baseUrl: `http://localhost:${port}` };
}

describe('AdminDdnsHandler', () => {
  describe('without DdnsManager (no XPOD_NODE_TOKEN)', () => {
    let server: ApiServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = makeServer(3090));
      registerAdminDdnsRoutes(server, { ddnsManager: undefined });
      await server.start();
    });
    afterAll(async () => { await server.stop(); });

    it('GET /api/admin/ddns returns enabled=false', async () => {
      const res = await fetch(`${baseUrl}/api/admin/ddns`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.allocated).toBe(false);
      expect(body.fqdn).toBeNull();
      expect(body.detail).toContain('not enabled');
    });

    it('POST /api/admin/ddns/refresh returns success=false', async () => {
      const res = await fetch(`${baseUrl}/api/admin/ddns/refresh`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });

  describe('with DdnsManager - not yet allocated', () => {
    let server: ApiServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = makeServer(3091));
      registerAdminDdnsRoutes(server, { ddnsManager: createMockDdnsManager() });
      await server.start();
    });
    afterAll(async () => { await server.stop(); });

    it('GET /api/admin/ddns returns enabled=true, allocated=false', async () => {
      const res = await fetch(`${baseUrl}/api/admin/ddns`);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.allocated).toBe(false);
      expect(body.fqdn).toBeNull();
      expect(body.detail).toContain('Allocating');
    });

    it('POST /api/admin/ddns/refresh triggers allocation', async () => {
      const res = await fetch(`${baseUrl}/api/admin/ddns/refresh`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);

      const statusRes = await fetch(`${baseUrl}/api/admin/ddns`);
      const status = await statusRes.json();
      expect(status.allocated).toBe(true);
      expect(status.fqdn).toBe('my-node.pods.undefineds.site');
      expect(status.baseUrl).toBe('https://my-node.pods.undefineds.site/');
      expect(status.mode).toBe('direct');
      expect(status.ipv4).toBe('203.0.113.42');
    });
  });

  describe('with DdnsManager - already allocated, direct mode', () => {
    let server: ApiServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = makeServer(3092));
      registerAdminDdnsRoutes(server, {
        ddnsManager: createMockDdnsManager({
          allocated: true,
          fqdn: 'alice.pods.undefineds.site',
          mode: 'direct',
          ipv4: '198.51.100.10',
        }),
      });
      await server.start();
    });
    afterAll(async () => { await server.stop(); });

    it('returns allocated domain with correct baseUrl', async () => {
      const res = await fetch(`${baseUrl}/api/admin/ddns`);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.allocated).toBe(true);
      expect(body.fqdn).toBe('alice.pods.undefineds.site');
      expect(body.baseUrl).toBe('https://alice.pods.undefineds.site/');
      expect(body.mode).toBe('direct');
      expect(body.ipv4).toBe('198.51.100.10');
      expect(body.detail).toContain('allocated');
    });
  });

  describe('with DdnsManager - tunnel mode', () => {
    let server: ApiServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = makeServer(3093));
      registerAdminDdnsRoutes(server, {
        ddnsManager: createMockDdnsManager({
          allocated: true,
          fqdn: 'bob.pods.undefineds.site',
          mode: 'tunnel',
          tunnelProvider: 'cloudflare',
        }),
      });
      await server.start();
    });
    afterAll(async () => { await server.stop(); });

    it('returns tunnel mode with provider info', async () => {
      const res = await fetch(`${baseUrl}/api/admin/ddns`);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.allocated).toBe(true);
      expect(body.fqdn).toBe('bob.pods.undefineds.site');
      expect(body.mode).toBe('tunnel');
      expect(body.tunnelProvider).toBe('cloudflare');
      expect(body.ipv4).toBeNull();
    });
  });
});
