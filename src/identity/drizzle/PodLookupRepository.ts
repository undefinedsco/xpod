import { sql } from 'drizzle-orm';
import { type IdentityDatabase, executeQuery, executeStatement, isDatabaseSqlite } from './db';

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

interface PodRow {
  id: string;
  account_id: string;
  base_url: string;
  node_id?: string | null;
  edge_node_id?: string | null;
}

interface MigrationRow {
  id: string;
  node_id?: string | null;
  migration_status?: string | null;
  migration_target_node?: string | null;
  migration_progress?: number | null;
}

/**
 * Repository for Pod lookup and migration operations.
 * 
 * Note: Uses ->> JSON operator which works on both PostgreSQL and SQLite 3.38+.
 * Write operations (setNodeId, setMigrationStatus) use database-specific syntax
 * since json_set (SQLite) and jsonb_set (PostgreSQL) differ.
 */
export class PodLookupRepository {
  public constructor(private readonly db: IdentityDatabase) {}

  public async findByResourceIdentifier(resourcePath: string): Promise<PodLookupResult | undefined> {
    // ->> works on both PostgreSQL (jsonb) and SQLite 3.38+ (json)
    const result = await executeQuery<PodRow>(this.db, sql`
      SELECT 
        id, 
        payload ->> 'accountId' AS account_id, 
        payload ->> 'baseUrl' AS base_url, 
        payload ->> 'nodeId' AS node_id, 
        payload ->> 'edgeNodeId' AS edge_node_id
      FROM identity_pod
      WHERE payload ->> 'baseUrl' IS NOT NULL
        AND ${resourcePath} LIKE (payload ->> 'baseUrl') || '%'
      ORDER BY length(payload ->> 'baseUrl') DESC
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      podId: row.id,
      accountId: row.account_id,
      baseUrl: row.base_url,
      nodeId: row.node_id ?? undefined,
      edgeNodeId: row.edge_node_id ?? undefined,
    };
  }

  /**
   * Get Pod by ID with node information.
   */
  public async findById(podId: string): Promise<PodLookupResult | undefined> {
    const result = await executeQuery<PodRow>(this.db, sql`
      SELECT 
        id, 
        payload ->> 'accountId' AS account_id, 
        payload ->> 'baseUrl' AS base_url, 
        payload ->> 'nodeId' AS node_id, 
        payload ->> 'edgeNodeId' AS edge_node_id
      FROM identity_pod
      WHERE id = ${podId}
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      podId: row.id,
      accountId: row.account_id,
      baseUrl: row.base_url,
      nodeId: row.node_id ?? undefined,
      edgeNodeId: row.edge_node_id ?? undefined,
    };
  }

  /**
   * Set the nodeId for a Pod.
   */
  public async setNodeId(podId: string, nodeId: string): Promise<void> {
    if (isDatabaseSqlite(this.db)) {
      await executeStatement(this.db, sql`
        UPDATE identity_pod
        SET payload = json_set(COALESCE(payload, '{}'), '$.nodeId', ${nodeId})
        WHERE id = ${podId}
      `);
    } else {
      await executeStatement(this.db, sql`
        UPDATE identity_pod
        SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{nodeId}', to_jsonb(${nodeId}::text))
        WHERE id = ${podId}
      `);
    }
  }

  /**
   * Get migration status for a Pod.
   */
  public async getMigrationStatus(podId: string): Promise<PodMigrationStatus | undefined> {
    const result = await executeQuery<MigrationRow>(this.db, sql`
      SELECT 
        id, 
        payload ->> 'nodeId' AS node_id, 
        payload ->> 'migrationStatus' AS migration_status,
        payload ->> 'migrationTargetNode' AS migration_target_node, 
        CAST(payload ->> 'migrationProgress' AS INTEGER) AS migration_progress
      FROM identity_pod
      WHERE id = ${podId}
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return undefined;
    }
    const row = result.rows[0];
    return {
      podId: row.id,
      nodeId: row.node_id ?? undefined,
      migrationStatus: row.migration_status as 'syncing' | 'done' | null | undefined,
      migrationTargetNode: row.migration_target_node ?? undefined,
      migrationProgress: row.migration_progress ?? undefined,
    };
  }

  /**
   * Update migration status for a Pod.
   */
  public async setMigrationStatus(
    podId: string,
    status: 'syncing' | 'done' | null,
    targetNode?: string | null,
    progress?: number | null,
  ): Promise<void> {
    if (isDatabaseSqlite(this.db)) {
      await executeStatement(this.db, sql`
        UPDATE identity_pod
        SET payload = json_set(
          json_set(
            json_set(COALESCE(payload, '{}'), '$.migrationStatus', ${status}),
            '$.migrationTargetNode', ${targetNode ?? null}
          ),
          '$.migrationProgress', ${progress ?? 0}
        )
        WHERE id = ${podId}
      `);
    } else {
      await executeStatement(this.db, sql`
        UPDATE identity_pod
        SET payload = jsonb_set(
          jsonb_set(
            jsonb_set(COALESCE(payload, '{}'::jsonb), '{migrationStatus}', to_jsonb(${status}::text)),
            '{migrationTargetNode}', to_jsonb(${targetNode ?? null}::text)
          ),
          '{migrationProgress}', to_jsonb(${progress ?? 0})
        )
        WHERE id = ${podId}
      `);
    }
  }

  /**
   * List all pods with their node assignments.
   */
  public async listAllPods(): Promise<PodLookupResult[]> {
    const result = await executeQuery<PodRow>(this.db, sql`
      SELECT 
        id, 
        payload ->> 'accountId' AS account_id, 
        payload ->> 'baseUrl' AS base_url, 
        payload ->> 'nodeId' AS node_id, 
        payload ->> 'edgeNodeId' AS edge_node_id
      FROM identity_pod
      WHERE payload ->> 'baseUrl' IS NOT NULL
      ORDER BY payload ->> 'baseUrl' ASC
    `);

    return result.rows.map(row => ({
      podId: row.id,
      accountId: row.account_id,
      baseUrl: row.base_url,
      nodeId: row.node_id ?? undefined,
      edgeNodeId: row.edge_node_id ?? undefined,
    }));
  }
}
