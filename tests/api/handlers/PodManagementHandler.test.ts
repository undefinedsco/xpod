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
  const podLookupRepository = {
    findByWebIds: vi.fn(),
  };

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
      podLookupRepository,
      storageProviderBaseUrl: 'http://localhost:5737/',
    });
  });

  describe('route registration', () => {
    it('should register POST /provision/pods', () => {
      expect(mockServer.post).toHaveBeenCalledWith('/provision/pods', expect.any(Function), { public: true });
    });

    it('should register DELETE /provision/pods/:podName', () => {
      expect(mockServer.delete).toHaveBeenCalledWith('/provision/pods/:podName', expect.any(Function), { public: true });
    });

    it('should register GET /provision/pods/:podName', () => {
      expect(mockServer.get).toHaveBeenCalledWith('/provision/pods/:podName', expect.any(Function), { public: true });
    });

    it('should register POST /provision/webids', () => {
      expect(mockServer.post).toHaveBeenCalledWith('/provision/webids', expect.any(Function), { public: true });
    });
  });

  describe('POST /provision/pods', () => {
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
      (stat as any).mockRejectedValue(new Error('Not found'));
      (mkdir as any).mockResolvedValue(undefined);

      const request = createMockRequest({ podName: 'alice' }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/pods'](request, response, {});

      expect(response.statusCode).toBe(201);
      expect(mkdir).toHaveBeenCalledWith(`${testDir}/alice`, { recursive: true });
    });

    it('should reject invalid token', async () => {
      mockVerifyToken.mockResolvedValue(false);

      const request = createMockRequest({ podName: 'alice' }, 'Bearer invalid_token');
      const response = createMockResponse();

      await routes['POST /provision/pods'](request, response, {});

      expect(response.statusCode).toBe(401);
    });

    it('should reject missing auth header', async () => {
      const request = createMockRequest({ podName: 'alice' });
      const response = createMockResponse();

      await routes['POST /provision/pods'](request, response, {});

      expect(response.statusCode).toBe(401);
    });

    it('should reject invalid pod name', async () => {
      mockVerifyToken.mockResolvedValue(true);

      const request = createMockRequest({ podName: 'invalid.pod' }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/pods'](request, response, {});

      expect(response.statusCode).toBe(400);
    });

    it('should reject duplicate pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockResolvedValue({ isDirectory: () => true } as any);

      const request = createMockRequest({ podName: 'alice' }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/pods'](request, response, {});

      expect(response.statusCode).toBe(409);
    });

    it('returns an existing provisioned pod for an idempotent same-WebID retry', async () => {
      routes = {};
      const provisioningService = { createPod: vi.fn() };
      registerPodManagementRoutes(mockServer, {
        rootDir: testDir,
        verifyServiceToken: mockVerifyToken,
        provisioningService,
        podLookupRepository,
        storageProviderBaseUrl: 'http://localhost:5737/',
      });
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockResolvedValue({ isDirectory: () => true } as any);
      podLookupRepository.findByWebIds.mockResolvedValue([
        {
          podId: 'pod-alice',
          accountId: 'acc-1',
          baseUrl: 'http://localhost:5737/alice/',
          storageUrl: 'http://localhost:5737/alice/',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
      ]);

      const request = createMockRequest({
        podName: 'alice',
        webId: 'https://id.undefineds.co/alice/profile/card#me',
      }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/pods'](request, response, {});

      expect(response.statusCode).toBe(200);
      expect(provisioningService.createPod).not.toHaveBeenCalled();
      expect(JSON.parse((response.end as any).mock.calls[0][0])).toEqual({
        success: true,
        podUrl: 'http://localhost:5737/alice/',
        message: 'Pod alice already exists for this WebID',
      });
    });

    it('keeps duplicate pod conflicts when existing ownership cannot be proven', async () => {
      routes = {};
      const provisioningService = { createPod: vi.fn() };
      registerPodManagementRoutes(mockServer, {
        rootDir: testDir,
        verifyServiceToken: mockVerifyToken,
        provisioningService,
        podLookupRepository,
        storageProviderBaseUrl: 'http://localhost:5737/',
      });
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockResolvedValue({ isDirectory: () => true } as any);
      podLookupRepository.findByWebIds.mockResolvedValue([]);

      const request = createMockRequest({
        podName: 'alice',
        webId: 'https://id.undefineds.co/alice/profile/card#me',
      }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/pods'](request, response, {});

      expect(response.statusCode).toBe(409);
      expect(provisioningService.createPod).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /provision/pods/:podName', () => {
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
      (stat as any).mockResolvedValue({ isDirectory: () => true } as any);
      (rm as any).mockResolvedValue(undefined);

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['DELETE /provision/pods/:podName'](request, response, { podName: 'alice' });

      expect(response.statusCode).toBe(200);
      expect(rm).toHaveBeenCalledWith(`${testDir}/alice`, { recursive: true, force: true });
    });

    it('should return 404 for non-existent pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockRejectedValue(new Error('Not found'));

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['DELETE /provision/pods/:podName'](request, response, { podName: 'nonexistent' });

      expect(response.statusCode).toBe(404);
    });

    it('should reject invalid token', async () => {
      mockVerifyToken.mockResolvedValue(false);

      const request = createMockRequest('Bearer invalid_token');
      const response = createMockResponse();

      await routes['DELETE /provision/pods/:podName'](request, response, { podName: 'alice' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /provision/pods/:podName', () => {
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
      (stat as any).mockResolvedValue({ isDirectory: () => true } as any);

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['GET /provision/pods/:podName'](request, response, { podName: 'alice' });

      expect(response.statusCode).toBe(200);
      const responseBody = JSON.parse((response.end as any).mock.calls[0][0]);
      expect(responseBody.exists).toBe(true);
      expect(responseBody.podName).toBe('alice');
      expect(responseBody.podUrl).toBe('https://node1.pods.example.com/alice/');
    });

    it('should return 404 for non-existent pod', async () => {
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockRejectedValue(new Error('Not found'));

      const request = createMockRequest('Bearer valid_token');
      const response = createMockResponse();

      await routes['GET /provision/pods/:podName'](request, response, { podName: 'nonexistent' });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /provision/webids', () => {
    const createMockRequest = (body: object, authHeader?: string): IncomingMessage =>
      ({
        headers: { authorization: authHeader },
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

    it('returns only SP-local storage facts for requested WebIDs', async () => {
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockResolvedValue({ isDirectory: () => true } as any);
      podLookupRepository.findByWebIds.mockResolvedValue([
        {
          podId: 'pod-alice',
          accountId: 'acc-1',
          baseUrl: 'http://localhost:5737/alice/',
          storageUrl: 'http://localhost:5737/alice/',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
      ]);

      const request = createMockRequest({
        webIds: [
          'https://id.undefineds.co/alice/profile/card#me',
          'https://id.undefineds.co/bob/profile/card#me',
        ],
      }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/webids'](request, response, {});

      expect(response.statusCode).toBe(200);
      expect(podLookupRepository.findByWebIds).toHaveBeenCalledWith([
        'https://id.undefineds.co/alice/profile/card#me',
        'https://id.undefineds.co/bob/profile/card#me',
      ]);
      expect(JSON.parse((response.end as any).mock.calls[0][0])).toEqual({
        entries: [
          {
            webId: 'https://id.undefineds.co/alice/profile/card#me',
            podUrl: 'http://localhost:5737/alice/',
            storageUrl: 'http://localhost:5737/alice/',
          },
        ],
      });
    });

    it('filters out Pod facts that do not belong to this SP root', async () => {
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockResolvedValue({ isDirectory: () => true } as any);
      podLookupRepository.findByWebIds.mockResolvedValue([
        {
          podId: 'pod-cloud',
          accountId: 'acc-1',
          baseUrl: 'https://id.undefineds.co/alice/',
          storageUrl: 'https://id.undefineds.co/alice/',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
        {
          podId: 'pod-old-local',
          accountId: 'acc-1',
          baseUrl: 'https://node-0000.undefineds.co/alice/',
          storageUrl: 'https://node-0000.undefineds.co/alice/',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
        {
          podId: 'pod-current-local',
          accountId: 'acc-1',
          baseUrl: 'http://localhost:5737/alice/',
          storageUrl: 'http://localhost:5737/alice/',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
      ]);

      const request = createMockRequest({
        webIds: ['https://id.undefineds.co/alice/profile/card#me'],
      }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/webids'](request, response, {});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse((response.end as any).mock.calls[0][0])).toEqual({
        entries: [
          {
            webId: 'https://id.undefineds.co/alice/profile/card#me',
            podUrl: 'http://localhost:5737/alice/',
            storageUrl: 'http://localhost:5737/alice/',
          },
        ],
      });
    });

    it('filters out stale SP-local index entries when the Pod directory is missing', async () => {
      mockVerifyToken.mockResolvedValue(true);
      (stat as any).mockRejectedValue(new Error('Not found'));
      podLookupRepository.findByWebIds.mockResolvedValue([
        {
          podId: 'pod-stale',
          accountId: 'acc-1',
          baseUrl: 'http://localhost:5737/alice/',
          storageUrl: 'http://localhost:5737/alice/',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
      ]);

      const request = createMockRequest({
        webIds: ['https://id.undefineds.co/alice/profile/card#me'],
      }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/webids'](request, response, {});

      expect(response.statusCode).toBe(200);
      expect(stat).toHaveBeenCalledWith(`${testDir}/alice`);
      expect(JSON.parse((response.end as any).mock.calls[0][0])).toEqual({ entries: [] });
    });

    it('fails closed when the SP storage root is not configured', async () => {
      routes = {};
      registerPodManagementRoutes(mockServer, {
        rootDir: testDir,
        verifyServiceToken: mockVerifyToken,
        podLookupRepository,
      });
      mockVerifyToken.mockResolvedValue(true);
      podLookupRepository.findByWebIds.mockResolvedValue([
        {
          podId: 'pod-alice',
          accountId: 'acc-1',
          baseUrl: 'http://localhost:5737/alice/',
          storageUrl: 'http://localhost:5737/alice/',
          webId: 'https://id.undefineds.co/alice/profile/card#me',
        },
      ]);

      const request = createMockRequest({
        webIds: ['https://id.undefineds.co/alice/profile/card#me'],
      }, 'Bearer valid_token');
      const response = createMockResponse();

      await routes['POST /provision/webids'](request, response, {});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse((response.end as any).mock.calls[0][0])).toEqual({ entries: [] });
    });

    it('rejects invalid service token before lookup', async () => {
      mockVerifyToken.mockResolvedValue(false);
      const request = createMockRequest({
        webIds: ['https://id.undefineds.co/alice/profile/card#me'],
      }, 'Bearer invalid_token');
      const response = createMockResponse();

      await routes['POST /provision/webids'](request, response, {});

      expect(response.statusCode).toBe(401);
      expect(podLookupRepository.findByWebIds).not.toHaveBeenCalled();
    });
  });
});
