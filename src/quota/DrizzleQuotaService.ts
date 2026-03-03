import { getLoggerFor } from 'global-logger-factory';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { AccountRepository } from '../identity/drizzle/AccountRepository';
import { UsageRepository } from '../storage/quota/UsageRepository';
import type { QuotaService, AccountQuota } from './QuotaService';

/**
 * 环境变量默认值
 */
function envNumber(key: string): number | null {
  const val = process.env[key];
  if (val === undefined || val === '') {
    return null;
  }
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

interface DrizzleQuotaServiceOptions {
  identityDbUrl: string;
}

/**
 * 统一 QuotaService 实现
 *
 * 查询优先级：DB 值 > 环境变量默认值 > 不限制 (null)
 */
export class DrizzleQuotaService implements QuotaService {
  private readonly logger = getLoggerFor(this);
  private readonly accountRepo: AccountRepository;
  private readonly usageRepo: UsageRepository;

  public constructor(options: DrizzleQuotaServiceOptions) {
    const db = getIdentityDatabase(options.identityDbUrl);
    this.accountRepo = new AccountRepository(db);
    this.usageRepo = new UsageRepository(db);
  }

  public async getAccountQuota(accountId: string): Promise<AccountQuota> {
    const usage = await this.usageRepo.getAccountUsage(accountId);
    return {
      storageLimitBytes: this.resolve(usage?.storageLimitBytes, 'XPOD_DEFAULT_STORAGE_LIMIT_BYTES'),
      bandwidthLimitBps: this.resolve(usage?.bandwidthLimitBps, 'XPOD_DEFAULT_BANDWIDTH_LIMIT_BPS'),
      computeLimitSeconds: this.resolve(usage?.computeLimitSeconds, 'XPOD_DEFAULT_COMPUTE_LIMIT_SECONDS'),
      tokenLimitMonthly: this.resolve(usage?.tokenLimitMonthly, 'XPOD_DEFAULT_TOKEN_LIMIT_MONTHLY'),
    };
  }

  public async setAccountQuota(accountId: string, quota: Partial<AccountQuota>): Promise<void> {
    if (quota.storageLimitBytes !== undefined) {
      await this.usageRepo.setAccountStorageLimit(accountId, quota.storageLimitBytes);
    }
    if (quota.bandwidthLimitBps !== undefined) {
      await this.usageRepo.setAccountBandwidthLimit(accountId, quota.bandwidthLimitBps);
    }
    if (quota.computeLimitSeconds !== undefined) {
      await this.usageRepo.setAccountComputeLimit(accountId, quota.computeLimitSeconds);
    }
    if (quota.tokenLimitMonthly !== undefined) {
      await this.usageRepo.setAccountTokenLimit(accountId, quota.tokenLimitMonthly);
    }
  }

  public async getPodQuota(podId: string): Promise<AccountQuota> {
    const usage = await this.usageRepo.getPodUsage(podId);
    return {
      storageLimitBytes: this.resolve(usage?.storageLimitBytes, 'XPOD_DEFAULT_STORAGE_LIMIT_BYTES'),
      bandwidthLimitBps: this.resolve(usage?.bandwidthLimitBps, 'XPOD_DEFAULT_BANDWIDTH_LIMIT_BPS'),
      computeLimitSeconds: this.resolve(usage?.computeLimitSeconds, 'XPOD_DEFAULT_COMPUTE_LIMIT_SECONDS'),
      tokenLimitMonthly: this.resolve(usage?.tokenLimitMonthly, 'XPOD_DEFAULT_TOKEN_LIMIT_MONTHLY'),
    };
  }

  public async setPodQuota(podId: string, quota: Partial<AccountQuota>): Promise<void> {
    // Try to get pod info from CSS
    const podInfo = await this.accountRepo.getPodInfo(podId);

    // If pod doesn't exist in CSS, try to get accountId from usage table
    let accountId = podInfo?.accountId;
    if (!accountId) {
      const usage = await this.usageRepo.getPodUsage(podId);
      accountId = usage?.accountId;
    }

    // If still no accountId, use a placeholder (quota can be set before pod creation)
    if (!accountId) {
      accountId = 'unknown';
    }

    if (quota.storageLimitBytes !== undefined) {
      await this.usageRepo.setPodStorageLimit(podId, accountId, quota.storageLimitBytes);
    }
    if (quota.bandwidthLimitBps !== undefined) {
      await this.usageRepo.setPodBandwidthLimit(podId, accountId, quota.bandwidthLimitBps);
    }
    if (quota.computeLimitSeconds !== undefined) {
      await this.usageRepo.setPodComputeLimit(podId, accountId, quota.computeLimitSeconds);
    }
    if (quota.tokenLimitMonthly !== undefined) {
      await this.usageRepo.setPodTokenLimit(podId, accountId, quota.tokenLimitMonthly);
    }
  }

  public async clearAccountQuota(accountId: string): Promise<void> {
    await this.setAccountQuota(accountId, {
      storageLimitBytes: null,
      bandwidthLimitBps: null,
      computeLimitSeconds: null,
      tokenLimitMonthly: null,
    });
  }

  public async clearPodQuota(podId: string): Promise<void> {
    await this.setPodQuota(podId, {
      storageLimitBytes: null,
      bandwidthLimitBps: null,
      computeLimitSeconds: null,
      tokenLimitMonthly: null,
    });
  }

  // 向后兼容
  public async getAccountLimit(accountId: string): Promise<number | null | undefined> {
    const quota = await this.getAccountQuota(accountId);
    return quota.storageLimitBytes;
  }

  public async getPodLimit(podId: string): Promise<number | null | undefined> {
    const quota = await this.getPodQuota(podId);
    return quota.storageLimitBytes;
  }

  public async setAccountLimit(accountId: string, limit: number | null): Promise<void> {
    await this.usageRepo.setAccountStorageLimit(accountId, limit);
  }

  public async setPodLimit(podId: string, limit: number | null): Promise<void> {
    const podInfo = await this.accountRepo.getPodInfo(podId);
    if (!podInfo?.accountId) {
      throw new Error(`Pod ${podId} not found or has no associated account`);
    }
    await this.usageRepo.setPodStorageLimit(podId, podInfo.accountId, limit);
  }

  /**
   * 解析配额值：DB 值 > 环境变量默认值 > null (不限制)
   */
  private resolve(dbValue: number | null | undefined, envKey: string): number | null {
    // DB 中有明确值（包括 0）
    if (typeof dbValue === 'number') {
      return dbValue;
    }
    // 回退到环境变量
    return envNumber(envKey);
  }
}
