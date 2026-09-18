import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import type { Authenticator, AuthResult } from '../../../src/api/auth/Authenticator';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import { registerDdnsRoutes } from '../../../src/api/handlers/DdnsHandler';

let authContext: AuthContext = { type: 'node', nodeId: 'node-1' };

class MockAuthenticator implements Authenticator {
  public canAuthenticate(): boolean { return true; }
  public async authenticate(): Promise<AuthResult> {
    return { success: true, context: authContext };
  }
}

function createRepo() {
  const records = new Map<string, any>();

  return {
    getRecord: async (subdomain: string) => records.get(subdomain) ?? null,
    allocateSubdomain: async (input: any) => {
      const record = {
        subdomain: input.subdomain,
        domain: input.domain,
        nodeId: input.nodeId,
        ipAddress: input.ipAddress,
        ipv6Address: input.ipv6Address,
        recordType: input.ipv6Address ? 'AAAA' : 'A',
        status: 'active',
        ttl: 60,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      records.set(input.subdomain, record);
      return record;
    },
    updateRecordIp: async (subdomain: string, input: any) => {
      const record = records.get(subdomain);
      if (!record) {
        return null;
      }
      const updated = {
        ...record,
        ipAddress: input.ipAddress ?? record.ipAddress,
        ipv6Address: input.ipv6Address ?? record.ipv6Address,
        updatedAt: new Date('2024-01-02T00:00:00.000Z'),
      };
      records.set(subdomain, updated);
      return updated;
    },
    releaseSubdomain: async (subdomain: string) => {
      records.delete(subdomain);
    },
    banSubdomain: vi.fn(async () => undefined),
    _records: records,
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
    authContext = { type: 'node', nodeId: 'node-1' };
    await server.stop();
  });

  function nodeRequest(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: 'XpodNode node-1:token',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  }

  it('allocates a tunnel DDNS record without requiring an IP address', async () => {
    authContext = { type: 'node', nodeId: 'node-1' };
    const response = await nodeRequest('/api/v1/ddns/allocate', {
      method: 'POST',
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
    authContext = { type: 'node', nodeId: 'node-1' };
    dnsProvider.upsertRecord.mockClear();
    dnsProvider.deleteRecord.mockClear();

    const response = await nodeRequest('/api/v1/ddns/node-1', {
      method: 'POST',
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
    authContext = { type: 'node', nodeId: 'node-1' };
    const response = await nodeRequest('/api/v1/ddns/node-1', {
      method: 'POST',
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

  it('binds the allocated record to the authenticated node, not the request body', async () => {
    authContext = { type: 'node', nodeId: 'node-1' };
    const response = await nodeRequest('/api/v1/ddns/allocate', {
      method: 'POST',
      body: JSON.stringify({ subdomain: 'bound-to-auth', mode: 'tunnel' }),
    });

    expect(response.status).toBe(201);
    expect(repo._records.get('bound-to-auth')?.nodeId).toBe('node-1');
  });

  it('rejects allocation requests that name a different node', async () => {
    authContext = { type: 'node', nodeId: 'node-1' };
    const response = await nodeRequest('/api/v1/ddns/allocate', {
      method: 'POST',
      body: JSON.stringify({ subdomain: 'spoofed', nodeId: 'node-2', mode: 'tunnel' }),
    });

    expect(response.status).toBe(403);
    expect(repo._records.has('spoofed')).toBe(false);
  });

  it('rejects updates from a node that does not own the record', async () => {
    authContext = { type: 'node', nodeId: 'node-2' };
    const response = await nodeRequest('/api/v1/ddns/node-1', {
      method: 'POST',
      body: JSON.stringify({ ip: '203.0.113.99' }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects deletes from a node that does not own the record', async () => {
    authContext = { type: 'node', nodeId: 'node-2' };
    const response = await nodeRequest('/api/v1/ddns/node-1', { method: 'DELETE' });

    expect(response.status).toBe(403);
    expect(repo._records.has('node-1')).toBe(true);
  });

  it('rejects ban requests from node credentials', async () => {
    authContext = { type: 'node', nodeId: 'node-1' };
    const response = await nodeRequest('/api/v1/ddns/node-1/ban', {
      method: 'POST',
      body: JSON.stringify({ reason: 'abuse' }),
    });

    expect(response.status).toBe(403);
  });

  it.each([{ scopes: [] }, { scopes: ['network:read'] }, { scopes: ['network:read', 'network:connect'] }])('rejects service DDNS mutations without network:write ($scopes)', async ({ scopes }) => {
    authContext = { type: 'service', serviceType: 'cloud', serviceId: 'provision:node-2:route', scopes };
    const record = { subdomain: 'protected-node', domain: 'undefineds.site', nodeId: 'node-1', ipAddress: '203.0.113.1', ttl: 60 };
    repo._records.set(record.subdomain, record);
    dnsProvider.upsertRecord.mockClear();
    dnsProvider.deleteRecord.mockClear();
    repo.banSubdomain.mockClear();
    for (const [path, method, body] of [
      ['/api/v1/ddns/allocate', 'POST', { subdomain: 'service-denied', nodeId: 'node-2' }],
      ['/api/v1/ddns/protected-node', 'POST', { ip: '203.0.113.99' }],
      ['/api/v1/ddns/protected-node', 'DELETE', undefined],
      ['/api/v1/ddns/protected-node/ban', 'POST', { reason: 'denied' }],
    ] as const) {
      const response = await nodeRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(repo._records.has('service-denied')).toBe(false);
    expect(repo._records.get(record.subdomain)).toEqual(record);
    expect(repo.banSubdomain).not.toHaveBeenCalled();
    expect(dnsProvider.upsertRecord).not.toHaveBeenCalled();
    expect(dnsProvider.deleteRecord).not.toHaveBeenCalled();
  });

  it.each(['POST', 'DELETE'])('rejects node %s of an ownerless legacy record without side effects', async (method) => {
    authContext = { type: 'node', nodeId: 'node-1' };
    const record = { subdomain: 'legacy-record', domain: 'undefineds.site', ipAddress: '203.0.113.1', ttl: 60 };
    repo._records.set(record.subdomain, record);
    dnsProvider.upsertRecord.mockClear();
    dnsProvider.deleteRecord.mockClear();
    const response = await nodeRequest('/api/v1/ddns/legacy-record', {
      method, ...(method === 'POST' ? { body: JSON.stringify({ ip: '203.0.113.99' }) } : {}),
    });
    expect(response.status).toBe(403);
    expect(repo._records.get(record.subdomain)).toEqual(record);
    expect(dnsProvider.upsertRecord).not.toHaveBeenCalled();
    expect(dnsProvider.deleteRecord).not.toHaveBeenCalled();
  });

  it('allows explicit network:write service authority to allocate, update and delete records', async () => {
    authContext = { type: 'service', serviceType: 'cloud', serviceId: 'network-admin', scopes: ['network:write'] };
    const allocated = await nodeRequest('/api/v1/ddns/allocate', {
      method: 'POST', body: JSON.stringify({ subdomain: 'managed-node', nodeId: 'node-2', mode: 'tunnel' }),
    });
    expect(allocated.status).toBe(201);
    expect(repo._records.get('managed-node')?.nodeId).toBe('node-2');
    const updated = await nodeRequest('/api/v1/ddns/managed-node', {
      method: 'POST', body: JSON.stringify({ ip: '203.0.113.88' }),
    });
    expect(updated.status).toBe(200);
    expect(repo._records.get('managed-node')?.ipAddress).toBe('203.0.113.88');
    const removed = await nodeRequest('/api/v1/ddns/managed-node', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(repo._records.has('managed-node')).toBe(false);
  });

  it('allows ban requests with explicit network:write service authority', async () => {
    authContext = { type: 'service', serviceType: 'cloud', serviceId: 'svc-admin', scopes: ['network:write'] };
    const response = await nodeRequest('/api/v1/ddns/node-1/ban', {
      method: 'POST',
      body: JSON.stringify({ reason: 'abuse' }),
    });

    expect(response.status).toBe(200);
  });

  it('rejects solid user credentials on DDNS mutations', async () => {
    authContext = { type: 'solid', webId: 'https://example.com/profile#me' };
    const response = await nodeRequest('/api/v1/ddns/allocate', {
      method: 'POST',
      body: JSON.stringify({ subdomain: 'solid-user-attempt', mode: 'tunnel' }),
    });

    expect(response.status).toBe(403);
    expect(repo._records.has('solid-user-attempt')).toBe(false);
  });
});
