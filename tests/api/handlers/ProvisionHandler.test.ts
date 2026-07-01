import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalSetupProvisionStateWriter, registerProvisionRoutes, registerProvisionStatusRoute } from '../../../src/api/handlers/ProvisionHandler';
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
      expect(payload!.serviceToken).toBeUndefined();
      expect(payload!.serviceAccessToken).toMatch(/^sat-/);
      expect(payload!.serviceAccessTokenExp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 15 * 60);
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
      expect(body.publicUrl).toBe('https://abc12345-6789-0000-0000-000000000000.undefineds.site/');
      expect(body.provisionCode).toBeDefined();

      // provisionCode should contain spDomain
      const codec = new ProvisionCodeCodec(baseUrl);
      const payload = codec.decode(body.provisionCode);
      expect(payload).toBeDefined();
      expect(payload!.spUrl).toBe('https://sp.example.com');
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

    it('should allocate a stable managed publicUrl when none is supplied', async () => {
      routes = {};
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        baseUrl,
        baseStorageDomain: 'nodes.undefineds.co',
      });

      mockRepo.registerSpNode.mockImplementation(async (input: { publicUrl: string; nodeId?: string }) => ({
        nodeId: input.nodeId,
        nodeToken: 'nt-xxx',
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      }));

      const request = createMockRequest({ domainMode: 'managed', localPort: 5737 });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.nodeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.spDomain).toBe(`${body.nodeId}.nodes.undefineds.co`);
      expect(body.publicUrl).toBe(`https://${body.spDomain}/`);
      expect(mockRepo.registerSpNode).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: body.nodeId,
        publicUrl: body.publicUrl,
      }));

      const codec = new ProvisionCodeCodec(baseUrl);
      const payload = codec.decode(body.provisionCode);
      expect(payload).toBeDefined();
      expect(payload!.spUrl).toBe(body.publicUrl);
      expect(payload!.spDomain).toBe(body.spDomain);
    });

    it('should reuse a caller supplied nodeId for managed publicUrl allocation', async () => {
      routes = {};
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        baseUrl,
        baseStorageDomain: 'nodes.undefineds.co',
      });

      mockRepo.registerSpNode.mockImplementation(async (input: { publicUrl: string; nodeId?: string; nodeToken?: string }) => ({
        nodeId: input.nodeId,
        nodeToken: input.nodeToken,
        serviceToken: 'st-xxx',
        createdAt: '2024-01-01T00:00:00.000Z',
      }));

      const request = createMockRequest({
        domainMode: 'managed',
        nodeId: '868c9f63-6b0e-4255-8f7f-f2e347908ba4',
        nodeToken: 'stable-node-token',
        localPort: 5737,
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(201);
      const body = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(body.nodeId).toBe('868c9f63-6b0e-4255-8f7f-f2e347908ba4');
      expect(body.nodeToken).toBe('stable-node-token');
      expect(body.spDomain).toBe('868c9f63-6b0e-4255-8f7f-f2e347908ba4.nodes.undefineds.co');
      expect(body.publicUrl).toBe('https://868c9f63-6b0e-4255-8f7f-f2e347908ba4.nodes.undefineds.co/');
      expect(mockRepo.registerSpNode).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: body.nodeId,
        nodeToken: 'stable-node-token',
        publicUrl: body.publicUrl,
      }));
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

    it('should reject a managed spDomain that is allocated to another node', async () => {
      routes = {};
      const mockDdnsRepo = {
        getRecord: vi.fn().mockResolvedValue({
          subdomain: 'node-0000',
          domain: 'undefineds.co',
          nodeId: 'other-node',
          status: 'active',
        }),
      };
      mockServer = {
        post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
        get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
        delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
      } as unknown as ApiServer;

      registerProvisionRoutes(mockServer, {
        repository: mockRepo,
        ddnsRepo: mockDdnsRepo as any,
        baseUrl,
        baseStorageDomain: 'undefineds.co',
      });

      const request = createMockRequest({
        domainMode: 'managed',
        nodeId: 'node-1',
        spDomain: 'node-0000.undefineds.co',
        localPort: 5737,
      });
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(409);
      expect(JSON.parse((response.end as any).mock.calls[0][0])).toEqual({
        error: 'spDomain already allocated',
        spDomain: 'node-0000.undefineds.co',
      });
      expect(mockRepo.registerSpNode).not.toHaveBeenCalled();
      expect(mockRepo.updateNodeMode).not.toHaveBeenCalled();
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

    it('should reject missing publicUrl when no managed storage domain is configured', async () => {
      const request = createMockRequest({});
      const response = createMockResponse();

      await routes['POST /provision/nodes'](request, response, {});

      expect(response.statusCode).toBe(400);
    });

    it('should reject missing publicUrl for self-managed registration', async () => {
      const request = createMockRequest({ domainMode: 'self-managed' });
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
  let originalProvisionEnv: Record<string, string | undefined>;
  const provisionEnvKeys = [
    'XPOD_NODE_ID',
    'XPOD_NODE_TOKEN',
    'XPOD_SERVICE_TOKEN',
    'XPOD_PROVISION_CODE',
    'XPOD_PROVISION_URL',
    'XPOD_SP_DOMAIN',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    routes = {};
    originalProvisionEnv = Object.fromEntries(provisionEnvKeys.map((key) => [key, process.env[key]]));

    mockServer = {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer;
  });

  afterEach(() => {
    for (const key of provisionEnvKeys) {
      const original = originalProvisionEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  const createMockResponse = (): ServerResponse => ({
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse);

  const parseResponseBody = (response: ServerResponse): any => JSON.parse((response.end as any).mock.calls[0][0]);

  function makeProvisionCode(options: {
    baseUrl?: string;
    spUrl?: string;
    serviceToken?: string;
    nodeId?: string;
    spDomain?: string;
    exp: number;
  }): string {
    return new ProvisionCodeCodec(options.baseUrl ?? 'https://id.undefineds.co/').encode({
      spUrl: options.spUrl ?? 'https://node.example/',
      serviceToken: options.serviceToken ?? 'st-old',
      nodeId: options.nodeId ?? 'abc123',
      spDomain: options.spDomain,
      exp: options.exp,
    });
  }

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
      nodeToken: 'nt-old',
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
    expect(body.provisionCode).toBe('test-code');
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

  it('should stay unregistered until Cloud has issued a nodeToken', async () => {
    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
      nodeId: 'local-device-id',
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(200);
    const body = parseResponseBody(response);
    expect(body.registered).toBe(false);
    expect(body.nodeId).toBeUndefined();
    expect(body.provisionCode).toBeUndefined();
  });

  it('should keep registered status readable when no provisionCode has been issued yet', async () => {
    const fetchMock = vi.fn();

    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
      nodeId: 'abc123',
      nodeToken: 'nt-old',
      serviceToken: 'st-old',
      fetchImpl: fetchMock as any,
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = parseResponseBody(response);
    expect(body).toMatchObject({
      registered: true,
      cloudUrl: 'https://api.undefineds.co',
      nodeId: 'abc123',
    });
    expect(body.provisionCode).toBeUndefined();
  });

  it('should return a fresh provisionCode without refreshing Cloud', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const provisionCode = makeProvisionCode({
      exp: Math.floor(nowMs / 1000) + 3600,
    });
    const fetchMock = vi.fn();

    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
      nodeId: 'abc123',
      nodeToken: 'nt-old',
      serviceToken: 'st-old',
      publicUrl: 'https://node.example',
      provisionCode,
      fetchImpl: fetchMock as any,
      now: () => nowMs,
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = parseResponseBody(response);
    expect(body.provisionCode).toBe(provisionCode);
    expect(body.publicUrl).toBe('https://node.example/');
  });

  it('should lazily refresh an expired provisionCode before returning status', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiredCode = makeProvisionCode({
      serviceToken: 'st-old',
      exp: Math.floor(nowMs / 1000) - 60,
    });
    const freshCode = makeProvisionCode({
      serviceToken: 'st-new',
      spDomain: 'abc123.undefineds.site',
      exp: Math.floor(nowMs / 1000) + 3600,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        nodeId: 'abc123',
        nodeToken: 'nt-new',
        serviceToken: 'st-new',
        provisionCode: freshCode,
        publicUrl: 'https://node.example/',
        spDomain: 'abc123.undefineds.site',
      }),
    }));
    const persistState = vi.fn();

    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
      nodeId: 'abc123',
      nodeToken: 'nt-old',
      serviceToken: 'st-old',
      publicUrl: 'https://node.example',
      spDomain: 'abc123.undefineds.site',
      localPort: 5737,
      tunnelToken: 'tunnel-token',
      provisionCode: expiredCode,
      persistState,
      fetchImpl: fetchMock as any,
      now: () => nowMs,
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.undefineds.co/provision/nodes');
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      publicUrl: 'https://node.example/',
      nodeId: 'abc123',
      nodeToken: 'nt-old',
      serviceToken: 'st-old',
      domainMode: 'managed',
      spDomain: 'abc123.undefineds.site',
      localPort: 5737,
      tunnelToken: 'tunnel-token',
      tunnelMode: 'client',
    });
    const body = parseResponseBody(response);
    expect(body.provisionCode).toBe(freshCode);
    expect(body.provisionUrl).toContain(encodeURIComponent(freshCode));
    expect(process.env.XPOD_PROVISION_CODE).toBe(freshCode);
    expect(process.env.XPOD_PROVISION_URL).toContain(encodeURIComponent(freshCode));
    expect(persistState).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'abc123',
      nodeToken: 'nt-new',
      serviceToken: 'st-new',
      provisionCode: freshCode,
      publicUrl: 'https://node.example/',
      spDomain: 'abc123.undefineds.site',
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
    }));

    const secondResponse = createMockResponse();
    await routes['GET /provision/status']({}, secondResponse, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parseResponseBody(secondResponse).provisionCode).toBe(freshCode);
  });

  it('should update the shared Local setup file with refreshed provision state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-provision-setup-'));
    const setupPath = path.join(dir, 'xpod-cloud-registration.json');
    fs.writeFileSync(setupPath, JSON.stringify({
      local: {
        nodeId: 'old-node',
        nodeToken: 'old-node-token',
        serviceToken: 'old-service-token',
        provisionCode: 'old-code',
        publicUrl: 'https://old.example/',
        provisionUrl: 'https://id.undefineds.co/.account/?provisionCode=old-code',
        cloudIdentityUrl: 'https://id.undefineds.co',
        cloudApiUrl: 'https://api.undefineds.co',
        registeredAt: 1760000000000,
      },
    }, null, 2), 'utf8');

    const writer = createLocalSetupProvisionStateWriter(setupPath, 'local');
    expect(writer).toBeDefined();
    await writer!({
      nodeId: 'node-new',
      nodeToken: 'node-token-new',
      serviceToken: 'service-token-new',
      provisionCode: 'fresh-code',
      publicUrl: 'https://node-new.undefineds.co/',
      spDomain: 'node-new.undefineds.co',
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
    });

    const next = JSON.parse(fs.readFileSync(setupPath, 'utf8')).local;
    expect(next).toMatchObject({
      nodeId: 'node-new',
      nodeToken: 'node-token-new',
      serviceToken: 'service-token-new',
      provisionCode: 'fresh-code',
      publicUrl: 'https://node-new.undefineds.co/',
      spDomain: 'node-new.undefineds.co',
      provisionUrl: `https://id.undefineds.co/.account/?provisionCode=${encodeURIComponent('fresh-code')}`,
      cloudIdentityUrl: 'https://id.undefineds.co/',
      cloudApiUrl: 'https://api.undefineds.co/',
      registeredAt: 1760000000000,
    });
  });

  it('should fail status instead of returning an expired provisionCode when refresh fails', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiredCode = makeProvisionCode({
      exp: Math.floor(nowMs / 1000) - 60,
    });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Cloud unavailable',
    }));

    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
      nodeId: 'abc123',
      nodeToken: 'nt-old',
      serviceToken: 'st-old',
      publicUrl: 'https://node.example',
      provisionCode: expiredCode,
      fetchImpl: fetchMock as any,
      now: () => nowMs,
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(503);
    expect(parseResponseBody(response)).toMatchObject({
      registered: true,
      error: 'provision_refresh_failed',
    });
  });

  it('should not return an expired provisionCode when refresh inputs are incomplete', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiredCode = makeProvisionCode({
      exp: Math.floor(nowMs / 1000) - 60,
    });
    const fetchMock = vi.fn();

    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://api.undefineds.co',
      cloudBaseUrl: 'https://id.undefineds.co',
      nodeId: 'abc123',
      provisionCode: expiredCode,
      fetchImpl: fetchMock as any,
      now: () => nowMs,
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = parseResponseBody(response);
    expect(body.registered).toBe(false);
    expect(body.provisionCode).toBeUndefined();
    expect(body.error).toBeUndefined();
  });

  it('should not treat malformed self-contained provisionCode as usable when refresh fails', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Cloud unavailable',
    }));

    registerProvisionStatusRoute(mockServer, {
      cloudUrl: 'https://api.undefineds.co',
      nodeId: 'abc123',
      nodeToken: 'nt-old',
      serviceToken: 'st-old',
      publicUrl: 'https://node.example',
      provisionCode: 'not-json.signature',
      fetchImpl: fetchMock as any,
      now: () => nowMs,
    });

    const response = createMockResponse();
    await routes['GET /provision/status']({}, response, {});

    expect(response.statusCode).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
