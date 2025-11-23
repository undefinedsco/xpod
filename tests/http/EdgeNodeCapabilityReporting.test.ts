import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EdgeNodeSignalHttpHandler } from '../../src/http/admin/EdgeNodeSignalHttpHandler';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';
import { EdgeNodeCapabilityDetector } from '../../src/edge/EdgeNodeCapabilityDetector';
import { 
  InternalServerError, 
  UnauthorizedHttpError,
  BadRequestHttpError 
} from '@solid/community-server';

// Mock the database
const mockRepository = {
  getNodeSecret: vi.fn(),
  updateNodeHeartbeat: vi.fn(),
  replaceNodePods: vi.fn(),
  getNodeConnectivityInfo: vi.fn(),
  updateNodeMode: vi.fn(),
  matchesToken: vi.fn(),
} as unknown as EdgeNodeRepository;

// Mock the capability detector
const mockCapabilityDetector = {
  detectCapabilities: vi.fn(),
} as unknown as EdgeNodeCapabilityDetector;

describe('EdgeNodeSignalHttpHandler - Capability Reporting', () => {
  let handler: EdgeNodeSignalHttpHandler;
  let mockRequest: any;
  let mockResponse: any;

  beforeEach(() => {
    vi.clearAllMocks();

    handler = new EdgeNodeSignalHttpHandler({
      identityDbUrl: 'sqlite::memory:',
      basePath: '/api/signal',
      edgeNodesEnabled: true,
      repository: mockRepository,
      capabilityDetector: mockCapabilityDetector,
    });

    mockRequest = {
      method: 'POST',
      url: '/api/signal',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:3000',
      },
    };

    mockResponse = {
      statusCode: 200,
      writeHead: vi.fn(),
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    // Setup default mocks
    (mockRepository.matchesToken as any).mockReturnValue(true);
    (mockRepository.getNodeSecret as any).mockResolvedValue({
      nodeId: 'test-node',
      tokenHash: 'valid-hash',
      metadata: {},
    });
    (mockRepository.getNodeConnectivityInfo as any).mockResolvedValue(null);
    (mockRepository.updateNodeHeartbeat as any).mockResolvedValue(undefined);
    (mockCapabilityDetector.detectCapabilities as any).mockResolvedValue({
      solidProtocolVersion: 'solid-0.11-test',
      storageBackends: ['filesystem', 'database'],
      authMethods: ['webid', 'oidc'],
      maxBandwidth: 100,
    });
  });

  it('should enhance capabilities when capability detector is available', async () => {
    // Mock request body
    const payload = {
      nodeId: 'test-node',
      token: 'valid-token',
      capabilities: ['custom:feature'],
    };

    // Mock request reading
    let requestBody = '';
    mockRequest.on = vi.fn((event, callback) => {
      if (event === 'data') {
        callback(JSON.stringify(payload));
      } else if (event === 'end') {
        callback();
      }
    });

    const canHandleInput = { request: mockRequest };
    const handleInput = { request: mockRequest, response: mockResponse };

    // Test
    await expect(handler.canHandle(canHandleInput)).resolves.not.toThrow();
    await handler.handle(handleInput);

    // Verify capability detector was called
    expect(mockCapabilityDetector.detectCapabilities).toHaveBeenCalled();

    // Verify updateNodeHeartbeat was called with enhanced metadata
    expect(mockRepository.updateNodeHeartbeat).toHaveBeenCalledWith(
      'test-node',
      expect.objectContaining({
        capabilities: expect.arrayContaining([
          'custom:feature', // Original capability
          'solid:solid-0.11-test', // Detected capability
          'storage:filesystem',
          'storage:database',
          'auth:webid',
          'auth:oidc',
          'bandwidth:100mbps',
        ]),
        detectedCapabilities: {
          solidProtocolVersion: 'solid-0.11-test',
          storageBackends: ['filesystem', 'database'],
          authMethods: ['webid', 'oidc'],
          maxBandwidth: 100,
        },
      }),
      expect.any(Date)
    );
  });

  it('should continue working when capability detection fails', async () => {
    // Mock capability detection failure
    (mockCapabilityDetector.detectCapabilities as any).mockRejectedValue(
      new Error('Detection failed')
    );

    // Mock request body
    const payload = {
      nodeId: 'test-node',
      token: 'valid-token',
      capabilities: ['custom:feature'],
    };

    // Mock request reading
    mockRequest.on = vi.fn((event, callback) => {
      if (event === 'data') {
        callback(JSON.stringify(payload));
      } else if (event === 'end') {
        callback();
      }
    });

    const handleInput = { request: mockRequest, response: mockResponse };

    // Test - should not throw even if capability detection fails
    await expect(handler.handle(handleInput)).resolves.not.toThrow();

    // Verify original capabilities are still used
    expect(mockRepository.updateNodeHeartbeat).toHaveBeenCalledWith(
      'test-node',
      expect.objectContaining({
        capabilities: ['custom:feature'],
      }),
      expect.any(Date)
    );
  });

  it('should work without capability detector', async () => {
    // Create handler without capability detector
    const handlerWithoutDetector = new EdgeNodeSignalHttpHandler({
      identityDbUrl: 'sqlite::memory:',
      basePath: '/api/signal',
      edgeNodesEnabled: true,
      repository: mockRepository,
      // No capabilityDetector
    });

    // Mock request body
    const payload = {
      nodeId: 'test-node',
      token: 'valid-token',
      capabilities: ['custom:feature'],
    };

    // Mock request reading
    mockRequest.on = vi.fn((event, callback) => {
      if (event === 'data') {
        callback(JSON.stringify(payload));
      } else if (event === 'end') {
        callback();
      }
    });

    const handleInput = { request: mockRequest, response: mockResponse };

    // Test
    await expect(handlerWithoutDetector.handle(handleInput)).resolves.not.toThrow();

    // Verify only original capabilities are used
    expect(mockRepository.updateNodeHeartbeat).toHaveBeenCalledWith(
      'test-node',
      expect.objectContaining({
        capabilities: ['custom:feature'],
      }),
      expect.any(Date)
    );
  });
});