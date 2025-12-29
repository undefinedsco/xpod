import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SubgraphQueryEngine and QuadstoreSparqlEngine
vi.mock('../../src/storage/sparql/SubgraphQueryEngine', () => ({
  SubgraphQueryEngine: vi.fn().mockImplementation(() => ({
    queryBoolean: vi.fn(),
    queryBindings: vi.fn(),
  })),
  QuadstoreSparqlEngine: vi.fn().mockImplementation(() => ({})),
}));

// Mock the logger
vi.mock('global-logger-factory', () => ({
  getLoggerFor: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { AclPermissionService } from '../../src/terminal/AclPermissionService';
import { SubgraphQueryEngine } from '../../src/storage/sparql/SubgraphQueryEngine';

describe('AclPermissionService', () => {
  let service: AclPermissionService;
  let mockEngine: { queryBoolean: ReturnType<typeof vi.fn>; queryBindings: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEngine = {
      queryBoolean: vi.fn(),
      queryBindings: vi.fn(),
    };
    (SubgraphQueryEngine as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockEngine);
    service = new AclPermissionService('sqlite:/test.db');
  });

  describe('hasControlPermission', () => {
    it('should return true when user has Control permission', async () => {
      mockEngine.queryBoolean.mockResolvedValue(true);

      const result = await service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/data/'
      );

      expect(result).toBe(true);
      expect(mockEngine.queryBoolean).toHaveBeenCalledTimes(1);
    });

    it('should return false when user lacks Control permission', async () => {
      mockEngine.queryBoolean.mockResolvedValue(false);

      const result = await service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/secret/'
      );

      expect(result).toBe(false);
    });

    it('should include both resource and container URLs in query', async () => {
      mockEngine.queryBoolean.mockResolvedValue(true);

      await service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/data'
      );

      const query = mockEngine.queryBoolean.mock.calls[0][0];
      // Should check both with and without trailing slash
      expect(query).toContain('https://example.com/pod/data');
      expect(query).toContain('https://example.com/pod/data/');
    });

    it('should check acl:agent, foaf:Agent, and AuthenticatedAgent', async () => {
      mockEngine.queryBoolean.mockResolvedValue(true);

      await service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/data/'
      );

      const query = mockEngine.queryBoolean.mock.calls[0][0];
      expect(query).toContain('acl:agent');
      expect(query).toContain('foaf:Agent');
      expect(query).toContain('acl:AuthenticatedAgent');
    });

    it('should return false on query error', async () => {
      mockEngine.queryBoolean.mockRejectedValue(new Error('Query failed'));

      const result = await service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/data/'
      );

      expect(result).toBe(false);
    });
  });

  describe('getControlledResources', () => {
    it('should return list of resources with Control permission', async () => {
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { get: () => ({ value: 'https://example.com/pod/data/' }) };
          yield { get: () => ({ value: 'https://example.com/pod/docs/' }) };
        },
      };
      mockEngine.queryBindings.mockResolvedValue(mockStream);

      const resources = await service.getControlledResources(
        'https://example.com/user/alice',
        'https://example.com/pod/'
      );

      expect(resources).toHaveLength(2);
      expect(resources).toContain('https://example.com/pod/data/');
      expect(resources).toContain('https://example.com/pod/docs/');
    });

    it('should return empty array on error', async () => {
      mockEngine.queryBindings.mockRejectedValue(new Error('Query failed'));

      const resources = await service.getControlledResources(
        'https://example.com/user/alice',
        'https://example.com/pod/'
      );

      expect(resources).toEqual([]);
    });
  });
});
