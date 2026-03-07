import { sql, eq } from 'drizzle-orm';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import { getSchema, isDatabaseSqlite } from '../../identity/drizzle/db';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres/session';

type DbClient = IdentityDatabase | NodePgTransaction<any, any>;

export interface AccountUsageRecord {
  accountId: string;
  storageBytes: number;
  ingressBytes: number;
  egressBytes: number;
  storageLimitBytes?: number | null;
  bandwidthLimitBps?: number | null;
  computeSeconds: number;
  tokensUsed: number;
  computeLimitSeconds?: number | null;
  tokenLimitMonthly?: number | null;
  periodStart?: number | null;
}

export interface PodUsageRecord extends AccountUsageRecord {
  podId: string;
}

/**
 * Repository for tracking pod and account usage metrics.
 * Supports both PostgreSQL and SQLite through unified schema abstraction.
 */
export class UsageRepository {
  private readonly schema: ReturnType<typeof getSchema>;

  public constructor(private readonly db: IdentityDatabase) {
    this.schema = getSchema(db);
  }

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
      storage: this.schema.accountUsage.storageBytes,
      ingress: this.schema.accountUsage.ingressBytes,
      egress: this.schema.accountUsage.egressBytes,
      storageLimit: this.schema.accountUsage.storageLimitBytes,
      bandwidthLimit: this.schema.accountUsage.bandwidthLimitBps,
      computeSeconds: this.schema.accountUsage.computeSeconds,
      tokensUsed: this.schema.accountUsage.tokensUsed,
      computeLimitSeconds: this.schema.accountUsage.computeLimitSeconds,
      tokenLimitMonthly: this.schema.accountUsage.tokenLimitMonthly,
      periodStart: this.schema.accountUsage.periodStart,
    }).from(this.schema.accountUsage)
      .where(eq(this.schema.accountUsage.accountId, accountId));
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
      computeSeconds: this.coerceNumber(row.computeSeconds),
      tokensUsed: this.coerceNumber(row.tokensUsed),
      computeLimitSeconds: this.coerceNullable(row.computeLimitSeconds),
      tokenLimitMonthly: this.coerceNullable(row.tokenLimitMonthly),
      periodStart: this.coerceTimestamp(row.periodStart),
    };
  }

  public async getPodUsage(podId: string): Promise<PodUsageRecord | undefined> {
    const result = await this.db.select({
      accountId: this.schema.podUsage.accountId,
      storage: this.schema.podUsage.storageBytes,
      ingress: this.schema.podUsage.ingressBytes,
      egress: this.schema.podUsage.egressBytes,
      storageLimit: this.schema.podUsage.storageLimitBytes,
      bandwidthLimit: this.schema.podUsage.bandwidthLimitBps,
      computeSeconds: this.schema.podUsage.computeSeconds,
      tokensUsed: this.schema.podUsage.tokensUsed,
      computeLimitSeconds: this.schema.podUsage.computeLimitSeconds,
      tokenLimitMonthly: this.schema.podUsage.tokenLimitMonthly,
      periodStart: this.schema.podUsage.periodStart,
    }).from(this.schema.podUsage)
      .where(eq(this.schema.podUsage.podId, podId));
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
      computeSeconds: this.coerceNumber(row.computeSeconds),
      tokensUsed: this.coerceNumber(row.tokensUsed),
      computeLimitSeconds: this.coerceNullable(row.computeLimitSeconds),
      tokenLimitMonthly: this.coerceNullable(row.tokenLimitMonthly),
      periodStart: this.coerceTimestamp(row.periodStart),
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

  public async setAccountComputeLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertAccountLimit(this.db, accountId, 'computeLimitSeconds', limit);
  }

  public async setAccountTokenLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertAccountLimit(this.db, accountId, 'tokenLimitMonthly', limit);
  }

  public async setPodComputeLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertPodLimit(this.db, accountId, podId, 'computeLimitSeconds', limit);
  }

  public async setPodTokenLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertPodLimit(this.db, accountId, podId, 'tokenLimitMonthly', limit);
  }

  /**
   * Increment token usage for an account and pod.
   */
  public async incrementTokenUsage(accountId: string, podId: string, tokensDelta: number): Promise<void> {
    const normalized = this.normalizeDelta(tokensDelta);
    if (normalized === 0) {
      return;
    }
    await this.db.transaction(async (tx: IdentityDatabase) => {
      await this.incrementPodTokensWith(tx, accountId, podId, normalized);
      await this.incrementAccountTokensWith(tx, accountId, normalized);
    });
  }

  /**
   * Increment compute usage for an account and pod.
   */
  public async incrementComputeUsage(accountId: string, podId: string, secondsDelta: number): Promise<void> {
    const normalized = this.normalizeDelta(secondsDelta);
    if (normalized === 0) {
      return;
    }
    await this.db.transaction(async (tx: IdentityDatabase) => {
      await this.incrementPodComputeWith(tx, accountId, podId, normalized);
      await this.incrementAccountComputeWith(tx, accountId, normalized);
    });
  }

  private async incrementAccountTokensWith(client: DbClient, accountId: string, tokensDelta: number): Promise<void> {
    await client.insert(this.schema.accountUsage)
      .values({
        accountId,
        storageBytes: 0,
        ingressBytes: 0,
        egressBytes: 0,
        tokensUsed: tokensDelta,
      })
      .onConflictDoUpdate({
        target: this.schema.accountUsage.accountId,
        set: {
          tokensUsed: sql`${this.schema.accountUsage.tokensUsed} + ${tokensDelta}`,
          updatedAt: this.now(),
        },
      });
  }

  private async incrementPodTokensWith(client: DbClient, accountId: string, podId: string, tokensDelta: number): Promise<void> {
    await client.insert(this.schema.podUsage)
      .values({
        podId,
        accountId,
        storageBytes: 0,
        ingressBytes: 0,
        egressBytes: 0,
        tokensUsed: tokensDelta,
      })
      .onConflictDoUpdate({
        target: this.schema.podUsage.podId,
        set: {
          tokensUsed: sql`${this.schema.podUsage.tokensUsed} + ${tokensDelta}`,
          accountId,
          updatedAt: this.now(),
        },
      });
  }

  private async incrementAccountComputeWith(client: DbClient, accountId: string, secondsDelta: number): Promise<void> {
    await client.insert(this.schema.accountUsage)
      .values({
        accountId,
        storageBytes: 0,
        ingressBytes: 0,
        egressBytes: 0,
        computeSeconds: secondsDelta,
      })
      .onConflictDoUpdate({
        target: this.schema.accountUsage.accountId,
        set: {
          computeSeconds: sql`${this.schema.accountUsage.computeSeconds} + ${secondsDelta}`,
          updatedAt: this.now(),
        },
      });
  }

  private async incrementPodComputeWith(client: DbClient, accountId: string, podId: string, secondsDelta: number): Promise<void> {
    await client.insert(this.schema.podUsage)
      .values({
        podId,
        accountId,
        storageBytes: 0,
        ingressBytes: 0,
        egressBytes: 0,
        computeSeconds: secondsDelta,
      })
      .onConflictDoUpdate({
        target: this.schema.podUsage.podId,
        set: {
          computeSeconds: sql`${this.schema.podUsage.computeSeconds} + ${secondsDelta}`,
          accountId,
          updatedAt: this.now(),
        },
      });
  }

  private async incrementAccountUsageWith(client: DbClient, accountId: string, storageDelta: number, ingressDelta: number, egressDelta: number): Promise<void> {
    await client.insert(this.schema.accountUsage)
      .values({
        accountId,
        storageBytes: storageDelta,
        ingressBytes: ingressDelta,
        egressBytes: egressDelta,
      })
      .onConflictDoUpdate({
        target: this.schema.accountUsage.accountId,
        set: {
          storageBytes: sql`${this.schema.accountUsage.storageBytes} + ${storageDelta}`,
          ingressBytes: sql`${this.schema.accountUsage.ingressBytes} + ${ingressDelta}`,
          egressBytes: sql`${this.schema.accountUsage.egressBytes} + ${egressDelta}`,
          updatedAt: this.now(),
        },
      });
  }

  private async incrementPodUsageWith(client: DbClient, accountId: string, podId: string, storageDelta: number, ingressDelta: number, egressDelta: number): Promise<void> {
    await client.insert(this.schema.podUsage)
      .values({
        podId,
        accountId,
        storageBytes: storageDelta,
        ingressBytes: ingressDelta,
        egressBytes: egressDelta,
      })
      .onConflictDoUpdate({
        target: this.schema.podUsage.podId,
        set: {
          storageBytes: sql`${this.schema.podUsage.storageBytes} + ${storageDelta}`,
          ingressBytes: sql`${this.schema.podUsage.ingressBytes} + ${ingressDelta}`,
          egressBytes: sql`${this.schema.podUsage.egressBytes} + ${egressDelta}`,
          accountId,
          updatedAt: this.now(),
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
      updatedAt: this.now(),
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
    await client.insert(this.schema.accountUsage)
      .values(insertValues)
      .onConflictDoUpdate({
        target: this.schema.accountUsage.accountId,
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
      updatedAt: this.now(),
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
    await client.insert(this.schema.podUsage)
      .values(insertValues)
      .onConflictDoUpdate({
        target: this.schema.podUsage.podId,
        set: updateSet,
      });
  }

  /**
   * Generic account limit setter for compute/token limits.
   */
  private async upsertAccountLimit(client: DbClient, accountId: string, field: 'computeLimitSeconds' | 'tokenLimitMonthly', value: number | null): Promise<void> {
    const insertValues: Record<string, unknown> = {
      accountId,
      storageBytes: 0,
      ingressBytes: 0,
      egressBytes: 0,
      [field]: value,
    };
    await client.insert(this.schema.accountUsage)
      .values(insertValues)
      .onConflictDoUpdate({
        target: this.schema.accountUsage.accountId,
        set: {
          [field]: value,
          updatedAt: this.now(),
        },
      });
  }

  /**
   * Generic pod limit setter for compute/token limits.
   */
  private async upsertPodLimit(client: DbClient, accountId: string, podId: string, field: 'computeLimitSeconds' | 'tokenLimitMonthly', value: number | null): Promise<void> {
    const insertValues: Record<string, unknown> = {
      podId,
      accountId,
      storageBytes: 0,
      ingressBytes: 0,
      egressBytes: 0,
      [field]: value,
    };
    await client.insert(this.schema.podUsage)
      .values(insertValues)
      .onConflictDoUpdate({
        target: this.schema.podUsage.podId,
        set: {
          accountId,
          [field]: value,
          updatedAt: this.now(),
        },
      });
  }

  private async getPodUsageWith(client: DbClient, podId: string): Promise<PodUsageRecord | undefined> {
    const result = await client.select({
      accountId: this.schema.podUsage.accountId,
      storage: this.schema.podUsage.storageBytes,
      ingress: this.schema.podUsage.ingressBytes,
      egress: this.schema.podUsage.egressBytes,
      storageLimit: this.schema.podUsage.storageLimitBytes,
      bandwidthLimit: this.schema.podUsage.bandwidthLimitBps,
      computeSeconds: this.schema.podUsage.computeSeconds,
      tokensUsed: this.schema.podUsage.tokensUsed,
      computeLimitSeconds: this.schema.podUsage.computeLimitSeconds,
      tokenLimitMonthly: this.schema.podUsage.tokenLimitMonthly,
      periodStart: this.schema.podUsage.periodStart,
    }).from(this.schema.podUsage)
      .where(eq(this.schema.podUsage.podId, podId));
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
      computeSeconds: this.coerceNumber(row.computeSeconds),
      tokensUsed: this.coerceNumber(row.tokensUsed),
      computeLimitSeconds: this.coerceNullable(row.computeLimitSeconds),
      tokenLimitMonthly: this.coerceNullable(row.tokenLimitMonthly),
      periodStart: this.coerceTimestamp(row.periodStart),
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

  /**
   * Coerce timestamp value to Unix timestamp (seconds).
   * Handles Date objects (from PG) and numbers (from SQLite).
   */
  private coerceTimestamp(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (value instanceof Date) {
      return Math.floor(value.getTime() / 1000);
    }
    if (typeof value === 'number') {
      return value;
    }
    return null;
  }

  /**
   * Get the current timestamp in the format expected by the database.
   * PG expects Date objects, SQLite expects Unix timestamps (seconds).
   */
  private now(): Date | number {
    const timestamp = new Date();
    return isDatabaseSqlite(this.db) ? Math.floor(timestamp.getTime() / 1000) : timestamp;
  }
}
