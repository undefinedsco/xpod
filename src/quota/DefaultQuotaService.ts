import type { QuotaService, AccountQuota } from './QuotaService';

interface DefaultQuotaServiceOptions {
  defaultAccountQuotaBytes?: number | null;
}

export class DefaultQuotaService implements QuotaService {
  public static readonly DEFAULT_ACCOUNT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

  private readonly defaultQuota: number | null;
  private readonly accountLimits = new Map<string, number | null>();
  private readonly podLimits = new Map<string, number | null>();

  public constructor(options: DefaultQuotaServiceOptions = {}) {
    const fallback = options.defaultAccountQuotaBytes ?? DefaultQuotaService.DEFAULT_ACCOUNT_QUOTA_BYTES;
    this.defaultQuota = fallback == null ? null : Math.max(0, Math.trunc(fallback));
  }

  public async getAccountQuota(accountId: string): Promise<AccountQuota> {
    const storageLimit = this.accountLimits.has(accountId)
      ? this.accountLimits.get(accountId)!
      : this.defaultQuota;
    return {
      storageLimitBytes: storageLimit,
      bandwidthLimitBps: null,
      computeLimitSeconds: null,
      tokenLimitMonthly: null,
    };
  }

  public async setAccountQuota(accountId: string, quota: Partial<AccountQuota>): Promise<void> {
    if (quota.storageLimitBytes !== undefined) {
      await this.setAccountLimit(accountId, quota.storageLimitBytes);
    }
  }

  public async getPodQuota(podId: string): Promise<AccountQuota> {
    return {
      storageLimitBytes: this.podLimits.get(podId) ?? null,
      bandwidthLimitBps: null,
      computeLimitSeconds: null,
      tokenLimitMonthly: null,
    };
  }

  public async setPodQuota(podId: string, quota: Partial<AccountQuota>): Promise<void> {
    if (quota.storageLimitBytes !== undefined) {
      await this.setPodLimit(podId, quota.storageLimitBytes);
    }
  }

  public async clearAccountQuota(accountId: string): Promise<void> {
    this.accountLimits.delete(accountId);
  }

  public async clearPodQuota(podId: string): Promise<void> {
    this.podLimits.delete(podId);
  }

  public async getAccountLimit(accountId: string): Promise<number | null | undefined> {
    if (this.accountLimits.has(accountId)) {
      return this.accountLimits.get(accountId)!;
    }
    return this.defaultQuota;
  }

  public async getPodLimit(podId: string): Promise<number | null | undefined> {
    return this.podLimits.get(podId) ?? null;
  }

  public async setAccountLimit(accountId: string, limit: number | null): Promise<void> {
    if (limit == null) {
      this.accountLimits.delete(accountId);
      return;
    }
    this.accountLimits.set(accountId, Math.max(0, Math.trunc(limit)));
  }

  public async setPodLimit(podId: string, limit: number | null): Promise<void> {
    if (limit == null) {
      this.podLimits.delete(podId);
      return;
    }
    this.podLimits.set(podId, Math.max(0, Math.trunc(limit)));
  }
}
