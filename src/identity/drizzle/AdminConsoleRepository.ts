import { sql } from 'drizzle-orm';
import type { IdentityDatabase } from './db';

export interface AccountSummary {
  accountId: string;
  email?: string;
  displayName?: string;
  quotaLimit?: number | null;
  usedBytes?: number | null;
  podIds: string[];
}

export interface PodSummary {
  podId: string;
  accountId?: string;
  baseUrl?: string;
  quotaLimit?: number | null;
  usedBytes?: number | null;
}

export interface AdminOverview {
  accounts: AccountSummary[];
  pods: PodSummary[];
}

function parseNumber(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeQuota(value: unknown): number | null | undefined {
  if (value == null) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  return numeric;
}

export class AdminConsoleRepository {
  public constructor(private readonly db: IdentityDatabase) {}

  public async fetchOverview(): Promise<AdminOverview> {
    const [ accountRows, accountUsageRows, podRows, podUsageRows ] = await Promise.all([
      this.db.execute(sql`SELECT id, payload FROM identity_account ORDER BY id ASC`),
      this.db.execute(sql`SELECT account_id, used_bytes FROM identity_account_usage`),
      this.db.execute(sql`SELECT id, payload FROM identity_pod ORDER BY id ASC`),
      this.db.execute(sql`SELECT pod_id, account_id, used_bytes FROM identity_pod_usage`),
    ]);

    const accountUsage = new Map<string, number>();
    for (const row of accountUsageRows.rows as Array<{ account_id: string; used_bytes: unknown }>) {
      const bytes = parseNumber(row.used_bytes);
      if (bytes != null) {
        accountUsage.set(row.account_id, bytes);
      }
    }

    const podUsage = new Map<string, { usedBytes?: number; accountId?: string }>();
    for (const row of podUsageRows.rows as Array<{ pod_id: string; account_id?: string; used_bytes?: unknown }>) {
      podUsage.set(row.pod_id, {
        usedBytes: parseNumber(row.used_bytes),
        accountId: parseString(row.account_id),
      });
    }

    const pods: PodSummary[] = [];
    for (const row of podRows.rows as Array<{ id: string; payload: unknown }>) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const usageRecord = podUsage.get(row.id);
      const quotaRaw = payload.quotaLimit ?? payload.quota_limit;
      pods.push({
        podId: row.id,
        accountId: parseString(payload.accountId ?? payload.account_id) ?? usageRecord?.accountId,
        baseUrl: parseString(payload.baseUrl ?? payload.base_url),
        quotaLimit: normalizeQuota(quotaRaw) ?? null,
        usedBytes: usageRecord?.usedBytes ?? null,
      });
    }

    const podMapByAccount = new Map<string, string[]>();
    for (const pod of pods) {
      if (!pod.accountId) {
        continue;
      }
      const list = podMapByAccount.get(pod.accountId) ?? [];
      list.push(pod.podId);
      podMapByAccount.set(pod.accountId, list);
    }

    const accounts: AccountSummary[] = [];
    for (const row of accountRows.rows as Array<{ id: string; payload: unknown }>) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const quotaRaw = payload.quotaLimit ?? payload.quota_limit;
      accounts.push({
        accountId: row.id,
        email: parseString(payload.email ?? payload.mail),
        displayName: parseString(payload.name ?? payload.displayName ?? payload.display_name),
        quotaLimit: normalizeQuota(quotaRaw) ?? null,
        usedBytes: accountUsage.get(row.id) ?? null,
        podIds: podMapByAccount.get(row.id) ?? [],
      });
    }

    return { accounts, pods };
  }

}
