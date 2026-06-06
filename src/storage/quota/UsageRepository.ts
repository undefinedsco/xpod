import { sql, eq, and } from 'drizzle-orm';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import { getSchema, isDatabaseSqlite } from '../../identity/drizzle/db';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres/session';

type DbClient = IdentityDatabase | NodePgTransaction<any, any>;
type UsageScopeType = 'account' | 'pod';

const ACCOUNT_SCOPE: UsageScopeType = 'account';
const POD_SCOPE: UsageScopeType = 'pod';

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
 * Tracks account and pod usage in one table. Account/pod are scopes of the same
 * metric record, not separate data models.
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
      await this.incrementUsageWith(tx, POD_SCOPE, podId, accountId, normalizedStorage, normalizedIngress, normalizedEgress);
      await this.incrementUsageWith(tx, ACCOUNT_SCOPE, accountId, accountId, normalizedStorage, normalizedIngress, normalizedEgress);
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

      await this.upsertUsage(tx, POD_SCOPE, podId, owningAccountId, { storageBytes: normalized });
      if (delta !== 0) {
        await this.incrementUsageWith(tx, ACCOUNT_SCOPE, owningAccountId, owningAccountId, delta, 0, 0);
      }
    });
  }

  public async setAccountStorage(accountId: string, storageBytes: number): Promise<void> {
    await this.upsertUsage(this.db, ACCOUNT_SCOPE, accountId, accountId, {
      storageBytes: this.normalizeValue(storageBytes),
    });
  }

  public async getAccountUsage(accountId: string): Promise<AccountUsageRecord | undefined> {
    const row = await this.getUsageRow(this.db, ACCOUNT_SCOPE, accountId);
    return row ? this.toAccountUsage(accountId, row) : undefined;
  }

  public async getPodUsage(podId: string): Promise<PodUsageRecord | undefined> {
    return this.getPodUsageWith(this.db, podId);
  }

  public async setAccountStorageLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, ACCOUNT_SCOPE, accountId, accountId, { storageLimitBytes: limit });
  }

  public async setPodStorageLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, POD_SCOPE, podId, accountId, { storageLimitBytes: limit });
  }

  public async setAccountBandwidthLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, ACCOUNT_SCOPE, accountId, accountId, { bandwidthLimitBps: limit });
  }

  public async setPodBandwidthLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, POD_SCOPE, podId, accountId, { bandwidthLimitBps: limit });
  }

  public async setAccountComputeLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, ACCOUNT_SCOPE, accountId, accountId, { computeLimitSeconds: limit });
  }

  public async setAccountTokenLimit(accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, ACCOUNT_SCOPE, accountId, accountId, { tokenLimitMonthly: limit });
  }

  public async setPodComputeLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, POD_SCOPE, podId, accountId, { computeLimitSeconds: limit });
  }

  public async setPodTokenLimit(podId: string, accountId: string, limit: number | null): Promise<void> {
    await this.upsertUsage(this.db, POD_SCOPE, podId, accountId, { tokenLimitMonthly: limit });
  }

  public async incrementTokenUsage(accountId: string, podId: string, tokensDelta: number): Promise<void> {
    const normalized = this.normalizeDelta(tokensDelta);
    if (normalized === 0) {
      return;
    }
    await this.db.transaction(async (tx: IdentityDatabase) => {
      await this.incrementTokensWith(tx, POD_SCOPE, podId, accountId, normalized);
      await this.incrementTokensWith(tx, ACCOUNT_SCOPE, accountId, accountId, normalized);
    });
  }

  public async incrementComputeUsage(accountId: string, podId: string, secondsDelta: number): Promise<void> {
    const normalized = this.normalizeDelta(secondsDelta);
    if (normalized === 0) {
      return;
    }
    await this.db.transaction(async (tx: IdentityDatabase) => {
      await this.incrementComputeWith(tx, POD_SCOPE, podId, accountId, normalized);
      await this.incrementComputeWith(tx, ACCOUNT_SCOPE, accountId, accountId, normalized);
    });
  }

  private async getPodUsageWith(client: DbClient, podId: string): Promise<PodUsageRecord | undefined> {
    const row = await this.getUsageRow(client, POD_SCOPE, podId);
    return row ? this.toPodUsage(podId, row) : undefined;
  }

  private async getUsageRow(client: DbClient, scopeType: UsageScopeType, scopeId: string): Promise<Record<string, unknown> | undefined> {
    const result = await client.select({
      accountId: this.schema.usage.accountId,
      storage: this.schema.usage.storageBytes,
      ingress: this.schema.usage.ingressBytes,
      egress: this.schema.usage.egressBytes,
      storageLimit: this.schema.usage.storageLimitBytes,
      bandwidthLimit: this.schema.usage.bandwidthLimitBps,
      computeSeconds: this.schema.usage.computeSeconds,
      tokensUsed: this.schema.usage.tokensUsed,
      computeLimitSeconds: this.schema.usage.computeLimitSeconds,
      tokenLimitMonthly: this.schema.usage.tokenLimitMonthly,
      periodStart: this.schema.usage.periodStart,
    }).from(this.schema.usage)
      .where(and(
        eq(this.schema.usage.scopeType, scopeType),
        eq(this.schema.usage.scopeId, scopeId),
      ));
    return result?.[0];
  }

  private async incrementTokensWith(client: DbClient, scopeType: UsageScopeType, scopeId: string, accountId: string, tokensDelta: number): Promise<void> {
    await client.insert(this.schema.usage)
      .values({
        scopeType,
        scopeId,
        accountId,
        storageBytes: 0,
        ingressBytes: 0,
        egressBytes: 0,
        tokensUsed: tokensDelta,
      })
      .onConflictDoUpdate({
        target: [ this.schema.usage.scopeType, this.schema.usage.scopeId ],
        set: {
          tokensUsed: sql`${this.schema.usage.tokensUsed} + ${tokensDelta}`,
          accountId,
          updatedAt: this.now(),
        },
      });
  }

  private async incrementComputeWith(client: DbClient, scopeType: UsageScopeType, scopeId: string, accountId: string, secondsDelta: number): Promise<void> {
    await client.insert(this.schema.usage)
      .values({
        scopeType,
        scopeId,
        accountId,
        storageBytes: 0,
        ingressBytes: 0,
        egressBytes: 0,
        computeSeconds: secondsDelta,
      })
      .onConflictDoUpdate({
        target: [ this.schema.usage.scopeType, this.schema.usage.scopeId ],
        set: {
          computeSeconds: sql`${this.schema.usage.computeSeconds} + ${secondsDelta}`,
          accountId,
          updatedAt: this.now(),
        },
      });
  }

  private async incrementUsageWith(client: DbClient, scopeType: UsageScopeType, scopeId: string, accountId: string, storageDelta: number, ingressDelta: number, egressDelta: number): Promise<void> {
    await client.insert(this.schema.usage)
      .values({
        scopeType,
        scopeId,
        accountId,
        storageBytes: storageDelta,
        ingressBytes: ingressDelta,
        egressBytes: egressDelta,
      })
      .onConflictDoUpdate({
        target: [ this.schema.usage.scopeType, this.schema.usage.scopeId ],
        set: {
          storageBytes: sql`${this.schema.usage.storageBytes} + ${storageDelta}`,
          ingressBytes: sql`${this.schema.usage.ingressBytes} + ${ingressDelta}`,
          egressBytes: sql`${this.schema.usage.egressBytes} + ${egressDelta}`,
          accountId,
          updatedAt: this.now(),
        },
      });
  }

  private async upsertUsage(
    client: DbClient,
    scopeType: UsageScopeType,
    scopeId: string,
    accountId: string,
    values: {
      storageBytes?: number;
      storageLimitBytes?: number | null;
      bandwidthLimitBps?: number | null;
      computeLimitSeconds?: number | null;
      tokenLimitMonthly?: number | null;
    },
  ): Promise<void> {
    const insertValues: Record<string, unknown> = {
      scopeType,
      scopeId,
      accountId,
      storageBytes: values.storageBytes ?? 0,
      ingressBytes: 0,
      egressBytes: 0,
    };
    const updateSet: Record<string, unknown> = {
      accountId,
      updatedAt: this.now(),
    };
    for (const field of [ 'storageBytes', 'storageLimitBytes', 'bandwidthLimitBps', 'computeLimitSeconds', 'tokenLimitMonthly' ] as const) {
      if (values[field] !== undefined) {
        insertValues[field] = values[field];
        updateSet[field] = values[field];
      }
    }

    await client.insert(this.schema.usage)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [ this.schema.usage.scopeType, this.schema.usage.scopeId ],
        set: updateSet,
      });
  }

  private toAccountUsage(accountId: string, row: Record<string, unknown>): AccountUsageRecord {
    return {
      accountId,
      ...this.toUsageMetrics(row),
    };
  }

  private toPodUsage(podId: string, row: Record<string, unknown>): PodUsageRecord {
    return {
      podId,
      accountId: String(row.accountId),
      ...this.toUsageMetrics(row),
    };
  }

  private toUsageMetrics(row: Record<string, unknown>): Omit<AccountUsageRecord, 'accountId'> {
    return {
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

  private now(): Date | number {
    const timestamp = new Date();
    return isDatabaseSqlite(this.db) ? Math.floor(timestamp.getTime() / 1000) : timestamp;
  }
}
