import { sql } from 'drizzle-orm';
import { type IdentityDatabase, executeQuery, executeStatement } from './db';

export interface PodLookupResult {
  podId: string;
  accountId: string;
  baseUrl: string;
  nodeId?: string;
  edgeNodeId?: string;
}

export interface PodMigrationStatus {
  podId: string;
  nodeId?: string;
  migrationStatus?: 'syncing' | 'done' | null;
  migrationTargetNode?: string;
  migrationProgress?: number;
}

interface InternalKvRow {
  key?: string;
  value?: string;
  id?: string;
  account_id?: string;
  base_url?: string;
  node_id?: string;
  edge_node_id?: string;
}

/**
 * Repository for Pod lookup operations.
 *
 * Reads Pod data from CSS's internal_kv table where account data is stored.
 * CSS stores account data at key "accounts/data/{accountId}" with Pod info
 * nested in the "**pod**" field.
 */
export class PodLookupRepository {
  private readonly kvTableName: string;
  private readonly usageTableName: string;

  public constructor(
    private readonly db: IdentityDatabase,
    kvTableName?: string,
  ) {
    this.kvTableName = kvTableName ?? 'internal_kv';
    this.usageTableName = 'identity_pod_usage';
  }

  /**
   * Find Pod by resource path (matches longest baseUrl prefix).
   */
  public async findByResourceIdentifier(resourcePath: string): Promise<PodLookupResult | undefined> {
    const pods = await this.getAllPods();

    let bestMatch: PodLookupResult | undefined;
    let bestLength = 0;

    for (const pod of pods) {
      if (resourcePath.startsWith(pod.baseUrl) && pod.baseUrl.length > bestLength) {
        bestMatch = pod;
        bestLength = pod.baseUrl.length;
      }
    }

    return bestMatch;
  }

  /**
   * Get Pod by ID.
   */
  public async findById(podId: string): Promise<PodLookupResult | undefined> {
    const pods = await this.getAllPods();
    return pods.find((p) => p.podId === podId);
  }

  /**
   * Get migration status for a Pod from identity_pod_usage table.
   */
  public async getMigrationStatus(podId: string): Promise<PodMigrationStatus | undefined> {
    try {
      const tableId = sql.identifier([this.usageTableName]);
      const result = await executeQuery<{
        pod_id?: string;
        id?: string;
        node_id?: string | null;
        migration_status?: string | null;
        migration_target_node?: string | null;
        migration_progress?: number | null;
      }>(this.db, sql`
        SELECT pod_id, node_id, migration_status, migration_target_node, migration_progress
        FROM ${tableId}
        WHERE pod_id = ${podId}
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return undefined;
      }
      const row = result.rows[0];
      return {
        podId: row.pod_id ?? row.id ?? podId,
        nodeId: row.node_id ?? undefined,
        migrationStatus: row.migration_status as 'syncing' | 'done' | null | undefined,
        migrationTargetNode: row.migration_target_node ?? undefined,
        migrationProgress: row.migration_progress ?? undefined,
      };
    } catch {
      // Table might not exist.
      return undefined;
    }
  }

  /**
   * Set the nodeId for a Pod in identity_pod_usage table.
   */
  public async setNodeId(podId: string, nodeId: string): Promise<void> {
    const tableId = sql.identifier([this.usageTableName]);
    await executeStatement(this.db, sql`
      INSERT INTO ${tableId} (pod_id, account_id, node_id)
      VALUES (${podId}, '', ${nodeId})
      ON CONFLICT (pod_id) DO UPDATE SET node_id = ${nodeId}
    `);
  }

  /**
   * Update migration status for a Pod in identity_pod_usage table.
   */
  public async setMigrationStatus(
    podId: string,
    status: 'syncing' | 'done' | null,
    targetNode?: string | null,
    progress?: number | null,
  ): Promise<void> {
    const tableId = sql.identifier([this.usageTableName]);
    await executeStatement(this.db, sql`
      INSERT INTO ${tableId} (pod_id, account_id, migration_status, migration_target_node, migration_progress)
      VALUES (${podId}, '', ${status}, ${targetNode ?? null}, ${progress ?? 0})
      ON CONFLICT (pod_id) DO UPDATE SET
        migration_status = ${status},
        migration_target_node = ${targetNode ?? null},
        migration_progress = ${progress ?? 0}
    `);
  }

  /**
   * List all pods.
   */
  public async listAllPods(): Promise<PodLookupResult[]> {
    return this.getAllPods();
  }

  /**
   * Extract all pods from CSS's internal_kv storage.
   *
   * It keeps backward compatibility with legacy rows that already expose
   * id/account_id/base_url columns (used by some unit tests and older schemas).
   */
  private async getAllPods(): Promise<PodLookupResult[]> {
    const kvTableId = sql.identifier([this.kvTableName]);

    const result = await executeQuery<InternalKvRow>(this.db, sql`
      SELECT key, value FROM ${kvTableId}
      WHERE key LIKE 'accounts/data/%'
    `);

    const pods: PodLookupResult[] = [];

    for (const row of result.rows) {
      if (row.id && row.account_id && row.base_url) {
        pods.push({
          podId: String(row.id),
          accountId: String(row.account_id),
          baseUrl: String(row.base_url),
          nodeId: row.node_id ? String(row.node_id) : undefined,
          edgeNodeId: row.edge_node_id ? String(row.edge_node_id) : undefined,
        });
        continue;
      }

      if (!row.key || row.value === undefined) {
        continue;
      }

      try {
        const accountId = row.key.replace('accounts/data/', '');
        const data = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;

        const podMap = (data as any)['**pod**'] || (data as any).pod || {};

        for (const [podId, podData] of Object.entries(podMap)) {
          const pod = podData as Record<string, unknown>;
          if (pod.baseUrl && typeof pod.baseUrl === 'string') {
            pods.push({
              podId,
              accountId,
              baseUrl: pod.baseUrl,
              nodeId: typeof pod.nodeId === 'string' ? pod.nodeId : undefined,
              edgeNodeId: typeof pod.edgeNodeId === 'string' ? pod.edgeNodeId : undefined,
            });
          }
        }
      } catch {
        // Skip malformed entries.
      }
    }

    return pods;
  }
}
