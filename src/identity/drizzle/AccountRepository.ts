import { sql } from 'drizzle-orm';
import type { IdentityDatabase } from './db';

const ACCOUNT_TABLE = 'identity_account';
const POD_TABLE = 'identity_pod';

export interface PodQuotaContext {
  accountId: string;
  podId: string;
  baseUrl?: string;
  podQuota?: number;
  accountQuota?: number;
}

export class AccountRepository {
  public constructor(private readonly db: IdentityDatabase) {}

  public async getAccountQuota(accountId: string): Promise<number | undefined> {
    const result = await this.db.execute(sql`SELECT payload FROM ${sql.identifier([ACCOUNT_TABLE])} WHERE id = ${accountId} LIMIT 1`);
    if (result.rows.length === 0) {
      return undefined;
    }
    const payload = result.rows[0].payload as Record<string, unknown> | null;
    if (!payload) {
      return undefined;
    }
    const quota = (payload.quotaLimit ?? payload.quota_limit) as unknown;
    if (quota == null) {
      return undefined;
    }
    const numeric = Number(quota);
    return Number.isNaN(numeric) ? undefined : numeric;
  }

  public async getPodInfo(podId: string): Promise<{ accountId: string; podQuota?: number; baseUrl?: string } | undefined> {
    const result = await this.db.execute(sql`SELECT payload FROM ${sql.identifier([POD_TABLE])} WHERE id = ${podId} LIMIT 1`);
    if (result.rows.length === 0) {
      return undefined;
    }
    const payload = result.rows[0].payload as Record<string, unknown> | null;
    if (!payload) {
      return undefined;
    }
    const accountId = String(payload.accountId ?? payload.account_id ?? '');
    const baseUrl = payload.baseUrl ?? payload.base_url;
    const quotaRaw = payload.quotaLimit ?? payload.quota_limit;
    const podQuota = quotaRaw == null ? undefined : Number(quotaRaw);
    return {
      accountId,
      baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
      podQuota: Number.isNaN(podQuota) ? undefined : podQuota,
    };
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
    if (quota == null) {
      await this.db.execute(sql`
        UPDATE ${sql.identifier([ACCOUNT_TABLE])}
        SET payload = COALESCE(payload, '{}'::jsonb) - 'quotaLimit'
        WHERE id = ${accountId}
      `);
      return;
    }
    await this.db.execute(sql`
      UPDATE ${sql.identifier([ACCOUNT_TABLE])}
      SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{quotaLimit}', to_jsonb(${quota}))
      WHERE id = ${accountId}
    `);
  }

  public async setPodQuota(podId: string, quota?: number): Promise<void> {
    if (quota == null) {
      await this.db.execute(sql`
        UPDATE ${sql.identifier([POD_TABLE])}
        SET payload = COALESCE(payload, '{}'::jsonb) - 'quotaLimit'
        WHERE id = ${podId}
      `);
      return;
    }
    await this.db.execute(sql`
      UPDATE ${sql.identifier([POD_TABLE])}
      SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{quotaLimit}', to_jsonb(${quota}))
      WHERE id = ${podId}
    `);
  }
}
