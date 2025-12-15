import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';

function createMockDb(isSqlite = false) {
  if (isSqlite) {
    // SQLite: has `all` and `run`, but NOT `execute`
    const all = vi.fn();
    const run = vi.fn();
    return {
      db: { all, run } as any,
      execute: undefined,
      all,
      run,
    };
  }
  // PostgreSQL: has `execute`
  const execute = vi.fn();
  return {
    db: { execute } as any,
    execute,
    all: undefined,
    run: undefined,
  };
}

describe('PodLookupRepository', () => {
  describe('findById', () => {
    it('returns pod info when found', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({
        rows: [{
          id: 'pod-123',
          account_id: 'account-456',
          base_url: 'https://example.com/alice/',
          node_id: 'center-node-1',
          edge_node_id: null,
        }],
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.findById('pod-123');

      expect(result).toEqual({
        podId: 'pod-123',
        accountId: 'account-456',
        baseUrl: 'https://example.com/alice/',
        nodeId: 'center-node-1',
        edgeNodeId: undefined,
      });
    });

    it('returns undefined when not found', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      const result = await repo.findById('non-existent');

      expect(result).toBeUndefined();
    });
  });

  describe('findByResourceIdentifier', () => {
    it('returns pod matching resource path', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({
        rows: [{
          id: 'pod-abc',
          account_id: 'acc-1',
          base_url: 'https://example.com/alice/',
          node_id: 'node-1',
          edge_node_id: 'edge-1',
        }],
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByResourceIdentifier('https://example.com/alice/profile/card');

      expect(result).toEqual({
        podId: 'pod-abc',
        accountId: 'acc-1',
        baseUrl: 'https://example.com/alice/',
        nodeId: 'node-1',
        edgeNodeId: 'edge-1',
      });
    });
  });

  describe('listAllPods', () => {
    it('returns all pods', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({
        rows: [
          { id: 'pod-1', account_id: 'acc-1', base_url: 'https://example.com/alice/', node_id: 'node-1', edge_node_id: null },
          { id: 'pod-2', account_id: 'acc-2', base_url: 'https://example.com/bob/', node_id: 'node-2', edge_node_id: null },
        ],
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.listAllPods();

      expect(result).toHaveLength(2);
      expect(result[0].podId).toBe('pod-1');
      expect(result[1].podId).toBe('pod-2');
    });

    it('returns empty array when no pods', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      const result = await repo.listAllPods();

      expect(result).toEqual([]);
    });
  });

  describe('getMigrationStatus', () => {
    it('returns migration status when set', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({
        rows: [{
          id: 'pod-123',
          node_id: 'node-1',
          migration_status: 'syncing',
          migration_target_node: 'node-2',
          migration_progress: 50,
        }],
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.getMigrationStatus('pod-123');

      expect(result).toEqual({
        podId: 'pod-123',
        nodeId: 'node-1',
        migrationStatus: 'syncing',
        migrationTargetNode: 'node-2',
        migrationProgress: 50,
      });
    });

    it('returns undefined when pod not found', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      const result = await repo.getMigrationStatus('non-existent');

      expect(result).toBeUndefined();
    });

    it('returns status with null migration when not migrating', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({
        rows: [{
          id: 'pod-123',
          node_id: 'node-1',
          migration_status: null,
          migration_target_node: null,
          migration_progress: null,
        }],
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.getMigrationStatus('pod-123');

      expect(result).toEqual({
        podId: 'pod-123',
        nodeId: 'node-1',
        migrationStatus: null,
        migrationTargetNode: undefined,
        migrationProgress: undefined,
      });
    });
  });

  describe('setNodeId', () => {
    it('updates nodeId for PostgreSQL', async () => {
      const { db, execute } = createMockDb(false);
      execute!.mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      await repo.setNodeId('pod-123', 'new-node-id');

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('updates nodeId for SQLite', async () => {
      const { db, run } = createMockDb(true);
      
      const repo = new PodLookupRepository(db);
      await repo.setNodeId('pod-123', 'new-node-id');

      expect(run!).toHaveBeenCalledTimes(1);
    });
  });

  describe('setMigrationStatus', () => {
    it('updates migration status for PostgreSQL', async () => {
      const { db, execute } = createMockDb(false);
      execute!.mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      await repo.setMigrationStatus('pod-123', 'syncing', 'target-node', 25);

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('clears migration status when null', async () => {
      const { db, execute } = createMockDb(false);
      execute!.mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      await repo.setMigrationStatus('pod-123', null, null, null);

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
