import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import type { Authenticator, AuthResult } from '../../../src/api/auth/Authenticator';
import { registerDdnsRoutes } from '../../../src/api/handlers/DdnsHandler';

class MockAuthenticator implements Authenticator {
  public canAuthenticate(): boolean { return true; }
  public async authenticate(): Promise<AuthResult> {
    return {
      success: true,
      context: { type: 'node', nodeId: 'node-1' },
    };
  }
}

function createRepo() {
  let record: any = null;

  return {
    getRecord: async (subdomain: string) => record && record.subdomain === subdomain ? record : null,
    allocateSubdomain: async (input: any) => {
      record = {
        subdomain: input.subdomain,
        domain: input.domain,
        ipAddress: input.ipAddress,
        ipv6Address: input.ipv6Address,
        recordType: input.ipv6Address ? 'AAAA' : 'A',
        status: 'active',
        ttl: 60,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      return record;
    },
    updateRecordIp: async (subdomain: string, input: any) => {
      if (!record || record.subdomain !== subdomain) {
        return null;
      }
      record = {
        ...record,
        ipAddress: input.ipAddress ?? record.ipAddress,
        ipv6Address: input.ipv6Address ?? record.ipv6Address,
        updatedAt: new Date('2024-01-02T00:00:00.000Z'),
      };
      return record;
    },
    releaseSubdomain: async () => undefined,
    banSubdomain: async () => undefined,
  };
}

describe('DdnsHandler', () => {
  const repo = createRepo();
  const dnsProvider = {
    upsertRecord: vi.fn().mockResolvedValue(undefined),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
  };
  const server = new ApiServer({
    port: 3094,
    authMiddleware: new AuthMiddleware({ authenticator: new MockAuthenticator() }),
  });
  const baseUrl = 'http://localhost:3094';

  beforeAll(async () => {
    registerDdnsRoutes(server, {
      ddnsRepo: repo as any,
      dnsProvider: dnsProvider as any,
      defaultDomain: 'undefineds.site',
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('allocates a tunnel DDNS record without requiring an IP address', async () => {
    const response = await fetch(`${baseUrl}/api/v1/ddns/allocate`, {
      method: 'POST',
      headers: {
        Authorization: 'XpodNode node-1:token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subdomain: 'node-1',
        nodeId: 'node-1',
        mode: 'tunnel',
        tunnelProvider: 'cloudflare',
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.fqdn).toBe('node-1.undefineds.site');
    expect(body.tunnelProvider).toBe('cloudflare');
  });

  it('clears stale CNAME and writes A plus AAAA records for direct refresh', async () => {
    dnsProvider.upsertRecord.mockClear();
    dnsProvider.deleteRecord.mockClear();

    const response = await fetch(`${baseUrl}/api/v1/ddns/node-1`, {
      method: 'POST',
      headers: {
        Authorization: 'XpodNode node-1:token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ip: '203.0.113.10',
        ipv6Address: '2001:db8::10',
        mode: 'direct',
      }),
    });

    expect(response.status).toBe(200);
    expect(dnsProvider.deleteRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-1',
      type: 'CNAME',
    });
    expect(dnsProvider.upsertRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-1',
      type: 'A',
      value: '203.0.113.10',
      ttl: 60,
    });
    expect(dnsProvider.upsertRecord).toHaveBeenCalledWith({
      domain: 'undefineds.site',
      subdomain: 'node-1',
      type: 'AAAA',
      value: '2001:db8::10',
      ttl: 60,
    });
  });

  it('accepts tunnel refresh without IP updates', async () => {
    const response = await fetch(`${baseUrl}/api/v1/ddns/node-1`, {
      method: 'POST',
      headers: {
        Authorization: 'XpodNode node-1:token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'tunnel',
        tunnelProvider: 'cloudflare',
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.fqdn).toBe('node-1.undefineds.site');
    expect(body.tunnelProvider).toBe('cloudflare');
  });
});
