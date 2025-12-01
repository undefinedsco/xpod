import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import { ClusterIngressRouter } from '../../src/http/ClusterIngressRouter';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';
import {
  NotImplementedHttpError,
  InternalServerError,
} from '@solid/community-server';

// Mock the EdgeNodeRepository
const mockRepository = {
  getNodeSecret: vi.fn(),
  getNodeConnectivityInfo: vi.fn(),
  getNodeMetadata: vi.fn(),
} as unknown as EdgeNodeRepository;

// Mock writable stream for response
class MockWritableResponse extends Writable {
  public statusCode = 200;
  public readonly headers: Record<string, any> = {};
  public setHeader = vi.fn((name: string, value: any) => {
    this.headers[name] = value;
  });
  public end = vi.fn((data?: any) => {
    if (data) {
      this.write(data);
    }
    super.end();
  });
  
  public _write(chunk: any, encoding: string, callback: () => void): void {
    callback();
  }
}

describe('ClusterIngressRouter', () => {
  let router: ClusterIngressRouter;
  let mockRequest: any;
  let mockResponse: MockWritableResponse;

  beforeEach(() => {
    vi.clearAllMocks();

    router = new ClusterIngressRouter({
      identityDbUrl: 'sqlite::memory:',
      edgeNodesEnabled: true,
      repository: mockRepository,
      clusterIngressDomain: 'cluster.example.com',
      skipAuthRedirect: true, // Skip for testing
    });

    mockRequest = {
      method: 'GET',
      url: '/data/test',
      headers: {
        host: 'node1.cluster.example.com',
      },
    };

    mockResponse = new MockWritableResponse();

    // Setup default mocks
    (mockRepository.getNodeSecret as any).mockResolvedValue({
      nodeId: 'node1',
      tokenHash: 'test-hash',
    });
    (mockRepository.getNodeMetadata as any).mockResolvedValue({
      nodeId: 'node1',
      metadata: null,
    });
  });

  describe('canHandle', () => {
    it('should handle valid node subdomain requests', async () => {
      const input = { request: mockRequest };
      
      await expect(router.canHandle(input)).resolves.not.toThrow();
      
      expect(mockRepository.getNodeSecret).toHaveBeenCalledWith('node1');
    });

    it('should reject requests to cluster domain itself', async () => {
      mockRequest.headers.host = 'cluster.example.com';
      const input = { request: mockRequest };
      
      await expect(router.canHandle(input))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('should reject requests to non-node subdomains', async () => {
      mockRequest.headers.host = 'invalid.subdomain.cluster.example.com';
      const input = { request: mockRequest };
      
      await expect(router.canHandle(input))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('should reject requests for non-existent nodes', async () => {
      (mockRepository.getNodeSecret as any).mockResolvedValue(null);
      const input = { request: mockRequest };
      
      await expect(router.canHandle(input))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('should reject when disabled', async () => {
      const disabledRouter = new ClusterIngressRouter({
        identityDbUrl: 'sqlite::memory:',
        edgeNodesEnabled: false,
        clusterIngressDomain: 'cluster.example.com',
      });

      const input = { request: mockRequest };
      
      await expect(disabledRouter.canHandle(input))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('should rewrite authentication requests to the cluster domain and skip handling', async () => {
      mockRequest.url = '/idp/auth';
      const input = { request: mockRequest };

      await expect(router.canHandle(input))
        .rejects.toThrow(NotImplementedHttpError);

      expect(mockRequest.headers['x-original-host']).toBe('node1.cluster.example.com');
      expect(mockRequest.headers.host).toBe('cluster.example.com');
      expect(mockRequest.headers['x-forwarded-host']).toBe('node1.cluster.example.com');
    });
  });

  describe('handle - Data Requests', () => {
    beforeEach(() => {
      mockRequest.url = '/data/test';
    });

    it('should redirect direct-mode nodes to their public IP', async () => {
      (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'direct',
        publicIp: '203.0.113.10',
        publicPort: 443,
      });

      const input = { request: mockRequest, response: mockResponse };
      
      await router.handle(input);
      
      expect(mockResponse.statusCode).toBe(307);
                  expect(mockResponse.statusCode).toBe(307);
                  expect(mockResponse.setHeader).toHaveBeenCalledWith('Location',
                    'https://203.0.113.10/data/test');
                  expect(mockResponse.setHeader).toHaveBeenCalledWith(
                    'X-Xpod-Direct-Node',
                    'node1'
                  );      expect(mockResponse.end).toHaveBeenCalled();
    });

    it('should handle custom port in direct mode', async () => {
      (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'direct',
        publicIp: '203.0.113.10',
        publicPort: 8443,
      });

      const input = { request: mockRequest, response: mockResponse };
      
      await router.handle(input);
      
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Location', 
        'https://203.0.113.10:8443/data/test'
      );
    });

    it('should proxy requests for proxy mode nodes', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('proxied response', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));

      const proxyRouter = new ClusterIngressRouter({
        identityDbUrl: 'sqlite::memory:',
        edgeNodesEnabled: true,
        repository: mockRepository,
        clusterIngressDomain: 'cluster.example.com',
        skipAuthRedirect: true,
        fetchImpl: mockFetch,
      });

      (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'proxy',
        publicIp: null,
      });
      
      (mockRepository.getNodeMetadata as any).mockResolvedValue({
        nodeId: 'node1',
        metadata: {
          tunnel: {
            entrypoint: 'https://tunnel.example.com/',
          },
        },
      });

      const input = { request: mockRequest, response: mockResponse };
      
      await proxyRouter.handle(input);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://tunnel.example.com/data/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.any(Headers),
        })
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Xpod-Proxy-Node', 'node1');
    });

    it('should handle missing tunnel entrypoint for proxy mode', async () => {
      (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'proxy',
        publicIp: null,
      });
      
      (mockRepository.getNodeMetadata as any).mockResolvedValue({
        nodeId: 'node1',
        metadata: {}, // No tunnel info
      });

      const input = { request: mockRequest, response: mockResponse };
      
      await expect(router.handle(input))
        .rejects.toThrow(InternalServerError);
    });

    it('should handle missing connectivity info', async () => {
      (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue(null);

      const input = { request: mockRequest, response: mockResponse };
      
      await expect(router.handle(input))
        .rejects.toThrow(InternalServerError);
    });
  });

  describe('URL parsing and routing', () => {
    it('should preserve query parameters in redirects', async () => {
      mockRequest.url = '/data/test?param=value&other=123';
      (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'direct',
        publicIp: '203.0.113.10',
        publicPort: 443,
      });

      const input = { request: mockRequest, response: mockResponse };
      
      await router.handle(input);
      
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Location', 
        'https://203.0.113.10/data/test?param=value&other=123'
      );
    });

    it('should handle different node IDs correctly', async () => {
      mockRequest.headers.host = 'myapp.cluster.example.com';
      (mockRepository.getNodeSecret as any).mockResolvedValue({
        nodeId: 'myapp',
        tokenHash: 'test-hash',
      });
      (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue({
        nodeId: 'myapp',
        accessMode: 'direct',
        publicIp: '198.51.100.20',
        publicPort: 443,
      });

      const input = { request: mockRequest, response: mockResponse };
      
      await router.handle(input);
      
      expect(mockRepository.getNodeConnectivityInfo).toHaveBeenCalledWith('myapp');
      expect(mockResponse.statusCode).toBe(307);
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Location',
        'https://198.51.100.20/data/test');
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'X-Xpod-Direct-Node',
        'myapp'
      );
    });
  });
});
