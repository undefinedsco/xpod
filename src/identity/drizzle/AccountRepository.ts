import { sql } from 'drizzle-orm';
import { type IdentityDatabase, executeQuery, isDatabaseSqlite } from './db';

export interface PodQuotaContext {
  accountId: string;
  podId: string;
  baseUrl?: string;
  podQuota?: number;
  accountQuota?: number;
}

interface InternalKvRow {
  key: string;
  value: string;
}

/**
 * Repository for account and pod quota operations.
 *
 * Reads account/pod data from CSS's internal_kv table.
 * Quota limits are stored in identity_account_usage / identity_pod_usage tables.
 */
export class AccountRepository {
  private readonly kvTableName: string;
  private readonly accountUsageTable: string;
  private readonly podUsageTable: string;

  public constructor(
    private readonly db: IdentityDatabase,
    kvTableName?: string,
  ) {
    this.kvTableName = kvTableName ?? 'internal_kv';
    this.accountUsageTable = 'identity_account_usage';
    this.podUsageTable = 'identity_pod_usage';
  }

  public async getAccountQuota(accountId: string): Promise<number | undefined> {
    try {
      const tableId = sql.identifier([this.accountUsageTable]);
      const result = await executeQuery<{ storage_limit_bytes: number | null }>(
        this.db,
        sql`SELECT storage_limit_bytes FROM ${tableId} WHERE account_id = ${accountId} LIMIT 1`,
      );
      if (result.rows.length === 0) {
        return undefined;
      }
      const limit = result.rows[0].storage_limit_bytes;
      return limit != null ? limit : undefined;
    } catch {
      // Table might not exist
      return undefined;
    }
  }

  public async getPodInfo(podId: string): Promise<{ accountId: string; podQuota?: number; baseUrl?: string } | undefined> {
    // Get pod info from CSS's internal_kv
    const kvTableId = sql.identifier([this.kvTableName]);
    const result = await executeQuery<InternalKvRow>(this.db, sql`
      SELECT key, value FROM ${kvTableId}
      WHERE key LIKE 'accounts/data/%'
    `);

    for (const row of result.rows) {
      try {
        const accountId = row.key.replace('accounts/data/', '');
        const data = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        const podMap = data['**pod**'] || data.pod || {};

        if (podMap[podId]) {
          const pod = podMap[podId] as Record<string, unknown>;
          const podQuota = await this.getPodQuota(podId);
          return {
            accountId,
            baseUrl: typeof pod.baseUrl === 'string' ? pod.baseUrl : undefined,
            podQuota,
          };
        }
      } catch {
        // Skip malformed entries
      }
    }

    return undefined;
  }

  private async getPodQuota(podId: string): Promise<number | undefined> {
    try {
      const tableId = sql.identifier([this.podUsageTable]);
      const result = await executeQuery<{ storage_limit_bytes: number | null }>(
        this.db,
        sql`SELECT storage_limit_bytes FROM ${tableId} WHERE pod_id = ${podId} LIMIT 1`,
      );
      if (result.rows.length === 0) {
        return undefined;
      }
      const limit = result.rows[0].storage_limit_bytes;
      return limit != null ? limit : undefined;
    } catch {
      // Table might not exist
      return undefined;
    }
  }

  public async getQuotaContext(accountId: string, podId: string): Promise<PodQuotaContext | undefined> {
    const podInfo = await this.getPodInfo(podId);
    if (!podInfo) {
      return undefined;
    }
    if (podInfo.accountId !== accountId) {
      return undefined;
    }
    const accountQuota = await this.getAccountQuota(accountId);
    return {
      accountId,
      podId,
      baseUrl: podInfo.baseUrl,
      podQuota: podInfo.podQuota,
      accountQuota,
    };
  }

  public async setAccountQuota(accountId: string, quota?: number): Promise<void> {
    const tableId = sql.identifier([this.accountUsageTable]);
    if (isDatabaseSqlite(this.db)) {
      await executeQuery(this.db, sql`
        INSERT INTO ${tableId} (account_id, storage_limit_bytes)
        VALUES (${accountId}, ${quota ?? null})
        ON CONFLICT (account_id) DO UPDATE SET storage_limit_bytes = ${quota ?? null}
      `);
    } else {
      await executeQuery(this.db, sql`
        INSERT INTO ${tableId} (account_id, storage_limit_bytes)
        VALUES (${accountId}, ${quota ?? null})
        ON CONFLICT (account_id) DO UPDATE SET storage_limit_bytes = EXCLUDED.storage_limit_bytes
      `);
    }
  }

  public async setPodQuota(podId: string, quota?: number): Promise<void> {
    const tableId = sql.identifier([this.podUsageTable]);
    if (isDatabaseSqlite(this.db)) {
      await executeQuery(this.db, sql`
        INSERT INTO ${tableId} (pod_id, account_id, storage_limit_bytes)
        VALUES (${podId}, '', ${quota ?? null})
        ON CONFLICT (pod_id) DO UPDATE SET storage_limit_bytes = ${quota ?? null}
      `);
    } else {
      await executeQuery(this.db, sql`
        INSERT INTO ${tableId} (pod_id, account_id, storage_limit_bytes)
        VALUES (${podId}, '', ${quota ?? null})
        ON CONFLICT (pod_id) DO UPDATE SET storage_limit_bytes = EXCLUDED.storage_limit_bytes
      `);
    }
  }
}
