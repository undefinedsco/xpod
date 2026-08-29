import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import type { SparqlEngine } from '../../src/storage/sparql/SubgraphQueryEngine';

interface MockAclEngine {
  queryBoolean: ReturnType<typeof vi.fn>;
  queryBindings: ReturnType<typeof vi.fn>;
}

class TestAclPermissionService extends AclPermissionService {
  public constructor(private readonly mockEngine: MockAclEngine) {
    super(mockEngine as unknown as SparqlEngine);
  }

  protected override async getEngine(): Promise<SparqlEngine> {
    return this.mockEngine as unknown as SparqlEngine;
  }
}

describe('AclPermissionService', () => {
  let service: AclPermissionService;
  let mockEngine: MockAclEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEngine = {
      queryBoolean: vi.fn(),
      queryBindings: vi.fn(),
    };
    service = new TestAclPermissionService(mockEngine);
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

    it('should check control permission from an explicit named graph source', async () => {
      mockEngine.queryBoolean.mockResolvedValue(true);

      await service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/data/'
      );

      const query = mockEngine.queryBoolean.mock.calls[0][0];
      expect(query).toMatch(/ASK\s*{[\s\S]*GRAPH\s+\?source\s*{/);
      expect(query).toMatch(/GRAPH\s+\?source\s*{[\s\S]*\?auth\s+a\s+acl:Authorization/);
      expect(query).toMatch(/GRAPH\s+\?source\s*{[\s\S]*UNION[\s\S]*acl:default/);
    });

    it('should return false on query error', async () => {
      mockEngine.queryBoolean.mockRejectedValue(new Error('Query failed'));

      const result = await service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/data/'
      );

      expect(result).toBe(false);
    });

    it('should fail closed before querying when a WebID or resource can break an IRI term', async () => {
      await expect(service.hasControlPermission(
        'https://example.com/user/alice> } UNION { SERVICE <https://attacker.example/sparql',
        'https://example.com/pod/data/',
      )).resolves.toBe(false);
      await expect(service.hasControlPermission(
        'https://example.com/user/alice',
        'https://example.com/pod/data> } UNION { ?s ?p ?o',
      )).resolves.toBe(false);

      expect(mockEngine.queryBoolean).not.toHaveBeenCalled();
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

    it('should list controlled resources from an explicit named graph source', async () => {
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {},
      };
      mockEngine.queryBindings.mockResolvedValue(mockStream);

      await service.getControlledResources(
        'https://example.com/user/alice',
        'https://example.com/pod/'
      );

      const query = mockEngine.queryBindings.mock.calls[0][0];
      expect(query).toMatch(/SELECT\s+DISTINCT\s+\?resource[\s\S]*GRAPH\s+\?source\s*{/);
      expect(query).toMatch(/GRAPH\s+\?source\s*{[\s\S]*\?auth\s+a\s+acl:Authorization/);
      expect(query).toMatch(/GRAPH\s+\?source\s*{[\s\S]*FILTER\(STRSTARTS\(STR\(\?resource\)/);
    });

    it('should return empty array on error', async () => {
      mockEngine.queryBindings.mockRejectedValue(new Error('Query failed'));

      const resources = await service.getControlledResources(
        'https://example.com/user/alice',
        'https://example.com/pod/'
      );

      expect(resources).toEqual([]);
    });

    it('should fail closed before querying when the WebID or base path is unsafe', async () => {
      await expect(service.getControlledResources(
        'https://example.com/user/alice> } UNION { ?s ?p ?o',
        'https://example.com/pod/',
      )).resolves.toEqual([]);
      await expect(service.getControlledResources(
        'https://example.com/user/alice',
        'https://example.com/pod/")) . SERVICE <https://attacker.example/sparql>',
      )).resolves.toEqual([]);

      expect(mockEngine.queryBindings).not.toHaveBeenCalled();
    });
  });
});
