import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { ClusterWebSocketConfigurator } from '../../src/http/ClusterWebSocketConfigurator';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';

// Mock the EdgeNodeRepository
const mockRepository = {
  getNodeSecret: vi.fn(),
  getNodeConnectivityInfo: vi.fn(),
  getNodeMetadata: vi.fn(),
} as unknown as EdgeNodeRepository;

// Mock socket
function createMockSocket(): Duplex & { written: string[], destroyed: boolean, ended: boolean } {
  const written: string[] = [];
  return {
    written,
    destroyed: false,
    ended: false,
    write: vi.fn((data: string) => {
      written.push(data);
      return true;
    }),
    end: vi.fn(function(this: any) {
      this.ended = true;
    }),
    destroy: vi.fn(function(this: any) {
      this.destroyed = true;
    }),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    pipe: vi.fn(),
    unpipe: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    listenerCount: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    eventNames: vi.fn(),
    addListener: vi.fn(),
    off: vi.fn(),
  } as any;
}

function createMockRequest(hostname: string, url = '/'): IncomingMessage {
  return {
    headers: {
      host: hostname,
      upgrade: 'websocket',
      connection: 'Upgrade',
    },
    url,
    method: 'GET',
    socket: {
      remoteAddress: '127.0.0.1',
    },
  } as unknown as IncomingMessage;
}

// Helper to wait for async operations
const waitForAsync = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('ClusterWebSocketConfigurator', () => {
  const clusterDomain = 'cluster.example.com';
  let configurator: ClusterWebSocketConfigurator;
  let mockServer: Server;
  let upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null;

  beforeEach(() => {
    vi.resetAllMocks();
    upgradeHandler = null;

    mockServer = {
      prependListener: vi.fn((event: string, handler: any) => {
        if (event === 'upgrade') {
          upgradeHandler = handler;
        }
      }),
      on: vi.fn(),
    } as unknown as Server;

    configurator = new ClusterWebSocketConfigurator({
      identityDbUrl: 'postgresql://localhost/test',
      edgeNodesEnabled: true,
      repository: mockRepository,
      clusterIngressDomain: clusterDomain,
    });
  });

  describe('handle', () => {
    it('should attach upgrade listener to server', async () => {
      await configurator.handle(mockServer);
      expect(mockServer.prependListener).toHaveBeenCalledWith('upgrade', expect.any(Function));
    });

    it('should not attach listener when disabled', async () => {
      const disabledConfigurator = new ClusterWebSocketConfigurator({
        identityDbUrl: 'postgresql://localhost/test',
        edgeNodesEnabled: false,
        repository: mockRepository,
        clusterIngressDomain: clusterDomain,
      });

      await disabledConfigurator.handle(mockServer);
      expect(mockServer.prependListener).not.toHaveBeenCalled();
    });
  });

  describe('WebSocket upgrade handling', () => {
    beforeEach(async () => {
      await configurator.handle(mockServer);
    });

    it('should ignore requests to cluster domain', async () => {
      const request = createMockRequest(clusterDomain);
      const socket = createMockSocket();

      upgradeHandler!(request, socket, Buffer.alloc(0));
      await waitForAsync();

      // Should not destroy or write anything - let other handlers deal with it
      expect(socket.destroyed).toBe(false);
      expect(socket.written.length).toBe(0);
    });

    it('should return 404 for unregistered node', async () => {
      mockRepository.getNodeSecret = vi.fn().mockResolvedValue(null);

      const request = createMockRequest('unknown.cluster.example.com');
      const socket = createMockSocket();

      upgradeHandler!(request, socket, Buffer.alloc(0));
      await waitForAsync();

      expect(socket.written[0]).toContain('404');
      expect(socket.ended).toBe(true);
    });

    it('should redirect for direct mode', async () => {
      mockRepository.getNodeSecret = vi.fn().mockResolvedValue({ secret: 'test' });
      mockRepository.getNodeConnectivityInfo = vi.fn().mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'direct',
        publicIp: '1.2.3.4',
        publicPort: 443,
      });

      const request = createMockRequest('node1.cluster.example.com', '/-/terminal/sessions/abc/ws');
      const socket = createMockSocket();

      upgradeHandler!(request, socket, Buffer.alloc(0));
      await waitForAsync();

      expect(socket.written[0]).toContain('307 Temporary Redirect');
      expect(socket.written[0]).toContain('Location: wss://1.2.3.4/-/terminal/sessions/abc/ws');
      expect(socket.written[0]).toContain('X-Xpod-Direct-Node: node1');
      expect(socket.ended).toBe(true);
    });

    it('should redirect with port for non-443 port', async () => {
      mockRepository.getNodeSecret = vi.fn().mockResolvedValue({ secret: 'test' });
      mockRepository.getNodeConnectivityInfo = vi.fn().mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'direct',
        publicIp: '1.2.3.4',
        publicPort: 8443,
      });

      const request = createMockRequest('node1.cluster.example.com', '/test');
      const socket = createMockSocket();

      upgradeHandler!(request, socket, Buffer.alloc(0));
      await waitForAsync();

      expect(socket.written[0]).toContain('Location: wss://1.2.3.4:8443/test');
    });

    it('should return 502 when node connectivity info not found', async () => {
      mockRepository.getNodeSecret = vi.fn().mockResolvedValue({ secret: 'test' });
      mockRepository.getNodeConnectivityInfo = vi.fn().mockResolvedValue(null);

      const request = createMockRequest('node1.cluster.example.com');
      const socket = createMockSocket();

      upgradeHandler!(request, socket, Buffer.alloc(0));
      await waitForAsync();

      expect(socket.written[0]).toContain('502');
      expect(socket.ended).toBe(true);
    });

    it('should return 502 when tunnel not ready in proxy mode', async () => {
      mockRepository.getNodeSecret = vi.fn().mockResolvedValue({ secret: 'test' });
      mockRepository.getNodeConnectivityInfo = vi.fn().mockResolvedValue({
        nodeId: 'node1',
        accessMode: 'proxy',
      });
      mockRepository.getNodeMetadata = vi.fn().mockResolvedValue({ metadata: {} });

      const request = createMockRequest('node1.cluster.example.com');
      const socket = createMockSocket();

      upgradeHandler!(request, socket, Buffer.alloc(0));
      await waitForAsync();

      expect(socket.written[0]).toContain('502');
      expect(socket.written[0]).toContain('Node tunnel not ready');
    });
  });
});
