import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { executeStatement, getIdentityDatabase } from '../../src/identity/drizzle/db';

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

  const execute = vi.fn().mockResolvedValue({ rows: [] });
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

function internalAccountKvRow(accountId: string, pods: Record<string, Record<string, unknown>>) {
  return {
    key: `/.internal/accounts/data/${accountId}`,
    value: JSON.stringify({ '**pod**': pods }),
  };
}

function accountKvRowWithWebIds(
  accountId: string,
  pods: Record<string, Record<string, unknown>>,
  webIds: Record<string, string>,
) {
  return {
    key: `accounts/data/${accountId}`,
    value: JSON.stringify({
      '**pod**': pods,
      '**webIdLink**': Object.fromEntries(
        Object.entries(webIds).map(([id, webId]) => [id, { id, webId, accountId }]),
      ),
    }),
  };
}

describe('PodLookupRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function createRealSqliteIdentityDb(name: string) {
    const db = getIdentityDatabase(`sqlite::memory:${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS internal_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER
      )
    `);
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS identity_store (
        container TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (container, id)
      )
    `);
    return db;
  }

  describe('findById', () => {
    it('returns pod info when found', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({ rows: [] }) // identity_store Pod miss
        .mockResolvedValueOnce({ rows: [] }) // node assignments are read before enrichment
        .mockResolvedValueOnce({
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
      execute!
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      const result = await repo.findById('non-existent');

      expect(result).toBeUndefined();
    });
  });

  describe('findByWebId', () => {
    it('reads pods from real SQLite identity_store rows', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-identity-store');
      await executeStatement(db, sql`
        INSERT INTO identity_store (container, id, payload)
        VALUES ('pod', 'pod-local', ${JSON.stringify({
          accountId: 'acc-local',
          baseUrl: 'http://localhost:58211/linxq5uue9m3xd/',
          webId: 'http://localhost:58211/linxq5uue9m3xd/profile/card#me',
        })})
      `);
      await executeStatement(db, sql`
        INSERT INTO identity_store (container, id, payload)
        VALUES ('webIdLink', 'webid-local', ${JSON.stringify({
          accountId: 'acc-local',
          webId: 'http://localhost:58211/linxq5uue9m3xd/profile/card#me',
        })})
      `);

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebId('http://localhost:58211/linxq5uue9m3xd/profile/card#me');

      expect(result).toMatchObject({
        podId: 'pod-local',
        accountId: 'acc-local',
        baseUrl: 'http://localhost:58211/linxq5uue9m3xd/',
        webId: 'http://localhost:58211/linxq5uue9m3xd/profile/card#me',
      });
    });

    it('does not infer ownership from account WebID links across origins', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({
          rows: [
            accountKvRowWithWebIds('acc-1', {
              'pod-1': {
                baseUrl: 'https://node-1.nodes.example/alice/',
                nodeId: 'node-1',
              },
            }, {
              'webid-link-1': 'https://id.example/alice/profile/card#me',
            }),
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebId('https://id.example/alice/profile/card#me');

      expect(result).toBeUndefined();
    });

    it('does not infer ownership from multiple account WebID links', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({
          rows: [
            accountKvRowWithWebIds('acc-1', {
              'pod-1': {
                baseUrl: 'https://node-1.nodes.example/alice/',
                nodeId: 'node-1',
              },
            }, {
              'webid-link-1': 'https://id.example/alice/profile/card#old',
              'webid-link-2': 'https://id.example/alice/profile/card#me',
            }),
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebId('https://id.example/alice/profile/card#me');

      expect(result).toBeUndefined();
    });

    it('prefers pod owner WebID links when present on the pod', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({
          rows: [
            accountKvRow('acc-1', {
              'pod-1': {
                baseUrl: 'https://node-1.nodes.example/alice/',
                '**owner**': {
                  'owner-1': {
                    webId: 'https://id.example/alice/profile/card#me',
                  },
                },
              },
            }),
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebId('https://id.example/alice/profile/card#me');

      expect(result?.podId).toBe('pod-1');
      expect(result?.webId).toBe('https://id.example/alice/profile/card#me');
    });

    it('keeps account WebID links scoped to their exact Pod owners', async () => {
      const { db, execute } = createMockDb();
      execute!.mockResolvedValue({
        rows: [
          accountKvRowWithWebIds('acc-1', {
            'pod-primary': {
              baseUrl: 'https://node-1.nodes.example/primary/',
              '**owner**': {
                ownerPrimary: { webId: 'https://id.example/alice/profile/card#primary' },
              },
            },
            'pod-secondary': {
              baseUrl: 'https://node-1.nodes.example/secondary/',
              '**owner**': {
                ownerSecondary: { webId: 'https://id.example/alice/profile/card#secondary' },
              },
            },
          }, {
            primary: 'https://id.example/alice/profile/card#primary',
            secondary: 'https://id.example/alice/profile/card#secondary',
          }),
        ],
      });

      const repo = new PodLookupRepository(db);

      await expect(repo.findAllByWebId('https://id.example/alice/profile/card#primary'))
        .resolves.toEqual([expect.objectContaining({
          podId: 'pod-primary',
          webId: 'https://id.example/alice/profile/card#primary',
        })]);
      await expect(repo.findAllByWebId('https://id.example/alice/profile/card#secondary'))
        .resolves.toEqual([expect.objectContaining({
          podId: 'pod-secondary',
          webId: 'https://id.example/alice/profile/card#secondary',
        })]);
    });

    it('reads account data stored under the CSS internal namespace', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({
          rows: [
            internalAccountKvRow('acc-1', {
              'pod-1': {
                baseUrl: 'https://node-1.nodes.example/alice/',
                '**owner**': {
                  'owner-1': {
                    webId: 'https://id.example/alice/profile/card#me',
                  },
                },
              },
            }),
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebId('https://id.example/alice/profile/card#me');

      expect(result).toMatchObject({
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
        webId: 'https://id.example/alice/profile/card#me',
      });
    });

    it('unwraps CSS key-value payload wrappers in account data rows', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({
          rows: [
            {
              key: 'accounts/data/acc-1',
              value: JSON.stringify({
                key: 'accounts/data/acc-1',
                payload: {
                  id: 'acc-1',
                  '**pod**': {
                    'pod-1': {
                      baseUrl: 'https://node-1.nodes.example/alice/',
                      accountId: 'acc-1',
                      '**owner**': {
                        'owner-1': {
                          webId: 'https://id.example/alice/profile/card#me',
                        },
                      },
                    },
                  },
                },
              }),
            },
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebId('https://id.example/alice/profile/card#me');

      expect(result).toMatchObject({
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
        webId: 'https://id.example/alice/profile/card#me',
      });
    });

    it('reads pods from DrizzleIndexedStorage identity_store rows', async () => {
      const { db, execute } = createMockDb();
      const podRow = {
        container: 'pod',
        id: 'pod-1',
        payload: {
          accountId: 'acc-1',
          baseUrl: 'https://node-1.nodes.example/alice/',
          nodeId: 'node-1',
        },
      };
      const ownerRow = {
        container: 'owner',
        id: 'owner-1',
        payload: {
          podId: 'pod-1',
          webId: 'https://id.example/alice/profile/card#me',
        },
      };
      execute!
        // Legacy account scan empty
        .mockResolvedValueOnce({ rows: [] })
        // Node assignments empty
        .mockResolvedValueOnce({ rows: [] })
        // owner 下推命中
        .mockResolvedValueOnce({ rows: [ownerRow] })
        // pod.webId 直查 miss
        .mockResolvedValueOnce({ rows: [] })
        // 按 podId 取回候选 pod 行
        .mockResolvedValueOnce({ rows: [podRow] })
        // Node assignments are read before the targeted owner enrichment.
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [ownerRow] });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebId('https://id.example/alice/profile/card#me');

      expect(result).toEqual({
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
        webId: 'https://id.example/alice/profile/card#me',
        nodeId: 'node-1',
        edgeNodeId: undefined,
      });
    });

    it('does not use an orphaned account index to establish Pod ownership', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-orphan-index');
      const webId = 'https://id.example/alice/profile/card#me';
      await executeStatement(db, sql`
        INSERT INTO internal_kv (key, value)
        VALUES (${`accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`}, ${JSON.stringify(['acc-1'])})
      `);
      await expect(new PodLookupRepository(db).findByWebId(webId)).resolves.toBeUndefined();
    });
  });

  describe('findByResourceIdentifier', () => {
    it('returns pod matching resource path', async () => {
      const { db, execute } = createMockDb();
      execute!.mockResolvedValueOnce({
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

    it('matches canonical storage from pod settings instead of usage rows', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({
          rows: [
            accountKvRow('acc-1', {
              'pod-abc': {
                baseUrl: 'https://cloud.example.com/alice/',
                storage: 'https://node-1.nodes.example/alice/',
              },
            }),
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'node-1',
              pod_base_urls: JSON.stringify(['https://node-1.nodes.example/alice/']),
            },
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByResourceIdentifier('https://node-1.nodes.example/alice/profile/card');

      expect(result).toEqual({
        podId: 'pod-abc',
        accountId: 'acc-1',
        baseUrl: 'https://cloud.example.com/alice/',
        storageUrl: 'https://node-1.nodes.example/alice/',
        nodeId: 'node-1',
        edgeNodeId: undefined,
      });
    });
  });

  describe('listAllPods', () => {
    it('reads pods from real SQLite internal_kv account rows', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-internal-kv');
      await executeStatement(db, sql`
        INSERT INTO internal_kv (key, value)
        VALUES ('accounts/data/acc-local', ${JSON.stringify({
          '**pod**': {
            'pod-local': {
              baseUrl: 'http://localhost:58211/linxq5uue9m3xd/',
              '**owner**': {
                'owner-local': {
                  webId: 'http://localhost:58211/linxq5uue9m3xd/profile/card#me',
                },
              },
            },
          },
        })})
      `);

      const repo = new PodLookupRepository(db);
      const result = await repo.listAllPods();

      expect(result).toEqual([
        {
          podId: 'pod-local',
          accountId: 'acc-local',
          baseUrl: 'http://localhost:58211/linxq5uue9m3xd/',
          webId: 'http://localhost:58211/linxq5uue9m3xd/profile/card#me',
          storageUrl: undefined,
          nodeId: undefined,
          edgeNodeId: undefined,
        },
      ]);
    });

    it('returns all pods', async () => {
      const { db, execute } = createMockDb();
      execute!.mockResolvedValueOnce({
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
      execute!
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const repo = new PodLookupRepository(db);
      const result = await repo.listAllPods();

      expect(result).toEqual([]);
    });

    it('returns pods from identity_store when internal_kv has no account rows', async () => {
      const { db, execute } = createMockDb();
      execute!
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              container: 'pod',
              id: 'pod-1',
              payload: JSON.stringify({
                accountId: 'acc-1',
                baseUrl: 'https://node-1.nodes.example/alice/',
              }),
            },
            {
              container: 'webIdLink',
              id: 'webid-link-1',
              payload: JSON.stringify({
                accountId: 'acc-1',
                webId: 'https://id.example/alice/profile/card#me',
              }),
            },
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.listAllPods();

      expect(result).toEqual([
        {
          podId: 'pod-1',
          accountId: 'acc-1',
          baseUrl: 'https://node-1.nodes.example/alice/',
          webId: undefined,
          nodeId: undefined,
          edgeNodeId: undefined,
        },
      ]);
    });
  });

  describe('listByAccountId', () => {
    it('returns only pods belonging to the requested account', async () => {
      const { db, execute } = createMockDb();
      execute!
        // nodeAssignments
        .mockResolvedValueOnce({ rows: [] })
        // targeted canonical query misses
        .mockResolvedValueOnce({ rows: [] })
        // independent legacy account discovery (including .json keys)
        .mockResolvedValueOnce({
          rows: [
            accountKvRow('acc-1', {
              'pod-1': { baseUrl: 'https://example.com/alice/', nodeId: 'node-1' },
              'pod-2': { baseUrl: 'https://example.com/alice-2/', nodeId: 'node-2' },
            }),
            accountKvRow('acc-2', {
              'pod-3': { baseUrl: 'https://example.com/bob/', nodeId: 'node-3' },
            }),
          ],
        });

      const repo = new PodLookupRepository(db);
      const result = await repo.listByAccountId('acc-1');

      expect(result).toHaveLength(2);
      expect(result.every((pod) => pod.accountId === 'acc-1')).toBe(true);
      expect(result.map((pod) => pod.podId)).toEqual(['pod-1', 'pod-2']);
    });
  });

  describe('fast paths with real SQLite identity_store', () => {
    async function insertIdentityStoreRow(
      db: ReturnType<typeof getIdentityDatabase>,
      container: string,
      id: string,
      payload: Record<string, unknown>,
    ) {
      await executeStatement(db, sql`
        INSERT INTO identity_store (container, id, payload)
        VALUES (${container}, ${id}, ${JSON.stringify(payload)})
      `);
    }

    it('findById reads the pod row directly and enriches owner/webIdLink links', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-fast-find-by-id');
      await insertIdentityStoreRow(db, 'pod', 'pod-1', {
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
      });
      await insertIdentityStoreRow(db, 'owner', 'owner-1', {
        podId: 'pod-1',
        webId: 'https://id.example/alice/profile/card#me',
      });
      await insertIdentityStoreRow(db, 'webIdLink', 'link-1', {
        accountId: 'acc-1',
        webId: 'https://id.example/alice/profile/card#secondary',
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.findById('pod-1');

      expect(result).toEqual({
        podId: 'pod-1',
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
        storageUrl: undefined,
        webId: 'https://id.example/alice/profile/card#me',
        nodeId: undefined,
        edgeNodeId: undefined,
      });
    });

    it('findById falls back to kv account rows when identity_store misses', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-fast-find-by-id-kv');
      await executeStatement(db, sql`
        INSERT INTO internal_kv (key, value)
        VALUES ('accounts/data/acc-kv', ${JSON.stringify({
          '**pod**': {
            'pod-kv': {
              baseUrl: 'https://legacy.example/alice/',
              nodeId: 'node-legacy',
            },
          },
        })})
      `);

      const repo = new PodLookupRepository(db);
      const result = await repo.findById('pod-kv');

      expect(result).toMatchObject({
        podId: 'pod-kv',
        accountId: 'acc-kv',
        baseUrl: 'https://legacy.example/alice/',
        nodeId: 'node-legacy',
      });
    });

    it('listByAccountId pushes down the accountId filter and merges kv with identity_store', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-fast-by-account');
      await insertIdentityStoreRow(db, 'pod', 'pod-a', {
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
      });
      await insertIdentityStoreRow(db, 'pod', 'pod-b', {
        accountId: 'acc-2',
        baseUrl: 'https://node-1.nodes.example/bob/',
      });
      await executeStatement(db, sql`
        INSERT INTO internal_kv (key, value)
        VALUES ('accounts/data/acc-1', ${JSON.stringify({
          '**pod**': {
            'pod-c': { baseUrl: 'https://legacy.example/alice/' },
          },
        })})
      `);

      const repo = new PodLookupRepository(db);
      const result = await repo.listByAccountId('acc-1');

      expect(result.map((pod) => pod.podId)).toEqual(['pod-c', 'pod-a']);
    });

    it('findAllByWebId returns every pod sharing a WebID across accounts', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-fast-shared-webid');
      const webId = 'https://id.example/alice/profile/card#me';
      await insertIdentityStoreRow(db, 'pod', 'pod-cloud', {
        accountId: 'acc-cloud',
        baseUrl: 'https://cloud.example/alice/', webId,
      });
      await insertIdentityStoreRow(db, 'pod', 'pod-local', {
        accountId: 'acc-local',
        baseUrl: 'http://localhost:3000/alice/', webId,
      });
      await insertIdentityStoreRow(db, 'webIdLink', 'link-cloud', {
        accountId: 'acc-cloud',
        webId,
      });
      await insertIdentityStoreRow(db, 'webIdLink', 'link-local', {
        accountId: 'acc-local',
        webId,
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.findAllByWebId(webId);

      expect(result).toHaveLength(2);
      expect(result.map((pod) => pod.podId).sort()).toEqual(['pod-cloud', 'pod-local']);
      expect(result.every((pod) => pod.webId === webId)).toBe(true);
    });

    it('findByWebIds resolves multiple targets and misses unknown ones', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-fast-webids');
      await insertIdentityStoreRow(db, 'pod', 'pod-a', {
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
        webId: 'https://id.example/alice/profile/card#me',
      });
      await insertIdentityStoreRow(db, 'pod', 'pod-b', {
        accountId: 'acc-2',
        baseUrl: 'https://node-1.nodes.example/bob/',
        webId: 'https://id.example/bob/profile/card#me',
      });
      await insertIdentityStoreRow(db, 'webIdLink', 'link-a', {
        accountId: 'acc-1',
        webId: 'https://id.example/alice/profile/card#me',
      });
      await insertIdentityStoreRow(db, 'webIdLink', 'link-b', {
        accountId: 'acc-2',
        webId: 'https://id.example/bob/profile/card#me',
      });

      const repo = new PodLookupRepository(db);
      const result = await repo.findByWebIds([
        'https://id.example/alice/profile/card#me',
        'https://id.example/bob/profile/card#me',
        'https://id.example/unknown/profile/card#me',
      ]);

      expect(result).toHaveLength(2);
      const byPodId = new Map(result.map((pod) => [pod.podId, pod]));
      expect(byPodId.get('pod-a')?.webId).toBe('https://id.example/alice/profile/card#me');
      expect(byPodId.get('pod-b')?.webId).toBe('https://id.example/bob/profile/card#me');
    });

    it('findByResourceIdentifier prefilters identity_store pods by URL prefix', async () => {
      const db = await createRealSqliteIdentityDb('pod-lookup-fast-resource');
      await insertIdentityStoreRow(db, 'pod', 'pod-alice', {
        accountId: 'acc-1',
        baseUrl: 'https://node-1.nodes.example/alice/',
      });
      await insertIdentityStoreRow(db, 'pod', 'pod-bob', {
        accountId: 'acc-2',
        baseUrl: 'https://node-1.nodes.example/bob/',
        storageUrl: 'https://storage-2.nodes.example/bob/',
      });

      const repo = new PodLookupRepository(db);
      const alice = await repo.findByResourceIdentifier('https://node-1.nodes.example/alice/profile/card');
      const bob = await repo.findByResourceIdentifier('https://storage-2.nodes.example/bob/profile/card');

      expect(alice?.podId).toBe('pod-alice');
      expect(bob?.podId).toBe('pod-bob');
    });
  });

});
