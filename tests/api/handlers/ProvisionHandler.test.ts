import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProvisionRoutes, registerProvisionStatusRoute } from '../../../src/api/handlers/ProvisionHandler';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { ServerResponse } from 'node:http';
import { ProvisionCodeCodec } from '../../../src/provision/ProvisionCodeCodec';

describe('ProvisionHandler', () => {
  let mockServer: ApiServer;
  let routes: Record<string, Function> = {};
  let mockRepo: any;
  const baseUrl = 'https://cloud.example.com/';

  beforeEach(() => {
    vi.clearAllMocks();
    routes = {};

    mockServer = {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer;

    mockRepo = {
      registerSpNode: vi.fn(),
      updateNodeMode: vi.fn(),
      getNodeMetadata: vi.fn(),
      mergeNodeMetadata: vi.fn(),
    };

    registerProvisionRoutes(mockServer, {
      repository: mockRepo,
      baseUrl,
    });
  });

  const createMockRequest = (body: object): any => ({
    headers: { host: 'cloud.example.com' },
    setEncoding: vi.fn(),
    on: vi.fn((event: string, callback: Function) => {
      if (event === 'data') callback(JSON.stringify(body));
      if (event === 'end') callback();
    }),
  });

  const createMockResponse = (): ServerResponse => ({
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse);

  describe('route registration', () => {
    it('should register POST /provision/nodes as public', () => {
      expect(mockServer.post).toHaveBeenCalledWith('/provision/nodes', expect.any(Function), { public: true });
    });

    it('should not register /provision/bind', () => {
      expect(routes['POST /provision/bind']).toBeUndefined();
    });
  });

  describe('POST /provision/nodes', () => {
    it('should register SP node and return self-contained provisionCode', async () => {
      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({ publicUrl: 'https://sp.example.com', displayName: 'My NAS' });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.nodeId).toBe('node-1');
      expect(body.nodeToken).toBe('nt-xxx');
      expect(body.serviceToken).toBe('st-xxx');
      expect(body.provisionCode).toBeDefined();

      // provisionCode should be decodable
      const codec = new ProvisionCodeCodec(baseUrl);
      const payload = codec.decode(body.provisionCode);
      expect(payload).toBeDefined();
      expect(payload!.spUrl).toBe('https://sp.example.com');
      expect(payload!.serviceToken).toBe('st-xxx');
      expect(payload!.nodeId).toBe('node-1');
    });

    it('should include spDomain when baseStorageDomain is configured', async () => {
      // Re-register with baseStorageDomain
      routes = {};
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        baseUrl,
        baseStorageDomain: 'undefineds.site',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'abc12345-6789-0000-0000-000000000000',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({ publicUrl: 'https://sp.example.com', ipv4: '1.2.3.4' });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.spDomain).toBe('abc12345-6789-0000-0000-000000000000.undefineds.site');
      expect(body.provisionCode).toBeDefined();

      // provisionCode should contain spDomain
      const codec = new ProvisionCodeCodec(baseUrl);
      const payload = codec.decode(body.provisionCode);
      expect(payload).toBeDefined();
      expect(payload!.spDomain).toBe('abc12345-6789-0000-0000-000000000000.undefineds.site');

      // Should have called updateNodeMode with ipv4 and subdomain
      expect(mockRepo.updateNodeMode).toHaveBeenCalledWith(
        'abc12345-6789-0000-0000-000000000000',
        expect.objectContaining({
          accessMode: 'direct',
          ipv4: '1.2.3.4',
          subdomain: 'abc12345-6789-0000-0000-000000000000',
        }),
      );
    });

    it('should not allocate spDomain for self-managed domains even when baseStorageDomain is configured', async () => {
      routes = {};
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        baseUrl,
        baseStorageDomain: 'undefineds.co',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'https://node-0000.undefineds.co',
        domainMode: 'self-managed',
        spDomain: 'node-0000.undefineds.co',
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.spDomain).toBeUndefined();
      expect(mockRepo.updateNodeMode).not.toHaveBeenCalled();

      const codec = new ProvisionCodeCodec(baseUrl);
      const payload = codec.decode(body.provisionCode);
      expect(payload).toBeDefined();
      expect(payload!.spUrl).toBe('https://node-0000.undefineds.co');
      expect(payload!.spDomain).toBeUndefined();
    });

    it('should honor a managed spDomain request within the configured storage domain', async () => {
      routes = {};
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        baseUrl,
        baseStorageDomain: 'undefineds.co',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'https://node-0000.undefineds.co',
        domainMode: 'managed',
        spDomain: 'node-0000.undefineds.co',
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.spDomain).toBe('node-0000.undefineds.co');
      expect(mockRepo.updateNodeMode).toHaveBeenCalledWith(
        'node-1',
        expect.objectContaining({
          accessMode: 'proxy',
          subdomain: 'node-0000',
        }),
      );
    });

    it('should provision a managed Cloudflare tunnel from client tunnelToken without cfd_tunnel API', async () => {
      routes = {};
      const tunnelId = '11111111-2222-4333-8444-555555555555';
      const tokenPayload = Buffer.from(JSON.stringify({
        a: 'account-1',
        t: tunnelId,
        s: 'secret',
      })).toString('base64url');
      const tunnelToken = `${tokenPayload}.sig`;
      const mockDnsProvider = {
        upsertRecord: vi.fn().mockResolvedValue(undefined),
      };
      const mockDdnsRepo = {
        getRecord: vi.fn().mockResolvedValue(null),
        allocateSubdomain: vi.fn(),
        updateRecordIp: vi.fn(),
      };

      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        ddnsRepo: mockDdnsRepo as any,
        dnsProvider: mockDnsProvider as any,
        tunnelProvider: undefined,
        baseUrl,
        baseStorageDomain: 'nodes.undefineds.co',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'http://127.0.0.1:5737/',
        localPort: 5737,
        tunnelToken,
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(response.statusCode).toBe(201);
      expect(mockDdnsRepo.allocateSubdomain).toHaveBeenCalledWith({
        subdomain: 'node-1',
        domain: 'nodes.undefineds.co',
        nodeId: 'node-1',
        ipAddress: `${tunnelId}.cfargotunnel.com`,
        recordType: 'CNAME',
      });
      expect(mockDnsProvider.upsertRecord).toHaveBeenCalledWith({
        domain: 'nodes.undefineds.co',
        subdomain: 'node-1',
        type: 'CNAME',
        value: `${tunnelId}.cfargotunnel.com`,
        ttl: 60,
      });
      expect(mockRepo.mergeNodeMetadata).toHaveBeenCalledWith('node-1', expect.objectContaining({
        managedTunnel: expect.objectContaining({
          provider: 'cloudflare',
          tunnelId,
          tunnelToken,
          subdomain: 'node-1',
          localPort: 5737,
          source: 'client-token',
        }),
      }));
      expect(mockRepo.updateNodeMode).toHaveBeenCalledWith('node-1', expect.objectContaining({
        accessMode: 'proxy',
        subdomain: 'node-1',
      }));
      expect(body.tunnelToken).toBe(tunnelToken);
      expect(body.tunnelProvider).toBe('cloudflare');
      expect(body.tunnelEndpoint).toBe('https://node-1.nodes.undefineds.co');
    });

    it('should reject invalid tunnelToken with 400 instead of 500', async () => {
      routes = {};
      const mockDnsProvider = {
        upsertRecord: vi.fn().mockResolvedValue(undefined),
      };
      const mockDdnsRepo = {
        getRecord: vi.fn().mockResolvedValue(null),
        allocateSubdomain: vi.fn(),
        updateRecordIp: vi.fn(),
      };

      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        ddnsRepo: mockDdnsRepo as any,
        dnsProvider: mockDnsProvider as any,
        baseUrl,
        baseStorageDomain: 'nodes.undefineds.co',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'http://127.0.0.1:5737/',
        localPort: 5737,
        tunnelToken: 'not-a-valid-token',
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(400);
      expect(mockDnsProvider.upsertRecord).not.toHaveBeenCalled();
      expect(mockRepo.mergeNodeMetadata).not.toHaveBeenCalled();
      expect(JSON.parse((response.end as any).mock.calls[0][0])).toEqual({ error: 'Invalid Cloudflare tunnel token' });
    });

    it('should provision a managed Cloudflare tunnel when localPort is provided', async () => {
      routes = {};
      const mockTunnelProvider = {
        setup: vi.fn().mockResolvedValue({
          provider: 'cloudflare',
          subdomain: 'node-1',
          endpoint: 'https://node-1.undefineds.site',
          tunnelId: 'tunnel-1',
          tunnelToken: 'cf-token-1',
        }),
      };
      const mockDdnsRepo = {
        getRecord: vi.fn().mockResolvedValue(null),
        allocateSubdomain: vi.fn(),
      };

      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        ddnsRepo: mockDdnsRepo as any,
        tunnelProvider: mockTunnelProvider as any,
        baseUrl,
        baseStorageDomain: 'undefineds.site',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      mockRepo.getNodeMetadata.mockResolvedValue({ nodeId: 'node-1', metadata: null });

      const request = createMockRequest({ publicUrl: 'http://localhost:5737/', localPort: 5737 });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(response.statusCode).toBe(201);
      expect(mockTunnelProvider.setup).toHaveBeenCalledWith({
        subdomain: 'node-1',
        localPort: 5737,
      });
      expect(mockDdnsRepo.allocateSubdomain).toHaveBeenCalledWith(expect.objectContaining({
        subdomain: 'node-1',
        domain: 'undefineds.site',
        nodeId: 'node-1',
      }));
      expect(mockRepo.mergeNodeMetadata).toHaveBeenCalledWith('node-1', expect.objectContaining({
        managedTunnel: expect.objectContaining({
          provider: 'cloudflare',
          tunnelId: 'tunnel-1',
          tunnelToken: 'cf-token-1',
          subdomain: 'node-1',
          localPort: 5737,
        }),
      }));
      expect(mockRepo.updateNodeMode).toHaveBeenCalledWith(
        'node-1',
        expect.objectContaining({
          accessMode: 'proxy',
          subdomain: 'node-1',
        }),
      );
      expect(body.tunnelToken).toBe('cf-token-1');
      expect(body.tunnelProvider).toBe('cloudflare');
      expect(body.tunnelEndpoint).toBe('https://node-1.undefineds.site');
    });

    it('should not include spDomain when baseStorageDomain is not configured', async () => {
      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({ publicUrl: 'https://sp.example.com' });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.spDomain).toBeUndefined();
    });

    it('should not allocate spDomain for self-managed domains even when baseStorageDomain is configured', async () => {
      routes = {};
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        baseUrl,
        baseStorageDomain: 'undefineds.co',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'https://node-0000.undefineds.co',
        domainMode: 'self-managed',
        spDomain: 'node-0000.undefineds.co',
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.spDomain).toBeUndefined();
      expect(mockRepo.updateNodeMode).not.toHaveBeenCalled();

      const codec = new ProvisionCodeCodec(baseUrl);
      const payload = codec.decode(body.provisionCode);
      expect(payload).toBeDefined();
      expect(payload!.spUrl).toBe('https://node-0000.undefineds.co');
      expect(payload!.spDomain).toBeUndefined();
    });

    it('should honor a managed spDomain request within the configured storage domain', async () => {
      routes = {};
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        baseUrl,
        baseStorageDomain: 'undefineds.co',
      });

      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'node-1',
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'https://node-0000.undefineds.co',
        domainMode: 'managed',
        spDomain: 'node-0000.undefineds.co',
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.spDomain).toBe('node-0000.undefineds.co');
      expect(mockRepo.updateNodeMode).toHaveBeenCalledWith(
        'node-1',
        expect.objectContaining({
          subdomain: 'node-0000',
        }),
      );
    });

    it('should pass nodeId and serviceToken to registerSpNode', async () => {
      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'my-device-id',
        nodeToken: 'nt-xxx',
        serviceToken: 'my-service-token',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'https://sp.example.com',
        nodeId: 'my-device-id',
        nodeToken: 'stable-node-token',
        serviceToken: 'my-service-token',
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      expect(mockRepo.registerSpNode).toHaveBeenCalledWith(
        expect.objectContaining({
          publicUrl: 'https://sp.example.com',
          nodeId: 'my-device-id',
          nodeToken: 'stable-node-token',
          serviceToken: 'my-service-token',
        }),
      );

      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.nodeId).toBe('my-device-id');
      expect(body.serviceToken).toBe('my-service-token');
    });

    it('should pass nodeToken through for same-node re-registration', async () => {
      mockRepo.registerSpNode.mockResolvedValue({
        nodeId: 'my-device-id',
        nodeToken: 'stable-node-token',
        serviceToken: 'my-service-token',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const request = createMockRequest({
        publicUrl: 'https://sp.example.com',
        nodeId: 'my-device-id',
        nodeToken: 'stable-node-token',
        serviceToken: 'my-service-token',
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      expect(mockRepo.registerSpNode).toHaveBeenCalledWith(
        expect.objectContaining({
          publicUrl: 'https://sp.example.com',
          nodeId: 'my-device-id',
          nodeToken: 'stable-node-token',
          serviceToken: 'my-service-token',
        }),
      );

      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.nodeToken).toBe('stable-node-token');
    });

    it('should reject missing publicUrl', async () => {
      const request = createMockRequest({});
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid publicUrl format', async () => {
      const request = createMockRequest({ publicUrl: 'not-a-url' });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(400);
    });

    it('should return 500 on repository error', async () => {
      mockRepo.registerSpNode.mockRejectedValue(new Error('DB error'));

      const request = createMockRequest({ publicUrl: 'https://sp.example.com' });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(500);
    });
  });
});

describe('ProvisionStatusHandler', () => {
  let mockServer: ApiServer;
  let routes: Record<string, Function> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    routes = {};

    mockServer = {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer;
  });

  const createMockResponse = (): ServerResponse => ({
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse);

  it('should register GET /provision/status as public', () => {
    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://id.undefineds.co',
      nodeId: 'abc123',
    });

    expect(mockServer.get).toHaveBeenCalledWith('/provision/status', expect.any(Function), { public: true });
  });

  it('should return registered status with all fields', async () => {
    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://id.undefineds.co',
      nodeId: 'abc123',
      spDomain: 'abc123.undefineds.site',
      cloudBaseUrl: 'https://id.undefineds.co',
      provisionCode: 'test-code',
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(200);
    const body = JSON.parse((response.end as any).mock.calls[0][0]);
    expect(body.registered).toBe(true);
    expect(body.cloudUrl).toBe('https://id.undefineds.co');
    expect(body.nodeId).toBe('abc123');
    expect(body.spDomain).toBe('abc123.undefineds.site');
    expect(body.provisionUrl).toContain('provisionCode=test-code');
  });

  it('should return unregistered status when nodeId is missing', async () => {
    registerProvisionStatusRoute(mockServer, {
      cloudUrl: undefined,
      nodeId: undefined,
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(200);
    const body = JSON.parse((response.end as any).mock.calls[0][0]);
    expect(body.registered).toBe(false);
    expect(body.cloudUrl).toBeUndefined();
    expect(body.nodeId).toBeUndefined();
  });
});
