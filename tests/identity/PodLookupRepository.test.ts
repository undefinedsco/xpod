import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';

function createMockDb(isSqlite = false) {
  if (isSqlite) {
    const all = vi.fn();
    const run = vi.fn();
    return {
      db: { all, run } as any,
      execute: undefined,
      all,
      run,
    };
  }

  const execute = vi.fn();
  return {
    db: { execute } as any,
    execute,
    all: undefined,
    run: undefined,
  };
}

function accountKvRow(accountId: string, pods: Record<string, Record<string, unknown>>) {
  return {
    key: `accounts/data/${accountId}`,
    value: JSON.stringify({ '**pod**': pods }),
  };
}

describe('PodLookupRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findById', () => {
    it('returns pod info when found', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({
        rows: [
          accountKvRow('account-456', {
            'pod-123': {
              baseUrl: 'https://example.com/alice/',
              nodeId: 'center-node-1',
            },
          }),
        ],
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
        rows: [
          accountKvRow('acc-1', {
            'pod-abc': {
              baseUrl: 'https://example.com/alice/',
              nodeId: 'node-1',
              edgeNodeId: 'edge-1',
            },
          }),
        ],
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
          accountKvRow('acc-1', {
            'pod-1': { baseUrl: 'https://example.com/alice/', nodeId: 'node-1' },
          }),
          accountKvRow('acc-2', {
            'pod-2': { baseUrl: 'https://example.com/bob/', nodeId: 'node-2' },
          }),
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
        rows: [
          {
            pod_id: 'pod-123',
            node_id: 'node-1',
            migration_status: 'syncing',
            migration_target_node: 'node-2',
            migration_progress: 50,
          },
        ],
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

    it('returns pod-only status when pod not found', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      const result = await repo.getMigrationStatus('non-existent');

      expect(result).toEqual({ podId: 'non-existent' });
    });

    it('returns status with null migration when not migrating', async () => {
      const { db, execute } = createMockDb();
      execute.mockResolvedValueOnce({
        rows: [
          {
            pod_id: 'pod-123',
            node_id: 'node-1',
            migration_status: null,
            migration_target_node: null,
            migration_progress: null,
          },
        ],
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
      const { db, all } = createMockDb(true);
      all!.mockReturnValueOnce([]);

      const repo = new PodLookupRepository(db);
      await repo.setNodeId('pod-123', 'new-node-id');

      expect(all!).toHaveBeenCalledTimes(1);
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
