import { sql, eq } from 'drizzle-orm';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres/session';
import { accountUsage, podUsage } from '../../identity/drizzle/schema';

type DbClient = IdentityDatabase | NodePgTransaction<any, any>;

export interface AccountUsageRecord {
  accountId: string;
  storageBytes: number;
  ingressBytes: number;
  egressBytes: number;
  storageLimitBytes?: number | null;
  bandwidthLimitBps?: number | null;
}

export interface PodUsageRecord extends AccountUsageRecord {
  podId: string;
}

/**
 * Repository for tracking pod and account usage metrics.
 * NOTE: This repository only supports PostgreSQL. SQLite is not supported.
 * For local/dev modes, usage tracking should be disabled.
 *
 * TODO: Make UsageRepository database-agnostic to support SQLite in local mode.
 * Required changes:
 * - Replace `sql\`now()\`` with cross-database compatible timestamp (e.g., new Date())
 * - Use Drizzle's database-agnostic transaction API or raw SQL compatible with both
 * - Test with both SQLite and PostgreSQL backends
 */
export class UsageRepository {
  public constructor(private readonly db: IdentityDatabase) {}

  public async incrementUsage(accountId: string, podId: string, storageDelta: number, ingressDelta: number, egressDelta: number): Promise<void> {
    const normalizedStorage = this.normalizeDelta(storageDelta);
    const normalizedIngress = this.normalizeDelta(ingressDelta);
    const normalizedEgress = this.normalizeDelta(egressDelta);
    if (normalizedStorage === 0 && normalizedIngress === 0 && normalizedEgress === 0) {
      return;
    }
    await this.db.transaction(async (tx: IdentityDatabase) => {
      await this.incrementPodUsageWith(tx, accountId, podId, normalizedStorage, normalizedIngress, normalizedEgress);
      await this.incrementAccountUsageWith(tx, accountId, normalizedStorage, normalizedIngress, normalizedEgress);
    });
  }

  public async incrementBandwidth(accountId: string, podId: string, ingressDelta: number, egressDelta: number): Promise<void> {
    await this.incrementUsage(accountId, podId, 0, ingressDelta, egressDelta);
  }

  public async setPodStorage(accountId: string, podId: string, storageBytes: number): Promise<void> {
    const normalized = this.normalizeValue(storageBytes);
    await this.db.transaction(async (tx: IdentityDatabase) => {
      const current = await this.getPodUsageWith(tx, podId);
      const owningAccountId = current?.accountId ?? accountId;
      const previousStorage = current?.storageBytes ?? 0;
      const delta = normalized - previousStorage;

      await this.upsertPodUsage(tx, owningAccountId, podId, normalized);
      if (delta !== 0) {
        await this.incrementAccountUsageWith(tx, owningAccountId, delta, 0, 0);
      }
    });
  }

  public async setAccountStorage(accountId: string, storageBytes: number): Promise<void> {
    const normalized = this.normalizeValue(storageBytes);
    await this.db.transaction(async (tx: IdentityDatabase) => {
      await this.upsertAccountUsage(tx, accountId, normalized);
      // Adjust pod rows proportionally is undefined behaviour here, so only account-level storage is updated.
      // Pods should be updated independently by their respective setters.
    });
  }

  public async getAccountUsage(accountId: string): Promise<AccountUsageRecord | undefined> {
    const result = await this.db.select({
      storage: accountUsage.storageBytes,
      ingress: accountUsage.ingressBytes,
      egress: accountUsage.egressBytes,
      storageLimit: accountUsage.storageLimitBytes,
      bandwidthLimit: accountUsage.bandwidthLimitBps,
    }).from(accountUsage)
      .where(eq(accountUsage.accountId, accountId));
    if (!result || result.length === 0) {
      return undefined;
    }
    const row = result[0];
    return {
      accountId,
      storageBytes: this.coerceNumber(row.storage),
      ingressBytes: this.coerceNumber(row.ingress),
      egressBytes: this.coerceNumber(row.egress),
      storageLimitBytes: this.coerceNullable(row.storageLimit),
      bandwidthLimitBps: this.coerceNullable(row.bandwidthLimit),
    };
  }

  public async getPodUsage(podId: string): Promise<PodUsageRecord | undefined> {
    const result = await this.db.select({
      accountId: podUsage.accountId,
      storage: podUsage.storageBytes,
      ingress: podUsage.ingressBytes,
      egress: podUsage.egressBytes,
      storageLimit: podUsage.storageLimitBytes,
      bandwidthLimit: podUsage.bandwidthLimitBps,
    }).from(podUsage)
      .where(eq(podUsage.podId, podId));
    if (!result || result.length === 0) {
      return undefined;
    }
    const row = result[0];
    const accountId = String(row.accountId);
    return {
      podId,
      accountId,
      storageBytes: this.coerceNumber(row.storage),
      ingressBytes: this.coerceNumber(row.ingress),
      egressBytes: this.coerceNumber(row.egress),
      storageLimitBytes: this.coerceNullable(row.storageLimit),
      bandwidthLimitBps: this.coerceNullable(row.bandwidthLimit),
    };
  }

  public async setAccountStorageLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertAccountUsage(this.db, accountId, undefined, limit, undefined);
  }

  public async setPodStorageLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertPodUsage(this.db, accountId, podId, undefined, limit, undefined);
  }

  public async setAccountBandwidthLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertAccountUsage(this.db, accountId, undefined, undefined, limit);
  }

  public async setPodBandwidthLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertPodUsage(this.db, accountId, podId, undefined, undefined, limit);
  }

  private async incrementAccountUsageWith(client: DbClient, accountId: string, storageDelta: number, ingressDelta: number, egressDelta: number): Promise<void> {
    await client.insert(accountUsage)
      .values({
        accountId,
        storageBytes: storageDelta,
        ingressBytes: ingressDelta,
        egressBytes: egressDelta,
      })
      .onConflictDoUpdate({
        target: accountUsage.accountId,
        set: {
          storageBytes: sql`${accountUsage.storageBytes} + ${storageDelta}`,
          ingressBytes: sql`${accountUsage.ingressBytes} + ${ingressDelta}`,
          egressBytes: sql`${accountUsage.egressBytes} + ${egressDelta}`,
          updatedAt: sql`now()`,
        },
      });
  }

  private async incrementPodUsageWith(client: DbClient, accountId: string, podId: string, storageDelta: number, ingressDelta: number, egressDelta: number): Promise<void> {
    await client.insert(podUsage)
      .values({
        podId,
        accountId,
        storageBytes: storageDelta,
        ingressBytes: ingressDelta,
        egressBytes: egressDelta,
      })
      .onConflictDoUpdate({
        target: podUsage.podId,
        set: {
          storageBytes: sql`${podUsage.storageBytes} + ${storageDelta}`,
          ingressBytes: sql`${podUsage.ingressBytes} + ${ingressDelta}`,
          egressBytes: sql`${podUsage.egressBytes} + ${egressDelta}`,
          accountId,
          updatedAt: sql`now()`,
        },
      });
  }

  private async upsertAccountUsage(client: DbClient, accountId: string, storageBytes?: number, storageLimit?: number | null, bandwidthLimit?: number | null): Promise<void> {
    const storageValue = typeof storageBytes === 'number' ? this.normalizeValue(storageBytes) : undefined;
    const insertValues: Record<string, unknown> = {
      accountId,
      storageBytes: storageValue ?? 0,
      ingressBytes: 0,
      egressBytes: 0,
    };
    if (storageLimit !== undefined) {
      insertValues.storageLimitBytes = storageLimit;
    }
    if (bandwidthLimit !== undefined) {
      insertValues.bandwidthLimitBps = bandwidthLimit;
    }
    const updateSet: Record<string, unknown> = {
      updatedAt: sql`now()`,
    };
    if (typeof storageValue === 'number') {
      updateSet.storageBytes = storageValue;
    }
    if (storageLimit !== undefined) {
      updateSet.storageLimitBytes = storageLimit;
    }
    if (bandwidthLimit !== undefined) {
      updateSet.bandwidthLimitBps = bandwidthLimit;
    }
    await client.insert(accountUsage)
      .values(insertValues)
      .onConflictDoUpdate({
        target: accountUsage.accountId,
        set: updateSet,
      });
  }

  private async upsertPodUsage(client: DbClient, accountId: string, podId: string, storageBytes?: number, storageLimit?: number | null, bandwidthLimit?: number | null): Promise<void> {
    const storageValue = typeof storageBytes === 'number' ? this.normalizeValue(storageBytes) : undefined;
    const insertValues: Record<string, unknown> = {
      podId,
      accountId,
      storageBytes: storageValue ?? 0,
      ingressBytes: 0,
      egressBytes: 0,
    };
    if (storageLimit !== undefined) {
      insertValues.storageLimitBytes = storageLimit;
    }
    if (bandwidthLimit !== undefined) {
      insertValues.bandwidthLimitBps = bandwidthLimit;
    }
    const updateSet: Record<string, unknown> = {
      accountId,
      updatedAt: sql`now()`,
    };
    if (typeof storageValue === 'number') {
      updateSet.storageBytes = storageValue;
    }
    if (storageLimit !== undefined) {
      updateSet.storageLimitBytes = storageLimit;
    }
    if (bandwidthLimit !== undefined) {
      updateSet.bandwidthLimitBps = bandwidthLimit;
    }
    await client.insert(podUsage)
      .values(insertValues)
      .onConflictDoUpdate({
        target: podUsage.podId,
        set: updateSet,
      });
  }

  private async getPodUsageWith(client: DbClient, podId: string): Promise<PodUsageRecord | undefined> {
    const result = await client.select({
      accountId: podUsage.accountId,
      storage: podUsage.storageBytes,
      ingress: podUsage.ingressBytes,
      egress: podUsage.egressBytes,
      storageLimit: podUsage.storageLimitBytes,
      bandwidthLimit: podUsage.bandwidthLimitBps,
    }).from(podUsage)
      .where(eq(podUsage.podId, podId));
    if (!result || result.length === 0) {
      return undefined;
    }
    const row = result[0];
    const accountId = String(row.accountId);
    return {
      podId,
      accountId,
      storageBytes: this.coerceNumber(row.storage),
      ingressBytes: this.coerceNumber(row.ingress),
      egressBytes: this.coerceNumber(row.egress),
      storageLimitBytes: this.coerceNullable(row.storageLimit),
      bandwidthLimitBps: this.coerceNullable(row.bandwidthLimit),
    };
  }

  private normalizeDelta(value: number): number {
    if (!Number.isFinite(value) || value === 0) {
      return 0;
    }
    return Math.trunc(value);
  }

  private normalizeValue(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return Math.max(0, Math.trunc(value));
  }

  private coerceNumber(value: unknown): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private coerceNullable(value: unknown): number | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return Math.trunc(numeric);
  }
}
