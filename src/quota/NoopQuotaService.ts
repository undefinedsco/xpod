import type { QuotaService, AccountQuota } from './QuotaService';

const NO_LIMIT: AccountQuota = {
  storageLimitBytes: null,
  bandwidthLimitBps: null,
  computeLimitSeconds: null,
  tokenLimitMonthly: null,
};

export class NoopQuotaService implements QuotaService {
  public async getAccountQuota(): Promise<AccountQuota> { return NO_LIMIT; }
  public async setAccountQuota(): Promise<void> {}
  public async getPodQuota(): Promise<AccountQuota> { return NO_LIMIT; }
  public async setPodQuota(): Promise<void> {}
  public async clearAccountQuota(): Promise<void> {}
  public async clearPodQuota(): Promise<void> {}

  public async getAccountLimit(): Promise<number | null | undefined> {
    return Number.POSITIVE_INFINITY;
  }
  public async getPodLimit(): Promise<number | null | undefined> {
    return null;
  }
  public async setAccountLimit(): Promise<void> {}
  public async setPodLimit(): Promise<void> {}
}
