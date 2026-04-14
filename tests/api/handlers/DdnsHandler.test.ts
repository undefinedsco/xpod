import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import type { Authenticator, AuthResult } from '../../../src/api/auth/Authenticator';
import { registerDdnsRoutes } from '../../../src/api/handlers/DdnsHandler';

class MockAuthenticator implements Authenticator {
  public canAuthenticate(): boolean { return true; }
  public async authenticate(): Promise<AuthResult> {
    return {
      success: true,
      context: { type: 'solid', webId: 'https://example.com/user#me', accountId: 'user-123' },
    };
  }
}

function makeServer(port: number): { server: ApiServer; baseUrl: string } {
  const server = new ApiServer({
    port,
    authMiddleware: new AuthMiddleware({ authenticator: new MockAuthenticator() }),
  });
  return { server, baseUrl: `http://localhost:${port}` };
}

describe('DdnsHandler', () => {
  const repo = {
    getRecord: vi.fn(),
    allocateSubdomain: vi.fn(),
    updateRecordIp: vi.fn(),
    releaseSubdomain: vi.fn(),
    banSubdomain: vi.fn(),
  };
  const dnsProvider = {
    upsertRecord: vi.fn(),
    deleteRecord: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(async () => {
    // no-op: each test owns its own server
  });

  it('creates a CNAME to cfargotunnel.com in tunnel mode allocation', async () => {
    repo.getRecord.mockResolvedValue(null);
    repo.allocateSubdomain.mockResolvedValue({
      subdomain: 'node-1',
      domain: 'nodes.undefineds.co',
      recordType: 'CNAME',
      createdAt: new Date('2026-04-14T00:00:00.000Z'),
    });

    const { server, baseUrl } = makeServer(3094);
    registerDdnsRoutes(server, {
      ddnsRepo: repo as any,
      dnsProvider: dnsProvider as any,
      defaultDomain: 'nodes.undefineds.co',
    });
    await server.start();

    try {
      const res = await fetch(`${baseUrl}/api/v1/ddns/allocate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          subdomain: 'node-1',
          nodeId: 'node-1',
          mode: 'tunnel',
          tunnelProvider: 'cloudflare',
        }),
      });

      expect(res.status).toBe(201);
      expect(repo.allocateSubdomain).toHaveBeenCalledWith(expect.objectContaining({
        subdomain: 'node-1',
        recordType: 'CNAME',
        ipAddress: undefined,
        ipv6Address: undefined,
      }));
      expect(dnsProvider.upsertRecord).toHaveBeenCalledWith(expect.objectContaining({
        domain: 'nodes.undefineds.co',
        subdomain: 'node-1',
        type: 'CNAME',
        value: 'node-1.cfargotunnel.com',
      }));
    } finally {
      await server.stop();
    }
  });

  it('updates to CNAME and clears stored IPs in tunnel mode update', async () => {
    repo.updateRecordIp.mockResolvedValue({
      subdomain: 'node-1',
      domain: 'nodes.undefineds.co',
      ipAddress: undefined,
      ipv6Address: undefined,
      recordType: 'CNAME',
      ttl: 60,
      updatedAt: new Date('2026-04-14T00:00:00.000Z'),
    });

    const { server, baseUrl } = makeServer(3095);
    registerDdnsRoutes(server, {
      ddnsRepo: repo as any,
      dnsProvider: dnsProvider as any,
      defaultDomain: 'nodes.undefineds.co',
    });
    await server.start();

    try {
      const res = await fetch(`${baseUrl}/api/v1/ddns/node-1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          mode: 'tunnel',
          tunnelProvider: 'cloudflare',
        }),
      });

      expect(res.status).toBe(200);
      expect(repo.updateRecordIp).toHaveBeenCalledWith('node-1', {
        ipAddress: null,
        ipv6Address: null,
        recordType: 'CNAME',
      });
      expect(dnsProvider.upsertRecord).toHaveBeenCalledWith(expect.objectContaining({
        domain: 'nodes.undefineds.co',
        subdomain: 'node-1',
        type: 'CNAME',
        value: 'node-1.cfargotunnel.com',
      }));
    } finally {
      await server.stop();
    }
  });
});
