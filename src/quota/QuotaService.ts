/**
 * 统一配额模型
 *
 * 支持四种资源：存储、带宽、计算、Token
 */

export interface AccountQuota {
  storageLimitBytes: number | null;
  bandwidthLimitBps: number | null;
  computeLimitSeconds: number | null;
  tokenLimitMonthly: number | null;
}

export interface QuotaService {
  getAccountQuota(accountId: string): Promise<AccountQuota>;
  setAccountQuota(accountId: string, quota: Partial<AccountQuota>): Promise<void>;
  getPodQuota(podId: string): Promise<AccountQuota>;
  setPodQuota(podId: string, quota: Partial<AccountQuota>): Promise<void>;
  clearAccountQuota(accountId: string): Promise<void>;
  clearPodQuota(podId: string): Promise<void>;

  // 向后兼容：存储限制快捷方法
  getAccountLimit(accountId: string): Promise<number | null | undefined>;
  getPodLimit(podId: string): Promise<number | null | undefined>;
  setAccountLimit(accountId: string, limit: number | null): Promise<void>;
  setPodLimit(podId: string, limit: number | null): Promise<void>;
}
