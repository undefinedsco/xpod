import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSocket = {
  connect: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
};

// Mock node module
vi.mock('node:net', () => ({
  Socket: vi.fn().mockImplementation(() => mockSocket),
}));

import { EdgeNodeModeDetector, type NodeRegistrationInfo } from '../../src/edge/EdgeNodeModeDetector';

describe('EdgeNodeModeDetector', () => {
  let detector: EdgeNodeModeDetector;

  beforeEach(() => {
    detector = new EdgeNodeModeDetector({
      baseDomain: 'cluster.example.com',
      connectivityTimeoutMs: 1000,
      maxDirectModeAttempts: 2,
    });

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('detectMode', () => {
    it('should return proxy mode when no public IP is provided', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node-123',
        capabilities: {
          solidProtocolVersion: '1.0.0',
          storageBackends: ['file'],
          supportedModes: [ 'direct', 'proxy' ],
        },
      };

      const result = await detector.detectMode(nodeInfo);

      expect(result).toEqual({
        accessMode: 'proxy',
        reason: 'Direct not available, using proxy',
        subdomain: 'test-node-123.cluster.example.com',
      });
    });

    it('should return direct mode when connectivity test passes', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node-456',
        publicIp: '192.168.1.100',
        publicPort: 3000,
        capabilities: {
          solidProtocolVersion: '1.0.0',
          storageBackends: ['file'],
          supportedModes: [ 'direct', 'proxy' ],
        },
      };

      // Mock successful connection
      mockSocket.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'connect') {
          setTimeout(callback, 10); // Simulate quick connection
        }
      });

      const result = await detector.detectMode(nodeInfo);

      expect(result.accessMode).toBe('direct');
      expect(result.reason).toBe('Direct connectivity test passed');
      expect(result.subdomain).toBe('test-node-456.cluster.example.com');
      expect(result.connectivityTest?.success).toBe(true);
      expect(result.connectivityTest?.latency).toBeGreaterThan(0);
    });

    it('should return proxy mode when connectivity test fails', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node-789',
        publicIp: '10.0.0.1',
        publicPort: 443,
        capabilities: {
          solidProtocolVersion: '1.0.0',
          storageBackends: ['file'],
          supportedModes: [ 'direct', 'proxy' ],
        },
      };

      // Mock failed connection
      mockSocket.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'error') {
          setTimeout(() => callback(new Error('Connection refused')), 10);
        }
      });

      const result = await detector.detectMode(nodeInfo);

      expect(result.accessMode).toBe('proxy');
      expect(result.reason).toContain('Direct connectivity failed');
      expect(result.subdomain).toBe('test-node-789.cluster.example.com');
      expect(result.connectivityTest?.success).toBe(false);
      expect(result.connectivityTest?.error).toBe('Connection refused');
    });

    it('should use default port 443 when no port is provided', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node-default-port',
        publicIp: '203.0.113.1',
        capabilities: {
          solidProtocolVersion: '1.0.0',
          storageBackends: ['file'],
          supportedModes: [ 'direct', 'proxy' ],
        },
      };

      // Mock connection
      mockSocket.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'connect') {
          setTimeout(callback, 10);
        }
      });

      await detector.detectMode(nodeInfo);

      expect(mockSocket.connect).toHaveBeenCalledWith(443, '203.0.113.1');
    });

    it('should handle connection timeout correctly', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node-timeout',
        publicIp: '198.51.100.1',
        publicPort: 8080,
        capabilities: {
          solidProtocolVersion: '1.0.0',
          storageBackends: ['file'],
          supportedModes: [ 'direct', 'proxy' ],
        },
      };

      // Mock timeout - don't call any callbacks
      mockSocket.on.mockImplementation(() => {});

      const result = await detector.detectMode(nodeInfo);

      expect(result.accessMode).toBe('proxy');
      expect(result.reason).toContain('Direct connectivity failed');
      expect(result.connectivityTest?.success).toBe(false);
      expect(result.connectivityTest?.error).toBe('Connection timeout after 1000ms');
    });

    it('should sanitize node ID for subdomain generation', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test@node#123!',
        capabilities: {
          solidProtocolVersion: '1.0.0',
          supportedModes: [ 'direct', 'proxy' ],
        },
      };

      const result = await detector.detectMode(nodeInfo);

      expect(result.subdomain).toBe('testnode123.cluster.example.com');
    });

    it('should skip direct detection when node only supports proxy mode', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'proxied-only',
        publicIp: '192.0.2.1',
        capabilities: {
          supportedModes: [ 'proxy' ],
        },
      };

      const result = await detector.detectMode(nodeInfo);

      expect(result.accessMode).toBe('proxy');
      expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    it('should remain in direct mode when proxy mode is unsupported', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'direct-only',
        publicIp: '198.51.100.2',
        capabilities: {
          supportedModes: [ 'direct' ],
        },
      };

      mockSocket.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'error') {
          setTimeout(() => callback(new Error('Connection refused')), 5);
        }
      });

      const result = await detector.detectMode(nodeInfo);

      expect(result.accessMode).toBe('direct');
      expect(result.reason).toContain('Direct connectivity failed and proxy not supported');
    });
  });

  describe('recheckMode', () => {
    it('should return null when current mode is direct', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node',
        publicIp: '192.168.1.1',
        capabilities: { supportedModes: [ 'direct', 'proxy' ] },
      };

      const result = await detector.recheckMode('direct', nodeInfo);

      expect(result).toBeNull();
    });

    it('should return null when no public IP is available', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node',
        capabilities: { supportedModes: [ 'direct', 'proxy' ] },
      };

      const result = await detector.recheckMode('proxy', nodeInfo);

      expect(result).toBeNull();
    });

    it('should return direct mode when connectivity is restored', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node-restored',
        publicIp: '10.1.1.1',
        publicPort: 3000,
        capabilities: { supportedModes: [ 'direct', 'proxy' ] },
      };

      // Mock successful connection
      mockSocket.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'connect') {
          setTimeout(callback, 5);
        }
      });

      const result = await detector.recheckMode('proxy', nodeInfo);

      expect(result?.accessMode).toBe('direct');
      expect(result?.reason).toBe('Direct connectivity restored');
      expect(result?.connectivityTest?.success).toBe(true);
    });

    it('should return null when connectivity is still failed', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'test-node-still-failed',
        publicIp: '172.16.0.1',
        capabilities: { supportedModes: [ 'direct', 'proxy' ] },
      };

      // Mock failed connection
      mockSocket.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'error') {
          setTimeout(() => callback(new Error('Still unreachable')), 5);
        }
      });

      const result = await detector.recheckMode('proxy', nodeInfo);

      expect(result).toBeNull();
    });

    it('should skip recheck entirely when direct mode is not supported', async () => {
      const nodeInfo: NodeRegistrationInfo = {
        nodeId: 'proxied-only',
        publicIp: '203.0.113.5',
        capabilities: { supportedModes: [ 'proxy' ] },
      };

      const result = await detector.recheckMode('proxy', nodeInfo);

      expect(result).toBeNull();
      expect(mockSocket.connect).not.toHaveBeenCalled();
    });
  });
});
