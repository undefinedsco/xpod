import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Mock database module
vi.mock('../../src/identity/drizzle/db', () => ({
  getIdentityDatabase: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  })),
}));

// Mock repositories
const mockPodLookupRepo = {
  findById: vi.fn(),
  listAllPods: vi.fn(),
  setNodeId: vi.fn(),
};

const mockEdgeNodeRepo = {
  getCenterNode: vi.fn(),
};

vi.mock('../../src/identity/drizzle/PodLookupRepository', () => ({
  PodLookupRepository: vi.fn().mockImplementation(() => mockPodLookupRepo),
}));

vi.mock('../../src/identity/drizzle/EdgeNodeRepository', () => ({
  EdgeNodeRepository: vi.fn().mockImplementation(() => mockEdgeNodeRepo),
}));

import { PodMigrationHttpHandler } from '../../src/http/cluster/PodMigrationHttpHandler';

function createMockRequest(method: string, url: string, body?: object): IncomingMessage {
  const readable = new Readable();
  if (body) {
    readable.push(JSON.stringify(body));
  }
  readable.push(null);

  return Object.assign(readable, {
    method,
    url,
    headers: { host: 'localhost' },
  }) as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse & { getBody: () => string } {
  let body = '';
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { body = data ?? ''; }),
    getBody: () => body,
  };
  return res as any;
}

describe('PodMigrationHttpHandler', () => {
  let handler: PodMigrationHttpHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PodMigrationHttpHandler({
      identityDbUrl: 'sqlite::memory:',
      currentNodeId: 'node-1',
    });
  });

  describe('canHandle', () => {
    it('accepts /.cluster/pods path', async () => {
      const request = createMockRequest('GET', '/.cluster/pods');
      
      await expect(handler.canHandle({ request } as any)).resolves.toBeUndefined();
    });

    it('accepts /.cluster/pods/{id} path', async () => {
      const request = createMockRequest('GET', '/.cluster/pods/pod-123');
      
      await expect(handler.canHandle({ request } as any)).resolves.toBeUndefined();
    });

    it('rejects non-matching path', async () => {
      const request = createMockRequest('GET', '/some/other/path');
      
      await expect(handler.canHandle({ request } as any)).rejects.toThrow();
    });

    it('rejects when disabled', async () => {
      const disabledHandler = new PodMigrationHttpHandler({
        identityDbUrl: 'sqlite::memory:',
        currentNodeId: 'node-1',
        enabled: false,
      });
      const request = createMockRequest('GET', '/.cluster/pods');
      
      await expect(disabledHandler.canHandle({ request } as any)).rejects.toThrow('disabled');
    });
  });

  describe('GET /.cluster/pods', () => {
    it('returns list of pods', async () => {
      mockPodLookupRepo.listAllPods.mockResolvedValueOnce([
        { podId: 'pod-1', baseUrl: 'https://example.com/alice/', accountId: 'acc-1', nodeId: 'node-1' },
        { podId: 'pod-2', baseUrl: 'https://example.com/bob/', accountId: 'acc-2', nodeId: 'node-2' },
      ]);

      const request = createMockRequest('GET', '/.cluster/pods');
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.getBody());
      expect(body.pods).toHaveLength(2);
      expect(body.pods[0].podId).toBe('pod-1');
    });

    it('returns empty array when no pods', async () => {
      mockPodLookupRepo.listAllPods.mockResolvedValueOnce([]);

      const request = createMockRequest('GET', '/.cluster/pods');
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.getBody());
      expect(body.pods).toEqual([]);
    });
  });

  describe('GET /.cluster/pods/{podId}', () => {
    it('returns pod info', async () => {
      mockPodLookupRepo.findById.mockResolvedValueOnce({
        podId: 'pod-123',
        baseUrl: 'https://example.com/alice/',
        accountId: 'acc-1',
        nodeId: 'node-1',
      });

      const request = createMockRequest('GET', '/.cluster/pods/pod-123');
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.getBody());
      expect(body.podId).toBe('pod-123');
      expect(body.nodeId).toBe('node-1');
    });

    it('returns 404 for unknown pod', async () => {
      mockPodLookupRepo.findById.mockResolvedValueOnce(undefined);

      const request = createMockRequest('GET', '/.cluster/pods/unknown');
      const response = createMockResponse();

      await expect(handler.handle({ request, response } as any)).rejects.toThrow('not found');
    });
  });

  describe('POST /.cluster/pods/{podId}/migrate', () => {
    it('migrates pod instantly', async () => {
      mockPodLookupRepo.findById.mockResolvedValue({
        podId: 'pod-123',
        baseUrl: 'https://example.com/alice/',
        accountId: 'acc-1',
        nodeId: 'node-1',
      });
      mockEdgeNodeRepo.getCenterNode.mockResolvedValueOnce({
        nodeId: 'node-2',
        internalIp: '10.0.0.2',
        internalPort: 3000,
      });
      mockPodLookupRepo.setNodeId.mockResolvedValueOnce(undefined);

      const request = createMockRequest('POST', '/.cluster/pods/pod-123/migrate', {
        targetNode: 'node-2',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.getBody());
      expect(body.message).toBe('Migration completed');
      expect(body.sourceNode).toBe('node-1');
      expect(body.targetNode).toBe('node-2');
      expect(body.migratedAt).toBeDefined();
      expect(mockPodLookupRepo.setNodeId).toHaveBeenCalledWith('pod-123', 'node-2');
    });

    it('rejects missing targetNode', async () => {
      const request = createMockRequest('POST', '/.cluster/pods/pod-123/migrate', {});
      const response = createMockResponse();

      await expect(handler.handle({ request, response } as any)).rejects.toThrow('targetNode');
    });

    it('rejects unknown pod', async () => {
      mockPodLookupRepo.findById.mockResolvedValueOnce(undefined);

      const request = createMockRequest('POST', '/.cluster/pods/pod-123/migrate', {
        targetNode: 'node-2',
      });
      const response = createMockResponse();

      await expect(handler.handle({ request, response } as any)).rejects.toThrow('not found');
    });

    it('rejects unknown target node', async () => {
      mockPodLookupRepo.findById.mockResolvedValueOnce({
        podId: 'pod-123',
        baseUrl: 'https://example.com/alice/',
        accountId: 'acc-1',
        nodeId: 'node-1',
      });
      mockEdgeNodeRepo.getCenterNode.mockResolvedValueOnce(undefined);

      const request = createMockRequest('POST', '/.cluster/pods/pod-123/migrate', {
        targetNode: 'unknown-node',
      });
      const response = createMockResponse();

      await expect(handler.handle({ request, response } as any)).rejects.toThrow('not found');
    });

    it('rejects if already on target node', async () => {
      mockPodLookupRepo.findById.mockResolvedValueOnce({
        podId: 'pod-123',
        baseUrl: 'https://example.com/alice/',
        accountId: 'acc-1',
        nodeId: 'node-2',
      });
      mockEdgeNodeRepo.getCenterNode.mockResolvedValueOnce({
        nodeId: 'node-2',
        internalIp: '10.0.0.2',
        internalPort: 3000,
      });

      const request = createMockRequest('POST', '/.cluster/pods/pod-123/migrate', {
        targetNode: 'node-2',
      });
      const response = createMockResponse();

      await expect(handler.handle({ request, response } as any)).rejects.toThrow('already on node');
    });
  });

  describe('unsupported endpoints', () => {
    it('rejects GET /migration (no longer supported)', async () => {
      const request = createMockRequest('GET', '/.cluster/pods/pod-123/migration');
      const response = createMockResponse();

      await expect(handler.handle({ request, response } as any)).rejects.toThrow('not implemented');
    });

    it('rejects DELETE /migration (no longer supported)', async () => {
      const request = createMockRequest('DELETE', '/.cluster/pods/pod-123/migration');
      const response = createMockResponse();

      await expect(handler.handle({ request, response } as any)).rejects.toThrow('not implemented');
    });
  });
});
