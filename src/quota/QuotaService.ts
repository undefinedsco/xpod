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
}
