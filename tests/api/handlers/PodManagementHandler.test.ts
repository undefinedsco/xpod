import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPodManagementRoutes } from '../../../src/api/handlers/PodManagementHandler';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

import { stat, mkdir, rm } from 'node:fs/promises';

describe('PodManagementHandler', () => {
  let mockServer: ApiServer;
  let routes: Record<string, Function> = {};
  const testDir = '/test/pods';
  const mockVerifyToken = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    routes = {};

    // Mock ApiServer
    mockServer = {
      post: vi.fn((path, handler) => { routes[`POST ${path}`] = handler; }),
      delete: vi.fn((path, handler) => { routes[`DELETE ${path}`] = handler; }),
      get: vi.fn((path, handler) => { routes[`GET ${path}`] = handler; }),
    } as unknown as ApiServer;

    registerPodManagementRoutes(mockServer, {
      rootDir: testDir,
      verifyServiceToken: mockVerifyToken,
    });
  });

  describe('route registration', () => {
    it('should register POST /api/v1/pods', () => {
      expect(mockServer.post).toHaveBeenCalledWith('/api/v1/pods', expect.any(Function), { public: true });
    });

    it('should register DELETE /api/v1/pods/:podName', () => {
      expect(mockServer.delete).toHaveBeenCalledWith('/api/v1/pods/:podName', expect.any(Function), { public: true });
    });

    it('should register GET /api/v1/pods/:podName', () => {
      expect(mockServer.get).toHaveBeenCalledWith('/api/v1/pods/:podName', expect.any(Function), { public: true });
    });
  });

  describe('POST /api/v1/pods', () => {
    const createMockRequest = (body: object, authHeader?: string): IncomingMessage =>
      ({
        headers: { authorization: authHeader, host: 'node1.pods.example.com' },
        setEncoding: vi.fn(),
        on: vi.fn((event, callback) => {
          if (event === 'data') callback(JSON.stringify(body));
          if (event === 'end') callback();
        }),
      } as unknown as IncomingMessage);

    const createMockResponse = (): ServerResponse =>
      ({
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse);

    it('should create pod with valid token', async () => {
      mockVerifyToken.mockResolvedValue(true);
      vi.mocked(stat).mockRejectedValue(new Error('Not found'));
      vi.mocked(mkdir).mockResolvedValue(undefined);

      const request = createMockRequest({ podName: 'alice' }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /api/v1/pods'](request, response, {});

      expect(response.statusCode).toBe(201);
      expect(mkdir).toHaveBeenCalledWith(`${testDir}/alice`, { recursive: true });
    });

    it('should reject invalid token', async () => {
      mockVerifyToken.mockResolvedValue(false);

      const request = createMockRequest({ podName: 'alice' }, 'Bearer invalid_token');
      const response = createMockResponse();

      await routes['POST /api/v1/pods'](request, response, {});

      expect(response.statusCode).toBe(401);
    });

    it('should reject missing auth header', async () => {
      const request = createMockRequest({ podName: 'alice' });
      const response = createMockResponse();

      await routes['POST /api/v1/pods'](request, response, {});

      expect(response.statusCode).toBe(401);
    });

    it('should reject invalid pod name', async () => {
      mockVerifyToken.mockResolvedValue(true);

      const request = createMockRequest({ podName: 'invalid.pod' }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /api/v1/pods'](request, response, {});

      expect(response.statusCode).toBe(400);
    });

    it('should reject duplicate pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);

      const request = createMockRequest({ podName: 'alice' }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /api/v1/pods'](request, response, {});

      expect(response.statusCode).toBe(409);
    });
  });

  describe('DELETE /api/v1/pods/:podName', () => {
    const createMockRequest = (authHeader?: string): IncomingMessage =>
      ({
        headers: { authorization: authHeader },
      } as unknown as IncomingMessage);

    const createMockResponse = (): ServerResponse =>
      ({
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse);

    it('should delete existing pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
      vi.mocked(rm).mockResolvedValue(undefined);

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['DELETE /api/v1/pods/:podName'](request, response, { podName: 'alice' });

      expect(response.statusCode).toBe(200);
      expect(rm).toHaveBeenCalledWith(`${testDir}/alice`, { recursive: true, force: true });
    });

    it('should return 404 for non-existent pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      vi.mocked(stat).mockRejectedValue(new Error('Not found'));

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['DELETE /api/v1/pods/:podName'](request, response, { podName: 'nonexistent' });

      expect(response.statusCode).toBe(404);
    });

    it('should reject invalid token', async () => {
      mockVerifyToken.mockResolvedValue(false);

      const request = createMockRequest('Bearer invalid_token');
      const response = createMockResponse();

      await routes['DELETE /api/v1/pods/:podName'](request, response, { podName: 'alice' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/pods/:podName', () => {
    const createMockRequest = (authHeader?: string): IncomingMessage =>
      ({
        headers: { authorization: authHeader, host: 'node1.pods.example.com' },
      } as unknown as IncomingMessage);

    const createMockResponse = (): ServerResponse =>
      ({
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse);

    it('should return pod info for existing pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['GET /api/v1/pods/:podName'](request, response, { podName: 'alice' });

      expect(response.statusCode).toBe(200);
      const responseBody = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(responseBody.exists).toBe(true);
      expect(responseBody.podName).toBe('alice');
      expect(responseBody.podUrl).toBe('https://node1.pods.example.com/alice/');
    });

    it('should return 404 for non-existent pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      vi.mocked(stat).mockRejectedValue(new Error('Not found'));

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['GET /api/v1/pods/:podName'](request, response, { podName: 'nonexistent' });

      expect(response.statusCode).toBe(404);
    });
  });
});
